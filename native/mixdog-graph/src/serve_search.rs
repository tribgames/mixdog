// Resident search server: JSONL over stdio, one request per line.
//
// Motivation (measured): every grep pays ~100ms of Windows process spawn +
// AV on-access scan for rg while the actual match work is ~5-10ms. This mode
// keeps ONE warm process and answers rg-COMPATIBLE content searches without a
// spawn. The Node side forwards the exact rg argv it would have used;
// anything outside the supported subset gets {"unsupported":...} and falls
// back to a real rg spawn, so behavior can never silently diverge.
//
// Request : {"id":1,"cwd":"C:/repo","args":["--color","never",...],"offset":0,"limit":400}
// Response: {"id":1,"lines":[...],"complete":true,"totalSeen":N}
//         | {"id":1,"unsupported":"reason"} | {"id":1,"error":"..."}
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use ignore::overrides::OverrideBuilder;
use ignore::WalkBuilder;
use rayon::prelude::*;
use rayon::{ThreadPool, ThreadPoolBuilder};
use regex::Regex;
use serde::Deserialize;

const CANCELLED: &str = "cancelled";

#[derive(Deserialize)]
struct ServeRequest {
    id: u64,
    cwd: String,
    args: Vec<String>,
    #[serde(default)]
    offset: usize,
    #[serde(default)]
    limit: usize,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WireRequest {
    Search(ServeRequest),
    Cancel {
        cancel: u64,
    },
    ProcessSnapshot {
        id: u64,
        #[serde(rename = "processSnapshot")]
        process_snapshot: bool,
    },
}

struct ParsedArgs {
    patterns: Vec<String>,
    globs: Vec<String>,
    iglobs: Vec<String>,
    targets: Vec<String>,
    before: usize,
    after: usize,
    case_insensitive: bool,
    fixed_strings: bool,
    hidden: bool,
    no_ignore: bool,
    no_require_git: bool,
    max_depth: Option<usize>,
    line_numbers: bool,
    with_filename: bool,
    files_with_matches: bool,
    files_list: bool,
    max_columns: usize,
}

fn parse_args(args: &[String]) -> Result<ParsedArgs, String> {
    let mut p = ParsedArgs {
        patterns: Vec::new(),
        globs: Vec::new(),
        iglobs: Vec::new(),
        targets: Vec::new(),
        before: 0,
        after: 0,
        case_insensitive: false,
        fixed_strings: false,
        hidden: false,
        no_ignore: false,
        no_require_git: false,
        max_depth: None,
        line_numbers: false,
        with_filename: false,
        files_with_matches: false,
        files_list: false,
        max_columns: 0,
    };
    let mut i = 0usize;
    let mut options = true;
    let mut saw_glob = false;
    let take = |i: &mut usize, args: &[String]| -> Result<String, String> {
        *i += 1;
        args.get(*i)
            .cloned()
            .ok_or_else(|| "missing flag value".to_string())
    };
    while i < args.len() {
        let a = args[i].as_str();
        if !options {
            p.targets.push(a.to_string());
            i += 1;
            continue;
        }
        match a {
            "--" => options = false,
            "--color" => {
                take(&mut i, args)?;
            }
            "--threads" | "-j" => {
                take(&mut i, args)?;
            }
            "--hidden" => p.hidden = true,
            "--no-ignore" => p.no_ignore = true,
            "--no-require-git" => p.no_require_git = true,
            "--no-heading" | "--max-columns-preview" => {}
            "-H" => p.with_filename = true,
            "--line-number" | "-n" => p.line_numbers = true,
            "-i" => p.case_insensitive = true,
            "-F" => p.fixed_strings = true,
            "--files-with-matches" | "-l" => p.files_with_matches = true,
            "--files" => p.files_list = true,
            "-e" => p.patterns.push(take(&mut i, args)?),
            "--glob" => {
                saw_glob = true;
                p.globs.push(take(&mut i, args)?);
            }
            "--iglob" => {
                if saw_glob {
                    return Err("--iglob after --glob".to_string());
                }
                p.iglobs.push(take(&mut i, args)?);
            }
            "--max-depth" => {
                p.max_depth = Some(take(&mut i, args)?.parse().map_err(|_| "bad --max-depth")?);
            }
            "-B" => p.before = take(&mut i, args)?.parse().map_err(|_| "bad -B")?,
            "-A" => p.after = take(&mut i, args)?.parse().map_err(|_| "bad -A")?,
            "-C" => {
                let n: usize = take(&mut i, args)?.parse().map_err(|_| "bad -C")?;
                p.before = n;
                p.after = n;
            }
            _ if a.starts_with("--max-columns=") => {
                p.max_columns = a["--max-columns=".len()..]
                    .parse()
                    .map_err(|_| "bad --max-columns")?;
            }
            _ if a.starts_with("--threads=") || a.starts_with("-j") && a.len() > 2 => {}
            _ if !a.starts_with('-') => p.targets.push(a.to_string()),
            other => return Err(format!("unsupported flag {other}")),
        }
        i += 1;
    }
    if p.patterns.is_empty() && !p.files_list {
        return Err("no -e patterns".to_string());
    }
    if p.targets.is_empty() {
        return Err("no target path".to_string());
    }
    Ok(p)
}

fn build_regex(p: &ParsedArgs) -> Result<Regex, String> {
    let bodies: Vec<String> = p
        .patterns
        .iter()
        .map(|raw| {
            if p.fixed_strings {
                regex::escape(raw)
            } else {
                raw.clone()
            }
        })
        .map(|b| format!("(?:{b})"))
        .collect();
    let flags = if p.case_insensitive { "(?i)" } else { "" };
    Regex::new(&format!("{flags}{}", bodies.join("|"))).map_err(|e| format!("regex: {e}"))
}

/// Collect candidate files for one operand. A file operand is returned as-is;
/// a directory operand walks with gitignore semantics + --glob overrides
/// (rg's --hidden is always passed by the caller, so hidden files are
/// included and the '!' globs do the noise filtering).
fn collect_files(
    operand: &Path,
    parsed: &ParsedArgs,
    cancelled: &AtomicBool,
    max_files: Option<usize>,
) -> Result<Vec<PathBuf>, String> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(CANCELLED.to_string());
    }
    if operand.is_file() {
        return Ok(vec![operand.to_path_buf()]);
    }
    if !operand.is_dir() {
        return Err(format!("no such path {}", operand.display()));
    }
    let mut over = OverrideBuilder::new(operand);
    for g in &parsed.globs {
        over.add(g).map_err(|e| format!("glob: {e}"))?;
    }
    let over = over.build().map_err(|e| format!("glob: {e}"))?;
    let iglob_over = if parsed.iglobs.is_empty() {
        None
    } else {
        let mut builder = OverrideBuilder::new(operand);
        builder
            .case_insensitive(true)
            .map_err(|e| format!("iglob: {e}"))?;
        for g in &parsed.iglobs {
            builder.add(g).map_err(|e| format!("iglob: {e}"))?;
        }
        Some(builder.build().map_err(|e| format!("iglob: {e}"))?)
    };
    let mut files = Vec::new();
    let mut walk = WalkBuilder::new(operand);
    walk.hidden(!parsed.hidden).overrides(over);
    if parsed.no_ignore {
        walk.ignore(false)
            .git_ignore(false)
            .git_global(false)
            .git_exclude(false);
    } else if parsed.no_require_git {
        walk.require_git(false);
    }
    if let Some(max_depth) = parsed.max_depth {
        walk.max_depth(Some(max_depth));
    }
    if max_files.is_none() {
        let threads = std::thread::available_parallelism()
            .map(|count| count.get())
            .unwrap_or(2)
            .clamp(2, 4);
        walk.threads(threads);
        let collected = Mutex::new(Vec::new());
        walk.build_parallel().run(|| {
            let collected = &collected;
            let iglob_over = iglob_over.as_ref();
            Box::new(move |entry| {
                if cancelled.load(Ordering::Relaxed) {
                    return ignore::WalkState::Quit;
                }
                let Ok(entry) = entry else {
                    return ignore::WalkState::Continue;
                };
                if !entry
                    .file_type()
                    .map(|kind| kind.is_file())
                    .unwrap_or(false)
                {
                    return ignore::WalkState::Continue;
                }
                if iglob_over
                    .is_some_and(|matcher| !matcher.matched(entry.path(), false).is_whitelist())
                {
                    return ignore::WalkState::Continue;
                }
                if let Ok(mut files) = collected.lock() {
                    files.push(entry.into_path());
                }
                ignore::WalkState::Continue
            })
        });
        if cancelled.load(Ordering::Relaxed) {
            return Err(CANCELLED.to_string());
        }
        files = collected
            .into_inner()
            .map_err(|_| "parallel file collector poisoned".to_string())?;
        files.sort();
        return Ok(files);
    }
    walk.sort_by_file_name(|left, right| left.cmp(right));
    for entry in walk.build() {
        if cancelled.load(Ordering::Relaxed) {
            return Err(CANCELLED.to_string());
        }
        let Ok(entry) = entry else { continue };
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            if iglob_over
                .as_ref()
                .is_some_and(|matcher| !matcher.matched(entry.path(), false).is_whitelist())
            {
                continue;
            }
            files.push(entry.into_path());
            if max_files.is_some_and(|limit| files.len() >= limit) {
                break;
            }
        }
    }
    files.sort();
    Ok(files)
}

