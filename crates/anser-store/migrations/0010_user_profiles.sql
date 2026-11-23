CREATE TABLE user_profiles (
    user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nickname TEXT CHECK (nickname IS NULL OR length(nickname) BETWEEN 1 AND 64),
    avatar TEXT CHECK (avatar IS NULL OR length(avatar) <= 349550)
);
