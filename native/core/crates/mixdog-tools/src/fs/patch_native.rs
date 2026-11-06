//! `apply_patch`'s native route, as Node's `dispatch.mjs` / `wave.mjs` run it: the resolved hunks
//! of every in-base update and delete are rendered as one unified patch and applied by the
//! `mixdog-patch` engine itself, so what lands on disk and what a rejected hunk reports are the
//! engine's own. Around it sit Node's summary rows and failure context.

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_js::js_trim;
use mixdog_patch_engine::ApplyOptions;
use mixdog_patch_engine::ApplyStats;
use mixdog_patch_engine::apply_patch_to_base;
use mixdog_rt::LaneToken;

use super::common::*;
use super::hints::compact_preview;
use super::hints::nearest_line;
use super::patch_guard::SNAPSHOT_MAX_BYTES;
use super::patch_guard::read_present;
use super::patch_hunk::Lines;
use super::patch_hunk::UHunk;
use super::patch_hunk::js_string;
use super::patch_hunk::normalize_typographic;

/// One in-base update or delete handed to the engine.
#[derive(Clone)]
pub(super) struct NativeEntry {
    pub delete: bool,
    /// The path as the patch headers write it (after `a/`), forward slashes.
    pub header: String,
    /// The `---` and `+++` header names as the engine is given them.
    pub old_name: String,
    pub new_name: String,
    pub abs: AbsPath,
    pub hunks: Vec<UHunk>,
    /// The lines a delete removes (empty for a file that is not valid UTF-8 text).
    pub deleted_lines: Vec<String>,
}

/// The unified patch for `entries`, one `--- a/` section each.
pub(super) fn render(entries: &[NativeEntry]) -> String {
    let mut out: Vec<String> = Vec::new();
    for e in entries {
        out.push(format!("--- {}", e.old_name));
        if e.delete {
            out.push("+++ /dev/null".to_owned());
            if e.hunks.is_empty() && !e.deleted_lines.is_empty() {
                out.push(format!("@@ -1,{} +0,0 @@", e.deleted_lines.len()));
                out.extend(e.deleted_lines.iter().map(|l| format!("-{l}")));
            }
        } else {
            out.push(format!("+++ {}", e.new_name));
        }
        if !e.hunks.is_empty() {
            for h in &e.hunks {
                out.push(h.header.clone());
                out.extend(h.lines.iter().cloned());
            }
        }
    }
    format!("{}\n", out.join("\n"))
}

/// Runs the engine on the durability lane. `Err` is the engine's own message.
pub(super) async fn run_engine(
    ctx: &ToolContext,
    base: &AbsPath,
    patch: String,
    fuzz: usize,
    reject_partial: bool,
    dry: bool,
) -> Result<Result<ApplyStats, String>, ToolError> {
    let base = base.as_path().to_path_buf();
    let opts = ApplyOptions { fuzz_factor: fuzz, reject_partial };
    let job = ctx
        .io
        .durability
        .submit_wait(&ctx.cancel, move |_| apply_patch_to_base(&base, &patch, dry, &opts))
        .await
        .map_err(|_| cancelled())?;
    job.await.map_err(|_| cancelled())
}

// ---- failure context (Node `formatNativeFailureContext`) ----

fn strip_ab(name: &str) -> &str {
    let absolute = name.starts_with('/') || name.starts_with('\\') || name.as_bytes().get(1) == Some(&b':');
    if absolute {
        return name;
    }
    match name.strip_prefix("a/").or_else(|| name.strip_prefix("b/")) {
        Some(rest) if !rest.is_empty() => rest,
        _ => name,
    }
}

fn norm(path: &str) -> String {
    path.replace('\\', "/")
}

