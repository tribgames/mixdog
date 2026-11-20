//! Streaming markdown: the settled part of a growing text and its live tail (`src/tui/markdown/streaming-markdown.mjs`),
//! the open-fence scan and the partial closing fence trim (`stream-fence.mjs`), and the in-place patch that turns a
//! streamed block into its final form (`src/ui/stream-finalize.mjs`).
//!
//! The per-stream caches are keyed by the stream key (the assistant message id) and hold at most 32 streams each, the
//! least recently used going first; a text that arrives with no key is resolved without any cache. Offsets are byte
//! offsets of the text; where Node counts UTF-16 units of text it does not hold (token lengths of a text with carriage
//! returns, which the lexer normalises) the units are converted, so the split falls where Node's does.

use std::sync::{Arc, LazyLock, Mutex, PoisonError};

use mixdog_js::{is_js_space, js_trim, utf16_len};
use mixdog_termtext::display_width;
use mixdog_termtext::grapheme::utf16_to_byte;
use mixdog_tui_style::color::visible_width;

use crate::heal::balance_streaming_markdown;
use crate::lexer::rules::Re;
use crate::lexer::{Token, TokenKind, lex};
use crate::render::has_markdown_syntax;

const STABLE_PREFIX_LRU_MAX: usize = 32;
const OPEN_FENCE_SCAN_LRU_MAX: usize = 32;
const CONTAINER_DESCENT_MAX: usize = 64;

/// `touchLru` over a map: the oldest entry first, a touch moves the key to the end, the oldest go past `max`. The caches
/// here also drop a key (`Map.delete`) and clear, which [`crate::lru::Lru`] has no use for.
struct Keyed<V> {
    max: usize,
    entries: Vec<(String, V)>,
}

impl<V> Keyed<V> {
    const fn new(max: usize) -> Self {
        Self { max, entries: Vec::new() }
    }

    /// `cache.get(key)`: no refresh.
    fn get(&self, key: &str) -> Option<&V> {
        self.entries.iter().find(|entry| entry.0 == key).map(|entry| &entry.1)
    }

    fn touch(&mut self, key: &str, value: V) {
        self.remove(key);
        self.entries.push((key.to_owned(), value));
        if self.entries.len() > self.max {
            let surplus = self.entries.len() - self.max;
            self.entries.drain(..surplus);
        }
    }

    fn remove(&mut self, key: &str) {
        self.entries.retain(|entry| entry.0 != key);
    }

    fn clear(&mut self) {
        self.entries.clear();
    }
}

/// `key == null || key === ''` is no key.
fn stream_key_of(stream_key: Option<&str>) -> Option<&str> {
    stream_key.filter(|key| !key.is_empty())
}

// --- stream-fence.mjs ---------------------------------------------------------------------------------------------

/// The tail `code` token, descending through trailing blockquotes and lists (at most 64 levels), or none.
fn tail_code_token(tokens: &mut [Token], depth: usize) -> Option<&mut Token> {
    if depth >= CONTAINER_DESCENT_MAX {
        return None;
    }
    let token = tokens.last_mut()?;
    match token.kind {
        TokenKind::Code => Some(token),
        TokenKind::Blockquote => tail_code_token(token.tokens.as_deref_mut()?, depth + 1),
        TokenKind::List => tail_code_token(token.items.as_deref_mut()?.last_mut()?.tokens.as_deref_mut()?, depth + 1),
        _ => None,
    }
}

/// `trimPartialClosingFences(tokens)`: while a fenced block is still streaming in, the partial closing fence (a lone
/// backtick or two) may arrive as the last code line, which grows the block and shrinks it again; it is cut from the
/// text of the last code token. An indented (list or quote nested) fence is left alone, and a run as long as the
/// opening one is the real closing fence, which the lexer has handled.
pub fn trim_partial_closing_fences(tokens: &mut [Token]) {
    let Some(token) = tail_code_token(tokens, 0) else { return };
    let opening_char = match token.raw.chars().next() {
        Some(c @ ('`' | '~')) => c,
        _ => return,
    };
    let opening = token.raw.chars().take_while(|c| *c == opening_char).count();
    if opening < 3 {
        return;
    }
    let tail = &token.raw[token.raw.rfind('\n').map_or(0, |at| at + 1)..];
    if tail.is_empty() || tail.len() >= opening || tail.chars().any(|c| c != opening_char) {
        return;
    }
    let text = token.text.as_deref().unwrap_or("");
    let kept = &text[..utf16_to_byte(text, utf16_len(text).saturating_sub(tail.len()))];
    let kept = kept.strip_suffix('\n').unwrap_or(kept);
    token.text = Some(kept.to_owned());
}

