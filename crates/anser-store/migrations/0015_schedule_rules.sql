ALTER TABLE scheduled_tasks ADD COLUMN rule TEXT;
ALTER TABLE scheduled_tasks ADD COLUMN completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0, 1));

DROP VIEW scheduled_task_views;
CREATE VIEW scheduled_task_views AS
SELECT s.id,s.name,s.plugin_id,t.name AS topic,
       CASE WHEN s.rule IS NULL OR json_extract(s.rule, '$.kind')='interval' THEN s.interval_minutes END AS interval_minutes,
       coalesce(s.rule,json_object('kind','interval','minutes',s.interval_minutes)) AS rule,
       s.enabled,s.completed,CASE WHEN s.completed=0 THEN s.next_at END AS next_at,
       s.last_at,s.last_status,s.last_count
FROM scheduled_tasks s LEFT JOIN topics t ON t.id=s.topic_id;