/// The path the engine's message names, as `extractNativeFailurePath` finds it.
pub(super) fn failure_path(message: &str, entries: &[NativeEntry]) -> String {
    let text = js_trim(message);
    if text.is_empty() {
        return String::new();
    }
    let mut candidates: Vec<String> = Vec::new();
    for e in entries {
        let header_name = format!("a/{}", e.header);
        let stripped = strip_ab(&header_name).to_owned();
        let display = norm(&stripped);
        for c in [header_name, stripped, display.clone(), format!("a/{display}"), format!("b/{display}")] {
            if !c.is_empty() && !candidates.contains(&c) {
                candidates.push(c);
            }
        }
    }
    candidates.sort_by_key(|c| std::cmp::Reverse(c.encode_utf16().count()));
    if let Some(c) = candidates.iter().find(|c| text.starts_with(&format!("{c}:"))) {
        return c.clone();
    }
    let lower = text.to_lowercase();
    let needle = "hunk rejected in ";
    let mut from = 0;
    while let Some(found) = lower[from..].find(needle) {
        let at = from + found;
        let word_before = text[..at].chars().next_back().is_some_and(|c| c.is_alphanumeric() || c == '_');
        if !word_before {
            let rest = &text[at + needle.len()..];
            let end = rest.char_indices().skip(1).find(|(i, _)| rest[*i..].starts_with(" (")).map_or(rest.len(), |(i, _)| i);
            let name = &rest[..end];
            if !name.is_empty() && !name.contains('\n') {
                return js_trim(name).to_owned();
            }
        }
        from = at + needle.len();
    }
    candidates.into_iter().find(|c| text.contains(c.as_str())).unwrap_or_default()
}

fn matches_entry(entry: &NativeEntry, failed: &str) -> bool {
    if failed.is_empty() {
        return true;
    }
    let failed = norm(strip_ab(failed));
    let display = norm(&entry.header);
    if failed.is_empty() || display.is_empty() {
        return false;
    }
    failed == display || display.ends_with(&format!("/{failed}")) || failed.ends_with(&format!("/{display}"))
}

/// `(tag, line)` of each old-side line of a hunk.
fn old_lines(hunk: &UHunk) -> Vec<(char, &str)> {
    hunk.lines.iter().filter_map(|l| l.chars().next().filter(|t| *t == ' ' || *t == '-').map(|t| (t, &l[1..]))).collect()
}

fn declared_start(hunk: &UHunk) -> usize {
    hunk.old_start.max(1) - 1
}

pub(super) fn first_meaningful(hunk: &UHunk) -> Option<(String, usize)> {
    old_lines(hunk).into_iter().find(|(_, l)| !js_trim(l).is_empty()).map(|(_, l)| (l.to_owned(), declared_start(hunk)))
}

fn trim_patch_ws(s: &str) -> &str {
    s.trim_matches([' ', '\t'])
}

fn line_eq(actual: &str, expected: &str) -> bool {
    actual == expected || trim_patch_ws(actual) == trim_patch_ws(expected)
}

pub(super) fn first_failing_detail(source: &[String], hunk: &UHunk) -> Option<(String, usize)> {
    let old = old_lines(hunk);
    if old.is_empty() {
        return None;
    }
    let depth_at = |start: usize| {
        let mut d = 0;
        while d < old.len() && start + d < source.len() && line_eq(&source[start + d], old[d].1) {
            d += 1;
        }
        d
    };
    let declared = declared_start(hunk);
    let mut candidates = Vec::new();
    if declared < source.len() {
        candidates.push(declared);
    }
    for (i, line) in source.iter().enumerate() {
        if candidates.len() >= 8 {
            break;
        }
        if i != declared && line_eq(line, old[0].1) {
            candidates.push(i);
        }
    }
    let mut best: Option<(usize, usize)> = None;
    for start in candidates {
        let depth = depth_at(start);
        if depth >= old.len() {
            continue;
        }
        if best.is_none_or(|(_, d)| depth > d) {
            best = Some((start, depth));
        }
    }
    let (start, depth) = best.filter(|(_, d)| *d > 0)?;
    Some((old[depth].1.to_owned(), start + depth))
}

/// First and last change position of a hunk's ops, in half-line units (`computeUnifiedChangeBand`).
fn change_band(hunk: &UHunk) -> (Option<usize>, Option<usize>) {
    let (mut first, mut last, mut cursor) = (None::<usize>, None::<usize>, 0usize);
    let mut mark = |pos: usize| {
        first = Some(first.map_or(pos, |f| f.min(pos)));
        last = Some(last.map_or(pos, |l| l.max(pos)));
    };
    for l in &hunk.lines {
        match l.chars().next() {
            Some(' ') => cursor += 1,
            Some('-') => {
                mark((cursor + 1) * 2);
                cursor += 1;
            }
            Some('+') => mark(cursor * 2 + 1),
            _ => {}
        }
    }
    (first, last)
}

