//! Node's adaptive grep context (`lib/grep-context-expander.mjs` `expandGrepAnchorContextOutput`): the match anchors
//! ranked by how rare their pattern branch is, windowed by limit and offset (head and tail kept), and rendered as source
//! blocks within a character budget: one or two clusters that fit stay at the full radius; past that the radius narrows
//! to the focused window, three or more clusters stay raw while they fit and the rest become `path:line` anchors, the
//! radius shrinks, then the lowest-priority anchors drop until the text fits.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::pin::Pin;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::fs::{FileBytes, FileStat};
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

struct Anchor<'a> {
    path: &'a str,
    abs: &'a AbsPath,
    line: u64,
    content: String,
    order: usize,
    priority: u64,
    /// `compactAnchorContent` of `content`, made the first time the anchor is shown as a `path:line` row: fitting lays
    /// the same anchors out again after every dropped one.
    compact: std::sync::OnceLock<String>,
}

impl Anchor<'_> {
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
            Lines::Mixed(lines) => lines.iter().for_each(|l| line(l)),
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
    let mut notice = String::new();
    write_paging_notice(&mut notice, shown, total, known, omitted, offset, next);
    notice
}

fn write_paging_notice(out: &mut String, shown: usize, total: usize, known: bool, omitted: usize, offset: usize, next: usize) {
    use std::fmt::Write;
    let _ = if shown == 0 {
        if known {
            write!(out, "[0 of {total} shown; offset:{offset} past end]")
        } else {
            write!(out, "[0 shown, results partial; offset:{offset} beyond streamed window; narrow path/glob/pattern]")
        }
    } else if omitted == 0 && known {
        Ok(())
    } else if known {
        write!(out, "\n[{shown} of {total} shown; offset:{next} for the rest]")
    } else {
        write!(out, "\n[{shown} shown, more exist; offset:{next} for the rest]")
    };
}

/// `expandGrepAnchorContextOutput`: the rendered text, empty when there is no anchor. `limit` `usize::MAX` is no limit;
/// `requested` 0 is the automatic window.
#[allow(clippy::too_many_arguments)]
#[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
pub(super) async fn expand(
    io: (&ToolContext, &mut SourceCache),
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
    let mut anchors = distinct_anchors(matches);
    rank_anchors(&mut anchors, pattern, case_insensitive);
    let total = anchors.len();
    if total == 0 {
        return Ok(String::new());
    }
    if offset >= total {
        return Ok(paging_notice(0, total, known, 0, offset, offset));
    }
    anchors.drain(..offset);
    let page = select_page(anchors, offset, limit, prefix);
    let selected = page.anchors;
    let notice = paging_notice(page.shown, total, known, page.omitted, offset, page.next);
    if selected.is_empty() {
        return Ok(notice);
    }
    // `contextSpan`: an explicit radius is honoured symmetrically; the automatic one leans downward.
    let span = if requested > 0 { Span { before: requested, after: requested } } else { Span { before: AUTO_BEFORE.min(AUTO_AFTER), after: AUTO_AFTER } };
    let budget = char_budget.max(512);
    let (ctx, sources) = io;
    sources.load(ctx, &selected, span).await?;
    Ok(fit(selected, sources, span, budget, notice, total, known, offset, prefix))
}

fn distinct_anchors(matches: Vec<Match<'_>>) -> Vec<Anchor<'_>> {
    let mut anchors: Vec<Anchor<'_>> = Vec::with_capacity(matches.len());
    let mut seen = std::collections::HashSet::with_capacity(matches.len());
    for m in matches {
        if !seen.insert((m.path, m.line)) {
            continue;
        }
        let order = anchors.len();
        anchors.push(Anchor {
            path: m.label,
            abs: m.path,
            line: m.line,
            content: m.text,
            order,
            priority: NO_PRIORITY,
            compact: std::sync::OnceLock::new(),
        });
    }
    anchors
}

struct Page<'a> {
    anchors: Vec<Anchor<'a>>,
    shown: usize,
    omitted: usize,
    next: usize,
}

