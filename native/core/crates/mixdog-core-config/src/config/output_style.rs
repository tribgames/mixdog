//! The output styles (`session-runtime/output-styles.mjs`, `lib/output-style-meta.cjs`,
//! `setOutputStyle` of `style-and-mode.mjs`): the catalog of the `.md` styles shipped with the
//! install and kept in the data dir, the configured style (the root `outputStyle` key), and the
//! change of it. Reads of the directories run on the read lane of the `Config`.

use std::path::Path;
use std::path::PathBuf;

use mixdog_js::is_js_space;
use mixdog_js::js_trim;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::Config;
use super::on_lane;
use crate::tool_modules::ToolModulesError;

const DEFAULT_STYLE: &str = "simple";
const SHARED_FORMAT_PARTIAL: &str = "common";
/// Catalog order: deepest first, then the unknown styles by label.
const ORDER: [&str; 4] = ["detailed", "simple", "minimal", "extreme-minimal"];

#[derive(Clone, Debug, PartialEq)]
struct Style {
    id: String,
    label: String,
    description: String,
    aliases: Vec<String>,
    source: &'static str,
}

impl Style {
    fn json(&self) -> Value {
        json!({
            "id": self.id,
            "label": self.label,
            "description": self.description,
            "aliases": self.aliases,
            "source": self.source,
        })
    }
}

#[derive(Clone)]
pub struct OutputStyles {
    config: Config,
    shipped: PathBuf,
    data_dir: PathBuf,
}

impl OutputStyles {
    /// `shipped`: the install's `output-styles` dir; the user's styles are `output-styles` in
    /// `data_dir`, and replace a shipped style of the same id.
    pub fn new(config: Config, shipped: impl Into<PathBuf>, data_dir: impl AsRef<Path>) -> Self {
        Self { config, shipped: shipped.into(), data_dir: data_dir.as_ref().join("output-styles") }
    }

    /// `getOutputStyle` / `listOutputStyles`: `{ configured, current, styles }`.
    pub async fn status(&self) -> Result<Value, ToolModulesError> {
        let styles = self.catalog().await?;
        Ok(status_of(&self.configured(), &styles))
    }

    /// `setOutputStyle(value)`: the style `value` names (id, label or alias) becomes the
    /// configured one. Answers `{ configured, current, styles }`; whether the current session
    /// takes it is the caller's to add (`appliedToCurrentSession`).
    pub async fn set(&self, value: &str) -> Result<Value, ToolModulesError> {
        let styles = self.catalog().await?;
        let Some(selected) = find(value, &styles).cloned() else {
            let names: Vec<&str> = styles.iter().map(|s| if s.label.is_empty() { s.id.as_str() } else { s.label.as_str() }).collect();
            let names = if names.is_empty() { "Default".to_owned() } else { names.join(", ") };
            return Err(ToolModulesError::InvalidArgument(format!("output style must be one of {names}")));
        };
        let id = selected.id.clone();
        self.config
            .update(move |doc| {
                // Defaults live in code: the default style is an absent key.
                if id == DEFAULT_STYLE {
                    doc.shift_remove("outputStyle");
                } else {
                    doc.insert("outputStyle".into(), Value::String(id));
                }
                // The retired `agent.outputStyle` copy goes.
                if let Some(Value::Object(agent)) = doc.get_mut("agent") {
                    agent.shift_remove("outputStyle");
                }
                Ok(())
            })
            .await
            .map_err(ToolModulesError::Config)?;
        Ok(json!({
            "configured": selected.id,
            "current": selected.json(),
            "styles": styles.iter().map(Style::json).collect::<Vec<_>>(),
        }))
    }

    fn configured(&self) -> String {
        let stored = self.config.get("outputStyle");
        let text = match stored {
            None | Some(Value::Null) => String::new(),
            Some(value) => js_trim(&mixdog_js::value_to_string(&value)).to_owned(),
        };
        if text.is_empty() { DEFAULT_STYLE.to_owned() } else { text }
    }

    async fn catalog(&self) -> Result<Vec<Style>, ToolModulesError> {
        let dirs = [(self.shipped.clone(), "builtin"), (self.data_dir.clone(), "user")];
        let lane = self.config.lanes.read;
        on_lane(lane, move |lane| read_catalog(lane, &dirs)).await.map_err(ToolModulesError::Config)
    }
}

fn status_of(configured: &str, styles: &[Style]) -> Value {
    let current = find(configured, styles)
        .or_else(|| find(DEFAULT_STYLE, styles))
        .or(styles.first())
        .cloned()
        .unwrap_or_else(|| Style {
            id: DEFAULT_STYLE.into(),
            label: title_case(DEFAULT_STYLE),
            description: String::new(),
            aliases: Vec::new(),
            source: "builtin",
        });
    json!({
        "configured": configured,
        "current": current.json(),
        "styles": styles.iter().map(Style::json).collect::<Vec<_>>(),
    })
}

