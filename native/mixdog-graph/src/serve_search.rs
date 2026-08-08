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
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use ignore::overrides::OverrideBuilder;
use ignore::WalkBuilder;
use rayon::prelude::*;
use regex::Regex;
use serde::Deserialize;

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

struct ParsedArgs {
    patterns: Vec<String>,
    globs: Vec<String>,
    targets: Vec<String>,
    before: usize,
    after: usize,
    case_insensitive: bool,
    fixed_strings: bool,
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
        targets: Vec::new(),
        before: 0,
        after: 0,
        case_insensitive: false,
        fixed_strings: false,
        line_numbers: false,
        with_filename: false,
        files_with_matches: false,
        files_list: false,
        max_columns: 0,
    };
    let mut i = 0usize;
    let mut options = true;
    let take = |i: &mut usize, args: &[String]| -> Result<String, String> {
        *i += 1;
        args.get(*i).cloned().ok_or_else(|| "missing flag value".to_string())
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
            "--color" => { take(&mut i, args)?; }
            "--threads" | "-j" => { take(&mut i, args)?; }
            "--hidden" | "--no-heading" | "--max-columns-preview" => {}
            "-H" => p.with_filename = true,
            "--line-number" | "-n" => p.line_numbers = true,
            "-i" => p.case_insensitive = true,
            "-F" => p.fixed_strings = true,
            "--files-with-matches" | "-l" => p.files_with_matches = true,
            "--files" => p.files_list = true,
            "-e" => p.patterns.push(take(&mut i, args)?),
            "--glob" => p.globs.push(take(&mut i, args)?),
            "-B" => p.before = take(&mut i, args)?.parse().map_err(|_| "bad -B")?,
            "-A" => p.after = take(&mut i, args)?.parse().map_err(|_| "bad -A")?,
            "-C" => {
                let n: usize = take(&mut i, args)?.parse().map_err(|_| "bad -C")?;
                p.before = n;
                p.after = n;
            }
            _ if a.starts_with("--max-columns=") => {
                p.max_columns = a["--max-columns=".len()..].parse().map_err(|_| "bad --max-columns")?;
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
            if p.fixed_strings { regex::escape(raw) } else { raw.clone() }
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
fn collect_files(operand: &Path, globs: &[String]) -> Result<Vec<PathBuf>, String> {
    if operand.is_file() {
        return Ok(vec![operand.to_path_buf()]);
    }
    if !operand.is_dir() {
        return Err(format!("no such path {}", operand.display()));
    }
    let mut over = OverrideBuilder::new(operand);
    for g in globs {
        over.add(g).map_err(|e| format!("glob: {e}"))?;
    }
    let over = over.build().map_err(|e| format!("glob: {e}"))?;
    let mut files = Vec::new();
    for entry in WalkBuilder::new(operand).hidden(false).overrides(over).build() {
        let Ok(entry) = entry else { continue };
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            files.push(entry.into_path());
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
fn scan_file(path: &Path, prefix: &str, re: &Regex, p: &ParsedArgs) -> Option<Vec<String>> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return None; // binary, rg default skip
    }
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = text.split('\n').collect();
    let mut matched: Vec<usize> = Vec::new();
    for (idx, line) in lines.iter().enumerate() {
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
    let sep = if operand.contains('/') && !operand.contains('\\') { "/" } else { std::path::MAIN_SEPARATOR_STR };
    let rel = rel.to_string_lossy().replace(['/', '\\'], sep);
    let trimmed = operand.trim_end_matches(['/', '\\']);
    format!("{trimmed}{sep}{rel}")
}

fn handle(req: &ServeRequest) -> Result<serde_json::Value, String> {
    let parsed = parse_args(&req.args)?;
    // rg --files mode (glob tool): no patterns, just the ignore-aware walk
    // with --glob overrides — the whole cost of a cold glob was the spawn.
    if parsed.files_list {
        let cwd = Path::new(&req.cwd);
        let mut all_lines: Vec<String> = Vec::new();
        for operand in &parsed.targets {
            let operand_path = if Path::new(operand).is_absolute() {
                PathBuf::from(operand)
            } else {
                cwd.join(operand)
            };
            for file in collect_files(&operand_path, &parsed.globs)? {
                all_lines.push(display_path(operand, &operand_path, &file));
            }
        }
        let total_after_offset = all_lines.len().saturating_sub(req.offset);
        let window: Vec<&String> = all_lines
            .iter()
            .skip(req.offset)
            .take(if req.limit > 0 { req.limit } else { usize::MAX })
            .collect();
        let complete = req.limit == 0 || total_after_offset <= req.limit;
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
    for operand in &parsed.targets {
        let operand_path = if Path::new(operand).is_absolute() {
            PathBuf::from(operand)
        } else {
            cwd.join(operand)
        };
        let files = collect_files(&operand_path, &parsed.globs)?;
        let use_prefix = parsed.with_filename || multi_target || operand_path.is_dir();
        let per_file: Vec<Vec<String>> = files
            .par_iter()
            .filter_map(|file| {
                let prefix = if use_prefix { display_path(operand, &operand_path, file) } else { String::new() };
                scan_file(file, &prefix, &re, &parsed)
            })
            .collect();
        for (index, block) in per_file.iter().enumerate() {
            if index > 0 && (parsed.before > 0 || parsed.after > 0) && !parsed.files_with_matches {
                all_lines.push("--".to_string());
            }
            all_lines.extend(block.iter().cloned());
        }
    }
    let total_after_offset = all_lines.len().saturating_sub(req.offset);
    let window: Vec<&String> = all_lines
        .iter()
        .skip(req.offset)
        .take(if req.limit > 0 { req.limit } else { usize::MAX })
        .collect();
    let complete = req.limit == 0 || total_after_offset <= req.limit;
    Ok(serde_json::json!({
        "id": req.id,
        "lines": window,
        "complete": complete,
        "totalSeen": total_after_offset,
    }))
}

pub fn run() {
    let stdout = std::io::stdout();
    {
        let mut out = stdout.lock();
        let _ = writeln!(out, "{}", serde_json::json!({ "ready": true }));
        let _ = out.flush();
    }
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<ServeRequest>(&line) {
            Ok(req) => match handle(&req) {
                Ok(value) => value,
                Err(reason) => serde_json::json!({ "id": req.id, "unsupported": reason }),
            },
            Err(error) => serde_json::json!({ "id": 0, "error": format!("bad request: {error}") }),
        };
        let mut out = stdout.lock();
        let _ = writeln!(out, "{response}");
        let _ = out.flush();
    }
}
