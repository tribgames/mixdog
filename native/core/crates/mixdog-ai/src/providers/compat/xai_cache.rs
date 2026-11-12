//! The `prompt_cache_key` of an xAI Responses request
//! (`openai-compat-xai.mjs` `xaiResponsesCacheRouting`, `xaiCacheRouting`,
//! `xaiResponsesPromptCacheLane`; `cache-strategy.mjs`
//! `resolveProviderPromptCacheLane`).
//!
//! xAI routes a request to the server holding its cached prefix by this key.
//! The scope picks what the key identifies: the `session` (default), the
//! request `prefix` (one-shot roles share it), or nothing (`none`, `off`,
//! `omit`, or no session id: the field is not sent). A prefix key can be
//! sharded into lanes by the `MIXDOG_*_CACHE_LANE_*` environment.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use mixdog_core_api::domain::provider::ModelRequest;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::providers::google::cache::hash::{stable_stringify, trace_hash};
use crate::registry::keys::Environment;

const DEFAULT_NAMESPACE: &str = "mixdog-xai";
const SCOPE_ENV: &str = "MIXDOG_XAI_RESPONSES_CACHE_SCOPE";
const MAX_ASSIGNMENTS: usize = 4096;

/// Lane shard count, first set wins (a set-but-empty value counts as set).
const SHARD_ENV: &[&str] = &[
    "MIXDOG_XAI_RESPONSES_CACHE_LANE_SHARDS",
    "MIXDOG_GROK_CACHE_LANE_SHARDS",
    "MIXDOG_GROK_RESPONSES_CACHE_LANE_SHARDS",
    "MIXDOG_GROK_OAUTH_CACHE_LANE_SHARDS",
    "MIXDOG_GROK_OAUTH_RESPONSES_CACHE_LANE_SHARDS",
];
/// Read only when none of [`SHARD_ENV`] is set. The `*_CACHE_MAX_PARALLEL`
/// aliases are deliberately not read on this route.
const SHARD_FALLBACK_ENV: &[&str] = &["MIXDOG_XAI_CACHE_LANE_SHARDS", "MIXDOG_OPENAI_CACHE_LANE_SHARDS"];
const AUTO_ENV: &[&str] = &[
    "MIXDOG_XAI_RESPONSES_CACHE_LANE_AUTO",
    "MIXDOG_GROK_CACHE_LANE_AUTO",
    "MIXDOG_GROK_RESPONSES_CACHE_LANE_AUTO",
    "MIXDOG_GROK_OAUTH_CACHE_LANE_AUTO",
    "MIXDOG_GROK_OAUTH_RESPONSES_CACHE_LANE_AUTO",
];

/// The slot an unbounded ("auto") lane gave each seed, in this process: the
/// first seed gets 0, the next 1, and so on (`assignPromptCacheLaneSlot`).
#[derive(Default, Debug)]
pub(crate) struct LaneBook {
    groups: HashMap<String, LaneGroup>,
}

#[derive(Default, Debug)]
struct LaneGroup {
    next: u64,
    by_seed: HashMap<String, u64>,
    order: VecDeque<String>,
}

impl LaneBook {
    fn slot(&mut self, namespace: &str, seed: &str) -> u64 {
        let group = self.groups.entry(namespace.to_owned()).or_default();
        let seed = mixdog_js::js_trim(seed);
        let seed = if seed.is_empty() { "mixdog" } else { seed };
        if let Some(slot) = group.by_seed.get(seed) {
            return *slot;
        }
        let slot = group.next;
        group.next += 1;
        group.by_seed.insert(seed.to_owned(), slot);
        group.order.push_back(seed.to_owned());
        if group.by_seed.len() > MAX_ASSIGNMENTS
            && let Some(oldest) = group.order.pop_front()
        {
            group.by_seed.remove(&oldest);
        }
        slot
    }
}