/// `selectAnchors`: the page of the anchors after `offset`; when it is cut, its head half and tail half. `prefix`: a page
/// that was cut to fit a byte cap is the first `shown` anchors, none skipped or shown twice across pages.
fn select_page(mut anchors: Vec<Anchor<'_>>, offset: usize, limit: usize, prefix: bool) -> Page<'_> {
    let shown = limit.min(anchors.len());
    let omitted = anchors.len() - shown;
    let next = if omitted == 0 || shown == 0 || prefix {
        anchors.truncate(shown);
        offset + shown
    } else {
        let head = shown.div_ceil(2).max(1);
        let tail = shown - head;
        let len = anchors.len();
        anchors.drain(head..len - tail);
        offset + head
    };
    Page { anchors, shown, omitted, next }
}

/// `rankAnchors`: with two or more branches (top-level alternatives of the unwrapped pattern), an anchor's priority is
/// the hit count of the rarest branch it matches.
fn rank_anchors(anchors: &mut [Anchor<'_>], pattern: &str, case_insensitive: bool) {
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
    let matches = |anchor: &Anchor<'_>, i: usize| branches[i].as_ref().is_some_and(|b| b.is_match(&anchor.content));
    // The first pass holds the branches an anchor matches in its `priority`, as bits; one past the 64th is matched again.
    let mut hits = vec![0u64; branches.len()];
    for anchor in anchors.iter_mut() {
        let mut matched = 0u64;
        for (i, count) in hits.iter_mut().enumerate() {
            if matches(anchor, i) {
                *count += 1;
                if i < 64 {
                    matched |= 1 << i;
                }
            }
        }
        anchor.priority = matched;
    }
    for anchor in anchors.iter_mut() {
        let matched = anchor.priority;
        anchor.priority =
            (0..branches.len()).filter(|&i| if i < 64 { matched & (1 << i) != 0 } else { matches(anchor, i) }).map(|i| hits[i]).min().unwrap_or(NO_PRIORITY);
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

type Window = (u64, u64);
type SourceRead<'a> = Pin<Box<dyn Future<Output = Result<Option<(FileStat, FileBytes)>, ToolError>> + Send + 'a>>;
const SOURCE_CHUNK: u64 = 64 * 1024;

/// One invocation's source rows, shared by budget retries and fan-out sections. An unreadable file falls back to
/// the printed matches, not to a partly read context. Keep the first-seen file order when issuing reads.
#[derive(Default)]
pub(super) struct SourceCache(HashMap<AbsPath, Option<Source>>);

#[derive(Default)]
struct Source {
    lines: HashMap<u64, String>,
    covered: Vec<Window>,
    offsets: BTreeMap<u64, u64>,
    eof: Option<u64>,
    version: Option<FileStat>,
}

fn merge_windows(windows: &mut Vec<Window>) {
    windows.sort_unstable();
    let mut kept = 0;
    for i in 0..windows.len() {
        let (first, last) = windows[i];
        if kept > 0 && first <= windows[kept - 1].1.saturating_add(1) {
            windows[kept - 1].1 = windows[kept - 1].1.max(last);
        } else {
            windows[kept] = (first, last);
            kept += 1;
        }
    }
    windows.truncate(kept);
}

impl SourceCache {
    async fn load(&mut self, ctx: &ToolContext, selected: &[Anchor<'_>], span: Span) -> Result<(), ToolError> {
        let mut positions = HashMap::<&AbsPath, usize>::new();
        let mut files = Vec::<(&AbsPath, Vec<Window>)>::new();
        for anchor in selected {
            let at = *positions.entry(anchor.abs).or_insert_with(|| {
                files.push((anchor.abs, Vec::new()));
                files.len() - 1
            });
            files[at].1.push((anchor.line.saturating_sub(span.before).max(1), anchor.line.saturating_add(span.after)));
        }
        // Even an all-three-byte UTF-8 prefix this long can't fit the largest context budget. A giant line
        // remains oversized without storing its remainder; a line that can be delivered is never clipped.
        let line_cap = super::common::grep_max_bytes().max(512).saturating_add(1).saturating_mul(3);
        for (path, mut windows) in files {
            if ctx.cancel.is_cancelled() {
                return Err(super::common::cancelled());
            }
            if ctx.deadline.is_some_and(|deadline| mixdog_rt::time::Instant::from_std(deadline) <= mixdog_rt::time::Instant::now()) {
                return Err(super::common::deadline_exceeded("grep", false));
            }
            merge_windows(&mut windows);
            let entry = self.0.entry(path.clone()).or_insert_with(|| Some(Source::default()));
            if let Some(source) = entry
                && !source
                    .fill(&windows, line_cap, |offset, max_len| {
                        Box::pin(
                            async move { Ok(guarded(ctx, "grep", ctx.files.read_versioned(ctx.io.interactive, path.clone(), offset, max_len)).await?.ok()) },
                        )
                    })
                    .await?
            {
                *entry = None;
            }
        }
        Ok(())
    }
}

impl Source {
    fn missing(&self, windows: &[Window]) -> Vec<Window> {
        let mut missing = Vec::new();
        let mut covered = self.covered.iter().copied().peekable();
        for &(mut first, last) in windows {
            let last = self.eof.map_or(last, |eof| last.min(eof));
            while first <= last {
                match covered.peek().copied() {
                    Some((_, end)) if end < first => {
                        covered.next();
                    }
                    Some((start, end)) if start <= first => {
                        if end >= last {
                            break;
                        }
                        first = end + 1;
                    }
                    Some((start, _)) if start <= last => {
                        missing.push((first, start - 1));
                        first = start;
                    }
                    _ => {
                        missing.push((first, last));
                        break;
                    }
                }
            }
        }
        missing
    }

    async fn fill<'a>(&mut self, windows: &[Window], line_cap: usize, mut read: impl FnMut(u64, u64) -> SourceRead<'a> + Send) -> Result<bool, ToolError> {
        let missing = self.missing(windows);
        let Some(&(first, _)) = missing.first() else { return Ok(true) };
        let (mut line, mut offset) = self.offsets.range(..=first).next_back().map_or((1, 0), |(&n, &at)| (n, at));
        let mut pending = Vec::new();
        let mut clipped = false;
        let mut partial = false;
        let mut ranges = missing.iter().copied().peekable();
        while let Some(&(first, _)) = ranges.peek() {
            if !partial
                && line <= first
                && let Some((&next_line, &next_offset)) = self.offsets.range(line..=first).next_back()
            {
                (line, offset) = (next_line, next_offset);
            }
            let Some((version, bytes)) = read(offset, SOURCE_CHUNK).await? else {
                return Ok(false);
            };
            if self.version.get_or_insert(version.clone()) != &version {
                return Ok(false);
            }
            // Virtual files can report size zero even when reads return data. Only an empty read proves EOF.
            if bytes.bytes.is_empty() {
                if partial && line >= first {
                    self.store_line(line, &pending, clipped);
                }
                self.eof = Some(line - u64::from(!partial));
                break;
            }
            if bytes.offset != offset {
                return Ok(false);
            }
            let base = offset;
            let mut rest = bytes.bytes.as_slice();
            let mut last_start = None;
            while let Some(&(first, last)) = ranges.peek() {
                if !partial
                    && line < first
                    && let Some((&next_line, &next_offset)) = self.offsets.range((line + 1)..=first).next_back()
                {
                    (line, offset) = (next_line, next_offset);
                    let Some(suffix) = bytes.bytes.get((offset - base) as usize..) else { break };
                    rest = suffix;
                }
                if rest.is_empty() {
                    break;
                }
                let newline = rest.iter().position(|&b| b == b'\n');
                let body = &rest[..newline.unwrap_or(rest.len())];
                let consumed = body.len() + usize::from(newline.is_some());
                offset += consumed as u64;
                rest = &rest[consumed..];
                if line >= first {
                    let keep = body.len().min(line_cap.saturating_sub(pending.len()));
                    pending.extend_from_slice(&body[..keep]);
                    clipped |= keep < body.len();
                }
                if newline.is_none() {
                    partial = true;
                    break;
                }
                if line >= first {
                    self.store_line(line, &pending, clipped);
                    pending.clear();
                    clipped = false;
                }
                line += 1;
                last_start = Some((line, offset));
                partial = false;
                if line > last {
                    // Keep the exact end of every fetched window, even when the chunk scans on for another window.
                    self.offsets.insert(line, offset);
                    ranges.next();
                }
            }
            if let Some((line, offset)) = last_start {
                self.offsets.insert(line, offset);
            }
        }
        self.covered.extend(missing);
        merge_windows(&mut self.covered);
        Ok(true)
    }

    fn store_line(&mut self, line: u64, bytes: &[u8], clipped: bool) {
        let bytes = if clipped { bytes } else { bytes.strip_suffix(b"\r").unwrap_or(bytes) };
        self.lines.insert(line, String::from_utf8_lossy(bytes).into_owned());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_core_api::domain::fs::EntryKind;

    fn version(len: u64, inode: u128) -> FileStat {
        FileStat { kind: EntryKind::File, len, modified: None, ctime: None, inode, device: 1, readonly: false }
    }

    fn chunk(bytes: &[u8], offset: u64, max_len: u64, version: FileStat) -> (FileStat, FileBytes) {
        let start = offset as usize;
        let end = (start + max_len as usize).min(bytes.len());
        let total_len = version.len;
        (version, FileBytes { offset, bytes: bytes[start..end].to_vec(), total_len })
    }

    #[tokio::test]
    async fn context_reads_only_ranged_chunks_and_reuses_covered_rows_when_refitting() {
        // A skipped line crosses two chunks; a selected UTF-8 codepoint crosses the third boundary.
        let mut bytes = vec![b'x'; (SOURCE_CHUNK * 3 - 5) as usize];
        bytes.extend_from_slice(b"\r\nab");
        bytes.extend_from_slice("한\r\n\n".as_bytes());
        bytes.extend_from_slice(b"invalid:\xff\r\nlast");
        let requests = std::sync::Mutex::new(Vec::new());
        let read_range = |offset, max_len| -> SourceRead<'_> {
            requests.lock().unwrap().push(offset);
            Box::pin(std::future::ready(Ok(Some(chunk(&bytes, offset, max_len, version(bytes.len() as u64, 1))))))
        };
        let mut source = Source::default();
        assert!(source.fill(&[(2, 4)], 24, read_range).await.unwrap());
        assert_eq!(source.lines.get(&1), None, "no retained body for a skipped line");
        assert_eq!(source.lines[&2], "ab한");
        assert_eq!(source.lines[&3], "");
        assert_eq!(source.lines[&4], "invalid:�");
        let reads = requests.lock().unwrap().len();
        assert!(source.fill(&[(3, 4)], 24, read_range).await.unwrap());
        assert_eq!(requests.lock().unwrap().len(), reads, "a narrower fit does not fetch source again");
        assert!(source.fill(&[(4, 9)], 24, read_range).await.unwrap());
        assert_eq!(source.lines[&5], "last");
        assert_eq!(source.lines.get(&6), None, "no phantom EOF line");
        assert_eq!(&requests.lock().unwrap()[reads..], &[bytes.len() as u64 - 4, bytes.len() as u64], "load only the new suffix and confirm EOF");
    }

    #[tokio::test]
    async fn context_rejects_a_replaced_file_when_expanding_cached_rows() {
        let mut source = Source::default();
        for (inode, body, windows, accepted) in [(1, b"a\nb\n".as_slice(), [(1, 1)], true), (2, b"x\ny\n".as_slice(), [(1, 2)], false)] {
            let read =
                |offset, max_len| -> SourceRead<'_> { Box::pin(std::future::ready(Ok(Some(chunk(body, offset, max_len, version(body.len() as u64, inode)))))) };
            assert_eq!(source.fill(&windows, 24, read).await.unwrap(), accepted);
        }
        assert_eq!(source.lines.get(&2), None, "the replacement never supplies a row to the original window");
    }

    #[tokio::test]
    async fn context_of_a_size_zero_source_continues_to_the_requested_line() {
        let mut bytes = vec![b'x'; SOURCE_CHUNK as usize + 1];
        bytes.extend_from_slice(b"\nmatch");
        let read = |offset, max_len| -> SourceRead<'_> { Box::pin(std::future::ready(Ok(Some(chunk(&bytes, offset, max_len, version(0, 1)))))) };
        let mut source = Source::default();
        assert!(source.fill(&[(2, 2)], 24, read).await.unwrap());
        assert_eq!(source.lines[&2], "match");
    }

    #[tokio::test]
    async fn context_expansion_skips_a_covered_line_spanning_multiple_chunks() {
        let mut bytes = b"before\n".to_vec();
        bytes.extend(std::iter::repeat_n(b'x', SOURCE_CHUNK as usize * 2));
        bytes.extend_from_slice(b"\nafter\nlater\n");
        let requests = std::sync::Mutex::new(Vec::new());
        let read = |offset, max_len| -> SourceRead<'_> {
            requests.lock().unwrap().push(offset);
            Box::pin(std::future::ready(Ok(Some(chunk(&bytes, offset, max_len, version(bytes.len() as u64, 1))))))
        };
        let mut source = Source::default();
        assert!(source.fill(&[(2, 2), (4, 4)], 24, read).await.unwrap());
        requests.lock().unwrap().clear();
        assert!(source.fill(&[(1, 4)], 24, read).await.unwrap());
        assert_eq!(source.lines[&1], "before");
        assert_eq!(source.lines[&3], "after");
        assert_eq!(*requests.lock().unwrap(), [0, bytes.len() as u64 - b"after\nlater\n".len() as u64]);
    }

    mod alloc_count {
        use std::alloc::{GlobalAlloc, Layout, System};
        use std::cell::Cell;

        thread_local! { static BYTES: Cell<usize> = const { Cell::new(0) }; }

        fn add(bytes: usize) {
            let _ = BYTES.try_with(|b| b.set(b.get() + bytes));
        }

        /// Bytes this thread has allocated so far, a grown block counted at its new size.
        pub(super) fn allocated() -> usize {
            BYTES.with(Cell::get)
        }

        struct Counting;

        unsafe impl GlobalAlloc for Counting {
            unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
                add(layout.size());
                // SAFETY: the caller upholds `GlobalAlloc::alloc`'s contract, which `System` shares.
                unsafe { System.alloc(layout) }
            }
            unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
                add(layout.size());
                // SAFETY: the caller upholds `GlobalAlloc::alloc_zeroed`'s contract, which `System` shares.
                unsafe { System.alloc_zeroed(layout) }
            }
            unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
                add(new_size);
                // SAFETY: the caller upholds `GlobalAlloc::realloc`'s contract, which `System` shares.
                unsafe { System.realloc(ptr, layout, new_size) }
            }
            unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
                // SAFETY: the caller upholds `GlobalAlloc::dealloc`'s contract, which `System` shares.
                unsafe { System.dealloc(ptr, layout) }
            }
        }

        #[global_allocator]
        static COUNTING: Counting = Counting;
    }

    #[test]
    fn context_fit_allocates_in_proportion_to_its_output() {
        let abs = AbsPath::new(if cfg!(windows) { "C:\\big.rs" } else { "/big.rs" }).expect("an absolute path");
        let text = |n: u64| {
            let call = if n % 400 == 0 { "needle_b" } else if n % 40 == 0 { "needle_a" } else { "plain" };
            format!("    let value_{n} = {call}(input_{n}, {n});")
        };
        let hits: Vec<u64> = (1..=20_000u64).filter(|n| n % 40 == 0).collect();
        let mut source = Source::default();
        for &n in &hits {
            for line in n - AUTO_BEFORE..=n + AUTO_AFTER {
                source.lines.entry(line).or_insert_with(|| text(line));
            }
        }
        let mut sources = SourceCache::default();
        sources.0.insert(abs.clone(), Some(source));
        let matches: Vec<Match<'_>> = hits.iter().map(|&n| Match { label: "big.rs", path: &abs, line: n, text: text(n) }).collect();

        // The process-wide collator is built on first use (about 1 MiB), not per call.
        let _ = mixdog_js::locale_compare("big.rs", "big.rs");

        let start = alloc_count::allocated();
        let mut anchors = distinct_anchors(matches);
        rank_anchors(&mut anchors, "needle_a|needle_b", false);
        let total = anchors.len();
        let page = select_page(anchors, 0, usize::MAX, false);
        let notice = paging_notice(page.shown, total, true, page.omitted, 0, page.next);
        let out = fit(page.anchors, &sources, Span { before: AUTO_BEFORE, after: AUTO_AFTER }, 16_000, notice, total, true, 0, false);
        let allocated = alloc_count::allocated() - start;

        eprintln!("grep context: {} anchors, {} output bytes, {allocated} bytes allocated", hits.len(), out.len());
        assert!(out.contains("# Additional matches"), "the large page takes the focused layout");
        // The fit drops one anchor per pass here, hundreds of passes: a layout rebuilt per pass costs thousands of times the
        // output, one held across passes a small multiple of it.
        assert!(allocated <= 32 * out.len(), "{allocated} bytes allocated for {} bytes of output", out.len());
    }

}