fn clamp_line(text: &str, max_columns: usize) -> String {
    if max_columns == 0 || text.len() <= max_columns {
        return text.to_string();
    }
    let mut end = max_columns;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{} [... omitted end of long line]", &text[..end])
}

/// One file's output lines in rg --no-heading format. `prefix` is the operand-
/// joined display path ('' means no filename prefix, single-file semantics).
fn scan_file(
    path: &Path,
    prefix: &str,
    re: &Regex,
    p: &ParsedArgs,
    cancelled: &AtomicBool,
) -> Option<Vec<String>> {
    if cancelled.load(Ordering::Relaxed) {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return None; // binary, rg default skip
    }
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = text.split('\n').collect();
    let mut matched: Vec<usize> = Vec::new();
    for (idx, line) in lines.iter().enumerate() {
        if idx & 1023 == 0 && cancelled.load(Ordering::Relaxed) {
            return None;
        }
        let line = line.strip_suffix('\r').unwrap_or(line);
        if re.is_match(line) {
            matched.push(idx);
        }
    }
    if matched.is_empty() {
        return None;
    }
    if p.files_with_matches {
        return Some(vec![prefix.trim_end_matches(':').to_string()]);
    }
    let mut out = Vec::new();
    let mut block_end: Option<usize> = None; // exclusive end of the last block
    let matched_set: std::collections::HashSet<usize> = matched.iter().copied().collect();
    let emit = |idx: usize, is_match: bool, out: &mut Vec<String>| {
        let line = lines[idx].strip_suffix('\r').unwrap_or(lines[idx]);
        let sep = if is_match { ':' } else { '-' };
        let number = if p.line_numbers {
            format!("{}{}", idx + 1, sep)
        } else {
            String::new()
        };
        let head = if prefix.is_empty() {
            number
        } else {
            format!("{}{}{}", prefix.trim_end_matches(':'), sep, number)
        };
        out.push(format!("{head}{}", clamp_line(line, p.max_columns)));
    };
    for &m in &matched {
        let start = m.saturating_sub(p.before);
        // Never re-emit lines already covered by the previous block.
        let start = block_end.map_or(start, |e| start.max(e));
        let end = (m + p.after + 1).min(lines.len());
        if start >= end {
            continue; // fully covered by the previous block
        }
        if let Some(e) = block_end {
            if start > e && (p.before > 0 || p.after > 0) {
                out.push("--".to_string());
            }
        }
        for idx in start..end {
            emit(idx, matched_set.contains(&idx), &mut out);
        }
        block_end = Some(end.max(block_end.unwrap_or(0)));
    }
    Some(out)
}

