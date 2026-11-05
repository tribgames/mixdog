//! Staging by id (`git-partial-stage.mjs`): a stageable `git diff` is parsed into numbered
//! change runs, remembered as a snapshot under a `diff_id`, and a later `action:stage` rebuilds
//! a patch of just the chosen runs and applies it to the index.

use std::collections::HashSet;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use regex::Regex;
use sha2::Digest;
use sha2::Sha256;

const SNAPSHOT_LIMIT: usize = 64;

pub(super) fn digest(value: &str) -> String {
    hex(&Sha256::digest(value.as_bytes()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn decode_path(path: &str) -> String {
    let mut path = path.to_owned();
    if path.starts_with('"') {
        let inner: Vec<char> = path.chars().skip(1).take(path.chars().count().saturating_sub(2)).collect();
        let mut bytes: Vec<u8> = Vec::new();
        let mut i = 0;
        while i < inner.len() {
            if inner[i] != '\\' || i + 1 >= inner.len() {
                let mut buf = [0u8; 4];
                bytes.extend_from_slice(inner[i].encode_utf8(&mut buf).as_bytes());
                i += 1;
                continue;
            }
            let next = inner[i + 1];
            if ('0'..='7').contains(&next) {
                let mut j = i + 1;
                let mut value = 0u32;
                while j < inner.len() && j < i + 4 && ('0'..='7').contains(&inner[j]) {
                    value = value * 8 + inner[j].to_digit(8).unwrap_or(0);
                    j += 1;
                }
                bytes.push((value & 0xff) as u8);
                i = j;
                continue;
            }
            let mapped = match next {
                'a' => '\x07',
                'b' => '\x08',
                't' => '\t',
                'n' => '\n',
                'v' => '\x0b',
                'f' => '\x0c',
                'r' => '\r',
                other => other,
            };
            let mut buf = [0u8; 4];
            bytes.extend_from_slice(mapped.encode_utf8(&mut buf).as_bytes());
            i += 2;
        }
        path = String::from_utf8_lossy(&bytes).into_owned();
    }
    if path.starts_with("a/") || path.starts_with("b/") {
        path.drain(..2);
    }
    path
}

fn display_path(diff_line: &str) -> String {
    let re = Regex::new(r#"^diff --git (?:"(?:[^"\\]|\\.)*"|a/.*?) ("(?:[^"\\]|\\.)*"|b/.*)$"#).expect("static pattern");
    re.captures(diff_line)
        .map_or_else(|| diff_line.to_owned(), |m| decode_path(&m[1]))
}

struct Entry {
    line: String,
    change_id: Option<String>,
}

struct Hunk {
    old_start: i64,
    tail: String,
    entries: Vec<Entry>,
}

fn parse_hunk_header(line: &str) -> Option<Hunk> {
    let re = Regex::new(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$").expect("static pattern");
    let m = re.captures(line)?;
    Some(Hunk { old_start: m[1].parse().ok()?, tail: m[5].to_owned(), entries: Vec::new() })
}

struct File {
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

fn finish_file(files: &mut Vec<File>, file: Option<File>) {
    let Some(mut file) = file else { return };
    let path_line = if file.new_line == "+++ /dev/null" { &file.old_line } else { &file.new_line };
    if !path_line.is_empty() {
        let raw: String = path_line.chars().skip(4).collect();
        file.path = decode_path(raw.strip_suffix('\t').unwrap_or(&raw));
    }
    file.stageable = !file.diff_line.is_empty()
        && !file.blocked
        && (file.kind.is_some() || (!file.old_line.is_empty() && !file.new_line.is_empty() && !file.hunks.is_empty()));
    files.push(file);
}

fn parse_files(raw: &str) -> Vec<File> {
    let meta = Regex::new(
        r"^(deleted file mode |old mode |new mode |similarity index |rename from |rename to |copy from |copy to |GIT binary patch)",
    )
    .expect("static pattern");
    let mut files = Vec::new();
    let mut file: Option<File> = None;
    let mut in_hunk = false;
    for line in raw.split('\n') {
        if line.starts_with("diff --git ") {
            finish_file(&mut files, file.take());
            file = Some(File {
                path: display_path(line),
                diff_line: line.to_owned(),
                old_line: String::new(),
                new_line: String::new(),
                lines: vec![line.to_owned()],
                kind: None,
                blocked: false,
                stageable: false,
                hunks: Vec::new(),
            });
            in_hunk = false;
            continue;
        }
        let Some(f) = file.as_mut() else { continue };
        f.lines.push(line.to_owned());
        if line.starts_with("@@") {
            match parse_hunk_header(line) {
                Some(hunk) => {
                    f.hunks.push(hunk);
                    in_hunk = true;
                }
                None => {
                    f.blocked = true;
                    in_hunk = false;
                }
            }
            continue;
        }
        if in_hunk {
            if matches!(line.chars().next(), Some(' ' | '+' | '-' | '\\')) {
                if line.starts_with('\\') {
                    f.kind.get_or_insert("file");
                }
                if let Some(h) = f.hunks.last_mut() {
                    h.entries.push(Entry { line: line.to_owned(), change_id: None });
                }
            }
            continue;
        }
        if line.starts_with("--- ") {
            f.old_line = line.to_owned();
        } else if line.starts_with("+++ ") {
            f.new_line = line.to_owned();
        } else if line.starts_with("new file mode ") {
            f.kind = Some("new_file");
        } else if meta.is_match(line) {
            f.kind.get_or_insert("file");
        } else if line.starts_with("Binary files ") {
            f.blocked = true;
        }
    }
    finish_file(&mut files, file);
    files
}

#[derive(Clone, Debug)]
pub(super) struct Change {
    pub id: String,
    pub path: String,
    pub kind: Option<&'static str>,
    pub additions: usize,
    pub deletions: usize,
}

/// Change ids are ordinals (`c1`, `c2`, …) in diff order, meaningful only with the `diff_id`
/// they were listed under.
fn annotate_changes(files: &mut [File]) -> Vec<Change> {
    let mut changes = Vec::new();
    let mut ordinal = 0;
    for file in files.iter_mut() {
        if !file.stageable {
            continue;
        }
        if let Some(kind) = file.kind {
            let entries = file.hunks.iter().flat_map(|h| h.entries.iter());
            let (mut additions, mut deletions) = (0, 0);
            for entry in entries {
                if entry.line.starts_with('+') {
                    additions += 1;
                }
                if entry.line.starts_with('-') {
                    deletions += 1;
                }
            }
            ordinal += 1;
            changes.push(Change { id: format!("c{ordinal}"), path: file.path.clone(), kind: Some(kind), additions, deletions });
            continue;
        }
        for hunk in &mut file.hunks {
            let mut group: Option<(Vec<usize>, usize, usize)> = None;
            let mut finish = |group: &mut Option<(Vec<usize>, usize, usize)>, entries: &mut Vec<Entry>| {
                if let Some((indexes, additions, deletions)) = group.take() {
                    ordinal += 1;
                    let id = format!("c{ordinal}");
                    for i in indexes {
                        entries[i].change_id = Some(id.clone());
                    }
                    changes.push(Change { id, path: file.path.clone(), kind: None, additions, deletions });
                }
            };
            for i in 0..hunk.entries.len() {
                let prefix = hunk.entries[i].line.chars().next();
                if matches!(prefix, Some('+' | '-')) {
                    let g = group.get_or_insert((Vec::new(), 0, 0));
                    g.0.push(i);
                    if prefix == Some('+') {
                        g.1 += 1;
                    } else {
                        g.2 += 1;
                    }
                    continue;
                }
                finish(&mut group, &mut hunk.entries);
            }
            finish(&mut group, &mut hunk.entries);
        }
    }
    changes
}

fn parse_stageable_diff(raw: &str) -> (Vec<File>, Vec<Change>) {
    let mut files = parse_files(raw);
    let changes = annotate_changes(&mut files);
    (files, changes)
}

#[derive(Clone)]
pub(super) struct SnapshotPlan {
    pub cwd: std::path::PathBuf,
    pub global_args: Vec<String>,
    pub args: Vec<String>,
}

#[derive(Clone)]
pub(super) struct Snapshot {
    pub repo: std::path::PathBuf,
    pub scope: std::path::PathBuf,
    pub plan: SnapshotPlan,
    pub argv: Vec<String>,
    pub raw_hash: String,
}

static SNAPSHOTS: Mutex<Vec<(String, Snapshot)>> = Mutex::new(Vec::new());
static COUNTER: AtomicU64 = AtomicU64::new(0);

fn new_diff_id(raw_hash: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let seed = format!("{raw_hash}:{nanos}:{}:{}", COUNTER.fetch_add(1, Ordering::Relaxed), std::process::id());
    format!("diff_{}", &digest(&seed)[..20])
}

pub(super) struct DiffSnapshot {
    pub diff_id: Option<String>,
    pub changes: Vec<Change>,
}

pub(super) fn create_diff_snapshot(
    repo: &std::path::Path,
    scope: &std::path::Path,
    plan: SnapshotPlan,
    argv: &[String],
    raw: &str,
) -> DiffSnapshot {
    let (_, changes) = parse_stageable_diff(raw);
    if changes.is_empty() {
        return DiffSnapshot { diff_id: None, changes };
    }
    let raw_hash = digest(raw);
    let diff_id = new_diff_id(&raw_hash);
    let mut store = SNAPSHOTS.lock().expect("snapshots");
    store.push((
        diff_id.clone(),
        Snapshot { repo: repo.to_path_buf(), scope: scope.to_path_buf(), plan, argv: argv.to_vec(), raw_hash },
    ));
    while store.len() > SNAPSHOT_LIMIT {
        store.remove(0);
    }
    DiffSnapshot { diff_id: Some(diff_id), changes }
}

/// A read refreshes the snapshot's place in the bounded store.
pub(super) fn get_diff_snapshot(diff_id: &str) -> Option<Snapshot> {
    let key = diff_id.trim();
    let mut store = SNAPSHOTS.lock().expect("snapshots");
    let position = store.iter().position(|(id, _)| id == key)?;
    let entry = store.remove(position);
    let snapshot = entry.1.clone();
    store.push(entry);
    Some(snapshot)
}

pub(super) fn delete_diff_snapshot(diff_id: &str) {
    SNAPSHOTS.lock().expect("snapshots").retain(|(id, _)| id != diff_id.trim());
}

pub(super) fn diff_snapshot_matches(snapshot: &Snapshot, raw: &str) -> bool {
    snapshot.raw_hash == digest(raw)
}

fn range(start: i64, count: usize) -> String {
    if count == 1 { start.to_string() } else { format!("{start},{count}") }
}

pub(super) struct SelectedPatch {
    pub patch: String,
    pub changes: Vec<Change>,
    pub missing: Vec<String>,
}

pub(super) fn build_selected_stage_patch(raw: &str, requested_ids: &[String]) -> SelectedPatch {
    let (files, changes) = parse_stageable_diff(raw);
    let mut requested: Vec<String> = Vec::new();
    for id in requested_ids.iter().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()) {
        if !requested.contains(&id) {
            requested.push(id);
        }
    }
    let available: HashSet<&str> = changes.iter().map(|c| c.id.as_str()).collect();
    let missing: Vec<String> = requested.iter().filter(|id| !available.contains(id.as_str())).cloned().collect();
    if !missing.is_empty() {
        return SelectedPatch { patch: String::new(), changes: Vec::new(), missing };
    }
    let wanted: HashSet<&str> = requested.iter().map(String::as_str).collect();
    let mut parts: Vec<String> = Vec::new();
    let mut selected: Vec<String> = Vec::new();
    for file in &files {
        if !file.stageable {
            continue;
        }
        let file_selected: Vec<&Change> =
            changes.iter().filter(|c| c.path == file.path && wanted.contains(c.id.as_str())).collect();
        if file_selected.is_empty() {
            continue;
        }
        if file.kind.is_some() {
            let joined = file.lines.join("\n");
            parts.push(joined.strip_suffix('\n').unwrap_or(&joined).to_owned());
            selected.extend(file_selected.iter().map(|c| c.id.clone()));
            continue;
        }
        let mut hunks: Vec<String> = Vec::new();
        let mut selected_delta: i64 = 0;
        for hunk in &file.hunks {
            let has_selected = hunk
                .entries
                .iter()
                .any(|e| e.change_id.as_deref().is_some_and(|id| wanted.contains(id)));
            if !has_selected {
                continue;
            }
            let mut body: Vec<String> = Vec::new();
            for entry in &hunk.entries {
                match entry.change_id.as_deref() {
                    None => body.push(entry.line.clone()),
                    Some(id) if wanted.contains(id) => body.push(entry.line.clone()),
                    Some(_) if entry.line.starts_with('-') => body.push(format!(" {}", &entry.line[1..])),
                    Some(_) => {}
                }
            }
            let old_count = body.iter().filter(|l| l.starts_with(' ') || l.starts_with('-')).count();
            let new_count = body.iter().filter(|l| l.starts_with(' ') || l.starts_with('+')).count();
            let old_start = hunk.old_start;
            let new_start = hunk.old_start + selected_delta + i64::from(old_count == 0) - i64::from(new_count == 0);
            hunks.push(format!("@@ -{} +{} @@{}", range(old_start, old_count), range(new_start, new_count), hunk.tail));
            hunks.extend(body);
            selected_delta += new_count as i64 - old_count as i64;
        }
        if hunks.is_empty() {
            continue;
        }
        parts.push(file.diff_line.clone());
        parts.push(file.old_line.clone());
        parts.push(file.new_line.clone());
        parts.extend(hunks);
        selected.extend(file_selected.iter().map(|c| c.id.clone()));
    }
    SelectedPatch {
        patch: if parts.is_empty() { String::new() } else { format!("{}\n", parts.join("\n")) },
        changes: changes.iter().filter(|c| selected.contains(&c.id)).cloned().collect(),
        missing: requested.iter().filter(|id| !selected.contains(id)).cloned().collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RAW: &str = "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n+d\n";

    #[test]
    fn runs_are_numbered_and_a_subset_builds_its_own_patch() {
        let (_, changes) = parse_stageable_diff(RAW);
        assert_eq!(changes.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["c1", "c2"]);
        let only_second = build_selected_stage_patch(RAW, &["c2".to_owned()]);
        assert_eq!(
            only_second.patch,
            "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,4 @@\n a\n b\n c\n+d\n"
        );
        assert_eq!(build_selected_stage_patch(RAW, &["c9".to_owned()]).missing, ["c9"]);
    }

    #[test]
    fn snapshots_are_consumed_by_delete_and_matched_by_hash() {
        let plan = SnapshotPlan { cwd: "/r".into(), global_args: vec![], args: vec![] };
        let made = create_diff_snapshot("/r".as_ref(), "/r".as_ref(), plan, &["diff".to_owned()], RAW);
        let id = made.diff_id.expect("a diff with changes gets an id");
        let snapshot = get_diff_snapshot(&id).expect("remembered");
        assert!(diff_snapshot_matches(&snapshot, RAW) && !diff_snapshot_matches(&snapshot, "x"));
        delete_diff_snapshot(&id);
        assert!(get_diff_snapshot(&id).is_none());
    }
}
