//! Node's adaptive grep context (`lib/grep-context-expander.mjs` `expandGrepAnchorContextOutput`): the match anchors
//! ranked by how rare their pattern branch is, windowed by limit and offset (head and tail kept), and rendered as source
//! blocks within a character budget: one or two clusters that fit stay at the full radius; past that the radius narrows
//! to the focused window, three or more clusters stay raw while they fit and the rest become `path:line` anchors, the
//! radius shrinks, then the lowest-priority anchors drop until the text fits.

use std::cmp::Ordering;
use std::collections::HashMap;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::fs::ReadRange;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_js::utf16_len;

use super::common::guarded;

/// `GREP_AUTO_CONTEXT_BEFORE` / `GREP_AUTO_CONTEXT_AFTER` (path-utils.mjs); the automatic window's `maxContext` is the
/// latter (`GREP_AUTO_CONTEXT_LINES`).
const AUTO_BEFORE: u64 = 8;
const AUTO_AFTER: u64 = 12;
const FOCUSED_BEFORE: u64 = 4;
const FOCUSED_AFTER: u64 = 7;
const FOCUSED_RAW_BLOCKS: usize = 3;
const COMPACT_ANCHOR_CONTENT_MAX: usize = 400;
/// `Number.MAX_SAFE_INTEGER`: the priority of an anchor no ranked branch matched.
const NO_PRIORITY: u64 = 9_007_199_254_740_991;

/// One match the search found: its display path, file, line and (clipped) text.
pub(super) struct Match<'a> {
    pub label: &'a str,
    pub path: &'a AbsPath,
    pub line: u64,
    pub text: String,
}

#[derive(Clone)]
struct Anchor {
    path: String,
    abs: AbsPath,
    line: u64,
    content: String,
    order: usize,
    priority: u64,
}

#[derive(Clone, Copy)]
struct Span {
    before: u64,
    after: u64,
}

struct Block {
    path: String,
    match_line: u64,
    start: u64,
    end: u64,
    contents: Vec<String>,
    priority: u64,
    order: usize,
}

/// `grepPagingNotice`.
pub(super) fn paging_notice(shown: usize, total: usize, known: bool, omitted: usize, offset: usize, next: usize) -> String {
    if shown == 0 {
        return if known {
            format!("[0 of {total} shown; offset:{offset} past end]")
        } else {
            format!("[0 shown, results partial; offset:{offset} beyond streamed window; narrow path/glob/pattern]")
        };
    }
    if omitted == 0 && known {
        return String::new();
    }
    let count = if known { format!("{shown} of {total} shown") } else { format!("{shown} shown, more exist") };
    format!("\n[{count}; offset:{next} for the rest]")
}

/// `expandGrepAnchorContextOutput`: the rendered text, empty when there is no anchor. `limit` `usize::MAX` is no limit;
/// `requested` 0 is the automatic window.
#[allow(clippy::too_many_arguments)]
pub(super) async fn expand(
    ctx: &ToolContext,
    matches: Vec<Match<'_>>,
    pattern: &str,
    offset: usize,
    limit: usize,
    known: bool,
    requested: u64,
    char_budget: usize,
) -> Result<String, ToolError> {
    let mut anchors: Vec<Anchor> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for m in matches {
        if !seen.insert((m.path.clone(), m.line)) {
            continue;
        }
        let order = anchors.len();
        anchors.push(Anchor { path: m.label.to_owned(), abs: m.path.clone(), line: m.line, content: m.text, order, priority: NO_PRIORITY });
    }
    rank_anchors(&mut anchors, pattern);
    let total = anchors.len();
    if total == 0 {
        return Ok(String::new());
    }
    // `selectAnchors`: the page after `offset`; when it is cut, its head half and tail half.
    let after_offset = anchors.get(offset..).unwrap_or(&[]);
    if after_offset.is_empty() {
        return Ok(paging_notice(0, total, known, 0, offset, offset));
    }
    let shown = limit.min(after_offset.len());
    let omitted = after_offset.len() - shown;
    let (selected, next) = if omitted == 0 || shown == 0 {
        (after_offset[..shown].to_vec(), offset + shown)
    } else {
        let head = shown.div_ceil(2).max(1);
        let tail = shown - head;
        let mut picked = after_offset[..head].to_vec();
        picked.extend_from_slice(&after_offset[after_offset.len() - tail..]);
        (picked, offset + head)
    };
    let notice = paging_notice(shown, total, known, omitted, offset, next);
    if selected.is_empty() {
        return Ok(notice);
    }
    // `contextSpan`: an explicit radius is honoured symmetrically; the automatic one leans downward.
    let span = if requested > 0 { Span { before: requested, after: requested } } else { Span { before: AUTO_BEFORE.min(AUTO_AFTER), after: AUTO_AFTER } };
    let budget = char_budget.max(512);
    let sources = read_sources(ctx, &selected, span).await?;
    Ok(fit(selected, &sources, span, budget, notice, total, known, offset))
}

