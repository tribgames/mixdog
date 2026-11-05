-- Usage ledger, objects the 1.4.6-dev line added at user_version 2 without a
-- version bump (5 tables, 16 triggers): per-session day sums, their build
-- cursor and the revision tables. Byte-identical to the dev-written ledger.
-- Used only to recognize that shape (Dev146); v3 drops them (ledger_v3_drop_dev.sql)
-- because session_days_route rewrites every sum row of a route in one write.

CREATE TABLE usage_session_days (
        session INTEGER NOT NULL, day INTEGER NOT NULL, route INTEGER NOT NULL,
        turns INTEGER NOT NULL, input REAL NOT NULL, output REAL NOT NULL,
        cache_read REAL NOT NULL, cache_write REAL NOT NULL, cost_usd REAL NOT NULL,
        duration_ms REAL NOT NULL, speed_output REAL NOT NULL, speed_ms REAL NOT NULL,
        -- The route's provider and model, kept beside it for the route-key revisions.
        provider TEXT, model TEXT,
        PRIMARY KEY(session,day,route)
    ) WITHOUT ROWID;

CREATE TABLE usage_session_days_state (
        id INTEGER PRIMARY KEY CHECK(id=1), complete INTEGER NOT NULL, next INTEGER NOT NULL);

CREATE TABLE usage_session_revisions (session INTEGER PRIMARY KEY, rev INTEGER NOT NULL);

CREATE TABLE usage_key_revisions (
        day INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, rev INTEGER NOT NULL,
        PRIMARY KEY(day,provider,model)) WITHOUT ROWID;

CREATE TABLE usage_membership_revision (id INTEGER PRIMARY KEY CHECK(id=1), rev INTEGER NOT NULL);

INSERT OR IGNORE INTO usage_session_days_state
        SELECT 1,NOT EXISTS(SELECT 1 FROM usage_events),0;

INSERT OR IGNORE INTO usage_membership_revision VALUES (1,0);

CREATE TRIGGER session_days_duplicate BEFORE INSERT ON usage_events
        WHEN EXISTS (SELECT 1 FROM usage_events WHERE id=NEW.id) BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER session_days_id BEFORE UPDATE OF id ON usage_events
        WHEN NEW.id IS NOT OLD.id BEGIN SELECT RAISE(ABORT,'a usage record id does not change'); END;

CREATE TRIGGER session_days_insert AFTER INSERT ON usage_events
        BEGIN INSERT INTO usage_session_days
        SELECT NEW.session,NEW.day,NEW.route,1,NEW.input,NEW.output,NEW.cache_read,NEW.cache_write,
        COALESCE(NEW.cost_usd,0),NEW.duration_ms,
        CASE WHEN NEW.duration_ms>0 AND NEW.output>0 THEN NEW.output ELSE 0 END,CASE WHEN NEW.duration_ms>0 AND NEW.output>0 THEN NEW.duration_ms ELSE 0 END,
        (SELECT json_extract(signature,'$[0]') FROM usage_routes WHERE id=NEW.route),(SELECT json_extract(signature,'$[1]') FROM usage_routes WHERE id=NEW.route) WHERE (SELECT complete=1 OR NEW.session<next FROM usage_session_days_state)
        ON CONFLICT(session,day,route) DO UPDATE SET turns=turns+excluded.turns,input=input+excluded.input,
        output=output+excluded.output,cache_read=cache_read+excluded.cache_read,
        cache_write=cache_write+excluded.cache_write,cost_usd=cost_usd+excluded.cost_usd,
        duration_ms=duration_ms+excluded.duration_ms,speed_output=speed_output+excluded.speed_output,
        speed_ms=speed_ms+excluded.speed_ms; INSERT INTO usage_session_revisions VALUES (NEW.session,1) ON CONFLICT(session) DO UPDATE SET rev=rev+1; END;

