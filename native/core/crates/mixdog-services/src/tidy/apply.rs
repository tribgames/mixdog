//! Writes. tidy never writes with fs directly: every byte goes through the host's atomic write,
//! and each written path then runs the post-write invalidation the builtin edit adapters run
//! (result cache, code-graph dirty paths, read snapshot) so a formatted file is not served
//! from a stale cache. Every write also reaches the session's turn review as its own file
//! change. Those three effects belong to other packages and arrive through [`WriteHost`].

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use mixdog_rt::DurabilityIo;
use serde_json::{Value, json};

use crate::lane::io_on_lane;

/// A write the turn review should show: exact bytes before and after.
#[derive(Debug, Clone, PartialEq)]
pub struct FileChange {
    pub full_path: PathBuf,
    pub before: Vec<u8>,
    pub after: Vec<u8>,
}

#[async_trait]
pub trait WriteHost: Send + Sync {
    /// Durable replace of `path` with `content`.
    async fn atomic_write(&self, path: &Path, content: &[u8], session_id: Option<&str>) -> Result<(), String>;
    /// Best-effort invalidation of caches that may hold the old bytes.
    fn note_written(&self, paths: &[PathBuf], session_id: Option<&str>);
    /// Records the changes as the session's own file changes (counted and undoable).
    async fn record_changes(&self, cwd: &Path, session_id: &str, changes: Vec<FileChange>);
}

