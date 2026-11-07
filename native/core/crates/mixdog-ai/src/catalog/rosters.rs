//! The live-roster files a provider's model listing persists
//! (`<provider>-models.json` in the plugin data directory), read as Node's
//! `provider-catalog-cache.mjs` reads them: from the data directory on every
//! call (`readModelsFromCacheFile`), so a file another process writes is seen
//! by the next lookup. A set of rows handed in (`from_rows`) stands in for the
//! directory, as Node's `withRosters` does.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;

use crate::service::admin_route::clean;
use crate::service::admin_route::nullish;
use crate::service::admin_route::number;
use crate::service::admin_route::truthy;
/// `providerRosterFiles(provider)`: the roster files a provider reads.
pub fn roster_files(provider: &str) -> &'static [&'static str] {
    match provider {
        "openai-oauth" => &["openai-oauth-models.json"],
        "anthropic-oauth" | "anthropic" => &["anthropic-oauth-models.json"],
        "gemini" => &["gemini-models.json"],
        "grok-oauth" => &["grok-oauth-models.json"],
        "muse-code-oauth" => &["muse-code-oauth-models.json"],
        "mimo-oauth" => &["mimo-oauth-models.json"],
        "antigravity-oauth" => &["antigravity-oauth-models.json"],
        "command-code-oauth" => &["command-code-oauth-models.json"],
        "opencode-go-oauth" => &["opencode-go-oauth-models.json"],
        _ => &[],
    }
}

/// The two windows a route's context share is sized against.
#[derive(Clone, Copy, PartialEq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedWindows {
    pub context_window: f64,
    pub max_context_window: f64,
}

/// The roster files of a data directory.
#[derive(Default, Debug)]
pub struct Rosters {
    dir: Option<PathBuf>,
    /// While set, reads are served from this file name -> rows map instead of the directory.
    preset: Option<HashMap<String, Vec<Value>>>,
}

