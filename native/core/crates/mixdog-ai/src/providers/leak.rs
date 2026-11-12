//! Leaked tool-call recovery (`providers/lib/leaked-toolcall.mjs`).
//!
//! A model sometimes writes a tool call as plain assistant text (`<invoke …>`,
//! `<function_calls>`, Gemma `<function name=…>`, gpt-oss harmony
//! `<|channel|>…to=functions.NAME…<|call|>`) instead of a structured call.
//! The scanner suppresses the tags from the visible text and, when the payload
//! names a tool the request offered, recovers a real call. Everything else is
//! kept as text. The decoders feed their text through a [`LeakGuard`] and
//! dispatch what it recovers through a [`Dedupe`].

use std::collections::HashSet;
use std::sync::LazyLock;

use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::ToolExclusionReport;
use mixdog_core_api::domain::provider::ToolExclusionSink;
use mixdog_core_api::domain::provider::WireCodec;
use regex::Regex;
use serde_json::Map;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

/// JS `\s` (and so `String.prototype.trim`): not Rust's `\s`, which adds U+0085 and lacks U+FEFF.
const WS_IN: &str = r"\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}";
/// JS `\b`: ASCII word boundary.
const B: &str = r"(?-u:\b)";

/// A pattern for `/…/i`: every ASCII letter of `word` matches both cases only (JS ignoreCase does not fold
/// `ſ` to `s` or the Kelvin sign to `k`, which Rust's `(?i)` would).
fn ci(word: &str) -> String {
    let mut out = String::new();
    for ch in word.chars() {
        if ch.is_ascii_alphabetic() {
            out.push('[');
            out.push(ch.to_ascii_lowercase());
            out.push(ch.to_ascii_uppercase());
            out.push(']');
        } else {
            out.push(ch);
        }
    }
    out
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("leak pattern")
}

fn ws() -> String {
    format!("[{WS_IN}]")
}

/// `["']?([^"'>\s]+)["']?` — a possibly quoted attribute value.
fn value() -> String {
    format!(r#"["']?([^"'>{WS_IN}]+)["']?"#)
}

fn antml() -> String {
    format!("(?:{})?", ci("antml:"))
}

static SENTINEL: LazyLock<Regex> = LazyLock::new(|| {
    let (a, w) = (antml(), ws());
    re(&format!(
        "<{a}{fc}{B}|<{a}{inv}{B}|<{a}{f}{B}[^>]*{B}{n}{w}*=",
        fc = ci("function_calls"),
        inv = ci("invoke"),
        f = ci("function"),
        n = ci("name"),
    ))
});
static HARMONY_SENTINEL: LazyLock<Regex> =
    LazyLock::new(|| re(&format!(r"<\|(?:{}|{})\|>", ci("channel"), ci("start"))));
static HARMONY_TERMINATOR: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(r"<\|{}\|>|<\|{}\|>|<\|{}\|>", ci("call"), ci("end"), ci("return")))
});
static HARMONY_RECIPIENT: LazyLock<Regex> =
    LazyLock::new(|| re(&format!(r"{}={}\.([A-Za-z0-9_.-]+)", ci("to"), ci("functions"))));
static HARMONY_MESSAGE: LazyLock<Regex> = LazyLock::new(|| re(&format!(r"<\|{}\|>", ci("message"))));
static HARMONY_START: LazyLock<Regex> =
    LazyLock::new(|| re(&format!(r"^<\|(?:{}|{})\|>", ci("channel"), ci("start"))));
static WRAPPER_OPEN: LazyLock<Regex> =
    LazyLock::new(|| re(&format!("^<{}{}{B}[^>]*>", antml(), ci("function_calls"))));
static WRAPPER_CLOSE: LazyLock<Regex> =
    LazyLock::new(|| re(&format!("</{}{}{}*>", antml(), ci("function_calls"), ws())));
static INVOKE_OPEN: LazyLock<Regex> = LazyLock::new(|| re(&format!("^<{}{}{B}[^>]*>", antml(), ci("invoke"))));
static INVOKE_CLOSE: LazyLock<Regex> = LazyLock::new(|| re(&format!("</{}{}{}*>", antml(), ci("invoke"), ws())));
static FUNCTION_OPEN: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!("^<{}{}{B}[^>]*{B}{}{w}*={w}*{}[^>]*>", antml(), ci("function"), ci("name"), value(), w = ws()))
});
static FUNCTION_CLOSE: LazyLock<Regex> =
    LazyLock::new(|| re(&format!("</{}{}{}*>", antml(), ci("function"), ws())));
