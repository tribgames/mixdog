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
