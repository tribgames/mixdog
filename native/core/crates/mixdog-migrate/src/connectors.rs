//! The one-time connector transition, which 1.4.5 runs at every start
//! (`session-runtime/boot/apis.mjs:115-128`) and the runtime no longer carries:
//!
//! - `migrateConnectorAccounts()` (`resource-mcp-api.mjs:174`): the one-account servers of a
//!   catalog connector (`gmail`, `gmail-2`…) merge into one server holding the accounts
//!   (`connector-catalog.mjs:316` `mergeConnectorAccountServers`), their MCP scopes go, and
//!   every store that names a merged-away server names the surviving one
//!   (`connector-merge-migration.mjs`), the mapping of an earlier start that a store failed
//!   (`connector-merge-pending.json`) included;
//! - `ensureConnectorAccountIds()` (`connector-accounts-mcp.mjs:115`): every account stored
//!   without an id gets one, and the accounts-in-use records from before identities are bound
//!   to the account under their name.
//!
//! One `config/agent.mcpServers` item does both in the late wave, after the stores are
//! verified. Its stage computes every rewritten file from the files as they are and keeps them
//! with an index; publishing renames each into place (one already in place is skipped), so a
//! resumed run lands the same bytes. A file the 1.4.5 start would fail on (one that does not
//! parse, a policy of neither shape) is left as it is, as is every file of a quarantined store;
//! the pending record is this item's source and goes with it. Ids are derived from the config
//! bytes, the server and the account's position (a random v4 id each in 1.4.5), so a resumed
//! run gives the same ones.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::HashSet;
use std::path::Path;
use std::sync::LazyLock;

use icu_collator::CollatorBorrowed;
use icu_collator::options::CollatorOptions;
use icu_locale_core::Locale;
use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_mcp::connector_model::account_enabled;
use mixdog_mcp::connector_model::account_entry;
use mixdog_mcp::connector_model::account_server;
use mixdog_mcp::connector_model::accounts_of;
use mixdog_mcp::connector_model::accounts_url;
use mixdog_mcp::connector_model::connector_of_server;
use mixdog_mcp::connector_model::gmail_app_password_account;
use mixdog_mcp::connector_model::server_settings;
use mixdog_mcp::connectors::CATALOG;
use mixdog_mcp::hooks::config_report;
use mixdog_mcp::permissions::PROJECT_CONNECTORS_FILE;
use mixdog_mcp::permissions::Permission;
use mixdog_mcp::permissions::Policy;
use mixdog_mcp::permissions::parse_connector_policy;
use mixdog_mcp::scopes::ExtensionScopes;
use mixdog_mcp::scopes::ScopeKind;
use mixdog_store::schema::migration::Contract;
use mixdog_store::schema::migration::ItemKind;
use mixdog_store::schema::migration::ItemState;
use mixdog_store::schema::migration::KindGroup;
use mixdog_store::schema::migration::ManifestItem;
use mixdog_store::schema::migration::QuarantineCode;
use mixdog_store::schema::migration::Root;
use mixdog_store::schema::migration::StagedEntry;
use mixdog_store::schema::migration::Target;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use sha2::Digest as _;
use sha2::Sha256;

use crate::durable;
use crate::error::Blocked;
use crate::error::Result;
use crate::framework::ItemContext;
use crate::framework::MigrationRoots;
use crate::framework::Staged;
use crate::framework::Verdict;
use crate::json;
use crate::plan;
use crate::plan::PlanSink;
use crate::stores;

pub const ITEM: &str = "config/agent.mcpServers";
const TARGET_KEY: &str = "agent.mcpServers";
/// `connector-merge-migration.mjs` `PENDING_MERGE_FILE`.
pub const PENDING_FILE: &str = "connector-merge-pending.json";
/// `connector-accounts-mcp.mjs` `ACCOUNTS_IN_USE_FILE`.
pub const IN_USE_FILE: &str = "connector-accounts-in-use.json";
/// The data-dir hook files (`migrateHookFiles`); project and plugin ones are never rewritten.
const HOOK_FILES: [&str; 2] = ["hooks.json", "hooks/hooks.json"];
const AGENT_STORES: [&str; 2] = ["agents", "bots"];
/// Set in the accounts-in-use file once its name-only records were bound.
const IDS_MIGRATED: &str = "#ids";
/// Under the item's stage dir: the index of the rewritten files and each one's bytes.
const INDEX_FILE: &str = "index.json";
const FILES_DIR: &str = "files";

