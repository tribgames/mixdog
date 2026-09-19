// Exact-string edits: tiered normalisation, occurrence search and the
// invariant-safe replacement path.

use super::*;

pub(crate) fn apply_exact_bytes(
    source: &[u8],
    entry: &Entry,
    fuzz_factor: usize,
) -> Result<AppliedFile, String> {
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
    let mut out = Vec::with_capacity(
        source
            .len()
            .saturating_add(estimate_added_hunk_bytes(entry))
            .saturating_add(1024),
    );
    let mut hasher = Sha256::new();
    let mut line_scan = Scan { line: 0, pos: 0 };
    // (start_offset, was_insert_only) of the previously applied hunk. Two hunks
    // that resolve to the SAME start are only well defined when both are
    // zero-length insertions (they are emitted in source order below); an
    // insertion sharing a start with a replacement — or any overlap — would
    // silently truncate or reorder content, so it is refused. Overlaps proper
    // are already refused by the `start_offset < cursor` checks in the
    // matchers. This mirrors the JS dispatcher's assertSafeReplacementPlan.
    let mut last_applied: Option<(usize, bool)> = None;

    for hunk in &entry.hunks {
        let parts = parse_hunk_parts(hunk)?;
        let declared = apply_declared_hunk(source, hunk, &parts, cursor, &mut line_scan);
        let applied = match declared {
            Some(value) => value,
            None => {
                if fuzz_factor == 0 {
                    return Err(format!(
                        "hunk rejected in {} (exact-only, fuzz=0)",
                        entry.old_file
                    ));
                }
                apply_fuzzy_hunk(source, hunk, &parts, cursor, fuzz_factor)
                    .ok_or_else(|| format!("hunk rejected in {}", entry.old_file))?
            }
        };
        let applied = preserve_eof_newline_state(source, &parts, applied);
        let insert_only = applied.0 == applied.1;
        if let Some((prev_start, prev_insert_only)) = last_applied {
            if applied.0 == prev_start && !(prev_insert_only && insert_only) {
                return Err(format!(
                    "hunks resolve to the same position in {} (line {}) and at least one of them replaces existing lines; widen their context or split them into separate patches",
                    entry.old_file,
                    source[..applied.0].iter().filter(|&&b| b == b'\n').count() + 1
                ));
            }
        }
        last_applied = Some((applied.0, insert_only));
        push_hashed(&mut out, &mut hasher, &source[cursor..applied.0]);
        push_hashed(&mut out, &mut hasher, &applied.2);
        cursor = applied.1;
    }

    push_hashed(&mut out, &mut hasher, &source[cursor..]);
    let digest = hasher.finalize();
    Ok(AppliedFile {
        bytes: out,
        content_hash: hex_bytes(&digest),
    })
}

// ---- invariant-safe char-indexed edit (--edit) ----
//
// Folds here are invariant-safe ONLY: each tier maps text to the SAME text in a
// different encoding (curly vs straight quote; CRLF vs LF). Heuristic-risky
// folds (dash, Unicode space, case, fullwidth, rstrip, indent-shift) are
// deliberately excluded so a match can never anchor onto a genuinely different
// region. NFC/NFD is a later stage gated behind the unicode-normalization dep.

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

// A normalized view of `s`: one entry per normalized char, paired with the
// ORIGINAL byte span [start, end) that char covers, so a match in normalized
// space maps back to a byte-exact slice of the source.
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
                // Canonical (NFD) decomposition: every decomposed char inherits
                // the ORIGINAL source char's byte span, so a normalized match
                // maps back to whole original chars. NFC vs NFD is invariant-safe
                // (same text, different composition).
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

pub(crate) fn find_char_occurrences(
    hay: &[char],
    needle: &[char],
    replace_all: bool,
) -> Vec<usize> {
    let mut out = Vec::new();
    if needle.is_empty() || needle.len() > hay.len() {
        return out;
    }
    let mut i = 0usize;
    while i + needle.len() <= hay.len() {
        if hay[i..i + needle.len()] == *needle {
            out.push(i);
            if !replace_all && out.len() > 1 {
                return out;
            }
            i += needle.len();
        } else {
            i += 1;
        }
    }
    out
}

