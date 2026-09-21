// Hunk application: parsing hunk bodies, declared and fuzzy placement,
// line/EOL bookkeeping over the source bytes.

use super::*;

pub(crate) fn estimate_added_hunk_bytes(entry: &Entry) -> usize {
    let mut bytes = 0usize;
    for hunk in &entry.hunks {
        for line in &hunk.lines {
            if line.as_bytes().first() == Some(&b'+') {
                bytes = bytes
                    .saturating_add(line.len().saturating_sub(1))
                    .saturating_add(2);
            }
        }
    }
    bytes
}

pub(crate) fn parse_hunk_parts(hunk: &Hunk) -> Result<HunkParts, String> {
    let mut old: Vec<HunkLine> = Vec::new();
    let mut new: Vec<HunkLine> = Vec::new();
    let mut ops: Vec<HunkOp> = Vec::new();
    let mut last_op: Option<usize> = None;
    let mut last_old: Option<usize> = None;
    let mut last_new: Option<usize> = None;

    for raw in &hunk.lines {
        if raw.starts_with('\\') {
            let Some(idx) = last_op else {
                return Err("no-newline marker without previous hunk line".to_string());
            };
            match ops[idx].tag {
                HunkTag::Context => {
                    ops[idx].new_has_newline = false;
                    if let Some(i) = last_old {
                        old[i].has_newline = false;
                    }
                    if let Some(i) = last_new {
                        new[i].has_newline = false;
                    }
                }
                HunkTag::Delete => {
                    if let Some(i) = last_old {
                        old[i].has_newline = false;
                    }
                }
                HunkTag::Add => {
                    ops[idx].new_has_newline = false;
                    if let Some(i) = last_new {
                        new[i].has_newline = false;
                    }
                }
            }
            continue;
        }
        if raw.is_empty() {
            return Err("malformed empty hunk line".to_string());
        }
        let tag = raw.as_bytes()[0];
        let body = raw.as_bytes()[1..].to_vec();
        match tag {
            b' ' => {
                old.push(HunkLine {
                    tag: HunkTag::Context,
                    body: body.clone(),
                    has_newline: true,
                });
                new.push(HunkLine {
                    tag: HunkTag::Context,
                    body: body.clone(),
                    has_newline: true,
                });
                ops.push(HunkOp {
                    tag: HunkTag::Context,
                    body,
                    new_has_newline: true,
                });
                last_old = Some(old.len() - 1);
                last_new = Some(new.len() - 1);
                last_op = Some(ops.len() - 1);
            }
            b'-' => {
                old.push(HunkLine {
                    tag: HunkTag::Delete,
                    body: body.clone(),
                    has_newline: true,
                });
                ops.push(HunkOp {
                    tag: HunkTag::Delete,
                    body,
                    new_has_newline: true,
                });
                last_old = Some(old.len() - 1);
                last_op = Some(ops.len() - 1);
            }
            b'+' => {
                new.push(HunkLine {
                    tag: HunkTag::Add,
                    body: body.clone(),
                    has_newline: true,
                });
                ops.push(HunkOp {
                    tag: HunkTag::Add,
                    body,
                    new_has_newline: true,
                });
                last_new = Some(new.len() - 1);
                last_op = Some(ops.len() - 1);
            }
            _ => return Err("bad hunk tag".to_string()),
        }
    }
    Ok(HunkParts { old, new, ops })
}

pub(crate) fn append_hunk_lines(out: &mut Vec<u8>, lines: &[HunkLine], eol: &str) {
    for line in lines {
        out.extend_from_slice(&line.body);
        if line.has_newline {
            out.extend_from_slice(eol.as_bytes());
        }
    }
}

pub(crate) fn hunk_lines_to_bytes(lines: &[HunkLine], eol: &str) -> Vec<u8> {
    let mut out = Vec::new();
    append_hunk_lines(&mut out, lines, eol);
    out
}

