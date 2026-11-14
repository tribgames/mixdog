//! `displayModelName(model, provider, hint)` (`runtime/shared/model-display.mjs`): the name a model reads under in a notice, a
//! statusline or a transcript line. The tool surfaces name an agent's model with it.

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_js::slice_utf16;
use mixdog_js::utf16_len;

fn re(pattern: &str) -> JsRegex {
    JsRegex::new_static(pattern, "i")
}

static DATE_DASHED: LazyLock<JsRegex> = LazyLock::new(|| re(r"-\d{4}-\d{2}-\d{2}$"));
static DATE_COMPACT: LazyLock<JsRegex> = LazyLock::new(|| re(r"-\d{8}$"));
static GPT_VERSIONED: LazyLock<JsRegex> = LazyLock::new(|| re(r"^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$"));
static GPT_ANY: LazyLock<JsRegex> = LazyLock::new(|| re(r"^gpt-"));
static OPENAI_O: LazyLock<JsRegex> = LazyLock::new(|| re(r"^o(\d+(?:\.\d+)?)(?:-(.+))?$"));
static CODEX: LazyLock<JsRegex> = LazyLock::new(|| re(r"^codex-(.+)$"));
static DEEPSEEK: LazyLock<JsRegex> = LazyLock::new(|| re(r"^deepseek-(.+)$"));
static GROK: LazyLock<JsRegex> = LazyLock::new(|| re(r"^grok-(.+)$"));
static CLAUDE_LEGACY: LazyLock<JsRegex> = LazyLock::new(|| re(r"^claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku|fable|mythos)(?:-|$)"));
static CLAUDE: LazyLock<JsRegex> = LazyLock::new(|| re(r"^claude-(opus|sonnet|haiku|fable|mythos)-(.+)$"));
static GEMINI: LazyLock<JsRegex> = LazyLock::new(|| re(r"^gemini-(\d+(?:\.\d+)?)-(.+)$"));
static GEMINI_LOOSE: LazyLock<JsRegex> = LazyLock::new(|| re(r"^gemini-(.+)$"));
static VERSIONISH: LazyLock<JsRegex> = LazyLock::new(|| re(r"^[a-z]?\d"));

/// Gateway brands whose ids carry the version inside the first token, with the joiner between the
/// brand and its words.
static SPACED_BRANDS: LazyLock<Vec<(JsRegex, &'static str, &'static str)>> = LazyLock::new(|| {
    vec![
        (re(r"^kimi-(.+)$"), "Kimi", " "),
        (re(r"^qwen(\d.*)$"), "Qwen", ""),
        (re(r"^mimo-(.+)$"), "MiMo", " "),
        (re(r"^muse-spark-(.+)$"), "Muse Spark", " "),
        (re(r"^hy(\d.*)$"), "Hy", ""),
    ]
});
static HYPHENATED_BRANDS: LazyLock<Vec<(JsRegex, &'static str)>> = LazyLock::new(|| {
    vec![(re(r"^glm-(.+)$"), "GLM"), (re(r"^minimax-(.+)$"), "MiniMax"), (re(r"^longcat-(.+)$"), "LongCat")]
});

/// `titleModelPart`.
pub fn title_model_part(part: &str) -> String {
    let text = js_trim(part);
    if text.is_empty() {
        return String::new();
    }
    let lower = js_to_lowercase(text);
    match lower.as_str() {
        "gpt" => return "GPT".to_owned(),
        "api" => return "API".to_owned(),
        "v4" => return "V4".to_owned(),
        _ => {}
    }
    let mut chars = lower.chars();
    let first: String = chars.next().map(|c| c.to_uppercase().collect()).unwrap_or_default();
    format!("{first}{}", chars.as_str())
}

/// `titleModelWords`: a hyphen-separated id tail, title-cased and joined.
fn title_model_words(tail: &str, joiner: &str) -> String {
    tail.split('-').map(title_model_part).filter(|p| !p.is_empty()).collect::<Vec<_>>().join(joiner)
}

/// `stripModelId`: the last non-empty segment of a `vendor/model` id.
fn strip_model_id(model: &str) -> String {
    let text = js_trim(model);
    if !text.contains('/') {
        return text.to_owned();
    }
    text.split('/').rfind(|s| !s.is_empty()).unwrap_or(text).to_owned()
}

