//! Single-file and directory stores of SM §11.2 outside the sessions: preserved stores
//! (bytes unchanged, verified by SHA-256 and parse), retired caches and leftovers, the
//! legacy usage inputs, and the config rewrites the runtime no longer carries
//! (`agent.compaction` legacy keys; the connector transition, `crate::connectors`).

use std::collections::BTreeSet;
use std::path::Path;
use std::path::PathBuf;

use mixdog_store::schema::bounded::Digest;
use mixdog_store::schema::migration::Contract;
use mixdog_store::schema::migration::ItemKind;
use mixdog_store::schema::migration::ItemState;
use mixdog_store::schema::migration::KindGroup;
use mixdog_store::schema::migration::ManifestItem;
use mixdog_store::schema::migration::QUARANTINE_DIR;
use mixdog_store::schema::migration::QuarantineCode;
use mixdog_store::schema::migration::QuarantineReason;
use mixdog_store::schema::migration::QuarantinedSource;
use mixdog_store::schema::migration::REASON_FILE;
use mixdog_store::schema::migration::REASON_FORMAT;
use mixdog_store::schema::migration::Root;
use mixdog_store::schema::migration::SourceFile;
use mixdog_store::schema::migration::StagedEntry;
use mixdog_store::schema::migration::Target;
use serde_json::Map;
use serde_json::Value;

use crate::connectors;
use crate::durable;
use crate::error::Blocked;
use crate::error::Result;
use crate::framework::ItemContext;
use crate::framework::ItemDriver;
use crate::framework::MigrationRoots;
use crate::framework::Staged;
use crate::framework::Verdict;
use crate::framework::Wave;
use crate::json;
use crate::plan;
use crate::plan::PlanSink;
use crate::temp_files;

/// What a preserved store consists of, relative to its root.
enum Spec {
    /// Exact files (each with its `.bak` sibling when present).
    Files(&'static [&'static str]),
    /// Every file under these directories.
    Dirs(&'static [&'static str]),
}

struct Store {
    kind: ItemKind,
    root: Root,
    spec: Spec,
    /// A singleton the core cannot run without: a parse failure blocks the migration.
    singleton: bool,
}

const fn store(kind: ItemKind, root: Root, spec: Spec, singleton: bool) -> Store {
    Store { kind, root, spec, singleton }
}

use ItemKind as K;
use Root::Data as D;

const STORES: &[Store] = &[
    store(K::Goals, D, Spec::Dirs(&["goals"]), false),
    store(K::QuotaResume, D, Spec::Files(&["quota-resume.json"]), false),
    store(K::HumanGate, D, Spec::Dirs(&["human-gate"]), false),
    store(K::ConnectorAccounts, D, Spec::Files(&["connector-accounts-by-conversation.json", "connector-accounts-in-use.json"]), false),
    store(K::GatewaySessionRoutes, D, Spec::Files(&["gateway-session-routes.json"]), false),
    store(K::PromptCacheTouches, D, Spec::Files(&["prompt-cache-touches.json"]), false),
    store(K::PromptCacheIdleGaps, D, Spec::Files(&["prompt-cache-idle-gaps.json"]), false),
    store(K::Heartbeat, D, Spec::Files(&["heartbeat.json"]), false),
    store(K::RoutineResults, D, Spec::Files(&["routine-results.json"]), false),
    store(K::Settings, D, Spec::Files(&["mixdog-config.json"]), true),
    store(K::CoreMemory, D, Spec::Files(&["core-memory.json"]), false),
    store(K::ProjectsRegistry, Root::Home, Spec::Files(&["projects.json"]), false),
    store(K::Agents, D, Spec::Dirs(&["agents"]), false),
    store(K::Bots, D, Spec::Dirs(&["bots"]), false),
    store(K::Workflows, D, Spec::Dirs(&["workflows"]), false),
    store(K::Schedules, D, Spec::Dirs(&["schedules"]), false),
    store(K::Hooks, D, Spec::Dirs(&["hooks"]), false),
    store(K::Skills, D, Spec::Dirs(&["skills"]), false),
    store(K::Plugins, D, Spec::Files(&["plugins/registry.json"]), false),
    store(K::McpConfig, D, Spec::Files(&[".mcp.json"]), false),
    store(K::ProjectConnectors, D, Spec::Files(&["project-connectors.json"]), false),
    store(K::TuiPromptHistory, D, Spec::Dirs(&["tui-prompt-history"]), false),
    store(K::Worktrees, D, Spec::Files(&["worktrees-v1/registry.json"]), false),
];

/// Retired by exact name under `<D>` (derived, caches, bookkeeping; SM §11.2).
const RETIRED_FILES: &[&str] = &[
    "agent-worker-header-cache.json",
    "bridge-workers.json",
    "session-sweep-records.json",
    "session-catalog.sqlite",
    "session-catalog.sqlite-wal",
    "session-catalog.sqlite-shm",
    "pending-dispatches.json",
    "session-log-migration.json",
    "litellm-catalog.json",
    "modelsdev-catalog.json",
    "gemini-models.json",
    "client-versions.json",
    "update-check-cache.json",
    "cache.local.json",
];

/// Records and live folders the core and launcher still read where 1.4.5 left them (`mixdog-core-agents`
/// `store_migration`: the kind stamp runs again without its record, once the worker index it reads is gone;
/// `live-sessions/<pid>.pid`: written by `mixdog` before starting the core for staged-update coordination).
/// No plan retires them; an item an earlier build planned to retire one settles with its files left in place.
const KEPT_RECORDS: &[&str] = &["agent-kind-migration.json", "live-sessions"];

const CATALOG_APPLICATION_ID: i64 = 0x4d58_5343;

fn session_catalog_name() -> &'static str {
    "session-catalog.sqlite"
}

/// Whether `session-catalog.sqlite` and its WAL/SHM are left where they are. 1.4.5 refused a database that is not its own
/// (another `application_id`) and moved aside only proven corruption, so it is retired only when it is Mixdog's, an empty
/// database or proven corrupt; a lock, an access error or any other answer that proves none of these keeps it.
pub(crate) fn keeps_catalog(data: &std::path::Path) -> bool {
    use rusqlite::ErrorCode;
    let path = data.join(session_catalog_name());
    // Only a file known to be absent has nothing to keep: a metadata error proves nothing, so it keeps the set.
    match mixdog_fsio::metadata(&mixdog_fsio::Unlaned, &path) {
        Ok(meta) if meta.is_file() => {}
        Ok(_) => return false,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return false,
        Err(_) => return true,
    }
    let corrupt = |e: &rusqlite::Error| matches!(e.sqlite_error_code(), Some(ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt));
    let Some((id, objects)) = mixdog_store::sqlite::read_only_identity(&path) else {
        return true;
    };
    match (id, objects) {
        (Ok(id), Ok(objects)) => id != CATALOG_APPLICATION_ID && !(id == 0 && objects == 0),
        (Err(e), _) | (_, Err(e)) => !corrupt(&e),
    }
}

/// Whether `item` retires a file of the catalog set that [`keeps_catalog`] keeps; asked again at disposal, since a resumed
/// run reuses the plan an earlier build journaled.
pub(crate) fn keeps_catalog_item(item: &ManifestItem, data: &std::path::Path) -> bool {
    let rel = item.key.as_str().split_once("/data/").map_or("", |(_, r)| r);
    item.kind == K::Retired && RETIRED_FILES.contains(&rel) && rel.starts_with(session_catalog_name()) && keeps_catalog(data)
}

