ALTER TABLE messages ADD COLUMN inbox_deliveries INTEGER NOT NULL DEFAULT 0 CHECK(inbox_deliveries >= 0);
ALTER TABLE messages ADD COLUMN inbox_recipient TEXT;
ALTER TABLE idempotency ADD COLUMN inbox_id INTEGER;

-- Support retention's foreign-key checks and group the surviving historical receipts.
CREATE INDEX inbox_message ON inbox(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX idempotency_message ON idempotency(message_id);
UPDATE messages SET inbox_deliveries = counts.total
FROM (SELECT message_id, count(*) AS total FROM inbox
      WHERE message_id IS NOT NULL GROUP BY message_id) AS counts
WHERE messages.id = counts.message_id;
