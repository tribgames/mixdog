//! The connector policy an agent's save carries (`agent.json` `connectors`): Node's
//! `connectorPolicyInput` (`parseConnectorPolicy` then `storedConnectorPolicy`) and, for a remote
//! client, the check that a save never gives a tool more authority (`connectorPolicyWidens`,
//! `assertConnectorPolicyNotWidened` without an approved tool change).

use std::collections::BTreeSet;

use mixdog_mcp::connectors::group_id;
use mixdog_mcp::permissions::Permission;
use mixdog_mcp::permissions::RawPolicy;
use mixdog_mcp::permissions::Policy;
use mixdog_mcp::permissions::parse_connector_policy;
use serde_json::Map;
use serde_json::Value;

/// `NO_WIDEN_MESSAGE`.
pub const NO_WIDEN: &str = "This change would widen what the bot may do without asking; make it on the desktop.";

fn clean(value: &Value) -> String {
    value.as_str().map_or_else(String::new, |s| mixdog_js::js_trim(s).to_owned())
}

fn utf16_sorted(mut list: Vec<String>) -> Vec<String> {
    list.sort_by_key(|s| s.encode_utf16().collect::<Vec<u16>>());
    list.dedup();
    list
}

/// `uniqueIds`.
fn unique_ids(list: Option<&Value>) -> Vec<String> {
    utf16_sorted(list.and_then(Value::as_array).into_iter().flatten().map(clean).filter(|s| !s.is_empty()).collect())
}

/// `Object.entries(value)`: an object's entries in JavaScript's key order (integer-like keys
/// first, ascending).
fn entries(value: Option<&Value>) -> Vec<(&String, &Value)> {
    value.and_then(Value::as_object).map(|map| mixdog_js::js_object_keys(map).into_iter().map(|key| (key, &map[key])).collect()).unwrap_or_default()
}

/// `toolOverrides`: in JavaScript's key order, a later key that trims to an earlier one wins.
fn tool_overrides(value: Option<&Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (server, tools) in entries(value) {
        let mut own = Map::new();
        for (tool, permission) in entries(Some(tools)) {
            if !clean(&Value::String(tool.clone())).is_empty() && permission.as_str().is_some_and(|p| Permission::parse(p).is_some()) {
                own.insert(mixdog_js::js_trim(tool).to_owned(), permission.clone());
            }
        }
        let server = mixdog_js::js_trim(server);
        if !server.is_empty() && !own.is_empty() {
            out.insert(server.to_owned(), Value::Object(own));
        }
    }
    out
}

/// `connectorPolicyInput(value)`: a policy given to a save as its stored form (`None` removes the
/// field). Only a deny-list policy `{ off, tools? }` is accepted.
pub(super) fn policy_input(value: &Value) -> Result<Option<Value>, String> {
    if value.is_array() {
        return Err("connectors must be { off: [connector id…], tools? } or null".into());
    }
    let Some(policy) = parse_connector_policy(Some(value))? else { return Ok(None) };
    if policy.allow.is_some() {
        return Err("a legacy connector list must be migrated before it is saved".into());
    }
    Ok(stored_policy(unique_ids(value.get("off")), &tool_overrides(value.get("tools"))))
}

/// `storedConnectorPolicy({ off, tools })`: the form a deny-list policy is saved in; `None` when
/// it switches nothing off (the same as no policy).
pub(super) fn stored_policy(off: Vec<String>, tools: &Map<String, Value>) -> Option<Value> {
    let off = utf16_sorted(off.iter().map(|id| clean(&Value::String(id.clone()))).filter(|id| !id.is_empty()).collect());
    let tools = tool_overrides(Some(&Value::Object(tools.clone())));
    if off.is_empty() && tools.is_empty() {
        return None;
    }
    let mut stored = Map::new();
    stored.insert("off".into(), Value::Array(off.into_iter().map(Value::String).collect()));
    if !tools.is_empty() {
        stored.insert("tools".into(), Value::Object(tools));
    }
    Some(Value::Object(stored))
}

/// A policy as `parseConnectorPolicy` reads it, in JavaScript's key order: `allow` only for a
/// legacy list.
#[derive(Clone, Debug, PartialEq)]
pub struct Parsed {
    pub allow: Option<Vec<String>>,
    pub off: Vec<String>,
    pub tools: Map<String, Value>,
}

impl Parsed {
    /// `DENY_ALL_CONNECTORS`: no connector is on.
    fn deny_all() -> Self {
        Self { allow: Some(Vec::new()), off: Vec::new(), tools: Map::new() }
    }