/// `normalizePromptCacheNamespace`: runs of anything but `[A-Za-z0-9_-]`
/// become one `-`, edge dashes go, and an empty result is `mixdog-shared`.
fn normalize_namespace(value: &str) -> String {
    let text = mixdog_js::js_trim(value);
    let mut out = String::new();
    let mut in_run = false;
    for c in text.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('-');
            in_run = true;
        }
    }
    let out = out.trim_matches('-');
    if out.is_empty() { "mixdog-shared".to_owned() } else { out.to_owned() }
}

/// A UUID derived from the routing seed (`deterministicUuidFromKey`).
fn uuid_from_seed(seed: &str) -> String {
    let hex: String = Sha256::digest(seed.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    let variant = (u8::from_str_radix(&hex[16..17], 16).unwrap_or(0) & 0x3) | 0x8;
    format!("{}-{}-4{}-{variant:x}{}-{}", &hex[0..8], &hex[8..12], &hex[13..16], &hex[17..20], &hex[20..32])
}

/// `promptCacheLaneAutoRequested` for a string.
fn auto_requested(raw: &str) -> bool {
    matches!(
        mixdog_js::js_trim(raw).to_lowercase().as_str(),
        "0" | "auto" | "unbounded" | "unlimited" | "none" | "off"
    )
}

/// `parsePromptCacheLaneLimit`: 0 is the unbounded lane.
fn lane_limit(raw: Option<&str>) -> u64 {
    match raw {
        None | Some("") => 1,
        Some(raw) if auto_requested(raw) => 0,
        Some(raw) => {
            let n = mixdog_js::string_to_number(raw);
            if n.is_finite() && n > 0.0 { n.floor() as u64 } else { 0 }
        }
    }
}

/// `value || null`: JS-falsy becomes null.
fn truthy_or_null(value: &Value) -> Value {
    let falsy = match value {
        Value::Null => true,
        Value::Bool(b) => !b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n == 0.0),
        Value::String(s) => s.is_empty(),
        _ => false,
    };
    if falsy { Value::Null } else { value.clone() }
}

/// `resolveProviderCacheKey(opts, 'xai')` (`providerCacheKey || promptCacheKey || 'mixdog-xai'`) and the model (`model
/// || null`).
fn namespace_and_model(request: &ModelRequest) -> (String, Value) {
    let namespace = request.options.prompt_cache_key.as_deref().filter(|k| !k.is_empty()).unwrap_or(DEFAULT_NAMESPACE);
    let model = if request.model.is_empty() { Value::Null } else { json!(request.model) };
    (namespace.to_owned(), model)
}

pub(crate) struct Routing<'a> {
    pub environment: Option<&'a dyn Environment>,
    pub lanes: &'a Mutex<LaneBook>,
    /// The texts of the system messages as the chat lowering sends them.
    pub system: &'a [String],
}

