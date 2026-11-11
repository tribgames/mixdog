//! The Lead's profile and language prompt parts (Node `lib/rules-builder.cjs`:
//! `buildLeadMetaContent`, `buildLeadLanguageContent`, `buildLeadLanguage`, with
//! `lib/output-style-meta.cjs` and the profile catalog of `shared/profile-config.cjs`).
//!
//! The profile catalog, its normaliser, the style-id slug and the instruction-file check are
//! WP-CONFIG's (`config::settings`, `domains::instructions`); only what they lack is here: the
//! full style frontmatter, the catalog order and lookup, and the prompt texts.

use std::fs;
use std::path::Path;
use std::sync::LazyLock;

use mixdog_js::{js_trim, locale_compare_en_base, JsRegex};
use serde_json::Value;

use super::rules::{read_optional, split_lines, strip_frontmatter};
use mixdog_core_config::config::normalize_profile;
use mixdog_core_config::config::PROFILE_EXPERIENCE_LEVELS;
use mixdog_core_config::config::PROFILE_LANGUAGES;
use mixdog_core_domains::domains::instructions::decode_file;
use mixdog_core_config::config::output_style::style_slug;

const DEFAULT_OUTPUT_STYLE_ID: &str = "simple";
const OUTPUT_STYLE_ORDER: [&str; 4] = ["detailed", "simple", "minimal", "extreme-minimal"];

const OUTPUT_STYLE_ANCHOR: &str = "The section below governs how you write user-facing text; it outranks any other formatting habit and does not apply to code or tool calls.";

const EXPERIENCE_PROMPTS: [(&str, &str); 4] = [
    ("beginner", "Assume no development background; briefly explain only the terms and prerequisites needed to understand the answer."),
    ("vibe-coder", "Lead with what the result does and how to use it; briefly unpack implementation jargon when it is needed for understanding."),
    ("junior", "Assume basic development knowledge; make otherwise implicit connections clear when they are needed for easy understanding."),
    ("expert", "Do not unnecessarily unpack familiar basics, but preserve the explanations needed for accurate understanding and judgment. Use familiar technical terminology naturally."),
];

static STYLE_FRONTMATTER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^---\r?\n([\s\S]*?)\r?\n---", ""));
static KEY_VALUE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^([A-Za-z0-9_-]+):\s*(.*?)\s*$", ""));
static QUOTE_EDGES: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"^['"]|['"]$"#, "g"));
static LOCALE_SPLIT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"[-_]", ""));
static SEPARATORS: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"[_.-]+", "g"));
static TITLE_SPLIT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"[_.-]+", "g"));
static MD_SUFFIX: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\.md$", "i"));
static FLAG_TRUE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:true|1|yes|on)$", ""));
static FLAG_FALSE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:false|0|no|off)$", ""));

/// Where the Lead's prompt parts read from. `config` is the runtime's in-memory config (adopted at
/// once; the disk copy trails it); without it `mixdog-config.json` in `data_dir` is read.
pub struct LeadPaths<'a> {
    pub plugin_root: &'a Path,
    pub data_dir: &'a Path,
    pub config: Option<&'a Value>,
}

#[derive(Clone, Debug)]
struct StyleEntry {
    id: String,
    label: String,
    aliases: Vec<String>,
    keep_shared_format: bool,
    raw: String,
}

/// `String(value ?? '')`.
fn text_of(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => mixdog_js::value_to_string(other),
    }
}