/// Render replacement lines so that each one inherits the terminator of the
/// old line it replaces (a 1:1 replacement is byte-identical outside the line
/// body); extra added lines fall back to the surrounding convention. A patch
/// must never normalize a mixed-EOL file onto one anchor terminator.
/// Render a hunk's new side OP-WISE, exactly like the fuzzy path: a context
/// line keeps its source terminator verbatim, a delete contributes its
/// terminator to the current run, and an add takes the terminator of the delete
/// it replaces inside that run (falling back to the local convention when the
/// run has none left). Content-similarity mapping cannot express interior
/// context, several change runs, or a moved line, so it is not used at all.
pub(crate) fn hunk_ops_to_bytes<'a>(
    parts: &'a HunkParts,
    old_eols: &[Option<&'a str>],
    fallback_eol: &'a str,
) -> Vec<u8> {
    // Pre-pass: EVERY delete of the hunk with the terminator of the source
    // line it consumes, tagged with its run. Filling the pool while walking
    // only saw deletes already passed, so a BACKWARD move (the add precedes
    // its delete) could not claim its own line and lost its terminator.
    let mut pool: Vec<(&'a [u8], Option<&'a str>, bool, usize)> = Vec::new();
    {
        let mut cursor = 0usize;
        let mut run = 0usize;
        for op in &parts.ops {
            match op.tag {
                HunkTag::Context => {
                    cursor += 1;
                    run += 1;
                }
                HunkTag::Delete => {
                    pool.push((
                        op.body.as_slice(),
                        old_eols.get(cursor).copied().flatten(),
                        false,
                        run,
                    ));
                    cursor += 1;
                }
                HunkTag::Add => {}
            }
        }
    }
    let mut pieces: Vec<(&'a [u8], Option<&'a str>)> = Vec::new();
    let mut old_cursor = 0usize;
    let mut current_run = 0usize;
    let mut last_claimed: isize = -1;
    for op in &parts.ops {
        match op.tag {
            HunkTag::Context => {
                let eol = old_eols.get(old_cursor).copied().flatten();
                old_cursor += 1;
                current_run += 1;
                // Verbatim copy: no terminator in the source means none here.
                pieces.push((op.body.as_slice(), eol));
            }
            HunkTag::Delete => {
                old_cursor += 1;
            }
            HunkTag::Add => {
                // 1) identity AFTER the previously claimed delete
                //    (order-preserving, so duplicates go in sequence),
                // 2) identity anywhere (a line moved backwards across context),
                // 3) the next unclaimed delete OF THIS RUN.
                let body = op.body.as_slice();
                let mut index: Option<usize> = None;
                for (position, (candidate, _, used, _)) in pool.iter().enumerate() {
                    if !*used && *candidate == body && position as isize > last_claimed {
                        index = Some(position);
                        break;
                    }
                }
                if index.is_none() {
                    for (position, (candidate, _, used, _)) in pool.iter().enumerate() {
                        if !*used && *candidate == body {
                            index = Some(position);
                            break;
                        }
                    }
                }
                if index.is_none() {
                    for (position, (_, _, used, run)) in pool.iter().enumerate() {
                        if !*used && *run == current_run {
                            index = Some(position);
                            break;
                        }
                    }
                }
                let mut inherited: Option<&'a str> = None;
                if let Some(position) = index {
                    pool[position].2 = true;
                    last_claimed = position as isize;
                    inherited = pool[position].1;
                }
                let eol = if op.new_has_newline {
                    Some(inherited.unwrap_or(fallback_eol))
                } else {
                    None
                };
                pieces.push((body, eol));
            }
        }
    }
    // A line that ends up INTERIOR must be terminated even when its source line
    // was the unterminated EOF line; only the final line may carry none.
    let count = pieces.len();
    let mut out = Vec::new();
    for (index, (body, eol)) in pieces.into_iter().enumerate() {
        out.extend_from_slice(body);
        match eol {
            Some(value) => out.extend_from_slice(value.as_bytes()),
            None if index + 1 < count => out.extend_from_slice(fallback_eol.as_bytes()),
            None => {}
        }
    }
    out
}