static OPEN_FENCE_RE: LazyLock<Re> = LazyLock::new(|| Re::new(r"^( {0,3})(`{3,}|~{3,})(.*)$", ""));
static CLOSE_FENCE_RE: LazyLock<Re> = LazyLock::new(|| Re::new(r"^ {0,3}([`~]+)[ \t]*$", ""));

/// An opening fence found by the line scan.
#[derive(Clone)]
struct FenceOpening {
    index: usize,
    indent: usize,
    char: char,
    len: usize,
    lang: String,
}

/// A closing fence: 0 to 3 spaces, a run that starts with the exact opening marker (same character, at least its
/// length; marked lets it go on with any mix of backticks and tildes), then only spaces and tabs.
fn is_closing_fence(line: &str, opening: &FenceOpening) -> bool {
    CLOSE_FENCE_RE.exec(line).and_then(|caps| caps.get(1)).is_some_and(|run| run.starts_with(&opening.char.to_string().repeat(opening.len)))
}

struct Scanned {
    open: Option<FenceOpening>,
    checkpoint_index: usize,
    open_before_checkpoint: Option<FenceOpening>,
}

/// `scanOpenFence(value, startAt, initialOpen)`: the fence still open at the end of `value`, scanning from a line start
/// with the state the fence scan had there. `open_before_checkpoint` is the state at the start of the last line, where a
/// longer text resumes.
fn scan_open_fence(value: &str, start_at: usize, initial_open: Option<FenceOpening>) -> Scanned {
    let mut open = initial_open;
    let mut start = start_at;
    let checkpoint_index = value.rfind('\n').map_or(0, |at| at + 1);
    let mut open_before_checkpoint = if start == checkpoint_index { open.clone() } else { None };
    let bytes = value.as_bytes();
    let mut at = start_at;
    loop {
        if at == bytes.len() || bytes[at] == b'\n' {
            if start == checkpoint_index {
                open_before_checkpoint = open.clone();
            }
            let line = &value[start..at];
            match &open {
                None => {
                    if let Some(caps) = OPEN_FENCE_RE.exec(line) {
                        let marks = caps.get(2).unwrap_or("");
                        let info = caps.get(3).unwrap_or("");
                        let char = marks.chars().next().unwrap_or('`');
                        // A backtick fence's info string may not contain a backtick.
                        if !(char == '`' && info.contains('`')) {
                            open = Some(FenceOpening {
                                index: start,
                                indent: caps.get(1).unwrap_or("").len(),
                                char,
                                len: marks.len(),
                                lang: js_trim(info).to_owned(),
                            });
                        }
                    }
                }
                Some(opening) => {
                    if is_closing_fence(line, opening) {
                        open = None;
                    }
                }
            }
            start = at + 1;
        }
        if at == bytes.len() {
            break;
        }
        at += 1;
    }
    Scanned { open, checkpoint_index, open_before_checkpoint }
}

struct ScanEntry {
    text: String,
    checkpoint_index: usize,
    open_before_checkpoint: Option<FenceOpening>,
    result: Option<OpenFence>,
}

static OPEN_FENCE_SCANS: Mutex<Keyed<ScanEntry>> = Mutex::new(Keyed::new(OPEN_FENCE_SCAN_LRU_MAX));

/// The open top-level fenced block of a text: where its fence line starts and its language.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenFence {
    /// The byte offset of the first character of the fence line.
    pub index: usize,
    pub lang: String,
}

