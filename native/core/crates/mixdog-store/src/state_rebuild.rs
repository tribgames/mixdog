//! What a fresh `state/core.sqlite` (after `CoreState::open_or_set_aside` kept a damaged one) can be given back from the
//! session catalog, which holds the sessions' own recorded fields.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::Value;

use crate::sqlite::DbError;
use crate::sqlite::SqliteStore;
use crate::state::CoreState;
use crate::state::ProjectRow;

/// One `projects` row per Project a session was opened in (`desktopSession.classification` "project", its `projectPath`), named
/// as `add` names it (the folder) and last used when its newest session was; returns how many. The aliases, hidden marks and
/// renames of the lost rows, and a Project no session was opened in, cannot be known and stay lost.
pub async fn rebuild_projects(state: &CoreState, index: &SqliteStore) -> Result<usize, DbError> {
    let mut newest: BTreeMap<String, Option<i64>> = BTreeMap::new();
    for listed in index.list_sessions(false, None, None).await? {
        let Some(desktop) = listed.row.get("desktopSession").and_then(Value::as_object) else { continue };
        if desktop.get("classification").and_then(Value::as_str) != Some("project") {
            continue;
        }
        let Some(path) = desktop.get("projectPath").and_then(Value::as_str) else { continue };
        let used = ["lastUsedAt", "updatedAt"]
            .iter()
            .filter_map(|key| listed.row.get(*key).and_then(Value::as_f64))
            .find(|ms| *ms > 0.0)
            .map(|ms| ms as i64);
        let slot = newest.entry(path.to_owned()).or_insert(None);
        *slot = (*slot).max(used);
    }
    let rows: Vec<ProjectRow> = newest
        .into_iter()
        .map(|(path, last_used_at)| ProjectRow {
            name: Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()),
            path,
            alias: None,
            hidden: false,
            hidden_rank: None,
            last_used_at,
        })
        .collect();
    let count = rows.len();
    state
        .write(move |tx| {
            for row in &rows {
                tx.put_project(row)?;
            }
            Ok(())
        })
        .await?;
    Ok(count)
}