/// Validate that `span` is exactly the hunk's old lines and return each line's
/// terminator AS IT APPEARS IN THE SOURCE. This replaces the old
/// "one matched eol for the whole span" check: it accepts a mixed-EOL span and
/// preserves every terminator instead of folding them onto one.
///
/// When the source file's last line has no trailing newline, unified-diff hunks
/// still encode that line with the default `has_newline: true` unless a `\`
/// no-newline marker is present; that single-line EOF mismatch stays tolerated
/// for the last old hunk line only.
pub(crate) fn old_hunk_span_line_eols<'a>(
    parts: &HunkParts,
    span: &'a [u8],
) -> Option<Vec<Option<&'a str>>> {
    let mut eols: Vec<Option<&'a str>> = Vec::with_capacity(parts.old.len());
    let mut pos = 0usize;
    for (index, expected) in parts.old.iter().enumerate() {
        let body_start = pos;
        let mut cursor = body_start;
        let mut body_end = span.len();
        let mut eol: Option<&'a str> = None;
        while cursor < span.len() {
            if span[cursor] == b'\n' {
                body_end = cursor;
                eol = Some("\n");
                break;
            }
            if span[cursor] == b'\r' {
                body_end = cursor;
                eol = Some(if span.get(cursor + 1) == Some(&b'\n') {
                    "\r\n"
                } else {
                    "\r"
                });
                break;
            }
            cursor += 1;
        }
        if span[body_start..body_end] != expected.body[..] {
            return None;
        }
        let is_last = index + 1 == parts.old.len();
        let has_newline = eol.is_some();
        if has_newline != expected.has_newline && !(is_last && !has_newline) {
            return None;
        }
        eols.push(eol);
        pos = body_end + eol.map(|value| value.len()).unwrap_or(0);
    }
    if pos != span.len() {
        return None;
    }
    Some(eols)
}

pub(crate) fn newline_flags_compatible(
    line: &SourceLine,
    expected: &HunkLine,
    is_last_old_in_hunk: bool,
    is_last_line_in_file: bool,
) -> bool {
    if expected.has_newline == line.has_newline {
        return true;
    }
    is_last_old_in_hunk && is_last_line_in_file && expected.has_newline && !line.has_newline
}

pub(crate) fn source_line_matches_eof_aware(
    source: &[u8],
    line: &SourceLine,
    expected: &HunkLine,
    is_last_old_in_hunk: bool,
    is_last_line_in_file: bool,
) -> bool {
    if source_line_matches(source, line, expected) {
        return true;
    }
    if !newline_flags_compatible(line, expected, is_last_old_in_hunk, is_last_line_in_file) {
        return false;
    }
    source[line.start..line.body_end] == expected.body
}

pub(crate) fn apply_declared_hunk(
    source: &[u8],
    hunk: &Hunk,
    parts: &HunkParts,
    cursor: usize,
    scan: &mut Scan,
) -> Option<(usize, usize, Vec<u8>)> {
    let mut local_scan = *scan;
    if parts.old.is_empty() {
        if parts.new.is_empty() {
            return None;
        }
        // Reject anchors past EOF: line_start_at clamps to source.len() for any
        // out-of-range target, which would silently accept an insert at the
        // wrong location. Insert-only hunks here use the unified-diff
        // convention `@@ -N,0 +M,K @@` where N is the old-file line AFTER
        // which lines are inserted (passed straight to line_start_at as a
        // 0-based "skip N newlines" count, unlike the delete/context branch
        // below which subtracts 1). Valid range is 0..=line_count:
        //   N = 0          -> insert at the very top
        //   N = line_count -> append at EOF (line_start_at returns source.len())
        // N == line_count + 1 has no line to anchor after; line_start_at would
        // silently clamp it to source.len() too, indistinguishable from the
        // legitimate append. Reject it explicitly.
        if hunk.old_start > count_source_lines(source) {
            return None;
        }
        let start_offset = line_start_at_cached(source, hunk.old_start, &mut local_scan)?;
        if start_offset < cursor {
            return None;
        }
        let eol = insertion_line_ending_at(source, start_offset);
        *scan = local_scan;
        return Some((
            start_offset,
            start_offset,
            hunk_lines_to_bytes(&parts.new, eol),
        ));
    }

    let start_line = hunk.old_start.saturating_sub(1);
    let start_offset = line_start_at_cached(source, start_line, &mut local_scan)?;
    let end_offset = line_start_at_cached(source, start_line + parts.old.len(), &mut local_scan)?;
    if start_offset < cursor || end_offset < start_offset {
        return None;
    }
    let span = &source[start_offset..end_offset];
    // Per-line terminators, so a replacement inherits the ending of the line it
    // replaces and a mixed-EOL span is never folded onto one anchor EOL.
    let old_eols = old_hunk_span_line_eols(parts, span)?;
    let fallback_eol = old_eols
        .iter()
        .rev()
        .find_map(|entry| *entry)
        .unwrap_or_else(|| insertion_line_ending_at(source, start_offset));
    *scan = local_scan;
    Some((
        start_offset,
        end_offset,
        hunk_ops_to_bytes(parts, &old_eols, fallback_eol),
    ))
}

