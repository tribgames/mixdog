//! Line similarity and previews shared by `edit` and `apply_patch` failure hints. Lengths and
//! whitespace follow JavaScript (UTF-16 units, `\s`), because the model sees the same numbers Node
//! printed.

use mixdog_js::js_trim;
use mixdog_js::js_words;
use mixdog_js::slice_utf16;
use mixdog_js::utf16_len;

/// Longest common run of UTF-16 units, each side cut to 4000 units.
pub(crate) fn longest_common_substring(a: &str, b: &str) -> usize {
    let a: Vec<u16> = a.encode_utf16().take(4000).collect();
    let b: Vec<u16> = b.encode_utf16().take(4000).collect();
    let mut prev = vec![0usize; b.len() + 1];
    let mut cur = vec![0usize; b.len() + 1];
    let mut best = 0;
    for x in &a {
        for (j, y) in b.iter().enumerate() {
            cur[j + 1] = if x == y { prev[j] + 1 } else { 0 };
            best = best.max(cur[j + 1]);
        }
        std::mem::swap(&mut prev, &mut cur);
        cur.fill(0);
    }
    best
}

fn squash(s: &str) -> String {
    js_words(s).collect::<Vec<_>>().join(" ")
}

fn score_similar(candidate: &str, target: &str) -> f64 {
    let cand = squash(candidate);
    let want = squash(target);
    if cand.is_empty() || want.is_empty() {
        return 0.0;
    }
    if cand == want {
        return 100_000.0;
    }
    let (lc, lw) = (utf16_len(&cand), utf16_len(&want));
    let mut score = longest_common_substring(&cand, &want) as f64 * 20.0;
    if cand.contains(&want) || want.contains(&cand) {
        score += 5000.0 + lc.min(lw) as f64;
    }
    let mut seen = std::collections::BTreeSet::new();
    for word in want.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '$')) {
        if word.len() > 1 && seen.insert(word) && cand.contains(word) {
            score += ((word.len() * 12) as f64).min(200.0);
        }
    }
    if lc.max(lw) < 80 {
        score -= lc.abs_diff(lw) as f64;
    }
    score
}

/// Index of the line most like `expected`, nearest `preferred` on ties.
pub(crate) fn nearest_line(lines: &[String], expected: &str, preferred: usize) -> Option<usize> {
    if js_trim(expected).is_empty() {
        return None;
    }
    let mut best: Option<(f64, usize)> = None;
    for (i, line) in lines.iter().enumerate() {
        let s = score_similar(line, expected) - i.abs_diff(preferred) as f64 * 0.01;
        if best.is_none_or(|(b, _)| s > b) {
            best = Some((s, i));
        }
    }
    best.filter(|(s, _)| *s > 0.0).map(|(_, i)| i)
}

/// `line` with tabs escaped, cut to `max` UTF-16 units (`…` replaces the last kept one).
pub(crate) fn compact_preview(line: &str, max: usize) -> String {
    let text = line.replace('\t', "\\t");
    if utf16_len(&text) > max {
        format!("{}…", slice_utf16(&text, max - 1))
    } else {
        text
    }
}
