use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use anser_store::totp::{FactorCode, FactorProof, TotpFactor};
use anser_store::{DataError, new_id, now_ms};
use axum::extract::{ConnectInfo, State};
use axum::http::{StatusCode, header};
use axum::{Extension, Json};
use data_encoding::BASE32_NOPAD;
use hmac::{Hmac, KeyInit, Mac};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use subtle::{Choice, ConstantTimeEq};
use zeroize::Zeroizing;

use crate::api::App;
use crate::auth::{Identity, serialize_secret, verify_password};
use crate::error::{ApiError, ApiJson, ApiResult};

const PERIOD_MS: i64 = 30_000;
const SETUP_TTL_MS: i64 = 600_000;
const RECOVERY_COUNT: usize = 8;

type NoStore<T> = ([(header::HeaderName, &'static str); 1], Json<T>);

#[derive(Deserialize)]
pub struct SetupInput {
    password: String,
}

#[derive(Deserialize)]
pub struct ConfirmInput {
    code: String,
}

#[derive(Deserialize)]
pub struct DisableInput {
    password: String,
    code: String,
}

#[derive(Serialize)]
pub struct TotpStatus {
    enabled: bool,
}

#[derive(Serialize)]
pub struct Setup {
    #[serde(serialize_with = "serialize_secret")]
    secret: Zeroizing<String>,
    #[serde(serialize_with = "serialize_secret")]
    uri: Zeroizing<String>,
    expires_at: i64,
}

#[derive(Serialize)]
pub struct Confirmation {
    enabled: bool,
    #[serde(serialize_with = "serialize_codes")]
    recovery_codes: Vec<Zeroizing<String>>,
}

pub async fn status(
    State(app): State<Arc<App>>,
    identity: Identity,
) -> ApiResult<NoStore<TotpStatus>> {
    let user = identity.session_user()?;
    let enabled = app.store.totp_enabled(&user.id).await?;
    Ok(no_store(TotpStatus { enabled }))
}

pub async fn setup(
    State(app): State<Arc<App>>,
    identity: Identity,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    ApiJson(input): ApiJson<SetupInput>,
) -> ApiResult<NoStore<Setup>> {
    let user = identity.session_user()?;
    management_rate(
        &app,
        &identity,
        peer.map(|Extension(ConnectInfo(peer))| peer.ip()),
    )?;
    current_password(input.password, &user.password_hash).await?;

    let epoch = new_id();
    let mut seed = Zeroizing::new([0u8; 20]);
    rand::rngs::OsRng.fill_bytes(&mut *seed);
    let encrypted_seed = app
        .cipher
        .seal_bytes(&seed_context(&user.id, &epoch), seed.as_slice())?;
    let expires_at = now_ms() + SETUP_TTL_MS;
    app.store
        .setup_totp(
            &user.id,
            &identity.key_id,
            &user.password_hash,
            &epoch,
            &encrypted_seed,
            expires_at,
        )
        .await
        .map_err(|error| match error {
            DataError::Conflict => ApiError::new(
                StatusCode::CONFLICT,
                "totp_already_enabled",
                "Two-factor authentication is already enabled",
            ),
            _ => error.into(),
        })?;

    let secret = Zeroizing::new(BASE32_NOPAD.encode(seed.as_slice()));
    // Usernames are limited to URL-safe ASCII by account validation.
    let uri = Zeroizing::new(format!(
        "otpauth://totp/Anser:{}?secret={}&issuer=Anser&algorithm=SHA1&digits=6&period=30",
        user.username, &*secret
    ));
    Ok(no_store(Setup {
        secret,
        uri,
        expires_at,
    }))
}

pub async fn confirm(
    State(app): State<Arc<App>>,
    identity: Identity,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    ApiJson(input): ApiJson<ConfirmInput>,
) -> ApiResult<NoStore<Confirmation>> {
    let code = Zeroizing::new(input.code);
    let user = identity.session_user()?;
    management_rate(
        &app,
        &identity,
        peer.map(|Extension(ConnectInfo(peer))| peer.ip()),
    )?;
    let pending = app
        .store
        .pending_totp(&user.id, &identity.key_id)
        .await?
        .ok_or_else(setup_expired)?;
    let Some(step) = matching_step(&seed(&app, &user.id, &pending)?, code.trim(), now_ms()) else {
        return Err(invalid_totp(StatusCode::BAD_REQUEST));
    };

    let recovery_codes: Vec<_> = (0..RECOVERY_COUNT).map(|_| recovery_code()).collect();
    let hashes: Vec<_> = recovery_codes
        .iter()
        .map(|code| recovery_hash(&user.id, &pending.epoch, code))
        .collect();
    app.store
        .confirm_totp(&user.id, &identity.key_id, &pending.epoch, step, &hashes)
        .await
        .map_err(|error| match error {
            DataError::Missing => setup_expired(),
            _ => error.into(),
        })?;
    Ok(no_store(Confirmation {
        enabled: true,
        recovery_codes,
    }))
}

pub async fn disable(
    State(app): State<Arc<App>>,
    identity: Identity,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    ApiJson(input): ApiJson<DisableInput>,
) -> ApiResult<NoStore<TotpStatus>> {
    let code = Zeroizing::new(input.code);
    let user = identity.session_user()?;
    management_rate(
        &app,
        &identity,
        peer.map(|Extension(ConnectInfo(peer))| peer.ip()),
    )?;
    current_password(input.password, &user.password_hash).await?;
    let factor = app.store.active_totp(&user.id).await?.ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "totp_not_enabled",
            "Two-factor authentication is not enabled",
        )
    })?;
    let proof = verify_factor(&app, &user.id, &factor, &code)?
        .ok_or_else(|| invalid_totp(StatusCode::BAD_REQUEST))?;
    app.store
        .disable_totp(&user.id, &identity.key_id, &user.password_hash, proof)
        .await
        .map_err(|error| match error {
            DataError::InvalidFactor => invalid_totp(StatusCode::BAD_REQUEST),
            _ => error.into(),
        })?;
    Ok(no_store(TotpStatus { enabled: false }))
}

