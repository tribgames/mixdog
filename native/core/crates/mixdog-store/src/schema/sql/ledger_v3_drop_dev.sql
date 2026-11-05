-- Dev146 → v3, step 1 (FORMAT.md §9.2): removes the 21 objects the 1.4.6-dev line added
-- (ledger_v2_session_days.sql), leaving exactly the 1.4.5 objects; ledger_v3.sql follows
-- in the same transaction. The sums and revision counters are derived: the sums are
-- rebuilt by the resumable build step, the counters only key in-memory caches.

DROP TRIGGER session_days_duplicate;
DROP TRIGGER session_days_id;
DROP TRIGGER session_days_insert;
DROP TRIGGER session_days_delete;
DROP TRIGGER session_days_update;
DROP TRIGGER key_revision_event_route;
DROP TRIGGER key_revision_daily_insert;
DROP TRIGGER key_revision_daily_delete;
DROP TRIGGER key_revision_daily_update;
DROP TRIGGER session_days_route;
DROP TRIGGER membership_usage_routes_update;
DROP TRIGGER membership_usage_routes_delete;
DROP TRIGGER membership_usage_sessions_update;
DROP TRIGGER membership_usage_sessions_delete;
DROP TRIGGER membership_usage_session_owners_update;
DROP TRIGGER membership_usage_session_owners_delete;
DROP TABLE usage_session_days;
DROP TABLE usage_session_days_state;
DROP TABLE usage_session_revisions;
DROP TABLE usage_key_revisions;
DROP TABLE usage_membership_revision;