/// 1.4.5's attachment tree, which the core never changes: it stays whole for a rollback, and its blobs are taken in by
/// `crate::legacy_blobs` alone. Only a manifest an earlier build planned has items there (its blobs as
/// `store/attachmentBlobs`, its census files and cut writes as retire items); such an item settles with its sources left
/// where they are, unread.
const LEGACY_ATTACHMENTS: &str = "prompt-attachments/";

fn in_legacy_attachments(item: &ManifestItem) -> bool {
    item.kind == K::AttachmentBlobs || item.sources.iter().any(|s| s.root == D && s.path.starts_with(LEGACY_ATTACHMENTS))
}

/// Retired directories under `<D>`, one item each.
const RETIRED_DIRS: &[&str] = &["session-writer-locks", "media/renditions"];

/// `gateway-usage.local.jsonl` is not here: at 1.4.5 it is the live store the core appends to per request and the
/// footer reads (`route-meta.mjs`), which the usage history import (`mixdog-ledger` `history`) only reads. `gateway-usage.local.json` is not
/// either: only the store's first writer retires it (renamed to `.migrated.bak`), which the Rust writer does too.
const LEDGER_LEGACY_INPUTS: &[&str] =
    &["usage-rollup.local.json", "usage-rollup.local.json.migrated.bak", "gateway-usage.local.jsonl.migrated.bak", "gateway-usage.local.json.migrated.bak"];

/// Root-level retire patterns (besides exact names).
fn is_retired_pattern(name: &str) -> bool {
    name.starts_with("session-summaries.json.bak-")
        || name.starts_with("session-catalog.sqlite.corrupt-")
        || (name.starts_with("session-cwd-") && name.ends_with(".txt"))
        || (name.ends_with("-oauth-models.json"))
        || (name.ends_with("-usage-cache.json"))
        || (name.starts_with("studio-models-") && name.ends_with(".json"))
        || temp_files::is_data_root_leftover(name)
}

/// The legacy `agent.compaction` keys the 1.4.5 desktop drops when auto-compaction is
/// switched (`apps/desktop/src/main/settings-store.ts` `update('autoCompact')`).
pub const LEGACY_COMPACTION_KEYS: &[&str] = &[
    "enabled",
    "type",
    "compactType",
    "compact_type",
    "semantic",
    "semanticModel",
    "prune",
    "tailTurns",
    "recallMemoryTimeoutMs",
    "recallIngestLimit",
    "recallChunkLimit",
    "recallLimit",
    "recallCycle1BatchSize",
    "recallRowsPerSession",
    "recallWindowSize",
    "recallConcurrency",
    "recallCycle1DeadlineMs",
];

pub const CONFIG_FILE: &str = "mixdog-config.json";
pub const LEGACY_COMPACTION_ITEM: &str = "config/agent.compaction";
const LEGACY_COMPACTION_TARGET: &str = "agent.compaction";
// The 1.4.5 quota auto-resume switch (`quotaResume.autoResume`) is not migrated: the core reads and writes it where 1.4.5 did
// (`mixdog_core_config::config::quota`), so a profile keeps working under either version and no step has to have run.

/// `agent.compaction` with the legacy keys folded into their current meaning and removed,
/// or `None` when it holds none. Same reading as the 1.4.5 runtime
/// (`config-storage.mjs` normalization): `summaryModel ← semanticModel`,
/// `memoryTimeoutMs ← recallMemoryTimeoutMs` when unset, `auto = auto ≠ false ∧
/// enabled ≠ false`; the other keys were already ignored.
pub fn fold_legacy_compaction(compaction: &Map<String, Value>) -> Option<Option<Map<String, Value>>> {
    if !LEGACY_COMPACTION_KEYS.iter().any(|k| compaction.contains_key(*k)) {
        return None;
    }
    let mut next = compaction.clone();
    if !json::js_truthy(next.get("summaryModel")) && json::js_truthy(next.get("semanticModel")) {
        next.insert("summaryModel".into(), next["semanticModel"].clone());
    }
    if !json::js_truthy(next.get("memoryTimeoutMs")) && json::js_truthy(next.get("recallMemoryTimeoutMs")) {
        next.insert("memoryTimeoutMs".into(), next["recallMemoryTimeoutMs"].clone());
    }
    let off = |v: Option<&Value>| v == Some(&Value::Bool(false));
    let auto = !off(next.get("auto")) && !off(next.get("enabled"));
    for key in LEGACY_COMPACTION_KEYS {
        next.shift_remove(*key);
    }
    if !auto {
        next.insert("auto".into(), Value::Bool(false));
    }
    Some((!next.is_empty()).then_some(next))
}

/// The config document with `agent.compaction` folded; `None` when nothing changes.
fn folded_config(doc: &Value) -> Option<Value> {
    let compaction = doc.get("agent")?.get("compaction")?.as_object()?;
    let folded = fold_legacy_compaction(compaction)?;
    let mut doc = doc.clone();
    let agent = doc.get_mut("agent").and_then(Value::as_object_mut).expect("agent is an object");
    match folded {
        Some(map) => agent.insert("compaction".into(), Value::Object(map)),
        None => agent.shift_remove("compaction"),
    };
    Some(doc)
}

/// A JSON document as 1.4.5 writes it (`JSON.stringify(value, null, 2)` and a newline).
pub(crate) fn config_bytes(doc: &Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec_pretty(doc).expect("a value encodes");
    bytes.push(b'\n');
    bytes
}

pub(crate) fn read_config(data: &Path) -> Result<Option<(Vec<u8>, Value)>> {
    let path = data.join(CONFIG_FILE);
    let Some(bytes) = durable::read_optional(&path)? else {
        return Ok(None);
    };
    let value = json::parse_config(&bytes).map_err(|detail| Blocked::StoreSchema { key: "store/settings".into(), detail })?;
    Ok(Some((bytes, value.value)))
}

/// Recovery and permission rules of a store file, matching its 1.4.5 and 1.5.0 reader.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FilePolicy {
    /// Restores a valid `.bak` sibling when the primary is damaged.
    restore_bak: bool,
    /// Leaves a damaged file in place when no good `.bak` exists (fail-closed connector policies,
    /// hand-edited hooks, bots migration stamp). Moving a connector policy away turns deny-all
    /// into allow-all (`mixdog_mcp::permissions::read_policy_file`).
    keep_without_backup: bool,
    /// Written with owner-only permissions (`0o600` / owner-only ACL) when restored.
    secret: bool,
}

