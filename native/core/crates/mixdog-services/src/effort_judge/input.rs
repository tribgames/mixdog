//! The text the effort judge reads for one tool-result step, normalised the
//! way the model was trained: code fences collapse to a `[code]` marker, tag
//! blocks and colour codes go, long hex runs shorten to 7 characters and
//! whitespace runs collapse. Lengths count code points.

use mixdog_js::JsRegex;
use std::sync::LazyLock;

use mixdog_agent::step_effort::StepInput;


const STEP_CALLS: usize = 3;

static ANSI: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static("\u{1b}\\[[0-9;]*m", "g"));
static FENCE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"```+[\s\S]*?(?:```+|$)", "g"));
static SPACES: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"[ \t]+", "g"));
static BLANK_LINES: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\n[ \t]*\n[\n \t]*", "g"));
static CRLF: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\r\n?", "g"));

/// End of the `<tag ...>...</tag>` block opening at byte `start`, when one does.
fn tag_block_end(text: &str, start: usize) -> Option<usize> {
    let after = &text[start + 1..];
    let first = after.chars().next().filter(char::is_ascii_alphabetic)?;
    let name_len = first.len_utf8()
        + after[first.len_utf8()..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').count();
    let name = &after[..name_len];
    let rest = &after[name_len..];
    let open_len = match rest.chars().next()? {
        '>' => 1,
        ' ' | '\t' | '\r' | '\n' => rest.find('>')? + 1,
        _ => return None,
    };
    let body_start = start + 1 + name_len + open_len;
    let close = format!("</{name}>");
    let found = text[body_start..].find(&close)?;
    Some(body_start + found + close.len())
}

fn strip_tag_blocks(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        if text.as_bytes()[i] == b'<'
            && let Some(end) = tag_block_end(text, i) {
                out.push(' ');
                i = end;
                continue;
            }
        let c = text[i..].chars().next().unwrap_or_default();
        out.push(c);
        i += c.len_utf8();
    }
    out
}

/// A hex run of 12 or more characters standing alone between non-alphanumerics.
fn shorten_hex(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut run = String::new();
    let flush = |run: &mut String, out: &mut String| {
        if run.len() >= 12 && run.chars().all(|c| c.is_ascii_hexdigit()) {
            out.push_str(&run[..7]);
        } else {
            out.push_str(run);
        }
        run.clear();
    };
    for c in text.chars() {
        if c.is_ascii_alphanumeric() {
            run.push(c);
        } else {
            flush(&mut run, &mut out);
            out.push(c);
        }
    }
    flush(&mut run, &mut out);
    out
}

fn clean(text: &str) -> String {
    let text = CRLF.replace_all_with(text, |_| "\n".into());
    let text = ANSI.replace_all_with(&text, |_| String::new());
    let text = FENCE.replace_all_with(&text, |_| " [code] ".into());
    let text = strip_tag_blocks(&text);
    let text = shorten_hex(&text);
    let text = SPACES.replace_all_with(&text, |_| " ".into());
    let text = BLANK_LINES.replace_all_with(&text, |_| "\n".into());
    mixdog_js::js_trim(&text).to_owned()
}

fn head(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

fn tail(text: &str, n: usize) -> String {
    let count = text.chars().count();
    text.chars().skip(count.saturating_sub(n)).collect()
}

/// A result keeps its start and end, where errors and summaries sit.
pub fn step_result_window(text: &str) -> String {
    if text.chars().count() <= 3000 { text.to_owned() } else { format!("{}\n…\n{}", head(text, 2000), tail(text, 1000)) }
}

/// The inputs of a turn judgment (`judgeTurn({ request, prev, prevRequest })`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TurnInput {
    pub request: String,
    /// The last assistant text of the session.
    pub prev: String,
    /// The last user text of the session.
    pub prev_request: String,
}

/// The text layout the model was trained on (`calibration.json` `inputFormat`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum InputFormat {
    /// Previous reply tail (300 units), then the request.
    #[default]
    Pr,
    Rp,
    Rpq,
    Rpc,
    Pack,
}

impl InputFormat {
    /// Any name but the four known ones is `pr`.
    pub fn named(name: &str) -> Self {
        match name {
            "rp" => Self::Rp,
            "rpq" => Self::Rpq,
            "rpc" => Self::Rpc,
            "pack" => Self::Pack,
            _ => Self::Pr,
        }
    }
}

