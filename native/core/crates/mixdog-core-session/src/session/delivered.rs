//! The delivered-completions registry (`delivered-completions.mjs`): a completion whose body
//! already reached the model by another path (a task read's ACK, a UI that injected it) is
//! recognised by its execution id or by a hash of its text, so a queued twin is not delivered
//! again. One registry per daemon, held by its single owner: sliding 6 h expiry, at most 512
//! keys, the oldest key (insertion order, refreshed by every record and hit) evicted first.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::Mutex;

use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use sha1::Digest;
use sha1::Sha1;

use super::Clock;

const TTL_MS: i64 = 6 * 60 * 60 * 1000;
const MAX_ENTRIES: usize = 512;

static LABELLED_ID: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^(?:> )?(?:\[?task_id:|agent task:)\s*([^\s\]]+)", "im"));
static ASYNC_ID: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^Async \S+ task (\S+) ", "i"));

/// `taskNotificationId`: the task a completion text names, empty when it names none.
pub(crate) fn task_notification_id(text: &str) -> String {
    if let Some(parsed) = mixdog_protocol::text_class::parse_task_notification(text) {
        return parsed.task_id;
    }
    [&*LABELLED_ID, &*ASYNC_ID]
        .into_iter()
        .find_map(|re| re.captures(text).and_then(|caps| caps.get(1)).filter(|id| !id.is_empty()))
        .unwrap_or_default()
        .to_owned()
}

fn exec_key(execution_id: &str) -> Option<String> {
    let id = js_trim(execution_id);
    (!id.is_empty()).then(|| format!("id:{id}"))
}

fn text_key(text: &str) -> Option<String> {
    let value = js_trim(text);
    (!value.is_empty()).then(|| {
        let digest = Sha1::digest(value.as_bytes());
        format!("tx:{}", digest.iter().map(|b| format!("{b:02x}")).collect::<String>())
    })
}

/// `execKey(executionId || taskNotificationId(text))` and `textKey(text)`.
fn keys_of(execution_id: Option<&str>, text: Option<&str>) -> Vec<String> {
    let text = text.unwrap_or_default();
    let id = match execution_id {
        Some(id) if !id.is_empty() => id.to_owned(),
        _ => task_notification_id(text),
    };
    [exec_key(&id), text_key(text)].into_iter().flatten().collect()
}

pub struct DeliveredCompletions {
    clock: Arc<dyn Clock>,
    /// Key and expiry, oldest first.
    keys: Mutex<VecDeque<(String, i64)>>,
}

impl DeliveredCompletions {
    pub fn new(clock: Arc<dyn Clock>) -> Self {
        Self { clock, keys: Mutex::default() }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, VecDeque<(String, i64)>> {
        self.keys.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn take(keys: &mut VecDeque<(String, i64)>, key: &str) -> bool {
        match keys.iter().position(|(k, _)| k == key) {
            Some(at) => {
                keys.remove(at);
                true
            }
            None => false,
        }
    }

    /// `recordDeliveredCompletion`: both keys, refreshed to the newest; whether any key exists.
    pub fn record(&self, execution_id: Option<&str>, text: Option<&str>) -> bool {
        let now = self.clock.now_ms();
        let mut keys = self.lock();
        keys.retain(|(_, expires)| *expires > now);
        let keys_of = keys_of(execution_id, text);
        for key in &keys_of {
            Self::take(&mut keys, key);
            keys.push_back((key.clone(), now + TTL_MS));
        }
        while keys.len() > MAX_ENTRIES {
            keys.pop_front();
        }
        !keys_of.is_empty()
    }

    /// `isDeliveredCompletion`: either key present and unexpired; a hit refreshes every present key.
    pub fn is_delivered(&self, execution_id: Option<&str>, text: Option<&str>) -> bool {
        let now = self.clock.now_ms();
        let mut keys = self.lock();
        let wanted = keys_of(execution_id, text);
        let mut hit = false;
        for key in &wanted {
            match keys.iter().find(|(k, _)| k == key) {
                Some((_, expires)) if *expires > now => hit = true,
                Some(_) => {
                    Self::take(&mut keys, key);
                }
                None => {}
            }
        }
        if !hit {
            return false;
        }
        for key in &wanted {
            if Self::take(&mut keys, key) {
                keys.push_back((key.clone(), now + TTL_MS));
            }
        }
        true
    }
}
