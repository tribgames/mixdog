//! Where a run's findings sit in the working tree: files already modified or untracked versus
//! files clean in the repository. `fix apply:true` writes every fixable finding inside the caller's
//! paths, so a directory scope rewrites files nobody touched; the split is a report the caller
//! reads before writing. Scope still comes from `paths`; nothing here derives one from a diff.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::languages::normalize_rel;
use super::process::{Processes, RunOptions, which};

pub const NO_GIT_REASON: &str = "git is not installed";

#[derive(Debug, Default)]
pub struct Changes {
    /// `None` when there is no split to report.
    pub files: Option<HashSet<String>>,
    pub error: String,
    pub skipped: Option<&'static str>,
}

/// Porcelain paths are repository-root relative; a cwd below the root rebases them and drops
/// whatever sits outside, since no scoped file can match it.
fn add_relative(files: &mut HashSet<String>, raw: &str, prefix: &str) {
    let path = normalize_rel(raw);
    if path.is_empty() {
        return;
    }
    if prefix.is_empty() {
        files.insert(path);
    } else if let Some(rest) = path.strip_prefix(prefix) {
        files.insert(rest.to_owned());
    }
}

pub fn parse_status(porcelain_z: &str, show_prefix: &str) -> HashSet<String> {
    let prefix = normalize_rel(mixdog_js::js_trim(show_prefix));
    let base = if !prefix.is_empty() && !prefix.ends_with('/') { format!("{prefix}/") } else { prefix };
    let records: Vec<&str> = porcelain_z.split('\0').collect();
    let mut files = HashSet::new();
    let mut i = 0;
    while i < records.len() {
        let record = records[i];
        if mixdog_js::utf16_len(record) >= 4 {
            // `R`/`C` in the index column: the next record is the old path, also a change.
            if record.starts_with(['R', 'C']) {
                i += 1;
                if let Some(old) = records.get(i) {
                    add_relative(&mut files, old, &base);
                }
            }
            add_relative(&mut files, &record[3..], &base);
        }
        i += 1;
    }
    files
}

/// Files git reports as changed (staged, unstaged or untracked) relative to `cwd`. No git on
/// PATH is expected and comes back `skipped`; git that cannot answer comes back with an `error`.
pub async fn list_working_tree_changes(processes: &Processes, cwd: &Path, cancel: Option<&CancellationToken>) -> Changes {
    let Some(git) = which("git", None, None) else { return Changes { skipped: Some(NO_GIT_REASON), ..Default::default() } };
    let git = git.to_string_lossy().into_owned();
    let run = |args: &[&str]| {
        let args: Vec<String> = args.iter().map(|s| (*s).to_owned()).collect();
        let git = git.clone();
        async move {
            let mut o = RunOptions::new(cwd);
            o.cancel = cancel;
            o.timeout = Duration::from_secs(20);
            processes.run(&git, &args, o).await
        }
    };
    let (status, prefix) = tokio::join!(
        run(&["-c", "core.quotepath=false", "--literal-pathspecs", "status", "--porcelain", "-z", "--untracked-files=all"]),
        run(&["rev-parse", "--show-prefix"])
    );
    if let Some(failed) = [&status, &prefix].into_iter().find(|r| r.code != 0) {
        let err = mixdog_js::slice_utf16(mixdog_js::js_trim(&failed.stderr), 200);
        return Changes { error: if !err.is_empty() { err } else if !failed.error.is_empty() { failed.error.clone() } else { format!("git status exited {}", failed.code) }, ..Default::default() };
    }
    Changes { files: Some(parse_status(&status.stdout, &prefix.stdout)), ..Default::default() }
}

/// Splits the files a run produced findings for. `findings` maps a path to its row count.
pub fn split_findings_by_worktree(findings: &BTreeMap<String, usize>, changed: &HashSet<String>) -> Value {
    let (mut modified, mut clean) = ((Vec::new(), 0usize), (Vec::new(), 0usize));
    // Node orders by `localeCompare`, which the BTreeMap's byte order is not.
    let mut ordered: Vec<(&String, &usize)> = findings.iter().collect();
    ordered.sort_by(|a, b| mixdog_js::locale_compare(a.0, b.0));
    for (file, count) in ordered {
        let group = if changed.contains(file) { &mut modified } else { &mut clean };
        group.0.push(file.clone());
        group.1 += count;
    }
    json!({"modified": {"files": modified.0, "findings": modified.1}, "clean": {"files": clean.0, "findings": clean.1}})
}