/// `sourceBlock`: the anchor's window as far as its source has lines, or the match line alone.
fn source_block<'a>(anchor: &'a Anchor<'_>, source: Option<&'a HashMap<u64, String>>, span: Span) -> Block<'a> {
    let Some(lines) = source.filter(|l| l.contains_key(&anchor.line)) else {
        return Block {
            path: anchor.path,
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
    Block { path: anchor.path, match_line: anchor.line, start, end, lines: Lines::Run(lines), priority: anchor.priority, order: anchor.order }
}

/// `mergeBlocks`, in place: overlapping or touching windows of a file joined (the higher-priority match line heads them),
/// then ordered by priority and first appearance. Equal windows keep the order the anchors had when they were listed:
/// first appearance, or rank when `ranked`.
fn merge_blocks(blocks: &mut Vec<Block<'_>>, ranked: bool) {
    blocks.sort_unstable_by(|a, b| {
        mixdog_js::locale_compare(a.path, b.path).then(a.start.cmp(&b.start)).then(a.end.cmp(&b.end)).then_with(|| {
            if ranked { a.priority.cmp(&b.priority).then(a.order.cmp(&b.order)) } else { a.order.cmp(&b.order) }
        })
    });
    blocks.dedup_by(|block, prev| {
        if prev.path != block.path || block.start > prev.end + 1 {
            return false;
        }
        // The joined window is the earlier one's lines, then the later one's past where they overlap. Two runs of the same
        // read lines are the run over both; anything else is listed.
        let same_run = matches!((&prev.lines, &block.lines), (Lines::Run(a), Lines::Run(b)) if std::ptr::eq(*a, *b));
        if !same_run {
            let mut overlap = (prev.end + 1).saturating_sub(block.start);
            if !matches!(prev.lines, Lines::Mixed(_)) {
                prev.lines = Lines::Mixed(prev.listed());
            }
            if let Lines::Mixed(lines) = &mut prev.lines {
                block.each(|line| {
                    if overlap > 0 {
                        overlap -= 1;
                    } else {
                        lines.push(line);
                    }
                });
            }
        }
        prev.end = prev.end.max(block.end);
        if block.priority < prev.priority || (block.priority == prev.priority && block.order < prev.order) {
            prev.match_line = block.match_line;
            prev.priority = block.priority;
            prev.order = block.order;
        }
        true
    });
    blocks.sort_unstable_by(|a, b| a.priority.cmp(&b.priority).then(a.order.cmp(&b.order)));
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

/// The merged blocks of `selected`, written over `blocks`.
fn blocks_for<'a>(blocks: &mut Vec<Block<'a>>, selected: &'a [Anchor<'_>], sources: &'a SourceCache, span: Span, ranked: bool) {
    blocks.clear();
    blocks.extend(selected.iter().map(|a| source_block(a, sources.0.get(a.abs).and_then(Option::as_ref).map(|s| &s.lines), span)));
    merge_blocks(blocks, ranked);
}