fn display_path(operand: &str, operand_path: &Path, file: &Path) -> String {
    if operand_path.is_file() {
        return operand.to_string();
    }
    let rel = file.strip_prefix(operand_path).unwrap_or(file);
    let sep = if operand.contains('/') && !operand.contains('\\') {
        "/"
    } else {
        std::path::MAIN_SEPARATOR_STR
    };
    let rel = rel.to_string_lossy().replace(['/', '\\'], sep);
    let trimmed = operand.trim_end_matches(['/', '\\']);
    format!("{trimmed}{sep}{rel}")
}

fn handle(req: &ServeRequest, cancelled: &AtomicBool) -> Result<serde_json::Value, String> {
    let parsed = parse_args(&req.args)?;
    let collect_until = if req.limit > 0 {
        req.offset.saturating_add(req.limit).saturating_add(1)
    } else {
        usize::MAX
    };
    // rg --files mode (glob tool): no patterns, just the ignore-aware walk
    // with --glob overrides — the whole cost of a cold glob was the spawn.
    if parsed.files_list {
        let cwd = Path::new(&req.cwd);
        let mut all_lines: Vec<String> = Vec::new();
        for operand in &parsed.targets {
            if cancelled.load(Ordering::Relaxed) {
                return Err(CANCELLED.to_string());
            }
            let operand_path = if Path::new(operand).is_absolute() {
                PathBuf::from(operand)
            } else {
                cwd.join(operand)
            };
            let remaining = collect_until.saturating_sub(all_lines.len());
            let max_files = (collect_until != usize::MAX).then_some(remaining);
            for file in collect_files(&operand_path, &parsed, cancelled, max_files)? {
                all_lines.push(display_path(operand, &operand_path, &file));
                if all_lines.len() >= collect_until {
                    break;
                }
            }
            if all_lines.len() >= collect_until {
                break;
            }
        }
        let total_after_offset = all_lines.len().saturating_sub(req.offset);
        let window: Vec<&String> = all_lines
            .iter()
            .skip(req.offset)
            .take(if req.limit > 0 { req.limit } else { usize::MAX })
            .collect();
        let complete =
            all_lines.len() < collect_until && (req.limit == 0 || total_after_offset <= req.limit);
        return Ok(serde_json::json!({
            "id": req.id,
            "lines": window,
            "complete": complete,
            "totalSeen": total_after_offset,
        }));
    }
    let re = build_regex(&parsed)?;
    let cwd = Path::new(&req.cwd);
    let multi_target = parsed.targets.len() > 1;
    let mut all_lines: Vec<String> = Vec::new();
    let mut emitted_blocks = 0usize;
    let chunk_size = (rayon::current_num_threads() * 4).max(16);
    'operands: for operand in &parsed.targets {
        if cancelled.load(Ordering::Relaxed) {
            return Err(CANCELLED.to_string());
        }
        let operand_path = if Path::new(operand).is_absolute() {
            PathBuf::from(operand)
        } else {
            cwd.join(operand)
        };
        let files = collect_files(&operand_path, &parsed, cancelled, None)?;
        let use_prefix = parsed.with_filename || multi_target || operand_path.is_dir();
        for file_chunk in files.chunks(chunk_size) {
            if cancelled.load(Ordering::Relaxed) {
                return Err(CANCELLED.to_string());
            }
            let per_file: Vec<Option<Vec<String>>> = file_chunk
                .par_iter()
                .map(|file| {
                    let prefix = if use_prefix {
                        display_path(operand, &operand_path, file)
                    } else {
                        String::new()
                    };
                    scan_file(file, &prefix, &re, &parsed, cancelled)
                })
                .collect();
            for block in per_file.into_iter().flatten() {
                if emitted_blocks > 0
                    && (parsed.before > 0 || parsed.after > 0)
                    && !parsed.files_with_matches
                {
                    all_lines.push("--".to_string());
                }
                emitted_blocks += 1;
                all_lines.extend(block);
                if all_lines.len() >= collect_until {
                    all_lines.truncate(collect_until);
                    break 'operands;
                }
            }
        }
    }
    let total_after_offset = all_lines.len().saturating_sub(req.offset);
    let window: Vec<&String> = all_lines
        .iter()
        .skip(req.offset)
        .take(if req.limit > 0 { req.limit } else { usize::MAX })
        .collect();
    let complete =
        all_lines.len() < collect_until && (req.limit == 0 || total_after_offset <= req.limit);
    Ok(serde_json::json!({
        "id": req.id,
        "lines": window,
        "complete": complete,
        "totalSeen": total_after_offset,
    }))
}

