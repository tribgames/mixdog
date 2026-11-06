//! dotnet-format — toolchain formatter for loose .cs files (no .csproj):
//! `dotnet format whitespace <folder> --folder --include <relative files…>`; check adds
//! `--verify-no-changes --report <json>`, fix omits verify-no-changes. FolderWorkspace walks
//! the given folder, so the folder is the parent of each include list, never the repo root.

use std::collections::BTreeMap;
use std::path::Path;

use async_trait::async_trait;
use mixdog_rt::DurabilityIo;
use serde_json::Value;

use super::shared::*;
use crate::lane::{io_on_lane, on_lane};

pub const ID: &str = "dotnet-format";
pub const INSTALL_HINT: &str = "install the .NET SDK (dotnet format)";

fn rows_of(payload: &Value) -> Vec<Value> {
    if let Some(a) = payload.as_array() {
        return a.clone();
    }
    ["documentReports", "DocumentReports", "files"].iter().find_map(|k| payload.get(*k).and_then(Value::as_array).cloned()).unwrap_or_default()
}

fn first<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|k| v.get(*k).filter(|x| !x.is_null()))
}

/// Parses a `dotnet format --report` JSON document.
pub fn parse_dotnet_format_report(json_text: &str, cwd: &Path) -> RunnerResult {
    let text = mixdog_js::js_trim(json_text);
    let Ok(payload) = serde_json::from_str::<Value>(text) else { return RunnerResult::default() };
    let (mut diagnostics, mut files) = (Vec::new(), Vec::new());
    for row in rows_of(&payload) {
        let path = first(&row, &["FilePath", "filePath", "FileName", "fileName"]).and_then(Value::as_str).unwrap_or("");
        let file = to_rel_long_path(cwd, path);
        if file.is_empty() {
            continue;
        }
        files.push(file.clone());
        let changes = first(&row, &["FileChanges", "fileChanges", "Changes", "changes"]).and_then(Value::as_array).cloned().unwrap_or_default();
        if changes.is_empty() {
            diagnostics.push(diagnostic(DiagnosticInit { file: &file, code: ID, message: "dotnet-format would reformat this file", severity: "warning", fixable: true, ..Default::default() }));
            continue;
        }
        for change in changes {
            let message = first(&change, &["FormatDescription", "formatDescription", "Message", "message"]).and_then(Value::as_str).map(mixdog_js::js_trim).filter(|m| !m.is_empty()).unwrap_or("dotnet-format would reformat this file");
            diagnostics.push(diagnostic(DiagnosticInit {
                file: &file,
                line: number(first(&change, &["LineNumber", "lineNumber", "Line", "line"])),
                col: number(first(&change, &["CharNumber", "charNumber", "Column", "column"])),
                code: ID,
                message,
                severity: "warning",
                fixable: true,
            }));
        }
    }
    RunnerResult { diagnostics, changed_files: unique_paths(files), ..Default::default() }
}

/// True when `dotnet` is missing or too old for `format whitespace --folder`.
pub fn is_unsupported(stderr: &str, stdout: &str) -> bool {
    let text = format!("{stderr}\n{stdout}").to_lowercase();
    ["could not execute because the specified command or file was not found", "no executable found matching command", "dotnet-format does not exist", "unrecognized command or argument"].iter().any(|p| text.contains(p))
}

fn with_install_hint(mut result: RunnerResult, timed_out: bool) -> RunnerResult {
    if !timed_out {
        result.diagnostics[0].message.push_str(&format!(". {INSTALL_HINT}"));
    }
    result
}

