//! Single-file and directory stores of SM §11.2 outside the sessions: preserved stores
//! (bytes unchanged, verified by SHA-256 and parse), retired caches and leftovers, the
//! legacy usage inputs, and the config rewrites the runtime no longer carries
//! (`agent.compaction` legacy keys; the connector transition, `crate::connectors`).

use std::path::Path;

use mixdog_store::schema::bounded::Digest;
use mixdog_store::schema::migration::Contract;
use mixdog_store::schema::migration::ItemKind;
use mixdog_store::schema::migration::KindGroup;
use mixdog_store::schema::migration::ManifestItem;
use mixdog_store::schema::migration::QuarantineCode;
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
    Store {
        kind,
        root,
        spec,
        singleton,
    }
}

use ItemKind as K;
use Root::Data as D;

const STORES: &[Store] = &[
    store(K::Goals, D, Spec::Dirs(&["goals"]), false),
    store(K::QuotaResume, D, Spec::Files(&["quota-resume.json"]), false),
    store(K::HumanGate, D, Spec::Dirs(&["human-gate"]), false),
    store(
        K::ConnectorAccounts,
        D,
        Spec::Files(&[
            "connector-accounts-by-conversation.json",
            "connector-accounts-in-use.json",
        ]),
        false,
    ),
    store(K::GatewaySessionRoutes, D, Spec::Files(&["gateway-session-routes.json"]), false),
    store(K::PromptCacheTouches, D, Spec::Files(&["prompt-cache-touches.json"]), false),
    store(K::PromptCacheIdleGaps, D, Spec::Files(&["prompt-cache-idle-gaps.json"]), false),
    store(K::Heartbeat, D, Spec::Files(&["heartbeat.json"]), false),
    store(K::RoutineResults, D, Spec::Files(&["routine-results.json"]), false),
    store(K::Settings, D, Spec::Files(&["mixdog-config.json"]), true),
    store(K::CoreMemory, D, Spec::Files(&["core-memory.json"]), false),
    store(K::ProjectsRegistry, Root::Home, Spec::Files(&["projects.json"]), true),
    store(K::Agents, D, Spec::Dirs(&["agents"]), false),
    store(K::Bots, D, Spec::Dirs(&["bots"]), false),
    store(K::Workflows, D, Spec::Dirs(&["workflows"]), false),
    store(K::Schedules, D, Spec::Dirs(&["schedules"]), false),
    store(K::Hooks, D, Spec::Dirs(&["hooks"]), false),
    store(K::Skills, D, Spec::Dirs(&["skills"]), false),
    store(K::Plugins, D, Spec::Files(&["plugins/registry.json"]), true),
    store(K::McpConfig, D, Spec::Files(&[".mcp.json"]), true),
    store(K::ProjectConnectors, D, Spec::Files(&["project-connectors.json"]), true),
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
    "agent-kind-migration.json",
    "pending-dispatches.json",
    "session-log-migration.json",
    "litellm-catalog.json",
    "modelsdev-catalog.json",
    "gemini-models.json",
    "client-versions.json",
    "update-check-cache.json",
    "cache.local.json",
];

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
    match std::fs::metadata(&path) {
        Ok(meta) if meta.is_file() => {}
        Ok(_) => return false,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return false,
        Err(_) => return true,
    }
    let corrupt = |e: &rusqlite::Error| {
        matches!(e.sqlite_error_code(), Some(ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt))
    };
    let Ok(conn) = rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return true;
    };
    let id: rusqlite::Result<i64> = conn.pragma_query_value(None, "application_id", |r| r.get(0));
    let objects: rusqlite::Result<i64> = conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get(0));
    match (id, objects) {
        (Ok(id), Ok(objects)) => id != CATALOG_APPLICATION_ID && !(id == 0 && objects == 0),
        (Err(e), _) | (_, Err(e)) => !corrupt(&e),
    }
}