/// `findOpenFenceStart(text, streamKey)`: the currently open (unclosed) fenced block that can be split off cheaply, by a
/// plain line scan, so a growing open block does not run the lexer on every delta (its closing-fence rule never matches
/// and backtracks over the whole body). Only a top-level fence (its line at column 0) is reported: it is always a fresh
/// top-level block, everything before it is complete blocks, and the split changes nothing in the rendering. An
/// indented (maybe list or quote nested) open fence gives none, and the caller lexes the whole text.
pub fn find_open_fence_start(text: &str, stream_key: Option<&str>) -> Option<OpenFence> {
    let key = stream_key_of(stream_key);
    let mut scans = OPEN_FENCE_SCANS.lock().unwrap_or_else(PoisonError::into_inner);
    let resume = match key.and_then(|key| scans.get(key)) {
        Some(cached) if cached.text == text => return cached.result.clone(),
        Some(cached) if text.starts_with(&cached.text) => Some((cached.checkpoint_index, cached.open_before_checkpoint.clone())),
        _ => None,
    };
    let scanned = match resume {
        Some((checkpoint, open)) => scan_open_fence(text, checkpoint, open),
        None => scan_open_fence(text, 0, None),
    };
    // Only unambiguously top-level (column 0) fences take the fast path.
    let result = scanned.open.as_ref().filter(|opening| opening.indent == 0).map(|opening| OpenFence { index: opening.index, lang: opening.lang.clone() });
    if let Some(key) = key {
        scans.touch(
            key,
            ScanEntry {
                text: text.to_owned(),
                checkpoint_index: scanned.checkpoint_index,
                open_before_checkpoint: scanned.open_before_checkpoint,
                result: result.clone(),
            },
        );
    }
    result
}

/// `resetOpenFenceScan(streamKey)`.
pub fn reset_open_fence_scan(stream_key: &str) {
    if !stream_key.is_empty() {
        OPEN_FENCE_SCANS.lock().unwrap_or_else(PoisonError::into_inner).remove(stream_key);
    }
}

/// `resetAllOpenFenceScans()`.
pub fn reset_all_open_fence_scans() {
    OPEN_FENCE_SCANS.lock().unwrap_or_else(PoisonError::into_inner).clear();
}

/// The tokens of the growing tail of a stream as `lexMarkdown(content, { trimPartialFences: true })` of `render-ansi.mjs`
/// lexes them: an open top-level fenced block is not lexed (the text before it is, and the block is one code token built
/// from the raw fence text, marked `plain` so it renders flat until its closing fence arrives), and the partial closing
/// fence of the last code block is cut. The tokens are transient and never cached.
pub fn lex_streaming_tail(text: &str) -> Vec<Token> {
    let mut tokens = match find_open_fence_start(text, None) {
        Some(open) => {
            let post = &text[open.index..];
            let mut code = Token::new(TokenKind::Code, post);
            code.lang = Some(open.lang);
            code.text = Some(post.find('\n').map_or("", |newline| &post[newline + 1..]).to_owned());
            code.plain = Some(true);
            let before = &text[..open.index];
            let mut tokens = if before.is_empty() { Vec::new() } else { lex(before).tokens };
            tokens.push(code);
            tokens
        }
        None => lex(text).tokens,
    };
    trim_partial_closing_fences(&mut tokens);
    tokens
}

// --- streaming-markdown.mjs ---------------------------------------------------------------------------------------

/// `streamingLayoutText(text)`: the text without its leading and trailing newlines (in lockstep with the streaming row
/// estimate).
pub fn streaming_layout_text(text: &str) -> &str {
    text.trim_matches('\n')
}

/// The settled and the live part of a streaming text.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StreamingParts {
    /// No markdown syntax in the text: it is one live tail, drawn as plain text.
    pub plain: bool,
    /// The text ends inside a top-level fenced block, which is the live tail (drawn flat).
    pub open_fence: bool,
    /// The settled blocks, which are lexed and rendered once.
    pub stable_prefix: String,
    /// The settled blocks as the chunks they arrived in.
    pub stable_chunks: Vec<Arc<str>>,
    /// The live tail: the text after the settled blocks.
    pub unstable_suffix: String,
    /// The live tail with its unfinished tokens closed ([`balance_streaming_markdown`]), or as it is when it is plain or
    /// an open fence.
    pub unstable_for_render: String,
}

/// `streamingStableChunks(parts)`: the settled chunks of resolved parts; render and row measurement share this split.
pub fn streaming_stable_chunks(parts: &StreamingParts) -> Vec<Arc<str>> {
    if !parts.stable_chunks.is_empty() {
        return parts.stable_chunks.clone();
    }
    if parts.stable_prefix.is_empty() { Vec::new() } else { vec![Arc::from(parts.stable_prefix.as_str())] }
}

