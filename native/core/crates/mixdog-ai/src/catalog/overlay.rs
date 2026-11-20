//! A narrowed catalog document (`model-catalog-projection.mjs`) as the metadata lookup reads it, held as one compact JSON
//! text per row instead of a tree of values.
//!
//! The lookup only ever reads a row by its key (a LiteLLM key, or a models.dev provider and model id), walks one provider's
//! rows, or lists the providers. As `serde_json` values the two documents were 37 MB resident (every row an ordered map of
//! keyed values); as text they are a fraction of that, and a lookup parses the one row it reads. Rows keep their member
//! order and numbers exactly (`preserve_order`, `float_roundtrip`), so a parsed row is the value the document held.

use std::sync::LazyLock;

use indexmap::IndexMap;
use serde_json::Map;
use serde_json::Value;

#[derive(Clone, Debug, Default)]
pub struct Overlay {
    /// LiteLLM: key → row.
    rows: IndexMap<String, Box<str>>,
    /// models.dev: provider → model id → row.
    providers: IndexMap<String, IndexMap<String, Box<str>>>,
}

pub(crate) fn text(row: &Value) -> Box<str> {
    row.to_string().into_boxed_str()
}

/// Whether a projected row is one the overlay holds.
pub(crate) fn holds(row: &Value) -> bool {
    held(row)
}

fn parse(text: &str) -> Value {
    // Every row was written by `text` from a value, so it parses back.
    serde_json::from_str(text).unwrap_or(Value::Null)
}

/// A row is read only when it is truthy (`catModels[id] || null`); every held row is an object, which is.
fn held(row: &Value) -> bool {
    !matches!(row, Value::Null | Value::Bool(false)) && !row.as_str().is_some_and(str::is_empty) && !row.as_f64().is_some_and(|n| n == 0.0 || n.is_nan())
}

impl Overlay {
    /// The empty document a cold layer reads.
    pub fn empty() -> &'static Overlay {
        static EMPTY: LazyLock<Overlay> = LazyLock::new(Overlay::default);
        &EMPTY
    }

    /// The overlay of rows already narrowed and written as text ([`text`]), as a streamed read of the document yields them.
    pub(crate) fn of_rows(rows: IndexMap<String, Box<str>>, providers: IndexMap<String, IndexMap<String, Box<str>>>) -> Self {
        Self { rows, providers }
    }

    /// A projected LiteLLM document: `{ key: row }`.
    pub fn from_projected_litellm(document: &Value) -> Self {
        let rows = document.as_object().map(|map| map.iter().filter(|(_, row)| held(row)).map(|(key, row)| (key.clone(), text(row))).collect());
        Self { rows: rows.unwrap_or_default(), providers: IndexMap::new() }
    }

    /// A projected models.dev document: `{ provider: { models: { id: row } } }`.
    pub fn from_projected_models_dev(document: &Value) -> Self {
        let providers = document.as_object().map(|map| {
            // A provider without a models map reads as absent, as it did in the document.
            map.iter()
                .filter_map(|(provider, entry)| {
                    let models = entry.get("models")?.as_object()?;
                    Some((provider.clone(), models.iter().filter(|(_, row)| held(row)).map(|(id, row)| (id.clone(), text(row))).collect()))
                })
                .collect()
        });
        Self { rows: IndexMap::new(), providers: providers.unwrap_or_default() }
    }

    /// The LiteLLM row under `key`.
    pub fn row(&self, key: &str) -> Option<Value> {
        self.rows.get(key).map(|row| parse(row))
    }

    /// The models.dev row of `id` under `provider`.
    pub fn model(&self, provider: &str, id: &str) -> Option<Value> {
        self.providers.get(provider)?.get(id).map(|row| parse(row))
    }

    pub fn has_model(&self, provider: &str, id: &str) -> bool {
        self.providers.get(provider).is_some_and(|models| models.contains_key(id))
    }

    /// The models.dev providers, in document order.
    pub fn providers(&self) -> impl Iterator<Item = &str> {
        self.providers.keys().map(String::as_str)
    }

    /// Every row `provider` lists, in document order; `None` when the document has no such provider.
    pub fn provider_models(&self, provider: &str) -> Option<Map<String, Value>> {
        let models = self.providers.get(provider)?;
        Some(models.iter().map(|(id, row)| (id.clone(), parse(row))).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_read_back_as_the_document_held_them() {
        let document = serde_json::json!({
            "openai": { "models": { "gpt-x": { "cost": { "input": 1.25, "output": 0.1 }, "name": "X", "tool_call": true }, "skip": null } },
            "empty": { "models": {} },
            "none": {}
        });
        let overlay = Overlay::from_projected_models_dev(&document);
        assert_eq!(overlay.model("openai", "gpt-x"), Some(document["openai"]["models"]["gpt-x"].clone()));
        assert!(overlay.has_model("openai", "gpt-x") && !overlay.has_model("openai", "skip"));
        assert_eq!(overlay.providers().collect::<Vec<_>>(), vec!["openai", "empty"]);
        assert_eq!(overlay.provider_models("empty").map(|m| m.len()), Some(0));
        assert!(overlay.provider_models("none").is_none());
        let litellm = Overlay::from_projected_litellm(&serde_json::json!({ "a/b": { "mode": "chat", "max_tokens": 8192 } }));
        assert_eq!(litellm.row("a/b").unwrap().to_string(), r#"{"mode":"chat","max_tokens":8192}"#);
        assert_eq!(litellm.row("missing"), None);
    }
}
