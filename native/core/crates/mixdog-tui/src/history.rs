//! The prompt history (`src/tui/prompt-history-store.mjs`, `app/use-prompt-queue-history/prompt-history.mjs`).
//!
//! The per-cwd store (the file `<data>/tui-prompt-history/<sha256(cwd key)[..32]>.json`, `{"version": 1, "entries": [..]}`,
//! the append rule, the write-behind backoff, the `MIXDOG_PROMPT_HISTORY_CACHE_LIMIT` bound of 128 cwds held in memory) is the
//! one the session service writes: it lives in `mixdog_core_files::prompt_history` and is re-exported here, so this crate has
//! one implementation of the format; the merge of the session's prompts with the persisted ones is the service's. The terminal UI reads the merged list the service publishes (`promptHistoryList`) and only walks it; the one piece
//! of the Node file that belongs to the surface is the local scan used when no list was published.

use mixdog_js::{js_trim, value_to_string};
use serde_json::Value;

pub use mixdog_core_files::prompt_history::{
    Appended, FLUSH_CAP, FilePromptHistory, PROMPT_HISTORY_LIMIT, PromptHistoryStore, WRITE_BEHIND_MS, WRITE_RETRY_MAX_MS, append_persisted,
    key as prompt_history_key, write_retry_delay,
};

/// `String(value || '')` of a transcript item's text.
fn item_text(item: &Value) -> String {
    match item.get("text") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null | Value::Bool(false)) | None => String::new(),
        Some(Value::Number(number)) if number.as_f64() == Some(0.0) => String::new(),
        Some(other) => value_to_string(other),
    }
}

/// `scanPromptHistory(items)`: the user prompts of the transcript, newest first, de-duplicated by key, at most
/// [`PROMPT_HISTORY_LIMIT`].
pub fn scan_prompt_history(items: &[Value]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut history = Vec::new();
    for item in items.iter().rev() {
        if history.len() >= PROMPT_HISTORY_LIMIT {
            break;
        }
        if item.get("kind").and_then(Value::as_str) != Some("user") {
            continue;
        }
        let text = js_trim(&item_text(item)).to_owned();
        let key = prompt_history_key(&text);
        if key.is_empty() || !seen.insert(key) {
            continue;
        }
        history.push(text);
    }
    history
}

/// `recentPromptHistory`: the list the service published when it did, else a scan of the transcript items.
pub fn recent_prompt_history(published: Option<&[String]>, items: &[Value]) -> Vec<String> {
    match published {
        Some(list) => list.to_vec(),
        None => scan_prompt_history(items),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_scan_is_newest_first_deduplicated_by_key_and_capped() {
        let items = vec![
            json!({"kind": "user", "text": " one "}),
            json!({"kind": "assistant", "text": "reply"}),
            json!({"kind": "user", "text": "two   words"}),
            json!({"kind": "user", "text": "one"}),
            json!({"kind": "user", "text": "  "}),
            json!({"kind": "user"}),
            json!({"kind": "user", "text": "two words"}),
        ];
        assert_eq!(scan_prompt_history(&items), ["two words", "one"]);
        let many: Vec<Value> = (0..80).map(|n| json!({"kind": "user", "text": format!("p{n}")})).collect();
        let scanned = scan_prompt_history(&many);
        assert_eq!(scanned.len(), PROMPT_HISTORY_LIMIT);
        assert_eq!((scanned[0].as_str(), scanned[49].as_str()), ("p79", "p30"));
    }

    #[test]
    fn a_published_list_wins_over_the_scan() {
        let items = vec![json!({"kind": "user", "text": "scanned"})];
        assert_eq!(recent_prompt_history(Some(&["published".to_owned()]), &items), ["published"]);
        assert_eq!(recent_prompt_history(None, &items), ["scanned"]);
    }

    #[test]
    fn a_failing_flush_backs_off_exponentially_and_caps() {
        let delays: Vec<u128> = (1..=10).map(|failures| write_retry_delay(failures).as_millis()).collect();
        assert_eq!(delays[..3], [500, 1000, 2000]);
        assert!(delays.windows(2).all(|pair| pair[0] <= pair[1]), "never shrinks");
        assert_eq!(delays[9], 30_000);
    }
}