// Locate `old` in `source` through the invariant-safe tiers in order. Returns
// the matched tier and the byte spans to replace. Ambiguity within a tier
// (more than one match and not replace_all) is an error, mirroring the JS path.
// A match is safe only when it begins at the first decomposed unit of a source
// char and ends at the last unit of a source char. Without this an NFD needle
// could match starting in the middle of a decomposed source char and splice a
// byte span that cuts a character in half.
pub(crate) fn match_is_char_aligned(view: &NormView, m: usize, len: usize) -> bool {
    if len == 0 {
        return false;
    }
    let start_ok = m == 0 || view.spans[m].0 != view.spans[m - 1].0;
    let end_idx = m + len - 1;
    let end_ok =
        end_idx + 1 == view.chars.len() || view.spans[end_idx].1 != view.spans[end_idx + 1].1;
    start_ok && end_ok
}

// Count occurrences allowing OVERLAP (advance by 1), aligned to char
// boundaries. Used only for the ambiguity decision so native matches the JS
// editor, which treats an overlapping second hit (e.g. "aa" in "aaa") as a
// collision rather than a single match.
pub(crate) fn count_aligned_overlapping(view: &NormView, needle: &[char]) -> usize {
    if needle.is_empty() || needle.len() > view.chars.len() {
        return 0;
    }
    let mut n = 0usize;
    let mut i = 0usize;
    while i + needle.len() <= view.chars.len() {
        if view.chars[i..i + needle.len()] == *needle
            && match_is_char_aligned(view, i, needle.len())
        {
            n += 1;
        }
        i += 1;
    }
    n
}

pub(crate) fn locate_invariant_safe_spans(
    source: &str,
    old: &str,
    replace_all: bool,
) -> Result<(EditTier, Vec<(usize, usize)>), String> {
    for tier in [
        EditTier::Exact,
        EditTier::Curly,
        EditTier::Nfc,
        EditTier::Crlf,
    ] {
        let view = build_norm_view(source, tier);
        let needle = norm_chars(old, tier);
        if needle.is_empty() {
            continue;
        }
        // Collect ALL occurrences, then keep only those aligned to original
        // character boundaries. Ambiguity is judged on aligned matches only.
        let matches: Vec<usize> = find_char_occurrences(&view.chars, &needle, true)
            .into_iter()
            .filter(|&m| match_is_char_aligned(&view, m, needle.len()))
            .collect();
        if matches.is_empty() {
            continue;
        }
        if !replace_all {
            // Overlap-aware ambiguity (matches the JS editor): a second match
            // starting one char later still counts as a collision.
            let overlap = count_aligned_overlapping(&view, &needle);
            if overlap > 1 {
                return Err(format!(
                    "old_string found {overlap} times; add surrounding lines to make it unique, or set replace_all to true to change every occurrence"
                ));
            }
        }
        let chosen: &[usize] = if replace_all { &matches } else { &matches[..1] };
        let spans = chosen
            .iter()
            .map(|&m| (view.spans[m].0, view.spans[m + needle.len() - 1].1))
            .collect();
        return Ok((tier, spans));
    }
    Err(format!(
        "old_string not found{}",
        nearest_line_hint(source, old)
    ))
}

