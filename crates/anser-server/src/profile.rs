use std::io::Cursor;
use std::sync::Arc;

use anser_store::users::UserProfile;
use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use image::{ImageFormat, ImageReader, Limits};
use tokio::sync::Semaphore;

use crate::api::App;
use crate::auth::Identity;
use crate::error::{ApiError, ApiJson, ApiResult};

const MAX_BYTES: usize = 256 * 1024;
const MAX_DIMENSION: u32 = 1024;
const AVATAR_DIMENSION: u32 = 224;
static AVATAR_WORK: Semaphore = Semaphore::const_new(4);

type ProfileResponse = (HeaderMap, Json<UserProfile>);

pub async fn get(State(app): State<Arc<App>>, identity: Identity) -> ApiResult<ProfileResponse> {
    let user = identity.session_user()?;
    Ok(private(app.store.profile(&user.id).await?))
}

pub async fn update(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiJson(input): ApiJson<UserProfile>,
) -> ApiResult<ProfileResponse> {
    let user = identity.session_user()?;
    let nickname = input
        .nickname
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if nickname
        .is_some_and(|value| value.chars().count() > 64 || value.chars().any(char::is_control))
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_nickname",
            "Nickname must contain up to 64 characters without control characters",
        ));
    }
    let avatar = match input.avatar {
        Some(data) => {
            let permit = AVATAR_WORK.try_acquire().map_err(|_| ApiError::limited())?;
            let canonical = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                normalize_avatar(&data)
            })
            .await
            .map_err(|_| ApiError::internal())??;
            Some(canonical)
        }
        None => None,
    };
    let profile = UserProfile {
        nickname: nickname.map(str::to_owned),
        avatar,
    };
    app.store.set_profile(&user.id, &profile).await?;
    Ok(private(profile))
}

fn private(profile: UserProfile) -> ProfileResponse {
    let mut headers = HeaderMap::new();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    (headers, Json(profile))
}

fn invalid_avatar() -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "invalid_avatar",
        "Choose a PNG, JPEG or WebP image no larger than 256 KiB and 1024 × 1024 pixels",
    )
}

fn normalize_avatar(data: &str) -> ApiResult<String> {
    let (media, encoded) = data.split_once(',').ok_or_else(invalid_avatar)?;
    let format = match media {
        "data:image/png;base64" => ImageFormat::Png,
        "data:image/jpeg;base64" => ImageFormat::Jpeg,
        "data:image/webp;base64" => ImageFormat::WebP,
        _ => return Err(invalid_avatar()),
    };
    if encoded.len() > MAX_BYTES.div_ceil(3) * 4 {
        return Err(invalid_avatar());
    }
    let bytes = STANDARD.decode(encoded).map_err(|_| invalid_avatar())?;
    if bytes.len() > MAX_BYTES || image::guess_format(&bytes).ok() != Some(format) {
        return Err(invalid_avatar());
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(32 * 1024 * 1024);
    reader.limits(limits);
    let input = reader.decode().map_err(|_| invalid_avatar())?;
    let normalized = image::DynamicImage::ImageRgba8(
        input
            .thumbnail(AVATAR_DIMENSION, AVATAR_DIMENSION)
            .into_rgba8(),
    );
    let mut encoded = Cursor::new(Vec::new());
    normalized
        .write_to(&mut encoded, ImageFormat::Png)
        .map_err(|_| ApiError::internal())?;
    if encoded.get_ref().len() > MAX_BYTES {
        return Err(ApiError::internal());
    }
    Ok(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(encoded.into_inner())
    ))
}