pub fn verify_factor<'a>(
    app: &App,
    user_id: &str,
    factor: &'a TotpFactor,
    input: &str,
) -> ApiResult<Option<FactorProof<'a>>> {
    let code = input.trim();
    let code = match code.len() {
        6 => matching_step(&seed(app, user_id, factor)?, code, now_ms()).map(FactorCode::Step),
        26 | 29 => {
            let canonical = Zeroizing::new(code.to_ascii_uppercase());
            let compact = canonical.bytes().filter(|&byte| byte != b'-');
            if compact.clone().count() != 26
                || !compact
                    .clone()
                    .all(|byte| byte.is_ascii_uppercase() || (b'2'..=b'7').contains(&byte))
            {
                return Ok(None);
            }
            Some(FactorCode::Recovery(recovery_hash(
                user_id,
                &factor.epoch,
                &canonical,
            )))
        }
        _ => None,
    };
    Ok(code.map(|code| FactorProof {
        epoch: &factor.epoch,
        code,
    }))
}

fn seed(app: &App, user_id: &str, factor: &TotpFactor) -> ApiResult<Zeroizing<Vec<u8>>> {
    Ok(app.cipher.open_bytes(
        &seed_context(user_id, &factor.epoch),
        &factor.encrypted_seed,
    )?)
}

fn seed_context(user_id: &str, epoch: &str) -> String {
    format!("user-totp:{user_id}:{epoch}")
}

fn matching_step(seed: &[u8], code: &str, now_ms: i64) -> Option<i64> {
    if code.len() != 6 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let value = code.parse::<u32>().ok()?.to_be_bytes();
    let center = now_ms / PERIOD_MS;
    let mut matched = None;
    for step in center.saturating_sub(1).max(0)..=center + 1 {
        let valid: Choice = value.ct_eq(&totp_code(seed, step).to_be_bytes());
        if bool::from(valid) {
            matched = Some(step);
        }
    }
    matched
}

fn totp_code(seed: &[u8], step: i64) -> u32 {
    let mut mac = Hmac::<Sha1>::new_from_slice(seed).expect("HMAC accepts any key length");
    mac.update(&step.to_be_bytes());
    let bytes = mac.finalize().into_bytes();
    let offset = usize::from(bytes[19] & 0x0f);
    let truncated = u32::from_be_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("offset is at most 15"),
    );
    (truncated & 0x7fff_ffff) % 1_000_000
}

fn recovery_code() -> Zeroizing<String> {
    let mut bytes = Zeroizing::new([0u8; 16]);
    rand::rngs::OsRng.fill_bytes(&mut *bytes);
    let code = Zeroizing::new(BASE32_NOPAD.encode(bytes.as_slice()));
    Zeroizing::new(format!(
        "{}-{}-{}-{}",
        &code[..7],
        &code[7..14],
        &code[14..20],
        &code[20..]
    ))
}

fn recovery_hash(user_id: &str, epoch: &str, code: &str) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(b"Anser TOTP recovery v1\0");
    hash.update(user_id);
    hash.update(b"\0");
    hash.update(epoch);
    hash.update(b"\0");
    for byte in code.bytes().filter(|&byte| byte != b'-') {
        hash.update([byte]);
    }
    hash.finalize().into()
}

fn no_store<T>(data: T) -> NoStore<T> {
    ([(header::CACHE_CONTROL, "no-store")], Json(data))
}

fn serialize_codes<S: serde::Serializer>(
    codes: &[Zeroizing<String>],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.collect_seq(codes.iter().map(|code| code.as_str()))
}

fn management_rate(app: &App, identity: &Identity, peer: Option<IpAddr>) -> ApiResult<()> {
    let peer = format!(
        "peer:{}",
        peer.map_or_else(|| "unknown".into(), |ip| ip.to_string())
    );
    if app.totp_requests.hit(&peer, 60) && app.totp_requests.hit(&identity.key_id, 12) {
        Ok(())
    } else {
        Err(ApiError::limited())
    }
}

async fn current_password(password: String, expected_hash: &str) -> ApiResult<()> {
    if verify_password(password, expected_hash.into()).await? {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_password",
            "Current password is incorrect",
        ))
    }
}

fn setup_expired() -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "totp_setup_expired",
        "Begin setup again to confirm two-factor authentication",
    )
}

pub fn required() -> ApiError {
    ApiError::new(
        StatusCode::UNAUTHORIZED,
        "totp_required",
        "Enter an authenticator or recovery code",
    )
}

pub fn invalid_totp(status: StatusCode) -> ApiError {
    ApiError::new(
        status,
        "invalid_totp",
        "The authenticator or recovery code is invalid or was already used",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc6238_sha1_digits_and_adjacent_steps() {
        let seed = b"12345678901234567890";
        // RFC 6238 Appendix B gives 94287082 at Unix second 59, using eight digits.
        assert_eq!(totp_code(seed, 1), 287082);
        assert_eq!(matching_step(seed, "287082", 59_000), Some(1));
        assert_eq!(matching_step(seed, "287082", 29_000), Some(1));
        assert_eq!(matching_step(seed, "287082", 60_000), Some(1));
        assert_eq!(matching_step(seed, "287082", 90_000), None);
    }
}