pub(crate) fn apply_fuzzy_hunk(
    source: &[u8],
    hunk: &Hunk,
    parts: &HunkParts,
    cursor: usize,
    fuzz_factor: usize,
) -> Option<(usize, usize, Vec<u8>)> {
    if parts.old.is_empty() {
        return None;
    }
    let lines = split_source_lines(source);
    if parts.old.len() > lines.len() {
        return None;
    }
    let target_idx = hunk.old_start.saturating_sub(1);
    // best tuple: (fuzz, norm_count, distance, start_offset, end_offset, bytes)
    let mut best: Option<(usize, usize, usize, usize, usize, Vec<u8>)> = None;
    for idx in 0..=lines.len().saturating_sub(parts.old.len()) {
        let start_offset = lines[idx].start;
        if start_offset < cursor {
            continue;
        }
        let Some((fuzz, norm_count, new_bytes)) =
            evaluate_fuzzy_candidate(source, &lines, idx, parts, fuzz_factor)
        else {
            continue;
        };
        let distance = idx.abs_diff(target_idx);
        let end_offset = lines[idx + parts.old.len() - 1].end;
        // Ordering: lower fuzz first, THEN fewer normalization-only matches,
        // THEN smaller distance. This guarantees a block that anchored WITHOUT
        // normalization always beats one that needed it, regardless of how much
        // nearer the normalized block sits to the target line.
        let replace = match &best {
            None => true,
            Some((best_fuzz, best_norm, best_dist, _, _, _)) => {
                (fuzz, norm_count, distance) < (*best_fuzz, *best_norm, *best_dist)
            }
        };
        if replace {
            best = Some((
                fuzz,
                norm_count,
                distance,
                start_offset,
                end_offset,
                new_bytes,
            ));
        }
    }
    best.map(|(_, _, _, start, end, bytes)| (start, end, bytes))
}