static PARAMETER: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        r"<{a}{p}{B}[^>]*{B}{n}{w}*={w}*{v}[^>]*>([\s\S]*?)</{a}{p}{w}*>",
        a = antml(),
        p = ci("parameter"),
        n = ci("name"),
        w = ws(),
        v = value(),
    ))
});
static INVOKE_NAME: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!("<{}{}{B}[^>]*{B}{}{w}*={w}*{}", antml(), ci("invoke"), ci("name"), value(), w = ws()))
});

const OPENERS: [&str; 3] = ["<function_calls", "<invoke", "<function"];
const HARMONY_OPENERS: [&str; 2] = ["<|channel|>", "<|start|>"];
/// The longest opener, in UTF-16 units (the openers are ASCII, so bytes), as Node derives it
/// (`Math.max(...OPENERS.map((o) => o.length), ...HARMONY_OPENERS.map((o) => o.length))`): an opener added to either list
/// is covered by `partial_tail` without touching this.
const LONGEST_OPENER: usize = {
    let (mut longest, mut i) = (0, 0);
    while i < OPENERS.len() {
        longest = if OPENERS[i].len() > longest { OPENERS[i].len() } else { longest };
        i += 1;
    }
    i = 0;
    while i < HARMONY_OPENERS.len() {
        longest = if HARMONY_OPENERS[i].len() > longest { HARMONY_OPENERS[i].len() } else { longest };
        i += 1;
    }
    longest
};

/// A call recovered from text, before an id is minted.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Recovered {
    pub name: String,
    pub arguments: Map<String, Value>,
}

/// Markdown code-fence / inline-code state across chunks: a tag inside code is a documentation example.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Fence {
    fence_char: Option<char>,
    fence_len: usize,
    inline_len: usize,
    at_line_start: bool,
}

impl Default for Fence {
    fn default() -> Self {
        Self { fence_char: None, fence_len: 0, inline_len: 0, at_line_start: true }
    }
}

impl Fence {
    fn in_code(&self) -> bool {
        self.fence_char.is_some() || self.inline_len > 0
    }

    /// `advanceFenceState`.
    fn advance(mut self, text: &str) -> Self {
        let chars: Vec<char> = text.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            let ch = chars[i];
            if ch == '`' || ch == '~' {
                let mut j = i;
                while j < chars.len() && chars[j] == ch {
                    j += 1;
                }
                let run = j - i;
                if let Some(fence) = self.fence_char {
                    if ch == fence && self.at_line_start && run >= self.fence_len {
                        self.fence_char = None;
                        self.fence_len = 0;
                    }
                } else if self.inline_len > 0 {
                    if ch == '`' && run == self.inline_len {
                        self.inline_len = 0;
                    }
                } else if self.at_line_start && run >= 3 {
                    self.fence_char = Some(ch);
                    self.fence_len = run;
                } else if ch == '`' {
                    self.inline_len = run;
                }
                self.at_line_start = false;
                i = j;
                continue;
            }
            if ch == '\n' {
                self.at_line_start = true;
                self.inline_len = 0;
                i += 1;
                continue;
            }
            if self.at_line_start && (ch == ' ' || ch == '\t') {
                i += 1;
                continue;
            }
            self.at_line_start = false;
            i += 1;
        }
        self
    }
}

fn first_sentinel(s: &str, harmony: bool) -> Option<usize> {
    let mut at = SENTINEL.find(s).map(|m| m.start());
    let harmonic = if harmony { HARMONY_SENTINEL.find(s).map(|m| m.start()) } else { None };
    if let Some(h) = harmonic
        && at.is_none_or(|i| h < i)
    {
        at = Some(h);
    }
    at
}

fn is_opener_prefix(tail: &str, harmony: bool) -> bool {
    if !tail.is_ascii() {
        return false;
    }
    let t = tail.to_ascii_lowercase();
    OPENERS.iter().any(|o| o.starts_with(&t)) || (harmony && HARMONY_OPENERS.iter().any(|o| o.starts_with(&t)))
}