/// Whether `old` matches `source` at `start` within `fuzz` drifted context lines; the fuzz and
/// typographic counts rank candidates.
fn old_lines_match_at(source: &Lines, old: &[(char, &str)], start: usize, fuzz: usize, band: (Option<usize>, Option<usize>)) -> Option<(usize, usize)> {
    if start + old.len() > source.text.len() {
        return None;
    }
    let (mut fuzz_used, mut norm_count) = (0, 0);
    let final_newline = source.terms.last().is_none_or(|t| !t.is_empty());
    let last = source.text.len().saturating_sub(1);
    for (offset, (tag, expected)) in old.iter().enumerate() {
        let idx = start + offset;
        let actual = source.text[idx].as_str();
        let actual_nl = !(idx == last && !final_newline);
        // The engine tolerates the file's missing final newline on the hunk's last old line.
        let newline_ok = actual_nl || (offset + 1 == old.len() && idx == last);
        if newline_ok {
            let kind = if actual == *expected {
                Some(0)
            } else if fuzz > 0 && (*tag == ' ' || *tag == '-') {
                if trim_patch_ws(actual) == trim_patch_ws(expected) {
                    Some(1)
                } else if normalize_typographic(actual) == normalize_typographic(expected) {
                    Some(2)
                } else {
                    None
                }
            } else {
                None
            };
            if let Some(k) = kind {
                if k == 2 {
                    norm_count += 1;
                }
                continue;
            }
        }
        if fuzz > 0 && *tag == ' ' {
            let pos = (offset + 1) * 2;
            let outer = match band {
                (Some(first), Some(last_pos)) => pos < first || pos > last_pos,
                _ => true,
            };
            if !outer {
                return None;
            }
            fuzz_used += 1;
            if fuzz_used <= fuzz {
                continue;
            }
        }
        return None;
    }
    Some((fuzz_used, norm_count))
}

/// Where the engine would place `hunk`: its declared line first, else the closest fuzz match at or
/// after `min_start`. Returns the match as `(start, end)`.
pub(super) fn find_hunk_match(source: &Lines, hunk: &UHunk, min_start: usize, fuzz: usize) -> Option<(usize, usize)> {
    let old = old_lines(hunk);
    let declared = declared_start(hunk);
    if old.is_empty() {
        let at = hunk.old_start.saturating_sub(1);
        return (at >= min_start && at <= source.text.len()).then_some((at, at));
    }
    let band = change_band(hunk);
    if declared >= min_start && old_lines_match_at(source, &old, declared, 0, band).is_some() {
        return Some((declared, declared + old.len()));
    }
    if fuzz == 0 || source.text.len() < old.len() {
        return None;
    }
    let mut best: Option<(usize, usize, usize, usize)> = None;
    for start in min_start..=source.text.len() - old.len() {
        let Some((fuzz_used, norm_count)) = old_lines_match_at(source, &old, start, fuzz, band) else { continue };
        let distance = start.abs_diff(declared);
        let better = best.is_none_or(|(_, d, f, n)| (fuzz_used, norm_count, distance) < (f, n, d));
        if better {
            best = Some((start, distance, fuzz_used, norm_count));
        }
    }
    best.map(|(start, ..)| (start, start + old.len()))
}