/// The report a spawn wrote, read on the lane; empty when there is none.
async fn read_report(lane: DurabilityIo, path: &Path) -> String {
    let path = path.to_owned();
    on_lane(lane, move || read_report_blocking(&path)).await.unwrap_or_default()
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn read_report_blocking(path: &Path) -> String {
    let try_dir = |p: &Path| std::fs::read_to_string(p.join("format-report.json")).ok();
    if path.is_dir() { try_dir(path) } else { std::fs::read_to_string(path).ok().or_else(|| try_dir(path)) }.unwrap_or_default()
}

pub struct Spawn1 {
    pub folder: String,
    pub files: Vec<String>,
}

/// One spawn per parent folder, with include lists chunked to stay inside the argv cap.
pub fn plan_spawns(files: &[String], cwd: &Path, per_spawn: usize) -> Vec<Spawn1> {
    let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    for file in files {
        let rel = to_rel_long_path(cwd, file);
        if rel.is_empty() {
            continue;
        }
        let (folder, name) = match rel.rfind('/') {
            Some(i) => (rel[..i].to_owned(), rel[i + 1..].to_owned()),
            None => (".".to_owned(), rel.clone()),
        };
        if name.is_empty() {
            continue;
        }
        if !groups.contains_key(&folder) {
            order.push(folder.clone());
        }
        groups.entry(folder).or_default().push(name);
    }
    let mut spawns = Vec::new();
    for folder in order {
        for chunk in chunk_files(&groups[&folder], per_spawn) {
            if !chunk.is_empty() {
                spawns.push(Spawn1 { folder: folder.clone(), files: chunk });
            }
        }
    }
    spawns
}

async fn invoke(req: &RunRequest, verify: bool) -> RunnerResult {
    let spawns = plan_spawns(&req.files, &req.cwd, req.files_per_spawn);
    if spawns.is_empty() {
        return RunnerResult::default();
    }
    let root = std::env::temp_dir().join(format!("mixdog-dotnet-format-{}", uuid::Uuid::new_v4().simple()));
    let (lane, made) = (req.lane, root.clone());
    if io_on_lane(lane, move || create_report_dir(&made)).await.is_err() {
        return spawn_failure_result(ID, "cannot create a report directory", false, -1, "");
    }
    let outcome = async {
        let (mut diagnostics, mut changed, mut stderr) = (Vec::new(), Vec::new(), String::new());
        for (index, spawn) in spawns.iter().enumerate() {
            let report = root.join(format!("report-{index}.json"));
            let mut args = req.args.clone();
            args.extend(["whitespace".to_owned(), spawn.folder.clone(), "--folder".to_owned()]);
            if verify {
                args.push("--verify-no-changes".into());
            }
            args.extend(["--report".to_owned(), report.to_string_lossy().into_owned(), "--include".to_owned()]);
            args.extend(spawn.files.iter().cloned());
            let r = req.spawn.run(&req.bin, &args, &req.cwd, req.timeout, req.cancel.as_ref(), None, None).await;
            stderr.push_str(&r.stderr);
            if !r.error.is_empty() {
                let f = spawn_failure_result(ID, &r.error, r.timed_out, r.code, &r.stderr);
                return with_install_hint(f, r.timed_out);
            }
            if is_unsupported(&r.stderr, &r.stdout) {
                let error = if mixdog_js::js_trim(&r.stderr).is_empty() { format!("exit {}", r.code) } else { tail600(&r.stderr) };
                return with_install_hint(spawn_failure_result(ID, &error, false, r.code, &r.stderr), false);
            }
            if !verify {
                continue;
            }
            let parsed = parse_dotnet_format_report(&read_report(lane, &report).await, &req.cwd);
            if parsed.changed_files.is_empty() && parsed.diagnostics.is_empty() && r.code != 0 {
                let error = if mixdog_js::js_trim(&r.stderr).is_empty() { format!("exit {}", r.code) } else { tail600(&r.stderr) };
                return spawn_failure_result(ID, &error, r.timed_out, r.code, &r.stderr);
            }
            diagnostics.extend(parsed.diagnostics);
            changed.extend(parsed.changed_files);
        }
        let unique = unique_paths(changed);
        let t = if unique.is_empty() { tail600(&stderr) } else { String::new() };
        RunnerResult { diagnostics: if verify { diagnostics } else { Vec::new() }, changed_files: if verify { unique } else { Vec::new() }, stderr_tail: t, ..Default::default() }
    }
    .await;
    let _ = on_lane(lane, move || remove_report_dir(&root)).await;
    outcome
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn create_report_dir(root: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(root)
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn remove_report_dir(root: &Path) {
    let _ = std::fs::remove_dir_all(root);
}

pub struct DotnetFormat;

#[async_trait]
impl Runner for DotnetFormat {
    fn id(&self) -> &'static str {
        ID
    }
    async fn check(&self, req: &RunRequest) -> RunnerResult {
        invoke(req, true).await
    }
    async fn fix(&self, req: &RunRequest) -> RunnerResult {
        invoke(req, false).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_rows_become_per_change_diagnostics() {
        let json = "\u{feff}[{\"FilePath\":\"/r/a.cs\",\"FileChanges\":[{\"LineNumber\":3,\"CharNumber\":5,\"FormatDescription\":\"Fix whitespace\"}]},{\"FilePath\":\"/r/b.cs\",\"FileChanges\":[]}]";
        let out = parse_dotnet_format_report(json, Path::new("/r"));
        assert_eq!(out.changed_files, ["a.cs", "b.cs"]);
        assert_eq!((out.diagnostics[0].line, out.diagnostics[0].col, out.diagnostics[0].message.as_str()), (3, 5, "Fix whitespace"));
        assert_eq!(out.diagnostics[1].message, "dotnet-format would reformat this file");
        assert!(parse_dotnet_format_report("nope", Path::new("/r")).diagnostics.is_empty());
        assert_eq!(parse_dotnet_format_report("{\"documentReports\":[{\"filePath\":\"/r/c.cs\"}]}", Path::new("/r")).changed_files, ["c.cs"]);
    }

    #[test]
    fn spawns_group_by_folder_and_chunk_include_lists() {
        let files: Vec<String> = ["src/a.cs", "src/b.cs", "src/c.cs", "top.cs", "lib/x.cs"].iter().map(|s| (*s).to_owned()).collect();
        let spawns = plan_spawns(&files, Path::new("/r"), 2);
        let shape: Vec<(String, usize)> = spawns.iter().map(|s| (s.folder.clone(), s.files.len())).collect();
        assert_eq!(shape, [("src".to_owned(), 2), ("src".to_owned(), 1), (".".to_owned(), 1), ("lib".to_owned(), 1)]);
        assert_eq!(spawns[0].files, ["a.cs", "b.cs"]);
    }

    #[test]
    fn a_missing_or_old_sdk_is_recognised() {
        assert!(is_unsupported("Could not execute because the specified command or file was not found.", ""));
        assert!(is_unsupported("", "Unrecognized command or argument 'whitespace'"));
        assert!(!is_unsupported("fine", "fine"));
        let hinted = with_install_hint(spawn_failure_result(ID, "ENOENT", false, -1, ""), false);
        assert!(hinted.diagnostics[0].message.ends_with(INSTALL_HINT));
    }
}