/// `partialTailIndex`: where the tail of `s` could be the start of a sentinel still arriving.
fn partial_tail(s: &str, harmony: bool) -> usize {
    // Only suffixes of at most LONGEST_OPENER UTF-16 units can match; measuring every suffix of
    // the buffer made one long delta quadratic (300 000 characters took 86 s).
    let mut start = s.len();
    let mut units = 0;
    for (i, c) in s.char_indices().rev() {
        units += c.len_utf16();
        if units > LONGEST_OPENER {
            break;
        }
        start = i;
    }
    s[start..].char_indices().map(|(i, _)| start + i).find(|&i| is_opener_prefix(&s[i..], harmony)).unwrap_or(s.len())
}

/// `coerceValue`: JSON-looking scalars and objects parse; anything else is the raw string.
fn coerce(raw: &str) -> Value {
    let trimmed = mixdog_js::js_trim(raw);
    if let Some(first) = trimmed.chars().next()
        && "{[0123456789tfn\"-".contains(first)
        && let Ok(value) = serde_json::from_str::<Value>(trimmed)
    {
        return value;
    }
    Value::String(raw.to_owned())
}

fn parse_params(text: &str) -> Map<String, Value> {
    let mut out = Map::new();
    for caps in PARAMETER.captures_iter(text) {
        out.insert(caps[1].to_owned(), coerce(&caps[2]));
    }
    out
}

fn parse_invoke(text: &str) -> Option<Recovered> {
    let name = INVOKE_NAME.captures(text)?[1].to_owned();
    Some(Recovered { name, arguments: parse_params(text) })
}

struct Block {
    end: usize,
    call: Option<Recovered>,
}

fn harmony_block(s: &str, idx: usize) -> Option<Block> {
    let rest = &s[idx..];
    if !HARMONY_START.is_match(rest) {
        return None;
    }
    let term = HARMONY_TERMINATOR.find(rest)?;
    let end = idx + term.end();
    let block = &rest[..term.start()];
    let Some(recipient) = HARMONY_RECIPIENT.captures(block) else {
        return Some(Block { end, call: None });
    };
    let mut arguments = Map::new();
    if let Some(message) = HARMONY_MESSAGE.find(block) {
        let raw = mixdog_js::js_trim(&block[message.end()..]);
        if !raw.is_empty()
            && let Value::Object(map) = coerce(raw)
        {
            arguments = map;
        }
    }
    Some(Block { end, call: Some(Recovered { name: recipient[1].to_owned(), arguments }) })
}

/// `matchCompleteBlockAt`: `None` while the block has not finished arriving.
fn complete_block(s: &str, idx: usize, harmony: bool) -> Option<Block> {
    let rest = &s[idx..];
    if harmony && HARMONY_START.is_match(rest) {
        return harmony_block(s, idx);
    }
    if let Some(open) = WRAPPER_OPEN.find(rest) {
        let close = WRAPPER_CLOSE.find(rest)?;
        let inner = rest.get(open.end()..close.start()).unwrap_or("");
        return Some(Block { end: idx + close.end(), call: parse_invoke(inner) });
    }
    if INVOKE_OPEN.is_match(rest) {
        let close = INVOKE_CLOSE.find(rest)?;
        return Some(Block { end: idx + close.end(), call: parse_invoke(&rest[..close.end()]) });
    }
    if let Some(caps) = FUNCTION_OPEN.captures(rest) {
        let close = FUNCTION_CLOSE.find(rest)?;
        let open_end = caps.get(0).map_or(0, |m| m.end());
        let inner = rest.get(open_end..close.start()).unwrap_or("");
        return Some(Block {
            end: idx + close.end(),
            call: Some(Recovered { name: caps[1].to_owned(), arguments: parse_params(inner) }),
        });
    }
    None
}

/// What one scan produced.
pub struct Scan {
    pub emit: String,
    pub calls: Vec<Recovered>,
    pub rest: String,
    pub fence: Fence,
}