/// Whether `item` retires a file of the catalog set that [`keeps_catalog`] keeps; asked again at disposal, since a resumed
/// run reuses the plan an earlier build journaled.
pub(crate) fn keeps_catalog_item(item: &ManifestItem, data: &std::path::Path) -> bool {
    let rel = item.key.as_str().split_once("/data/").map_or("", |(_, r)| r);
    item.kind == K::Retired
        && RETIRED_FILES.contains(&rel)
        && rel.starts_with(session_catalog_name())
        && keeps_catalog(data)
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
const RETIRED_DIRS: &[&str] = &["live-sessions", "session-writer-locks", "media/renditions"];

/// `gateway-usage.local.jsonl` is not here: at 1.4.5 it is the live store the core appends to per request and the
/// footer reads (`route-meta.mjs`), which the usage history import (`mixdog-ledger` `history`) only reads. `gateway-usage.local.json` is not
/// either: only the store's first writer retires it (renamed to `.migrated.bak`), which the Rust writer does too.
const LEDGER_LEGACY_INPUTS: &[&str] = &[
    "usage-rollup.local.json",
    "usage-rollup.local.json.migrated.bak",
    "gateway-usage.local.jsonl.migrated.bak",
    "gateway-usage.local.json.migrated.bak",
];

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
    if !json::js_truthy(next.get("memoryTimeoutMs"))
        && json::js_truthy(next.get("recallMemoryTimeoutMs"))
    {
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
    let agent = doc
        .get_mut("agent")
        .and_then(Value::as_object_mut)
        .expect("agent is an object");
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
    let value = json::parse_config(&bytes).map_err(|detail| Blocked::StoreSchema {
        key: "store/settings".into(),
        detail,
    })?;
    Ok(Some((bytes, value.value)))
}

/// Strict parse of the JSON formats among a store's files.
fn parse_check(path: &Path, rel: &str, bytes: &[u8]) -> std::result::Result<(), String> {
    let text = bytes.strip_prefix("\u{feff}".as_bytes()).unwrap_or(bytes);
    if rel == CONFIG_FILE {
        // The config is read as Node reads it (`JSON.parse(readFileSync(path, 'utf8'))`): invalid UTF-8 as U+FFFD, any nesting, 1e400 as null.
        json::parse_config(bytes).map(drop).map_err(|e| format!("{}: {e}", path.display()))
    } else if rel.ends_with(".json") {
        json::parse_source(text).map(drop).map_err(|e| format!("{}: {e}", path.display()))
    } else if rel.ends_with(".jsonl") {
        for (n, line) in text.split(|&b| b == b'\n').enumerate() {
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            if !line.is_empty() {
                json::parse_source(line).map_err(|e| format!("{}:{}: {e}", path.display(), n + 1))?;
            }
        }
        Ok(())
    } else {
        Ok(())
    }
}

pub(crate) fn store_key(kind: ItemKind) -> String {
    let name = serde_json::to_value(kind)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    format!("store/{name}")
}

#[derive(Default)]
pub struct StoresDriver;

fn digest(hex: &str) -> Result<Digest> {
    Ok(json::hex_digest(hex))
}

fn handles(kind: ItemKind) -> bool {
    matches!(
        kind,
        K::AttachmentBlobs | K::LedgerBackups | K::Retired | K::LedgerLegacyInputs
    ) || STORES.iter().any(|s| s.kind == kind)
}

/// A preserved store as it stands. It is its own target, verified in its wave; the core that serves while the sessions
/// convert may have written it since, so its links are read from the file there is, not from the planned bytes.
fn standing(cx: &ItemContext<'_>, source: &mixdog_store::schema::migration::SourceFile) -> Result<Vec<u8>> {
    durable::read(&cx.source_path(source)?)
}

/// Session ids named by a preserved keyed store (SM §11.6 `links`).
fn linked_sessions(item: &ManifestItem, cx: &ItemContext<'_>) -> Result<Vec<String>> {
    let mut ids = Vec::new();
    match item.kind {
        K::Goals => {
            for s in &item.sources {
                let rest = s.path.strip_prefix("goals/").unwrap_or(&s.path);
                let id = match rest.strip_prefix("history/") {
                    Some(h) => h.split('/').next().unwrap_or(""),
                    None => rest.split('.').next().unwrap_or(""),
                };
                if !id.is_empty() && !ids.iter().any(|x| x == id) {
                    ids.push(id.to_string());
                }
            }
        }
        K::ConnectorAccounts => {
            for s in &item.sources {
                if s.path == "connector-accounts-by-conversation.json" {
                    let value = json::parse_source(&standing(cx, s)?).map_err(Blocked::journal)?.value;
                    if let Some(map) = value.as_object() {
                        ids.extend(map.keys().cloned());
                    }
                }
            }
        }
        K::Worktrees => {
            fn owners(v: &Value, out: &mut Vec<String>) {
                match v {
                    Value::Object(m) => {
                        for (k, v) in m {
                            match (k.as_str(), v) {
                                ("ownerSessionId", Value::String(s)) => out.push(s.clone()),
                                _ => owners(v, out),
                            }
                        }
                    }
                    Value::Array(a) => a.iter().for_each(|v| owners(v, out)),
                    _ => {}
                }
            }
            for s in &item.sources {
                if s.path.ends_with(".json") {
                    let value = json::parse_source(&standing(cx, s)?).map_err(Blocked::journal)?.value;
                    owners(&value, &mut ids);
                }
            }
        }
        _ => {}
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
        assert_eq!(
            Value::Object(folded),
            serde_json::json!({"auto": false, "summaryModel": "m", "memoryTimeoutMs": 5, "onModelChange": true})
        );
        assert_eq!(
            fold_legacy_compaction(&obj(serde_json::json!({"prune": true}))),
            Some(None)
        );
        assert_eq!(fold_legacy_compaction(&obj(serde_json::json!({"auto": false}))), None);
        let kept = fold_legacy_compaction(&obj(serde_json::json!({"summaryModel": "a", "semanticModel": "b"})))
            .unwrap()
            .unwrap();
        assert_eq!(Value::Object(kept), serde_json::json!({"summaryModel": "a"}));
    }

    #[test]
    fn the_verify_reads_the_config_as_json_parse_does() {
        let deep = format!("{}{}", "[".repeat(300), "]".repeat(300));
        let mut bytes = b"{\"a\":\"\xff\",\"n\":1e400,\"deep\":".to_vec();
        bytes.extend_from_slice(deep.as_bytes());
        bytes.push(b'}');
        let path = Path::new("mixdog-config.json");
        assert_eq!(parse_check(path, CONFIG_FILE, &bytes), Ok(()));
        // Another store's JSON keeps the strict parse.
        assert!(parse_check(path, "other.json", &bytes).is_err());
        assert!(parse_check(path, CONFIG_FILE, b"{\"a\":").is_err());
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
        let mut sources = Vec::new();
        match &store.spec {
            Spec::Files(names) => {
                for name in *names {
                    for rel in [name.to_string(), format!("{name}.bak")] {
                        if durable::is_file(&roots.resolve(store.root, &rel)?) {
                            sources.push(sink.source(store.root, &rel, false)?);
                        }
                    }
                }
            }
            Spec::Dirs(dirs) => {
                for dir in *dirs {
                    for rel in durable::walk_files(&base.join(dir))? {
                        let path = format!("{dir}/{rel}");
                        // An interrupted write was never renamed, so it was never state (SM §11.2): it is retired,
                        // not carried with the store it lies in.
                        if store.root == D && temp_files::is_store_leftover(&path) {
                            let source = sink.source(D, &path, false)?;
                            sink.add_item(plan::item(
                                &plan::retire_key(D, &path),
                                KindGroup::Data,
                                K::Retired,
                                Contract::Retire,
                                vec![source],
                                None,
                            )?)?;
                        } else {
                            sources.push(sink.source(store.root, &path, false)?);
                        }
                    }
                }
            }
        }
        if sources.is_empty() {
            return Ok(());
        }
        sink.add_item(plan::item(
            &store_key(store.kind),
            KindGroup::Data,
            store.kind,
            Contract::Preserve,
            sources,
            None,
        )?)
    }

    fn plan_ledger_backups(&self, roots: &MigrationRoots, sink: &mut PlanSink) -> Result<()> {
        let usage = roots.data.join("usage");
        let mut sources = Vec::new();
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
                for rel in durable::walk_files(&usage.join(&name))? {
                    sources.push(sink.source(D, &format!("usage/{name}/{rel}"), false)?);
                }
            } else {
                sources.push(sink.source(D, &format!("usage/{name}"), false)?);
            }
        }
        if sources.is_empty() {
            return Ok(());
        }
        sink.add_item(plan::item(
            &store_key(K::LedgerBackups),
            KindGroup::Data,
            K::LedgerBackups,
            Contract::Preserve,
            sources,
            None,
        )?)
    }

    fn plan_retired(&self, roots: &MigrationRoots, sink: &mut PlanSink) -> Result<()> {
        let retire = |sink: &mut PlanSink, rel: String, sources: Vec<SourceFile>| -> Result<()> {
            sink.add_item(plan::item(
                &plan::retire_key(D, &rel),
                KindGroup::Data,
                K::Retired,
                Contract::Retire,
                sources,
                None,
            )?)
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
            let sources = files
                .iter()
                .map(|rel| sink.source(D, &format!("{dir}/{rel}"), false))
                .collect::<Result<Vec<_>>>()?;
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
            let (key, contract) = if imported {
                (plan::retire_key(D, rel), Contract::Retire)
            } else {
                (plan::retain_key(D, rel), Contract::Retain)
            };
            sink.add_item(plan::item(
                &key,
                KindGroup::Data,
                K::LedgerLegacyInputs,
                contract,
                vec![source],
                None,
            )?)?;
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
            Some(Target::ConfigKey {
                key: LEGACY_COMPACTION_TARGET.into(),
            }),
        )?)
    }

    fn stage_legacy_compaction(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<Staged> {
        let (_, doc) = read_config(&cx.roots.data)?.ok_or_else(|| Blocked::StoreSchema {
            key: item.key.as_str().into(),
            detail: format!("{CONFIG_FILE} is gone"),
        })?;
        // Already folded (an earlier run published it): the current file is the output.
        let bytes = match folded_config(&doc) {
            Some(next) => config_bytes(&next),
            None => durable::read(&cx.roots.data.join(CONFIG_FILE))?,
        };
        durable::write_synced(&cx.stage_dir(item.key.as_str()).join(CONFIG_FILE), &bytes)?;
        Ok(Staged::Output {
            output_sha256: durable::sha256_hex(&bytes),
            replaced_surrogates: 0,
        })
    }

    fn publish_legacy_compaction(
        &self,
        cx: &ItemContext<'_>,
        item: &ManifestItem,
        staged: &StagedEntry,
    ) -> Result<()> {
        let target = cx.roots.data.join(CONFIG_FILE);
        let current = durable::read(&target)?;
        if durable::sha256_hex(&current) == staged.output_sha256.as_str() {
            return Ok(());
        }
        let stage = cx.stage_dir(item.key.as_str()).join(CONFIG_FILE);
        if !durable::exists(&stage)? {
            return Err(Blocked::TargetConflict {
                key: item.key.as_str().into(),
                path: target,
            });
        }
        durable::durable_rename(&stage, &target)
    }

    fn verify_legacy_compaction(&self, cx: &ItemContext<'_>) -> Result<Verdict> {
        let (bytes, doc) = read_config(&cx.roots.data)?.ok_or_else(|| Blocked::StoreSchema {
            key: LEGACY_COMPACTION_ITEM.into(),
            detail: format!("{CONFIG_FILE} is gone"),
        })?;
        if folded_config(&doc).is_some() {
            return Ok(Verdict::Quarantine {
                code: QuarantineCode::DigestMismatch,
                detail: "agent.compaction still holds legacy keys".into(),
            });
        }
        Ok(Verdict::Verified {
            digest: Some(digest(&durable::sha256_hex(&bytes))?),
        })
    }

    fn verify_store(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<Verdict> {
        let singleton = STORES.iter().any(|s| s.kind == item.kind && s.singleton);
        for source in &item.sources {
            let path = cx.source_path(source)?;
            let bytes = cx.read_source(source)?;
            if let Err(detail) = parse_check(&path, &source.path, &bytes) {
                if singleton {
                    return Err(Blocked::StoreSchema {
                        key: item.key.as_str().into(),
                        detail,
                    });
                }
                return Ok(Verdict::Quarantine {
                    code: QuarantineCode::ParseError,
                    detail,
                });
            }
        }
        Ok(Verdict::Verified {
            digest: Some(digest(&sources_sha256(&item.sources))?),
        })
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
                || RETIRED_DIRS.contains(&rel)
                || (!rel.contains('/') && is_retired_pattern(rel))
                || temp_files::is_store_leftover(rel)
                || rel.starts_with(LEGACY_ATTACHMENTS);
        }
        handles(item.kind)
    }

    fn wave(&self, item: &ManifestItem) -> Wave {
        if [LEGACY_COMPACTION_ITEM, connectors::ITEM].contains(&item.key.as_str()) {
            Wave::Settings
        } else {
            Wave::Stores
        }
    }

    fn stage(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<Staged> {
        if item.key.as_str() == LEGACY_COMPACTION_ITEM {
            return self.stage_legacy_compaction(cx, item);
        }
        if item.key.as_str() == connectors::ITEM {
            return connectors::stage(cx, item);
        }
        match item.contract {
            Contract::Retain => Ok(Staged::Quarantine {
                code: QuarantineCode::LedgerImportIncomplete,
                detail: "the ledger has no metadata.importedThrough: kept for the usage history import".into(),
            }),
            _ => Ok(Staged::Output {
                output_sha256: sources_sha256(&item.sources),
                replaced_surrogates: 0,
            }),
        }
    }

    fn publish(&self, cx: &ItemContext<'_>, item: &ManifestItem, staged: &StagedEntry) -> Result<()> {
        if item.key.as_str() == LEGACY_COMPACTION_ITEM {
            return self.publish_legacy_compaction(cx, item, staged);
        }
        if item.key.as_str() == connectors::ITEM {
            return connectors::publish(cx, item, staged);
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
        item.contract == Contract::Preserve || item.key.as_str() == LEGACY_COMPACTION_ITEM || in_legacy_attachments(item)
    }
}
