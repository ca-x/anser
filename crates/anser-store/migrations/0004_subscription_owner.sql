ALTER TABLE subscriptions ADD COLUMN key_id TEXT REFERENCES api_keys(id);
DROP INDEX subscriptions_owner;
CREATE UNIQUE INDEX subscriptions_owner ON subscriptions(topic_id, coalesce(user_id,key_id,''), subscriber_ref);
CREATE INDEX subscriptions_machine ON subscriptions(key_id,topic_id);