/// `rankAnchors`: with two or more branches (top-level alternatives of the unwrapped pattern), an anchor's priority is
/// the hit count of the rarest branch it matches.
fn rank_anchors(anchors: &mut [Anchor], pattern: &str) {
    let (source, ignore_case) = unwrap_pattern_shell(pattern);
    let branches: Vec<Option<mixdog_js::JsRegex>> = split_top_level_alternatives(&source)
        .into_iter()
        .filter(|b| !b.is_empty())
        .map(|b| mixdog_js::JsRegex::new(&b, if ignore_case { "i" } else { "" }).ok())
        .collect();
    if branches.len() <= 1 {
        return;
    }
    let matched: Vec<Vec<usize>> = anchors
        .iter()
        .map(|a| branches.iter().enumerate().filter(|(_, b)| b.as_ref().is_some_and(|b| b.is_match(&a.content))).map(|(i, _)| i).collect())
        .collect();
    let mut hits = vec![0u64; branches.len()];
    for indices in &matched {
        for i in indices {
            hits[*i] += 1;
        }
    }
    for (anchor, indices) in anchors.iter_mut().zip(&matched) {
        anchor.priority = indices.iter().map(|i| hits[*i]).min().unwrap_or(NO_PRIORITY);
    }
}

fn split_top_level_alternatives(source: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let (mut start, mut depth, mut in_class, mut escaped) = (0usize, 0usize, false, false);
    for (index, ch) in source.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match ch {
            '\\' => escaped = true,
            _ if in_class => in_class = ch != ']',
            '[' => in_class = true,
            '(' => depth += 1,
            ')' if depth > 0 => depth -= 1,
            '|' if depth == 0 => {
                parts.push(source[start..index].to_owned());
                start = index + 1;
            }
            _ => {}
        }
    }
    if parts.is_empty() {
        return vec![source.to_owned()];
    }
    parts.push(source[start..].to_owned());
    parts
}

/// `groupEnclosesWhole`: the leading `(` closes at the last character.
fn group_encloses_whole(source: &str) -> bool {
    let (mut depth, mut escaped, mut in_class) = (0i64, false, false);
    let last = source.char_indices().last().map_or(0, |(i, _)| i);
    for (index, ch) in source.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match ch {
            '\\' => escaped = true,
            _ if in_class => in_class = ch != ']',
            '[' => in_class = true,
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 && index < last {
                    return false;
                }
            }
            _ => {}
        }
    }
    depth == 0
}

/// `unwrapPatternShell`: leading inline flag groups and one fully enclosing group stripped (at most eight passes),
/// with whether an inline `i` asked for case-insensitive branches.
fn unwrap_pattern_shell(pattern: &str) -> (String, bool) {
    static FLAGS: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"^\(\?([a-zA-Z]+(?:-[a-zA-Z]+)?)\)").expect("a fixed pattern"));
    static PREFIX: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"^\?(?:<[^=!][^>]*>|([a-zA-Z]+(?:-[a-zA-Z]+)?)?:)").expect("a fixed pattern"));
    let mut source = pattern.to_owned();
    let mut ignore_case = false;
    let has_i = |flags: &str| flags.split('-').next().unwrap_or_default().contains('i');
    for _ in 0..8 {
        if let Some(group) = FLAGS.captures(&source) {
            ignore_case |= has_i(&group[1]);
            source = source[group[0].len()..].to_owned();
            continue;
        }
        if !(source.starts_with('(') && source.ends_with(')')) || !group_encloses_whole(&source) {
            break;
        }
        let mut inner = source[1..source.len() - 1].to_owned();
        if inner.starts_with('?') {
            let Some(prefix) = PREFIX.captures(&inner) else { break };
            ignore_case |= prefix.get(1).is_some_and(|f| has_i(f.as_str()));
            inner = inner[prefix[0].len()..].to_owned();
        }
        source = inner;
    }
    (source, ignore_case)
}

