//! Writes. tidy never writes with fs directly: every byte goes through the host's atomic write,
//! and each written path then runs the post-write invalidation the builtin edit adapters run
//! (result cache, code-graph dirty paths, read snapshot) so a formatted file is not served
//! from a stale cache. Every write also reaches the session's turn review as its own file
//! change. Those three effects belong to other packages and arrive through [`WriteHost`].

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use mixdog_rt::DurabilityIo;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::lane::{io_on_lane, on_lane};

/// A write the turn review should show: exact bytes before and after.
#[derive(Debug, Clone, PartialEq)]
pub struct FileChange {
    pub full_path: PathBuf,
    pub before: Vec<u8>,
    pub after: Vec<u8>,
}

#[async_trait]
pub trait WriteHost: Send + Sync {
    /// Durable replace of `path` with `content`. A cancelled `cancel` refuses the write before it
    /// starts (`atomicWrite`: `if (resolvedSignal?.aborted) throw abortReasonOf(..)`).
    async fn atomic_write(&self, path: &Path, content: &[u8], session_id: Option<&str>, cancel: Option<&CancellationToken>) -> Result<(), String>;
    /// Best-effort invalidation of caches that may hold the old bytes.
    async fn note_written(&self, paths: &[PathBuf], session_id: Option<&str>);
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

/// The project root as the file system resolves it. Blocking: a lane job's body.
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn real_root(root: &Path) -> Result<PathBuf, String> {
    std::fs::canonicalize(root).map_err(|e| format!("the project root cannot be resolved ({e}), so no write target can be checked"))
}

/// Why `path` is not a write target: its real path (symbolic links and junctions followed) leaves
/// the project. Blocking: a lane job's body.
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn outside_project(real_root: &Path, path: &Path) -> Option<String> {
    match std::fs::canonicalize(path) {
        Ok(real) if real.starts_with(real_root) => None,
        Ok(real) => Some(format!("its real path {} is outside the project, so it is not a write target", real.display())),
        Err(e) => Some(format!("its real path cannot be resolved ({e}), so it is not a write target")),
    }
}

/// `(file, reason)` for each of `files` whose real path leaves the project: a symbolic link
/// among `links`, or a file whose directory resolves elsewhere. Engines rewrite in place, so such a
/// file is never handed to an engine's apply pass.
pub async fn escaping_write_targets(lane: DurabilityIo, cwd: &Path, files: &[String], links: &[String]) -> Result<Vec<(String, String)>, String> {
    let (root, files, links) = (cwd.to_owned(), files.to_vec(), links.iter().cloned().collect::<std::collections::HashSet<_>>());
    on_lane(lane, move || {
        let real = real_root(&root)?;
        let mut dirs: std::collections::HashMap<String, Option<String>> = std::collections::HashMap::new();
        Ok(files
            .into_iter()
            .filter_map(|f| {
                let parent = f.rsplit_once('/').map_or("", |(d, _)| d).to_owned();
                let dir = dirs
                    .entry(parent.clone())
                    .or_insert_with(|| {
                        if parent.is_empty() { None } else { outside_project(&real, &root.join(&parent)).map(|why| format!("its directory {parent}: {why}")) }
                    })
                    .clone();
                let why = dir.or_else(|| if links.contains(&f) { outside_project(&real, &full_path_for(&root, &f)) } else { None });
                why.map(|why| (f, why))
            })
            .collect())
    })
    .await
    .map_err(|_| "the write targets could not be checked: their lane did not run the check".to_owned())?
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
    /// Why a fix cannot be checked against the file the scanner read.
    pub unverifiable: Vec<String>,
    /// SHA-256 of the file the scanner read, the same on every fix of the file.
    pub scanned: Option<String>,
}

/// SHA-256 of `bytes`, lower-case hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Orders byte-range replacements for application. Overlapping ranges are never applied: the
/// file is rejected whole, because a partial apply of conflicting fixes produces text no rule
/// asked for. A fix carries the digest of the file the scanner read (`scanned`) or why it has
/// none (`stale`).
pub fn plan_replacements(fixes: &[Value]) -> Plan {
    let mut usable = Vec::new();
    let (mut invalid, mut unverifiable, mut scanned) = (0, Vec::new(), None::<String>);
    for fix in fixes {
        if let Some(stale) = fix.get("stale").and_then(Value::as_str) {
            unverifiable.push(stale.to_owned());
            continue;
        }
        let range = fix.get("byteOffset").and_then(Value::as_array);
        let bound = |i: usize| range.and_then(|r| r.get(i)).and_then(Value::as_u64).map(|n| n as usize);
        match (bound(0), bound(1), fix.get("text").and_then(Value::as_str)) {
            (Some(start), Some(end), Some(text)) if end >= start => {
                let why = match (fix.get("scanned").and_then(Value::as_str), scanned.as_deref()) {
                    (None, _) => Some("the fix carries no digest of the file the scanner read"),
                    (Some(d), Some(seen)) if d != seen => Some("the fixes were scanned from different contents of the file"),
                    (Some(d), _) => {
                        scanned = Some(d.to_owned());
                        None
                    }
                };
                if let Some(why) = why {
                    unverifiable.push(why.to_owned());
                    continue;
                }
                usable.push(Replacement { start, end, text: text.to_owned(), rule_id: fix.get("ruleId").and_then(Value::as_str).unwrap_or("").to_owned() });
            }
            _ => invalid += 1,
        }
    }
    usable.sort_by_key(|r| (r.start, r.end));
    let overlaps = usable.windows(2).filter(|w| w[1].start < w[0].end).map(|w| (w[0].clone(), w[1].clone())).collect();
    usable.reverse();
    Plan { replacements: usable, overlaps, invalid, unverifiable, scanned }
}

/// Whether `at` starts a UTF-8 sequence (or ends the buffer): a splice there cannot cut a character.
pub fn on_char_boundary(bytes: &[u8], at: usize) -> bool {
    at == bytes.len() || bytes.get(at).is_some_and(|b| b & 0xC0 != 0x80)
}

/// Applies pre-ordered (descending) replacements to a buffer. A range must not split a
/// character; otherwise nothing is applied.
pub fn apply_replacements(buffer: &[u8], replacements: &[Replacement]) -> Result<Vec<u8>, String> {
    let mut out = buffer.to_vec();
    for r in replacements {
        if r.start > buffer.len() || r.end > buffer.len() {
            return Err(format!("replacement range [{},{}] is outside the file", r.start, r.end));
        }
        if !on_char_boundary(buffer, r.start) || !on_char_boundary(buffer, r.end) {
            return Err(format!("replacement range [{},{}] splits a multi-byte character", r.start, r.end));
        }
        out.splice(r.start..r.end, r.text.bytes());
    }
    Ok(out)
}

pub struct StructuralResult {
    pub applied: Vec<Value>,
    pub rejected: Vec<Value>,
}

/// The current bytes of a write target whose real path stays inside the project.
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn read_write_target(root: &Path, path: &Path) -> std::io::Result<Vec<u8>> {
    let real = real_root(root).map_err(std::io::Error::other)?;
    if let Some(why) = outside_project(&real, path) {
        return Err(std::io::Error::other(why));
    }
    std::fs::read(path)
}

/// Applies structural byte-range fixes, grouped per file. `matches_by_file` maps a repo-relative
/// path to its matches; only matches carrying a `fix` participate.
pub async fn apply_structural_fixes(
    lane: DurabilityIo,
    host: &dyn WriteHost,
    cwd: &Path,
    matches_by_file: &[(String, Vec<Value>)],
    session_id: Option<&str>,
    cancel: Option<&CancellationToken>,
) -> StructuralResult {
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
        if let Some(why) = plan.unverifiable.first() {
            rejected.push(
                json!({"file": file, "reason": format!("{} fix(es) cannot be checked against the file the scanner read: {why}", plan.unverifiable.len())}),
            );
            continue;
        }
        let outcome = async {
            let current = io_on_lane(lane, {
                let (root, full) = (cwd.to_owned(), full.clone());
                move || read_write_target(&root, &full)
            })
            .await
            .map_err(|e| e.to_string())?;
            // The offsets are the scanner's: they hold only in the bytes it matched.
            if plan.scanned.as_deref() != Some(sha256_hex(&current).as_str()) {
                return Err("the file changed since the scan: it no longer holds the bytes the rules matched".to_owned());
            }
            let next = apply_replacements(&current, &plan.replacements)?;
            host.atomic_write(&full, &next, session_id, cancel).await?;
            host.note_written(std::slice::from_ref(&full), session_id).await;
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
        async fn atomic_write(&self, path: &Path, content: &[u8], _: Option<&str>, cancel: Option<&CancellationToken>) -> Result<(), String> {
            if cancel.is_some_and(CancellationToken::is_cancelled) {
                return Err("atomicWrite aborted".to_owned());
            }
            std::fs::write(path, content).map_err(|e| e.to_string())?;
            self.writes.lock().unwrap().push((path.to_owned(), content.to_vec()));
            Ok(())
        }
        async fn note_written(&self, paths: &[PathBuf], _: Option<&str>) {
            self.noted.lock().unwrap().extend(paths.iter().cloned());
        }
        async fn record_changes(&self, _: &Path, _: &str, changes: Vec<FileChange>) {
            self.recorded.lock().unwrap().extend(changes);
        }
    }

    /// A fix over `[start, end)` of `source` as scanned: it carries the digest of that source.
    fn fix_in(source: &str, start: usize, end: usize, text: &str, rule: &str) -> Value {
        json!({"byteOffset": [start, end], "text": text, "ruleId": rule, "scanned": sha256_hex(source.as_bytes())})
    }

    #[test]
    fn replacements_apply_back_to_front_so_offsets_hold() {
        let plan = plan_replacements(&[fix_in("abcdef", 0, 1, "X", "a"), fix_in("abcdef", 4, 5, "YY", "b")]);
        assert_eq!(plan.replacements[0].start, 4);
        assert_eq!(apply_replacements(b"abcdef", &plan.replacements).unwrap(), b"XbcdYYf");
        assert!(apply_replacements(b"ab", &[Replacement { start: 5, end: 6, text: String::new(), rule_id: String::new() }]).is_err());
        assert!(plan_replacements(&[fix_in("abcdef", 0, 1, "X", "a"), fix_in("other", 4, 5, "Y", "b")]).unverifiable[0].contains("different contents"));
    }

    #[test]
    fn overlaps_and_unusable_ranges_are_detected() {
        let s = "0123456789";
        let plan =
            plan_replacements(&[fix_in(s, 0, 4, "x", "a"), fix_in(s, 3, 6, "y", "b"), json!({"byteOffset": [5, 2], "text": "z"}), json!({"text": "no range"})]);
        assert_eq!((plan.overlaps.len(), plan.invalid), (1, 2));
        // Touching ranges are not overlaps.
        assert!(plan_replacements(&[fix_in(s, 0, 2, "x", ""), fix_in(s, 2, 4, "y", "")]).overlaps.is_empty());
        let unverified = plan_replacements(&[
            json!({"byteOffset": [0, 1], "text": "x"}),
            json!({"byteOffset": [0, 1], "text": "x", "stale": "the file changed while it was scanned"}),
        ]);
        assert_eq!(unverified.unverifiable.len(), 2);
        assert!(unverified.replacements.is_empty());
    }

    /// A fix applies only to the bytes the scanner read, and never splits a character: a
    /// same-length edit after the scan or a stray offset rejects the file instead of corrupting it.
    #[tokio::test]
    async fn a_fix_over_text_that_is_no_longer_there_rejects_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let scanned = "var a = 1;";
        std::fs::write(dir.path().join("edited.ts"), "VAR a = 1;").unwrap();
        let wide = "x = \"é\";";
        std::fs::write(dir.path().join("wide.ts"), wide).unwrap();
        let host = Recording::default();
        let matches = vec![
            ("edited.ts".to_owned(), vec![json!({"ruleId": "var", "fix": fix_in(scanned, 0, 3, "let", "")})]),
            // Byte 6 sits inside the two-byte é.
            ("wide.ts".to_owned(), vec![json!({"ruleId": "r", "fix": fix_in(wide, 6, 7, "e", "")})]),
        ];
        let lane = mixdog_rt::testing::tokens().durability_io;
        let out = apply_structural_fixes(lane, &host, dir.path(), &matches, None, None).await;
        assert!(out.applied.is_empty(), "{:?}", out.applied);
        assert!(out.rejected[0]["reason"].as_str().unwrap().contains("no longer holds the bytes the rules matched"), "{:?}", out.rejected);
        assert!(out.rejected[1]["reason"].as_str().unwrap().contains("splits a multi-byte character"), "{:?}", out.rejected);
        assert_eq!(std::fs::read_to_string(dir.path().join("edited.ts")).unwrap(), "VAR a = 1;");
        assert_eq!(std::fs::read_to_string(dir.path().join("wide.ts")).unwrap(), "x = \"é\";");
        assert!(host.writes.lock().unwrap().is_empty());
    }

