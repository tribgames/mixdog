//! Who is asking, and which sessions and rows are theirs (Node `agent-tool/helpers.mjs`).

use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

use serde_json::Value;

/// `String(value ?? '').trim()`.
pub fn clean(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => mixdog_js::js_trim(s).to_owned(),
        Some(other) => mixdog_js::js_trim(&mixdog_js::value_to_string(other)).to_owned(),
    }
}

pub fn clean_str(value: &str) -> String {
    mixdog_js::js_trim(value).to_owned()
}

/// `positiveInt`: `Math.floor(Number(value))` when finite and at least 1.
pub fn positive_int(value: Option<&Value>) -> Option<u64> {
    let n = match value? {
        Value::Null => return None,
        Value::String(s) => mixdog_js::string_to_number(s),
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64()?,
        _ => return None,
    };
    let floored = n.floor();
    (floored.is_finite() && floored >= 1.0).then_some(floored as u64)
}

/// The caller's context: the owner session that holds the agents, else the host process.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct Scope {
    /// `callerSessionId` or `routingSessionId`.
    pub caller_session_id: Option<String>,
    /// `clientHostPid`.
    pub host_pid: Option<u64>,
}

/// A request's caller: its scope plus the working directory it asks from.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct Caller {
    pub scope: Scope,
    pub cwd: String,
}

/// The ownership fields a session and the worker row describing it share.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct Owner {
    pub parent_session_id: String,
    pub owner_session_id: String,
    pub client_host_pid: Option<u64>,
}

#[derive(Clone, Default, PartialEq, Debug)]
pub struct SessionFacts {
    pub id: String,
    pub agent: String,
    pub cwd: String,
    pub owner: Owner,
}

/// A row that names a tag: a worker row, a reap tombstone or a stored session record.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct TagRecord {
    pub tag: String,
    pub session_id: String,
    pub agent: String,
    pub cwd: String,
    pub owner: Owner,
}

impl Scope {
    /// Without a `scope`/`terminal`/`term` of `all`/`global` (or `allTerminals`), the caller's own.
    pub fn of(args: &Value, caller: &Scope) -> Scope {
        let named = {
            // `args.scope || args.terminal || args.term`: the first truthy raw value.
            let truthy = |v: &&Value| match v {
                Value::Null | Value::Bool(false) => false,
                Value::String(s) => !s.is_empty(),
                Value::Number(n) => n.as_f64() != Some(0.0),
                _ => true,
            };
            let first = [args.get("scope"), args.get("terminal"), args.get("term")].into_iter().flatten().find(truthy);
            clean(first).to_lowercase()
        };
        if args.get("allTerminals") == Some(&Value::Bool(true)) || named == "all" || named == "global" {
            return Scope::default();
        }
        caller.clone()
    }

    /// Agents are session-owned: when the caller carries a session id the scope is that owner
    /// session, strictly; pid matching alone would leak sibling Lead sessions of one host.
    pub fn owns(&self, owner: &Owner) -> bool {
        if let Some(wanted) = &self.caller_session_id {
            let held = if clean_str(&owner.parent_session_id).is_empty() { &owner.owner_session_id } else { &owner.parent_session_id };
            return clean_str(held) == *wanted;
        }
        match self.host_pid {
            None => true,
            Some(wanted) => owner.client_host_pid == Some(wanted),
        }
    }
}

/// `normalizeAgentName`.
pub fn normalize_agent_name(value: &str) -> String {
    let lowered = clean_str(value).to_lowercase();
    let mut id = String::new();
    let mut in_run = false;
    for c in lowered.chars() {
        if mixdog_js::is_js_space(c) || c == '_' {
            if !in_run {
                id.push('-');
            }
            in_run = true;
        } else {
            id.push(c);
            in_run = false;
        }
    }
    match id.as_str() {
        "maint" | "maintenance" | "memory" => "maintainer".into(),
        "heavy" | "heavyworker" => "heavy-worker".into(),
        "review" => "reviewer".into(),
        _ => id,
    }
}

/// `path.resolve(base, rel)`, lexically: `rel` wins when absolute, `.` and `..` fold.
pub fn resolve_path(base: &str, rel: &str) -> String {
    let joined: PathBuf = Path::new(base).join(rel);
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out.to_string_lossy().into_owned()
}