/// `scanLeakedToolCalls`.
pub fn scan(buffer: &str, is_known: &dyn Fn(&str) -> bool, last: bool, harmony: bool, fence: Fence) -> Scan {
    let mut emit = String::new();
    let mut calls = Vec::new();
    let mut fence = fence;
    let mut pos = 0;
    let consume = |to: usize, as_text: bool, pos: &mut usize, emit: &mut String, fence: &mut Fence| {
        if as_text {
            *fence = fence.advance(&buffer[*pos..to]);
            emit.push_str(&buffer[*pos..to]);
        }
        *pos = to;
    };
    while pos < buffer.len() {
        let Some(rel) = first_sentinel(&buffer[pos..], harmony) else {
            if last {
                consume(buffer.len(), true, &mut pos, &mut emit, &mut fence);
            } else {
                let hold = partial_tail(&buffer[pos..], harmony);
                consume(pos + hold, true, &mut pos, &mut emit, &mut fence);
            }
            break;
        };
        let idx = pos + rel;
        consume(idx, true, &mut pos, &mut emit, &mut fence);
        let in_code = fence.in_code();
        let Some(block) = complete_block(buffer, idx, harmony) else {
            if last {
                consume(buffer.len(), true, &mut pos, &mut emit, &mut fence);
                break;
            }
            if in_code {
                // The opener char is emitted and scanning goes on, one JS char (code unit) wide.
                let step = buffer[idx..].chars().next().map_or(1, char::len_utf8);
                consume(idx + step, true, &mut pos, &mut emit, &mut fence);
                continue;
            }
            break;
        };
        if !in_code && let Some(call) = block.call.filter(|c| !c.name.is_empty() && is_known(&c.name)) {
            consume(block.end, false, &mut pos, &mut emit, &mut fence);
            calls.push(call);
            continue;
        }
        consume(block.end, true, &mut pos, &mut emit, &mut fence);
    }
    Scan { emit, calls, rest: buffer[pos..].to_owned(), fence }
}

/// `createLeakGuard`: the rolling window over a stream's text.
pub struct LeakGuard {
    known: HashSet<String>,
    harmony: bool,
    buffer: String,
    fence: Fence,
}

impl LeakGuard {
    pub fn new(known: HashSet<String>, harmony: bool) -> Self {
        Self { known, harmony, buffer: String::new(), fence: Fence::default() }
    }

    /// No tool was offered, so no text is ever scanned.
    pub fn enabled(&self) -> bool {
        !self.known.is_empty()
    }

    /// Visible text safe to forward now and the calls recovered from the window.
    pub fn push(&mut self, delta: &str, last: bool) -> (String, Vec<Recovered>) {
        if !self.enabled() {
            return (delta.to_owned(), Vec::new());
        }
        self.buffer.push_str(delta);
        if self.buffer.is_empty() && !last {
            return (String::new(), Vec::new());
        }
        let known = &self.known;
        let scanned = scan(&self.buffer, &|name: &str| known.contains(name), last, self.harmony, self.fence);
        self.buffer = scanned.rest;
        self.fence = scanned.fence;
        (scanned.emit, scanned.calls)
    }

    pub fn flush(&mut self) -> (String, Vec<Recovered>) {
        self.push("", true)
    }

    /// `scrubAssistantText`: the whole text scanned once, with no fence state carried in.
    pub fn scrub(&self, raw: &str) -> (String, Vec<Recovered>) {
        if raw.is_empty() || !self.enabled() {
            return (raw.to_owned(), Vec::new());
        }
        let known = &self.known;
        let scanned = scan(raw, &|name: &str| known.contains(name), true, false, Fence::default());
        (format!("{}{}", scanned.emit, scanned.rest), scanned.calls)
    }
}

fn objectish(arguments: &Value) -> Value {
    match arguments {
        Value::Object(_) => arguments.clone(),
        _ => Value::Object(Map::new()),
    }
}

/// `traceHash(stableTraceStringify(value))`: the first 16 hex digits of SHA-256 over the canonical text.
fn trace_hash(value: &Value) -> String {
    let digest = Sha256::digest(mixdog_js::json_stringify_sorted(value).as_bytes());
    digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect()
}

/// `toolCallFingerprint`.
pub fn fingerprint(name: &str, arguments: &Value) -> String {
    trace_hash(&serde_json::json!({ "name": name, "args": objectish(arguments) }))
}

fn is_synthetic(id: &str) -> bool {
    id.contains("_leaked_")
}

/// `createToolCallDedupe`: one dispatch per call across the leaked and native paths.
#[derive(Default)]
pub struct Dedupe {
    seen: HashSet<String>,
    leaked: HashSet<String>,
    ids: HashSet<String>,
}