fn server_parallelism() -> usize {
    let available = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);
    std::env::var("MIXDOG_SEARCH_SERVER_MAX_INFLIGHT")
        .ok()
        .and_then(|raw| raw.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or_else(|| available.clamp(2, 8))
}

fn write_response(response: &serde_json::Value) {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let _ = writeln!(out, "{response}");
    let _ = out.flush();
}

fn search_pool() -> ThreadPool {
    ThreadPoolBuilder::new()
        .num_threads(server_parallelism())
        .thread_name(|index| format!("mixdog-search-{index}"))
        .build()
        .expect("mixdog search worker pool")
}

fn bulk_search_pool() -> ThreadPool {
    let threads = std::env::var("MIXDOG_SEARCH_SERVER_MAX_BULK_INFLIGHT")
        .ok()
        .and_then(|raw| raw.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(2)
        .min(server_parallelism());
    ThreadPoolBuilder::new()
        .num_threads(threads)
        .thread_name(|index| format!("mixdog-search-bulk-{index}"))
        .build()
        .expect("mixdog bulk search worker pool")
}

fn is_bulk_file_enumeration(req: &ServeRequest) -> bool {
    req.limit == 0 && req.args.iter().any(|arg| arg == "--files")
}

#[cfg(target_os = "windows")]
fn process_snapshot(id: u64) -> serde_json::Value {
    use std::ffi::c_void;
    use std::mem;

    type Handle = *mut c_void;
    const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
    const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    #[repr(C)]
    #[allow(non_snake_case)]
    struct ProcessEntry32W {
        dwSize: u32,
        cntUsage: u32,
        th32ProcessID: u32,
        th32DefaultHeapID: usize,
        th32ModuleID: u32,
        cntThreads: u32,
        th32ParentProcessID: u32,
        pcPriClassBase: i32,
        dwFlags: u32,
        szExeFile: [u16; 260],
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> Handle;
        fn Process32FirstW(snapshot: Handle, entry: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(snapshot: Handle, entry: *mut ProcessEntry32W) -> i32;
        fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> Handle;
        fn GetProcessTimes(
            process: Handle,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    fn creation_identity(pid: u32) -> String {
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            return String::new();
        }
        let mut creation = FileTime::default();
        let mut exit = FileTime::default();
        let mut kernel = FileTime::default();
        let mut user = FileTime::default();
        let ok =
            unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) };
        unsafe {
            CloseHandle(process);
        }
        if ok == 0 {
            String::new()
        } else {
            ((u64::from(creation.high) << 32) | u64::from(creation.low)).to_string()
        }
    }

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return serde_json::json!({ "id": id, "error": "process snapshot failed" });
    }
    let mut entry = ProcessEntry32W {
        dwSize: mem::size_of::<ProcessEntry32W>() as u32,
        cntUsage: 0,
        th32ProcessID: 0,
        th32DefaultHeapID: 0,
        th32ModuleID: 0,
        cntThreads: 0,
        th32ParentProcessID: 0,
        pcPriClassBase: 0,
        dwFlags: 0,
        szExeFile: [0; 260],
    };
    let mut rows = Vec::new();
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) };
    while ok != 0 {
        if entry.th32ProcessID > 0 {
            rows.push(serde_json::json!({
                "pid": entry.th32ProcessID,
                "parentPid": entry.th32ParentProcessID,
                "identity": creation_identity(entry.th32ProcessID),
            }));
        }
        ok = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe {
        CloseHandle(snapshot);
    }
    serde_json::json!({ "id": id, "rows": rows })
}

