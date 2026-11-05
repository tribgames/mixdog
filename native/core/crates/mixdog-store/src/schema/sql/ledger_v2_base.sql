-- Usage ledger, objects of the 1.4.5 schema (tag 69fe41b05, user_version 2).
-- Statement text is byte-identical to sqlite_master.sql as 1.4.5 writes it
-- (13 tables, 7 indexes, 1 view, 16 triggers). Never edit: a changed byte is
-- a changed object to the verifier (FORMAT.md section 9).

CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE usage_routes (
        id INTEGER PRIMARY KEY, signature TEXT NOT NULL UNIQUE
    );

CREATE TABLE usage_sessions (
        id INTEGER PRIMARY KEY, value TEXT NOT NULL UNIQUE
    );

CREATE TABLE usage_events (
        id BLOB PRIMARY KEY, ts INTEGER NOT NULL, day INTEGER NOT NULL,
        route INTEGER NOT NULL REFERENCES usage_routes(id),
        session INTEGER NOT NULL REFERENCES usage_sessions(id),
        input REAL NOT NULL, output REAL NOT NULL, cache_read REAL NOT NULL, cache_write REAL NOT NULL,
        cost_usd REAL, duration_ms REAL NOT NULL
    ) WITHOUT ROWID;

CREATE TABLE usage_session_owners (
        session INTEGER PRIMARY KEY REFERENCES usage_sessions(id),
        owner INTEGER NOT NULL REFERENCES usage_sessions(id)
    );

CREATE TABLE daily (
                day TEXT NOT NULL, rank INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
                kind TEXT NOT NULL, cost_source TEXT NOT NULL, conversation INTEGER NOT NULL,
                turns INTEGER NOT NULL, input REAL NOT NULL, output REAL NOT NULL,
                cache_read REAL NOT NULL, cache_write REAL NOT NULL, cost_usd REAL NOT NULL,
                duration_ms REAL NOT NULL, imported INTEGER NOT NULL,
                PRIMARY KEY(day,rank,provider,model,kind,cost_source,conversation)
            );

CREATE TABLE day_sessions (
                day TEXT NOT NULL, rank INTEGER NOT NULL, session_id TEXT NOT NULL, tokens REAL NOT NULL,
                PRIMARY KEY(day,rank,session_id)
            );

CREATE TABLE legacy_days (day TEXT PRIMARY KEY, document TEXT NOT NULL);

CREATE TABLE quota_samples (
        provider TEXT NOT NULL, account TEXT NOT NULL, label TEXT NOT NULL,
        ts INTEGER NOT NULL, seen_until INTEGER NOT NULL,
        used_pct REAL NOT NULL, reset_at INTEGER,
        PRIMARY KEY(provider,account,label,ts)
    ) WITHOUT ROWID;

CREATE TABLE day_revisions (day TEXT PRIMARY KEY, rev INTEGER NOT NULL) WITHOUT ROWID;

CREATE TABLE usage_requests (
        id BLOB PRIMARY KEY, ts INTEGER NOT NULL, requested_model TEXT, status TEXT NOT NULL,
        attempts INTEGER NOT NULL, ttft_ms REAL, elapsed_ms REAL
    ) WITHOUT ROWID;

CREATE TABLE usage_request_first_output (
        id BLOB PRIMARY KEY, ttft_ms REAL NOT NULL
    ) WITHOUT ROWID;

CREATE TABLE usage_request_requested_provider (
        id BLOB PRIMARY KEY, provider TEXT NOT NULL
    ) WITHOUT ROWID;

CREATE INDEX usage_events_time ON usage_events(ts);

CREATE INDEX usage_events_time_usage ON usage_events(
        ts,route,day,session,input,output,cache_read,cache_write,cost_usd,duration_ms);

CREATE INDEX usage_events_session ON usage_events(session);

CREATE INDEX usage_session_owners_owner ON usage_session_owners(owner);

CREATE INDEX usage_requests_status_time ON usage_requests(status, ts) WHERE status<>'completed';

CREATE INDEX usage_events_route_time ON usage_events(route, ts);

CREATE INDEX usage_routes_model ON usage_routes(json_extract(signature,'$[1]'));

CREATE VIEW events AS 
    SELECT CASE WHEN substr(e.id,1,1)=X'00'
        THEN lower(hex(substr(e.id,2))) ELSE CAST(substr(e.id,2) AS TEXT) END AS id,
        e.ts, printf('%04d-%02d-%02d',e.day/10000,(e.day/100)%100,e.day%100) AS day,
        json_extract(r.signature,'$[0]') AS provider,
        json_extract(r.signature,'$[1]') AS model,
        json_extract(r.signature,'$[2]') AS kind,
        s.value AS session_id,
        json_extract(r.signature,'$[3]') AS source_type,
        e.input,e.output,e.cache_read,e.cache_write,e.cost_usd,
        json_extract(r.signature,'$[4]') AS cost_source,
        json_extract(r.signature,'$[5]') AS rates,
        json_extract(r.signature,'$[6]') AS origin,
        json_extract(r.signature,'$[7]') AS rank,
        e.duration_ms
    FROM usage_events e
    JOIN usage_routes r ON r.id=e.route
    JOIN usage_sessions s ON s.id=e.session;