/// `brandVersionPart`: version-ish tokens (`k2.7`, `3.8`) upper-case, word tokens title-case; the
/// program-tier token `contributor` says nothing about the model.
fn brand_version_part(part: &str) -> String {
    let text = js_trim(part);
    if text.is_empty() || text.eq_ignore_ascii_case("contributor") {
        return String::new();
    }
    if VERSIONISH.is_match(text) { text.to_uppercase() } else { title_model_part(text) }
}

fn brand_words(tail: &str, joiner: &str) -> String {
    tail.split('-').map(brand_version_part).filter(|p| !p.is_empty()).collect::<Vec<_>>().join(joiner)
}

/// `gatewayBrandDisplay`.
pub fn gateway_brand_display(raw: &str) -> String {
    for (pattern, brand, joiner) in SPACED_BRANDS.iter() {
        if let Some(m) = pattern.captures(raw) {
            return format!("{brand}{joiner}{}", brand_words(m.get(1).unwrap_or_default(), " "));
        }
    }
    for (pattern, brand) in HYPHENATED_BRANDS.iter() {
        if let Some(m) = pattern.captures(raw) {
            return format!("{brand}-{}", brand_words(m.get(1).unwrap_or_default(), "-"));
        }
    }
    String::new()
}

fn without_match(text: &str, pattern: &JsRegex) -> String {
    match pattern.find(text) {
        Some(range) => format!("{}{}", &text[..range.start], &text[range.end..]),
        None => text.to_owned(),
    }
}

/// `canonicalModelDisplay`.
pub fn canonical_model_display(model: &str) -> String {
    let raw = without_match(&without_match(js_trim(model), &DATE_DASHED), &DATE_COMPACT);
    if raw.is_empty() {
        return String::new();
    }
    if let Some(m) = GPT_VERSIONED.captures(&raw) {
        let suffix = m.get(2).map(|tail| format!("-{}", title_model_words(tail, "-"))).unwrap_or_default();
        return format!("GPT-{}{suffix}", m.get(1).unwrap_or_default());
    }
    if GPT_ANY.is_match(&raw) {
        return raw
            .split('-')
            .enumerate()
            .map(|(index, part)| if index == 0 { part.to_uppercase() } else { title_model_part(part) })
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>()
            .join("-");
    }
    if let Some(m) = OPENAI_O.captures(&raw) {
        let tail = m.get(2).map(|tail| format!(" {}", title_model_words(tail, " "))).unwrap_or_default();
        return format!("O{}{tail}", m.get(1).unwrap_or_default());
    }
    for (pattern, brand) in [(&*CODEX, "Codex"), (&*DEEPSEEK, "DeepSeek"), (&*GROK, "Grok")] {
        if let Some(m) = pattern.captures(&raw) {
            return format!("{brand} {}", title_model_words(m.get(1).unwrap_or_default(), " "));
        }
    }
    if let Some(m) = CLAUDE_LEGACY.captures(&raw) {
        let minor = m.get(2).map(|minor| format!(".{minor}")).unwrap_or_default();
        return format!("Claude {} {}{minor}", title_model_part(m.get(3).unwrap_or_default()), m.get(1).unwrap_or_default());
    }
    if let Some(m) = CLAUDE.captures(&raw) {
        return format!("Claude {} {}", title_model_part(m.get(1).unwrap_or_default()), m.get(2).unwrap_or_default().replace('-', "."));
    }
    if let Some(m) = GEMINI.captures(&raw) {
        return format!("Gemini {} {}", m.get(1).unwrap_or_default(), title_model_words(m.get(2).unwrap_or_default(), " "));
    }
    if let Some(m) = GEMINI_LOOSE.captures(&raw) {
        return format!("Gemini {}", title_model_words(m.get(1).unwrap_or_default(), " "));
    }
    let brand = gateway_brand_display(&raw);
    if brand.is_empty() { raw } else { brand }
}

/// `displayKey`: the id folded to lowercase letters and digits.
fn display_key(text: &str) -> String {
    js_to_lowercase(text).chars().filter(char::is_ascii_alphanumeric).collect()
}