fn anchor_priority(a: &Anchor<'_>, b: &Anchor<'_>) -> Ordering {
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
/// `ordered` is in [`anchor_priority`] order; `blocks` is scratch space.
fn write_focused<'a>(
    out: &mut impl std::fmt::Write,
    blocks: &mut Vec<Block<'a>>,
    ordered: &'a [Anchor<'_>],
    sources: &'a SourceCache,
    span: Span,
    budget: usize,
    notice: &str,
) {
    blocks_for(blocks, ordered, sources, span, true);
    let mut raw = 0usize;
    let mut raw_length = 0usize;
    for block in blocks.iter() {
        let mut length = utf16_len(block.path) + 32;
        block.each(|line| length += utf16_len(line) + 1);
        if raw >= FOCUSED_RAW_BLOCKS && raw_length + length > budget {
            break;
        }
        raw += 1;
        raw_length += length;
    }
    let raw = &blocks[..raw];
    let covered = |a: &Anchor<'_>| raw.iter().any(|b| a.path == b.path && a.line >= b.start && a.line <= b.end);
    write_blocks(out, raw.iter());
    let mut compact = ordered.iter().filter(|a| !covered(a)).peekable();
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

fn render_focused<'a>(blocks: &mut Vec<Block<'a>>, ordered: &'a [Anchor<'_>], sources: &'a SourceCache, span: Span, budget: usize, notice: &str) -> String {
    let mut text = String::new();
    write_focused(&mut text, blocks, ordered, sources, span, budget, notice);
    text
}

