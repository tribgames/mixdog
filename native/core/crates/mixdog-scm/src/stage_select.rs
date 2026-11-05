//! Staging by id for the `git` tool: `git diff` with `include_stage_ids` numbers the +/- runs of
//! the diff (`c1`, `c2`, …) under a `diff_id`; `action:stage` re-reads the same diff, refuses it
//! when it no longer hashes to what the caller saw, and applies only the selected runs to the
//! index. The ids mean something only together with their `diff_id`.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

use crate::engine::Repo;
use crate::error::ScmFailure;
use crate::git::RunOptions;
use crate::git::nul_records;
use crate::locks::path_key;
use crate::repo::hex;

const SNAPSHOT_LIMIT: usize = 64;
const MAX_CHANGE_IDS: usize = 50;
pub const NOT_UTF8_NOTE: &str = "This diff holds bytes that are not UTF-8, so it cannot be staged by id. Stage the file with git add.";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Change {
    pub id: String,
    pub path: String,
    /// `new_file` or `file` for a change that stages the whole file.
    pub kind: Option<&'static str>,
    pub additions: u64,
    pub deletions: u64,
    pub old_start: u64,
    pub new_start: u64,
}

#[derive(Clone, Debug)]
struct Entry {
    line: String,
    change: Option<usize>,
}

#[derive(Clone, Debug)]
struct Hunk {
    old_start: u64,
    new_start: u64,
    tail: String,
    entries: Vec<Entry>,
}

#[derive(Clone, Debug, Default)]
struct DiffFile {
    path: String,
    diff_line: String,
    old_line: String,
    new_line: String,
    lines: Vec<String>,
    kind: Option<&'static str>,
    blocked: bool,
    stageable: bool,
    hunks: Vec<Hunk>,
}

fn decode_path(raw: &str) -> String {
    let mut path = raw.to_owned();
    if let Some(inner) = raw.strip_prefix('"').and_then(|rest| rest.strip_suffix('"')) {
        let mut bytes: Vec<u8> = Vec::new();
        let chars: Vec<char> = inner.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            if chars[i] != '\\' || i + 1 >= chars.len() {
                let mut buf = [0u8; 4];
                bytes.extend_from_slice(chars[i].encode_utf8(&mut buf).as_bytes());
                i += 1;
                continue;
            }
            i += 1;
            if chars[i].is_digit(8) {
                let mut value = 0u32;
                let mut taken = 0;
                while i < chars.len() && taken < 3 && chars[i].is_digit(8) {
                    value = value * 8 + chars[i].to_digit(8).unwrap_or(0);
                    i += 1;
                    taken += 1;
                }
                bytes.push(value as u8);
                continue;
            }
            let mapped = match chars[i] {
                'a' => '\u{7}',
                'b' => '\u{8}',
                't' => '\t',
                'n' => '\n',
                'v' => '\u{b}',
                'f' => '\u{c}',
                'r' => '\r',
                other => other,
            };
            let mut buf = [0u8; 4];
            bytes.extend_from_slice(mapped.encode_utf8(&mut buf).as_bytes());
            i += 1;
        }
        path = String::from_utf8_lossy(&bytes).into_owned();
    }
    for prefix in ["a/", "b/"] {
        if let Some(rest) = path.strip_prefix(prefix) {
            return rest.to_owned();
        }
    }
    path
}

fn display_path(diff_line: &str) -> String {
    let rest = diff_line.strip_prefix("diff --git ").unwrap_or(diff_line);
    match rest.rfind(" b/") {
        Some(at) => decode_path(&rest[at + 1..]),
        None => decode_path(rest.rsplit(' ').next().unwrap_or(rest)),
    }
}

fn parse_hunk_header(line: &str) -> Option<Hunk> {
    let rest = line.strip_prefix("@@ -")?;
    let (ranges, tail) = rest.split_once(" @@")?;
    let (old, new) = ranges.split_once(" +")?;
    let start = |range: &str| range.split(',').next().and_then(|s| s.parse::<u64>().ok());
    Some(Hunk {
        old_start: start(old)?,
        new_start: start(new)?,
        tail: tail.to_owned(),
        entries: Vec::new(),
    })
}

