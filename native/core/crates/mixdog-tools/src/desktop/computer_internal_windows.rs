//! Mixdog's own overlay, pill and indicator windows kept out of window lists (`overlay/internal-windows.ts`
//! `filterComputerUseInternalWindows`, `filterComputerUseWindowListText`). The desktop owns them and names them
//! (`host/computer/internalWindows`); the ids are kept for a short while so a burst of reads asks once. Every read the core
//! makes goes through `exchange`, so the lists the settle, the transition and the arrivals work from are filtered too.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_rt::time::Instant;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::computer_backend::ProcessComputerBackend;

const METHOD: &str = "host/computer/internalWindows";
/// How long the desktop's answer is trusted: an overlay window is created in the moments after an action.
const TTL: Duration = Duration::from_millis(500);

/// The desktop's internal window ids and when they were read. The windows belong to the desktop process, not to one session.
struct IdCache {
    slot: Mutex<Option<(Instant, HashSet<String>)>>,
}

impl IdCache {
    const fn new() -> Self {
        Self { slot: Mutex::new(None) }
    }

    /// The ids read within `TTL`, else the ones `fetch` returns; a failed fetch is not remembered and names none.
    async fn ids<F, Fut>(&self, fetch: F) -> HashSet<String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Option<HashSet<String>>>,
    {
        let fresh = {
            let slot = self.slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            slot.as_ref().filter(|(read, _)| read.elapsed() < TTL).map(|(_, ids)| ids.clone())
        };
        if let Some(ids) = fresh {
            return ids;
        }
        let Some(ids) = fetch().await else { return HashSet::new() };
        *self.slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((Instant::now(), ids.clone()));
        ids
    }
}

static CACHE: IdCache = IdCache::new();

/// `normalizedWindowId`.
fn normalized(id: &str) -> String {
    js_to_lowercase(js_trim(id))
}

/// The ids of a `host/computer/internalWindows` answer; `None` when it is not one.
fn ids_of(answer: &Value) -> Option<HashSet<String>> {
    let ids = answer.get("windowIds")?.as_array()?;
    Some(ids.iter().filter_map(Value::as_str).map(normalized).filter(|id| !id.is_empty()).collect())
}

/// Drops the internal windows from a `list_windows` or `window_snapshot` result. A list text is rebuilt over the windows that
/// stay (`filterComputerUseWindowListText`); a result with none of them is left as the helper wrote it.
pub(super) async fn filter(backend: &ProcessComputerBackend, result: &mut Map<String, Value>, cancel: &CancellationToken) {
    let internal = CACHE.ids(|| async { backend.ask_desktop(METHOD, json!({}), cancel).await.ok().and_then(|answer| ids_of(&answer)) }).await;
    drop_windows(&internal, result);
}

fn window_id(window: &Value) -> String {
    window.get("id").and_then(Value::as_str).map(normalized).unwrap_or_default()
}

/// `filterComputerUseInternalWindows` over a result's `windows`, and the text that lists them.
fn drop_windows(internal: &HashSet<String>, result: &mut Map<String, Value>) {
    if internal.is_empty() {
        return;
    }
    let Some(Value::Array(windows)) = result.get_mut("windows") else { return };
    let before = windows.len();
    windows.retain(|window| {
        let id = window_id(window);
        id.is_empty() || !internal.contains(&id)
    });
    if windows.len() == before {
        return;
    }
    let visible: HashSet<String> = windows.iter().map(window_id).filter(|id| !id.is_empty()).collect();
    if let Some(Value::String(text)) = result.get_mut("text") {
        *text = list_text(text, &visible);
    }
}

/// `filterComputerUseWindowListText`: a `Windows:` text keeps the lines of the visible windows; none left is `No windows found.`.
fn list_text(text: &str, visible: &HashSet<String>) -> String {
    let mut lines = text.split('\n');
    if lines.next().map(|first| first.trim_end_matches('\r')) != Some("Windows:") {
        return text.to_string();
    }
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let kept: Vec<&str> = lines
        .map(|line| line.trim_end_matches('\r'))
        .filter(|line| line.find(" |").is_some_and(|at| visible.contains(&normalized(&line[..at]))))
        .collect();
    if kept.is_empty() { "No windows found.".to_string() } else { format!("Windows:{newline}{}", kept.join(newline)) }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use mixdog_rt::time::sleep;

    use super::*;

    fn set(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().cloned().expect("an object")
    }

    fn list() -> Map<String, Value> {
        object(json!({
            "text": "Windows:\nhwnd:0x10 | app=a pid=1 | \"A\"\nhwnd:0xAB | app=mixdog pid=2 | \"Pill\"",
            "windows": [{ "id": "hwnd:0x10" }, { "id": "hwnd:0xAB" }],
        }))
    }

    #[test]
    fn a_registered_window_leaves_the_list_and_its_text() {
        let mut result = list();
        drop_windows(&set(&["hwnd:0xab"]), &mut result);
        assert_eq!(result["windows"], json!([{ "id": "hwnd:0x10" }]));
        assert_eq!(result["text"], "Windows:\nhwnd:0x10 | app=a pid=1 | \"A\"");
    }

    #[test]
    fn every_window_internal_leaves_no_windows_found() {
        let mut result = list();
        drop_windows(&set(&["hwnd:0x10", "hwnd:0xab"]), &mut result);
        assert_eq!(result["windows"], json!([]));
        assert_eq!(result["text"], "No windows found.");
    }

    #[test]
    fn a_list_without_internal_windows_is_untouched() {
        let mut result = list();
        drop_windows(&set(&["hwnd:0x99"]), &mut result);
        assert_eq!(result, list());
        drop_windows(&HashSet::new(), &mut result);
        assert_eq!(result, list());
    }

    #[test]
    fn a_snapshot_without_text_is_filtered_by_id() {
        let mut result = object(json!({ "windows": [{ "id": "hwnd:0x10" }, { "id": "hwnd:0xab" }, { "title": "no id" }] }));
        drop_windows(&set(&["hwnd:0xab"]), &mut result);
        assert_eq!(result["windows"], json!([{ "id": "hwnd:0x10" }, { "title": "no id" }]));
        assert!(!result.contains_key("text"));
    }

    #[test]
    fn the_answer_names_ids_without_case_or_blanks() {
        assert_eq!(ids_of(&json!({ "windowIds": ["HWND:0xAB", " ", 7] })), Some(set(&["hwnd:0xab"])));
        assert_eq!(ids_of(&json!({})), None);
    }

    #[tokio::test(start_paused = true)]
    async fn the_cache_asks_again_after_its_ttl_and_forgets_a_failed_ask() {
        let cache = IdCache::new();
        let asked = AtomicUsize::new(0);
        let ask = |answer: Option<HashSet<String>>| {
            asked.fetch_add(1, Ordering::SeqCst);
            async move { answer }
        };
        assert_eq!(cache.ids(|| ask(None)).await, HashSet::new());
        assert_eq!(cache.ids(|| ask(Some(set(&["hwnd:0x1"])))).await, set(&["hwnd:0x1"]));
        assert_eq!(cache.ids(|| ask(Some(set(&["hwnd:0x2"])))).await, set(&["hwnd:0x1"]));
        assert_eq!(asked.load(Ordering::SeqCst), 2);
        sleep(TTL * 2).await;
        assert_eq!(cache.ids(|| ask(Some(set(&["hwnd:0x2"])))).await, set(&["hwnd:0x2"]));
        assert_eq!(asked.load(Ordering::SeqCst), 3);
    }
}
