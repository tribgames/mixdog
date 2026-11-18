-- Usage ledger v4 delta: applied to a v3 ledger inside the BEGIN IMMEDIATE transaction that sets user_version.
--
-- A record's 1-hour cache-write token count is its own fact, not part of its route: inside the rates snapshot of the
-- route signature it made nearly every request a route of its own (72,769 routes over 1.08M records on one ledger), and
-- every read that picks routes by their signature scanned them all. The count lives here, one row per record that wrote
-- any; the route keeps the rates without it.

CREATE TABLE usage_event_cache_1h (id BLOB PRIMARY KEY, tokens REAL NOT NULL) WITHOUT ROWID;

CREATE TRIGGER cache_1h_event_delete AFTER DELETE ON usage_events
        BEGIN DELETE FROM usage_event_cache_1h WHERE id=OLD.id; END;

PRAGMA user_version = 4;
