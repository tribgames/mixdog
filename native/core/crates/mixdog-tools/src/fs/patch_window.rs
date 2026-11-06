//! The fuzzy window-matching tiers of the V4A locator: Node's `v4a-windows.mjs` plus the
//! escape-equivalence scan of `matcher.mjs`. Each tier keeps its uniqueness guard, so a rescue can
//! never mis-anchor; callers try them cheapest first and only while a hunk is still unlocated.

use mixdog_js::js_trim;
use mixdog_js::js_words;
use mixdog_js::utf16_len;

use super::hints::longest_common_substring;
use super::patch_hunk::Hunk;
use super::patch_hunk::Stats;
use super::patch_hunk::exact_starts;
use super::patch_hunk::is_eof_marker;
use super::patch_hunk::stats;
use super::patch_hunk::unique_exact_start;

/// Total character drift the edit-distance tier tolerates per context line: 3 lines buy exactly
/// one character, so it rescues a typo, never a different block.
const EDIT_DISTANCE_ALLOWANCE_PER_LINE: f64 = 0.34;

/// A window a tier rebuilt: where the old side sits and the old/new lines to splice.
pub(super) struct Restored {
    pub start: usize,
    pub old: Vec<String>,
    pub new: Vec<String>,
}

fn collapse(s: &str) -> String {
    js_words(s).collect::<Vec<_>>().join(" ")
}