impl Dedupe {
    /// True the first time this call should be dispatched. A provider-assigned id is the identity of a real
    /// call; no id or a minted `_leaked_` id is identified by its name+arguments fingerprint.
    pub fn should_dispatch(&mut self, name: &str, arguments: &Value, id: &str) -> bool {
        let fp = fingerprint(name, arguments);
        if id.is_empty() || is_synthetic(id) {
            if self.seen.contains(&fp) {
                return false;
            }
            self.seen.insert(fp.clone());
            self.leaked.insert(fp);
            return true;
        }
        if !self.ids.insert(id.to_owned()) {
            return false;
        }
        if self.leaked.remove(&fp) {
            return false;
        }
        self.seen.insert(fp);
        true
    }
}

/// `dedupeToolCallList`: a repeated id, a synthetic leak the native path already carries, or an id-less exact
/// repeat is dropped; the first occurrence wins and order is kept.
pub fn dedupe_list(calls: Vec<ToolCall>) -> Vec<ToolCall> {
    if calls.len() < 2 {
        return calls;
    }
    let native: HashSet<String> = calls
        .iter()
        .filter(|c| !c.id.is_empty() && !is_synthetic(&c.id))
        .map(|c| fingerprint(&c.name, &c.arguments))
        .collect();
    let mut ids = HashSet::new();
    let mut synthetic = HashSet::new();
    let mut out = Vec::new();
    for call in calls {
        if !call.id.is_empty() && !is_synthetic(&call.id) {
            if ids.insert(call.id.clone()) {
                out.push(call);
            }
            continue;
        }
        let fp = fingerprint(&call.name, &call.arguments);
        if native.contains(&fp) || !synthetic.insert(fp) {
            continue;
        }
        out.push(call);
    }
    out
}

fn random_id(prefix: &str) -> String {
    let bytes: [u8; 8] = crate::random::bytes();
    format!("{prefix}{:016x}", u64::from_be_bytes(bytes))
}

fn leaked_call(id: String, recovered: Recovered) -> ToolCall {
    ToolCall { id, name: recovered.name, arguments: Value::Object(recovered.arguments), native_type: None }
}

/// `synthLeakedOpenAICall`: the Responses and chat id shape.
pub fn openai_call(recovered: Recovered) -> ToolCall {
    leaked_call(random_id("call_leaked_"), recovered)
}

/// The Anthropic leak guard's id shape.
pub fn anthropic_call(recovered: Recovered) -> ToolCall {
    leaked_call(random_id("toolu_leaked_"), recovered)
}

/// The Gemini guard's id: a hash of the call itself, so the same leak always has the same id.
pub fn gemini_call(recovered: Recovered) -> ToolCall {
    let hash = trace_hash(&serde_json::json!({
        "name": recovered.name,
        "args": recovered.arguments,
        "leak": true,
    }));
    leaked_call(format!("gemini_leaked_{hash}"), recovered)
}

/// Where a tool's name sits in the request body.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ToolNames {
    /// `knownToolNamesFromOpenAITools`: `function.name`, else a top-level `name`.
    Chat,
    /// A top-level `name` (Anthropic, Responses).
    Named,
}

/// The tool names of the exact request body a codec sends, so a recovered call only names a tool the model was
/// offered. Encoded again with exclusions discarded: the real encode already reported them.
pub fn body_tool_names(codec: &dyn WireCodec, request: &ModelRequest, shape: ToolNames) -> HashSet<String> {
    let mut quiet = request.clone();
    quiet.options.on_tool_excluded = Some(ToolExclusionSink(std::sync::Arc::new(|_report: ToolExclusionReport| {})));
    let Ok(wire) = codec.encode(&quiet) else {
        return HashSet::new();
    };
    let Ok(body) = serde_json::from_slice::<Value>(&wire.body) else {
        return HashSet::new();
    };
    let tools = body.get("tools").and_then(Value::as_array).cloned().unwrap_or_default();
    tools
        .iter()
        .filter_map(|tool| {
            let nested = (shape == ToolNames::Chat).then(|| tool.pointer("/function/name").and_then(Value::as_str));
            match nested.flatten() {
                Some(name) => Some(name),
                None => tool.get("name").and_then(Value::as_str),
            }
        })
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .collect()
}