/// `displayModelName(model, provider, displayHint)` over a string hint (the provider argument
/// does not change the answer). A hint that is more than the id re-spaced wins; else the id's
/// canonical name; else the hint; else the id.
pub fn display_model_name(model: &str, hint: &str) -> String {
    let id = strip_model_id(model);
    let hint = js_trim(hint);
    if !hint.is_empty() && !id.is_empty() && display_key(hint) != display_key(&id) {
        return hint.to_owned();
    }
    if !id.is_empty() {
        let canonical = canonical_model_display(&id);
        if !canonical.is_empty() && canonical != id {
            return canonical;
        }
    }
    if hint.is_empty() { id } else { hint.to_owned() }
}

static ONE_M_CONTEXT: LazyLock<JsRegex> = LazyLock::new(|| re(r"\s*\(1M context\)"));
static CLAUDE_PREFIX: LazyLock<JsRegex> = LazyLock::new(|| re(r"^Claude\s+"));
static OPENAI_PREFIX: LazyLock<JsRegex> = LazyLock::new(|| re(r"^OpenAI\s+"));

fn is_option_separator(c: char) -> bool {
    mixdog_js::is_js_space(c) || c == '_' || c == '-'
}

/// `titleCaseOption`: each word upper-case first and lower-case rest, the separators (white space, `_`, `-`) kept.
fn title_case_option(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut String| {
        let mut chars = word.chars();
        if let Some(first) = chars.next() {
            out.extend(first.to_uppercase());
            out.push_str(&js_to_lowercase(chars.as_str()));
        }
        word.clear();
    };
    for c in value.chars() {
        if is_option_separator(c) {
            flush(&mut word, &mut out);
            out.push(c);
        } else {
            word.push(c);
        }
    }
    flush(&mut word, &mut out);
    out
}

/// `effortDisplayLabel(value)`: `xhigh` reads `XHigh`, any other effort title-cased; empty for nothing.
pub fn effort_display_label(value: &str) -> String {
    let text = js_trim(value);
    if text.is_empty() {
        return String::new();
    }
    if js_to_lowercase(text) == "xhigh" {
        return "XHigh".to_owned();
    }
    title_case_option(text)
}

/// `shortenModelName(name, cols)`: the name as a narrow footer shows it: `(1M context)` as `(1M)`, no `Claude ` or
/// `OpenAI ` prefix, cut to 18 columns under 80 and 28 under 120 with an ellipsis.
pub fn shorten_model_name(name: &str, cols: f64) -> String {
    let named = if name.is_empty() { "model" } else { name };
    let replaced = match ONE_M_CONTEXT.find(named) {
        Some(range) => format!("{} (1M){}", &named[..range.start], &named[range.end..]),
        None => named.to_owned(),
    };
    let out = without_match(&replaced, &CLAUDE_PREFIX);
    let out = without_match(&out, &OPENAI_PREFIX);
    if cols < 80.0 && utf16_len(&out) > 18 {
        return format!("{}\u{2026}", slice_utf16(&out, 17));
    }
    if cols < 120.0 && utf16_len(&out) > 28 {
        return format!("{}\u{2026}", slice_utf16(&out, 27));
    }
    out
}

#[cfg(test)]
mod display_tests {
    use super::*;

    #[test]
    fn effort_labels_title_case_and_keep_xhigh() {
        assert_eq!(effort_display_label("xhigh"), "XHigh");
        assert_eq!(effort_display_label(" XHIGH "), "XHigh");
        assert_eq!(effort_display_label("medium"), "Medium");
        assert_eq!(effort_display_label("very_high-ish"), "Very_High-Ish");
        assert_eq!(effort_display_label(""), "");
    }

    #[test]
    fn narrow_footers_shorten_the_name() {
        assert_eq!(shorten_model_name("Claude Opus 4.7 (1M context)", 200.0), "Opus 4.7 (1M)");
        assert_eq!(shorten_model_name("OpenAI GPT-5", 200.0), "GPT-5");
        assert_eq!(shorten_model_name("", 200.0), "model");
        assert_eq!(shorten_model_name("A very long model display name indeed", 70.0), "A very long model\u{2026}");
        assert_eq!(shorten_model_name("A very long model display name indeed", 100.0), "A very long model display n\u{2026}");
        assert_eq!(shorten_model_name("A very long model display name indeed", 120.0), "A very long model display name indeed");
    }
}
