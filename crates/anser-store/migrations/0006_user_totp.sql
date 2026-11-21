CREATE TABLE user_totp (
    user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    epoch TEXT NOT NULL,
    encrypted_seed BLOB NOT NULL,
    setup_session_id TEXT REFERENCES api_keys(id) ON DELETE CASCADE,
    setup_expires_at INTEGER,
    last_step INTEGER,
    CHECK (
        (setup_session_id IS NOT NULL AND setup_expires_at IS NOT NULL AND last_step IS NULL)
        OR (setup_session_id IS NULL AND setup_expires_at IS NULL AND last_step >= 0 AND last_step IS NOT NULL)
    )
) STRICT;

CREATE TABLE totp_recovery_codes (
    user_id TEXT NOT NULL REFERENCES user_totp(user_id) ON DELETE CASCADE,
    code_hash BLOB NOT NULL CHECK(length(code_hash)=32),
    PRIMARY KEY(user_id, code_hash)
) STRICT;