#[allow(clippy::disallowed_methods, reason = "runs inside the composition's io-interactive lane job (HostRunParts::compose_prompt), like RealSources")]
/// `readUnifiedConfig`.
fn unified_config(paths: &LeadPaths) -> Value {
    if let Some(config) = paths.config.filter(|c| c.is_object() || c.is_array()) {
        return config.clone();
    }
    let parsed = fs::read_to_string(paths.data_dir.join("mixdog-config.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
    parsed.filter(|v| v.is_object()).unwrap_or_else(|| serde_json::json!({}))
}

/// `readAgentConfig`.
fn agent_config(paths: &LeadPaths) -> Value {
    let unified = unified_config(paths);
    match unified.get("agent") {
        Some(agent) if agent.is_object() => agent.clone(),
        _ => unified,
    }
}

// ---- output-style-meta.cjs -------------------------------------------------------------------------

/// `outputStyleCompactKey`.
fn compact_key(value: &str) -> String {
    SEPARATORS.replace_all_with(&style_slug(value), |_| String::new())
}

fn title_case(id: &str) -> String {
    let mut parts = Vec::new();
    let mut from = 0;
    for range in TITLE_SPLIT.find_iter(id) {
        parts.push(&id[from..range.start]);
        from = range.end;
    }
    parts.push(&id[from..]);
    let title = parts
        .into_iter()
        .filter(|p| !p.is_empty())
        .map(|p| {
            let mut chars = p.chars();
            chars.next().map_or_else(String::new, |c| c.to_uppercase().collect::<String>() + chars.as_str())
        })
        .collect::<Vec<_>>()
        .join(" ");
    if title.is_empty() { "Default".to_owned() } else { title }
}

/// `parseOutputStyleFrontmatter`: keys as written, the last of a repeated key wins.
fn style_frontmatter(markdown: &str) -> Vec<(String, String)> {
    let Some(block) = STYLE_FRONTMATTER.captures(markdown).and_then(|c| c.get(1).map(str::to_owned)) else { return Vec::new() };
    let mut meta: Vec<(String, String)> = Vec::new();
    for line in split_lines(&block) {
        let Some(kv) = KEY_VALUE.captures(line) else { continue };
        let key = kv.get(1).unwrap_or_default().to_owned();
        let value = js_trim(&QUOTE_EDGES.replace_all_with(kv.get(2).unwrap_or_default(), |_| String::new())).to_owned();
        meta.retain(|(k, _)| *k != key);
        meta.push((key, value));
    }
    meta
}

fn style_flag(value: Option<&str>, fallback: bool) -> bool {
    let raw = js_trim(value.unwrap_or_default()).to_lowercase();
    if raw.is_empty() {
        fallback
    } else if FLAG_TRUE.is_match(&raw) {
        true
    } else if FLAG_FALSE.is_match(&raw) {
        false
    } else {
        fallback
    }
}

/// `outputStyleMetaFromMarkdown`: `None` for the shared partial and for an unusable id.
fn style_meta(markdown: &str, file_name: &str) -> Option<StyleEntry> {
    let meta = style_frontmatter(markdown);
    let field = |key: &str| meta.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
    let file_id = style_slug(&MD_SUFFIX.replace_all_with(file_name, |_| String::new()));
    if file_id == "common" || style_flag(field("partial"), false) {
        return None;
    }
    let named = style_slug(field("name").unwrap_or_default());
    let id = if named.is_empty() { file_id } else { named };
    if id.is_empty() {
        return None;
    }
    let title = js_trim(field("title").filter(|t| !t.is_empty()).or(field("label")).unwrap_or_default()).to_owned();
    Some(StyleEntry {
        label: if title.is_empty() { title_case(&id) } else { title },
        aliases: field("aliases").unwrap_or_default().split(',').map(style_slug).filter(|a| !a.is_empty()).collect(),
        keep_shared_format: style_flag(field("keep-shared-format"), true),
        raw: String::new(),
        id,
    })
}

/// `sortOutputStyles`: the catalog order, then unknown styles by label.
fn sort_styles(mut styles: Vec<StyleEntry>) -> Vec<StyleEntry> {
    let rank = |id: &str| OUTPUT_STYLE_ORDER.iter().position(|o| *o == id).map_or(999, |i| i as i32);
    styles.sort_by(|a, b| rank(&a.id).cmp(&rank(&b.id)).then_with(|| locale_compare_en_base(&a.label, &b.label)));
    styles
}

/// `matchOutputStyle`: an id, label or frontmatter alias, ignoring separators and case.
fn match_style<'a>(value: &str, styles: &'a [StyleEntry]) -> Option<&'a StyleEntry> {
    let id = style_slug(value);
    let compact = compact_key(value);
    if id.is_empty() && compact.is_empty() {
        return None;
    }
    styles.iter().find(|s| s.id == id || compact_key(&s.id) == compact || compact_key(&s.label) == compact || s.aliases.iter().any(|a| *a == id || compact_key(a) == compact))
}