pub(crate) fn evaluate_fuzzy_candidate(
    source: &[u8],
    lines: &[SourceLine],
    idx: usize,
    parts: &HunkParts,
    fuzz_factor: usize,
) -> Option<(usize, usize, Vec<u8>)> {
    // Change band, computed from BOTH Add and Delete positions (not deletes
    // only). Context lines before the first change or after the last change are
    // the hunk's OUTER context and may drift under the fuzz factor (classic
    // `patch` fuzz). Any context line BETWEEN two changes is interior context:
    // it must match (modulo trailing whitespace), otherwise the hunk is binding
    // to a different block and we must reject rather than silently patch the
    // wrong location.
    //
    // Adds live in parts.ops (the in-order op sequence), not in parts.old, and
    // an Add sits BETWEEN two old lines rather than at an old index. To compare
    // it against old-context positions we use a doubled+shifted coordinate over
    // the old-index space: an old Context/Delete at old offset `o` maps to
    // 2*(o + 1), while an Add inserted at old cursor `k` (after k old lines were
    // consumed) maps to 2*k + 1, landing strictly between its neighboring old
    // lines. Tracking the min/max change position over Adds AND Deletes yields a
    // band that correctly flags interior context between two adds, or between an
    // add and a delete, which a delete-only band would miss.
    let mut first_change_pos: Option<usize> = None;
    let mut last_change_pos: Option<usize> = None;
    {
        let mut old_cursor = 0usize;
        for op in &parts.ops {
            match op.tag {
                HunkTag::Context => {
                    old_cursor += 1;
                }
                HunkTag::Delete => {
                    let pos = (old_cursor + 1) * 2;
                    first_change_pos = Some(first_change_pos.map_or(pos, |v| v.min(pos)));
                    last_change_pos = Some(last_change_pos.map_or(pos, |v| v.max(pos)));
                    old_cursor += 1;
                }
                HunkTag::Add => {
                    let pos = old_cursor * 2 + 1;
                    first_change_pos = Some(first_change_pos.map_or(pos, |v| v.min(pos)));
                    last_change_pos = Some(last_change_pos.map_or(pos, |v| v.max(pos)));
                }
            }
        }
    }

    let mut fuzz = 0usize;
    // Count of lines in this candidate that matched ONLY via the Unicode
    // normalization tier. Normalization is deterministic but lossy enough to
    // create extra collisions, so a block that needed it must never beat a
    // block that matched exactly/whitespace-only. Tracking the count lets the
    // best-candidate selector prefer non-normalized matches.
    let mut norm_count = 0usize;
    for (offset, expected) in parts.old.iter().enumerate() {
        let src = lines.get(idx + offset)?;
        let is_last_old_in_hunk = offset + 1 == parts.old.len();
        let is_last_line_in_file = idx + offset + 1 == lines.len();
        if source_line_matches_eof_aware(
            source,
            src,
            expected,
            is_last_old_in_hunk,
            is_last_line_in_file,
        ) {
            continue;
        }
        // Whitespace-only drift (leading OR trailing) is always tolerated and
        // costs no fuzz, for Context AND Delete lines alike. Whitespace is
        // normalised (rstrip/strip) across
        // every context+delete line before comparing, so indentation reflow
        // never blocks a hunk. Content (non-whitespace) drift is unaffected:
        // it still falls through to the outer/interior fuzz-budget logic below
        // for Context, and to a hard reject for Delete.
        if fuzz_factor > 0
            && matches!(expected.tag, HunkTag::Context | HunkTag::Delete)
            && source_context_line_matches_fuzzy(
                source,
                src,
                expected,
                is_last_old_in_hunk,
                is_last_line_in_file,
            )
        {
            continue;
        }
        // Unicode-normalization tier: an ASCII-authored patch line that
        // differs from the source only by typographic dashes / quotes /
        // exotic spaces is treated as an exact match at ZERO fuzz cost. This
        // is a deterministic code-point normalization (not a heuristic
        // guess), so it is safe for interior context lines too — unlike the
        // outer-context-only content fuzz below. This is the final
        // normalise() pass of the seek.
        if fuzz_factor > 0
            && matches!(expected.tag, HunkTag::Context | HunkTag::Delete)
            && source_context_line_matches_normalized(
                source,
                src,
                expected,
                is_last_old_in_hunk,
                is_last_line_in_file,
            )
        {
            norm_count += 1;
            continue;
        }
        match expected.tag {
            HunkTag::Context => {
                // Only outer (leading/trailing) context lines may differ in
                // content, and only within the fuzz budget. An interior context
                // mismatch means a different block — reject it rather than
                // counting it as tolerable fuzz.
                // Map this context line into the same doubled coordinate space
                // used for the change band: an old line at offset `offset` lives
                // at (offset + 1) * 2. It is interior iff it lies strictly
                // between the first and last change position.
                let ctx_pos = (offset + 1) * 2;
                let is_outer = match (first_change_pos, last_change_pos) {
                    (Some(f), Some(l)) => ctx_pos < f || ctx_pos > l,
                    // No changes at all (degenerate): there is no interior band,
                    // so all context is outer/anchor context.
                    _ => true,
                };
                if !is_outer {
                    return None;
                }
                fuzz += 1;
                if fuzz > fuzz_factor {
                    return None;
                }
            }
            // parts.old only ever carries Context/Delete lines; Add is
            // unreachable here but must be matched for exhaustiveness and is
            // treated as a non-match (return None) defensively.
            HunkTag::Delete | HunkTag::Add => return None,
        }
    }

    // idx is bound to 0..=lines.len()-parts.old.len() above, and parts.old is
    // non-empty, so lines[idx] is always in range.
    let anchor = &lines[idx];
    let fallback_eol = source_line_eol(source, anchor)
        .unwrap_or_else(|| insertion_line_ending_at(source, anchor.start));
    let mut new_bytes = Vec::new();
    let mut old_offset = 0usize;
    // Terminators of the lines the current run deletes. The k-th added line of
    // a run inherits the k-th deleted line's ending, so a replacement inside a
    // mixed-EOL file keeps that line's own terminator instead of the anchor's.
    let mut replaced_eols: Vec<&str> = Vec::new();
    let mut replaced_cursor = 0usize;
    for op in &parts.ops {
        match op.tag {
            HunkTag::Context => {
                let src = lines.get(idx + old_offset)?;
                new_bytes.extend_from_slice(&source[src.start..src.end]);
                old_offset += 1;
                replaced_eols.clear();
                replaced_cursor = 0;
            }
            HunkTag::Delete => {
                if let Some(src) = lines.get(idx + old_offset) {
                    if let Some(eol) = source_line_eol(source, src) {
                        replaced_eols.push(eol);
                    }
                }
                old_offset += 1;
            }
            HunkTag::Add => {
                new_bytes.extend_from_slice(&op.body);
                if op.new_has_newline {
                    let eol = replaced_eols
                        .get(replaced_cursor)
                        .copied()
                        .unwrap_or(fallback_eol);
                    replaced_cursor += 1;
                    new_bytes.extend_from_slice(eol.as_bytes());
                }
            }
        }
    }
    Some((fuzz, norm_count, new_bytes))
}

