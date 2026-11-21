// Exact-string edits: tiered normalisation, occurrence search and the
// invariant-safe replacement path.

use super::*;

pub(crate) fn apply_exact_bytes(source: &[u8], entry: &Entry, fuzz_factor: usize) -> Result<AppliedFile, String> {
    // A UTF-8 BOM is a FILE PREFIX, not line content (JS-route parity): the
    // first line must match as `alpha`, not `<BOM>alpha`, and an insertion at
    // the top must land AFTER the prefix. Peel it, apply, put it back.
    if source.starts_with(UTF8_BOM) {
        let mut applied = apply_exact_bytes(&source[UTF8_BOM.len()..], entry, fuzz_factor)?;
        let mut bytes = UTF8_BOM.to_vec();
        bytes.extend_from_slice(&applied.bytes);
        applied.content_hash = sha256_hex(&bytes);
        applied.bytes = bytes;
        return Ok(applied);
    }
    if entry.hunks.is_empty() {
        return Err(format!("{} has no hunks", entry.old_file));
    }
    let mut cursor = 0usize;
    let mut out = Vec::with_capacity(source.len().saturating_add(estimate_added_hunk_bytes(entry)).saturating_add(1024));
    let mut hasher = Sha256::new();
    let mut line_scan = Scan { line: 0, pos: 0 };
    let mut last_applied: Option<(usize, bool)> = None;

    for hunk in &entry.hunks {
        let applied = place_hunk(source, hunk, cursor, &mut line_scan, fuzz_factor, &entry.old_file)?;
        let insert_only = applied.0 == applied.1;
        ensure_distinct_start(source, applied.0, insert_only, last_applied, &entry.old_file)?;
        last_applied = Some((applied.0, insert_only));
        push_hashed(&mut out, &mut hasher, &source[cursor..applied.0]);
        push_hashed(&mut out, &mut hasher, &applied.2);
        cursor = applied.1;
    }

    push_hashed(&mut out, &mut hasher, &source[cursor..]);
    let digest = hasher.finalize();
    Ok(AppliedFile { bytes: out, content_hash: hex_bytes(&digest) })
}

fn place_hunk(source: &[u8], hunk: &Hunk, cursor: usize, scan: &mut Scan, fuzz_factor: usize, old_file: &str) -> Result<(usize, usize, Vec<u8>), String> {
    let parts = parse_hunk_parts(hunk)?;
    let placed = match apply_declared_hunk(source, hunk, &parts, cursor, scan) {
        Some(value) => value,
        None if fuzz_factor == 0 => return Err(format!("hunk rejected in {old_file} (exact-only, fuzz=0)")),
        None => apply_fuzzy_hunk(source, hunk, &parts, cursor, fuzz_factor).ok_or_else(|| format!("hunk rejected in {old_file}"))?,
    };
    Ok(preserve_eof_newline_state(source, &parts, placed))
}