/// `parseRosterFile`: `models` when it is an array, else the document itself
/// when it is one, else no rows.
fn parse_rows(bytes: &[u8]) -> Vec<Value> {
    let Ok(raw) = serde_json::from_slice::<Value>(bytes) else { return Vec::new() };
    match raw {
        Value::Array(rows) => rows,
        Value::Object(mut map) => match map.shift_remove("models") {
            Some(Value::Array(rows)) => rows,
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

/// `rowId`: `String(row?.id || row?.name || row?.slug || '').trim()`.
fn row_id(row: &Value) -> String {
    for key in ["id", "name", "slug"] {
        if truthy(row.get(key)) {
            return clean(row.get(key));
        }
    }
    String::new()
}

fn all_digits(s: &str) -> bool {
    s.bytes().all(|b| b.is_ascii_digit())
}

/// `modelAliases`: the id, and the id without a trailing `-YYYY-MM-DD` or `-YYYYMMDD`.
fn model_aliases(model: &str) -> Vec<String> {
    let text = mixdog_js::js_trim(model);
    if text.is_empty() {
        return Vec::new();
    }
    let mut out = vec![text.to_owned()];
    let bytes = text.as_bytes();
    let dashed = bytes.len() >= 11
        && text.is_char_boundary(text.len() - 11)
        && {
            let tail = &text[text.len() - 11..];
            tail.starts_with('-')
                && all_digits(&tail[1..5])
                && &tail[5..6] == "-"
                && all_digits(&tail[6..8])
                && &tail[8..9] == "-"
                && all_digits(&tail[9..11])
        };
    if dashed {
        out.push(text[..text.len() - 11].to_owned());
    }
    let compact = bytes.len() >= 9 && text.is_char_boundary(text.len() - 9) && {
        let tail = &text[text.len() - 9..];
        tail.starts_with('-') && all_digits(&tail[1..])
    };
    if compact {
        out.push(text[..text.len() - 9].to_owned());
    }
    out.dedup();
    out.retain(|alias| !alias.is_empty());
    out
}

impl Rosters {
    /// The roster files in `dir`, each read when a lookup asks for it.
    pub fn in_dir(dir: PathBuf) -> Self {
        Self { dir: Some(dir), preset: None }
    }

    /// Fixed rows in place of the directory (`withRosters`).
    pub fn from_rows(files: impl IntoIterator<Item = (String, Vec<Value>)>) -> Self {
        Self { dir: None, preset: Some(files.into_iter().collect()) }
    }

    /// `readModelsFromCacheFile`: the file's rows; an absent, unreadable or damaged file is no rows.
    fn rows(&self, file: &str) -> Vec<Value> {
        if let Some(preset) = &self.preset {
            return preset.get(file).cloned().unwrap_or_default();
        }
        let Some(dir) = &self.dir else { return Vec::new() };
        match mixdog_statefile::read_content(&dir.join(file)) {
            Ok(Some(bytes)) => parse_rows(&bytes),
            Ok(None) | Err(_) => Vec::new(),
        }
    }
    /// `getProviderCachedModelSync`: the first row of the provider's files
    /// whose id is the model or one of its date-less aliases.
    pub fn row(&self, provider: &str, model: &str) -> Option<Value> {
        let files = roster_files(provider);
        if files.is_empty() || model.is_empty() {
            return None;
        }
        let aliases = model_aliases(model);
        files.iter().find_map(|file| {
            self.rows(file).into_iter().find(|row| {
                let id = row_id(row);
                !id.is_empty() && aliases.contains(&id)
            })
        })
    }

    /// `providerCachedModelsSync`: the provider's rows, each id once, the id
    /// normalized (`{...row, id}`).
    pub fn cached_models(&self, provider: &str) -> Vec<Value> {
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        for file in roster_files(provider) {
            for row in self.rows(file) {
                let id = row_id(&row);
                if id.is_empty() || !seen.insert(id.clone()) {
                    continue;
                }
                let mut object = row.as_object().cloned().unwrap_or_default();
                object.insert("id".into(), Value::String(id));
                out.push(Value::Object(object));
            }
        }
        out
    }

    /// `cachedRouteWindows`: the row's two windows when it states either.
    pub fn windows(&self, provider: &str, model: &str) -> Option<CachedWindows> {
        let row = self.row(provider, model)?;
        let window = |value: f64| if value.is_nan() { 0.0 } else { value };
        let context_window = window(number(nullish(
            nullish(row.get("contextWindow"), row.get("context_window")),
            row.get("max_input_tokens"),
        )));
        let max_context_window = window(number(nullish(row.get("maxContextWindow"), row.get("max_context_window"))));
        (context_window > 0.0 || max_context_window > 0.0).then_some(CachedWindows { context_window, max_context_window })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn snapshot() -> Rosters {
        Rosters::from_rows([
            (
                "openai-oauth-models.json".to_owned(),
                parse_rows(
                    json!({"models": [
                        {"id": "gpt-5.5", "contextWindow": 272000, "maxContextWindow": 1000000},
                        {"name": "gpt-x", "context_window": "8000"},
                        {"id": "only-max", "max_context_window": 500000},
                        {"id": "silent"}
                    ]})
                    .to_string()
                    .as_bytes(),
                ),
            ),
            ("anthropic-oauth-models.json".to_owned(), parse_rows(json!([{"id": "claude-x", "max_input_tokens": 200000}]).to_string().as_bytes())),
        ])
    }

    #[test]
    fn windows_follow_the_node_row_reading() {
        let s = snapshot();
        let both = s.windows("openai-oauth", "gpt-5.5").unwrap();
        assert_eq!((both.context_window, both.max_context_window), (272000.0, 1000000.0));
        // `name` identifies a row without an id; a numeric string is a number.
        assert_eq!(s.windows("openai-oauth", "gpt-x").unwrap().context_window, 8000.0);
        assert_eq!(s.windows("openai-oauth", "only-max").unwrap().max_context_window, 500000.0);
        assert!(s.windows("openai-oauth", "silent").is_none());
        assert!(s.windows("openai-oauth", "missing").is_none());
        // A bare array file, and `anthropic` reading the OAuth file.
        assert_eq!(s.windows("anthropic", "claude-x").unwrap().context_window, 200000.0);
        assert!(s.windows("openai", "gpt-5.5").is_none());
    }

    #[test]
    fn a_dated_model_id_finds_its_undated_row() {
        let s = snapshot();
        assert!(s.windows("openai-oauth", "gpt-5.5-2025-08-07").is_some());
        assert!(s.windows("openai-oauth", "gpt-5.5-20250807").is_some());
        assert!(s.windows("openai-oauth", "gpt-5.5-2025").is_none());
    }
}