#[derive(Clone, Default)]
struct StableState {
    text: String,
    chunks: Vec<Arc<str>>,
}

struct SyntaxEntry {
    text: String,
    value: bool,
}

struct ResolvedEntry {
    text: String,
    parts: Arc<StreamingParts>,
}

struct Caches {
    stable_prefix: Keyed<StableState>,
    markdown_syntax: Keyed<SyntaxEntry>,
    plain_window_syntax: Keyed<SyntaxEntry>,
    /// The current normalised-text split, reused across measure, render and harvest.
    resolved: Keyed<ResolvedEntry>,
}

static CACHES: Mutex<Caches> = Mutex::new(Caches {
    stable_prefix: Keyed::new(STABLE_PREFIX_LRU_MAX),
    markdown_syntax: Keyed::new(STABLE_PREFIX_LRU_MAX),
    plain_window_syntax: Keyed::new(STABLE_PREFIX_LRU_MAX),
    resolved: Keyed::new(STABLE_PREFIX_LRU_MAX),
});

fn lock_caches() -> std::sync::MutexGuard<'static, Caches> {
    CACHES.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `cachedStreamingHasMarkdownSyntax`: the syntax probe of a growing text. A text that extends the cached one is only
/// probed from the start of its last cached line (the newline before it included), a probe that found syntax stays
/// true.
fn cached_has_markdown_syntax(cache: &mut Keyed<SyntaxEntry>, text: &str, key: Option<&str>) -> bool {
    let Some(key) = key else { return has_markdown_syntax(text) };
    let value = match cache.get(key) {
        Some(previous) if text.starts_with(&previous.text) => previous.value || has_markdown_syntax(&text[previous.text.rfind('\n').unwrap_or(0)..]),
        _ => has_markdown_syntax(text),
    };
    cache.touch(key, SyntaxEntry { text: text.to_owned(), value });
    value
}

/// `windowPlainStreamingText(text, columns, maxRows, streamKey)`: the last `max_rows` display rows of a plain streaming
/// text at `columns` columns (80 when 0), cut at a line start; a text with markdown syntax or no row budget is returned
/// whole.
pub fn window_plain_streaming_text(text: &str, columns: usize, max_rows: usize, stream_key: Option<&str>) -> String {
    let value = streaming_layout_text(text);
    let key = stream_key_of(stream_key);
    if value.is_empty() || max_rows == 0 || cached_has_markdown_syntax(&mut lock_caches().plain_window_syntax, value, key) {
        return value.to_owned();
    }
    let width = if columns == 0 { 80 } else { columns };
    let mut rows = 0;
    let mut end = value.len();
    let mut start = end;
    loop {
        let newline = value[..end].rfind('\n');
        let line_start = newline.map_or(0, |at| at + 1);
        let line_rows = display_width(&value[line_start..end]).div_ceil(width).max(1);
        if rows > 0 && rows + line_rows > max_rows {
            break;
        }
        rows += line_rows;
        start = line_start;
        match newline {
            Some(at) if rows < max_rows => end = at,
            _ => break,
        }
    }
    value[start..].to_owned()
}

/// `isWhitespaceOnlyText`.
fn is_whitespace_only(text: &str) -> bool {
    text.chars().all(is_js_space)
}

/// `stableStateForText(text, previous)`: the settled state for `text`, as one more chunk when it extends the previous
/// one, as its own single chunk when it does not.
fn stable_state_for_text(text: &str, previous: StableState) -> StableState {
    if text.is_empty() {
        return StableState::default();
    }
    if let Some(appended) = text.strip_prefix(previous.text.as_str()) {
        if appended.is_empty() {
            return previous;
        }
        let mut chunks = previous.chunks;
        chunks.push(Arc::from(appended));
        return StableState { text: text.to_owned(), chunks };
    }
    StableState { text: text.to_owned(), chunks: vec![Arc::from(text)] }
}

fn cache_resolved(caches: &mut Caches, key: Option<&str>, text: &str, parts: StreamingParts) -> Arc<StreamingParts> {
    let parts = Arc::new(parts);
    if let Some(key) = key {
        caches.resolved.touch(key, ResolvedEntry { text: text.to_owned(), parts: Arc::clone(&parts) });
    }
    parts
}