/// Policy of `rel` inside store `kind`, or `None` for files the product does not read as JSON
/// state (non-data files like `tsconfig.json`, `goals/history/**`, `human-gate/audit.jsonl`,
/// `<data>/.mcp.json`, and `.bak` siblings).
fn file_policy(kind: ItemKind, rel: &str) -> Option<FilePolicy> {
    if rel.ends_with(".bak") {
        return None;
    }
    let standard = FilePolicy { restore_bak: true, keep_without_backup: false, secret: false };
    let secret = FilePolicy { restore_bak: true, keep_without_backup: false, secret: true };
    let keep = FilePolicy { restore_bak: true, keep_without_backup: true, secret: false };
    match kind {
        K::Settings if rel == CONFIG_FILE => Some(FilePolicy { restore_bak: false, keep_without_backup: false, secret: true }),
        K::Goals => rel.strip_prefix("goals/").is_some_and(|rest| rest.ends_with(".json") && !rest.contains('/')).then_some(secret),
        K::QuotaResume if rel == "quota-resume.json" => Some(standard),
        // `grants.json` never restores `.bak` (`restoreBackup: false`, so a revoked grant cannot return).
        // `audit.jsonl` skips bad lines in place and is never damaged.
        K::HumanGate if rel == "human-gate/grants.json" => Some(FilePolicy { restore_bak: false, keep_without_backup: false, secret: false }),
        K::ConnectorAccounts if matches!(rel, "connector-accounts-by-conversation.json" | "connector-accounts-in-use.json") => Some(standard),
        K::GatewaySessionRoutes if rel == "gateway-session-routes.json" => Some(standard),
        K::PromptCacheTouches if rel == "prompt-cache-touches.json" => Some(standard),
        K::PromptCacheIdleGaps if rel == "prompt-cache-idle-gaps.json" => Some(standard),
        K::Heartbeat if rel == "heartbeat.json" => Some(standard),
        K::RoutineResults if rel == "routine-results.json" => Some(standard),
        K::CoreMemory if rel == "core-memory.json" => Some(secret),
        K::ProjectsRegistry if rel == "projects.json" => Some(standard),
        K::Agents => {
            rel.strip_prefix("agents/").and_then(|rest| rest.strip_suffix("/agent.json")).is_some_and(|id| !id.is_empty() && !id.contains('/')).then_some(keep)
        }
        K::Bots => (rel == "bots/migration.json"
            || rel.strip_prefix("bots/").and_then(|rest| rest.strip_suffix("/agent.json")).is_some_and(|id| !id.is_empty() && !id.contains('/')))
        .then_some(keep),
        // 1.4.5 and 1.5.0 restore `.bak` only for `<data>/hooks.json`, never `<data>/hooks/hooks.json`
        // (connector merge writes a `.bak` there, so restoring it would roll back newer hook rules).
        K::Hooks if rel == "hooks/hooks.json" => Some(FilePolicy { restore_bak: false, keep_without_backup: true, secret: false }),
        K::Plugins if rel == "plugins/registry.json" => Some(secret),
        K::ProjectConnectors if rel == "project-connectors.json" => Some(keep),
        K::TuiPromptHistory => rel.strip_prefix("tui-prompt-history/").is_some_and(|rest| rest.ends_with(".json") && !rest.contains('/')).then_some(secret),
        K::Worktrees if rel == "worktrees-v1/registry.json" => Some(standard),
        // Workflows (`WORKFLOW.md`), skills (`SKILL.md`), schedules (DB-backed), and `<data>/.mcp.json`
        // (neither 1.4.5 nor 1.5.0 reads `<data>/.mcp.json`) are carried verbatim.
        _ => None,
    }
}

/// Validates a Goal record as `goal-storage.mjs` and `mixdog-core-goal` do: a newer version
/// (`version > 1`) is intact (`unsupportedState`, never replaced); otherwise requires `version === 1`
/// and a `goal` field that is `null` or an object.
fn validate_goal(raw: &Value) -> std::result::Result<(), String> {
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    if raw.get("version").and_then(Value::as_f64).is_some_and(|v| v.fract() == 0.0 && v.abs() <= MAX_SAFE && v > 1.0) {
        return Ok(());
    }
    let current = raw.get("version").and_then(Value::as_f64) == Some(1.0);
    let goal = raw.as_object().and_then(|d| d.get("goal"));
    let (Some(goal), true) = (goal, current) else {
        return Err("unsupported or invalid Goal record".to_owned());
    };
    if !goal.is_null() && !goal.is_object() {
        return Err("invalid Goal value".to_owned());
    }
    Ok(())
}

/// Validates `project-connectors.json` as `mixdog_mcp::permissions::projects_of` does.
fn validate_project_connectors(raw: &Value) -> std::result::Result<(), String> {
    let object = raw.as_object().ok_or("projects must be an object")?;
    let projects = match object.get("projects") {
        None | Some(Value::Null) => return Ok(()),
        Some(Value::Object(map)) => map,
        Some(_) => return Err("projects must be an object".to_owned()),
    };
    for (root, entry) in projects {
        let Some(entry) = entry.as_object() else {
            return Err(format!("project \"{root}\" must be {{ off: [connector id…] }}"));
        };
        if entry.get("off").is_some_and(|v| !v.is_null() && !v.is_array()) {
            return Err(format!("project \"{root}\" must be {{ off: [connector id…] }}"));
        }
    }
    Ok(())
}

/// Validates `bytes` as the product's own reader of `(kind, rel)` reads it: Node `JSON.parse`
/// semantics (`mixdog_statefile::parse_json_text`, accepting invalid UTF-8 as U+FFFD, deep nesting,
/// and out-of-range numbers) plus each store's structural check.
fn validate_store_bytes(kind: ItemKind, path: &Path, rel: &str, bytes: &[u8]) -> std::result::Result<(), (QuarantineCode, String)> {
    if rel == CONFIG_FILE {
        return json::parse_config(bytes).map(drop).map_err(|e| (QuarantineCode::ParseError, format!("{}: {e}", path.display())));
    }
    let value = mixdog_statefile::parse_json_text(bytes).map_err(|e| (QuarantineCode::ParseError, format!("{}: {e}", path.display())))?;
    let schema = match kind {
        K::Goals => validate_goal(&value),
        K::Plugins => value.get("plugins").is_some_and(Value::is_array).then_some(()).ok_or_else(|| "plugin registry has no plugin list".to_owned()),
        K::ProjectConnectors => validate_project_connectors(&value),
        K::Agents => {
            if !value.is_object() {
                Err("not a JSON object".to_owned())
            } else {
                mixdog_mcp::permissions::parse_connector_policy(value.get("connectors")).map(drop)
            }
        }
        K::Bots if rel == "bots/migration.json" => value.is_object().then_some(()).ok_or_else(|| "not a JSON object".to_owned()),
        K::Bots => {
            if !value.is_object() {
                Err("not a JSON object".to_owned())
            } else {
                mixdog_mcp::permissions::parse_connector_policy(value.get("connectors")).map(drop)
            }
        }
        K::ConnectorAccounts => value.is_object().then_some(()).ok_or_else(|| "connector accounts must be an object".to_owned()),
        K::TuiPromptHistory => value.get("entries").is_some_and(Value::is_array).then_some(()).ok_or_else(|| "prompt history has no entries".to_owned()),
        K::Worktrees => value
            .as_object()
            .and_then(|o| o.get("entries"))
            .is_some_and(Value::is_object)
            .then_some(())
            .ok_or_else(|| "worktree registry has no entries object".to_owned()),
        _ => Ok(()),
    };
    schema.map_err(|detail| (QuarantineCode::SchemaViolation, format!("{}: {detail}", path.display())))
}

pub(crate) fn store_key(kind: ItemKind) -> String {
    let name = serde_json::to_value(kind).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
    format!("store/{name}")
}

/// Key of an individual data file planned out of a store (`store/<kind>/<rel>`), so one damaged
/// file can be restored or quarantined without affecting the rest of its store.
pub(crate) fn store_file_key(kind: ItemKind, rel: &str) -> String {
    format!("{}/{rel}", store_key(kind))
}

fn is_restore_item(item: &ManifestItem) -> bool {
    item.contract == Contract::Convert && matches!(item.target, Some(Target::File { .. }))
}

fn is_set_aside_item(item: &ManifestItem) -> bool {
    item.key.as_str().starts_with("retain/") && item.kind != K::LedgerLegacyInputs
}

fn safe_aside_name(rel: &str) -> String {
    let base = rel.rsplit('/').next().unwrap_or(rel);
    let folded = base.trim_end_matches([' ', '.']).to_ascii_lowercase();
    if folded == REASON_FILE || folded.starts_with("shared-") || folded.starts_with("source-") { "source-0".to_owned() } else { base.to_owned() }
}

/// Quarantine copy path of a damaged primary set aside when its valid `.bak` is restored
/// (matches `run::quarantine_source` for the companion `retain/<root>/<path>` item).
fn set_aside_file(data: &Path, primary: &SourceFile) -> PathBuf {
    let key = plan::retain_key(primary.root, &primary.path);
    data.join(QUARANTINE_DIR).join("carried_set_aside").join(plan::escape_key(&key)).join(safe_aside_name(&primary.path))
}

