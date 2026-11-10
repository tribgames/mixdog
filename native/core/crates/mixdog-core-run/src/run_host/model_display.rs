//! `displayModelName(model, provider, hint)` (`runtime/shared/model-display.mjs`): the name a
//! model reads under in a notice, a statusline or a transcript line. The hop's notice and its
//! "tried" lines name models with it (`routeLabel`).

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_trim;

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
fn title_model_part(part: &str) -> String {
    let text = js_trim(part);
    if text.is_empty() {
        return String::new();
    }
    let lower = text.to_lowercase();
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
    text.split('/').filter(|s| !s.is_empty()).next_back().unwrap_or(text).to_owned()
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
fn gateway_brand_display(raw: &str) -> String {
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
fn canonical_model_display(model: &str) -> String {
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
    text.to_lowercase().chars().filter(char::is_ascii_alphanumeric).collect()
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

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    const GOLDEN: &str = include_str!("../../../../fixtures/hop-host/golden.json");

    /// Every model id and hint the recorder tried reads as Node's `displayModelName` reads it.
    #[test]
    fn every_name_is_the_one_node_shows() {
        let golden: Value = serde_json::from_str(GOLDEN).unwrap();
        let cases = golden["display"].as_array().unwrap();
        assert!(cases.len() > 200);
        for case in cases {
            let (model, hint) = (case["model"].as_str().unwrap(), case["hint"].as_str().unwrap());
            assert_eq!(display_model_name(model, hint), case["name"].as_str().unwrap(), "{model:?} with hint {hint:?}");
        }
    }
}