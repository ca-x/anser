CREATE TABLE history_retention (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
    days INTEGER NOT NULL CHECK(days BETWEEN 1 AND 3650)
) STRICT;