CREATE TRIGGER session_days_delete AFTER DELETE ON usage_events
        BEGIN INSERT INTO usage_session_days
        SELECT OLD.session,OLD.day,OLD.route,-1,-OLD.input,-OLD.output,-OLD.cache_read,-OLD.cache_write,
        -COALESCE(OLD.cost_usd,0),-OLD.duration_ms,
        -CASE WHEN OLD.duration_ms>0 AND OLD.output>0 THEN OLD.output ELSE 0 END,-CASE WHEN OLD.duration_ms>0 AND OLD.output>0 THEN OLD.duration_ms ELSE 0 END,
        (SELECT json_extract(signature,'$[0]') FROM usage_routes WHERE id=OLD.route),(SELECT json_extract(signature,'$[1]') FROM usage_routes WHERE id=OLD.route) WHERE (SELECT complete=1 OR OLD.session<next FROM usage_session_days_state)
        ON CONFLICT(session,day,route) DO UPDATE SET turns=turns+excluded.turns,input=input+excluded.input,
        output=output+excluded.output,cache_read=cache_read+excluded.cache_read,
        cache_write=cache_write+excluded.cache_write,cost_usd=cost_usd+excluded.cost_usd,
        duration_ms=duration_ms+excluded.duration_ms,speed_output=speed_output+excluded.speed_output,
        speed_ms=speed_ms+excluded.speed_ms; INSERT INTO usage_session_revisions VALUES (OLD.session,1) ON CONFLICT(session) DO UPDATE SET rev=rev+1; END;

CREATE TRIGGER session_days_update AFTER UPDATE ON usage_events
        BEGIN INSERT INTO usage_session_days
        SELECT OLD.session,OLD.day,OLD.route,-1,-OLD.input,-OLD.output,-OLD.cache_read,-OLD.cache_write,
        -COALESCE(OLD.cost_usd,0),-OLD.duration_ms,
        -CASE WHEN OLD.duration_ms>0 AND OLD.output>0 THEN OLD.output ELSE 0 END,-CASE WHEN OLD.duration_ms>0 AND OLD.output>0 THEN OLD.duration_ms ELSE 0 END,
        (SELECT json_extract(signature,'$[0]') FROM usage_routes WHERE id=OLD.route),(SELECT json_extract(signature,'$[1]') FROM usage_routes WHERE id=OLD.route) WHERE (SELECT complete=1 OR OLD.session<next FROM usage_session_days_state)
        ON CONFLICT(session,day,route) DO UPDATE SET turns=turns+excluded.turns,input=input+excluded.input,
        output=output+excluded.output,cache_read=cache_read+excluded.cache_read,
        cache_write=cache_write+excluded.cache_write,cost_usd=cost_usd+excluded.cost_usd,
        duration_ms=duration_ms+excluded.duration_ms,speed_output=speed_output+excluded.speed_output,
        speed_ms=speed_ms+excluded.speed_ms; INSERT INTO usage_session_days
        SELECT NEW.session,NEW.day,NEW.route,1,NEW.input,NEW.output,NEW.cache_read,NEW.cache_write,
        COALESCE(NEW.cost_usd,0),NEW.duration_ms,
        CASE WHEN NEW.duration_ms>0 AND NEW.output>0 THEN NEW.output ELSE 0 END,CASE WHEN NEW.duration_ms>0 AND NEW.output>0 THEN NEW.duration_ms ELSE 0 END,
        (SELECT json_extract(signature,'$[0]') FROM usage_routes WHERE id=NEW.route),(SELECT json_extract(signature,'$[1]') FROM usage_routes WHERE id=NEW.route) WHERE (SELECT complete=1 OR NEW.session<next FROM usage_session_days_state)
        ON CONFLICT(session,day,route) DO UPDATE SET turns=turns+excluded.turns,input=input+excluded.input,
        output=output+excluded.output,cache_read=cache_read+excluded.cache_read,
        cache_write=cache_write+excluded.cache_write,cost_usd=cost_usd+excluded.cost_usd,
        duration_ms=duration_ms+excluded.duration_ms,speed_output=speed_output+excluded.speed_output,
        speed_ms=speed_ms+excluded.speed_ms;
        INSERT INTO usage_session_revisions VALUES (OLD.session,1) ON CONFLICT(session) DO UPDATE SET rev=rev+1; INSERT INTO usage_session_revisions VALUES (NEW.session,1) ON CONFLICT(session) DO UPDATE SET rev=rev+1; END;