/// Durably copies a damaged primary and writes its `reason.json` under `quarantine/carried_set_aside/`
/// when restoring `.bak` in place on a resumed manifest from an older build.
fn write_resumed_set_aside(cx: &ItemContext<'_>, primary: &SourceFile, bak: &SourceFile, damaged: &[u8], secret: bool) -> Result<()> {
    let key = plan::retain_key(primary.root, &primary.path);
    let dir = cx.roots.data.join(QUARANTINE_DIR).join("carried_set_aside").join(plan::escape_key(&key));
    let aside_file = dir.join(safe_aside_name(&primary.path));
    let aside_reason = dir.join(REASON_FILE);
    let expected = (primary.size, primary.sha256.clone());
    if durable::exists(&aside_file)? {
        if durable::hash_file(&aside_file)? != expected {
            return Err(Blocked::TargetConflict { key, path: aside_file });
        }
    } else {
        durable::publish_file_with(&aside_file, damaged, secret)?;
    }
    if !durable::exists(&aside_reason)? {
        let reason = QuarantineReason {
            format: REASON_FORMAT,
            key,
            code: QuarantineCode::CarriedSetAside,
            expected: true,
            detail: format!("{} failed validation; restored {} and set this file aside", primary.path, bak.path),
            sources: vec![QuarantinedSource { root: primary.root, path: primary.path.clone(), sha256: primary.sha256.clone() }],
        };
        durable::publish_file(&aside_reason, &serde_json::to_vec(&reason).expect("reason encodes"))?;
    }
    Ok(())
}

#[derive(Default)]
pub struct StoresDriver;

fn digest(hex: &str) -> Result<Digest> {
    Ok(json::hex_digest(hex))
}

fn handles(kind: ItemKind) -> bool {
    matches!(kind, K::AttachmentBlobs | K::LedgerBackups | K::Retired | K::LedgerLegacyInputs) || STORES.iter().any(|s| s.kind == kind)
}

/// A preserved store as it stands. It is its own target, verified in its wave; the core that serves while the sessions
/// convert may have written or removed it since, so its links are read from the file there is, not from the planned bytes.
fn standing(cx: &ItemContext<'_>, source: &mixdog_store::schema::migration::SourceFile) -> Result<Option<Vec<u8>>> {
    durable::read_optional(&cx.source_path(source)?)
}

/// Session ids named by a preserved keyed store (SM §11.6 `links`).
fn linked_sessions(item: &ManifestItem, cx: &ItemContext<'_>) -> Result<Vec<String>> {
    match item.kind {
        K::Goals => {
            let sources: Vec<SourceFile> = item
                .sources
                .iter()
                .filter(|s| s.path.strip_suffix(".bak").is_none_or(|primary| !cx.has_item(&store_file_key(K::Goals, primary))))
                .cloned()
                .collect();
            Ok(goal_session_ids(&sources))
        }
        K::ConnectorAccounts => conversation_session_ids(&item.sources, cx),
        K::Worktrees => worktree_owner_ids(&item.sources, cx),
        _ => Ok(Vec::new()),
    }
}

/// Every session a goal, a connector conversation or a worktree names, as those stores stand. A store that did not verify
/// is set aside, out of the core's reach, and names none.
pub(crate) fn linked_session_ids(cx: &ItemContext<'_>) -> Result<std::collections::BTreeSet<String>> {
    let mut ids = std::collections::BTreeSet::new();
    for item in cx.manifest.items.iter().filter(|item| cx.state(item.key.as_str()) == Some(ItemState::Verified)) {
        ids.extend(linked_sessions(item, cx)?);
    }
    Ok(ids)
}

fn goal_session_ids(sources: &[SourceFile]) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for s in sources {
        let rest = s.path.strip_prefix("goals/").unwrap_or(&s.path);
        let id = match rest.strip_prefix("history/") {
            Some(h) => h.split('/').next().unwrap_or(""),
            None => rest.split('.').next().unwrap_or(""),
        };
        if !id.is_empty() && !ids.iter().any(|x| x == id) {
            ids.push(id.to_string());
        }
    }
    ids
}

fn conversation_session_ids(sources: &[SourceFile], cx: &ItemContext<'_>) -> Result<Vec<String>> {
    let mut ids = Vec::new();
    for s in sources {
        if s.path == "connector-accounts-by-conversation.json"
            && let Some(bytes) = standing(cx, s)?
        {
            let value = mixdog_statefile::parse_json_text(&bytes).map_err(|e| Blocked::journal(e.to_string()))?;
            if let Some(map) = value.as_object() {
                ids.extend(map.keys().cloned());
            }
        }
    }
    Ok(ids)
}

fn collect_owner_ids(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Object(m) => {
            for (k, v) in m {
                match (k.as_str(), v) {
                    ("ownerSessionId", Value::String(s)) => out.push(s.clone()),
                    _ => collect_owner_ids(v, out),
                }
            }
        }
        Value::Array(a) => a.iter().for_each(|v| collect_owner_ids(v, out)),
        _ => {}
    }
}