    /// `parseConnectorPolicy(value)` for a field that already passed the shape check
    /// (`read_raw_policy`); `None` for no policy.
    pub(super) fn of_field(value: &Value) -> Option<Self> {
        match value {
            Value::Null => None,
            Value::Array(items) => {
                let mut allow = Vec::new();
                let mut tools = Map::new();
                for item in items {
                    let id = item.get("id").map(clean).unwrap_or_default();
                    if id.is_empty() {
                        continue;
                    }
                    if item.get("enabled") == Some(&Value::Bool(true)) {
                        allow.push(id.clone());
                    }
                    let wrapped = Value::Object(Map::from_iter([(id.clone(), item.get("tools").cloned().unwrap_or(Value::Null))]));
                    if let Some(Value::Object(own)) = tool_overrides(Some(&wrapped)).shift_remove(&id)
                        && let Value::Object(kept) = tools.entry(id).or_insert_with(|| Value::Object(Map::new()))
                    {
                        kept.extend(own);
                    }
                }
                Some(Self { allow: Some(utf16_sorted(allow)), off: Vec::new(), tools })
            }
            other => Some(Self { allow: None, off: unique_ids(other.get("off")), tools: tool_overrides(other.get("tools")) }),
        }
    }

    /// The object Node holds: `{ off, tools }`, with `allow` first for a legacy list.
    pub fn json(&self) -> Value {
        let mut out = Map::new();
        if let Some(allow) = &self.allow {
            out.insert("allow".into(), Value::Array(allow.iter().cloned().map(Value::String).collect()));
        }
        out.insert("off".into(), Value::Array(self.off.iter().cloned().map(Value::String).collect()));
        out.insert("tools".into(), Value::Object(self.tools.clone()));
        Value::Object(out)
    }
}

/// What an agent's `agent.json` holds as its connector policy (`readConnectorsFile`).
#[derive(Clone, Debug, PartialEq)]
pub enum Stored {
    /// No file or no field: every connector is on.
    Absent,
    Policy(Parsed),
    /// A policy that cannot be trusted: no connector is on.
    DenyAll,
}

impl Stored {
    pub(super) fn of_raw(raw: RawPolicy) -> Self {
        match raw {
            RawPolicy::Absent => Self::Absent,
            RawPolicy::Field(field) => Parsed::of_field(&field).map_or(Self::Absent, Self::Policy),
            RawPolicy::DenyAll => Self::DenyAll,
        }
    }

    /// The stored value as the widening check reads `before`: a parsed policy, `None` for none.
    pub(super) fn before(&self) -> Option<Value> {
        self.parsed().map(|policy| policy.json())
    }

    fn parsed(&self) -> Option<Parsed> {
        match self {
            Self::Absent => None,
            Self::Policy(policy) => Some(policy.clone()),
            Self::DenyAll => Some(Parsed::deny_all()),
        }
    }

    /// The policy as the editor returns it: `Null` for none.
    pub fn json(&self) -> Value {
        self.parsed().map_or(Value::Null, |policy| policy.json())
    }

    /// `connectorEnabled(policy, serverId)`.
    pub fn enabled(&self, server: &str) -> bool {
        let Some(policy) = self.parsed() else { return true };
        if policy.allow.as_ref().is_some_and(|allow| !allow.iter().any(|id| id == server)) {
            return false;
        }
        !policy.off.iter().any(|id| id == server)
    }

    /// `editablePolicyOf(stored)`: a legacy list (or an unreadable policy) as the equivalent deny
    /// list over the installed connectors, so an edit never widens it; none is an empty one.
    pub(super) fn editable(&self, installed: &[String]) -> (Vec<String>, Map<String, Value>) {
        let Some(policy) = self.parsed() else { return (Vec::new(), Map::new()) };
        let Some(allow) = &policy.allow else { return (policy.off, policy.tools) };
        let installed = utf16_sorted(installed.iter().map(|id| clean(&Value::String(id.clone()))).filter(|id| !id.is_empty()).collect());
        let missing = installed.into_iter().filter(|id| !allow.contains(id));
        let off = utf16_sorted(policy.off.iter().cloned().chain(missing).map(|id| clean(&Value::String(id))).filter(|id| !id.is_empty()).collect());
        (off, tool_overrides(Some(&Value::Object(policy.tools))))
    }

    /// The explicit per-tool entries of the policy: connector → tool → permission.
    pub(super) fn tools(&self) -> Map<String, Value> {
        self.parsed().map(|policy| policy.tools).unwrap_or_default()
    }
}