pub(crate) fn source_line_matches(source: &[u8], line: &SourceLine, expected: &HunkLine) -> bool {
    // Newline presence must match in both directions: a patch expecting a
    // trailing newline must not silently apply on top of an EOF line that has
    // none (and vice versa).
    if expected.has_newline != line.has_newline {
        return false;
    }
    source[line.start..line.body_end] == expected.body
}

pub(crate) fn trim_patch_ws(bytes: &[u8]) -> &[u8] {
    // Strip leading AND trailing horizontal whitespace: strip-level context
    // normalisation (not just the old trailing-only trim).
    let mut start = 0usize;
    let mut end = bytes.len();
    while start < end && matches!(bytes[start], b' ' | b'\t') {
        start += 1;
    }
    while end > start && matches!(bytes[end - 1], b' ' | b'\t') {
        end -= 1;
    }
    &bytes[start..end]
}

pub(crate) fn source_context_line_matches_fuzzy(
    source: &[u8],
    line: &SourceLine,
    expected: &HunkLine,
    is_last_old_in_hunk: bool,
    is_last_line_in_file: bool,
) -> bool {
    if !newline_flags_compatible(line, expected, is_last_old_in_hunk, is_last_line_in_file) {
        return false;
    }
    trim_patch_ws(&source[line.start..line.body_end]) == trim_patch_ws(&expected.body)
}

/// Map common typographic code-points to their ASCII equivalents, then trim.
/// This is the seek's `normalise()` pass, so an ASCII-authored patch can
/// still anchor against source containing curly
/// quotes, em/en dashes, NBSP and other exotic spaces.
pub(crate) fn normalize_typographic(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .chars()
        .map(|c| match c {
            // Various dash / hyphen code-points -> ASCII '-'
            '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}'
            | '\u{2212}' => '-',
            // Non-breaking space and other odd spaces -> normal space
            '\u{00A0}' | '\u{2002}' | '\u{2003}' | '\u{2004}' | '\u{2005}' | '\u{2006}'
            | '\u{2007}' | '\u{2008}' | '\u{2009}' | '\u{200A}' | '\u{202F}' | '\u{205F}'
            | '\u{3000}' => ' ',
            other => fold_char_curly(other),
        })
        .collect::<String>()
        .trim()
        .to_string()
}