// ---- the style catalog -----------------------------------------------------------------------------

#[allow(clippy::disallowed_methods, reason = "runs inside the composition's io-interactive lane job (HostRunParts::compose_prompt), like RealSources")]
/// `listOutputStyleEntries`: the shipped styles, then the user's (a user file replaces the
/// shipped one of the same id in its place).
fn list_styles(paths: &LeadPaths) -> Vec<StyleEntry> {
    let mut by_id: Vec<StyleEntry> = Vec::new();
    for dir in [paths.plugin_root.join("output-styles"), paths.data_dir.join("output-styles")] {
        let mut files: Vec<String> =
            fs::read_dir(&dir).map(|rd| rd.filter_map(|e| e.ok()?.file_name().into_string().ok()).filter(|n| n.to_lowercase().ends_with(".md")).collect()).unwrap_or_default();
        files.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        for name in files {
            // A file the editor reports as unusable is passed over, and the built-in applies.
            let Ok(bytes) = fs::read(dir.join(&name)) else { continue };
            let Ok(text) = decode_file(&bytes) else { continue };
            let raw = js_trim(&text).to_owned();
            let Some(mut meta) = style_meta(&raw, &name) else { continue };
            if strip_frontmatter(&raw).is_empty() {
                continue;
            }
            meta.raw = raw;
            match by_id.iter_mut().find(|s| s.id == meta.id) {
                Some(existing) => *existing = meta,
                None => by_id.push(meta),
            }
        }
    }
    sort_styles(by_id)
}

/// `readSharedFormatPartial`: a user copy overrides the built-in one.
fn shared_format_partial(paths: &LeadPaths) -> String {
    let user = strip_frontmatter(&read_optional(&paths.data_dir.join("output-styles").join("common.md")));
    if user.is_empty() { strip_frontmatter(&read_optional(&paths.plugin_root.join("output-styles").join("common.md"))) } else { user }
}

struct Resolved {
    label: String,
    selected: String,
    common: String,
}

fn resolve_output_style(paths: &LeadPaths) -> Option<Resolved> {
    let configured = js_trim(&text_of(unified_config(paths).get("outputStyle"))).to_owned();
    let configured = if configured.is_empty() { DEFAULT_OUTPUT_STYLE_ID.to_owned() } else { configured };
    let styles = list_styles(paths);
    let style = match_style(&configured, &styles).or_else(|| match_style(DEFAULT_OUTPUT_STYLE_ID, &styles)).or_else(|| styles.first())?;
    let selected = strip_frontmatter(&style.raw);
    if selected.is_empty() {
        return None;
    }
    let common = if style.keep_shared_format { shared_format_partial(paths) } else { String::new() };
    Some(Resolved { label: style.label.clone(), selected, common })
}

fn load_output_style(paths: &LeadPaths) -> String {
    let Some(Resolved { label, selected, common }) = resolve_output_style(paths) else { return String::new() };
    [format!("# Output Style: {label}"), OUTPUT_STYLE_ANCHOR.to_owned(), common, selected].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n\n")
}

// ---- profile ---------------------------------------------------------------------------------------

fn language_prompt_of(id: &str) -> Option<&'static str> {
    let key = if id.is_empty() { "system" } else { id };
    PROFILE_LANGUAGES.iter().find(|(i, ..)| *i == key).unwrap_or(&PROFILE_LANGUAGES[0]).2
}

