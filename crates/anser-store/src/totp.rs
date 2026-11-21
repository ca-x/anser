//! Transaction boundaries for per-user TOTP factors and recovery codes.

use sqlx::SqliteConnection;

use crate::{DataError, Result, Store, now_ms};

#[derive(sqlx::FromRow)]
pub struct TotpFactor {
    pub epoch: String,
    pub encrypted_seed: Vec<u8>,
}

pub enum FactorCode {
    Step(i64),
    Recovery([u8; 32]),
}

pub struct FactorProof<'a> {
    pub epoch: &'a str,
    pub code: FactorCode,
}

impl Store {
    pub async fn active_totp(&self, user_id: &str) -> Result<Option<TotpFactor>> {
        Ok(sqlx::query_as(
            "SELECT epoch,encrypted_seed FROM user_totp WHERE user_id=? AND last_step IS NOT NULL",
        )
        .bind(user_id)
        .fetch_optional(&self.0)
        .await?)
    }

    pub async fn totp_enabled(&self, user_id: &str) -> Result<bool> {
        Ok(sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM user_totp WHERE user_id=? AND last_step IS NOT NULL)",
        )
        .bind(user_id)
        .fetch_one(&self.0)
        .await?)
    }

    pub async fn pending_totp(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> Result<Option<TotpFactor>> {
        Ok(sqlx::query_as("SELECT epoch,encrypted_seed FROM user_totp WHERE user_id=? AND setup_session_id=? AND setup_expires_at>?")
            .bind(user_id)
            .bind(session_id)
            .bind(now_ms())
            .fetch_optional(&self.0)
            .await?)
    }

    pub async fn setup_totp(
        &self,
        user_id: &str,
        session_id: &str,
        password_hash: &str,
        epoch: &str,
        encrypted_seed: &[u8],
        expires_at: i64,
    ) -> Result<()> {
        let mut tx = self.0.begin_with("BEGIN IMMEDIATE").await?;
        require_live_session(&mut tx, user_id, session_id, Some(password_hash)).await?;
        let result = sqlx::query("INSERT INTO user_totp(user_id,epoch,encrypted_seed,setup_session_id,setup_expires_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET epoch=excluded.epoch,encrypted_seed=excluded.encrypted_seed,setup_session_id=excluded.setup_session_id,setup_expires_at=excluded.setup_expires_at WHERE user_totp.last_step IS NULL")
            .bind(user_id)
            .bind(epoch)
            .bind(encrypted_seed)
            .bind(session_id)
            .bind(expires_at)
            .execute(&mut *tx)
            .await?;
        if result.rows_affected() != 1 {
            return Err(DataError::Conflict);
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn confirm_totp(
        &self,
        user_id: &str,
        session_id: &str,
        epoch: &str,
        step: i64,
        recovery_codes: &[[u8; 32]],
    ) -> Result<()> {
        let mut tx = self.0.begin_with("BEGIN IMMEDIATE").await?;
        require_live_session(&mut tx, user_id, session_id, None).await?;
        let result = sqlx::query("UPDATE user_totp SET last_step=?,setup_session_id=NULL,setup_expires_at=NULL WHERE user_id=? AND epoch=? AND setup_session_id=? AND setup_expires_at>?")
            .bind(step)
            .bind(user_id)
            .bind(epoch)
            .bind(session_id)
            .bind(now_ms())
            .execute(&mut *tx)
            .await?;
        super::affected(result.rows_affected())?;
        for code_hash in recovery_codes {
            sqlx::query("INSERT INTO totp_recovery_codes(user_id,code_hash) VALUES(?,?)")
                .bind(user_id)
                .bind(code_hash.as_slice())
                .execute(&mut *tx)
                .await?;
        }
        revoke_other_sessions(&mut tx, user_id, session_id).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn disable_totp(
        &self,
        user_id: &str,
        session_id: &str,
        password_hash: &str,
        proof: FactorProof<'_>,
    ) -> Result<()> {
        let mut tx = self.0.begin_with("BEGIN IMMEDIATE").await?;
        require_live_session(&mut tx, user_id, session_id, Some(password_hash)).await?;
        consume_factor(&mut tx, user_id, Some(proof)).await?;
        sqlx::query("DELETE FROM user_totp WHERE user_id=?")
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        revoke_other_sessions(&mut tx, user_id, session_id).await?;
        tx.commit().await?;
        Ok(())
    }
}

pub(super) async fn consume_factor(
    tx: &mut SqliteConnection,
    user_id: &str,
    proof: Option<FactorProof<'_>>,
) -> Result<()> {
    let Some(proof) = proof else {
        let active: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM user_totp WHERE user_id=? AND last_step IS NOT NULL)",
        )
        .bind(user_id)
        .fetch_one(tx)
        .await?;
        return if active {
            Err(DataError::InvalidFactor)
        } else {
            Ok(())
        };
    };
    let result = match proof.code {
        FactorCode::Step(step) => {
            sqlx::query(
                "UPDATE user_totp SET last_step=? WHERE user_id=? AND epoch=? AND last_step<?",
            )
            .bind(step)
            .bind(user_id)
            .bind(proof.epoch)
            .bind(step)
            .execute(tx)
            .await?
        }
        FactorCode::Recovery(code_hash) => {
            sqlx::query("DELETE FROM totp_recovery_codes WHERE user_id=? AND code_hash=? AND EXISTS(SELECT 1 FROM user_totp WHERE user_id=? AND epoch=? AND last_step IS NOT NULL)")
                .bind(user_id)
                .bind(code_hash.as_slice())
                .bind(user_id)
                .bind(proof.epoch)
                .execute(tx)
                .await?
        }
    };
    if result.rows_affected() == 1 {
        Ok(())
    } else {
        Err(DataError::InvalidFactor)
    }
}

async fn require_live_session(
    tx: &mut SqliteConnection,
    user_id: &str,
    session_id: &str,
    password_hash: Option<&str>,
) -> Result<()> {
    let live: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users u JOIN api_keys k ON k.user_id=u.id WHERE u.id=? AND k.id=? AND u.enabled=1 AND k.enabled=1 AND k.session=1 AND k.expires_at>? AND (? IS NULL OR u.password_hash=?))")
        .bind(user_id)
        .bind(session_id)
        .bind(now_ms())
        .bind(password_hash)
        .bind(password_hash)
        .fetch_one(tx)
        .await?;
    if live {
        Ok(())
    } else {
        Err(DataError::Forbidden)
    }
}