CREATE TRIGGER day_rev_events_insert AFTER INSERT ON usage_events
        BEGIN INSERT INTO day_revisions(day,rev) VALUES(printf('%04d-%02d-%02d',NEW.day/10000,(NEW.day/100)%100,NEW.day%100),1) ON CONFLICT(day) DO UPDATE SET rev=rev+1; END;

CREATE TRIGGER day_rev_events_update AFTER UPDATE ON usage_events
        BEGIN INSERT INTO day_revisions(day,rev) VALUES(printf('%04d-%02d-%02d',OLD.day/10000,(OLD.day/100)%100,OLD.day%100),1) ON CONFLICT(day) DO UPDATE SET rev=rev+1; INSERT INTO day_revisions(day,rev) VALUES(printf('%04d-%02d-%02d',NEW.day/10000,(NEW.day/100)%100,NEW.day%100),1) ON CONFLICT(day) DO UPDATE SET rev=rev+1; END;

CREATE TRIGGER day_rev_events_delete AFTER DELETE ON usage_events
        BEGIN INSERT INTO day_revisions(day,rev) VALUES(printf('%04d-%02d-%02d',OLD.day/10000,(OLD.day/100)%100,OLD.day%100),1) ON CONFLICT(day) DO UPDATE SET rev=rev+1; END;

CREATE TRIGGER day_rev_daily_insert AFTER INSERT ON daily
        BEGIN INSERT INTO day_revisions(day,rev) VALUES(NEW.day,1) ON CONFLICT(day) DO UPDATE SET rev=rev+1; END;

CREATE TRIGGER day_rev_daily_update AFTER UPDATE ON daily
        BEGIN INSERT INTO day_revisions(day,rev) VALUES(OLD.day,1) ON CONFLICT(day) DO UPDATE SET rev=rev+1; INSERT INTO day_revisions(day,rev) VALUES(NEW.day,1) ON CONFLICT(day) DO UPDATE SET rev=rev+1; END;

CREATE TRIGGER day_rev_daily_delete AFTER DELETE ON daily
        BEGIN INSERT INTO day_revisions(day,rev) VALUES(OLD.day,1) ON CONFLICT(day) DO UPDATE SET rev=rev+1; END;

CREATE TRIGGER day_rev_sessions_insert AFTER INSERT ON day_sessions
        BEGIN INSERT INTO day_revisions(day,rev) VALUES(NEW.day,1) ON CONFLICT(day) DO UPDATE SET rev=rev+1; END;

CREATE TRIGGER day_rev_sessions_update AFTER UPDATE ON day_sessions
        BEGIN INSERT INTO day_revisions(day,rev) VALUES(OLD.day,1) ON CONFLICT(day) DO UPDATE SET rev=rev+1; INSERT INTO day_revisions(day,rev) VALUES(NEW.day,1) ON CONFLICT(day) DO UPDATE SET rev=rev+1; END;

CREATE TRIGGER day_rev_sessions_delete AFTER DELETE ON day_sessions
        BEGIN INSERT INTO day_revisions(day,rev) VALUES(OLD.day,1) ON CONFLICT(day) DO UPDATE SET rev=rev+1; END;

CREATE TRIGGER day_rev_legacy_insert AFTER INSERT ON legacy_days
        BEGIN INSERT INTO day_revisions(day,rev) VALUES(NEW.day,1) ON CONFLICT(day) DO UPDATE SET rev=rev+1; END;

CREATE TRIGGER day_rev_legacy_update AFTER UPDATE ON legacy_days
        BEGIN INSERT INTO day_revisions(day,rev) VALUES(OLD.day,1) ON CONFLICT(day) DO UPDATE SET rev=rev+1; INSERT INTO day_revisions(day,rev) VALUES(NEW.day,1) ON CONFLICT(day) DO UPDATE SET rev=rev+1; END;

CREATE TRIGGER day_rev_legacy_delete AFTER DELETE ON legacy_days
        BEGIN INSERT INTO day_revisions(day,rev) VALUES(OLD.day,1) ON CONFLICT(day) DO UPDATE SET rev=rev+1; END;

CREATE TRIGGER day_rev_routes_update AFTER UPDATE ON usage_routes BEGIN INSERT INTO day_revisions(day,rev) VALUES('',1) ON CONFLICT(day) DO UPDATE SET rev=rev+1; END;

CREATE TRIGGER day_rev_routes_delete AFTER DELETE ON usage_routes BEGIN INSERT INTO day_revisions(day,rev) VALUES('',1) ON CONFLICT(day) DO UPDATE SET rev=rev+1; END;

CREATE TRIGGER day_rev_session_names_update AFTER UPDATE ON usage_sessions BEGIN INSERT INTO day_revisions(day,rev) VALUES('',1) ON CONFLICT(day) DO UPDATE SET rev=rev+1; END;

CREATE TRIGGER day_rev_session_names_delete AFTER DELETE ON usage_sessions BEGIN INSERT INTO day_revisions(day,rev) VALUES('',1) ON CONFLICT(day) DO UPDATE SET rev=rev+1; END;