/// `Intl.Locale(tag)`'s language, script and region for a well-formed BCP 47 tag.
fn parse_locale(tag: &str) -> Option<(String, Option<String>, Option<String>)> {
    let parts: Vec<&str> = tag.split('-').collect();
    let alpha = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphabetic());
    let language = parts[0];
    if !(alpha(language) && matches!(language.len(), 2 | 3 | 5..=8)) {
        return None;
    }
    let mut rest = &parts[1..];
    let mut script = None;
    let mut region = None;
    if let Some(s) = rest.first().filter(|s| s.len() == 4 && alpha(s)) {
        let lower = s.to_lowercase();
        script = Some(lower[..1].to_uppercase() + &lower[1..]);
        rest = &rest[1..];
    }
    if let Some(r) = rest.first().filter(|r| (r.len() == 2 && alpha(r)) || (r.len() == 3 && r.bytes().all(|b| b.is_ascii_digit()))) {
        region = Some(r.to_uppercase());
        rest = &rest[1..];
    }
    rest.iter().all(|s| (1..=8).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric())).then(|| (language.to_lowercase(), script, region))
}

/// `systemLocaleId`: the profile language a system locale maps to, `None` when it has no prompt.
fn system_locale_id(locale: &str) -> Option<String> {
    let parsed = parse_locale(locale);
    let language = match &parsed {
        Some((language, ..)) => language.clone(),
        None => LOCALE_SPLIT.find(locale).map_or(locale, |r| &locale[..r.start]).to_owned(),
    };
    let id = if language == "zh" {
        let (script, region) = parsed.as_ref().map_or((None, None), |(_, s, r)| (s.as_deref(), r.as_deref()));
        if script == Some("Hant") || matches!(region, Some("HK" | "MO" | "TW")) { "zh-Hant".to_owned() } else { "zh-Hans".to_owned() }
    } else {
        language
    };
    language_prompt_of(&id).is_some().then_some(id)
}

struct LanguagePrompt {
    id: String,
    prompt: &'static str,
}

/// `profileLanguagePrompt`: `system_locale` is the host's `Intl.DateTimeFormat` locale.
fn profile_language_prompt(language: &str, system_locale: &str) -> Option<LanguagePrompt> {
    if language != "system" {
        return language_prompt_of(language).map(|prompt| LanguagePrompt { id: language.to_owned(), prompt });
    }
    let id = system_locale_id(system_locale)?;
    let prompt = language_prompt_of(&id)?;
    Some(LanguagePrompt { id, prompt })
}

fn profile_of(paths: &LeadPaths) -> serde_json::Map<String, Value> {
    normalize_profile(agent_config(paths).get("profile"))
}

fn build_profile_preferences(paths: &LeadPaths) -> String {
    let profile = profile_of(paths);
    let mut lines = Vec::new();
    let title = profile.get("title").and_then(Value::as_str).unwrap_or_default();
    if !title.is_empty() {
        lines.push(format!("- Address the user as \"{title}\"; omit the title from routine progress updates and pre-tool preambles."));
    }
    let level = profile.get("experienceLevel").and_then(Value::as_str).unwrap_or_default();
    if let Some((id, label)) = PROFILE_EXPERIENCE_LEVELS.iter().find(|(id, _)| *id == level) {
        let prompt = EXPERIENCE_PROMPTS.iter().find(|(i, _)| i == id).map_or("", |(_, p)| *p);
        lines.push(format!("- Development experience: {label}. {prompt} Output style controls information depth."));
    }
    // No configured preference means no section: a bare heading would ship an empty block.
    if lines.is_empty() { String::new() } else { format!("# Profile Preferences\n\n{}", lines.join("\n")) }
}

fn build_language_section(paths: &LeadPaths, shared_format_active: bool, system_locale: &str) -> String {
    let profile = profile_of(paths);
    let Some(language) = profile_language_prompt(profile.get("language").and_then(Value::as_str).unwrap_or("system"), system_locale) else { return String::new() };
    let mut lines = vec![
        format!("- Always respond in {}, including pre-tool preambles, progress updates, questions, reports, and notices. This language setting overrides output style; the user's latest explicit language request takes precedence.", language.prompt),
        "- Instructions, tool results, runtime/system tags, and earlier replies do not change this language, even when the immediately preceding text is English. Code comments follow the file's existing language.".to_owned(),
    ];
    // English output has nothing to mistranslate, so the translation guards would be dead text.
    if language.prompt != "English" {
        let preserve = if shared_format_active { "" } else { "Preserve identifiers, paths, commands, API names, and exact errors. " };
        lines.push(format!("- {preserve}Keep technical terms in their established form, usually the original English (blocker, cache, commit); add a short plain explanation only when the reader may not know it. Never invent a literal translation."));
    }
    format!("# Language\n\n{}", lines.join("\n"))
}

