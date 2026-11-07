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
    "session-summaries.json",
    "session-summaries.log",
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
    "prompt-attachments/gc-reference-cache.json",
    "prompt-attachments/gc-last-run",
    "prompt-attachments/gc-running",
    "prompt-attachments/staged-originals.json",
    "prompt-attachments/staged-originals.json.lock",
];

/// Retired directories under `<D>`, one item each.
const RETIRED_DIRS: &[&str] = &["live-sessions", "session-writer-locks", "media/renditions"];

const LEDGER_LEGACY_INPUTS: &[&str] = &[
    "usage-rollup.local.json",
    "gateway-usage.local.jsonl",
    "gateway-usage.local.json",
    "usage-rollup.local.json.migrated.bak",
    "gateway-usage.local.jsonl.migrated.bak",
    "gateway-usage.local.json.migrated.bak",
];

fn is_hex(text: &str, len: usize) -> bool {
    text.len() == len && text.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Interrupted-write leftovers that were never renamed (SM §11.2): `*.mixdog-tmp-*`,
/// `.<name>.<24hex>.tmp`, `*.lock.<pid>.<hex>.tmp`, `<name>.json.<12hex>.tmp`.
pub fn is_interrupted_write(name: &str) -> bool {
    if name.contains(".mixdog-tmp-") {
        return true;
    }
    let Some(stem) = name.strip_suffix(".tmp") else {
        return false;
    };
    let Some((head, tail)) = stem.rsplit_once('.') else {
        return false;
    };
    if name.starts_with('.') && is_hex(tail, 24) {
        return true;
    }
    if head.ends_with(".json") && is_hex(tail, 12) {
        return true;
    }
    if let Some((lock, pid)) = head.rsplit_once('.') {
        return lock.ends_with(".lock")
            && !pid.is_empty()
            && pid.bytes().all(|b| b.is_ascii_digit())
            && tail.bytes().all(|b| b.is_ascii_hexdigit())
            && !tail.is_empty();
    }
    false
}

/// Root-level retire patterns (besides exact names).
fn is_retired_pattern(name: &str) -> bool {
    name.starts_with("session-summaries.json.bak-")
        || name.starts_with("session-catalog.sqlite.corrupt-")
        || (name.starts_with("session-cwd-") && name.ends_with(".txt"))
        || (name.ends_with("-oauth-models.json"))
        || (name.ends_with("-usage-cache.json"))
        || (name.starts_with("studio-models-") && name.ends_with(".json"))
        || is_interrupted_write(name)
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
/// 1.4.5 kept the quota auto-resume switch at `quotaResume.autoResume`; the core reads the registered key `quotaAutoResume`
/// (`desktop-services.md` A2/D1).
pub const LEGACY_QUOTA_ITEM: &str = "config/quotaResume.autoResume";
const QUOTA_TARGET: &str = "quotaAutoResume";

/// The config document with `quotaResume.autoResume` moved to `quotaAutoResume`; `None` when it holds no such key. The switch
/// is on unless it is the boolean `false` (`quotaAutoResumeEnabled`), so only `false` is carried; any other value is the
/// default and is just dropped. A `quotaAutoResume` the document already has wins. The rest of `quotaResume` stays, and an
/// emptied `quotaResume` goes.
pub fn moved_quota_config(doc: &Value) -> Option<Value> {
    let section = doc.get("quotaResume")?.as_object()?;
    let legacy = section.get("autoResume")?;
    let mut next = doc.clone();
    let root = next.as_object_mut()?;
    let mut rest = section.clone();
    rest.shift_remove("autoResume");
    if rest.is_empty() {
        root.shift_remove("quotaResume");
    } else {
        root.insert("quotaResume".into(), Value::Object(rest));
    }
    if *legacy == Value::Bool(false) && !root.contains_key(QUOTA_TARGET) {
        root.insert(QUOTA_TARGET.into(), Value::Bool(false));
    }
    Some(next)
}

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
    let text = bytes.strip_prefix("\u{feff}".as_bytes()).unwrap_or(&bytes);
    let value = json::parse_source(text).map_err(|detail| Blocked::StoreSchema {
        key: "store/settings".into(),
        detail,
    })?;
    Ok(Some((bytes, value.value)))
}

/// Strict parse of the JSON formats among a store's files.
fn parse_check(path: &Path, rel: &str, bytes: &[u8]) -> std::result::Result<(), String> {
    let text = bytes.strip_prefix("\u{feff}".as_bytes()).unwrap_or(bytes);
    if rel.ends_with(".json") {
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

/// SHA-256 over a preserve item's sources (`root path sha256` lines): its staged output
/// and verified digest.
fn sources_sha256(sources: &[SourceFile]) -> String {
    let mut text = String::new();
    for s in sources {
        text.push_str(&format!("{} {} {}\n", plan::root_name(s.root), s.path, s.sha256));
    }
    durable::sha256_hex(text.as_bytes())
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
                        sources.push(sink.source(store.root, &format!("{dir}/{rel}"), false)?);
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

    fn plan_blobs(&self, roots: &MigrationRoots, sink: &mut PlanSink) -> Result<()> {
        let mut sources = Vec::new();
        let base = roots.data.join(mixdog_store::schema::blob::BLOB_DIR);
        for (shard, is_dir) in durable::list_dir(&base)? {
            if !is_dir || !is_hex(&shard, 2) {
                continue;
            }
            for (name, is_dir) in durable::list_dir(&base.join(&shard))? {
                if !is_dir && is_hex(&name, 64) && name.starts_with(&shard) {
                    let rel = format!("{}/{shard}/{name}", mixdog_store::schema::blob::BLOB_DIR);
                    sources.push(sink.source(D, &rel, false)?);
                }
            }
        }
        if sources.is_empty() {
            return Ok(());
        }
        sink.add_item(plan::item(
            &store_key(K::AttachmentBlobs),
            KindGroup::Data,
            K::AttachmentBlobs,
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
        for rel in RETIRED_FILES {
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

    /// Legacy usage inputs: already imported (`metadata.importedThrough`) → retire; else
    /// retain `ledger_import_incomplete` (the importer is not reimplemented).
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

    fn plan_legacy_quota(&self, roots: &MigrationRoots, sink: &mut PlanSink) -> Result<()> {
        let Some((_, doc)) = read_config(&roots.data)? else {
            return Ok(());
        };
        if moved_quota_config(&doc).is_none() {
            return Ok(());
        }
        sink.add_item(plan::item(
            LEGACY_QUOTA_ITEM,
            KindGroup::Data,
            K::Settings,
            Contract::Convert,
            Vec::new(),
            Some(Target::ConfigKey {
                key: QUOTA_TARGET.into(),
            }),
        )?)
    }

    fn stage_legacy_quota(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<Staged> {
        let (_, doc) = read_config(&cx.roots.data)?.ok_or_else(|| Blocked::StoreSchema {
            key: item.key.as_str().into(),
            detail: format!("{CONFIG_FILE} is gone"),
        })?;
        // Already moved (an earlier run published it): the current file is the output.
        let bytes = match moved_quota_config(&doc) {
            Some(next) => config_bytes(&next),
            None => durable::read(&cx.roots.data.join(CONFIG_FILE))?,
        };
        durable::write_synced(&cx.stage_dir(item.key.as_str()).join(CONFIG_FILE), &bytes)?;
        Ok(Staged::Output {
            output_sha256: durable::sha256_hex(&bytes),
            replaced_surrogates: 0,
        })
    }

    fn verify_legacy_quota(&self, cx: &ItemContext<'_>) -> Result<Verdict> {
        let (bytes, doc) = read_config(&cx.roots.data)?.ok_or_else(|| Blocked::StoreSchema {
            key: LEGACY_QUOTA_ITEM.into(),
            detail: format!("{CONFIG_FILE} is gone"),
        })?;
        if moved_quota_config(&doc).is_some() {
            return Ok(Verdict::Quarantine {
                code: QuarantineCode::DigestMismatch,
                detail: "quotaResume.autoResume is still in the config".into(),
            });
        }
        Ok(Verdict::Verified {
            digest: Some(digest(&durable::sha256_hex(&bytes))?),
        })
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

fn digest(hex: &str) -> Result<Digest> {
    Ok(json::hex_digest(hex))
}

fn handles(kind: ItemKind) -> bool {
    matches!(
        kind,
        K::AttachmentBlobs | K::LedgerBackups | K::Retired | K::LedgerLegacyInputs
    ) || STORES.iter().any(|s| s.kind == kind)
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
                    let value = json::parse_source(&cx.read_source(s)?).map_err(Blocked::journal)?.value;
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
                    let value = json::parse_source(&cx.read_source(s)?).map_err(Blocked::journal)?.value;
                    owners(&value, &mut ids);
                }
            }
        }
        _ => {}
    }
    Ok(ids)
}

impl ItemDriver for StoresDriver {
    fn plan(&self, roots: &MigrationRoots, sink: &mut PlanSink) -> Result<()> {
        for store in STORES {
            self.plan_store(roots, sink, store)?;
        }
        self.plan_blobs(roots, sink)?;
        self.plan_ledger_backups(roots, sink)?;
        self.plan_retired(roots, sink)?;
        self.plan_ledger_inputs(roots, sink)?;
        self.plan_legacy_compaction(roots, sink)?;
        self.plan_legacy_quota(roots, sink)?;
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
                || (!rel.contains('/') && is_retired_pattern(rel));
        }
        handles(item.kind)
    }

    fn wave(&self, item: &ManifestItem) -> Wave {
        if [LEGACY_COMPACTION_ITEM, LEGACY_QUOTA_ITEM, connectors::ITEM].contains(&item.key.as_str()) {
            Wave::Late
        } else {
            Wave::Stores
        }
    }

    fn stage(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<Staged> {
        if item.key.as_str() == LEGACY_COMPACTION_ITEM {
            return self.stage_legacy_compaction(cx, item);
        }
        if item.key.as_str() == LEGACY_QUOTA_ITEM {
            return self.stage_legacy_quota(cx, item);
        }
        if item.key.as_str() == connectors::ITEM {
            return connectors::stage(cx, item);
        }
        match item.contract {
            Contract::Retain => Ok(Staged::Quarantine {
                code: QuarantineCode::LedgerImportIncomplete,
                detail: "the ledger has no metadata.importedThrough: not yet imported".into(),
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
        if item.key.as_str() == LEGACY_QUOTA_ITEM {
            // The same whole-file publish as the compaction item: the stage is the config as it stands plus this move.
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
        if item.key.as_str() == LEGACY_QUOTA_ITEM {
            return self.verify_legacy_quota(cx);
        }
        if item.key.as_str() == connectors::ITEM {
            return connectors::verify(cx, item);
        }
        match item.contract {
            Contract::Retire => Ok(Verdict::Verified { digest: None }),
            _ => self.verify_store(cx, item),
        }
    }

    fn dangling(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<u64> {
        let migrated: std::collections::BTreeSet<&str> = cx.verified_sessions().collect();
        Ok(linked_sessions(item, cx)?
            .iter()
            .filter(|id| !migrated.contains(id.as_str()))
            .count() as u64)
    }

    fn keeps_sources(&self, item: &ManifestItem) -> bool {
        item.contract == Contract::Preserve
            || item.key.as_str() == LEGACY_COMPACTION_ITEM
            || item.key.as_str() == LEGACY_QUOTA_ITEM
    }
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
    fn a_1_4_5_config_with_the_quota_switch_off_keeps_it_off_under_the_new_key() {
        // The shape 1.4.5 wrote: the switch in the `quotaResume` section, beside another of its keys.
        let off = serde_json::json!({"agent": {}, "quotaResume": {"autoResume": false, "note": 1}, "desktop": {"zoom": 1}});
        assert_eq!(
            moved_quota_config(&off),
            Some(serde_json::json!({"agent": {}, "quotaResume": {"note": 1}, "desktop": {"zoom": 1}, "quotaAutoResume": false}))
        );
        // Alone in its section, the section goes with it.
        let only = serde_json::json!({"quotaResume": {"autoResume": false}});
        assert_eq!(moved_quota_config(&only), Some(serde_json::json!({"quotaAutoResume": false})));
        // On (or any value but `false`) is the default: nothing is written under the new key.
        assert_eq!(
            moved_quota_config(&serde_json::json!({"quotaResume": {"autoResume": true}})),
            Some(serde_json::json!({}))
        );
        assert_eq!(
            moved_quota_config(&serde_json::json!({"quotaResume": {"autoResume": "no"}})),
            Some(serde_json::json!({}))
        );
        // A key the document already has wins; the legacy one is still removed.
        assert_eq!(
            moved_quota_config(&serde_json::json!({"quotaAutoResume": true, "quotaResume": {"autoResume": false}})),
            Some(serde_json::json!({"quotaAutoResume": true}))
        );
        // Nothing to move: no item is planned, and a moved document is not moved again.
        assert_eq!(moved_quota_config(&serde_json::json!({"agent": {}})), None);
        assert_eq!(moved_quota_config(&serde_json::json!({"quotaResume": {"note": 1}})), None);
        let moved = moved_quota_config(&off).unwrap();
        assert_eq!(moved_quota_config(&moved), None);
    }

    #[test]
    fn interrupted_writes_are_recognized() {
        for name in [
            "a.json.0123456789ab.tmp",
            ".x.json.0123456789abcdef01234567.tmp",
            "x.lock.123.ab.tmp",
            "gateway-session-routes.json.mixdog-tmp-ab12",
        ] {
            assert!(is_interrupted_write(name), "{name}");
        }
        assert!(!is_interrupted_write("notes.tmp"));
    }
}