#[cfg(not(target_os = "windows"))]
fn process_snapshot(id: u64) -> serde_json::Value {
    serde_json::json!({ "id": id, "error": "process snapshot is only available on Windows" })
}

pub fn run() {
    write_response(&serde_json::json!({ "ready": true }));
    let pool = search_pool();
    let bulk_pool = bulk_search_pool();
    let cancellations: Arc<Mutex<HashMap<u64, Arc<AtomicBool>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<WireRequest>(&line) {
            Ok(WireRequest::Cancel { cancel }) => {
                if let Some(flag) = cancellations
                    .lock()
                    .ok()
                    .and_then(|map| map.get(&cancel).cloned())
                {
                    flag.store(true, Ordering::Relaxed);
                }
            }
            Ok(WireRequest::ProcessSnapshot {
                id,
                process_snapshot: true,
            }) => write_response(&process_snapshot(id)),
            Ok(WireRequest::ProcessSnapshot { id, .. }) => write_response(
                &serde_json::json!({ "id": id, "error": "invalid process snapshot request" }),
            ),
            Ok(WireRequest::Search(req)) => {
                let id = req.id;
                let cancelled = Arc::new(AtomicBool::new(false));
                if let Ok(mut map) = cancellations.lock() {
                    map.insert(id, Arc::clone(&cancelled));
                }
                let request_cancellations = Arc::clone(&cancellations);
                let worker_pool = if is_bulk_file_enumeration(&req) {
                    &bulk_pool
                } else {
                    &pool
                };
                worker_pool.spawn(move || {
                    let response = match handle(&req, &cancelled) {
                        Ok(value) => Some(value),
                        Err(reason) if reason == CANCELLED || cancelled.load(Ordering::Relaxed) => {
                            None
                        }
                        Err(reason) => {
                            Some(serde_json::json!({ "id": req.id, "unsupported": reason }))
                        }
                    };
                    if let Ok(mut map) = request_cancellations.lock() {
                        map.remove(&id);
                    }
                    if !cancelled.load(Ordering::Relaxed) {
                        if let Some(response) = response {
                            write_response(&response);
                        }
                    }
                });
            }
            Err(error) => write_response(
                &serde_json::json!({ "id": 0, "error": format!("bad request: {error}") }),
            ),
        }
    }
}
