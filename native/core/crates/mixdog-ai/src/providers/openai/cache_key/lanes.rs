//! Optional routing lanes on OpenAI's prefix-derived keys. A single lane
//! leaves both hash inputs null and adds no suffix, preserving old keys.

use std::collections::{HashMap, VecDeque};
use std::sync::{LazyLock, Mutex};

use mixdog_core_api::domain::provider::RequestOptions;
use serde_json::{Map, Value, json};

const AUTO: &[&str] = &["promptCacheLaneAuto", "openaiCacheLaneAuto"];
const SHARDS: &[&str] = &["promptCacheLaneShards", "openaiCacheLaneShards"];
const ALIASES: &[&str] = &["promptCacheLaneMaxParallel", "openaiCacheMaxParallel"];
const IGNORE_ALIASES: &str = "promptCacheLaneIgnoreAliases";

#[derive(Clone, Default)]
pub(in crate::providers::openai) struct LaneConfig(Map<String, Value>);

#[derive(Default)]
struct Group {
    next: u64,
    slots: HashMap<String, u64>,
    order: VecDeque<String>,
}

static ASSIGNMENTS: LazyLock<Mutex<HashMap<(String, String), Group>>> = LazyLock::new(Mutex::default);

/// A new process has assigned no lane slots.
#[cfg(any(test, feature = "test-support"))]
pub(super) fn reset_assignments() {
    ASSIGNMENTS.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clear();
}

fn non_null(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| !v.is_null())
}

fn nonnegative(value: Option<&Value>) -> Option<u64> {
    let n = mixdog_js::to_number_of(value);
    (n.is_finite() && n >= 0.0).then(|| n.floor() as u64)
}

fn auto_flag(value: &Value) -> bool {
    value.as_bool() == Some(true)
        || value.as_f64() == Some(0.0)
        || value
            .as_str()
            .is_some_and(|s| matches!(mixdog_js::js_trim(s).to_ascii_lowercase().as_str(), "0" | "auto" | "unbounded" | "unlimited" | "none" | "off"))
}

impl LaneConfig {
    pub(in crate::providers::openai) fn from_provider(config: &Value) -> Self {
        Self(
            AUTO.iter()
                .chain(SHARDS)
                .chain(ALIASES)
                .copied()
                .chain([IGNORE_ALIASES])
                .filter_map(|key| Some((key.to_owned(), config.get(key)?.clone())))
                .collect(),
        )
    }

    pub(super) fn resolve(&self, provider: &str, namespace: &str, options: &RequestOptions, var: &dyn Fn(&str) -> Option<String>) -> Lane {
        let param = |key| non_null(options.model_parameters.as_ref().and_then(|p| p.get(key)));
        let lane = |key| non_null(param("promptCacheLane").and_then(|lane| lane.get(key)));
        let config = |key| non_null(self.0.get(key));
        let env = |oauth, public| (provider == "openai-oauth").then(|| var(oauth)).flatten().or_else(|| var(public)).map(Value::String);
        let automatic = lane("auto").is_some_and(auto_flag) || AUTO.iter().any(|&k| param(k).is_some_and(auto_flag) || config(k).is_some_and(auto_flag));
        let count = if automatic {
            0
        } else {
            let shards = param(SHARDS[0])
                .or_else(|| lane("shards"))
                .or_else(|| param(SHARDS[1]))
                .or_else(|| config(SHARDS[0]))
                .or_else(|| config(SHARDS[1]))
                .cloned()
                .or_else(|| env("MIXDOG_OPENAI_OAUTH_CACHE_LANE_SHARDS", "MIXDOG_OPENAI_CACHE_LANE_SHARDS"));
            let raw = shards.or_else(|| {
                if param(IGNORE_ALIASES).and_then(Value::as_bool) == Some(true) || config(IGNORE_ALIASES).and_then(Value::as_bool) == Some(true) {
                    return None;
                }
                param(ALIASES[0])
                    .or_else(|| lane("maxParallel"))
                    .or_else(|| param(ALIASES[1]))
                    .or_else(|| config(ALIASES[0]))
                    .or_else(|| config(ALIASES[1]))
                    .cloned()
                    .or_else(|| env("MIXDOG_OPENAI_OAUTH_CACHE_MAX_PARALLEL", "MIXDOG_OPENAI_CACHE_MAX_PARALLEL"))
            });
            match raw.as_ref() {
                None => 1,
                Some(raw) if raw.as_str() == Some("") => 1,
                Some(raw) if auto_flag(raw) => 0,
                Some(raw) => nonnegative(Some(raw)).unwrap_or(0),
            }
        };
        if count == 1 {
            return Lane::Single;
        }
        let slot = match nonnegative(param("promptCacheLaneSlot").or_else(|| param("cacheLaneSlot"))) {
            Some(slot) if count != 0 => slot % count,
            Some(slot) => slot,
            None => {
                let seed = param("promptCacheLaneSeed")
                    .map(|v| v.as_str().unwrap_or_default())
                    .or(options.session_id.as_deref())
                    .or_else(|| param("providerCacheKey").and_then(Value::as_str))
                    .or_else(|| param("promptCacheKey").and_then(Value::as_str))
                    .or(options.prompt_cache_key.as_deref())
                    .unwrap_or(provider);
                assign(provider, namespace, count, mixdog_js::js_trim(seed))
            }
        };
        Lane::new(count, slot)
    }
}

fn assign(provider: &str, namespace: &str, count: u64, seed: &str) -> u64 {
    let seed = if seed.is_empty() { "mixdog" } else { seed };
    let mut groups = ASSIGNMENTS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let group = groups.entry((provider.to_owned(), namespace.to_owned())).or_default();
    if let Some(&slot) = group.slots.get(seed) {
        return slot;
    }
    let slot = if count == 0 { group.next } else { group.next % count };
    group.next = if count == 0 { group.next + 1 } else { (group.next + 1) % count };
    group.slots.insert(seed.to_owned(), slot);
    group.order.push_back(seed.to_owned());
    if group.slots.len() > 4096
        && let Some(oldest) = group.order.pop_front()
    {
        group.slots.remove(&oldest);
    }
    slot
}

pub(super) enum Lane {
    Single,
    Shard { count: u64, slot: u64 },
}

impl Lane {
    fn new(count: u64, slot: u64) -> Self {
        match count {
            1 => Self::Single,
            0 => Self::Shard { count, slot },
            _ => Self::Shard { count, slot: slot.min(count - 1) },
        }
    }

    pub(super) fn key_parts(&self) -> (Value, Value, String) {
        let Self::Shard { count, slot } = *self else { return (Value::Null, Value::Null, String::new()) };
        let mut n = slot;
        let mut digits = Vec::new();
        loop {
            digits.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(n % 36) as usize] as char);
            n /= 36;
            if n == 0 {
                break;
            }
        }
        if digits.len() == 1 {
            digits.push('0');
        }
        let digits: String = digits.into_iter().rev().collect();
        (json!(slot), if count == 0 { json!("auto") } else { json!(count) }, format!("-s{digits}"))
    }
}