    /// A tracked symbolic link whose target is outside the project is not a write target.
    #[tokio::test]
    async fn a_link_out_of_the_project_is_not_written() {
        let (project, outside) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let target = outside.path().join("t.ts");
        std::fs::write(&target, "var a = 1;").unwrap();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&target, project.path().join("link.ts"));
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&target, project.path().join("link.ts"));
        if let Err(e) = linked {
            return eprintln!("skipped: cannot create a symbolic link here: {e}");
        }
        std::fs::write(project.path().join("own.ts"), "x").unwrap();
        let lane = mixdog_rt::testing::tokens().durability_io;
        let matches = vec![("link.ts".to_owned(), vec![json!({"ruleId": "var", "fix": fix_in("var a = 1;", 0, 3, "let", "")})])];
        let out = apply_structural_fixes(lane, &Recording::default(), project.path(), &matches, None, None).await;
        assert!(out.applied.is_empty());
        assert!(out.rejected[0]["reason"].as_str().unwrap().contains("is outside the project, so it is not a write target"), "{:?}", out.rejected);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "var a = 1;");
        let escapes = escaping_write_targets(lane, project.path(), &["link.ts".into(), "own.ts".into()], &["link.ts".into()]).await.unwrap();
        assert_eq!(escapes.iter().map(|(f, _)| f.as_str()).collect::<Vec<_>>(), ["link.ts"]);
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
            ("ok.ts".to_owned(), vec![json!({"ruleId": "var", "fix": fix_in("var a = 1;", 0, 3, "let", "")}), json!({"ruleId": "info"})]),
            (
                "clash.ts".to_owned(),
                vec![json!({"ruleId": "r1", "fix": fix_in("0123456789", 0, 5, "x", "")}), json!({"ruleId": "r2", "fix": fix_in("0123456789", 3, 8, "y", "")})],
            ),
            ("missing.ts".to_owned(), vec![json!({"ruleId": "r", "fix": fix_in("z", 0, 1, "z", "")})]),
            ("none.ts".to_owned(), vec![json!({"ruleId": "r"})]),
        ];
        let lane = mixdog_rt::testing::tokens().durability_io;
        let out = apply_structural_fixes(lane, &host, dir.path(), &matches, Some("s1"), None).await;
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
        let none = apply_structural_fixes(lane, &Recording::default(), dir.path(), &[], None, None).await;
        assert!(none.applied.is_empty());
    }
    /// A session aborted before the write refuses it: the file is left as it was and the
    /// rejection carries the write's own text.
    #[tokio::test]
    async fn an_aborted_session_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("ok.ts"), "var a = 1;").unwrap();
        let host = Recording::default();
        let matches = vec![("ok.ts".to_owned(), vec![json!({"ruleId": "var", "fix": fix_in("var a = 1;", 0, 3, "let", "")})])];
        let cancel = CancellationToken::new();
        cancel.cancel();
        let lane = mixdog_rt::testing::tokens().durability_io;
        let out = apply_structural_fixes(lane, &host, dir.path(), &matches, Some("s1"), Some(&cancel)).await;
        assert_eq!(std::fs::read_to_string(dir.path().join("ok.ts")).unwrap(), "var a = 1;");
        assert!(out.applied.is_empty());
        assert_eq!(out.rejected, vec![json!({"file": "ok.ts", "reason": "atomicWrite aborted"})]);
        assert!(host.recorded.lock().unwrap().is_empty());
    }
}
