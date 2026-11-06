//! How each store statement of schedules-db.mjs changes a stored row. Every `ScheduleStore`
//! applies these, so the in-memory and the durable store cannot disagree on a rule.

use serde_json::Value;

use super::model::{PAUSE_AFTER_FAILURES, Schedule, ScheduleStatus};
use super::store::Ts;

/// Claims one slot: only an active, enabled row whose last claimed slot is older takes it.
/// `started_at` is set for a run (not for a skipped slot's cursor move).
pub fn claim(s: &mut Schedule, scheduled_at: Ts, started_at: Option<Ts>, next: Option<Ts>) -> bool {
    if s.status != ScheduleStatus::Active || !s.enabled || s.last_scheduled_at.is_some_and(|t| t >= scheduled_at) {
        return false;
    }
    s.last_scheduled_at = Some(scheduled_at);
    if let Some(started) = started_at {
        s.last_started_at = Some(started);
        s.last_fired_at = Some(started);
    }
    s.next_fire_at = next;
    true
}

pub fn success(s: &mut Schedule, at: Ts) {
    s.last_success_at = Some(at);
    s.consecutive_failures = 0;
}

/// One more failure in a row; the one reaching the pause limit switches the row off.
pub fn failure(s: &mut Schedule, at: Ts) {
    s.last_failed_at = Some(at);
    s.consecutive_failures += 1;
    s.enabled = s.enabled && s.consecutive_failures < PAUSE_AFTER_FAILURES;
}

pub fn done(s: &mut Schedule) {
    s.status = ScheduleStatus::Done;
    s.next_fire_at = None;
}

/// A save: the row `def` describes. A redefinition clears the stale runtime state and
/// reactivates, so the re-registered schedule is due again; undelivered results survive.
pub fn redefined(def: &Schedule, existing: Option<&Schedule>, now: Ts) -> Schedule {
    Schedule {
        name: def.name.clone(),
        description: def.description.clone(),
        when_at: def.when_at,
        when_cron: def.when_cron.clone(),
        timezone: def.timezone.clone(),
        cwd: def.cwd.clone(),
        attachments: def.attachments.clone(),
        delivery: def.delivery.clone(),
        prompt: def.prompt.clone(),
        enabled: def.enabled,
        status: ScheduleStatus::Active,
        next_fire_at: def.next_fire_at,
        owner_agent_id: owner_of(def),
        executor_agent_id: def.executor_agent_id.clone().filter(|e| !e.is_empty()),
        result_delivery: existing.and_then(|e| e.result_delivery.clone()),
        created_at: existing.and_then(|e| e.created_at).or(Some(now)),
        updated_at: Some(now),
        ..Schedule::default()
    }
}

fn owner_of(def: &Schedule) -> String {
    if def.owner_agent_id.is_empty() { "lead".into() } else { def.owner_agent_id.clone() }
}

/// The row after moving `old` to `def.name` with the edited settings. Run history, status and
/// the next-fire cursor stay; when `timing_changed` the row is re-armed the way a
/// redefinition arms it.
pub fn renamed(old: &Schedule, def: &Schedule, timing_changed: bool, now: Ts) -> Schedule {
    let mut row = Schedule {
        name: def.name.clone(),
        description: def.description.clone(),
        when_at: def.when_at,
        when_cron: def.when_cron.clone(),
        timezone: def.timezone.clone(),
        cwd: def.cwd.clone(),
        attachments: def.attachments.clone(),
        prompt: def.prompt.clone(),
        enabled: def.enabled,
        owner_agent_id: owner_of(def),
        executor_agent_id: def.executor_agent_id.clone().filter(|e| !e.is_empty()),
        updated_at: Some(now),
        ..old.clone()
    };
    if timing_changed {
        row.next_fire_at = def.when_at;
        row.status = ScheduleStatus::Active;
        row.deferred_until = None;
        row.skipped_until = None;
        row.last_fired_at = None;
        row.last_scheduled_at = None;
    }
    row
}