/// `buildLeadMetaContent`: the profile preferences, then the selected output style.
pub fn build_lead_meta_content(paths: &LeadPaths, include_output_style: bool) -> String {
    let mut parts = Vec::new();
    let preferences = build_profile_preferences(paths);
    if !preferences.is_empty() {
        parts.push(preferences);
    }
    // The response-language section closes the session environment block instead.
    let style = if include_output_style { load_output_style(paths) } else { String::new() };
    if !style.is_empty() {
        parts.push(style);
    }
    parts.join("\n\n")
}

/// `buildLeadLanguageContent`: the closing part of the session-environment block.
pub fn build_lead_language_content(paths: &LeadPaths, include_output_style: bool, system_locale: &str) -> String {
    let resolved = if include_output_style { resolve_output_style(paths) } else { None };
    // Only the shipped partial is known to keep literals verbatim; a user override may not.
    let shipped = strip_frontmatter(&read_optional(&paths.plugin_root.join("output-styles").join("common.md")));
    let active = !shipped.is_empty() && resolved.is_some_and(|r| r.common == shipped);
    build_language_section(paths, active, system_locale)
}

/// `buildLeadLanguage`: the configured response language as `(id, name)`.
pub fn build_lead_language(paths: &LeadPaths, system_locale: &str) -> Option<(String, String)> {
    let profile = profile_of(paths);
    let language = profile_language_prompt(profile.get("language").and_then(Value::as_str).unwrap_or("system"), system_locale)?;
    Some((language.id, language.prompt.to_owned()))
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup builds fixture trees")]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn write_tree(root: &Path, files: &Value) {
        for (rel, body) in files.as_object().unwrap() {
            let path = root.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, body.as_str().unwrap()).unwrap();
        }
    }

    /// Node's lead meta, language and language-id builders over 234 cases: configs by object and
    /// by file, a user override of the shared format, unusable and partial style files.
    #[test]
    fn the_lead_parts_follow_node() {
        let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("src/run_host/golden/rules_lead.json")).expect("fixture");
        let root = PathBuf::from(std::env::var("TEMP").unwrap_or_else(|_| ".".into())).join(format!("lead-golden-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        write_tree(&root.join("plugin"), &golden["plugin"]);
        write_tree(&root.join("a"), &golden["dataA"]);
        write_tree(&root.join("b"), &golden["dataB"]);
        fs::create_dir_all(root.join("empty")).unwrap();
        fs::write(root.join("plugin/output-styles/bad.md"), [0x2d, 0x2d, 0x00, 0x41]).unwrap();
        let locale = golden["locale"].as_str().unwrap();
        for case in golden["cases"].as_array().unwrap() {
            let a = &case["args"];
            let data = root.join(a["data"].as_str().unwrap());
            let plugin = root.join("plugin");
            let config = a["config"].as_object().map(|_| a["config"].clone());
            let paths = LeadPaths { plugin_root: &plugin, data_dir: &data, config: config.as_ref() };
            let inc = a["includeOutputStyle"].as_bool().unwrap();
            match case["fn"].as_str().unwrap() {
                "meta" => assert_eq!(build_lead_meta_content(&paths, inc), case["out"].as_str().unwrap(), "{case}"),
                "language" => assert_eq!(build_lead_language_content(&paths, inc, locale), case["out"].as_str().unwrap(), "{case}"),
                _ => {
                    let want = case["out"].as_object().map(|o| (o["id"].as_str().unwrap().to_owned(), o["name"].as_str().unwrap().to_owned()));
                    assert_eq!(build_lead_language(&paths, locale), want, "{case}");
                }
            }
        }
        for row in golden["ids"].as_array().unwrap() {
            let want = row["out"].as_str().map(str::to_owned);
            assert_eq!(system_locale_id(row["locale"].as_str().unwrap()), want, "{row}");
        }
    }
}
