//! Token accounting of one exec (`createSessionStats` / `applyUsageDelta`) and the per-run usage
//! document (`writeUsageDocument`, schema v1), rewritten after every model response.
#![allow(
    clippy::disallowed_methods,
    reason = "the exec process owns its usage file; it writes it on its own thread, outside the core's lanes"
)]

use std::path::Path;

use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::route::clean;

/// One model response's spend (`onUsageDelta`'s delta).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct UsageDelta {
    pub model: Option<String>,
    pub input: f64,
    pub cached_read: f64,
    pub cache_write: f64,
    pub output: f64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionStats {
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub cached_tokens: f64,
    pub cache_write_tokens: f64,
}

impl SessionStats {
    pub fn apply(&mut self, delta: &UsageDelta) {
        self.input_tokens += delta.input;
        self.output_tokens += delta.output;
        self.cached_tokens += delta.cached_read;
        self.cache_write_tokens += delta.cache_write;
    }
}

/// `nonNegativeNumber`.
pub fn non_negative(value: f64) -> f64 {
    if value.is_finite() { value.max(0.0) } else { 0.0 }
}

pub use mixdog_js::json_number as js_number;

/// What the document names about the session.
pub struct UsageSession<'a> {
    pub session_id: &'a str,
    pub model: &'a str,
    pub observed_models: &'a [String],
    pub tool_calls: f64,
}

/// The usage document of `stats`.
pub fn usage_document(stats: &SessionStats, session: &UsageSession<'_>) -> Value {
    let mut models: Vec<String> = Vec::new();
    for name in std::iter::once(session.model).chain(session.observed_models.iter().map(String::as_str)) {
        let name = clean(Some(name));
        if !name.is_empty() && !models.iter().any(|seen| seen == name) {
            models.push(name.to_owned());
        }
    }
    let tool_calls = js_number(non_negative(session.tool_calls));
    let mut entry = Map::new();
    entry.insert("sessionId".into(), json!(clean(Some(session.session_id))));
    entry.insert("agentRole".into(), json!("primary"));
    entry.insert("models".into(), json!(models));
    entry.insert("inputTokens".into(), js_number(stats.input_tokens));
    entry.insert("cacheTokens".into(), js_number(stats.cached_tokens));
    entry.insert("cacheWriteTokens".into(), js_number(stats.cache_write_tokens));
    entry.insert("outputTokens".into(), js_number(stats.output_tokens));
    entry.insert("toolCallCountApprox".into(), tool_calls.clone());
    json!({
        "schemaVersion": 1,
        "sessions": [Value::Object(entry)],
        "totals": {
            "inputTokens": js_number(stats.input_tokens),
            "cacheTokens": js_number(stats.cached_tokens),
            "cacheWriteTokens": js_number(stats.cache_write_tokens),
            "outputTokens": js_number(stats.output_tokens),
            "toolCallCountApprox": tool_calls,
        },
    })
}

/// Atomically replaces `target` with the document (a reader never sees a half-written file).
pub fn write_usage_document(target: &Path, document: &Value) -> std::io::Result<()> {
    let mut temp = target.as_os_str().to_owned();
    temp.push(format!(".tmp-{}", std::process::id()));
    let temp = std::path::PathBuf::from(temp);
    if let Some(parent) = target.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    let mut text = serde_json::to_string_pretty(document).expect("a document serializes");
    text.push('\n');
    std::fs::write(&temp, text)?;
    std::fs::rename(&temp, target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_document_matches_the_recorded_node_shape() {
        let mut stats = SessionStats::default();
        stats.apply(&UsageDelta { model: Some("gpt-fallback".into()), input: 11.0, cached_read: 7.0, cache_write: 3.0, output: 5.0 });
        let document = usage_document(
            &stats,
            &UsageSession { session_id: " sess_exec_test ", model: "gpt-test", observed_models: &["gpt-fallback".into(), "gpt-test".into(), " ".into()], tool_calls: 0.0 },
        );
        let golden: Value = serde_json::from_str(include_str!("../../tests/goldens/exec_usage_v1.json")).expect("golden parses");
        assert_eq!(document, golden);
        // Key order is part of the file the harnesses read.
        assert_eq!(
            serde_json::to_string_pretty(&document).unwrap() + "\n",
            include_str!("../../tests/goldens/exec_usage_v1.json")
        );
    }

    #[test]
    fn the_file_is_replaced_in_place_without_a_temp_left() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("nested").join("usage.json");
        write_usage_document(&target, &json!({"a": 1})).unwrap();
        write_usage_document(&target, &json!({"a": 2})).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "{\n  \"a\": 2\n}\n");
        assert_eq!(std::fs::read_dir(target.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn counts_are_clamped_like_node() {
        assert_eq!(non_negative(f64::NAN), 0.0);
        assert_eq!(non_negative(-3.0), 0.0);
        assert_eq!(js_number(2.5), json!(2.5));
    }
}