pub(crate) fn source_context_line_matches_normalized(
    source: &[u8],
    line: &SourceLine,
    expected: &HunkLine,
    is_last_old_in_hunk: bool,
    is_last_line_in_file: bool,
) -> bool {
    if !newline_flags_compatible(line, expected, is_last_old_in_hunk, is_last_line_in_file) {
        return false;
    }
    // Guard against lossy UTF-8 decoding: normalize_typographic relies on
    // String::from_utf8_lossy, which collapses every invalid byte to U+FFFD.
    // Without this guard a patch line carrying U+FFFD (or one decoded to it)
    // could spuriously match arbitrary invalid source bytes. Only attempt a
    // normalized comparison when BOTH the source body and the expected body
    // are valid UTF-8; otherwise there is no normalized match.
    let src_body = &source[line.start..line.body_end];
    if std::str::from_utf8(src_body).is_err() || std::str::from_utf8(&expected.body).is_err() {
        return false;
    }
    normalize_typographic(src_body) == normalize_typographic(&expected.body)
}

pub(crate) fn source_line_eol<'a>(source: &'a [u8], line: &SourceLine) -> Option<&'a str> {
    if !line.has_newline {
        return None;
    }
    if line.body_end + 1 < line.end
        && source.get(line.body_end) == Some(&b'\r')
        && source.get(line.body_end + 1) == Some(&b'\n')
    {
        return Some("\r\n");
    }
    if source.get(line.body_end) == Some(&b'\r') {
        return Some("\r");
    }
    Some("\n")
}

pub(crate) fn split_source_lines(source: &[u8]) -> Vec<SourceLine> {
    let mut lines = Vec::new();
    let mut start = 0usize;
    if source_uses_cr_only(source) {
        while start < source.len() {
            match memchr(b'\r', &source[start..]) {
                Some(rel) => {
                    let cr = start + rel;
                    lines.push(SourceLine {
                        start,
                        body_end: cr,
                        end: cr + 1,
                        has_newline: true,
                    });
                    start = cr + 1;
                }
                None => {
                    lines.push(SourceLine {
                        start,
                        body_end: source.len(),
                        end: source.len(),
                        has_newline: false,
                    });
                    break;
                }
            }
        }
        return lines;
    }
    while start < source.len() {
        match memchr_lf(source, start) {
            Some(nl) => {
                let body_end = if nl > start && source[nl - 1] == b'\r' {
                    nl - 1
                } else {
                    nl
                };
                lines.push(SourceLine {
                    start,
                    body_end,
                    end: nl + 1,
                    has_newline: true,
                });
                start = nl + 1;
            }
            None => {
                lines.push(SourceLine {
                    start,
                    body_end: source.len(),
                    end: source.len(),
                    has_newline: false,
                });
                break;
            }
        }
    }
    lines
}

pub(crate) fn line_start_at_fresh(source: &[u8], target_line: usize) -> Option<usize> {
    let mut scan = Scan { line: 0, pos: 0 };
    line_start_at(source, target_line, &mut scan)
}

pub(crate) fn line_start_at_cached(
    source: &[u8],
    target_line: usize,
    scan: &mut Scan,
) -> Option<usize> {
    if target_line < scan.line {
        return line_start_at_fresh(source, target_line);
    }
    line_start_at(source, target_line, scan)
}

pub(crate) fn line_start_at(source: &[u8], target_line: usize, scan: &mut Scan) -> Option<usize> {
    if target_line < scan.line {
        return None;
    }
    while scan.line < target_line {
        match memchr_eol(source, scan.pos) {
            Some(nl) => {
                scan.pos = nl + 1;
                scan.line += 1;
            }
            None => {
                scan.line = target_line;
                scan.pos = source.len();
                return Some(source.len());
            }
        }
    }
    Some(scan.pos)
}

pub(crate) fn memchr_lf(source: &[u8], start: usize) -> Option<usize> {
    memchr(b'\n', source.get(start..)?).map(|idx| start + idx)
}

pub(crate) fn source_uses_cr_only(source: &[u8]) -> bool {
    source.contains(&b'\r') && !source.contains(&b'\n')
}

pub(crate) fn memchr_eol(source: &[u8], start: usize) -> Option<usize> {
    if source_uses_cr_only(source) {
        memchr(b'\r', source.get(start..)?).map(|idx| start + idx)
    } else {
        memchr_lf(source, start)
    }
}