/// `connectorToolEntries(tools, group, tool)`: the entries for `tool` under connector `group` or
/// any of its accounts, topmost first (the connector's own, then the lowest-numbered account).
pub(super) fn tool_entries(tools: &Map<String, Value>, group: &str, tool: &str) -> Vec<Permission> {
    let account_number = |id: &str| -> u64 {
        id.rsplit_once('-').filter(|(_, n)| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())).and_then(|(_, n)| n.parse().ok()).unwrap_or(0)
    };
    let mut found: Vec<(u64, Permission)> = mixdog_js::js_object_keys(tools)
        .into_iter()
        .filter(|id| group_id(id) == group)
        .filter_map(|id| Some((account_number(id), tools[id].get(tool)?.as_str().and_then(Permission::parse)?)))
        .collect();
    found.sort_by_key(|(n, _)| *n);
    found.into_iter().map(|(_, permission)| permission).collect()
}

fn rank(permission: Permission) -> u8 {
    match permission {
        Permission::Disabled => 0,
        Permission::NeedsApproval => 1,
        Permission::Auto => 2,
    }
}

/// A policy as the widening check reads it: `after` is read as given, its names untrimmed (the
/// check parses only the stored policy), so a name that trims differently is a different one.
struct View {
    off: BTreeSet<String>,
    /// Connector id → tool → the stored value (valid or not), in JavaScript's key order.
    tools: Vec<(String, Tools)>,
}

/// One connector's tools and the permission each holds, `None` for a value that is no permission.
type Tools = Vec<(String, Option<Permission>)>;

/// A `tools` object as a view reads it: connector id → tool → permission, each level in
/// JavaScript's key order.
fn view_tools(tools: Option<&Value>) -> Vec<(String, Tools)> {
    entries(tools)
        .into_iter()
        .map(|(id, own)| (id.clone(), entries(Some(own)).into_iter().map(|(tool, p)| (tool.clone(), p.as_str().and_then(Permission::parse))).collect()))
        .collect()
}

/// `parseConnectorPolicy(before).tools`: `toolOverrides` of the stored value.
fn stored_tools(before: Option<&Value>) -> Map<String, Value> {
    tool_overrides(before.and_then(|v| v.get("tools")))
}

impl View {
    /// The stored policy `before` as `parseConnectorPolicy` reads it: its `off` is the parsed
    /// set, its tools are `toolOverrides` of the stored value (trimmed names, valid permissions
    /// only), in the order the value holds them.
    fn of_stored(policy: &Policy, before: Option<&Value>) -> Self {
        Self { off: policy.off.clone(), tools: view_tools(Some(&Value::Object(stored_tools(before)))) }
    }

    fn raw(value: Option<&Value>) -> Self {
        let value = value.filter(|v| !v.is_null());
        let off = value.and_then(|v| v.get("off")).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
        Self { off, tools: view_tools(value.and_then(|v| v.get("tools"))) }
    }

    /// `connectorToolEntries`: the valid entries for `tool` under connector `group` or any of its
    /// accounts, topmost first.
    fn entries(&self, group: &str, tool: &str) -> Vec<Permission> {
        let account_number = |id: &str| -> u64 {
            id.rsplit_once('-').filter(|(_, n)| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())).and_then(|(_, n)| n.parse().ok()).unwrap_or(0)
        };
        let mut found: Vec<(u64, Permission)> = self
            .tools
            .iter()
            .filter(|(id, _)| group_id(id) == group)
            .filter_map(|(id, own)| Some((account_number(id), own.iter().find(|(t, _)| t == tool)?.1?)))
            .collect();
        found.sort_by_key(|(n, _)| *n);
        found.into_iter().map(|(_, p)| p).collect()
    }

    /// `accountRank`: 0 when that account is off, else the topmost entry for the connector, else
    /// `unset`.
    fn account_rank(&self, account: &str, group: &str, tool: &str, unset: u8) -> u8 {
        if self.off.contains(account) {
            return 0;
        }
        self.entries(group, tool).first().map_or(unset, |p| rank(*p))
    }
}

/// `connectorPolicyWidens(before, after)`: whether replacing the stored policy `before` with
/// `after` could give any tool more authority, judged on effective permissions.
fn widens(before: Option<&Value>, after: Option<&Value>) -> bool {
    let old = match parse_connector_policy(before) {
        Ok(policy) => policy.unwrap_or_default(),
        Err(_) => return true,
    };
    if old.allow.is_some() {
        return true;
    }
    let (old, next) = (View::of_stored(&old, before), View::raw(after));
    if old.off.iter().any(|server| !next.off.contains(server)) {
        return true;
    }
    let mut pairs: BTreeSet<(String, String)> = BTreeSet::new();
    for view in [&old, &next] {
        for (id, own) in &view.tools {
            for (tool, _) in own {
                pairs.insert((group_id(id), tool.clone()));
            }
        }
    }
    for (group, tool) in pairs {
        // Each account on its own, plus one the policy never names (it stands for every
        // installed account that is not listed).
        let mut accounts: BTreeSet<String> = BTreeSet::from(["\0unlisted account".to_owned()]);
        let ids = |view: &View| view.tools.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>();
        let named = std::iter::once(group.clone()).chain(old.off.iter().cloned()).chain(next.off.iter().cloned()).chain(ids(&old)).chain(ids(&next));
        accounts.extend(named.filter(|id| group_id(id) == group));
        for account in &accounts {
            if next.account_rank(account, &group, &tool, 2) > old.account_rank(account, &group, &tool, 1) {
                return true;
            }
        }
    }
    false
}

