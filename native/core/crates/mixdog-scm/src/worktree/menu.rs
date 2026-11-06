//! The branch menu's rows (Node `contract.mjs` `branchMenuEntries`).

use serde_json::Value;
use serde_json::json;

/// The desktop `DesktopGitBranch` rows for the local branch `names` the manager lists:
/// `current` marks the branch checked out in the project folder, `committedAt` (branch → ISO
/// time of its tip) becomes `lastCommitAt`.
pub fn branch_menu_entries(names: &[Value], occupancy: &[Value], committed_at: &Value) -> Vec<Value> {
    let current: Vec<&Value> = occupancy.iter().filter(|row| row["kind"] == "current").map(|row| &row["branch"]).collect();
    names
        .iter()
        .map(|name| {
            let mut entry = json!({ "name": name, "current": current.contains(&name), "remote": false, "upstream": "" });
            if let Some(at) = name.as_str().and_then(|n| committed_at.get(n)).filter(|at| at.as_str().is_some_and(|s| !s.is_empty())) {
                entry["lastCommitAt"] = at.clone();
            }
            entry
        })
        .collect()
}