fn finish_file(files: &mut Vec<DiffFile>, file: Option<DiffFile>) {
    let Some(mut file) = file else { return };
    let path_line = if file.new_line == "+++ /dev/null" { &file.old_line } else { &file.new_line };
    if path_line.len() > 4 {
        file.path = decode_path(path_line[4..].trim_end_matches('\t'));
    }
    file.stageable = !file.diff_line.is_empty()
        && !file.blocked
        && (file.kind.is_some() || (!file.old_line.is_empty() && !file.new_line.is_empty() && !file.hunks.is_empty()));
    files.push(file);
}

fn parse_files(raw: &str) -> Vec<DiffFile> {
    let mut files = Vec::new();
    let mut file: Option<DiffFile> = None;
    let mut in_hunk = false;
    for line in raw.split('\n') {
        if line.starts_with("diff --git ") {
            finish_file(&mut files, file.take());
            file = Some(DiffFile {
                path: display_path(line),
                diff_line: line.to_owned(),
                lines: vec![line.to_owned()],
                ..DiffFile::default()
            });
            in_hunk = false;
            continue;
        }
        let Some(current) = file.as_mut() else { continue };
        current.lines.push(line.to_owned());
        if line.starts_with("@@") {
            match parse_hunk_header(line) {
                Some(hunk) => {
                    current.hunks.push(hunk);
                    in_hunk = true;
                }
                None => current.blocked = true,
            }
            continue;
        }
        if in_hunk {
            if line.starts_with([' ', '+', '-', '\\']) {
                if line.starts_with('\\') {
                    current.kind.get_or_insert("file");
                }
                if let Some(hunk) = current.hunks.last_mut() {
                    hunk.entries.push(Entry { line: line.to_owned(), change: None });
                }
            }
            continue;
        }
        if line.starts_with("--- ") {
            current.old_line = line.to_owned();
        } else if line.starts_with("+++ ") {
            current.new_line = line.to_owned();
        } else if line.starts_with("new file mode ") {
            current.kind = Some("new_file");
        } else if [
            "deleted file mode ", "old mode ", "new mode ", "similarity index ", "rename from ",
            "rename to ", "copy from ", "copy to ", "GIT binary patch",
        ]
        .iter()
        .any(|prefix| line.starts_with(prefix))
        {
            current.kind.get_or_insert("file");
        } else if line.starts_with("Binary files ") {
            current.blocked = true;
        }
    }
    finish_file(&mut files, file.take());
    files
}

/// Numbers the +/- runs in diff order; a whole-file change takes one id.
fn annotate(files: &mut [DiffFile]) -> Vec<Change> {
    let mut changes: Vec<Change> = Vec::new();
    for file in files.iter_mut().filter(|file| file.stageable) {
        if let Some(kind) = file.kind {
            let entries: Vec<&Entry> = file.hunks.iter().flat_map(|h| h.entries.iter()).collect();
            changes.push(Change {
                id: format!("c{}", changes.len() + 1),
                path: file.path.clone(),
                kind: Some(kind),
                additions: entries.iter().filter(|e| e.line.starts_with('+')).count() as u64,
                deletions: entries.iter().filter(|e| e.line.starts_with('-')).count() as u64,
                old_start: 0,
                new_start: 0,
            });
            continue;
        }
        let path = file.path.clone();
        for hunk in &mut file.hunks {
            let (mut old_line, mut new_line) = (hunk.old_start, hunk.new_start);
            let mut group: Option<Change> = None;
            for entry in &mut hunk.entries {
                match entry.line.as_bytes()[0] {
                    prefix @ (b'+' | b'-') => {
                        let id_index = changes.len();
                        let change = group.get_or_insert_with(|| Change {
                            id: format!("c{}", id_index + 1),
                            path: path.clone(),
                            kind: None,
                            additions: 0,
                            deletions: 0,
                            old_start: old_line,
                            new_start: new_line,
                        });
                        entry.change = Some(id_index);
                        if prefix == b'+' {
                            change.additions += 1;
                            new_line += 1;
                        } else {
                            change.deletions += 1;
                            old_line += 1;
                        }
                    }
                    other => {
                        if let Some(done) = group.take() {
                            changes.push(done);
                        }
                        if other == b' ' {
                            old_line += 1;
                            new_line += 1;
                        }
                    }
                }
            }
            if let Some(done) = group.take() {
                changes.push(done);
            }
        }
    }
    changes
}