/// The names of the tools a Gemini-shaped request offers (`tools?.map(t => t.name).filter(Boolean)`).
pub fn request_tool_names(request: &ModelRequest) -> HashSet<String> {
    request.tools.iter().filter(|t| !t.name.is_empty()).map(|t| t.name.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `partialTailIndex` before it was limited to the last `LONGEST_OPENER` units: the first suffix of the whole buffer that could
    /// start an opener. The windowed `partial_tail` must give the same index for every buffer (no opener is longer than the window).
    fn every_suffix(s: &str, harmony: bool) -> usize {
        s.char_indices().map(|(i, _)| i).find(|&i| is_opener_prefix(&s[i..], harmony)).unwrap_or(s.len())
    }

    fn openers() -> impl Iterator<Item = &'static str> {
        OPENERS.iter().chain(HARMONY_OPENERS.iter()).copied()
    }

    #[test]
    fn the_window_is_the_longest_listed_opener() {
        assert_eq!(openers().map(str::len).max(), Some(LONGEST_OPENER));
        assert!(openers().all(|opener| opener.is_ascii()), "the window counts bytes as UTF-16 units only while the openers are ASCII");
    }

    /// Every opener, cut at every length, after text of every width around the window (a multi-byte character, an astral one, a `<`
    /// that opens nothing): the held tail is the one a search of every suffix finds, an opener of the full window length ending
    /// at the end of the buffer included.
    #[test]
    fn the_windowed_tail_is_the_one_every_suffix_finds() {
        let mut leads: Vec<String> = ["", "x", "é", "日本", "😀", "😀😀", "<", "<<", "a<fun", "é<invoke>é"].map(str::to_owned).into();
        leads.extend([LONGEST_OPENER - 1, LONGEST_OPENER, LONGEST_OPENER + 1].map(|width| "y".repeat(width)));
        for harmony in [false, true] {
            for opener in openers() {
                for cut in 1..=opener.len() {
                    for lead in &leads {
                        for tail in [&opener[..cut], &opener[..cut].to_ascii_uppercase()] {
                            let s = format!("{lead}{tail}");
                            assert_eq!(partial_tail(&s, harmony), every_suffix(&s, harmony), "harmony {harmony}, buffer {s:?}");
                        }
                    }
                }
            }
        }
    }

    /// A text pushed in three deltas split at every pair of character boundaries (an opener split over three deltas included, with a
    /// multi-byte and an astral character before it) gives, once flushed, the same visible text and the same calls as the text pushed
    /// whole.
    #[test]
    fn an_opener_split_over_three_deltas_is_held_until_it_completes() {
        let call = r#"<function_calls><invoke name="read"><parameter name="path">a.txt</parameter></invoke></function_calls>"#;
        let known = || ["read".to_owned()].into_iter().collect::<HashSet<_>>();
        // (A bare `<function ` is held only as far as `<function`: once a delta ends after the space, Node's `partialTailIndex`
        // lets it go as text before `name=` arrives, so a text with a Gemma-style block is not split-invariant in Node either.)
        for text in [format!("é{call}"), format!("😀 {call} ok"), format!("ab <invoke name=\"read\"></invoke> {call}")] {
            let whole = {
                let mut guard = LeakGuard::new(known(), false);
                let (mut emit, mut calls) = guard.push(&text, false);
                let (rest, more) = guard.flush();
                emit.push_str(&rest);
                calls.extend(more);
                (emit, calls)
            };
            let bounds: Vec<usize> = text.char_indices().map(|(i, _)| i).chain(std::iter::once(text.len())).collect();
            for (a, &i) in bounds.iter().enumerate() {
                for &j in &bounds[a..] {
                    let mut guard = LeakGuard::new(known(), false);
                    let (mut emit, mut calls) = (String::new(), Vec::new());
                    for part in [&text[..i], &text[i..j], &text[j..]] {
                        let (shown, recovered) = guard.push(part, false);
                        emit.push_str(&shown);
                        calls.extend(recovered);
                    }
                    let (rest, more) = guard.flush();
                    emit.push_str(&rest);
                    calls.extend(more);
                    assert_eq!((&emit, &calls), (&whole.0, &whole.1), "split at {i} and {j} of {text:?}");
                }
            }
        }
    }
}