impl Routing<'_> {
    fn var(&self, name: &str) -> Option<String> {
        self.environment.and_then(|env| env.var(name))
    }

    fn first_var(&self, names: &[&str]) -> Option<String> {
        names.iter().find_map(|name| self.var(name))
    }

    /// `xaiCacheRouting(opts, params, rawTools, model).key`: the `x-grok-conv-id` of a Chat request, always set
    /// (the prefix lane for a shared-scope request, else the session's, else this process's ephemeral one).
    pub fn chat_key(&self, request: &ModelRequest) -> String {
        let options = &request.options;
        let namespace = options.prompt_cache_key.as_deref().filter(|k| !k.is_empty()).unwrap_or(DEFAULT_NAMESPACE);
        let model = if request.model.is_empty() { Value::Null } else { json!(request.model) };
        let session = mixdog_js::js_trim(options.session_id.as_deref().unwrap_or_default());
        let seed = if options.prompt_cache_scope.as_deref() == Some("shared") {
            json!({ "scope": "xai-chat-prefix-v1", "providerKey": namespace, "model": model, "prefixHash": self.prefix_hash(request, namespace, &model) })
        } else {
            json!({
                "scope": "xai-chat-session-v1",
                "providerKey": namespace,
                "model": model,
                "sessionId": if session.is_empty() { format!("ephemeral:{}", crate::pid::id()) } else { session.to_owned() },
            })
        };
        uuid_from_seed(&stable_stringify(&seed))
    }

    /// `None` when the request goes out without a `prompt_cache_key`.
    pub fn key(&self, request: &ModelRequest) -> Option<String> {
        let options = &request.options;
        let shared = options.prompt_cache_scope.as_deref() == Some("shared");
        // `||` chain: an empty string falls through to the next source.
        let scope = options
            .xai_responses_cache_scope
            .clone()
            .filter(|s| !s.is_empty())
            .or_else(|| shared.then(|| "prefix".to_owned()))
            .or_else(|| self.var(SCOPE_ENV).filter(|s| !s.is_empty()))
            .unwrap_or_else(|| "session".to_owned());
        let scope = mixdog_js::js_trim(&scope).to_lowercase();
        let session = mixdog_js::js_trim(options.session_id.as_deref().unwrap_or_default());
        if matches!(scope.as_str(), "none" | "off" | "omit") || (scope == "session" && session.is_empty()) {
            return None;
        }
        if scope != "prefix" {
            return Some(self.chat_key(request));
        }
        let (namespace, model) = namespace_and_model(request);
        let namespace = namespace.as_str();

        let prefix_hash = self.prefix_hash(request, namespace, &model);
        let (enabled, slot) = self.lane(options.session_id.as_deref(), session, namespace);
        let mut seed = json!({
            "scope": "xai-responses-prefix-v1",
            "providerKey": namespace,
            "model": model,
            "prefixHash": prefix_hash,
        });
        if enabled {
            seed["laneSlot"] = json!(slot);
        }
        Some(uuid_from_seed(&stable_stringify(&seed)))
    }

    /// `traceHash` of the model, system text and tools the prefix is made of.
    fn prefix_hash(&self, request: &ModelRequest, namespace: &str, model: &Value) -> String {
        let tools: Vec<Value> = request
            .tools
            .iter()
            .map(|tool| {
                json!({
                    "name": truthy_or_null(&json!(tool.name)),
                    "description": tool.description,
                    "inputSchema": truthy_or_null(&tool.input_schema),
                })
            })
            .collect();
        trace_hash(&stable_stringify(&json!({
            "scope": "xai-prefix-model-system-tools",
            "providerKey": namespace,
            "model": model,
            "systemMessages": self.system,
            "tools": tools,
        })))
    }

    /// Whether the prefix key is sharded into lanes, and the lane this
    /// session takes. `raw_session` is the option as given (a blank id still
    /// seeds the unbounded lane's slot).
    fn lane(&self, raw_session: Option<&str>, session: &str, namespace: &str) -> (bool, u64) {
        let auto = self.var_auto();
        let shards = if auto {
            0
        } else {
            let raw = self.first_var(SHARD_ENV).or_else(|| self.first_var(SHARD_FALLBACK_ENV));
            lane_limit(raw.as_deref())
        };
        let unbounded = auto || shards == 0;
        let enabled = unbounded || shards > 1;
        let slot = if !unbounded {
            if shards > 0 {
                let basis = if session.is_empty() { crate::pid::id().to_string() } else { session.to_owned() };
                let digest = Sha256::digest(basis.as_bytes());
                u64::from(u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]])) % shards
            } else {
                0
            }
        } else {
            let seed = raw_session.filter(|s| !s.is_empty()).unwrap_or("xai-cache-lane");
            let group = normalize_namespace(namespace);
            self.lanes.lock().unwrap_or_else(std::sync::PoisonError::into_inner).slot(&format!("xai\0{group}"), seed)
        };
        (enabled, slot)
    }

    fn var_auto(&self) -> bool {
        self.first_var(AUTO_ENV).is_some_and(|raw| auto_requested(&raw))
    }
}
