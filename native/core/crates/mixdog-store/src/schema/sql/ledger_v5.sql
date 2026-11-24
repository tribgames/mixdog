-- Usage ledger v5 delta: applied to a v4 ledger inside the BEGIN IMMEDIATE transaction that sets user_version.
--
-- Whether a limit window is rolling, its use ageing out continuously instead of resetting, is what its provider
-- declares, recorded with each reading; a reading recorded before the declaration was kept reads as a fixed window.

ALTER TABLE quota_samples ADD COLUMN rolling INTEGER NOT NULL DEFAULT 0;

-- A record counts over its run, which ended at `ts`: the records still running at the end of a range end no later
-- than the longest run of their routes past it, and this index answers that longest run without a scan.
CREATE INDEX usage_events_route_duration ON usage_events(route, duration_ms);

PRAGMA user_version = 5;