/// The UTF-16 length of [`render_focused`]'s text, without the text.
fn focused_length<'a>(blocks: &mut Vec<Block<'a>>, ordered: &'a [Anchor<'_>], sources: &'a SourceCache, span: Span, budget: usize, notice: &str) -> usize {
    let mut length = Utf16Length(0);
    write_focused(&mut length, blocks, ordered, sources, span, budget, notice);
    length.0
}

/// `fitContextToBudget`. The anchors are put in [`anchor_priority`] order once: a dropped anchor is the last one, and
/// every pass lays out a prefix of them in the same scratch blocks.
#[allow(clippy::too_many_arguments)]
fn fit(
    mut selected: Vec<Anchor<'_>>,
    sources: &SourceCache,
    span: Span,
    budget: usize,
    mut notice: String,
    total: usize,
    known: bool,
    offset: usize,
    prefix: bool,
) -> String {
    selected.sort_unstable_by(anchor_priority);
    let ordered = selected.as_slice();
    let mut blocks = Vec::new();
    blocks_for(&mut blocks, ordered, sources, span, false);
    if blocks.len() <= 2 {
        let mut length = Utf16Length(utf16_len(&notice));
        write_blocks(&mut length, blocks.iter());
        if length.0 <= budget {
            let mut text = String::new();
            write_blocks(&mut text, blocks.iter());
            text.push_str(&notice);
            return text;
        }
    }
    let mut focused = Span { before: span.before.min(FOCUSED_BEFORE), after: span.after.min(FOCUSED_AFTER) };
    // Each pass below decides on the length of the text alone; the text is built once, for the layout that is kept.
    let mut length = focused_length(&mut blocks, ordered, sources, focused, budget, &notice);
    while length > budget && (focused.before > 0 || focused.after > 0) {
        // `shrinkSpan`: the wider side gives first.
        focused = if focused.after > focused.before {
            Span { before: focused.before, after: focused.after - 1 }
        } else {
            Span { before: focused.before.saturating_sub(1), after: focused.after }
        };
        length = focused_length(&mut blocks, ordered, sources, focused, budget, &notice);
    }
    // A prefix page keeps every anchor it was given: the caller shrinks the page instead of dropping anchors out of order.
    let mut shown = ordered.len();
    while !prefix && length > budget && shown > 1 {
        shown -= 1;
        let omitted = total.saturating_sub(offset + shown);
        notice.clear();
        write_paging_notice(&mut notice, shown, total, known, omitted, offset, offset + shown);
        length = focused_length(&mut blocks, &ordered[..shown], sources, focused, budget, &notice);
    }
    render_focused(&mut blocks, &ordered[..shown], sources, focused, budget, &notice)
}
