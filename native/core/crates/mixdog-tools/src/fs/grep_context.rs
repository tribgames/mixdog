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
    /// `compactAnchorContent` of `content`, made the first time the anchor is shown as a `path:line` row: fitting lays
    /// the same anchors out again after every dropped one.
    compact: std::sync::OnceLock<String>,
}

impl Anchor {
    fn compact(&self) -> &str {
        self.compact.get_or_init(|| compact_anchor_content(&self.content))
    }
}

#[derive(Clone, Copy)]
struct Span {
    before: u64,
    after: u64,
}

/// The lines of a window, borrowed from the anchors and the sources read once for the call.
enum Lines<'a> {
    /// The match line alone, as the search clipped it (its file was not read, or the line is not in what was read).
    Lone(&'a str),
    /// The lines `start..=end` of a file's read lines, every one of them present.
    Run(&'a HashMap<u64, String>),
    /// Windows of both kinds joined.
    Mixed(Vec<&'a str>),
}

/// A window of source lines. Fitting lays the same anchors out again at every radius and after every dropped anchor
/// (a large search drops hundreds, one at a time), so a window names its lines instead of holding a list of them, and
/// the passes that only need the length of the text count it instead of building it: copies of the lines, and then
/// lists of them and the text itself, were gigabytes of allocation for one large search.
struct Block<'a> {
    path: &'a str,
    match_line: u64,
    start: u64,
    end: u64,
    lines: Lines<'a>,
    priority: u64,
    order: usize,
}

impl<'a> Block<'a> {
    fn each(&self, mut line: impl FnMut(&'a str)) {
        match &self.lines {
            Lines::Lone(only) => line(only),
            Lines::Run(source) => (self.start..=self.end).for_each(|n| line(source[&n].as_str())),
            Lines::Mixed(lines) => lines.iter().for_each(|l| line(*l)),
        }
    }

    fn listed(&self) -> Vec<&'a str> {
        let mut lines = Vec::new();
        self.each(|line| lines.push(line));
        lines
    }

    /// `# path:line [lines a-b]` and the lines under it.
    fn write(&self, out: &mut impl std::fmt::Write) {
        let _ = write!(out, "# {}:{} [lines {}-{}]", self.path, self.match_line, self.start, self.end);
        self.each(|line| {
            let _ = out.write_char('\n');
            let _ = out.write_str(line);
        });
    }
}

/// The UTF-16 length of what is written to it (what the budget is counted in).
struct Utf16Length(usize);

impl std::fmt::Write for Utf16Length {
    fn write_str(&mut self, text: &str) -> std::fmt::Result {
        self.0 += utf16_len(text);
        Ok(())
    }
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
#[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
pub(super) async fn expand(
    ctx: &ToolContext,
    matches: Vec<Match<'_>>,
    pattern: &str,
    case_insensitive: bool,
    offset: usize,
    limit: usize,
    known: bool,
    requested: u64,
    char_budget: usize,
    prefix: bool,
) -> Result<String, ToolError> {
    let mut anchors: Vec<Anchor> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for m in matches {
        if !seen.insert((m.path.clone(), m.line)) {
            continue;
        }
        let order = anchors.len();
        anchors.push(Anchor { path: m.label.to_owned(), abs: m.path.clone(), line: m.line, content: m.text, order, priority: NO_PRIORITY, compact: std::sync::OnceLock::new() });
    }
    rank_anchors(&mut anchors, pattern, case_insensitive);
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
    // `prefix`: a page that was cut to fit a byte cap is the first `shown` anchors, none skipped or shown twice across pages.
    let (selected, next) = if omitted == 0 || shown == 0 || prefix {
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
    Ok(fit(selected, &sources, span, budget, notice, total, known, offset, prefix))
}

/// `rankAnchors`: with two or more branches (top-level alternatives of the unwrapped pattern), an anchor's priority is
/// the hit count of the rarest branch it matches.
fn rank_anchors(anchors: &mut [Anchor], pattern: &str, case_insensitive: bool) {
    let (source, shell_ignores_case) = unwrap_pattern_shell(pattern);
    let ignore_case = case_insensitive || shell_ignores_case;
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
#[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
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
fn source_block<'a>(anchor: &'a Anchor, source: Option<&'a HashMap<u64, String>>, span: Span) -> Block<'a> {
    let Some(lines) = source.filter(|l| l.contains_key(&anchor.line)) else {
        return Block {
            path: &anchor.path,
            match_line: anchor.line,
            start: anchor.line,
            end: anchor.line,
            lines: Lines::Lone(anchor.content.as_str()),
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
    // The window ends before the first line that was not read.
    let held = (start..=end).take_while(|n| lines.contains_key(n)).count() as u64;
    let end = start + held - 1;
    Block { path: &anchor.path, match_line: anchor.line, start, end, lines: Lines::Run(lines), priority: anchor.priority, order: anchor.order }
}

/// `mergeBlocks`: overlapping or touching windows of a file joined (the higher-priority match line heads them), then
/// ordered by priority and first appearance.
fn merge_blocks(blocks: Vec<Block<'_>>) -> Vec<Block<'_>> {
    let mut sorted = blocks;
    sorted.sort_by(|a, b| mixdog_js::locale_compare(a.path, b.path).then(a.start.cmp(&b.start)).then(a.end.cmp(&b.end)));
    let mut merged: Vec<Block<'_>> = Vec::new();
    for block in sorted {
        match merged.last_mut() {
            Some(prev) if prev.path == block.path && block.start <= prev.end + 1 => {
                // The joined window is the earlier one's lines, then the later one's past where they overlap. Two runs
                // of the same read lines are the run over both; anything else is listed.
                let same_run = matches!((&prev.lines, &block.lines), (Lines::Run(a), Lines::Run(b)) if std::ptr::eq(*a, *b));
                if !same_run {
                    let overlap = (prev.end + 1).saturating_sub(block.start) as usize;
                    if !matches!(prev.lines, Lines::Mixed(_)) {
                        prev.lines = Lines::Mixed(prev.listed());
                    }
                    if let Lines::Mixed(lines) = &mut prev.lines {
                        lines.extend(block.listed().into_iter().skip(overlap));
                    }
                }
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

/// The blocks, one under the other.
fn write_blocks<'b>(out: &mut impl std::fmt::Write, blocks: impl Iterator<Item = &'b Block<'b>>) {
    for (nth, block) in blocks.enumerate() {
        if nth > 0 {
            let _ = out.write_char('\n');
        }
        block.write(out);
    }
}

type Sources = HashMap<AbsPath, Option<HashMap<u64, String>>>;

fn blocks_for<'a>(selected: impl Iterator<Item = &'a Anchor>, sources: &'a Sources, span: Span) -> Vec<Block<'a>> {
    merge_blocks(selected.map(|a| source_block(a, sources.get(&a.abs).and_then(Option::as_ref), span)).collect())
}

/// `renderAtRadius`: the text and its block count.
fn render_at_radius(selected: &[Anchor], sources: &Sources, span: Span, notice: &str) -> (String, usize) {
    let blocks = blocks_for(selected.iter(), sources, span);
    let mut text = String::new();
    write_blocks(&mut text, blocks.iter());
    text.push_str(notice);
    (text, blocks.len())
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
/// `path:line:content [lines a-b]` under `# Additional matches`. Written to `out`: the text, or its length alone.
fn write_focused(out: &mut impl std::fmt::Write, selected: &[Anchor], sources: &Sources, span: Span, budget: usize, notice: &str) {
    let mut ordered: Vec<&Anchor> = selected.iter().collect();
    ordered.sort_by(|a, b| anchor_priority(a, b));
    let ranked = blocks_for(ordered.iter().copied(), sources, span);
    let mut raw: Vec<&Block<'_>> = Vec::new();
    let mut raw_length = 0usize;
    for block in &ranked {
        let mut length = utf16_len(block.path) + 32;
        block.each(|line| length += utf16_len(line) + 1);
        if raw.len() >= FOCUSED_RAW_BLOCKS && raw_length + length > budget {
            break;
        }
        raw.push(block);
        raw_length += length;
    }
    let covered = |a: &Anchor| raw.iter().any(|b| a.path == b.path && a.line >= b.start && a.line <= b.end);
    write_blocks(out, raw.iter().copied());
    let mut compact = ordered.iter().copied().filter(|a| !covered(a)).peekable();
    if compact.peek().is_none() {
        let _ = out.write_str(notice);
        return;
    }
    let _ = out.write_str("\n# Additional matches");
    for a in compact {
        let _ = write!(out, "\n{}:{}:{} [lines {}-{}]", a.path, a.line, a.compact(), a.line.saturating_sub(span.before).max(1), a.line + span.after);
    }
    // `anchorOverflowSummary`.
    let _ = match notice.strip_suffix(']') {
        Some(head) if !notice.is_empty() => write!(out, "{head}; {} source spans, rest as path:line anchors]", raw.len()),
        _ => write!(out, "\n[{} of {} shown; rest as path:line anchors]", raw.len(), ordered.len()),
    };
}

fn render_focused(selected: &[Anchor], sources: &Sources, span: Span, budget: usize, notice: &str) -> String {
    let mut text = String::new();
    write_focused(&mut text, selected, sources, span, budget, notice);
    text
}

/// The UTF-16 length of [`render_focused`]'s text, without the text.
fn focused_length(selected: &[Anchor], sources: &Sources, span: Span, budget: usize, notice: &str) -> usize {
    let mut length = Utf16Length(0);
    write_focused(&mut length, selected, sources, span, budget, notice);
    length.0
}

/// `fitContextToBudget`.
#[allow(clippy::too_many_arguments)]
fn fit(mut selected: Vec<Anchor>, sources: &Sources, span: Span, budget: usize, mut notice: String, total: usize, known: bool, offset: usize, prefix: bool) -> String {
    let (text, blocks) = render_at_radius(&selected, sources, span, &notice);
    if blocks <= 2 && utf16_len(&text) <= budget {
        return text;
    }
    let mut focused = Span { before: span.before.min(FOCUSED_BEFORE), after: span.after.min(FOCUSED_AFTER) };
    // Each pass below decides on the length of the text alone; the text is built once, for the layout that is kept.
    let mut length = focused_length(&selected, sources, focused, budget, &notice);
    while length > budget && (focused.before > 0 || focused.after > 0) {
        // `shrinkSpan`: the wider side gives first.
        focused = if focused.after > focused.before {
            Span { before: focused.before, after: focused.after - 1 }
        } else {
            Span { before: focused.before.saturating_sub(1), after: focused.after }
        };
        length = focused_length(&selected, sources, focused, budget, &notice);
    }
    // A prefix page keeps every anchor it was given: the caller shrinks the page instead of dropping anchors out of order.
    while !prefix && length > budget && selected.len() > 1 {
        selected.sort_by(anchor_priority);
        selected.pop();
        let shown = selected.len();
        let omitted = total.saturating_sub(offset + shown);
        notice = paging_notice(shown, total, known, omitted, offset, offset + shown);
        length = focused_length(&selected, sources, focused, budget, &notice);
    }
    render_focused(&selected, sources, focused, budget, &notice)
}