/// The one change a person approved on a card (`withApprovedConnectorToolChange`): this tool of
/// this connector goes from `from` to `to`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApprovedToolChange {
    pub server: String,
    pub tool: String,
    pub from: Permission,
    pub to: Permission,
}

/// `pinTool(policy, group, tool)`: the approved tool's entries (the connector's, and any
/// account's) pinned to one value in a policy, so a comparison judges every other tool and switch.
fn pinned(policy: &Policy, before: Option<&Value>, group: &str, tool: &str) -> Value {
    let mut tools = Map::new();
    for (id, own) in entries(Some(&Value::Object(stored_tools(before)))) {
        let mut entry = own.as_object().cloned().unwrap_or_default();
        if group_id(id) == group {
            entry.insert(tool.into(), Value::String("disabled".into()));
        }
        tools.insert(id.clone(), Value::Object(entry));
    }
    let mut own = match tools.get(group) {
        Some(Value::Object(own)) => own.clone(),
        _ => Map::new(),
    };
    own.insert(tool.into(), Value::String("disabled".into()));
    tools.insert(group.into(), Value::Object(own));
    let mut out = Map::new();
    out.insert("off".into(), Value::Array(policy.off.iter().cloned().map(Value::String).collect()));
    out.insert("tools".into(), Value::Object(tools));
    Value::Object(out)
}

/// `pinTool` of the policy being written, as given: its names are not trimmed (only the stored
/// policy is parsed).
fn pinned_raw(policy: Option<&Value>, group: &str, tool: &str) -> Value {
    let policy = policy.filter(|v| !v.is_null());
    let mut tools = Map::new();
    for (id, own) in entries(policy.and_then(|p| p.get("tools"))) {
        let mut entry = own.as_object().cloned().unwrap_or_default();
        if group_id(id) == group {
            entry.insert(tool.into(), Value::String("disabled".into()));
        }
        tools.insert(id.clone(), Value::Object(entry));
    }
    let mut own = match tools.get(group) {
        Some(Value::Object(own)) => own.clone(),
        _ => Map::new(),
    };
    own.insert(tool.into(), Value::String("disabled".into()));
    tools.insert(group.into(), Value::Object(own));
    let mut out = Map::new();
    out.insert("off".into(), policy.and_then(|p| p.get("off")).cloned().filter(|v| !v.is_null()).unwrap_or_else(|| Value::Array(Vec::new())));
    out.insert("tools".into(), Value::Object(tools));
    Value::Object(out)
}

/// `assertApprovedToolChange`: only the approved tool may go to `to`, judged on the stored policy
/// it writes over.
fn assert_approved(before: Option<&Value>, after: Option<&Value>, change: &ApprovedToolChange) -> Result<(), String> {
    let old = parse_connector_policy(before).map_err(|_| NO_WIDEN.to_owned())?.unwrap_or_default();
    // The approved change is the connector's: its one entry goes to `to`.
    let group = group_id(&change.server);
    let landed = after.and_then(|after| after.get("tools")).and_then(|tools| tools.get(&group)).and_then(|own| own.get(&change.tool));
    if old.allow.is_some() || landed.and_then(Value::as_str) != Some(change.to.name()) {
        return Err(NO_WIDEN.into());
    }
    if widens(Some(&pinned(&old, before, &group, &change.tool)), Some(&pinned_raw(after, &group, &change.tool))) {
        return Err(NO_WIDEN.into());
    }
    // No override: it asks at least (as `connectorPolicyWidens` reads it).
    let was = View::of_stored(&old, before).account_rank(&change.server, &group, &change.tool, 1);
    if was < rank(change.from) {
        return Err("A newer restriction on this tool landed meanwhile; it was kept.".into());
    }
    if was >= rank(change.to) {
        return Err("The tool already has this permission or more; nothing changed.".into());
    }
    Ok(())
}

/// `assertConnectorPolicyNotWidened(before, after)`; inside an approved tool change, only that
/// change may.
pub(super) fn assert_not_widened(before: Option<&Value>, after: Option<&Value>, approved: Option<&ApprovedToolChange>) -> Result<(), String> {
    if let Some(change) = approved {
        return assert_approved(before, after, change);
    }
    if widens(before, after) { Err(NO_WIDEN.into()) } else { Ok(()) }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]
mod tests;
