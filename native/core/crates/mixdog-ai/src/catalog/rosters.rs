//! The live-roster files a provider's model listing persists
//! (`<provider>-models.json` in the plugin data directory), as Node's
//! `provider-catalog-cache.mjs` reads them. The files are read together as
//! lane jobs when the catalog refreshes; a lookup is a read of the resident
//! snapshot and touches no disk.

use std::collections::HashMap;
use std::path::Path;

use mixdog_rt::LaneToken;
use serde::Serialize;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::modelsdev_source::read_file;
use crate::oauth::CredentialIo;
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

const ALL_FILES: [&str; 9] = [
    "openai-oauth-models.json",
    "anthropic-oauth-models.json",
    "gemini-models.json",
    "grok-oauth-models.json",
    "muse-code-oauth-models.json",
    "mimo-oauth-models.json",
    "antigravity-oauth-models.json",
    "command-code-oauth-models.json",
    "opencode-go-oauth-models.json",
];

/// The two windows a route's context share is sized against.
#[derive(Clone, Copy, PartialEq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedWindows {
    pub context_window: f64,
    pub max_context_window: f64,
}

/// File name -> rows, each file read once.
#[derive(Default, Debug)]
pub struct RosterSnapshot {
    files: HashMap<String, Vec<Value>>,
}

/// `parseRosterFile`: `models` when it is an array, else the document itself
/// when it is one, else no rows.
fn parse_rows(bytes: &[u8]) -> Vec<Value> {
    let Ok(raw) = serde_json::from_slice::<Value>(bytes) else { return Vec::new() };
    match raw {
        Value::Array(rows) => rows,
        Value::Object(mut map) => match map.remove("models") {
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

impl RosterSnapshot {
    pub fn from_rows(files: impl IntoIterator<Item = (String, Vec<Value>)>) -> Self {
        Self { files: files.into_iter().collect() }
    }

    /// Reads every roster file as a lane job; an absent or unreadable file
    /// is no rows.
    pub async fn load(dir: &Path, io: &CredentialIo) -> Self {
        let reads = ALL_FILES.iter().map(|name| {
            let path = dir.join(name);
            let job = io.read.submit(&CancellationToken::new(), move |_| read_file(&path).map(|b| parse_rows(&b)));
            async move {
                let rows = match job {
                    Ok(job) => job.await.ok().flatten().unwrap_or_default(),
                    Err(_) => Vec::new(),
                };
                ((*name).to_owned(), rows)
            }
        });
        Self::from_rows(futures::future::join_all(reads).await)
    }

    /// `getProviderCachedModelSync`: the first row of the provider's files
    /// whose id is the model or one of its date-less aliases.
    pub fn row(&self, provider: &str, model: &str) -> Option<&Value> {
        let files = roster_files(provider);
        if files.is_empty() || model.is_empty() {
            return None;
        }
        let aliases = model_aliases(model);
        files.iter().find_map(|file| {
            self.files.get(*file)?.iter().find(|row| {
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
            for row in self.files.get(*file).into_iter().flatten() {
                let id = row_id(row);
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

    fn snapshot() -> RosterSnapshot {
        RosterSnapshot::from_rows([
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