pub fn list_changes(raw: &str) -> Vec<Change> {
    let mut files = parse_files(raw);
    annotate(&mut files)
}

fn range(start: i64, count: usize) -> String {
    if count == 1 { start.to_string() } else { format!("{start},{count}") }
}

pub struct Selected {
    pub patch: String,
    pub changes: Vec<Change>,
    pub missing: Vec<String>,
}

/// The patch that stages exactly `requested`; unselected runs stay as context (a deletion
/// becomes a context line) so the hunk still applies.
pub fn build_selected_patch(raw: &str, requested: &[String]) -> Selected {
    let mut files = parse_files(raw);
    let changes = annotate(&mut files);
    let mut wanted: Vec<&str> = Vec::new();
    for id in requested {
        if !wanted.contains(&id.as_str()) {
            wanted.push(id);
        }
    }
    let missing: Vec<String> = wanted
        .iter()
        .filter(|id| !changes.iter().any(|c| c.id == **id))
        .map(|id| (*id).to_owned())
        .collect();
    if !missing.is_empty() {
        return Selected { patch: String::new(), changes: Vec::new(), missing };
    }
    let is_wanted = |index: usize| wanted.contains(&changes[index].id.as_str());
    let mut parts: Vec<String> = Vec::new();
    let mut selected: Vec<Change> = Vec::new();
    for file in files.iter().filter(|file| file.stageable) {
        let file_changes: Vec<(usize, &Change)> = changes
            .iter()
            .enumerate()
            .filter(|(i, c)| c.path == file.path && is_wanted(*i))
            .collect();
        if file_changes.is_empty() {
            continue;
        }
        if file.kind.is_some() {
            parts.push(file.lines.join("\n").trim_end_matches('\n').to_owned());
            selected.extend(file_changes.iter().map(|(_, c)| (*c).clone()));
            continue;
        }
        let mut hunks: Vec<String> = Vec::new();
        let mut delta: i64 = 0;
        for hunk in &file.hunks {
            if !hunk.entries.iter().any(|e| e.change.is_some_and(is_wanted)) {
                continue;
            }
            let mut body: Vec<String> = Vec::new();
            for entry in &hunk.entries {
                match entry.change {
                    Some(index) if !is_wanted(index) => {
                        if entry.line.starts_with('-') {
                            body.push(format!(" {}", &entry.line[1..]));
                        }
                    }
                    _ => body.push(entry.line.clone()),
                }
            }
            let old_count = body.iter().filter(|l| l.starts_with([' ', '-'])).count();
            let new_count = body.iter().filter(|l| l.starts_with([' ', '+'])).count();
            let new_start = hunk.old_start as i64 + delta + i64::from(old_count == 0) - i64::from(new_count == 0);
            hunks.push(format!(
                "@@ -{} +{} @@{}",
                range(hunk.old_start as i64, old_count),
                range(new_start, new_count),
                hunk.tail
            ));
            hunks.extend(body);
            delta += new_count as i64 - old_count as i64;
        }
        if hunks.is_empty() {
            continue;
        }
        parts.extend([file.diff_line.clone(), file.old_line.clone(), file.new_line.clone()]);
        parts.extend(hunks);
        selected.extend(file_changes.iter().map(|(_, c)| (*c).clone()));
    }
    let missing = wanted
        .iter()
        .filter(|id| !selected.iter().any(|c| c.id == **id))
        .map(|id| (*id).to_owned())
        .collect();
    Selected {
        patch: if parts.is_empty() { String::new() } else { format!("{}\n", parts.join("\n")) },
        changes: selected,
        missing,
    }
}

fn listed_path(path: &str) -> String {
    if path.chars().any(|c| (c as u32) < 0x20 || c == '"') {
        serde_json::to_string(path).unwrap_or_else(|_| path.to_owned())
    } else {
        path.to_owned()
    }
}