/// `text.slice(-n)`: the last `n` UTF-16 units. A cut inside a surrogate pair leaves a lone low
/// surrogate in JavaScript; a Rust string shows it as U+FFFD.
fn tail_units(text: &str, n: usize) -> String {
    let total = mixdog_js::utf16_len(text);
    if total <= n {
        return text.to_owned();
    }
    let mut skip = total - n;
    let mut chars = text.chars();
    let mut broken = false;
    while skip > 0 {
        let Some(c) = chars.next() else { break };
        let width = c.len_utf16();
        if width > skip {
            broken = true;
            skip = 0;
        } else {
            skip -= width;
        }
    }
    let rest = chars.as_str();
    if broken { format!("\u{fffd}{rest}") } else { rest.to_owned() }
}

/// The client's clip before the text reaches the model: `request.slice(0, 3000)`,
/// `prev.slice(-2000)`, `prevRequest.slice(0, 1200)`, in UTF-16 units.
pub fn clip_turn(input: &TurnInput) -> TurnInput {
    TurnInput {
        request: mixdog_js::slice_utf16(&input.request, 3000),
        prev: tail_units(&input.prev, 2000),
        prev_request: mixdog_js::slice_utf16(&input.prev_request, 1200),
    }
}

/// `judgeText(format, ...)` for the formats that are one text.
pub fn turn_text(format: InputFormat, input: &TurnInput) -> String {
    let TurnInput { request, prev, prev_request } = input;
    match format {
        InputFormat::Rpc => format!("request: {}\nprevious reply: {}", clean(&head(request, 1500)), clean(&tail(prev, 1000))),
        InputFormat::Rpq => format!("request: {}\nprevious request: {}\nprevious reply: {}", head(request, 1500), head(prev_request, 300), tail(prev, 1000)),
        InputFormat::Rp => format!("request: {}\nprevious reply: {}", mixdog_js::slice_utf16(request, 1500), tail_units(prev, 1000)),
        InputFormat::Pr | InputFormat::Pack => format!("previous reply: {}\nrequest: {}", tail_units(prev, 300), mixdog_js::slice_utf16(request, 1500)),
    }
}

/// What the `pack` format assembles from token budgets (`PACK_BUDGET`).
const PACK_REQUEST: usize = 64;
const PACK_PREV_REQUEST: usize = 24;
const PACK_REPLY_HEAD: usize = 16;

/// `packJudgeIds`: the ids between the template's prefix and suffix, each part cleaned, encoded on
/// its own and cut to its budget; the previous reply's end gets what is left.
pub fn pack_ids(tokenizer: &crate::effort_judge::tokenizer::BpeTokenizer, input: &TurnInput, max_tokens: usize) -> Vec<u32> {
    let (prefix, suffix) = (&tokenizer.prefix, &tokenizer.suffix);
    let room = max_tokens.saturating_sub(prefix.len() + suffix.len());
    let cut = |mut ids: Vec<u32>, n: usize| {
        ids.truncate(n);
        ids
    };
    let req = cut(tokenizer.encode(&format!("request: {}", clean(&head(&input.request, 1500)))), PACK_REQUEST);
    let q = if input.prev_request.is_empty() {
        Vec::new()
    } else {
        cut(tokenizer.encode(&format!("previous request: {}", clean(&head(&input.prev_request, 600)))), PACK_PREV_REQUEST)
    };
    let reply = clean(&tail(&input.prev, 1000));
    let (first, rest) = match reply.find('\n') {
        Some(at) => (&reply[..at], &reply[at + 1..]),
        None => (reply.as_str(), ""),
    };
    let top = if first.is_empty() { Vec::new() } else { cut(tokenizer.encode(&format!("previous reply: {first}")), PACK_REPLY_HEAD) };
    let left = room.saturating_sub(req.len() + q.len() + top.len());
    let end = if !rest.is_empty() && left > 0 { tokenizer.encode(rest) } else { Vec::new() };
    let end = &end[end.len().saturating_sub(left)..];
    let mut ids: Vec<u32> = prefix.iter().chain(&req).chain(&q).chain(&top).chain(end).chain(suffix).copied().collect();
    ids.truncate(max_tokens);
    ids
}

pub fn step_judge_text(input: &StepInput) -> String {
    let mut parts = vec![format!("step {}", input.step), format!("request: {}", clean(&head(&input.request, 300)))];
    let said = clean(&tail(&input.plan, 300));
    if !said.is_empty() {
        parts.push(format!("plan: {said}"));
    }
    for call in input.calls.iter().take(STEP_CALLS) {
        parts.push(format!("call: {} {}", call.name, clean(&head(&call.args, 160))));
        let result = clean(&step_result_window(&step_result_window(&call.result)));
        let shown =
            if result.chars().count() > 500 { format!("{} … {}", head(&result, 300), tail(&result, 200)) } else { result };
        parts.push(format!("result: {shown}"));
    }
    parts.join("\n")
}