/// `resetStreamingMarkdownStablePrefix(streamKey)`: forgets everything cached for the stream.
pub fn reset_streaming_markdown_stable_prefix(stream_key: &str) {
    if stream_key.is_empty() {
        return;
    }
    {
        let mut caches = lock_caches();
        caches.stable_prefix.remove(stream_key);
        caches.markdown_syntax.remove(stream_key);
        caches.plain_window_syntax.remove(stream_key);
        caches.resolved.remove(stream_key);
    }
    reset_open_fence_scan(stream_key);
}

/// `resetAllStreamingMarkdownStablePrefixes()`.
pub fn reset_all_streaming_markdown_stable_prefixes() {
    {
        let mut caches = lock_caches();
        caches.stable_prefix.clear();
        caches.markdown_syntax.clear();
        caches.plain_window_syntax.clear();
        caches.resolved.clear();
    }
    reset_all_open_fence_scans();
}

/// `resolveStreamingMarkdownParts(text, streamKey)`: the settled blocks of a growing text and its live tail. The settled
/// prefix is kept per stream and only grows while the text extends it. A text with no markdown syntax is plain. A text
/// that ends inside a top-level fenced block splits at the fence line by a line scan, and the lexer never runs on the
/// growing block. Otherwise the lexer runs on the part after the settled prefix, and every block but the last content
/// block settles.
pub fn resolve_streaming_markdown_parts(text: &str, stream_key: Option<&str>) -> Arc<StreamingParts> {
    let layout = streaming_layout_text(text);
    let key = stream_key_of(stream_key);
    let mut caches = lock_caches();
    if let Some(key) = key
        && let Some(entry) = caches.resolved.get(key)
        && entry.text == layout
    {
        return Arc::clone(&entry.parts);
    }
    if layout.is_empty() {
        if let Some(key) = key {
            caches.stable_prefix.remove(key);
        }
        return cache_resolved(&mut caches, key, layout, StreamingParts { plain: true, ..StreamingParts::default() });
    }
    if !cached_has_markdown_syntax(&mut caches.markdown_syntax, layout, key) {
        if let Some(key) = key {
            caches.stable_prefix.remove(key);
        }
        let plain = StreamingParts { plain: true, unstable_suffix: layout.to_owned(), unstable_for_render: layout.to_owned(), ..StreamingParts::default() };
        return cache_resolved(&mut caches, key, layout, plain);
    }

    let mut state = match key.and_then(|key| caches.stable_prefix.get(key).cloned().map(|state| (key, state))) {
        Some((key, state)) => {
            caches.stable_prefix.touch(key, state.clone());
            state
        }
        None => StableState::default(),
    };
    if !layout.starts_with(&state.text) {
        state = StableState::default();
    }

    // Open-fence fast path: never lex a growing unclosed code block. The text before the fence line is settled markdown,
    // lexed and rendered once; the open block is drawn flat until its closing fence lands.
    if let Some(open) = find_open_fence_start(layout, key) {
        let mut open_prefix = &layout[..open.index];
        if is_whitespace_only(open_prefix) {
            open_prefix = "";
        }
        state = stable_state_for_text(open_prefix, state);
        if let Some(key) = key {
            if open_prefix.is_empty() {
                caches.stable_prefix.remove(key);
            } else {
                caches.stable_prefix.touch(key, state.clone());
            }
        }
        let suffix = layout[open_prefix.len()..].to_owned();
        let parts = StreamingParts {
            plain: false,
            open_fence: true,
            stable_prefix: open_prefix.to_owned(),
            stable_chunks: state.chunks,
            unstable_for_render: suffix.clone(),
            unstable_suffix: suffix,
        };
        return cache_resolved(&mut caches, key, layout, parts);
    }

    let boundary = state.text.len();
    let tokens = lex(&layout[boundary..]).tokens;
    let is_space = |token: &Token| token.kind == TokenKind::Space;
    let first_content = tokens.iter().position(|token| !is_space(token)).unwrap_or(tokens.len());
    let last_content = tokens.iter().rposition(|token| !is_space(token));
    // The blocks before the last content block are settled. Token lengths are UTF-16 units of the lexer's normalised
    // text, as in Node.
    let advance: usize = match last_content {
        Some(last) if first_content < last => tokens[first_content..last].iter().map(|token| utf16_len(&token.raw)).sum(),
        _ => 0,
    };
    let mut stable_prefix = state.text.clone();
    if advance > 0 {
        let end = boundary + utf16_to_byte(&layout[boundary..], advance);
        stable_prefix = layout[..end].to_owned();
        if is_whitespace_only(&stable_prefix) {
            stable_prefix.clear();
        }
        state = stable_state_for_text(&stable_prefix, state);
        if let Some(key) = key {
            if stable_prefix.is_empty() {
                caches.stable_prefix.remove(key);
            } else {
                caches.stable_prefix.touch(key, state.clone());
            }
        }
    }
    if is_whitespace_only(&stable_prefix) {
        stable_prefix.clear();
        state = StableState::default();
    }
    let unstable_suffix = layout[stable_prefix.len()..].to_owned();
    let parts = StreamingParts {
        plain: false,
        open_fence: false,
        stable_prefix,
        stable_chunks: state.chunks,
        unstable_for_render: balance_streaming_markdown(&unstable_suffix),
        unstable_suffix,
    };
    cache_resolved(&mut caches, key, layout, parts)
}

