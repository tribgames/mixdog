//! The pending Goal reminder a turn carries at the model request boundary (Node
//! `runtime-core/goal-reminder.mjs`): `snapshotPendingGoalReminder` at the turn's start,
//! `acknowledgePendingGoalReminder` once the turn was accepted.

use mixdog_js::js_trim;
use mixdog_js::json_number;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::HeaderChange;
use serde_json::Value;
use serde_json::json;

use crate::goal::js::Goal;

/// Stalled states the model is told about when they begin.
const STALL_NOTICE_STATUSES: [&str; 3] = ["paused", "blocked", "usage_limited"];

/// What a turn carries: the revision it acknowledges and the tail text.
#[derive(Clone, Debug, PartialEq)]
pub struct GoalReminder {
    pub revision: u64,
    pub content: String,
}

/// `Math.max(0, Number(x) || 0)`.
fn count(value: Option<&Value>) -> f64 {
    let number = mixdog_js::to_number_of(value);
    if number.is_nan() { 0.0 } else { number.max(0.0) }
}

fn pending_revision(header: &Header) -> f64 {
    count(header.get("pendingGoalReminder").and_then(|pending| pending.get("revision")))
}

fn text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => js_trim(&mixdog_js::value_to_string(value)).to_owned(),
    }
}

fn set(change: &mut HeaderChange, key: &str, value: Value) {
    change.unset.retain(|k| k != key);
    change.set.insert(key.to_owned(), value);
}

fn unset(change: &mut HeaderChange, key: &str) {
    change.set.shift_remove(key);
    if !change.unset.iter().any(|k| k == key) {
        change.unset.push(key.to_owned());
    }
}

/// `snapshotPendingGoalReminder(session, { includePaused: true })` over the session header,
/// the Goal the runtime shows and the session's todo list: the reminder this turn carries and
/// the header change the read makes (`None` change fields when it touched nothing).
pub fn snapshot(header: &Header, goal: Option<Goal>, todo: &mixdog_tools::state::todo::TodoList, now: i64) -> (Option<GoalReminder>, HeaderChange) {
    let mut change = HeaderChange { set: serde_json::Map::new(), unset: Vec::new() };
    let mut revision = pending_revision(header);
    let mut goal = goal.filter(|goal| goal.get("status").and_then(Value::as_str) != Some("complete"));
    let marked = text(header.get("pendingGoalReminder").and_then(|pending| pending.get("reason")));
    let status = |goal: &Option<Goal>| goal.as_ref().map(|goal| text(goal.get("status")));
    // A Goal that left the stalled states is told afresh if it stalls again.
    // (`delete session.goalStalledNotice` changes nothing when it was never set.)
    if (goal.is_none() || status(&goal).as_deref() == Some("active")) && header.contains_key("goalStalledNotice") {
        unset(&mut change, "goalStalledNotice");
    }
    // A stalled Goal is told once, when it stalls; compaction does not re-inject it.
    if marked == "compaction" && goal.is_some() && status(&goal).as_deref() != Some("active") {
        goal = None;
    }
    // Compaction drops the todo tool results too: the open list rides once.
    let todo_block = if revision != 0.0 && marked == "compaction" {
        todo.context_block("Context was compacted; your todo list (exact wordings):", false)
    } else {
        String::new()
    };
    let clear = |change: &mut HeaderChange| {
        if header.contains_key("pendingGoalReminder") {
            unset(change, "pendingGoalReminder");
            set(change, "updatedAt", json!(now));
        }
    };
    if goal.is_none() {
        if todo_block.is_empty() {
            clear(&mut change);
            return (None, change);
        }
        return finish(header, change, revision, None, todo_block, now);
    }
    if revision == 0.0 {
        let goal = goal.as_ref().expect("a Goal is shown here");
        let status = text(goal.get("status"));
        if !STALL_NOTICE_STATUSES.contains(&status.as_str()) {
            return (None, change);
        }
        // One notice per stall: a later pause, block or limit of the same Goal is a new stall.
        let stall = format!("{}:{}:{}", text(goal.get("id")), status, json_number(count(goal.get("turnCount"))));
        if header.get("goalStalledNotice").and_then(Value::as_str) == Some(stall.as_str()) {
            return (None, change);
        }
        set(&mut change, "goalStalledNotice", json!(stall));
        // `markPendingGoalReminder(session, goal.status)`.
        revision = pending_revision(header).max(count(header.get("goalReminderRevision"))) + 1.0;
        let mark = if status.is_empty() { "compaction".to_owned() } else { status };
        set(&mut change, "goalReminderRevision", json_number(revision));
        set(&mut change, "pendingGoalReminder", json!({ "version": 1, "type": "goal_state", "revision": json_number(revision), "reason": mark }));
        set(&mut change, "updatedAt", json!(now));
    }
    finish(header, change, revision, goal, todo_block, now)
}