/// A merged connector: the surviving server and every server merged into it, the surviving
/// one first, then the others lowest-numbered first.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Group {
    pub name: String,
    pub from: Vec<String>,
}

// ── The config merge (`connector-catalog.mjs` `mergeConnectorAccountServers`) ──────────────

/// `a.localeCompare(b, 'en', { numeric: true })`.
fn natural_order(a: &str, b: &str) -> Ordering {
    static COLLATOR: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
        let locale: Locale = "en-u-kn".parse().expect("a valid locale");
        CollatorBorrowed::try_new((&locale).into(), CollatorOptions::default()).expect("compiled collation data")
    });
    COLLATOR.compare(a, b)
}

/// What makes an account the same connection as another: its transport, whatever its name
/// (`connectionOf`).
fn connection_of(cfg: &Value, account: &Value) -> String {
    let mut server = account_server(cfg, account);
    server["name"] = Value::String(String::new());
    server.to_string()
}

fn with_key(value: Value, key: &str, field: Value) -> Value {
    let mut map = match value {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    map.insert(key.to_owned(), field);
    Value::Object(map)
}

/// The servers with every catalog connector's servers merged into one holding the accounts,
/// and the groups merged; none when nothing changes (`mergeConnectorAccountServers`).
pub fn merge_servers(input: Option<&Value>) -> (Map<String, Value>, Vec<Group>) {
    let mut servers = input.and_then(Value::as_object).cloned().unwrap_or_default();
    let mut merged = Vec::new();
    for entry in &CATALOG {
        let mut names: Vec<String> = servers
            .iter()
            .filter(|(_, cfg)| cfg.is_object() && connector_of_server(cfg).is_some_and(|c| c.id == entry.id))
            .map(|(name, _)| name.clone())
            .collect();
        if names.is_empty() {
            continue;
        }
        names.sort_by(|a, b| natural_order(a, b));
        let grouped: Vec<&String> =
            names.iter().filter(|name| servers[name.as_str()].get("accounts").is_some_and(Value::is_array)).collect();
        if names.len() == 1 && grouped.len() == 1 {
            continue;
        }
        let target = match grouped.first() {
            Some(name) => (*name).clone(),
            None if names.iter().any(|name| name == entry.id) => entry.id.to_owned(),
            None => names[0].clone(),
        };
        let order: Vec<String> =
            std::iter::once(target.clone()).chain(names.iter().filter(|name| **name != target).cloned()).collect();
        let off = order.iter().all(|name| servers[name.as_str()].get("enabled") == Some(&Value::Bool(false)));
        let mut accounts = Vec::new();
        let mut seen_names = HashSet::new();
        let mut seen_addresses = HashSet::new();
        let mut seen_connections = HashSet::new();
        for name in &order {
            let cfg = &servers[name.as_str()];
            let own = if cfg.get("accounts").is_some_and(Value::is_array) {
                accounts_of(cfg)
            } else {
                vec![account_entry(name, cfg)]
            };
            // A merged server that was off keeps its accounts off, unless the whole connector
            // is off.
            let server_off = !off && cfg.get("enabled") == Some(&Value::Bool(false));
            for account in own {
                let account_name = account.get("name").and_then(Value::as_str).unwrap_or_default().to_owned();
                let address = gmail_app_password_account(&account_server(cfg, &account));
                let connection = connection_of(cfg, &account);
                if seen_names.contains(&account_name)
                    || (!address.is_empty() && seen_addresses.contains(&address))
                    || seen_connections.contains(&connection)
                {
                    continue;
                }
                seen_names.insert(account_name);
                if !address.is_empty() {
                    seen_addresses.insert(address);
                }
                seen_connections.insert(connection);
                accounts.push(if server_off { with_key(account, "enabled", Value::Bool(false)) } else { account });
            }
        }
        let mut server = server_settings(&servers[target.as_str()]);
        server.shift_remove("enabled");
        for name in &order {
            servers.shift_remove(name);
        }
        let none_on = !accounts.is_empty() && !accounts.iter().any(account_enabled);
        server.insert("type".into(), json!("http"));
        server.insert("url".into(), Value::String(accounts_url(entry.id)));
        server.insert("connector".into(), json!(entry.id));
        server.insert("accounts".into(), Value::Array(accounts));
        if off || none_on {
            server.insert("enabled".into(), Value::Bool(false));
        }
        servers.insert(target.clone(), Value::Object(server));
        merged.push(Group { name: target, from: order });
    }
    (servers, merged)
}

// ── Account ids (`connector-accounts-mcp.mjs` `ensureConnectorAccountIds`) ──────────────────

fn has_id(account: &Value) -> bool {
    account.get("id").and_then(Value::as_str).is_some_and(|id| !id.is_empty())
}

/// A v4-shaped id of the account at `index` of `server`, derived from `seed`.
fn account_id(seed: &str, server: &str, index: usize) -> String {
    let digest = Sha256::digest(format!("{seed}\0{server}\0{index}").as_bytes());
    let bytes: [u8; 16] = digest[..16].try_into().expect("16 bytes");
    uuid::Builder::from_random_bytes(bytes).into_uuid().hyphenated().to_string()
}

/// `servers` with an id given to every connector account stored without one; `None` when
/// every account has one (`withAccountIds`).
fn with_account_ids(servers: &Map<String, Value>, seed: &str) -> Option<Map<String, Value>> {
    let missing = |cfg: &Value| accounts_of(cfg).iter().any(|account| !has_id(account));
    if !servers.values().any(missing) {
        return None;
    }
    Some(
        servers
            .iter()
            .map(|(name, cfg)| {
                if !missing(cfg) {
                    return (name.clone(), cfg.clone());
                }
                let accounts: Vec<Value> = cfg["accounts"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .enumerate()
                    .map(|(index, account)| {
                        if account.is_object() && !has_id(account) {
                            with_key(account.clone(), "id", Value::String(account_id(seed, name, index)))
                        } else {
                            account.clone()
                        }
                    })
                    .collect();
                (name.clone(), with_key(cfg.clone(), "accounts", Value::Array(accounts)))
            })
            .collect(),
    )
}

/// The accounts-in-use records with each name-only one bound to the account then under that
/// name, marked done; `None` when already done.
fn bind_in_use(stored: &Map<String, Value>, servers: &Map<String, Value>) -> Option<Map<String, Value>> {
    if json::js_truthy(stored.get(IDS_MIGRATED)) {
        return None;
    }
    let mut next = stored.clone();
    next.insert(IDS_MIGRATED.into(), Value::Bool(true));
    for (connector, name) in stored {
        let Some(name) = name.as_str().filter(|name| !name.is_empty()) else { continue };
        let cfg = servers.values().find(|one| {
            connector_of_server(one).is_some_and(|c| c.id == connector) && !accounts_of(one).is_empty()
        });
        let account = cfg.and_then(|cfg| {
            accounts_of(cfg).into_iter().find(|account| account.get("name").and_then(Value::as_str) == Some(name))
        });
        if let Some(account) = account.filter(has_id) {
            next.insert(connector.clone(), json!({ "name": name, "id": account["id"] }));
        }
    }
    Some(next)
}

// ── Stores naming a server (`connector-merge-migration.mjs`) ──────────────────────────────────

fn named(policy: &Policy, server: &str) -> bool {
    policy.off.contains(server)
        || policy.allow.as_ref().is_some_and(|allow| allow.contains(server))
        || policy.tools.contains_key(server)
}

/// The policy with every merged-away server mapped onto its surviving one; `None` when it
/// names none (`mapMergedConnectorPolicy`). The merged connector is on or off as the
/// surviving server was when the policy names it, else as the lowest-numbered one it names;
/// per-tool entries move to the surviving name, the surviving server's own first, those of a
/// server that was off dropped when the connector stays on.
pub fn map_policy(policy: &Policy, groups: &[Group]) -> Option<Policy> {
    let mut current = policy.clone();
    let mut changed = false;
    for Group { name, from } in groups {
        if !from.iter().filter(|server| *server != name).any(|server| named(&current, server)) {
            continue;
        }
        let live: Vec<&String> = from.iter().filter(|server| current.enabled(server)).collect();
        let first = from.iter().find(|server| named(&current, server)).expect("a merged-away server is named");
        let on = current.enabled(first);
        let mut off: BTreeSet<String> = current.off.iter().filter(|server| !from.contains(server)).cloned().collect();
        let mut allow: Option<BTreeSet<String>> =
            current.allow.as_ref().map(|allow| allow.iter().filter(|server| !from.contains(server)).cloned().collect());
        match &mut allow {
            Some(allow) if on => {
                allow.insert(name.clone());
            }
            None if !on => {
                off.insert(name.clone());
            }
            _ => {}
        }
        let mut tools = current.tools.clone();
        for server in from {
            tools.remove(server);
        }
        let sources: Vec<&String> = if on { live } else { from.iter().collect() };
        let mut moved: BTreeMap<String, Permission> = BTreeMap::new();
        for server in std::iter::once(name).chain(sources.iter().copied().filter(|id| *id != name)) {
            if !sources.contains(&server) {
                continue;
            }
            for (tool, permission) in current.tools.get(server).into_iter().flatten() {
                moved.entry(tool.clone()).or_insert(*permission);
            }
        }
        if !moved.is_empty() {
            tools.insert(name.clone(), moved);
        }
        current = Policy { allow, off, tools };
        changed = true;
    }
    changed.then_some(current)
}

fn tools_value(tools: &BTreeMap<String, Permission>) -> Value {
    Value::Object(tools.iter().map(|(tool, permission)| (tool.clone(), json!(permission.name()))).collect())
}

/// A mapped policy as the agent.json `connectors` field stores it; `None`: the field goes
/// (`storedValue`, `storedConnectorPolicy`).
fn stored_value(policy: &Policy) -> Option<Value> {
    let Some(allow) = &policy.allow else {
        if policy.off.is_empty() && policy.tools.is_empty() {
            return None;
        }
        let mut out = Map::new();
        out.insert("off".into(), json!(policy.off));
        if !policy.tools.is_empty() {
            let tools = policy.tools.iter().map(|(server, tools)| (server.clone(), tools_value(tools))).collect();
            out.insert("tools".into(), Value::Object(tools));
        }
        return Some(Value::Object(out));
    };
    let ids: BTreeSet<&String> = allow.iter().chain(policy.tools.keys()).collect();
    Some(Value::Array(
        ids.into_iter()
            .map(|id| {
                let mut entry = Map::new();
                entry.insert("id".into(), json!(id));
                entry.insert("enabled".into(), json!(allow.contains(id)));
                if let Some(tools) = policy.tools.get(id) {
                    entry.insert("tools".into(), tools_value(tools));
                }
                Value::Object(entry)
            })
            .collect(),
    ))
}

/// JS `escapeRegExp`.
fn escape_reg_exp(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if ".*+?^${}()|[]\\".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

type Renames = Vec<(String, String)>;

/// A tool identifier or pattern (`mcp__a__x`, `^mcp__a__.*$`, `Bash|mcp__a__x`) with each
/// `mcp__<merged-away>` alternative renamed (`renameToolPattern`).
fn rename_tool_pattern(value: &str, renames: &Renames) -> String {
    let mut next = value.to_owned();
    for (gone, name) in renames {
        let pattern = format!(r"(^|\|)(\^?)mcp__{}(?=__|(?![A-Za-z0-9_-]))", escape_reg_exp(gone));
        let identifier = JsRegex::new(&pattern, "").expect("an escaped name is a literal");
        next = identifier
            .replace_all_with(&next, |caps| format!("{}{}mcp__{name}", caps.get(1).unwrap_or(""), caps.get(2).unwrap_or("")));
    }
    next
}

/// A condition `Tool(arguments)`: only the tool part is an identifier (`renameCondition`).
fn rename_condition(value: &str, renames: &Renames) -> String {
    match value.find('(') {
        None => rename_tool_pattern(value, renames),
        Some(open) => rename_tool_pattern(&value[..open], renames) + &value[open..],
    }
}

/// Renames a string field of `owner`; true when it changed.
fn rename_field(owner: &mut Map<String, Value>, key: &str, renames: &Renames, rename: fn(&str, &Renames) -> String) -> bool {
    let Some(Value::String(text)) = owner.get(key) else { return false };
    let next = rename(text, renames);
    if next == *text {
        return false;
    }
    owner.insert(key.to_owned(), Value::String(next));
    true
}

fn rename_handler(hook: &mut Value, renames: &Renames) -> bool {
    let Some(hook) = hook.as_object_mut() else { return false };
    let mut changed = false;
    if hook.get("type").and_then(Value::as_str) == Some("mcp_tool") {
        let surviving = hook.get("server").and_then(Value::as_str).and_then(|server| {
            let server = js_trim(server);
            renames.iter().find(|(gone, _)| gone == server).map(|(_, name)| name.clone())
        });
        if let Some(name) = surviving {
            hook.insert("server".into(), Value::String(name));
            changed = true;
        }
        changed |= rename_field(hook, "tool", renames, rename_tool_pattern);
    }
    changed | rename_field(hook, "if", renames, rename_condition)
}

/// The legacy rule list of a hooks document, as `normalizeRules` finds it.
fn rules_mut(document: &mut Value) -> Option<&mut Vec<Value>> {
    if document.is_array() {
        return document.as_array_mut();
    }
    for key in ["toolBefore", "beforeTool"] {
        if document.get(key).is_some_and(Value::is_array) {
            return document.get_mut(key).and_then(Value::as_array_mut);
        }
    }
    document.pointer_mut("/hooks/toolBefore").and_then(Value::as_array_mut)
}

/// Renames the tool identifiers of a hooks document in place; true when any changed
/// (`renameInHooks`).
fn rename_in_hooks(document: &mut Value, renames: &Renames) -> bool {
    let mut changed = false;
    if config_report(document).standard {
        for groups in document["hooks"].as_object_mut().into_iter().flat_map(|hooks| hooks.values_mut()) {
            for group in groups.as_array_mut().into_iter().flatten() {
                let Some(group) = group.as_object_mut() else { continue };
                changed |= rename_field(group, "matcher", renames, rename_tool_pattern);
                changed |= rename_field(group, "if", renames, rename_condition);
                for hook in group.get_mut("hooks").and_then(Value::as_array_mut).into_iter().flatten() {
                    changed |= rename_handler(hook, renames);
                }
            }
        }
    } else {
        for rule in rules_mut(document).into_iter().flatten() {
            let Some(rule) = rule.as_object_mut() else { continue };
            changed |= rename_field(rule, "tool", renames, rename_tool_pattern);
            changed |= rename_field(rule, "name", renames, rename_tool_pattern);
            changed |= rename_field(rule, "if", renames, rename_condition);
        }
    }
    changed
}

// ── The whole transition over a data dir ──────────────────────────────────────────────────

/// The files the transition rewrites, in publication order (a backup before its file), and
/// the lone surrogates their rewrite replaced.
#[derive(Default)]
struct Conversion {
    outputs: Vec<(String, Vec<u8>)>,
    replaced: u64,
}

impl Conversion {
    /// `rel` rewritten to `document`; its old bytes become `<rel>.bak` when `backup`
    /// (`writeJsonAtomicSync(…, { backup: true })`).
    fn rewrite(&mut self, rel: &str, previous: Vec<u8>, document: &Value, replaced: u64, backup: bool) {
        if backup {
            self.outputs.push((format!("{rel}.bak"), previous));
        }
        self.outputs.push((rel.to_owned(), stores::config_bytes(document)));
        self.replaced += replaced;
    }
}

/// A parsed JSON file: its value and the lone surrogates replaced on the way.
type Parsed = (Value, u64);

/// A JSON file: its bytes and, when it parses (a leading BOM allowed), its value and the
/// lone surrogates replaced on the way.
fn read_document(path: &Path) -> Result<Option<(Vec<u8>, Option<Parsed>)>> {
    let Some(bytes) = durable::read_optional(path)? else { return Ok(None) };
    // As Node reads a file (`JSON.parse(readFileSync(path, 'utf8'))`): invalid UTF-8 as U+FFFD, any nesting, 1e400 as null.
    let parsed = json::parse_config(&bytes).ok().map(|parsed| (parsed.value, parsed.replaced_surrogates));
    Ok(Some((bytes, parsed)))
}

/// The groups the pending record still maps (`validGroup`); none when it is absent or does
/// not parse.
fn pending_groups(data: &Path) -> Result<Vec<Group>> {
    let Some((_, Some((document, _)))) = read_document(&data.join(PENDING_FILE))? else { return Ok(Vec::new()) };
    let groups = document.get("merged").and_then(Value::as_array).into_iter().flatten();
    Ok(groups
        .filter_map(|group| {
            let name = group.get("name")?.as_str()?;
            let from = group.get("from")?.as_array()?.iter().map(|s| s.as_str().map(str::to_owned)).collect::<Option<_>>()?;
            Some(Group { name: name.to_owned(), from })
        })
        .collect())
}

fn convert_agents(data: &Path, groups: &[Group], writable: &dyn Fn(&str) -> bool, out: &mut Conversion) -> Result<()> {
    for store in AGENT_STORES {
        for (entry, is_dir) in durable::list_dir(&data.join(store))? {
            let rel = format!("{store}/{entry}/agent.json");
            if !is_dir || !writable(&rel) {
                continue;
            }
            let Some((bytes, Some((mut document, replaced)))) = read_document(&data.join(&rel))? else { continue };
            let Some(manifest) = document.as_object_mut() else { continue };
            let Ok(Some(policy)) = parse_connector_policy(manifest.get("connectors")) else { continue };
            let Some(next) = map_policy(&policy, groups) else { continue };
            match stored_value(&next) {
                Some(value) => manifest.insert("connectors".into(), value),
                None => manifest.shift_remove("connectors"),
            };
            out.rewrite(&rel, bytes, &document, replaced, true);
        }
    }
    Ok(())
}

fn convert_projects(data: &Path, groups: &[Group], writable: &dyn Fn(&str) -> bool, out: &mut Conversion) -> Result<()> {
    if !writable(PROJECT_CONNECTORS_FILE) {
        return Ok(());
    }
    let Some((bytes, Some((mut document, replaced)))) = read_document(&data.join(PROJECT_CONNECTORS_FILE))? else {
        return Ok(());
    };
    let Some(projects) = document.get_mut("projects").and_then(Value::as_object_mut) else { return Ok(()) };
    let mut changed = false;
    let roots: Vec<String> = projects.keys().cloned().collect();
    for root in roots {
        let Some(off) = projects[&root].get("off").and_then(Value::as_array) else { continue };
        let policy = Policy { allow: None, off: off.iter().map(json::js_to_string).collect(), tools: BTreeMap::new() };
        let Some(next) = map_policy(&policy, groups) else { continue };
        if next.off.is_empty() {
            projects.shift_remove(&root);
        } else {
            projects[&root]["off"] = json!(next.off);
        }
        changed = true;
    }
    if changed {
        out.rewrite(PROJECT_CONNECTORS_FILE, bytes, &document, replaced, true);
    }
    Ok(())
}

fn convert_hooks(data: &Path, groups: &[Group], writable: &dyn Fn(&str) -> bool, out: &mut Conversion) -> Result<()> {
    // `new Map(entries)`: a later entry for the same server replaces the value in place.
    let mut renames: Renames = Vec::new();
    for Group { name, from } in groups {
        for gone in from.iter().filter(|server| *server != name) {
            match renames.iter_mut().find(|(server, _)| server == gone) {
                Some(entry) => entry.1 = name.clone(),
                None => renames.push((gone.clone(), name.clone())),
            }
        }
    }
    for rel in HOOK_FILES {
        if !writable(rel) {
            continue;
        }
        let Some((bytes, Some((mut document, replaced)))) = read_document(&data.join(rel))? else { continue };
        if (document.is_object() || document.is_array()) && rename_in_hooks(&mut document, &renames) {
            out.rewrite(rel, bytes, &document, replaced, true);
        }
    }
    Ok(())
}

/// The config with its connectors merged (and their MCP scopes dropped) and every account
/// given its id, and the groups merged; `None` when it changes nothing.
fn convert_config(bytes: &[u8], document: &Value) -> (Option<Value>, Map<String, Value>, Vec<Group>) {
    let agent = document.get("agent").and_then(Value::as_object).cloned().unwrap_or_default();
    let (merged_servers, merged) = merge_servers(agent.get("mcpServers"));
    let mut next = agent.clone();
    if !merged.is_empty() {
        next.insert("mcpServers".into(), Value::Object(merged_servers));
        let scoped = ExtensionScopes::from_config(agent.get("extensionScopes").unwrap_or(&Value::Null));
        for Group { name, from } in &merged {
            for gone in from.iter().filter(|server| *server != name) {
                if scoped.projects(ScopeKind::Mcp, gone).is_none() {
                    continue;
                }
                let mut scopes = ExtensionScopes::from_config(next.get("extensionScopes").unwrap_or(&Value::Null));
                scopes.set(ScopeKind::Mcp, js_trim(gone), Vec::new());
                next.insert("extensionScopes".into(), scopes.to_config());
            }
        }
    }
    let servers = next.get("mcpServers").and_then(Value::as_object).cloned().unwrap_or_default();
    let servers = match with_account_ids(&servers, &durable::sha256_hex(bytes)) {
        Some(given) => {
            next.insert("mcpServers".into(), Value::Object(given.clone()));
            given
        }
        None => servers,
    };
    if next == agent && merged.is_empty() {
        return (None, servers, merged);
    }
    let mut document = document.clone();
    document["agent"] = Value::Object(next);
    (Some(document), servers, merged)
}

/// Every file the transition rewrites over the data dir as it is; `writable` says whether a
/// file may be rewritten.
fn convert(data: &Path, writable: &dyn Fn(&str) -> bool) -> Result<Conversion> {
    let mut out = Conversion::default();
    let config = stores::read_config(data)?;
    let (config_next, servers, merged) = match &config {
        Some((bytes, document)) => convert_config(bytes, document),
        None => (None, Map::new(), Vec::new()),
    };
    let mut groups = pending_groups(data)?;
    for group in merged {
        if !groups.contains(&group) {
            groups.push(group);
        }
    }
    if !groups.is_empty() {
        convert_agents(data, &groups, writable, &mut out)?;
        convert_projects(data, &groups, writable, &mut out)?;
        convert_hooks(data, &groups, writable, &mut out)?;
    }
    if let (Some(next), Some((bytes, _))) = (&config_next, config) {
        out.rewrite(stores::CONFIG_FILE, bytes, next, 0, false);
    }
    // A missing file is left missing: the runtime reads no marker.
    if writable(IN_USE_FILE)
        && let Some((bytes, Some((stored, replaced)))) = read_document(&data.join(IN_USE_FILE))?
    {
        let stored = stored.as_object().cloned().unwrap_or_default();
        if let Some(next) = bind_in_use(&stored, &servers) {
            out.rewrite(IN_USE_FILE, bytes, &Value::Object(next), replaced, false);
        }
    }
    Ok(out)
}

/// The preserved store whose item holds `rel`.
fn owner(rel: &str) -> Option<ItemKind> {
    match rel {
        stores::CONFIG_FILE => Some(ItemKind::Settings),
        IN_USE_FILE => Some(ItemKind::ConnectorAccounts),
        PROJECT_CONNECTORS_FILE => Some(ItemKind::ProjectConnectors),
        "hooks/hooks.json" => Some(ItemKind::Hooks),
        _ if rel.starts_with("agents/") => Some(ItemKind::Agents),
        _ if rel.starts_with("bots/") => Some(ItemKind::Bots),
        _ => None,
    }
}

// ── The item ────────────────────────────────────────────────────────────────────────────────

/// One item when the transition changes anything or a pending record is left.
pub fn plan(roots: &MigrationRoots, sink: &mut PlanSink) -> Result<()> {
    let pending = durable::is_file(&roots.data.join(PENDING_FILE));
    if !pending && convert(&roots.data, &|_| true)?.outputs.is_empty() {
        return Ok(());
    }
    let sources = if pending { vec![sink.source(Root::Data, PENDING_FILE, false)?] } else { Vec::new() };
    sink.add_item(plan::item(
        ITEM,
        KindGroup::Data,
        ItemKind::Settings,
        Contract::Convert,
        sources,
        Some(Target::ConfigKey { key: TARGET_KEY.into() }),
    )?)
}

/// Every rewritten file under the stage dir, with the index naming each one's target and
/// SHA-256; the index's SHA-256 is the output. A file of a quarantined store is not rewritten.
pub fn stage(cx: &ItemContext<'_>, item: &ManifestItem) -> Result<Staged> {
    let writable = |rel: &str| {
        owner(rel).is_none_or(|kind| cx.state(&stores::store_key(kind)) != Some(ItemState::Quarantined))
    };
    let conversion = convert(&cx.roots.data, &writable)?;
    let dir = cx.stage_dir(item.key.as_str());
    let mut index = Vec::new();
    for (n, (rel, bytes)) in conversion.outputs.iter().enumerate() {
        durable::write_synced(&dir.join(FILES_DIR).join(n.to_string()), bytes)?;
        index.push(json!({ "path": rel, "sha256": durable::sha256_hex(bytes) }));
    }
    let index = serde_json::to_vec(&index).expect("an index encodes");
    durable::write_synced(&dir.join(INDEX_FILE), &index)?;
    Ok(Staged::Output {
        output_sha256: durable::sha256_hex(&index),
        replaced_surrogates: conversion.replaced,
    })
}

/// The staged index: each target path and the SHA-256 it is published with.
fn staged_index(cx: &ItemContext<'_>, item: &ManifestItem) -> Result<(String, Vec<(String, String)>)> {
    let path = cx.stage_dir(item.key.as_str()).join(INDEX_FILE);
    let bytes = durable::read(&path)?;
    let entries: Vec<Value> = serde_json::from_slice(&bytes).map_err(|e| Blocked::journal(format!("{}: {e}", path.display())))?;
    let index = entries
        .iter()
        .map(|entry| {
            let field = |key: &str| entry.get(key).and_then(Value::as_str).map(str::to_owned);
            field("path").zip(field("sha256")).ok_or_else(|| Blocked::journal(format!("{}: bad entry", path.display())))
        })
        .collect::<Result<_>>()?;
    Ok((durable::sha256_hex(&bytes), index))
}

fn holds(path: &Path, sha256: &str) -> Result<bool> {
    Ok(durable::exists(path)? && durable::hash_file(path)?.1 == sha256)
}

/// Renames each staged file over its target; one already in place is skipped.
pub fn publish(cx: &ItemContext<'_>, item: &ManifestItem, staged: &StagedEntry) -> Result<()> {
    let (sha256, index) = staged_index(cx, item)?;
    if sha256 != staged.output_sha256.as_str() {
        return Err(Blocked::journal(format!("{}: the staged index changed", item.key.as_str())));
    }
    let dir = cx.stage_dir(item.key.as_str()).join(FILES_DIR);
    for (n, (rel, sha256)) in index.iter().enumerate() {
        let target = cx.roots.data.join(rel);
        if holds(&target, sha256)? {
            continue;
        }
        cx.fault(&format!("publish:{}:{rel}", item.key.as_str()))?;
        let file = dir.join(n.to_string());
        if !durable::exists(&file)? {
            return Err(Blocked::TargetConflict { key: item.key.as_str().into(), path: target });
        }
        if let Some(parent) = target.parent() {
            durable::create_dir_all(parent)?;
        }
        durable::durable_rename(&file, &target)?;
    }
    Ok(())
}

/// Every target holds what was staged for it.
pub fn verify(cx: &ItemContext<'_>, item: &ManifestItem) -> Result<Verdict> {
    let (sha256, index) = staged_index(cx, item)?;
    for (rel, want) in &index {
        if !holds(&cx.roots.data.join(rel), want)? {
            return Ok(Verdict::Quarantine {
                code: QuarantineCode::DigestMismatch,
                detail: format!("{rel} does not hold its converted bytes"),
            });
        }
    }
    Ok(Verdict::Verified { digest: Some(json::hex_digest(&sha256)) })
}

#[cfg(test)]
mod tests;