/// `listOutputStyleCatalog`: a later directory replaces an earlier style of the same id.
#[allow(clippy::disallowed_methods, reason = "an io-interactive job body: the proof says it runs there")]
fn read_catalog(_lane: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>, dirs: &[(PathBuf, &'static str)]) -> Vec<Style> {
    let mut by_id: Vec<Style> = Vec::new();
    for (dir, source) in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        let mut names: Vec<String> = entries
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.to_lowercase().ends_with(".md"))
            .collect();
        names.sort();
        for name in names {
            let Ok(bytes) = std::fs::read(dir.join(&name)) else { continue };
            let Some(style) = style_of(&String::from_utf8_lossy(&bytes), &name, source) else { continue };
            match by_id.iter().position(|s| s.id == style.id) {
                Some(at) => by_id[at] = style,
                None => by_id.push(style),
            }
        }
    }
    sort(by_id)
}

/// `parseOutputStyleFrontmatter`: the `key: value` lines of the leading `---` block.
fn frontmatter(markdown: &str) -> Map<String, Value> {
    let mut meta = Map::new();
    let Some(rest) = markdown.strip_prefix("---\n").or_else(|| markdown.strip_prefix("---\r\n")) else {
        return meta;
    };
    let end = rest.find("\n---").map(|at| if rest[..at].ends_with('\r') { at - 1 } else { at });
    let Some(end) = end else { return meta };
    for line in rest[..end].split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let Some((key, value)) = line.split_once(':') else { continue };
        if key.is_empty() || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
            continue;
        }
        let value = js_trim(value);
        let value = value.strip_prefix(['\'', '"']).unwrap_or(value);
        let value = value.strip_suffix(['\'', '"']).unwrap_or(value);
        meta.insert(key.to_owned(), Value::String(js_trim(value).to_owned()));
    }
    meta
}

/// `outputStyleFlag(value, false)`.
fn flag(value: Option<&Value>) -> bool {
    let raw = value.and_then(Value::as_str).map(|s| js_trim(s).to_lowercase()).unwrap_or_default();
    matches!(raw.as_str(), "true" | "1" | "yes" | "on")
}

fn text(meta: &Map<String, Value>, key: &str) -> String {
    meta.get(key).and_then(Value::as_str).map(|s| js_trim(s).to_owned()).unwrap_or_default()
}

/// `outputStyleMetaFromMarkdown`, with the source: `None` for the shared partial and for a file
/// without a usable id.
fn style_of(markdown: &str, file_name: &str, source: &'static str) -> Option<Style> {
    let meta = frontmatter(markdown);
    let stem = file_name.len().checked_sub(3).filter(|_| file_name.to_lowercase().ends_with(".md")).map_or(file_name, |at| &file_name[..at]);
    let file_id = style_slug(stem);
    if file_id == SHARED_FORMAT_PARTIAL || flag(meta.get("partial")) {
        return None;
    }
    let named = style_slug(&text(&meta, "name"));
    let id = if named.is_empty() { file_id } else { named };
    if id.is_empty() {
        return None;
    }
    let label = Some(text(&meta, "title")).filter(|s| !s.is_empty()).or(Some(text(&meta, "label")).filter(|s| !s.is_empty()));
    Some(Style {
        label: label.unwrap_or_else(|| title_case(&id)),
        description: text(&meta, "description"),
        aliases: text(&meta, "aliases").split(',').map(style_slug).filter(|a| !a.is_empty()).collect(),
        id,
        source,
    })
}

fn title_case(id: &str) -> String {
    let words: Vec<String> = id
        .split(['_', '.', '-'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or_default()
        })
        .collect();
    if words.is_empty() { "Default".to_owned() } else { words.join(" ") }
}

/// `outputStyleCompactKey`: separator-insensitive.
fn compact(value: &str) -> String {
    style_slug(value).chars().filter(|c| !matches!(c, '_' | '.' | '-')).collect()
}

/// `sortOutputStyles`.
fn sort(mut styles: Vec<Style>) -> Vec<Style> {
    let rank = |style: &Style| ORDER.iter().position(|id| *id == style.id).map_or(999, |at| at as i32);
    styles.sort_by(|a, b| rank(a).cmp(&rank(b)).then_with(|| mixdog_js::locale_compare_en_base(&a.label, &b.label)));
    styles
}

/// `matchOutputStyle`: an id, label or alias, ignoring separators and case.
fn find<'a>(value: &str, styles: &'a [Style]) -> Option<&'a Style> {
    let (id, key) = (style_slug(value), compact(value));
    if id.is_empty() && key.is_empty() {
        return None;
    }
    styles.iter().find(|style| {
        style.id == id
            || compact(&style.id) == key
            || compact(&style.label) == key
            || style.aliases.iter().any(|alias| *alias == id || compact(alias) == key)
    })
}

/// `normalizeOutputStyleId`.
pub fn style_slug(value: &str) -> String {
    let lowered = js_trim(value).to_lowercase();
    let mut slug = String::new();
    let mut in_separator = false;
    for c in lowered.chars() {
        if c == '_' || is_js_space(c) {
            if !in_separator {
                slug.push('-');
            }
            in_separator = true;
        } else {
            slug.push(c);
            in_separator = false;
        }
    }
    let slug = slug.trim_matches('-');
    if !slug.is_empty()
        && slug
            .bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'-'))
    {
        slug.to_owned()
    } else {
        String::new()
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]
mod tests;