fn worktree_owner_ids(sources: &[SourceFile], cx: &ItemContext<'_>) -> Result<Vec<String>> {
    let mut ids = Vec::new();
    for s in sources {
        if s.path.ends_with(".json")
            && let Some(bytes) = standing(cx, s)?
        {
            let value = mixdog_statefile::parse_json_text(&bytes).map_err(|e| Blocked::journal(e.to_string()))?;
            collect_owner_ids(&value, &mut ids);
        }
    }
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn legacy_compaction_keys_fold_into_their_meaning() {
        let folded = fold_legacy_compaction(&obj(serde_json::json!({
            "enabled": false, "semanticModel": "m", "recallMemoryTimeoutMs": 5,
            "type": "semantic", "onModelChange": true
        })))
        .unwrap()
        .unwrap();
        assert_eq!(Value::Object(folded), serde_json::json!({"auto": false, "summaryModel": "m", "memoryTimeoutMs": 5, "onModelChange": true}));
        assert_eq!(fold_legacy_compaction(&obj(serde_json::json!({"prune": true}))), Some(None));
        assert_eq!(fold_legacy_compaction(&obj(serde_json::json!({"auto": false}))), None);
        let kept = fold_legacy_compaction(&obj(serde_json::json!({"summaryModel": "a", "semanticModel": "b"}))).unwrap().unwrap();
        assert_eq!(Value::Object(kept), serde_json::json!({"summaryModel": "a"}));
    }

    fn source(path: &str) -> SourceFile {
        SourceFile { root: Root::Data, path: path.into(), size: 0, sha256: String::new(), secret: false }
    }

    #[test]
    fn a_goal_file_names_its_session_once_whether_current_or_history() {
        let sources = [source("goals/sess_a.json"), source("goals/sess_a.json.bak"), source("goals/history/sess_b/1.json"), source("goals/history/")];
        assert_eq!(goal_session_ids(&sources), ["sess_a", "sess_b"]);
    }

    #[test]
    fn a_worktree_registry_names_every_owner_session_at_any_depth() {
        let mut ids = Vec::new();
        collect_owner_ids(&serde_json::json!({"a": {"ownerSessionId": "s1", "list": [{"ownerSessionId": "s2"}, {"ownerSessionId": 3}]}}), &mut ids);
        assert_eq!(ids, ["s1", "s2"]);
    }

    #[test]
    fn the_verify_reads_stores_as_node_json_parse_does() {
        let deep = format!("{}{}", "[".repeat(300), "]".repeat(300));
        let mut bytes = b"{\"a\":\"\xff\",\"n\":1e400,\"deep\":".to_vec();
        bytes.extend_from_slice(deep.as_bytes());
        bytes.push(b'}');
        let path = Path::new("mixdog-config.json");
        assert_eq!(validate_store_bytes(K::Settings, path, CONFIG_FILE, &bytes), Ok(()));
        assert_eq!(validate_store_bytes(K::ProjectsRegistry, Path::new("projects.json"), "projects.json", &bytes), Ok(()));
        assert_eq!(validate_store_bytes(K::ConnectorAccounts, Path::new("connector-accounts-in-use.json"), "connector-accounts-in-use.json", &bytes), Ok(()));
        assert!(validate_store_bytes(K::Settings, path, CONFIG_FILE, b"{\"a\":").is_err());
        assert!(validate_store_bytes(K::Plugins, Path::new("plugins/registry.json"), "plugins/registry.json", b"{}").is_err());
        assert_eq!(validate_store_bytes(K::Plugins, Path::new("plugins/registry.json"), "plugins/registry.json", br#"{"plugins":[]}"#), Ok(()));
        assert!(validate_store_bytes(K::Agents, Path::new("agents/a/agent.json"), "agents/a/agent.json", br#"{"connectors":"bad"}"#).is_err());
        assert_eq!(validate_store_bytes(K::Agents, Path::new("agents/a/agent.json"), "agents/a/agent.json", br#"{"connectors":{"off":["gmail"]}}"#), Ok(()));
        assert!(validate_store_bytes(K::ProjectConnectors, Path::new("project-connectors.json"), "project-connectors.json", br#"{"projects":[]}"#).is_err());
        assert_eq!(validate_store_bytes(K::ProjectConnectors, Path::new("project-connectors.json"), "project-connectors.json", br#"{"projects":{}}"#), Ok(()));
        assert!(validate_store_bytes(K::Goals, Path::new("goals/s.json"), "goals/s.json", br#"{"sessionId":"s"}"#).is_err());
        assert!(validate_store_bytes(K::Goals, Path::new("goals/s.json"), "goals/s.json", br#"{"version":1,"goal":42}"#).is_err());
        assert_eq!(validate_store_bytes(K::Goals, Path::new("goals/s.json"), "goals/s.json", br#"{"version":1,"goal":null}"#), Ok(()));
        assert_eq!(validate_store_bytes(K::Goals, Path::new("goals/s.json"), "goals/s.json", br#"{"version":1,"goal":{}}"#), Ok(()));
        assert_eq!(validate_store_bytes(K::Goals, Path::new("goals/s.json"), "goals/s.json", br#"{"version":2,"goal":42}"#), Ok(()));
        assert!(
            validate_store_bytes(K::Worktrees, Path::new("worktrees-v1/registry.json"), "worktrees-v1/registry.json", br#"{"version":1,"worktrees":[]}"#)
                .is_err()
        );
        assert!(
            validate_store_bytes(K::Worktrees, Path::new("worktrees-v1/registry.json"), "worktrees-v1/registry.json", br#"{"version":1,"entries":[]}"#)
                .is_err()
        );
        assert_eq!(
            validate_store_bytes(K::Worktrees, Path::new("worktrees-v1/registry.json"), "worktrees-v1/registry.json", br#"{"version":1,"entries":{}}"#),
            Ok(())
        );
    }
}

/// SHA-256 over a preserve item's sources (`root path sha256` lines): its staged output
/// and verified digest.
fn sources_sha256(sources: &[SourceFile]) -> String {
    let mut text = String::new();
    for s in sources {
        text.push_str(&format!("{} {} {}\n", plan::root_name(s.root), s.path, s.sha256));
    }
    durable::sha256_hex(text.as_bytes())
}
impl StoresDriver {
    fn plan_store(&self, roots: &MigrationRoots, sink: &mut PlanSink, store: &Store) -> Result<()> {
        let Some(base) = roots.root(store.root) else {
            return Ok(());
        };
        match &store.spec {
            Spec::Files(names) => {
                // Check each primary file so a damaged file can restore its good `.bak` (and report
                // the set-aside), keep a fail-closed policy in place, or quarantine alone without
                // moving its `.bak` or a healthy sibling.
                let mut entries = Vec::new();
                let mut any_damaged = false;
                for name in *names {
                    let bak_rel = format!("{name}.bak");
                    let path = roots.resolve(store.root, name)?;
                    let bak_path = roots.resolve(store.root, &bak_rel)?;
                    let has_primary = durable::is_file(&path);
                    let has_bak = durable::is_file(&bak_path);
                    if !has_primary && !has_bak {
                        continue;
                    }
                    let policy = file_policy(store.kind, name);
                    let secret = policy.is_some_and(|p| p.secret);
                    let primary_damaged = if has_primary && !store.singleton && policy.is_some() {
                        validate_store_bytes(store.kind, &path, name, &durable::read(&path)?).is_err()
                    } else {
                        false
                    };
                    let restore = primary_damaged
                        && has_bak
                        && policy.is_some_and(|p| p.restore_bak)
                        && validate_store_bytes(store.kind, &bak_path, name, &durable::read(&bak_path)?).is_ok();
                    any_damaged |= primary_damaged;
                    entries.push((name, bak_rel, has_primary, has_bak, policy, secret, primary_damaged, restore));
                }
                if entries.is_empty() {
                    return Ok(());
                }
                if !any_damaged {
                    let mut sources = Vec::new();
                    for (name, bak_rel, has_primary, has_bak, _, secret, _, _) in entries {
                        if has_primary {
                            sources.push(sink.source(store.root, name, secret)?);
                        }
                        if has_bak {
                            sources.push(sink.source(store.root, &bak_rel, secret)?);
                        }
                    }
                    return sink.add_item(plan::item(&store_key(store.kind), KindGroup::Data, store.kind, Contract::Preserve, sources, None)?);
                }
                let single_entry = entries.len() == 1;
                for (name, bak_rel, has_primary, has_bak, policy, secret, primary_damaged, restore) in entries {
                    let key = if single_entry { store_key(store.kind) } else { store_file_key(store.kind, name) };
                    if restore {
                        let primary = sink.source(store.root, name, secret)?;
                        let bak = sink.source(store.root, &bak_rel, secret)?;
                        sink.add_item(plan::item(
                            &key,
                            KindGroup::Data,
                            store.kind,
                            Contract::Convert,
                            vec![primary.clone(), bak],
                            Some(Target::File { root: store.root, path: (*name).to_owned() }),
                        )?)?;
                        sink.add_item(plan::item(&plan::retain_key(store.root, name), KindGroup::Data, store.kind, Contract::Preserve, vec![primary], None)?)?;
                    } else if primary_damaged {
                        let primary = sink.source(store.root, name, secret)?;
                        let contract = if policy.is_some_and(|p| p.keep_without_backup) { Contract::Retain } else { Contract::Preserve };
                        sink.add_item(plan::item(&key, KindGroup::Data, store.kind, contract, vec![primary], None)?)?;
                        if has_bak {
                            let bak = sink.source(store.root, &bak_rel, secret)?;
                            sink.add_item(plan::item(
                                &store_file_key(store.kind, &bak_rel),
                                KindGroup::Data,
                                store.kind,
                                Contract::Preserve,
                                vec![bak],
                                None,
                            )?)?;
                        }
                    } else {
                        let mut sources = Vec::new();
                        if has_primary {
                            sources.push(sink.source(store.root, name, secret)?);
                        }
                        if has_bak {
                            sources.push(sink.source(store.root, &bak_rel, secret)?);
                        }
                        sink.add_item(plan::item(&key, KindGroup::Data, store.kind, Contract::Preserve, sources, None)?)?;
                    }
                }
                Ok(())
            }
            Spec::Dirs(dirs) => {
                let mut kept = Vec::new();
                for dir in *dirs {
                    let paths: Vec<String> = durable::walk_files(&base.join(dir))?.into_iter().map(|rel| format!("{dir}/{rel}")).collect();
                    sink.hash_ahead(store.root, &paths)?;
                    for path in paths {
                        // An interrupted write was never renamed, so it was never state (SM §11.2): it is retired,
                        // not carried with the store it lies in.
                        if store.root == D && temp_files::is_store_leftover(&path) {
                            let source = sink.source(D, &path, false)?;
                            sink.add_item(plan::item(&plan::retire_key(D, &path), KindGroup::Data, K::Retired, Contract::Retire, vec![source], None)?)?;
                        } else {
                            kept.push(path);
                        }
                    }
                }
                let present: BTreeSet<String> = kept.iter().cloned().collect();
                let mut claimed = BTreeSet::new();
                for path in &kept {
                    let Some(policy) = file_policy(store.kind, path) else {
                        continue;
                    };
                    claimed.insert(path.clone());
                    let full = roots.resolve(store.root, path)?;
                    let damaged = validate_store_bytes(store.kind, &full, path, &durable::read(&full)?).is_err();
                    let bak_rel = format!("{path}.bak");
                    let restore = damaged && policy.restore_bak && present.contains(&bak_rel) && {
                        let bak_full = roots.resolve(store.root, &bak_rel)?;
                        validate_store_bytes(store.kind, &bak_full, path, &durable::read(&bak_full)?).is_ok()
                    };
                    if restore {
                        claimed.insert(bak_rel.clone());
                        let primary = sink.source(store.root, path, policy.secret)?;
                        let bak = sink.source(store.root, &bak_rel, policy.secret)?;
                        sink.add_item(plan::item(
                            &store_file_key(store.kind, path),
                            KindGroup::Data,
                            store.kind,
                            Contract::Convert,
                            vec![primary.clone(), bak],
                            Some(Target::File { root: store.root, path: path.clone() }),
                        )?)?;
                        sink.add_item(plan::item(&plan::retain_key(store.root, path), KindGroup::Data, store.kind, Contract::Preserve, vec![primary], None)?)?;
                    } else if damaged && policy.keep_without_backup {
                        let source = sink.source(store.root, path, policy.secret)?;
                        sink.add_item(plan::item(&store_file_key(store.kind, path), KindGroup::Data, store.kind, Contract::Retain, vec![source], None)?)?;
                    } else {
                        let source = sink.source(store.root, path, policy.secret)?;
                        sink.add_item(plan::item(&store_file_key(store.kind, path), KindGroup::Data, store.kind, Contract::Preserve, vec![source], None)?)?;
                    }
                }
                let other_sources: Vec<SourceFile> =
                    kept.iter().filter(|path| !claimed.contains(*path)).map(|path| sink.source(store.root, path, false)).collect::<Result<_>>()?;
                if !other_sources.is_empty() {
                    sink.add_item(plan::item(&store_key(store.kind), KindGroup::Data, store.kind, Contract::Preserve, other_sources, None)?)?;
                }
                Ok(())
            }
        }
    }

    fn plan_ledger_backups(&self, roots: &MigrationRoots, sink: &mut PlanSink) -> Result<()> {
        let usage = roots.data.join("usage");
        let mut rels = Vec::new();
        for (name, is_dir) in durable::list_dir(&usage)? {
            let backup = name.starts_with("ledger.backup-")
                || name.contains(".v1-backup-")
                || name.starts_with("pricing-backup-")
                || name == "audits"
                || name.starts_with("antigravity-audit-");
            if !backup {
                continue;
            }
            if is_dir {
                rels.extend(durable::walk_files(&usage.join(&name))?.into_iter().map(|rel| format!("usage/{name}/{rel}")));
            } else {
                rels.push(format!("usage/{name}"));
            }
        }
        // A few whole databases: hashed side by side.
        sink.hash_ahead(D, &rels)?;
        let sources = rels.iter().map(|rel| sink.source(D, rel, false)).collect::<Result<Vec<_>>>()?;
        if sources.is_empty() {
            return Ok(());
        }
        sink.add_item(plan::item(&store_key(K::LedgerBackups), KindGroup::Data, K::LedgerBackups, Contract::Preserve, sources, None)?)
    }

    fn plan_retired(&self, roots: &MigrationRoots, sink: &mut PlanSink) -> Result<()> {
        let retire = |sink: &mut PlanSink, rel: String, sources: Vec<SourceFile>| -> Result<()> {
            sink.add_item(plan::item(&plan::retire_key(D, &rel), KindGroup::Data, K::Retired, Contract::Retire, sources, None)?)
        };
        let foreign_catalog = keeps_catalog(&roots.data);
        for rel in RETIRED_FILES {
            if foreign_catalog && rel.starts_with(session_catalog_name()) {
                continue;
            }
            if durable::is_file(&roots.data.join(rel)) {
                let source = sink.source(D, rel, false)?;
                retire(sink, rel.to_string(), vec![source])?;
            }
        }
        for (name, is_dir) in durable::list_dir(&roots.data)? {
            if !is_dir && !RETIRED_FILES.contains(&name.as_str()) && is_retired_pattern(&name) {
                let source = sink.source(D, &name, false)?;
                retire(sink, name, vec![source])?;
            }
        }
        for dir in RETIRED_DIRS {
            let files = durable::walk_files(&roots.data.join(dir))?;
            if files.is_empty() {
                continue;
            }
            let sources = files.iter().map(|rel| sink.source(D, &format!("{dir}/{rel}"), false)).collect::<Result<Vec<_>>>()?;
            retire(sink, dir.to_string(), sources)?;
        }
        Ok(())
    }

    /// Legacy usage inputs: already imported (`metadata.importedThrough`) → retire; else retained
    /// untouched (`ledger_import_incomplete`) for the core's usage history import, which reads them
    /// when statistics are read (`mixdog-ledger` `history`) and marks the ledger imported; the next
    /// run then retires them.
    fn plan_ledger_inputs(&self, roots: &MigrationRoots, sink: &mut PlanSink) -> Result<()> {
        let imported = crate::ledger::imported_through(&roots.data)?;
        for rel in LEDGER_LEGACY_INPUTS {
            if !durable::is_file(&roots.data.join(rel)) {
                continue;
            }
            let source = sink.source(D, rel, false)?;
            let (key, contract) = if imported { (plan::retire_key(D, rel), Contract::Retire) } else { (plan::retain_key(D, rel), Contract::Retain) };
            sink.add_item(plan::item(&key, KindGroup::Data, K::LedgerLegacyInputs, contract, vec![source], None)?)?;
        }
        Ok(())
    }

    fn plan_legacy_compaction(&self, roots: &MigrationRoots, sink: &mut PlanSink) -> Result<()> {
        let Some((_, doc)) = read_config(&roots.data)? else {
            return Ok(());
        };
        if folded_config(&doc).is_none() {
            return Ok(());
        }
        sink.add_item(plan::item(
            LEGACY_COMPACTION_ITEM,
            KindGroup::Data,
            K::Settings,
            Contract::Convert,
            Vec::new(),
            Some(Target::ConfigKey { key: LEGACY_COMPACTION_TARGET.into() }),
        )?)
    }

    fn stage_legacy_compaction(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<Staged> {
        let (_, doc) =
            read_config(&cx.roots.data)?.ok_or_else(|| Blocked::StoreSchema { key: item.key.as_str().into(), detail: format!("{CONFIG_FILE} is gone") })?;
        // Already folded (an earlier run published it): the current file is the output.
        let bytes = match folded_config(&doc) {
            Some(next) => config_bytes(&next),
            None => durable::read(&cx.roots.data.join(CONFIG_FILE))?,
        };
        durable::write_synced(&cx.stage_dir(item.key.as_str()).join(CONFIG_FILE), &bytes)?;
        Ok(Staged::Output { output_sha256: durable::sha256_hex(&bytes), replaced_surrogates: 0 })
    }

    fn publish_legacy_compaction(&self, cx: &ItemContext<'_>, item: &ManifestItem, staged: &StagedEntry) -> Result<()> {
        let target = cx.roots.data.join(CONFIG_FILE);
        let current = durable::read(&target)?;
        if durable::sha256_hex(&current) == staged.output_sha256.as_str() {
            return Ok(());
        }
        let stage = cx.stage_dir(item.key.as_str()).join(CONFIG_FILE);
        if !durable::exists(&stage)? {
            return Err(Blocked::TargetConflict { key: item.key.as_str().into(), path: target });
        }
        durable::durable_rename(&stage, &target)
    }

    fn verify_legacy_compaction(&self, cx: &ItemContext<'_>) -> Result<Verdict> {
        let (bytes, doc) = read_config(&cx.roots.data)?
            .ok_or_else(|| Blocked::StoreSchema { key: LEGACY_COMPACTION_ITEM.into(), detail: format!("{CONFIG_FILE} is gone") })?;
        if folded_config(&doc).is_some() {
            return Ok(Verdict::Quarantine { code: QuarantineCode::DigestMismatch, detail: "agent.compaction still holds legacy keys".into() });
        }
        Ok(Verdict::Verified { digest: Some(digest(&durable::sha256_hex(&bytes))?) })
    }

    fn restore_pair(item: &ManifestItem) -> Result<(&SourceFile, &SourceFile)> {
        let Some(Target::File { root, path }) = &item.target else {
            return Err(Blocked::journal(format!("{}: restore item without file target", item.key.as_str())));
        };
        let bak_rel = format!("{path}.bak");
        let primary = item
            .sources
            .iter()
            .find(|s| s.root == *root && s.path == *path)
            .ok_or_else(|| Blocked::journal(format!("{}: missing primary source {path}", item.key.as_str())))?;
        let bak = item
            .sources
            .iter()
            .find(|s| s.root == *root && s.path == bak_rel)
            .ok_or_else(|| Blocked::journal(format!("{}: missing backup source {bak_rel}", item.key.as_str())))?;
        Ok((primary, bak))
    }

    fn stage_restore(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<Staged> {
        let (primary, bak) = Self::restore_pair(item)?;
        let bak_path = cx.source_path(bak)?;
        let bak_bytes = cx.read_source(bak)?;
        if let Err((code, detail)) = validate_store_bytes(item.kind, &bak_path, &primary.path, &bak_bytes) {
            return Ok(Staged::Quarantine { code, detail });
        }
        durable::write_synced(&cx.stage_dir(item.key.as_str()).join("restored"), &bak_bytes)?;
        Ok(Staged::Output { output_sha256: bak.sha256.clone(), replaced_surrogates: 0 })
    }

    fn publish_restore(&self, cx: &ItemContext<'_>, item: &ManifestItem, staged: &StagedEntry) -> Result<()> {
        let (primary, bak) = Self::restore_pair(item)?;
        let target_path = cx.source_path(primary)?;
        let aside_file = set_aside_file(&cx.roots.data, primary);
        let target_restored = durable::exists(&target_path)? && durable::hash_file(&target_path)? == (bak.size, bak.sha256.clone());
        let aside_done = durable::exists(&aside_file)? && durable::hash_file(&aside_file)? == (primary.size, primary.sha256.clone());
        if target_restored && aside_done {
            return Ok(());
        }
        // Never overwrite a target that changed since planning (for example a return to 1.4.5
        // that repaired the file and saved newer edits).
        if !target_restored && (!durable::exists(&target_path)? || durable::hash_file(&target_path)? != (primary.size, primary.sha256.clone())) {
            return Err(Blocked::SourceChanged { path: target_path });
        }
        if !aside_done {
            if durable::exists(&aside_file)? {
                return Err(Blocked::TargetConflict { key: plan::retain_key(primary.root, &primary.path), path: aside_file });
            }
            let damaged = cx.read_source(primary)?;
            durable::publish_file_with(&aside_file, &damaged, primary.secret)?;
        }
        if !target_restored {
            let stage_path = cx.stage_dir(item.key.as_str()).join("restored");
            if !durable::exists(&stage_path)? {
                return Err(Blocked::TargetConflict { key: item.key.as_str().into(), path: target_path });
            }
            let bytes = durable::read(&stage_path)?;
            if durable::sha256_hex(&bytes) != staged.output_sha256.as_str() {
                return Err(Blocked::journal(format!("{}: staged backup changed", item.key.as_str())));
            }
            durable::publish_file_with(&target_path, &bytes, primary.secret)?;
        }
        Ok(())
    }

    fn verify_restore(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<Verdict> {
        let (primary, bak) = Self::restore_pair(item)?;
        let target_path = cx.source_path(primary)?;
        let bytes = durable::read(&target_path)?;
        if bytes.len() as u64 != bak.size || durable::sha256_hex(&bytes) != bak.sha256 {
            return Ok(Verdict::Quarantine { code: QuarantineCode::DigestMismatch, detail: format!("{} does not hold {}", primary.path, bak.path) });
        }
        if let Err((code, detail)) = validate_store_bytes(item.kind, &target_path, &primary.path, &bytes) {
            return Ok(Verdict::Quarantine { code, detail });
        }
        if primary.secret && !durable::is_owner_only_if_supported(&target_path)? {
            return Ok(Verdict::Quarantine { code: QuarantineCode::DigestMismatch, detail: format!("{} is not owner-only", primary.path) });
        }
        let aside_file = set_aside_file(&cx.roots.data, primary);
        if !durable::exists(&aside_file)? || durable::hash_file(&aside_file)? != (primary.size, primary.sha256.clone()) {
            return Ok(Verdict::Quarantine { code: QuarantineCode::DigestMismatch, detail: format!("damaged {} was not set aside", primary.path) });
        }
        Ok(Verdict::Verified { digest: Some(digest(&bak.sha256)?) })
    }

    fn verify_store(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<Verdict> {
        let singleton = STORES.iter().any(|s| s.kind == item.kind && s.singleton);
        let mut first_failure: Option<(QuarantineCode, String)> = None;
        for source in &item.sources {
            let path = cx.source_path(source)?;
            let policy = file_policy(item.kind, &source.path);
            let bak = (!singleton && policy.is_some_and(|p| p.restore_bak))
                .then(|| {
                    let bak_rel = format!("{}.bak", source.path);
                    item.sources.iter().find(|s| s.root == source.root && s.path == bak_rel)
                })
                .flatten();
            let bytes = match cx.read_source(source) {
                Ok(bytes) => bytes,
                Err(Blocked::SourceChanged { .. }) if bak.is_some() => {
                    // Resumed older manifest after an interrupted in-place `.bak` restore: self-identify.
                    let bak = bak.expect("checked");
                    let aside_file = set_aside_file(&cx.roots.data, source);
                    let aside_reason = aside_file.with_file_name(REASON_FILE);
                    if durable::exists(&path)?
                        && durable::hash_file(&path)? == (bak.size, bak.sha256.clone())
                        && durable::exists(&aside_file)?
                        && durable::hash_file(&aside_file)? == (source.size, source.sha256.clone())
                        && durable::exists(&aside_reason)?
                    {
                        if policy.is_some_and(|p| p.secret) && !durable::is_owner_only_if_supported(&path)? {
                            first_failure.get_or_insert((QuarantineCode::DigestMismatch, format!("{} is not owner-only", source.path)));
                        }
                        continue;
                    }
                    return Err(Blocked::SourceChanged { path });
                }
                Err(error) => return Err(error),
            };
            let Some(policy) = policy else {
                continue;
            };
            if let Err((code, detail)) = validate_store_bytes(item.kind, &path, &source.path, &bytes) {
                if singleton {
                    return Err(Blocked::StoreSchema { key: item.key.as_str().into(), detail });
                }
                if let Some(bak) = bak {
                    let bak_path = cx.source_path(bak)?;
                    let bak_bytes = cx.read_source(bak)?;
                    if validate_store_bytes(item.kind, &bak_path, &source.path, &bak_bytes).is_ok() {
                        write_resumed_set_aside(cx, source, bak, &bytes, policy.secret)?;
                        durable::publish_file_with(&path, &bak_bytes, policy.secret)?;
                        if policy.secret && !durable::is_owner_only_if_supported(&path)? {
                            first_failure.get_or_insert((QuarantineCode::DigestMismatch, format!("{} is not owner-only", source.path)));
                        }
                        continue;
                    }
                }
                let detail = if policy.keep_without_backup { format!("{} is damaged and was left in place ({detail})", path.display()) } else { detail };
                first_failure.get_or_insert((code, detail));
            }
        }
        if let Some((code, detail)) = first_failure {
            return Ok(Verdict::Quarantine { code, detail });
        }
        Ok(Verdict::Verified { digest: Some(digest(&sources_sha256(&item.sources))?) })
    }
}
impl ItemDriver for StoresDriver {
    fn plan(&self, roots: &MigrationRoots, sink: &mut PlanSink) -> Result<()> {
        for store in STORES {
            self.plan_store(roots, sink, store)?;
        }
        self.plan_ledger_backups(roots, sink)?;
        self.plan_retired(roots, sink)?;
        self.plan_ledger_inputs(roots, sink)?;
        self.plan_legacy_compaction(roots, sink)?;
        connectors::plan(roots, sink)
    }

    fn owns(&self, item: &ManifestItem) -> bool {
        if item.group != KindGroup::Data {
            return false;
        }
        if item.kind == K::Retired {
            let rel = item.key.as_str().split_once("/data/").map_or("", |(_, r)| r);
            return RETIRED_FILES.contains(&rel)
                || KEPT_RECORDS.contains(&rel)
                || RETIRED_DIRS.contains(&rel)
                || (!rel.contains('/') && is_retired_pattern(rel))
                || temp_files::is_store_leftover(rel)
                || rel.starts_with(LEGACY_ATTACHMENTS);
        }
        handles(item.kind)
    }

    fn wave(&self, item: &ManifestItem) -> Wave {
        if [LEGACY_COMPACTION_ITEM, connectors::ITEM].contains(&item.key.as_str()) { Wave::Settings } else { Wave::Stores }
    }

    fn stage(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<Staged> {
        if item.key.as_str() == LEGACY_COMPACTION_ITEM {
            return self.stage_legacy_compaction(cx, item);
        }
        if item.key.as_str() == connectors::ITEM {
            return connectors::stage(cx, item);
        }
        if is_restore_item(item) {
            return self.stage_restore(cx, item);
        }
        if is_set_aside_item(item) {
            let rel = item.sources.first().map_or(item.key.as_str(), |s| s.path.as_str());
            return Ok(Staged::Quarantine {
                code: QuarantineCode::CarriedSetAside,
                detail: format!("{rel} failed validation; restored {rel}.bak and set this file aside"),
            });
        }
        match item.contract {
            Contract::Retain if item.kind == K::LedgerLegacyInputs => Ok(Staged::Quarantine {
                code: QuarantineCode::LedgerImportIncomplete,
                detail: "the ledger has no metadata.importedThrough: kept for the usage history import".into(),
            }),
            Contract::Retain => {
                for source in &item.sources {
                    let path = cx.source_path(source)?;
                    let bytes = cx.read_source(source)?;
                    if let Err((code, detail)) = validate_store_bytes(item.kind, &path, &source.path, &bytes) {
                        return Ok(Staged::Quarantine { code, detail: format!("{} is damaged and was left in place ({detail})", path.display()) });
                    }
                }
                let name = item.sources.first().map_or(item.key.as_str(), |s| s.path.as_str());
                Ok(Staged::Quarantine { code: QuarantineCode::ParseError, detail: format!("{name} is damaged and was left in place") })
            }
            _ => Ok(Staged::Output { output_sha256: sources_sha256(&item.sources), replaced_surrogates: 0 }),
        }
    }

    fn publish(&self, cx: &ItemContext<'_>, item: &ManifestItem, staged: &StagedEntry) -> Result<()> {
        if item.key.as_str() == LEGACY_COMPACTION_ITEM {
            return self.publish_legacy_compaction(cx, item, staged);
        }
        if item.key.as_str() == connectors::ITEM {
            return connectors::publish(cx, item, staged);
        }
        if is_restore_item(item) {
            return self.publish_restore(cx, item, staged);
        }
        Ok(())
    }

    fn verify(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<Verdict> {
        if item.key.as_str() == LEGACY_COMPACTION_ITEM {
            return self.verify_legacy_compaction(cx);
        }
        if item.key.as_str() == connectors::ITEM {
            return connectors::verify(cx, item);
        }
        if is_restore_item(item) {
            return self.verify_restore(cx, item);
        }
        if in_legacy_attachments(item) {
            let digest = (item.contract == Contract::Preserve).then(|| digest(&sources_sha256(&item.sources))).transpose()?;
            return Ok(Verdict::Verified { digest });
        }
        match item.contract {
            Contract::Retire => Ok(Verdict::Verified { digest: None }),
            _ => self.verify_store(cx, item),
        }
    }

    fn dangling(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<u64> {
        let migrated: std::collections::BTreeSet<&str> = cx.verified_sessions().collect();
        let mut dangling = 0;
        for id in linked_sessions(item, cx)? {
            // A session the serving core created since is named by the store as it stands, and is there.
            let created = crate::session::source::is_session_id(&id) && durable::exists(&cx.roots.data.join(crate::session::SESSIONS_DIR).join(&id))?;
            dangling += u64::from(!migrated.contains(id.as_str()) && !created);
        }
        Ok(dangling)
    }

    fn keeps_sources(&self, item: &ManifestItem) -> bool {
        item.contract == Contract::Preserve
            || is_restore_item(item)
            || item.key.as_str() == LEGACY_COMPACTION_ITEM
            || in_legacy_attachments(item)
            // Retained in place: ledger legacy inputs and fail-closed damaged stores (`keepWithoutBackup`).
            || item.contract == Contract::Retain
            || (item.kind == K::Retired && KEPT_RECORDS.iter().any(|rel| item.key.as_str() == plan::retire_key(D, rel)))
    }

    fn keeps_quarantined_source(&self, cx: &ItemContext<'_>, item: &ManifestItem, source: &SourceFile) -> bool {
        if is_set_aside_item(item) {
            return false;
        }
        if item.contract == Contract::Retain && self.keeps_sources(item) {
            return true;
        }
        let Some(policy) = file_policy(item.kind, &source.path) else {
            return true;
        };
        if policy.keep_without_backup {
            return true;
        }
        // On a resumed multi-file manifest from an older build, keep healthy (or already-restored) siblings in place.
        if item.sources.len() > 1
            && let Ok(path) = cx.source_path(source)
            && let Ok(Some(bytes)) = durable::read_optional(&path)
            && validate_store_bytes(item.kind, &path, &source.path, &bytes).is_ok()
        {
            return true;
        }
        false
    }
}