async fn revoke_other_sessions(
    tx: &mut SqliteConnection,
    user_id: &str,
    session_id: &str,
) -> Result<()> {
    sqlx::query("UPDATE api_keys SET enabled=0 WHERE user_id=? AND session=1 AND id<>?")
        .bind(user_id)
        .bind(session_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM pair_codes WHERE user_id=?")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn totp_seeds_require_the_original_master_key() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("anser.sqlite3"))
            .await
            .unwrap();
        let user = store
            .create_user("user", "fixture-hash", true, false)
            .await
            .unwrap()
            .unwrap();
        let session = new_session(&store, &user).await;

        assert!(!store.has_credentials().await.unwrap());
        store
            .setup_totp(
                &user.id,
                &session,
                &user.password_hash,
                "expired",
                &[0],
                now_ms() - 1,
            )
            .await
            .unwrap();
        assert!(!store.has_credentials().await.unwrap());
        store
            .setup_totp(
                &user.id,
                &session,
                &user.password_hash,
                "pending",
                &[0],
                now_ms() + 60_000,
            )
            .await
            .unwrap();
        assert!(store.has_credentials().await.unwrap());
        store
            .confirm_totp(&user.id, &session, "pending", 1, &[[0; 32]])
            .await
            .unwrap();
        assert!(store.has_credentials().await.unwrap());
    }

    async fn new_session(store: &Store, user: &crate::users::User) -> String {
        let id = crate::new_id();
        store
            .create_session(
                &id,
                &[0; 32],
                &user.id,
                now_ms() + 60_000,
                &user.password_hash,
                None,
            )
            .await
            .unwrap();
        id
    }
}