pub(crate) fn count_source_lines(source: &[u8]) -> usize {
    if source.is_empty() {
        return 0;
    }
    let mut n = 0usize;
    let mut pos = 0usize;
    while let Some(nl) = memchr_eol(source, pos) {
        n += 1;
        pos = nl + 1;
    }
    if pos < source.len() {
        n += 1;
    }
    n
}

pub(crate) fn insertion_line_ending_at(source: &[u8], byte_offset: usize) -> &'static str {
    if source_uses_cr_only(source) {
        return "\r";
    }
    if byte_offset >= 2 && source[byte_offset - 1] == b'\n' && source[byte_offset - 2] == b'\r' {
        return "\r\n";
    }
    if let Some(next_lf) = memchr_lf(source, byte_offset) {
        if next_lf > 0 && source[next_lf - 1] == b'\r' {
            return "\r\n";
        }
    }
    "\n"
}

pub(crate) fn source_ends_with_newline(source: &[u8]) -> bool {
    source.last() == Some(&b'\n') || (source_uses_cr_only(source) && source.last() == Some(&b'\r'))
}

/// The file's own line terminator, taken from its LAST terminator so a CRLF
/// file keeps CRLF when a separator has to be synthesised at EOF.
pub(crate) fn source_trailing_eol(source: &[u8]) -> &'static str {
    if source_uses_cr_only(source) {
        return "\r";
    }
    match memrchr(b'\n', source) {
        Some(idx) if idx > 0 && source[idx - 1] == b'\r' => "\r\n",
        _ => "\n",
    }
}

pub(crate) fn strip_trailing_eol(bytes: &mut Vec<u8>) {
    if bytes.ends_with(b"\r\n") {
        bytes.truncate(bytes.len() - 2);
    } else if bytes.ends_with(b"\n") {
        bytes.truncate(bytes.len() - 1);
    } else if bytes.ends_with(b"\r") {
        bytes.truncate(bytes.len() - 1);
    }
}

/// Keep the source file's end-of-file newline state across a hunk that reaches
/// EOF in a file whose last line has NO terminator.
///
///  * insert-only at EOF: the last source line has no separator, so the
///    inserted block must be prefixed with one — otherwise the first inserted
///    line is glued onto it ("root" + "A\n" -> "rootA\n").
///  * any hunk whose replaced region ends at EOF: the rewritten tail must not
///    gain a terminator the file never had.
///
/// Both only apply when the patch is SILENT about the EOF newline (no
/// `\ No newline at end of file` marker on the side in question); an explicit
/// marker is a deliberate intent and is left alone. This matches the JS
/// dispatcher, which carries the source's `hasFinalNewline` through unchanged.
pub(crate) fn preserve_eof_newline_state(
    source: &[u8],
    parts: &HunkParts,
    applied: (usize, usize, Vec<u8>),
) -> (usize, usize, Vec<u8>) {
    let (start, end, mut bytes) = applied;
    if source.is_empty() || end != source.len() || source_ends_with_newline(source) {
        return (start, end, bytes);
    }
    if parts.old.is_empty() {
        let mut prefixed = source_trailing_eol(source).as_bytes().to_vec();
        prefixed.extend_from_slice(&bytes);
        bytes = prefixed;
    } else if !parts.old.last().is_none_or(|line| line.has_newline) {
        // The patch explicitly declared the old EOF state; trust its new side.
        return (start, end, bytes);
    }
    // Only a hunk whose LAST op ADDS the new EOF line may re-strip the
    // terminator that the unified format implies. When the hunk deletes the
    // unterminated EOF line (or ends on context), the new tail is a line the
    // hunk did not write: its bytes — including the terminator that belongs to
    // it — were copied verbatim and must not be rewritten.
    let last_op_adds = matches!(parts.ops.last().map(|op| op.tag), Some(HunkTag::Add));
    if last_op_adds && parts.new.last().is_some_and(|line| line.has_newline) {
        strip_trailing_eol(&mut bytes);
    }
    (start, end, bytes)
}