// --- stream-finalize.mjs ------------------------------------------------------------------------------------------

/// A patch that rewrites a streamed terminal block in place.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StreamFinalPatch {
    /// The cursor moves and row rewrites; empty when nothing changed.
    pub output: String,
    pub changed_rows: usize,
    pub total_rows: usize,
}

/// `buildStreamFinalPatch(rawText, renderedText, { columns })`: a conservative in-place patch from the streamed rows to
/// the final-format rows. Logical rows must map one to one to physical rows: a text with carriage returns, a different
/// row count, or a row as wide as the terminal (`columns`, 80 when 0) gives none, and the caller redraws in full.
pub fn build_stream_final_patch(raw_text: &str, rendered_text: &str, columns: usize) -> Option<StreamFinalPatch> {
    if raw_text.contains('\r') || rendered_text.contains('\r') {
        return None;
    }
    let raw_lines: Vec<&str> = raw_text.split('\n').collect();
    let rendered_lines: Vec<&str> = rendered_text.split('\n').collect();
    if raw_lines.len() != rendered_lines.len() {
        return None;
    }
    let width = if columns == 0 { 80 } else { columns };
    if raw_lines.iter().zip(&rendered_lines).any(|(raw, rendered)| visible_width(raw) >= width || visible_width(rendered) >= width) {
        return None;
    }
    let total_rows = raw_lines.len();
    let changed_rows = raw_lines.iter().zip(&rendered_lines).filter(|(raw, rendered)| raw != rendered).count();
    if changed_rows == 0 {
        return Some(StreamFinalPatch { output: String::new(), changed_rows: 0, total_rows });
    }
    let mut output = String::from("\r");
    for index in (0..total_rows).rev() {
        if raw_lines[index] != rendered_lines[index] {
            output.push_str("\x1b[2K");
            output.push_str(rendered_lines[index]);
        }
        if index > 0 {
            output.push_str("\r\x1b[1A");
        }
    }
    if total_rows > 1 {
        output.push_str(&format!("\r\x1b[{}B", total_rows - 1));
        let last_width = visible_width(rendered_lines[total_rows - 1]);
        if last_width > 0 {
            output.push_str(&format!("\x1b[{last_width}C"));
        }
    }
    Some(StreamFinalPatch { output, changed_rows, total_rows })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts(text: &str, key: &str) -> Arc<StreamingParts> {
        resolve_streaming_markdown_parts(text, Some(key))
    }

    fn code_token(raw: &str, text: &str) -> Token {
        let mut token = Token::new(TokenKind::Code, raw);
        token.text = Some(text.to_owned());
        token
    }

    #[test]
    fn a_partial_closing_fence_is_cut_from_the_last_code_token_and_a_real_one_is_not() {
        let mut tokens = vec![code_token("```js\nlet a;\n``", "let a;\n``")];
        trim_partial_closing_fences(&mut tokens);
        assert_eq!(tokens[0].text.as_deref(), Some("let a;"));

        let mut full = vec![code_token("```js\nlet a;\n```", "let a;")];
        trim_partial_closing_fences(&mut full);
        assert_eq!(full[0].text.as_deref(), Some("let a;"));

        let mut other_char = vec![code_token("```js\nlet a;\n~", "let a;\n~")];
        trim_partial_closing_fences(&mut other_char);
        assert_eq!(other_char[0].text.as_deref(), Some("let a;\n~"));

        let mut indented = vec![code_token("  ```js\nx\n``", "x\n``")];
        trim_partial_closing_fences(&mut indented);
        assert_eq!(indented[0].text.as_deref(), Some("x\n``"));
    }

    #[test]
    fn the_trim_reaches_a_code_token_through_trailing_quotes_and_lists() {
        let mut tokens = lex("> ```js
> let a;
> ``")
        .tokens;
        trim_partial_closing_fences(&mut tokens);
        assert_eq!(tokens[0].kind, TokenKind::Blockquote);
        assert_eq!(tokens[0].children().last().map(Token::text_str), Some("let a;"));

        let mut listed = lex("- a
  ```js
  x
  ``")
        .tokens;
        trim_partial_closing_fences(&mut listed);
        let item = &listed[0].items.as_deref().unwrap_or(&[])[0];
        assert_eq!(item.children().last().map(Token::text_str), Some("x"));
    }

    #[test]
    fn the_open_fence_scan_reports_only_top_level_fences_and_resumes_from_its_checkpoint() {
        assert_eq!(find_open_fence_start("text\n```rust\nfn", None), Some(OpenFence { index: 5, lang: "rust".to_owned() }));
        assert_eq!(find_open_fence_start("text\n```rust\nfn\n```", None), None);
        assert_eq!(find_open_fence_start("```\n```\n~~~ x\n", None), Some(OpenFence { index: 8, lang: "x".to_owned() }));
        assert_eq!(find_open_fence_start("- item\n  ```js\n  x", None), None);
        assert_eq!(find_open_fence_start("```a`b\ncode", None), None);
        // A longer closing run closes it, a shorter one does not.
        assert_eq!(find_open_fence_start("````\n```\nx", None).map(|open| open.index), Some(0));
        assert_eq!(find_open_fence_start("```\nx\n````", None), None);

        let key = Some("fence-scan-resume");
        let text = "intro\n\n```py\nprint(1)\nprint(2)";
        let mut grown = String::new();
        for ch in text.chars() {
            grown.push(ch);
            let cached = find_open_fence_start(&grown, key);
            assert_eq!(cached, find_open_fence_start(&grown, None), "at {grown:?}");
        }
        reset_open_fence_scan("fence-scan-resume");
    }

    #[test]
    fn the_streaming_tail_lexes_around_an_open_fence_and_trims_a_partial_closing_fence() {
        let tokens = lex_streaming_tail("# t\n\n```js\nlet a;\n``");
        let last = tokens.last();
        assert_eq!(last.map(|token| token.kind), Some(TokenKind::Code));
        assert_eq!(last.and_then(|token| token.plain), Some(true));
        assert_eq!(last.and_then(|token| token.lang.as_deref()), Some("js"));
        assert_eq!(last.map(Token::text_str), Some("let a;"));
        assert_eq!(lex_streaming_tail("```js").last().map(Token::text_str), Some(""));
        let settled = lex_streaming_tail("```js\nlet a;\n```\n");
        assert_eq!(settled[0].plain, None);
    }

    #[test]
    fn plain_text_is_one_live_tail_and_blocks_settle_behind_the_last_one() {
        let plain = parts("\nhello world\n", "plain-1");
        assert!(plain.plain);
        assert_eq!(plain.unstable_suffix, "hello world");
        assert_eq!(plain.unstable_for_render, "hello world");
        assert!(plain.stable_prefix.is_empty());

        let key = "settle-1";
        let growing = parts("# Title\n\nfirst **para", key);
        assert!(!growing.plain);
        assert_eq!(growing.stable_prefix, "# Title\n\n");
        assert_eq!(growing.unstable_suffix, "first **para");
        assert_eq!(growing.unstable_for_render, "first **para**");
        let more = parts("# Title\n\nfirst **para** done\n\nsecond", key);
        assert_eq!(more.stable_prefix, "# Title\n\nfirst **para** done\n\n");
        assert_eq!(more.stable_chunks.iter().map(|chunk| &**chunk).collect::<Vec<_>>(), ["# Title\n\n", "first **para** done\n\n"]);
        assert_eq!(more.unstable_suffix, "second");
        // The same text again is the cached split.
        assert!(Arc::ptr_eq(&more, &parts("# Title\n\nfirst **para** done\n\nsecond", key)));
        // A text that does not extend the settled prefix starts over.
        let other = parts("another\n\ntext", key);
        assert_eq!(other.stable_prefix, "another\n\n");
        reset_streaming_markdown_stable_prefix(key);
        reset_streaming_markdown_stable_prefix("plain-1");
    }

    #[test]
    fn an_open_fence_is_the_live_tail_and_what_precedes_it_settles() {
        let open = parts("intro\n\n```js\nlet a = 1;\nlet b", "fence-1");
        assert!(open.open_fence);
        assert_eq!(open.stable_prefix, "intro\n\n");
        assert_eq!(open.unstable_suffix, "```js\nlet a = 1;\nlet b");
        assert_eq!(open.unstable_for_render, open.unstable_suffix);
        let bare = parts("```js\nlet a", "fence-2");
        assert!(bare.open_fence);
        assert!(bare.stable_prefix.is_empty());
        assert_eq!(streaming_stable_chunks(&bare).len(), 0);
        assert_eq!(streaming_stable_chunks(&open).len(), 1);
        reset_streaming_markdown_stable_prefix("fence-1");
        reset_streaming_markdown_stable_prefix("fence-2");
    }

    #[test]
    fn a_whole_text_with_no_key_is_resolved_without_caches() {
        let first = resolve_streaming_markdown_parts("a\n\nb", None);
        let second = resolve_streaming_markdown_parts("a\n\nb", Some(""));
        assert_eq!(*first, *second);
        assert_eq!(first.stable_prefix, "a\n\n");
    }

    #[test]
    fn a_keyed_cache_keeps_its_most_recent_entries_and_forgets_a_dropped_key() {
        let mut cache: Keyed<u32> = Keyed::new(STABLE_PREFIX_LRU_MAX);
        for at in 0..40 {
            cache.touch(&format!("lru-{at}"), at);
        }
        assert_eq!(cache.entries.len(), 32);
        assert!(cache.get("lru-7").is_none());
        assert_eq!(cache.get("lru-8"), Some(&8));
        cache.touch("lru-8", 80);
        cache.touch("lru-40", 40);
        assert_eq!(cache.get("lru-8"), Some(&80));
        assert!(cache.get("lru-9").is_none());
        cache.remove("lru-8");
        assert!(cache.get("lru-8").is_none());
        cache.clear();
        assert!(cache.entries.is_empty());
    }

    #[test]
    fn a_plain_text_is_windowed_to_its_last_rows_by_display_width() {
        let text = "one\ntwo two two two\n日本語日本語\nlast";
        assert_eq!(window_plain_streaming_text(text, 10, 3, None), "日本語日本語\nlast");
        assert_eq!(window_plain_streaming_text(text, 10, 1, None), "last");
        assert_eq!(window_plain_streaming_text(text, 10, 0, None), text);
        assert_eq!(window_plain_streaming_text("# heading\nx", 10, 1, None), "# heading\nx");
        assert_eq!(window_plain_streaming_text("\n\n", 10, 2, None), "");
        assert_eq!(window_plain_streaming_text("a\nb", 0, 5, Some("win-1")), "a\nb");
        reset_streaming_markdown_stable_prefix("win-1");
    }

    #[test]
    fn the_final_patch_rewrites_the_changed_rows_in_place() {
        assert_eq!(build_stream_final_patch("a\nb", "a\nb", 80), Some(StreamFinalPatch { output: String::new(), changed_rows: 0, total_rows: 2 }));
        let patch = build_stream_final_patch("a\n**b**", "a\nB", 80);
        assert_eq!(patch, Some(StreamFinalPatch { output: "\r\x1b[2KB\r\x1b[1A\r\x1b[1B\x1b[1C".to_owned(), changed_rows: 1, total_rows: 2 }));
        assert_eq!(build_stream_final_patch("a", "b", 80).map(|patch| patch.output), Some("\r\x1b[2Kb".to_owned()));
        assert_eq!(build_stream_final_patch("a\nb", "a", 80), None);
        assert_eq!(build_stream_final_patch("a\r\nb", "a\nb", 80), None);
        assert_eq!(build_stream_final_patch("0123456789", "x", 10), None);
        assert!(build_stream_final_patch("0123456789", "x", 11).is_some());
    }
}