/// Same write-target guards the builtin edit surfaces enforce.
pub fn guard_tidy_write_path(full_path: &Path) -> Option<String> {
    use mixdog_js::device_paths::{has_unsafe_win32_component, is_blocked_device_path, is_unc_path, is_windows_device_path};
    let p = full_path.to_string_lossy();
    if is_unc_path(&p) {
        return Some(format!("cannot write UNC / SMB path: {p}"));
    }
    if is_windows_device_path(&p) {
        return Some(format!("cannot write Windows device path: {p}"));
    }
    if has_unsafe_win32_component(&p) {
        return Some(format!("cannot write path with a trailing dot/space or ADS component: {p}"));
    }
    if is_blocked_device_path(&p) {
        return Some(format!("cannot write device path: {p}"));
    }
    None
}
pub fn full_path_for(cwd: &Path, file_path: &str) -> PathBuf {
    let p = Path::new(file_path);
    if p.is_absolute() { p.to_owned() } else { cwd.join(p) }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Replacement {
    pub start: usize,
    pub end: usize,
    pub text: String,
    pub rule_id: String,
}

#[derive(Debug, Default)]
pub struct Plan {
    /// Descending by start offset, so every earlier offset stays valid.
    pub replacements: Vec<Replacement>,
    pub overlaps: Vec<(Replacement, Replacement)>,
    pub invalid: usize,
}

/// Orders byte-range replacements for application. Overlapping ranges are never applied: the
/// file is rejected whole, because a partial apply of conflicting fixes produces text no rule
/// asked for.
pub fn plan_replacements(fixes: &[Value]) -> Plan {
    let mut usable = Vec::new();
    let mut invalid = 0;
    for fix in fixes {
        let range = fix.get("byteOffset").and_then(Value::as_array);
        let bound = |i: usize| range.and_then(|r| r.get(i)).and_then(Value::as_u64).map(|n| n as usize);
        match (bound(0), bound(1), fix.get("text").and_then(Value::as_str)) {
            (Some(start), Some(end), Some(text)) if end >= start => {
                usable.push(Replacement { start, end, text: text.to_owned(), rule_id: fix.get("ruleId").and_then(Value::as_str).unwrap_or("").to_owned() });
            }
            _ => invalid += 1,
        }
    }
    usable.sort_by_key(|r| (r.start, r.end));
    let overlaps = usable.windows(2).filter(|w| w[1].start < w[0].end).map(|w| (w[0].clone(), w[1].clone())).collect();
    usable.reverse();
    Plan { replacements: usable, overlaps, invalid }
}

/// Applies pre-ordered (descending) replacements to a buffer.
pub fn apply_replacements(buffer: &[u8], replacements: &[Replacement]) -> Result<Vec<u8>, String> {
    let mut out = buffer.to_vec();
    for r in replacements {
        if r.start > out.len() || r.end > out.len() {
            return Err(format!("replacement range [{},{}] is outside the file", r.start, r.end));
        }
        out.splice(r.start..r.end, r.text.bytes());
    }
    Ok(out)
}

pub struct StructuralResult {
    pub applied: Vec<Value>,
    pub rejected: Vec<Value>,
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn read_file(path: &Path) -> std::io::Result<Vec<u8>> {
    std::fs::read(path)
}

/// Applies structural byte-range fixes, grouped per file. `matches_by_file` maps a repo-relative
/// path to its matches; only matches carrying a `fix` participate.
pub async fn apply_structural_fixes(lane: DurabilityIo, host: &dyn WriteHost, cwd: &Path, matches_by_file: &[(String, Vec<Value>)], session_id: Option<&str>) -> StructuralResult {
    let (mut applied, mut rejected, mut written) = (Vec::new(), Vec::new(), Vec::new());
    for (file, matches) in matches_by_file {
        let fixes: Vec<Value> = matches
            .iter()
            .filter_map(|m| {
                let mut fix = m.get("fix").filter(|f| !f.is_null())?.clone();
                fix["ruleId"] = m.get("ruleId").cloned().unwrap_or(Value::Null);
                Some(fix)
            })
            .collect();
        if fixes.is_empty() {
            continue;
        }
        let full = full_path_for(cwd, file);
        if let Some(guard) = guard_tidy_write_path(&full) {
            rejected.push(json!({"file": file, "reason": guard}));
            continue;
        }
        let plan = plan_replacements(&fixes);
        if !plan.overlaps.is_empty() {
            let mut rules: Vec<String> = plan.overlaps.iter().flat_map(|(a, b)| [a.rule_id.clone(), b.rule_id.clone()]).filter(|r| !r.is_empty()).collect();
            rules.dedup();
            let mut seen = std::collections::HashSet::new();
            rules.retain(|r| seen.insert(r.clone()));
            let named = if rules.is_empty() { "structural rules".to_owned() } else { rules.join(", ") };
            rejected.push(json!({"file": file, "reason": format!("overlapping fixes from {named}"), "overlaps": plan.overlaps.len()}));
            continue;
        }
        if plan.invalid > 0 {
            rejected.push(json!({"file": file, "reason": format!("{} fix(es) carried an unusable byte range", plan.invalid)}));
            continue;
        }
        let outcome = async {
            let current = io_on_lane(lane, {
                let full = full.clone();
                move || read_file(&full)
            })
            .await
            .map_err(|e| e.to_string())?;
            let next = apply_replacements(&current, &plan.replacements)?;
            host.atomic_write(&full, &next, session_id).await?;
            host.note_written(std::slice::from_ref(&full), session_id);
            Ok::<_, String>((current, next))
        }
        .await;
        match outcome {
            Ok((before, after)) => {
                written.push(FileChange { full_path: full, before, after });
                applied.push(json!({"file": file, "fixes": plan.replacements.len()}));
            }
            Err(reason) => rejected.push(json!({"file": file, "reason": reason})),
        }
    }
    if let Some(session) = session_id.filter(|_| !written.is_empty()) {
        host.record_changes(cwd, session, written).await;
    }
    StructuralResult { applied, rejected }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    pub(crate) struct Recording {
        pub writes: Mutex<Vec<(PathBuf, Vec<u8>)>>,
        pub noted: Mutex<Vec<PathBuf>>,
        pub recorded: Mutex<Vec<FileChange>>,
    }

    #[async_trait]
    impl WriteHost for Recording {
        async fn atomic_write(&self, path: &Path, content: &[u8], _: Option<&str>) -> Result<(), String> {
            std::fs::write(path, content).map_err(|e| e.to_string())?;
            self.writes.lock().unwrap().push((path.to_owned(), content.to_vec()));
            Ok(())
        }
        fn note_written(&self, paths: &[PathBuf], _: Option<&str>) {
            self.noted.lock().unwrap().extend(paths.iter().cloned());
        }
        async fn record_changes(&self, _: &Path, _: &str, changes: Vec<FileChange>) {
            self.recorded.lock().unwrap().extend(changes);
        }
    }

    fn fix(start: u64, end: u64, text: &str, rule: &str) -> Value {
        json!({"byteOffset": [start, end], "text": text, "ruleId": rule})
    }

    #[test]
    fn replacements_apply_back_to_front_so_offsets_hold() {
        let plan = plan_replacements(&[fix(0, 1, "X", "a"), fix(4, 5, "YY", "b")]);
        assert_eq!(plan.replacements[0].start, 4);
        assert_eq!(apply_replacements(b"abcdef", &plan.replacements).unwrap(), b"XbcdYYf");
        assert!(apply_replacements(b"ab", &[Replacement { start: 5, end: 6, text: String::new(), rule_id: String::new() }]).is_err());
    }

    #[test]
    fn overlaps_and_unusable_ranges_are_detected() {
        let plan = plan_replacements(&[fix(0, 4, "x", "a"), fix(3, 6, "y", "b"), json!({"byteOffset": [5, 2], "text": "z"}), json!({"text": "no range"})]);
        assert_eq!((plan.overlaps.len(), plan.invalid), (1, 2));
        // Touching ranges are not overlaps.
        assert!(plan_replacements(&[fix(0, 2, "x", ""), fix(2, 4, "y", "")]).overlaps.is_empty());
    }

    #[test]
    fn write_targets_are_guarded_like_the_edit_tools() {
        assert!(guard_tidy_write_path(Path::new("\\\\server\\share\\a.ts")).unwrap().contains("UNC"));
        // The raw-device namespace also starts with two separators, and the UNC check runs first.
        assert!(guard_tidy_write_path(Path::new("\\\\.\\COM1")).unwrap().contains("UNC"));
        assert!(guard_tidy_write_path(Path::new("//?/C:/x")).is_some());
        assert!(guard_tidy_write_path(Path::new("/dev/zero")).unwrap().contains("device"));
        assert!(guard_tidy_write_path(Path::new("/proc/self/fd/1")).unwrap().contains("device"));
        assert!(guard_tidy_write_path(Path::new("C:\\repo\\..\\a.ts")).is_none() && guard_tidy_write_path(Path::new("src/./a.ts")).is_none());
        assert_eq!(guard_tidy_write_path(Path::new("C:\\repo\\name.\\a.ts")).is_some(), cfg!(windows));
        assert!(guard_tidy_write_path(Path::new("src/a.ts")).is_none());
        assert_eq!(full_path_for(Path::new("/r"), "a/b.ts"), Path::new("/r").join("a/b.ts"));
    }

    #[tokio::test]
    async fn structural_fixes_write_once_per_file_and_report_rejections() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("ok.ts"), "var a = 1;").unwrap();
        std::fs::write(dir.path().join("clash.ts"), "0123456789").unwrap();
        let host = Recording::default();
        let matches = vec![
            ("ok.ts".to_owned(), vec![json!({"ruleId": "var", "fix": fix(0, 3, "let", "")}), json!({"ruleId": "info"})]),
            ("clash.ts".to_owned(), vec![json!({"ruleId": "r1", "fix": fix(0, 5, "x", "")}), json!({"ruleId": "r2", "fix": fix(3, 8, "y", "")})]),
            ("missing.ts".to_owned(), vec![json!({"ruleId": "r", "fix": fix(0, 1, "z", "")})]),
            ("none.ts".to_owned(), vec![json!({"ruleId": "r"})]),
        ];
        let lane = mixdog_rt::testing::tokens().durability_io;
        let out = apply_structural_fixes(lane, &host, dir.path(), &matches, Some("s1")).await;
        assert_eq!(std::fs::read_to_string(dir.path().join("ok.ts")).unwrap(), "let a = 1;");
        assert_eq!(out.applied, vec![json!({"file": "ok.ts", "fixes": 1})]);
        assert_eq!(out.rejected.len(), 2);
        assert!(out.rejected[0]["reason"].as_str().unwrap().starts_with("overlapping fixes from r1, r2"));
        assert_eq!(std::fs::read_to_string(dir.path().join("clash.ts")).unwrap(), "0123456789", "a conflicting file is left whole");
        {
            let recorded = host.recorded.lock().unwrap();
            assert_eq!((recorded.len(), recorded[0].before.clone(), recorded[0].after.clone()), (1, b"var a = 1;".to_vec(), b"let a = 1;".to_vec()));
        }
        assert_eq!(host.noted.lock().unwrap().len(), 1);
        let none = apply_structural_fixes(lane, &Recording::default(), dir.path(), &[], None).await;
        assert!(none.applied.is_empty());
    }
}