fn ensure_distinct_start(source: &[u8], start: usize, insert_only: bool, previous: Option<(usize, bool)>, old_file: &str) -> Result<(), String> {
    match previous {
        Some((prev_start, prev_insert_only)) if start == prev_start && !(prev_insert_only && insert_only) => Err(format!(
            "hunks resolve to the same position in {old_file} (line {}) and at least one of them replaces existing lines; widen their context or split them into separate patches",
            source[..start].iter().filter(|&&b| b == b'\n').count() + 1
        )),
        _ => Ok(()),
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum EditTier {
    Exact,
    Curly,
    Nfc,
    Crlf,
}

impl EditTier {
    pub(crate) fn label(self) -> &'static str {
        match self {
            EditTier::Exact => "exact",
            EditTier::Curly => "curly",
            EditTier::Nfc => "nfc",
            EditTier::Crlf => "crlf",
        }
    }
}

pub(crate) fn fold_char_curly(c: char) -> char {
    match c {
        '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
        '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => '"',
        other => other,
    }
}

pub(crate) struct NormView {
    pub(crate) chars: Vec<char>,
    pub(crate) spans: Vec<(usize, usize)>,
}

pub(crate) fn build_norm_view(s: &str, tier: EditTier) -> NormView {
    let mut chars = Vec::new();
    let mut spans = Vec::new();
    let mut it = s.char_indices().peekable();
    while let Some((i, c)) = it.next() {
        match tier {
            EditTier::Exact => {
                chars.push(c);
                spans.push((i, i + c.len_utf8()));
            }
            EditTier::Curly => {
                chars.push(fold_char_curly(c));
                spans.push((i, i + c.len_utf8()));
            }
            EditTier::Nfc => {
                use unicode_normalization::char::decompose_canonical;
                let span = (i, i + c.len_utf8());
                decompose_canonical(c, |d| {
                    chars.push(d);
                    spans.push(span);
                });
            }
            EditTier::Crlf => {
                if c == '\r' {
                    if let Some(&(j, '\n')) = it.peek() {
                        it.next();
                        chars.push('\n');
                        spans.push((i, j + 1));
                        continue;
                    }
                }
                chars.push(c);
                spans.push((i, i + c.len_utf8()));
            }
        }
    }
    NormView { chars, spans }
}

pub(crate) fn norm_chars(s: &str, tier: EditTier) -> Vec<char> {
    build_norm_view(s, tier).chars
}

/// Every non-overlapping occurrence of `needle` in `hay`, left to right.
pub(crate) fn find_char_occurrences(hay: &[char], needle: &[char]) -> Vec<usize> {
    let mut out = Vec::new();
    if needle.is_empty() || needle.len() > hay.len() {
        return out;
    }
    let mut i = 0usize;
    while i + needle.len() <= hay.len() {
        if hay[i..i + needle.len()] == *needle {
            out.push(i);
            i += needle.len();
        } else {
            i += 1;
        }
    }
    out
}

pub(crate) fn match_is_char_aligned(view: &NormView, m: usize, len: usize) -> bool {
    if len == 0 {
        return false;
    }
    let start_ok = m == 0 || view.spans[m].0 != view.spans[m - 1].0;
    let end_idx = m + len - 1;
    let end_ok = end_idx + 1 == view.chars.len() || view.spans[end_idx].1 != view.spans[end_idx + 1].1;
    start_ok && end_ok
}

/// Overlapping hits count (the JS editor treats "aa" in "aaa" as ambiguous).
pub(crate) fn count_aligned_overlapping(view: &NormView, needle: &[char]) -> usize {
    if needle.is_empty() || needle.len() > view.chars.len() {
        return 0;
    }
    let mut n = 0usize;
    let mut i = 0usize;
    while i + needle.len() <= view.chars.len() {
        if view.chars[i..i + needle.len()] == *needle && match_is_char_aligned(view, i, needle.len()) {
            n += 1;
        }
        i += 1;
    }
    n
}

pub(crate) fn locate_invariant_safe_spans(source: &str, old: &str, replace_all: bool) -> Result<(EditTier, Vec<(usize, usize)>), String> {
    for tier in [EditTier::Exact, EditTier::Curly, EditTier::Nfc, EditTier::Crlf] {
        let view = build_norm_view(source, tier);
        let needle = norm_chars(old, tier);
        if needle.is_empty() {
            continue;
        }
        let matches: Vec<usize> = find_char_occurrences(&view.chars, &needle).into_iter().filter(|&m| match_is_char_aligned(&view, m, needle.len())).collect();
        if matches.is_empty() {
            continue;
        }
        if !replace_all {
            let overlap = count_aligned_overlapping(&view, &needle);
            if overlap > 1 {
                return Err(format!(
                    "old_string found {overlap} times; add surrounding lines to make it unique, or set replace_all to true to change every occurrence"
                ));
            }
        }
        let chosen: &[usize] = if replace_all { &matches } else { &matches[..1] };
        let spans = chosen.iter().map(|&m| (view.spans[m].0, view.spans[m + needle.len() - 1].1)).collect();
        return Ok((tier, spans));
    }
    Err(format!("old_string not found{}", nearest_line_hint(source, old)))
}

pub(crate) fn nearest_line_hint(source: &str, old: &str) -> String {
    let keyword = old.lines().find(|line| !line.trim().is_empty()).and_then(|line| line.split_whitespace().max_by_key(|token| token.len())).unwrap_or("");
    if keyword.chars().count() < 4 {
        return String::new();
    }
    for (index, line) in source.lines().enumerate() {
        if line.contains(keyword) {
            let trimmed = line.trim();
            let content: String = trimmed.chars().take(120).collect();
            let ellipsis = if trimmed.chars().count() > 120 { "…" } else { "" };
            return format!("; nearest match on line {}: {content}{ellipsis}", index + 1);
        }
    }
    String::new()
}

pub(crate) fn apply_invariant_safe_edit_to_path(
    path: &Path,
    old_bytes: &[u8],
    new_bytes: &[u8],
    replace_all: bool,
    dry_run: bool,
) -> Result<(ExactEditStats, EditTier), String> {
    let old = std::str::from_utf8(old_bytes).map_err(|_| "old_string is not valid UTF-8".to_string())?;
    if old.is_empty() {
        return Err("old_string is empty".to_string());
    }
    let total_start = Instant::now();
    let t = Instant::now();
    let metadata = fs::metadata(path).map_err(|e| format!("stat {}: {e}", path.display()))?;
    let snapshot = snapshot_from_metadata(&metadata);
    let source_bytes = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let read_ms = t.elapsed().as_secs_f64() * 1000.0;

    let source = std::str::from_utf8(&source_bytes).map_err(|_| "source file is not valid UTF-8".to_string())?;

    let t = Instant::now();
    let (tier, mut spans) = locate_invariant_safe_spans(source, old, replace_all)?;
    if new_bytes.is_empty() && !old.ends_with('\n') && !old.ends_with('\r') {
        absorb_trailing_eol(&mut spans, &source_bytes);
    }
    let (out, content_hash) = splice_spans(&source_bytes, &spans, new_bytes);
    let apply_ms = t.elapsed().as_secs_f64() * 1000.0;

    let mut write_ms = 0.0f64;
    if !dry_run {
        let t = Instant::now();
        snapshot_matches(path, &snapshot)?;
        atomic_write_replace(path, &out)?;
        write_ms = t.elapsed().as_secs_f64() * 1000.0;
    }
    Ok((ExactEditStats { replacements: spans.len(), read_ms, apply_ms, write_ms, total_ms: total_start.elapsed().as_secs_f64() * 1000.0, content_hash }, tier))
}

fn absorb_trailing_eol(spans: &mut [(usize, usize)], source: &[u8]) {
    for span in spans.iter_mut() {
        let e = span.1;
        if source.get(e) == Some(&b'\r') && source.get(e + 1) == Some(&b'\n') {
            span.1 = e + 2;
        } else if source.get(e) == Some(&b'\n') || source.get(e) == Some(&b'\r') {
            span.1 = e + 1;
        }
    }
}

fn splice_spans(source: &[u8], spans: &[(usize, usize)], new_bytes: &[u8]) -> (Vec<u8>, String) {
    let mut out = Vec::with_capacity(source.len());
    let mut hasher = Sha256::new();
    let mut cursor = 0usize;
    for &(start, end) in spans {
        push_hashed(&mut out, &mut hasher, &source[cursor..start]);
        push_hashed(&mut out, &mut hasher, &preserve_eol(new_bytes, &source[start..end], source));
        cursor = end;
    }
    push_hashed(&mut out, &mut hasher, &source[cursor..]);
    (out, hex_bytes(&hasher.finalize()))
}

/// Mirrors replacementForOriginalSlice (edit-match-utils.mjs): never synthesises CRLF where the file uses bare LF.
pub(crate) fn preserve_eol(new_bytes: &[u8], slice: &[u8], file: &[u8]) -> Vec<u8> {
    let new_str = match std::str::from_utf8(new_bytes) {
        Ok(s) => s,
        Err(_) => return new_bytes.to_vec(),
    };
    let slice_str = String::from_utf8_lossy(slice);
    let has_crlf = slice_str.contains("\r\n");
    let has_lf = slice_str.contains('\n');
    if !has_crlf && !has_lf {
        if source_uses_cr_only(file) {
            return new_str.replace("\r\n", "\n").replace('\n', "\r").into_bytes();
        }
        // Single-line slice: only upgrade LF->CRLF when the WHOLE file is pure
        // CRLF (no bare LF); otherwise leave new untouched to avoid mixed-EOL.
        if !file.windows(2).any(|w| w == b"\r\n") {
            return new_bytes.to_vec();
        }
        for i in 0..file.len() {
            if file[i] == b'\n' && (i == 0 || file[i - 1] != b'\r') {
                return new_bytes.to_vec();
            }
        }
        return new_str.replace("\r\n", "\n").replace('\n', "\r\n").into_bytes();
    }
    let lf_replacement = new_str.replace("\r\n", "\n");
    let mut result = if has_crlf { lf_replacement.replace('\n', "\r\n") } else { lf_replacement };
    if slice_str.ends_with('\r') && !result.ends_with('\r') && !result.ends_with('\n') {
        result.push('\r');
    }
    result.into_bytes()
}