fn finish(header: &Header, mut change: HeaderChange, revision: f64, goal: Option<Goal>, todo_block: String, now: i64) -> (Option<GoalReminder>, HeaderChange) {
    let reason = match change.set.get("pendingGoalReminder") {
        Some(pending) => text(pending.get("reason")),
        None => text(header.get("pendingGoalReminder").and_then(|pending| pending.get("reason"))),
    };
    let goal_content = crate::goal::text::goal_state_reminder(goal.as_ref(), &reason);
    let todo = if todo_block.is_empty() { String::new() } else { format!("<system-reminder>\n{todo_block}\n</system-reminder>") };
    let content = [goal_content, todo].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join("\n\n");
    if content.is_empty() {
        if header.contains_key("pendingGoalReminder") || change.set.contains_key("pendingGoalReminder") {
            unset(&mut change, "pendingGoalReminder");
            set(&mut change, "updatedAt", json!(now));
        }
        return (None, change);
    }
    (Some(GoalReminder { revision: revision as u64, content }), change)
}

/// `acknowledgePendingGoalReminder(session, revision)`: the marker goes only if it is still the
/// revision the turn carried.
pub fn acknowledge(header: &Header, revision: u64, now: i64) -> Option<HeaderChange> {
    let current = pending_revision(header);
    if current == 0.0 || current != revision as f64 {
        return None;
    }
    let mut change = HeaderChange { set: serde_json::Map::new(), unset: Vec::new() };
    unset(&mut change, "pendingGoalReminder");
    set(&mut change, "updatedAt", json!(now));
    Some(change)
}

#[cfg(test)]
mod tests {
    use mixdog_tools::state::todo::TodoList;

    use super::*;

    fn object(value: Value) -> serde_json::Map<String, Value> {
        let Value::Object(map) = value else { unreachable!() };
        map
    }

    fn goal(status: &str) -> Goal {
        object(json!({ "id": "g1", "objective": "Ship it", "title": "Ship it", "status": status, "turnCount": 3, "remainingMs": 1000, "timeLimitMs": 600000, "timeUsedMs": 1 }))
    }

    #[test]
    fn a_marked_reminder_carries_the_goals_state_and_leaves_the_marker_until_acknowledged() {
        let header = object(json!({ "pendingGoalReminder": { "version": 1, "type": "goal_state", "revision": 2, "reason": "objective-updated" } }));
        let (reminder, change) = snapshot(&header, Some(goal("active")), &TodoList::default(), 5);
        let reminder = reminder.expect("a reminder");
        assert_eq!(reminder.revision, 2);
        assert_eq!(reminder.content, crate::goal::text::goal_state_reminder(Some(&goal("active")), "objective-updated"));
        assert!(!change.set.contains_key("pendingGoalReminder") && !change.unset.contains(&"pendingGoalReminder".to_owned()));
        // A newer mark since the turn started stays.
        assert!(acknowledge(&header, 1, 6).is_none());
        let ack = acknowledge(&header, 2, 6).expect("the same revision");
        assert_eq!((ack.unset, ack.set.get("updatedAt").cloned()), (vec!["pendingGoalReminder".to_owned()], Some(json!(6))));
    }

    #[test]
    fn a_marker_with_nothing_to_remind_about_is_dropped() {
        let header = object(json!({ "pendingGoalReminder": { "revision": 1, "reason": "compaction" }, "goalStalledNotice": "g1:paused:3" }));
        let (reminder, change) = snapshot(&header, None, &TodoList::default(), 9);
        assert!(reminder.is_none());
        assert!(change.unset.contains(&"pendingGoalReminder".to_owned()) && change.unset.contains(&"goalStalledNotice".to_owned()));
        // A completed Goal is no Goal.
        assert!(snapshot(&header, Some(goal("complete")), &TodoList::default(), 9).0.is_none());
        // Compaction does not re-inject a stalled Goal.
        assert!(snapshot(&header, Some(goal("paused")), &TodoList::default(), 9).0.is_none());
    }

    #[test]
    fn a_stalled_goal_is_told_once_per_stall() {
        let (reminder, change) = snapshot(&object(json!({})), Some(goal("paused")), &TodoList::default(), 4);
        let reminder = reminder.expect("told when it stalls");
        assert_eq!(reminder.revision, 1);
        assert_eq!(reminder.content, crate::goal::text::goal_state_reminder(Some(&goal("paused")), "paused"));
        assert_eq!(change.set.get("goalStalledNotice"), Some(&json!("g1:paused:3")));
        assert_eq!(change.set.get("goalReminderRevision"), Some(&json!(1)));
        assert_eq!(change.set.get("pendingGoalReminder"), Some(&json!({ "version": 1, "type": "goal_state", "revision": 1, "reason": "paused" })));
        let told = object(json!({ "goalStalledNotice": "g1:paused:3" }));
        assert!(snapshot(&told, Some(goal("paused")), &TodoList::default(), 4).0.is_none());
        // An active Goal needs no notice and forgets the stall.
        let (none, forget) = snapshot(&told, Some(goal("active")), &TodoList::default(), 4);
        assert!(none.is_none() && forget.unset.contains(&"goalStalledNotice".to_owned()));
        // A header with nothing to forget or mark is left as it is: no record per turn.
        let (none, nothing) = snapshot(&object(json!({})), Some(goal("active")), &TodoList::default(), 4);
        assert!(none.is_none() && nothing.set.is_empty() && nothing.unset.is_empty());
        let (none, nothing) = snapshot(&object(json!({})), None, &TodoList::default(), 4);
        assert!(none.is_none() && nothing.set.is_empty() && nothing.unset.is_empty());
    }
}
