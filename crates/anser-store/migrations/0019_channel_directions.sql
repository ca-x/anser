ALTER TABLE channel_settings ADD COLUMN ingress_enabled INTEGER NOT NULL DEFAULT 0 CHECK (ingress_enabled IN (0, 1));
ALTER TABLE channel_settings ADD COLUMN egress_enabled INTEGER NOT NULL DEFAULT 1 CHECK (egress_enabled IN (0, 1));