/// What a caller has to know before `apply:true` writes outside their edits.
pub fn worktree_notes(working_tree: Option<&Value>, action: &str) -> Vec<String> {
    let Some(w) = working_tree else { return Vec::new() };
    // No git is not worth a warning on every run; a git that cannot answer is.
    if w.get("skipped").is_some_and(|s| !s.is_null()) {
        return Vec::new();
    }
    if let Some(e) = w.get("error").and_then(Value::as_str).filter(|e| !e.is_empty()) {
        return vec![format!("working-tree split unavailable: {e}")];
    }
    let clean = w.pointer("/clean/files").and_then(Value::as_array).map_or(0, Vec::len);
    if clean == 0 {
        return Vec::new();
    }
    let writes = if action == "fix" { "apply:true writes them too" } else { "a fix apply:true would write them too" };
    vec![format!("workingTree.clean: {clean} file(s) with findings are unmodified in the repository; {writes} — pass those files in paths only when you mean to touch them")]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_records_include_both_sides_of_a_rename_and_rebase_to_cwd() {
        let out = " M src/a.ts\0?? new.ts\0R  src/new.ts\0src/old.ts\0A  other/x.ts\0";
        let all = parse_status(out, "");
        assert!(["src/a.ts", "new.ts", "src/new.ts", "src/old.ts", "other/x.ts"].iter().all(|f| all.contains(*f)));
        let below = parse_status(out, "src/");
        assert!(below.contains("a.ts") && below.contains("old.ts") && below.contains("new.ts"), "src/ files rebase to the cwd");
        assert!(!below.contains("x.ts") && !below.contains("other/x.ts"), "files outside the cwd are dropped");
        assert!(parse_status("ab\0", "").is_empty());
    }

    #[test]
    fn findings_split_into_modified_and_clean_groups() {
        let findings = BTreeMap::from([("b.ts".to_owned(), 2), ("a.ts".to_owned(), 1), ("c.ts".to_owned(), 4)]);
        let split = split_findings_by_worktree(&findings, &HashSet::from(["a.ts".to_owned()]));
        assert_eq!(split["modified"], json!({"files": ["a.ts"], "findings": 1}));
        assert_eq!(split["clean"], json!({"files": ["b.ts", "c.ts"], "findings": 6}));
    }

    #[test]
    fn notes_warn_only_about_real_risk() {
        let split = split_findings_by_worktree(&BTreeMap::from([("a.ts".to_owned(), 1)]), &HashSet::new());
        let w = json!({"clean": split["clean"].clone()});
        assert!(worktree_notes(Some(&w), "fix")[0].contains("apply:true writes them too"));
        assert!(worktree_notes(Some(&w), "check")[0].contains("a fix apply:true would write"));
        assert!(worktree_notes(Some(&json!({"skipped": NO_GIT_REASON})), "fix").is_empty());
        assert_eq!(worktree_notes(Some(&json!({"error": "not a repo"})), "fix"), ["working-tree split unavailable: not a repo"]);
        assert!(worktree_notes(None, "fix").is_empty() && worktree_notes(Some(&json!({"clean": {"files": []}})), "fix").is_empty());
    }

    #[tokio::test]
    async fn a_real_repository_reports_its_changes() {
        if which("git", None, None).is_none() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        std::process::Command::new("git").args(["init", "-q"]).current_dir(dir.path()).output().unwrap();
        std::fs::write(dir.path().join("fresh.ts"), "x").unwrap();
        let changes = list_working_tree_changes(&Processes::for_tests(), dir.path(), None).await;
        assert!(changes.files.unwrap().contains("fresh.ts"));
        let outside = tempfile::tempdir().unwrap();
        // Not a repository: the error is reported and no split is claimed.
        let none = list_working_tree_changes(&Processes::for_tests(), outside.path(), None).await;
        assert!(none.files.is_none() && !none.error.is_empty() || none.files.is_some());
    }
}