/// The lines appended to a stageable diff: its id and the id range per file.
pub fn listing(diff_id: &str, changes: &[Change]) -> String {
    struct Row<'a> { path: &'a str, start: &'a str, end: &'a str, whole: bool }
    let mut rows: Vec<Row> = Vec::new();
    for change in changes {
        match rows.last_mut() {
            Some(last) if last.path == change.path && change.kind.is_none() && !last.whole => last.end = &change.id,
            _ => rows.push(Row { path: &change.path, start: &change.id, end: &change.id, whole: change.kind.is_some() }),
        }
    }
    let mut lines = vec![format!(
        "diff_id: {diff_id} (ids number the +/- runs in diff order; [whole file] ids stage the entire file)"
    )];
    for row in rows {
        let span = if row.start == row.end { row.start.to_owned() } else { format!("{}-{}", row.start, row.end) };
        lines.push(format!("{}: {span}{}", listed_path(row.path), if row.whole { " [whole file]" } else { "" }));
    }
    lines.join("\n")
}

/// Per-file staged counts.
pub fn staged_summary(changes: &[Change]) -> Value {
    let mut order: Vec<&str> = Vec::new();
    let mut totals: HashMap<&str, (u64, u64, u64)> = HashMap::new();
    for change in changes {
        if !totals.contains_key(change.path.as_str()) {
            order.push(&change.path);
        }
        let entry = totals.entry(&change.path).or_default();
        entry.0 += 1;
        entry.1 += change.additions;
        entry.2 += change.deletions;
    }
    let files: Vec<String> = order
        .iter()
        .map(|path| {
            let (count, adds, dels) = totals[path];
            format!("{path}: {count} {} +{adds} -{dels}", if count == 1 { "change" } else { "changes" })
        })
        .collect();
    json!({
        "changes": changes.len(),
        "additions": changes.iter().map(|c| c.additions).sum::<u64>(),
        "deletions": changes.iter().map(|c| c.deletions).sum::<u64>(),
        "files": files,
    })
}

#[derive(Clone)]
struct Snapshot {
    scope: PathBuf,
    argv: Vec<String>,
    raw_hash: String,
}

/// Recent diffs that handed out ids, oldest evicted first.
#[derive(Default)]
pub struct DiffSnapshots {
    inner: Mutex<(HashMap<String, Snapshot>, VecDeque<String>)>,
    counter: AtomicU64,
}

fn digest(text: &str) -> String {
    hex(&Sha256::digest(text.as_bytes()))
}

impl DiffSnapshots {
    pub fn new() -> Arc<Self> {
        Arc::default()
    }

    fn remember(&self, snapshot: Snapshot) -> String {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let seed = format!("{nanos}:{}:{}", std::process::id(), self.counter.fetch_add(1, Ordering::Relaxed));
        let id = format!("diff_{}", &digest(&seed)[..20]);
        let mut guard = self.inner.lock().expect("snapshots");
        guard.0.insert(id.clone(), snapshot);
        guard.1.push_back(id.clone());
        while guard.1.len() > SNAPSHOT_LIMIT {
            if let Some(oldest) = guard.1.pop_front() {
                guard.0.remove(&oldest);
            }
        }
        id
    }

    fn get(&self, id: &str) -> Option<Snapshot> {
        let mut guard = self.inner.lock().expect("snapshots");
        let found = guard.0.get(id).cloned()?;
        guard.1.retain(|known| known != id);
        guard.1.push_back(id.to_owned());
        Some(found)
    }

    fn forget(&self, id: &str) {
        let mut guard = self.inner.lock().expect("snapshots");
        guard.0.remove(id);
        guard.1.retain(|known| known != id);
    }
}

/// A stageable diff: its text and, when it holds changes, the id they are listed under.
pub struct StageableDiff {
    pub raw: String,
    pub diff_id: Option<String>,
    pub changes: Vec<Change>,
    pub not_utf8: bool,
}