/// `readAnchorSources` (`readSourceWindows`): per file, the raw lines inside the anchors' merged windows; `None` for a
/// file that could not be read.
async fn read_sources(ctx: &ToolContext, selected: &[Anchor], span: Span) -> Result<HashMap<AbsPath, Option<HashMap<u64, String>>>, ToolError> {
    let mut sources: HashMap<AbsPath, Option<HashMap<u64, String>>> = HashMap::new();
    for anchor in selected {
        if sources.contains_key(&anchor.abs) {
            continue;
        }
        let windows: Vec<(u64, u64)> = selected
            .iter()
            .filter(|a| a.abs == anchor.abs)
            .map(|a| (a.line.saturating_sub(span.before).max(1), a.line + span.after))
            .collect();
        let read = guarded(ctx, "grep", ctx.files.read(ctx.io.interactive, anchor.abs.clone(), ReadRange::default())).await?;
        let lines = read.ok().map(|bytes| {
            let text = String::from_utf8_lossy(&bytes.bytes);
            let mut segments: Vec<&str> = text.split('\n').collect();
            // The empty piece after a final newline is no line.
            if segments.last().is_some_and(|s| s.is_empty()) {
                segments.pop();
            }
            segments
                .into_iter()
                .enumerate()
                .map(|(i, s)| (i as u64 + 1, s))
                .filter(|(n, _)| windows.iter().any(|(start, end)| (*start..=*end).contains(n)))
                .map(|(n, s)| (n, s.strip_suffix('\r').unwrap_or(s).to_owned()))
                .collect()
        });
        sources.insert(anchor.abs.clone(), lines);
    }
    Ok(sources)
}

/// `sourceBlock`: the anchor's window as far as its source has lines, or the match line alone.
fn source_block(anchor: &Anchor, source: Option<&HashMap<u64, String>>, span: Span) -> Block {
    let Some(lines) = source.filter(|l| l.contains_key(&anchor.line)) else {
        return Block {
            path: anchor.path.clone(),
            match_line: anchor.line,
            start: anchor.line,
            end: anchor.line,
            contents: vec![anchor.content.clone()],
            priority: anchor.priority,
            order: anchor.order,
        };
    };
    let mut start = anchor.line.saturating_sub(span.before).max(1);
    let mut end = anchor.line + span.after;
    while start < anchor.line && !lines.contains_key(&start) {
        start += 1;
    }
    while end > anchor.line && !lines.contains_key(&end) {
        end -= 1;
    }
    let mut contents = Vec::new();
    for n in start..=end {
        let Some(line) = lines.get(&n) else { break };
        contents.push(line.clone());
    }
    let end = start + contents.len() as u64 - 1;
    Block { path: anchor.path.clone(), match_line: anchor.line, start, end, contents, priority: anchor.priority, order: anchor.order }
}

/// `mergeBlocks`: overlapping or touching windows of a file joined (the higher-priority match line heads them), then
/// ordered by priority and first appearance.
fn merge_blocks(blocks: Vec<Block>) -> Vec<Block> {
    let mut sorted = blocks;
    sorted.sort_by(|a, b| mixdog_js::locale_compare(&a.path, &b.path).then(a.start.cmp(&b.start)).then(a.end.cmp(&b.end)));
    let mut merged: Vec<Block> = Vec::new();
    for block in sorted {
        match merged.last_mut() {
            Some(prev) if prev.path == block.path && block.start <= prev.end + 1 => {
                let overlap = (prev.end + 1).saturating_sub(block.start) as usize;
                prev.contents.extend(block.contents.into_iter().skip(overlap));
                prev.end = prev.end.max(block.end);
                if block.priority < prev.priority || (block.priority == prev.priority && block.order < prev.order) {
                    prev.match_line = block.match_line;
                    prev.priority = block.priority;
                    prev.order = block.order;
                }
            }
            _ => merged.push(block),
        }
    }
    merged.sort_by(|a, b| a.priority.cmp(&b.priority).then(a.order.cmp(&b.order)));
    merged
}

fn render_blocks(blocks: &[Block]) -> String {
    blocks
        .iter()
        .map(|b| format!("# {}:{} [lines {}-{}]\n{}", b.path, b.match_line, b.start, b.end, b.contents.join("\n")))
        .collect::<Vec<_>>()
        .join("\n")
}

type Sources = HashMap<AbsPath, Option<HashMap<u64, String>>>;

fn blocks_for(selected: &[Anchor], sources: &Sources, span: Span) -> Vec<Block> {
    merge_blocks(selected.iter().map(|a| source_block(a, sources.get(&a.abs).and_then(Option::as_ref), span)).collect())
}

/// `renderAtRadius`: the text and its block count.
fn render_at_radius(selected: &[Anchor], sources: &Sources, span: Span, notice: &str) -> (String, usize) {
    let blocks = blocks_for(selected, sources, span);
    (format!("{}{notice}", render_blocks(&blocks)), blocks.len())
}