/// Levenshtein distance over UTF-16 units: exact while it stays within `max`, otherwise `max + 1`
/// as soon as that is certain.
fn bounded_edit_distance(a: &str, b: &str, max: i64) -> i64 {
    if a == b {
        return 0;
    }
    if max <= 0 {
        return 1;
    }
    let (s, t): (Vec<u16>, Vec<u16>) = (a.encode_utf16().collect(), b.encode_utf16().collect());
    if (s.len() as i64 - t.len() as i64).abs() > max {
        return max + 1;
    }
    let mut prev: Vec<i64> = (0..=t.len() as i64).collect();
    let mut curr = vec![0i64; t.len() + 1];
    for (i, cs) in s.iter().enumerate() {
        curr[0] = i as i64 + 1;
        let mut row_min = curr[0];
        for (j, ct) in t.iter().enumerate() {
            let cost = i64::from(cs != ct);
            let value = (prev[j + 1] + 1).min(curr[j] + 1).min(prev[j] + cost);
            curr[j + 1] = value;
            row_min = row_min.min(value);
        }
        if row_min > max {
            return max + 1;
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    let last = prev[t.len()];
    if last > max { max + 1 } else { last }
}

/// Context-tolerance tier: one to two drifted context lines. Every `-` line must match verbatim,
/// only ` ` lines may mismatch (at most 2, each still sharing half its text), at least two
/// non-blank lines must match exactly, and the window must be the only one in the file.
pub(super) fn context_tolerant_window(source: &[String], old: &[String], tags: &[char]) -> Option<usize> {
    let n = old.len();
    if n < 3 || tags.len() != n {
        return None;
    }
    let similar = |a: &str, b: &str| {
        let (ca, cb) = (collapse(a), collapse(b));
        if ca.is_empty() || cb.is_empty() {
            return false;
        }
        let longest = utf16_len(&ca).max(utf16_len(&cb));
        longest_common_substring(&ca, &cb) >= 4.max(longest.div_ceil(2))
    };
    let mut windows = Vec::new();
    let mut i = 0;
    while i + n <= source.len() && windows.len() < 2 {
        let (mut mismatches, mut exact_non_blank, mut ok) = (0, 0, true);
        for k in 0..n {
            let (pat, src) = (&old[k], &source[i + k]);
            if src == pat {
                if !collapse(pat).is_empty() {
                    exact_non_blank += 1;
                }
                continue;
            }
            mismatches += 1;
            if tags[k] != ' ' || mismatches > 2 || !similar(pat, src) {
                ok = false;
                break;
            }
        }
        if ok && mismatches > 0 && exact_non_blank >= 2 {
            windows.push(i);
        }
        i += 1;
    }
    (windows.len() == 1).then(|| windows[0])
}

/// Edit-distance tier: a block retyped with a character or two off. Total distance stays within
/// 0.34 per line on trimmed text, two non-blank lines must match exactly, and the window must be
/// unique in the file.
pub(super) fn edit_distance_window(source: &[String], old: &[String]) -> Option<usize> {
    let n = old.len();
    let max_distance = (n as f64 * EDIT_DISTANCE_ALLOWANCE_PER_LINE).floor() as i64;
    if n < 3 || max_distance <= 0 {
        return None;
    }
    let mut windows = Vec::new();
    let mut i = 0;
    while i + n <= source.len() && windows.len() < 2 {
        let (mut total, mut exact, mut ok) = (0i64, 0, true);
        for k in 0..n {
            let (pat, src) = (&old[k], &source[i + k]);
            if src == pat {
                if !js_trim(pat).is_empty() {
                    exact += 1;
                }
                continue;
            }
            total += bounded_edit_distance(js_trim(src), js_trim(pat), max_distance - total);
            if total > max_distance {
                ok = false;
                break;
            }
        }
        if ok && total > 0 && exact >= 2 {
            windows.push(i);
        }
        i += 1;
    }
    (windows.len() == 1).then(|| windows[0])
}

/// Outer-trim tier: a stray or retyped line of surrounding context around current deletion lines.
/// Trims only contiguous outer ` ` lines, smallest trim first, and accepts the shortened block only
/// when it matches verbatim at exactly one place in the whole file.
pub(super) fn outer_context_trimmed_window(source: &[String], hunk: &Hunk, s: &Stats) -> Option<Restored> {
    let body: Vec<&String> = hunk
        .lines
        .iter()
        .filter(|l| !l.is_empty() && !is_eof_marker(l) && matches!(l.as_bytes()[0], b' ' | b'-' | b'+'))
        .collect();
    if !body.iter().any(|l| l.starts_with('-')) {
        return None;
    }
    let leading_available = body.iter().take_while(|l| l.starts_with(' ')).count();
    let trailing_available = body[leading_available..].iter().rev().take_while(|l| l.starts_with(' ')).count();
    if leading_available == 0 && trailing_available == 0 {
        return None;
    }
    for total_trimmed in 1..=leading_available + trailing_available {
        let mut plans: Vec<Restored> = Vec::new();
        let mut ambiguous = false;
        for leading in 0..=total_trimmed.min(leading_available) {
            let trailing = total_trimmed - leading;
            if trailing > trailing_available {
                continue;
            }
            if !body[leading..body.len() - trailing].iter().any(|l| l.starts_with('-')) {
                continue;
            }
            let old = s.old_lines[leading..s.old_lines.len() - trailing].to_vec();
            let new = s.new_lines[leading..s.new_lines.len() - trailing].to_vec();
            if old.is_empty() {
                continue;
            }
            let starts = exact_starts(source, &old, 2);
            if starts.len() > 1 {
                ambiguous = true;
            } else if starts.len() == 1 {
                plans.push(Restored { start: starts[0], old, new });
            }
        }
        if ambiguous || plans.len() > 1 {
            return None;
        }
        if let Some(plan) = plans.pop() {
            return Some(plan);
        }
    }
    None
}

/// A leading `-` or `+` on a file line was eaten as the hunk opcode (`- Plan` parsed as a delete of
/// ` Plan`). Restores it when the dashed form is the one window; a mixed hunk keeps that line as
/// context, a delete-only hunk still deletes the dashed file line.
pub(super) fn restore_opcode_prefix_window(source: &[String], hunk: &Hunk) -> Option<Restored> {
    let s = stats(hunk);
    let old = &s.old_lines;
    if old.is_empty() {
        return None;
    }
    let starts: Vec<usize> = (0..)
        .take_while(|i| i + old.len() <= source.len())
        .filter(|i| {
            old.iter().enumerate().all(|(k, pat)| {
                let src = &source[i + k];
                src == pat || src.strip_prefix('-') == Some(pat) || src.strip_prefix('+') == Some(pat)
            })
        })
        .collect();
    if starts.len() != 1 {
        return None;
    }
    let start = starts[0];
    let restored_old: Vec<String> = (0..old.len()).map(|k| source[start + k].clone()).collect();
    if !restored_old.iter().zip(old).any(|(src, pat)| src != pat) {
        return None;
    }
    let had_plus = hunk.lines.iter().any(|l| l.starts_with('+'));
    let mut restored_new = Vec::new();
    let mut old_idx = 0;
    for raw in &hunk.lines {
        let Some(tag) = raw.chars().next() else { continue };
        let body = &raw[tag.len_utf8()..];
        match tag {
            ' ' => {
                restored_new.push(restored_old[old_idx].clone());
                old_idx += 1;
            }
            '-' => {
                let restored = &restored_old[old_idx];
                if had_plus && restored != body {
                    restored_new.push(restored.clone());
                }
                old_idx += 1;
            }
            '+' => restored_new.push(body.to_owned()),
            _ => {}
        }
    }
    Some(Restored { start, old: restored_old, new: restored_new })
}

/// A `+` line was eaten as an addition (`+ TODO`) when the file line itself is `+ TODO`: peels those
/// pluses into the unique old window so they stay context instead of a duplicate insert.
pub(super) fn restore_plus_as_context(source: &[String], hunk: &Hunk) -> Option<Restored> {
    if stats(hunk).old_count == 0 {
        return None;
    }
    let (mut old, mut new, mut peeled) = (Vec::new(), Vec::new(), 0);
    for raw in hunk.lines.iter().filter(|l| !l.is_empty() && !is_eof_marker(l)) {
        let Some(tag) = raw.chars().next() else { continue };
        let rest = &raw[tag.len_utf8()..];
        match tag {
            ' ' => {
                old.push(rest.to_owned());
                new.push(rest.to_owned());
            }
            '-' => old.push(rest.to_owned()),
            '+' => {
                let as_file = format!("+{rest}");
                if source.contains(&as_file) {
                    old.push(as_file.clone());
                    new.push(as_file);
                    peeled += 1;
                } else {
                    new.push(rest.to_owned());
                }
            }
            _ => {}
        }
    }
    if peeled == 0 || old.is_empty() {
        return None;
    }
    let start = unique_exact_start(source, &old)?;
    Some(Restored { start, old, new })
}

/// The peeled-`+` window may only refine an already located match, never relocate it: containment
/// is half-open, so a window starting one past the match is a different place.
pub(super) fn plus_window_covers_match(window_start: usize, window_len: usize, located: Option<usize>) -> bool {
    located.is_none_or(|at| at >= window_start && at < window_start + window_len)
}

/// Non-ASCII UTF-16 units as the file's literal `\uXXXX` escapes.
fn escape_non_ascii(line: &str) -> String {
    let mut out = String::new();
    for unit in line.encode_utf16() {
        if unit > 0x7f {
            out.push_str(&format!("\\u{unit:04x}"));
        } else {
            out.push(char::from(unit as u8));
        }
    }
    out
}

/// Escape-equivalence tier: a window where each old line matches verbatim or as the file's literal
/// `\uXXXX` escape of the patch's real character, and at least one line needed the escape. Only a
/// single such window counts.
pub(super) fn escape_equiv_start(source: &[String], pattern: &[String], min_start: usize) -> Option<usize> {
    if pattern.is_empty() {
        return None;
    }
    let mut starts = Vec::new();
    let mut i = min_start;
    while i + pattern.len() <= source.len() {
        let mut used_equiv = false;
        let ok = pattern.iter().enumerate().all(|(k, pat)| {
            let src = &source[i + k];
            if src == pat {
                return true;
            }
            if *src == escape_non_ascii(pat) {
                used_equiv = true;
                return true;
            }
            false
        });
        if ok && used_equiv {
            starts.push(i);
        }
        i += 1;
    }
    (starts.len() == 1).then(|| starts[0])
}