#[derive(Debug)]
pub enum StageOutcome {
    Staged(Value),
    /// `expired_diff`, `scope_mismatch` or `stale_diff`, with the hint the tool shows.
    NotStaged { reason: &'static str, hint: &'static str },
}

/// Validated `action:stage` input.
pub fn stage_request(diff_id: &str, change_ids: &[String]) -> Result<(String, Vec<String>), ScmFailure> {
    let diff_id = diff_id.trim();
    if diff_id.is_empty() {
        return Err(ScmFailure::invalid("diff_id", "the diff_id of a prior git diff"));
    }
    let mut ids: Vec<String> = Vec::new();
    for id in change_ids.iter().map(|id| id.trim()).filter(|id| !id.is_empty()) {
        if !ids.iter().any(|known| known == id) {
            ids.push(id.to_owned());
        }
    }
    if ids.is_empty() {
        return Err(ScmFailure::invalid("change_ids", "at least one change_id"));
    }
    if ids.len() > MAX_CHANGE_IDS {
        return Err(ScmFailure::invalid("change_ids", "at most 50 change_ids"));
    }
    Ok((diff_id.to_owned(), ids))
}

impl Repo {
    /// Runs the read-only `git diff <args>` and appends the diffs of untracked files that match
    /// its pathspecs, so new files can be staged by id too.
    pub async fn read_stageable_diff(&self, diff_args: &[String]) -> Result<(String, bool), ScmFailure> {
        let root = self.root()?.to_path_buf();
        let git = &self.scm.git;
        let mut argv: Vec<&str> = vec!["--no-optional-locks", "diff"];
        argv.extend(diff_args.iter().map(String::as_str));
        let first = git.outcome(&self.cancel, &root, &argv, &RunOptions::read()).await?;
        if !first.success() {
            return Err(ScmFailure::git(first.stderr_text().trim().to_owned()));
        }
        let mut not_utf8 = std::str::from_utf8(&first.stdout).is_err();
        let mut raw = first.stdout_text();
        let paths: Vec<&str> = diff_args
            .iter()
            .position(|arg| arg == "--")
            .map(|at| diff_args[at + 1..].iter().map(String::as_str).collect())
            .unwrap_or_default();
        let mut others = vec!["--no-optional-locks", "ls-files", "--others", "--exclude-standard", "--full-name", "-z", "--"];
        others.extend(paths);
        let listed = git.read(&self.cancel, &root, &others).await?;
        for path in nul_records(&listed) {
            let added = git
                .outcome(
                    &self.cancel,
                    &root,
                    &[
                        "--no-optional-locks", "diff", "--no-index", "--binary", "--no-ext-diff", "--no-textconv",
                        "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--", "/dev/null", path,
                    ],
                    &RunOptions::read(),
                )
                .await?;
            // --no-index uses exit 1 for a successfully produced patch.
            if !matches!(added.code, Some(0 | 1)) {
                return Err(ScmFailure::git(added.stderr_text().trim().to_owned()));
            }
            not_utf8 |= std::str::from_utf8(&added.stdout).is_err();
            if !raw.is_empty() && !raw.ends_with('\n') {
                raw.push('\n');
            }
            raw.push_str(&added.stdout_text());
        }
        Ok((raw, not_utf8))
    }

    /// `git diff` for the tool with `include_stage_ids`: the text plus the ids it can be staged by.
    pub async fn stageable_diff(
        &self,
        snapshots: &DiffSnapshots,
        scope: &Path,
        diff_args: &[String],
    ) -> Result<StageableDiff, ScmFailure> {
        let (raw, not_utf8) = self.read_stageable_diff(diff_args).await?;
        let changes = list_changes(&raw);
        let diff_id = (!changes.is_empty() && !not_utf8).then(|| {
            snapshots.remember(Snapshot {
                scope: scope.to_path_buf(),
                argv: diff_args.to_vec(),
                raw_hash: digest(&raw),
            })
        });
        Ok(StageableDiff { raw, diff_id, changes, not_utf8 })
    }