/// Node `formatNativeFailureContext`: what the engine expected and the closest current line.
pub(super) async fn failure_context(ctx: &ToolContext, entries: &[NativeEntry], failed: &str, fuzz: usize) -> String {
    let Some(entry) = entries.iter().find(|e| matches_entry(e, failed)).or_else(|| entries.first()) else { return String::new() };
    let display = norm(&entry.header);
    // Bounded like Node's `readBoundedFile` default: a binary or over-8-MiB target gets no hints.
    let source = match read_present(ctx, &entry.abs, SNAPSHOT_MAX_BYTES, true).await {
        Ok(Some(bytes)) => String::from_utf8(bytes).ok().map(|text| Lines::split(&text)),
        _ => None,
    };
    let failing = source.as_ref().and_then(|s| first_failing_hunk_of(entry, s, fuzz));
    let detail = failing.and_then(|h| source.as_ref().and_then(|s| first_failing_detail(&s.text, h)));
    let expected = detail
        .or_else(|| failing.and_then(first_meaningful))
        .or_else(|| entry.hunks.iter().find_map(first_meaningful));
    let Some((line, preferred)) = expected else { return String::new() };
    let expected_text = js_string(&compact_preview(&line, 140));
    let mut nearest = String::new();
    let mut normalize_hint = String::new();
    if let Some(s) = &source {
        if let Some(i) = nearest_line(&s.text, &line, preferred) {
            nearest = format!("nearest line {}: {}", i + 1, js_string(&compact_preview(&s.text[i], 140)));
        }
        let want = normalize_typographic(&line);
        if !want.is_empty() {
            for (i, src) in s.text.iter().enumerate() {
                if *src == line {
                    break;
                }
                if js_trim(src) != js_trim(&line) && normalize_typographic(src) == want {
                    normalize_hint = format!("context matches after Unicode normalization at line {} — source may contain typographic dashes/quotes/NBSP", i + 1);
                    break;
                }
            }
        }
    }
    let in_file = if display.is_empty() { String::new() } else { format!(" in {display}") };
    let nearest = if nearest.is_empty() { String::new() } else { format!("; {nearest}") };
    let normalize_hint = if normalize_hint.is_empty() { String::new() } else { format!("; {normalize_hint}") };
    format!(" expected first old/context line{in_file}: {expected_text}{nearest}{normalize_hint}; use exact current lines, no stubs.")
}

/// The first hunk of `entry` the engine cannot place against `source`.
fn first_failing_hunk_of<'a>(entry: &'a NativeEntry, source: &Lines, fuzz: usize) -> Option<&'a UHunk> {
    let mut min_start = 0;
    for hunk in &entry.hunks {
        match find_hunk_match(source, hunk, min_start, fuzz) {
            Some((_, end)) => min_start = min_start.max(end),
            None => return Some(hunk),
        }
    }
    None
}
// ---- routing (Node `wave.mjs`) ----

#[allow(clippy::disallowed_methods, reason = "runs only as a lane job body (uses_js_writer)")]
fn real_nearest_ancestor(path: &std::path::Path) -> std::path::PathBuf {
    let mut cur = path.to_path_buf();
    loop {
        if let Ok(real) = std::fs::canonicalize(&cur) {
            return real;
        }
        match cur.parent() {
            Some(parent) if parent != cur => cur = parent.to_path_buf(),
            _ => return cur,
        }
    }
}

/// `(outside the base once symlinks are resolved, leaf is a live symlink)`.
#[allow(clippy::disallowed_methods, reason = "runs only as a lane job body (uses_js_writer)")]
fn probe_route(base: &std::path::Path, full: &std::path::Path) -> (bool, bool) {
    let outside = super::patch_redirect::relative_inside(&real_nearest_ancestor(base), &real_nearest_ancestor(full)).is_none();
    let symlink = std::fs::symlink_metadata(full).is_ok_and(|m| m.file_type().is_symlink()) && std::fs::canonicalize(full).is_ok();
    (outside, symlink)
}

/// Whether Node hands this target to its own codec-preserving writer instead of the engine: a path
/// outside the base (symlinks resolved) or, for an update, a symlinked leaf. UTF-16 files are
/// decided by the caller, which has the bytes.
pub(super) async fn uses_js_writer(ctx: &ToolContext, base: &AbsPath, abs: &AbsPath, delete: bool) -> Result<bool, ToolError> {
    let (base, full) = (base.as_path().to_path_buf(), abs.as_path().to_path_buf());
    let job = ctx
        .io
        .interactive
        .submit(&ctx.cancel, move |_| probe_route(&base, &full))
        .map_err(|_| cancelled())?;
    let (outside, symlink) = job.await.map_err(|_| cancelled())?;
    Ok(outside || (symlink && !delete))
}
impl NativeEntry {
    /// An entry from a V4A section: headers written `a/<path>` and `b/<path>`.
    pub(super) fn v4a(delete: bool, header: String, abs: AbsPath, hunks: Vec<UHunk>, deleted_lines: Vec<String>) -> Self {
        Self { delete, old_name: format!("a/{header}"), new_name: format!("b/{header}"), header, abs, hunks, deleted_lines }
    }
}