/// Switching a schedule back on clears its failure streak.
pub fn enabled(s: &mut Schedule, on: bool) {
    s.enabled = on;
    if on {
        s.consecutive_failures = 0;
    }
}

/// Sets (`entry`) or clears (None) the undelivered result of run `run_id`.
pub fn delivery(s: &mut Schedule, run_id: &str, entry: Option<Value>) {
    let mut map = match s.result_delivery.take() {
        Some(Value::Object(map)) => map,
        _ => Default::default(),
    };
    match entry {
        Some(entry) => {
            map.insert(run_id.to_string(), entry);
        }
        None => {
            map.shift_remove(run_id);
        }
    }
    s.result_delivery = (!map.is_empty()).then_some(Value::Object(map));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> Ts {
        s.parse().unwrap()
    }

    fn row() -> Schedule {
        Schedule { name: "a".into(), prompt: "p".into(), when_cron: Some("0 9 * * *".into()), ..Default::default() }
    }

    #[test]
    fn redefinition_clears_runtime_state_but_keeps_undelivered_results() {
        let mut old = row();
        old.consecutive_failures = 3;
        old.status = ScheduleStatus::Done;
        old.last_success_at = Some(at("2025-01-01T00:00:00Z"));
        old.created_at = Some(at("2024-01-01T00:00:00Z"));
        delivery(&mut old, "r1", Some(serde_json::json!({"state":"pending"})));
        let now = at("2025-02-01T00:00:00Z");
        let fresh = redefined(&row(), Some(&old), now);
        assert_eq!((fresh.consecutive_failures, fresh.status, fresh.last_success_at), (0, ScheduleStatus::Active, None));
        assert_eq!(fresh.created_at, old.created_at);
        assert_eq!(fresh.result_delivery, old.result_delivery);
        assert_eq!(redefined(&row(), None, now).created_at, Some(now));
    }

    #[test]
    fn rename_keeps_history_unless_timing_changed() {
        let mut old = row();
        old.last_success_at = Some(at("2025-01-01T00:00:00Z"));
        old.last_scheduled_at = Some(at("2025-01-01T09:00:00Z"));
        old.next_fire_at = Some(at("2025-01-02T09:00:00Z"));
        let mut def = row();
        def.name = "b".into();
        let kept = renamed(&old, &def, false, at("2025-01-01T12:00:00Z"));
        assert_eq!((kept.name.as_str(), kept.last_scheduled_at, kept.next_fire_at), ("b", old.last_scheduled_at, old.next_fire_at));
        let rearmed = renamed(&old, &def, true, at("2025-01-01T12:00:00Z"));
        assert_eq!((rearmed.last_scheduled_at, rearmed.last_success_at), (None, old.last_success_at));
    }

    #[test]
    fn failures_pause_at_the_limit_and_enabling_resets_the_streak() {
        let mut s = row();
        for _ in 0..PAUSE_AFTER_FAILURES {
            failure(&mut s, at("2025-01-01T00:00:00Z"));
        }
        assert!(!s.enabled);
        enabled(&mut s, true);
        assert_eq!((s.enabled, s.consecutive_failures), (true, 0));
    }

    #[test]
    fn claims_are_once_per_slot() {
        let mut s = row();
        let slot = at("2025-01-01T09:00:00Z");
        assert!(claim(&mut s, slot, Some(slot), None));
        assert!(!claim(&mut s, slot, Some(slot), None));
        s.enabled = false;
        assert!(!claim(&mut s, at("2025-01-02T09:00:00Z"), None, None));
    }

    #[test]
    fn delivery_entries_come_and_go_by_run_id() {
        let mut s = row();
        delivery(&mut s, "r1", Some(serde_json::json!({"state":"failed"})));
        delivery(&mut s, "r2", Some(serde_json::json!({"state":"pending"})));
        delivery(&mut s, "r1", None);
        assert_eq!(s.result_delivery, Some(serde_json::json!({"r2":{"state":"pending"}})));
        delivery(&mut s, "r2", None);
        assert_eq!(s.result_delivery, None);
    }
}
