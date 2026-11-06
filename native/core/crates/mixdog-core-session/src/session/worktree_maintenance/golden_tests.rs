//! The worktree cleanup job against Node's real modules (`fixtures/maintenance-jobs/golden.json`,
//! recorded by `record-maintenance-jobs.mjs`): when the schedule first runs it and how often,
//! and which worktrees one pass selects to remove or keeps.

use std::collections::HashMap;
use std::collections::HashSet;
use std::time::Duration;

use mixdog_scm::worktree::maintenance::CLEANUP_MAX_REMOVALS;
use mixdog_scm::worktree::maintenance::CLEANUP_MIN_AGE_MS;
use mixdog_scm::worktree::maintenance::CleanupReason;
use mixdog_scm::worktree::maintenance::CleanupRow;
use mixdog_scm::worktree::maintenance::SelectOptions;
use mixdog_scm::worktree::maintenance::select_worktree_cleanup;
use mixdog_scm::worktree::settings::WorktreeSettings;
use serde_json::Value;

use super::CLEANUP_INITIAL_DELAY;
use super::CLEANUP_INTERVAL;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/maintenance-jobs/golden.json")).unwrap()
}

#[test]
fn the_cleanup_is_first_due_after_three_minutes_then_hourly() {
    let constants = &golden()["constants"];
    assert_eq!(CLEANUP_INITIAL_DELAY, Duration::from_millis(constants["cleanupInitialDelayMs"].as_u64().unwrap()));
    assert_eq!(CLEANUP_INTERVAL, Duration::from_millis(constants["cleanupIntervalMs"].as_u64().unwrap()));
    let worktree = &golden()["worktree"]["constants"];
    assert_eq!(CLEANUP_MIN_AGE_MS, worktree["minAgeMs"].as_i64().unwrap());
    assert_eq!(CLEANUP_MAX_REMOVALS as u64, worktree["maxRemovals"].as_u64().unwrap());
}

fn row(value: &Value) -> CleanupRow {
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
    CleanupRow {
        id: text("id").unwrap(),
        repo_common_dir: text("repoCommonDir").unwrap(),
        is_snapshot: text("kind").as_deref() == Some("snapshot"),
        state: text("state").unwrap(),
        dirty: value["dirty"].as_u64().unwrap(),
        unmerged: value["unmerged"].as_u64().unwrap(),
        owner_live: value["ownerLive"].as_bool().unwrap_or(false),
        in_use: value["inUse"].as_bool().unwrap_or(false),
        owner_session_id: text("ownerSessionId"),
        shared_session_ids: value["sharedSessionIds"].as_array().map_or_else(Vec::new, |ids| ids.iter().map(|id| id.as_str().unwrap().to_owned()).collect()),
        created_at: value["createdAt"].as_i64().unwrap(),
    }
}

/// Each recorded set of rows, settings and options selects the same worktrees, for the same
/// reason, in the same order: dirty, unmerged, live, in-use, shared, favorite, young, snapshot
/// and half-created ones are kept; the per-pass cap and a repository scope apply.
#[test]
fn one_pass_selects_what_nodes_selects() {
    let golden = golden();
    let now = golden["worktree"]["NOW"].as_i64().unwrap();
    for case in golden["worktree"]["select"].as_array().unwrap() {
        let input = &case["input"];
        let rows: Vec<CleanupRow> = input["rows"].as_array().unwrap().iter().map(row).collect();
        let s = &input["settings"];
        let settings = WorktreeSettings {
            auto_cleanup: s["autoCleanup"].as_bool().unwrap(),
            max_worktrees: s["maxWorktrees"].as_u64().unwrap(),
            unused_days: s["unusedDays"].as_u64().unwrap(),
            ..WorktreeSettings::default()
        };
        let activity: HashMap<String, i64> = input["activity"].as_object().map_or_else(HashMap::new, |map| map.iter().map(|(id, at)| (id.clone(), at.as_i64().unwrap())).collect());
        let favorites: HashSet<String> = input["favoriteSessionIds"].as_array().map_or_else(HashSet::new, |ids| ids.iter().map(|id| id.as_str().unwrap().to_owned()).collect());
        let options = SelectOptions {
            now,
            activity: &activity,
            favorite_session_ids: &favorites,
            potential: input["potential"].as_bool().unwrap_or(false),
            repo_common_dir: input["repoCommonDir"].as_str(),
            max_removals: input["maxRemovals"].as_u64().map_or(CLEANUP_MAX_REMOVALS, |n| n as usize),
        };
        let got: Vec<(String, &str, i64)> = select_worktree_cleanup(&rows, &settings, &options)
            .into_iter()
            .map(|picked| (picked.id, if picked.reason == CleanupReason::Age { "age" } else { "count" }, picked.last_active_at))
            .collect();
        let want: Vec<(String, &str, i64)> = case["selected"]
            .as_array()
            .unwrap()
            .iter()
            .map(|picked| (picked["id"].as_str().unwrap().to_owned(), picked["reason"].as_str().unwrap(), picked["lastActiveAt"].as_i64().unwrap()))
            .collect();
        assert_eq!(got, want, "{input}");
    }
}