    /// `action:stage`: applies the selected runs of the diff `diff_id` names, if that diff is
    /// still the working diff.
    pub async fn stage_changes(
        &self,
        snapshots: &DiffSnapshots,
        scope: &Path,
        diff_id: &str,
        change_ids: &[String],
    ) -> Result<StageOutcome, ScmFailure> {
        let (diff_id, ids) = stage_request(diff_id, change_ids)?;
        let Some(snapshot) = snapshots.get(&diff_id) else {
            return Ok(StageOutcome::NotStaged {
                reason: "expired_diff",
                hint: "Run git diff with include_stage_ids:true again and use its new diff_id/change_ids.",
            });
        };
        if path_key(&snapshot.scope) != path_key(scope) {
            return Ok(StageOutcome::NotStaged {
                reason: "scope_mismatch",
                hint: "Run git diff with include_stage_ids:true in the current Project and use its diff_id/change_ids.",
            });
        }
        // The diff check and the index apply are one transaction on this work tree's index.
        let _scope = self.write_scope().await?;
        let (raw, not_utf8) = self.read_stageable_diff(&snapshot.argv).await?;
        if not_utf8 {
            return Err(ScmFailure::refused("NOT_UTF8", NOT_UTF8_NOTE));
        }
        if digest(&raw) != snapshot.raw_hash {
            return Ok(StageOutcome::NotStaged {
                reason: "stale_diff",
                hint: "The working diff changed. Run git diff with include_stage_ids:true again and select current change_ids.",
            });
        }
        let built = build_selected_patch(&raw, &ids);
        if !built.missing.is_empty() || built.patch.is_empty() {
            return Err(ScmFailure::refused(
                "CHANGE_IDS_MISSING",
                format!(
                    "git stage change_ids are not present in the diff: {}",
                    if built.missing.is_empty() { "(none selected)".to_owned() } else { built.missing.join(", ") }
                ),
            ));
        }
        let directory = std::env::temp_dir().join(format!("mixdog-git-stage-{}", &digest(&diff_id)[..12]));
        std::fs::create_dir_all(&directory)?;
        let patch_path = directory.join("selected.patch");
        let result = async {
            std::fs::write(&patch_path, &built.patch)?;
            let patch = patch_path.to_string_lossy().into_owned();
            self.run(&["apply", "--cached", "--check", "--unidiff-zero", &patch]).await?;
            self.run(&["apply", "--cached", "--unidiff-zero", &patch]).await?;
            Ok::<_, ScmFailure>(())
        }
        .await;
        let _ = std::fs::remove_dir_all(&directory);
        result?;
        snapshots.forget(&diff_id);
        Ok(StageOutcome::Staged(staged_summary(&built.changes)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIFF: &str = "diff --git a/f.txt b/f.txt\nindex 1..2 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1,5 +1,5 @@\n a\n-b\n+B\n c\n d\n-e\n+E\n";

    #[test]
    fn runs_of_plus_and_minus_are_numbered_in_order() {
        let changes = list_changes(DIFF);
        assert_eq!(changes.len(), 2);
        assert_eq!((changes[0].id.as_str(), changes[0].additions, changes[0].deletions), ("c1", 1, 1));
        assert_eq!(changes[1].old_start, 5);
        assert!(listing("diff_x", &changes).contains("f.txt: c1-c2"));
    }

    #[test]
    fn an_unselected_run_stays_as_context() {
        let picked = build_selected_patch(DIFF, &["c2".to_owned()]);
        assert!(picked.missing.is_empty());
        assert!(picked.patch.contains("@@ -1,5 +1,5 @@") || picked.patch.contains("@@ -1,5 +"), "{}", picked.patch);
        assert!(picked.patch.contains("\n b\n"), "{}", picked.patch);
        assert!(picked.patch.contains("-e\n+E"));
        assert!(!picked.patch.contains("+B"));
        assert_eq!(build_selected_patch(DIFF, &["c9".to_owned()]).missing, ["c9"]);
    }

    #[test]
    fn stage_requests_are_validated() {
        assert!(stage_request("", &["c1".into()]).is_err());
        assert!(stage_request("diff_a", &[]).is_err());
        assert_eq!(stage_request(" diff_a ", &["c1".into(), "c1".into()]).unwrap().1, ["c1"]);
    }
}