/// Recovery hint for a failed match: locate the first file line containing the
/// longest token from old_string's first line, so the model can re-anchor
/// without a full re-read (whitespace drift is the usual culprit).
pub(crate) fn nearest_line_hint(source: &str, old: &str) -> String {
    let keyword = old
        .lines()
        .find(|line| !line.trim().is_empty())
        .and_then(|line| line.split_whitespace().max_by_key(|token| token.len()))
        .unwrap_or("");
    if keyword.chars().count() < 4 {
        return String::new();
    }
    for (index, line) in source.lines().enumerate() {
        if line.contains(keyword) {
            let trimmed = line.trim();
            let content: String = trimmed.chars().take(120).collect();
            let ellipsis = if trimmed.chars().count() > 120 {
                "…"
            } else {
                ""
            };
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
    let old =
        std::str::from_utf8(old_bytes).map_err(|_| "old_string is not valid UTF-8".to_string())?;
    if old.is_empty() {
        return Err("old_string is empty".to_string());
    }
    let total_start = Instant::now();
    let t = Instant::now();
    let metadata = fs::metadata(path).map_err(|e| format!("stat {}: {e}", path.display()))?;
    let snapshot = snapshot_from_metadata(&metadata);
    let source_bytes = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let read_ms = t.elapsed().as_secs_f64() * 1000.0;

    let source = std::str::from_utf8(&source_bytes)
        .map_err(|_| "source file is not valid UTF-8".to_string())?;

    let t = Instant::now();
    let (tier, mut spans) = locate_invariant_safe_spans(source, old, replace_all)?;
    if spans.is_empty() {
        return Err(format!(
            "old_string not found{}",
            nearest_line_hint(source, old)
        ));
    }

    // No size gate on fold-tier matches: every tier in
    // locate_invariant_safe_spans is invariant-safe (same text, different
    // encoding), so a large curly/NFC/CRLF match cannot anchor onto a
    // different region, and ambiguous matches are already rejected above.

    // Pure-deletion newline absorption (JS parity): when new is empty and old
    // does not already end in a line terminator, extend each span over its own
    // trailing CRLF / LF / CR so the deleted line leaves no blank residue.
    if new_bytes.is_empty() && !old.ends_with('\n') && !old.ends_with('\r') {
        for span in spans.iter_mut() {
            let e = span.1;
            if source_bytes.get(e) == Some(&b'\r') && source_bytes.get(e + 1) == Some(&b'\n') {
                span.1 = e + 2;
            } else if source_bytes.get(e) == Some(&b'\n') || source_bytes.get(e) == Some(&b'\r') {
                span.1 = e + 1;
            }
        }
    }

    let mut out = Vec::with_capacity(source_bytes.len());
    let mut hasher = Sha256::new();
    let mut cursor = 0usize;
    for &(start, end) in &spans {
        push_hashed(&mut out, &mut hasher, &source_bytes[cursor..start]);
        // EOL preservation (JS parity): match the replacement's line endings to
        // the slice it replaces so a CRLF file is not silently degraded to LF.
        let new_eol = preserve_eol(new_bytes, &source_bytes[start..end], &source_bytes);
        push_hashed(&mut out, &mut hasher, &new_eol);
        cursor = end;
    }
    push_hashed(&mut out, &mut hasher, &source_bytes[cursor..]);
    let content_hash = hex_bytes(&hasher.finalize());
    let apply_ms = t.elapsed().as_secs_f64() * 1000.0;

    let mut write_ms = 0.0f64;
    if !dry_run {
        let t = Instant::now();
        snapshot_matches(path, &snapshot)?;
        atomic_write_replace(path, &out)?;
        write_ms = t.elapsed().as_secs_f64() * 1000.0;
    }
    Ok((
        ExactEditStats {
            replacements: spans.len(),
            read_ms,
            apply_ms,
            write_ms,
            total_ms: total_start.elapsed().as_secs_f64() * 1000.0,
            content_hash,
        },
        tier,
    ))
}

// Mirror replacementForOriginalSlice (edit-match-utils.mjs): adjust the new
// text's line endings to match the original slice being replaced, with the
// mixed-EOL guard so we never synthesise CRLF where the file uses bare LF.
pub(crate) fn preserve_eol(new_bytes: &[u8], slice: &[u8], file: &[u8]) -> Vec<u8> {
    let new_str = match std::str::from_utf8(new_bytes) {
        Ok(s) => s,
        Err(_) => return new_bytes.to_vec(),
    };
    let slice_str = String::from_utf8_lossy(slice);
    let has_crlf = slice_str.contains("\r\n");
    let has_lf = slice_str.contains('\n');
    if !has_crlf && !has_lf {
        if file.contains(&b'\r') && !file.contains(&b'\n') {
            return new_str
                .replace("\r\n", "\n")
                .replace('\n', "\r")
                .into_bytes();
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
        return new_str
            .replace("\r\n", "\n")
            .replace('\n', "\r\n")
            .into_bytes();
    }
    let lf_replacement = new_str.replace("\r\n", "\n");
    let mut result = if has_crlf {
        lf_replacement.replace('\n', "\r\n")
    } else {
        lf_replacement
    };
    if slice_str.ends_with('\r') && !result.ends_with('\r') && !result.ends_with('\n') {
        result.push('\r');
    }
    result.into_bytes()
}