fn anchor_priority(a: &Anchor, b: &Anchor) -> Ordering {
    a.priority.cmp(&b.priority).then(a.order.cmp(&b.order))
}

/// `compactAnchorContent`: trimmed, whitespace runs one space, cut at 400 UTF-16 units with an ellipsis.
fn compact_anchor_content(content: &str) -> String {
    let mut normalized = String::new();
    let mut in_space = false;
    for ch in mixdog_js::js_trim(content).chars() {
        if mixdog_js::is_js_space(ch) {
            if !in_space {
                normalized.push(' ');
            }
            in_space = true;
        } else {
            normalized.push(ch);
            in_space = false;
        }
    }
    if utf16_len(&normalized) <= COMPACT_ANCHOR_CONTENT_MAX {
        normalized
    } else {
        format!("{}…", mixdog_js::slice_utf16(&normalized, COMPACT_ANCHOR_CONTENT_MAX - 1))
    }
}

/// `renderFocusedContext`: at least three clusters raw, more while their text fits the budget; the other anchors as
/// `path:line:content [lines a-b]` under `# Additional matches`.
fn render_focused(selected: &[Anchor], sources: &Sources, span: Span, budget: usize, notice: &str) -> String {
    let mut ordered = selected.to_vec();
    ordered.sort_by(anchor_priority);
    let ranked = blocks_for(&ordered, sources, span);
    let mut raw: Vec<&Block> = Vec::new();
    let mut raw_length = 0usize;
    for block in &ranked {
        let length = utf16_len(&block.path) + block.contents.iter().map(|l| utf16_len(l) + 1).sum::<usize>() + 32;
        if raw.len() >= FOCUSED_RAW_BLOCKS && raw_length + length > budget {
            break;
        }
        raw.push(block);
        raw_length += length;
    }
    let covered = |a: &Anchor| raw.iter().any(|b| a.path == b.path && a.line >= b.start && a.line <= b.end);
    let compact: Vec<&Anchor> = ordered.iter().filter(|a| !covered(a)).collect();
    let raw_text = raw.iter().map(|b| format!("# {}:{} [lines {}-{}]\n{}", b.path, b.match_line, b.start, b.end, b.contents.join("\n"))).collect::<Vec<_>>().join("\n");
    if compact.is_empty() {
        return format!("{raw_text}{notice}");
    }
    let rows: Vec<String> = compact
        .iter()
        .map(|a| {
            let hint = format!("lines {}-{}", a.line.saturating_sub(span.before).max(1), a.line + span.after);
            format!("{}:{}:{} [{hint}]", a.path, a.line, compact_anchor_content(&a.content))
        })
        .collect();
    // `anchorOverflowSummary`.
    let summary = match notice.strip_suffix(']') {
        Some(head) if !notice.is_empty() => format!("{head}; {} source spans, rest as path:line anchors]", raw.len()),
        _ => format!("\n[{} of {} shown; rest as path:line anchors]", raw.len(), ordered.len()),
    };
    format!("{raw_text}\n# Additional matches\n{}{summary}", rows.join("\n"))
}

/// `fitContextToBudget`.
#[allow(clippy::too_many_arguments)]
fn fit(mut selected: Vec<Anchor>, sources: &Sources, span: Span, budget: usize, mut notice: String, total: usize, known: bool, offset: usize) -> String {
    let (text, blocks) = render_at_radius(&selected, sources, span, &notice);
    if blocks <= 2 && utf16_len(&text) <= budget {
        return text;
    }
    let mut focused = Span { before: span.before.min(FOCUSED_BEFORE), after: span.after.min(FOCUSED_AFTER) };
    let mut text = render_focused(&selected, sources, focused, budget, &notice);
    while utf16_len(&text) > budget && (focused.before > 0 || focused.after > 0) {
        // `shrinkSpan`: the wider side gives first.
        focused = if focused.after > focused.before {
            Span { before: focused.before, after: focused.after - 1 }
        } else {
            Span { before: focused.before.saturating_sub(1), after: focused.after }
        };
        text = render_focused(&selected, sources, focused, budget, &notice);
    }
    while utf16_len(&text) > budget && selected.len() > 1 {
        selected.sort_by(anchor_priority);
        selected.pop();
        let shown = selected.len();
        let omitted = total.saturating_sub(offset + shown);
        notice = paging_notice(shown, total, known, omitted, offset, offset + shown);
        text = render_focused(&selected, sources, focused, budget, &notice);
    }
    text
}