CREATE TRIGGER key_revision_event_route AFTER UPDATE OF route,day ON usage_events
        WHEN OLD.route IS NOT NEW.route OR OLD.day IS NOT NEW.day
        BEGIN INSERT INTO usage_key_revisions VALUES (OLD.day,(SELECT json_extract(signature,'$[0]') FROM usage_routes WHERE id=OLD.route),(SELECT json_extract(signature,'$[1]') FROM usage_routes WHERE id=OLD.route),1)
        ON CONFLICT(day,provider,model) DO UPDATE SET rev=rev+1; INSERT INTO usage_key_revisions VALUES (NEW.day,(SELECT json_extract(signature,'$[0]') FROM usage_routes WHERE id=NEW.route),(SELECT json_extract(signature,'$[1]') FROM usage_routes WHERE id=NEW.route),1)
        ON CONFLICT(day,provider,model) DO UPDATE SET rev=rev+1; END;

CREATE TRIGGER key_revision_daily_insert AFTER INSERT ON daily
        WHEN NEW.rank < COALESCE((SELECT MIN(rank) FROM daily WHERE day=NEW.day AND provider=NEW.provider AND model=NEW.model
            AND NOT (rank=NEW.rank AND kind=NEW.kind AND cost_source=NEW.cost_source
                AND conversation=NEW.conversation)),1000000)
        BEGIN INSERT INTO usage_key_revisions VALUES (CAST(REPLACE(NEW.day,'-','') AS INTEGER),NEW.provider,NEW.model,1)
        ON CONFLICT(day,provider,model) DO UPDATE SET rev=rev+1; END;

CREATE TRIGGER key_revision_daily_delete AFTER DELETE ON daily
        WHEN OLD.rank <= COALESCE((SELECT MIN(rank) FROM daily WHERE day=OLD.day AND provider=OLD.provider AND model=OLD.model),1000000)
        BEGIN INSERT INTO usage_key_revisions VALUES (CAST(REPLACE(OLD.day,'-','') AS INTEGER),OLD.provider,OLD.model,1)
        ON CONFLICT(day,provider,model) DO UPDATE SET rev=rev+1; END;

CREATE TRIGGER key_revision_daily_update AFTER UPDATE ON daily
        WHEN OLD.rank IS NOT NEW.rank OR OLD.day IS NOT NEW.day OR OLD.provider IS NOT NEW.provider
            OR OLD.model IS NOT NEW.model
        BEGIN INSERT INTO usage_key_revisions VALUES (CAST(REPLACE(OLD.day,'-','') AS INTEGER),OLD.provider,OLD.model,1)
        ON CONFLICT(day,provider,model) DO UPDATE SET rev=rev+1; INSERT INTO usage_key_revisions VALUES (CAST(REPLACE(NEW.day,'-','') AS INTEGER),NEW.provider,NEW.model,1)
        ON CONFLICT(day,provider,model) DO UPDATE SET rev=rev+1; END;

CREATE TRIGGER session_days_route AFTER UPDATE OF signature ON usage_routes
        WHEN json_extract(OLD.signature,'$[0]') IS NOT json_extract(NEW.signature,'$[0]')
            OR json_extract(OLD.signature,'$[1]') IS NOT json_extract(NEW.signature,'$[1]')
        BEGIN
            UPDATE usage_session_days SET provider=json_extract(NEW.signature,'$[0]'),
                model=json_extract(NEW.signature,'$[1]') WHERE route=NEW.id;
        END;

CREATE TRIGGER membership_usage_routes_update
        AFTER UPDATE ON usage_routes BEGIN UPDATE usage_membership_revision SET rev=rev+1; END;

CREATE TRIGGER membership_usage_routes_delete
        AFTER DELETE ON usage_routes BEGIN UPDATE usage_membership_revision SET rev=rev+1; END;

CREATE TRIGGER membership_usage_sessions_update
        AFTER UPDATE ON usage_sessions BEGIN UPDATE usage_membership_revision SET rev=rev+1; END;

CREATE TRIGGER membership_usage_sessions_delete
        AFTER DELETE ON usage_sessions BEGIN UPDATE usage_membership_revision SET rev=rev+1; END;

CREATE TRIGGER membership_usage_session_owners_update
        AFTER UPDATE ON usage_session_owners BEGIN UPDATE usage_membership_revision SET rev=rev+1; END;

CREATE TRIGGER membership_usage_session_owners_delete
        AFTER DELETE ON usage_session_owners BEGIN UPDATE usage_membership_revision SET rev=rev+1; END;
