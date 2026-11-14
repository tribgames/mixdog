//! The two one-time migrations of the agent definitions (`runtime/shared/bot-split-migration.mjs` and
//! `agent-kind-migration.mjs`), so a profile that never ran them reaches the layout this core reads.
//!
//! - The bot split copies every bot of `agents/` to `bots/<id>/` with its own model route, and Mixy's identity
//!   from `agents/lead/` to `bots/mixy/`; the originals stay, `bots/migration.json` names what moved. Every later
//!   start re-syncs it: a copy is replaced only while `bots/` is untouched since the copy and `agents/` changed.
//! - The kind stamp writes `kind: agent` into the `AGENT.md` of a user-made agent that is no bot (it never held
//!   a bot's evidence, or a Lead delegated work to it), and brings a delegated agent the split took for a bot back
//!   to `agents/`.
//!
//! Both run under one cross-process lock beside the profile, after a user-data backup of `agents/` and `bots/`.
//! Synchronous file work for a durability lane job: the evidence only the sessions know (a home thread's greeting,
//! Mixy's thread route) and the config routes arrive in [`Facts`], read before the job.
#![allow(clippy::disallowed_methods, reason = "lane job bodies: the service runs these functions on a durability lane")]

use std::collections::BTreeSet;
use std::collections::HashMap;
use std::collections::HashSet;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use mixdog_core_base::rooms::ids::agent_id_of_home_session;
use mixdog_core_config::workflow::ids::truthy;
use mixdog_core_config::workflow::pack::read_document;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_statefile as state;
use serde_json::Map;
use serde_json::Value;
use sha2::Digest as _;
use sha2::Sha256;

use super::files::STARTERS;
use super::files::explicit_kind;
use super::files::is_dialog_default_body;
use super::files::manifest_of;

/// `BOT_MIGRATION_LOCK`: beside, never inside, `bots/` and `agents/`.
pub const LOCK_FILE: &str = ".bot-split.lock";
/// `BOT_SPLIT_BACKUP_DIRS`: what the backup before a copy carries besides the routine user data.
pub const BACKUP_DIRS: [&str; 2] = ["agents", "bots"];
const BOTS_DIR: &str = "bots";
const MANIFEST: &str = "migration.json";
const MANIFEST_VERSION: i64 = 1;
pub const MIXY_BOT_ID: &str = "mixy";
/// Mixy's home thread keeps the id it always had: its messages never move.
pub const MIXY_LEGACY_HOME_SESSION_ID: &str = "sess_home_lead";
const KIND_RECORD: &str = "agent-kind-migration.json";
const KIND_VERSION: i64 = 1;
const DELETED_MARKER: &str = ".deleted";
const ARCHIVED_FILE: &str = "AGENT.md.archived";
const LOCK_WAIT: Duration = Duration::from_secs(10);
/// Keys only the bot store writes into a bot's `agent.json`.
const KIND_STORE_ONLY_KEYS: [&str; 2] = ["route", "homeSessionId"];
const SPLIT_STORE_ONLY_KEYS: [&str; 3] = ["route", "homeSessionId", "created"];
/// Mixy's own files under `agents/lead/`: name, description, face, connectors and the creation flag.
const MIXY_IDENTITY_KEYS: [&str; 5] = ["name", "description", "avatar", "connectors", "created"];

/// What the sessions, the config and the roster know, read before the lane job.
#[derive(Debug, Default, Clone)]
pub struct Facts {
    /// The install root: shipped agents are under `<shipped>/agents`.
    pub shipped: PathBuf,
    /// The internal agents (`isHiddenAgent`).
    pub hidden: HashSet<String>,
    /// The ids whose home thread holds the creation greeting (`homeThreadEvidence(..).greeted`).
    pub greeted: HashSet<String>,
    /// The user wrote in Mixy's home thread (`homeThreadEvidence(dataDir, 'lead').chatted`).
    pub mixy_chatted: bool,
    /// The provider and model Mixy's thread runs on.
    pub mixy_thread_route: Option<Value>,
    /// The Lead's route at this time (Mixy's route when her thread names none).
    pub lead_route: Option<Value>,
    /// An agent's own route in the config, by id (`agentRouteFromConfig`).
    pub routes: HashMap<String, Value>,
}

/// How a run of the bot split ended.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct SplitReport {
    pub skipped: bool,
    pub failed: bool,
    /// Another start held the lock for the whole wait: the profile is read as it is.
    pub busy: bool,
    pub bots: Vec<String>,
    pub mixy: bool,
    pub changed: Vec<String>,
}

/// The first half of the kind stamp: what is written and what still has to be brought back.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct KindStage {
    /// The record says it ran already.
    pub skipped: bool,
    pub failed: bool,
    pub stamped: Vec<String>,
    /// The ids whose `bots/<id>` is copied back to `agents/<id>`, with the route the bot had: the caller
    /// stores it in the config (where a workflow agent's lives), then calls [`finish_kind_stamp`].
    pub restore: Vec<(String, Option<Value>)>,
}

/// How a run of the kind stamp ended.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct KindReport {
    pub skipped: bool,
    pub failed: bool,
    pub stamped: Vec<String>,
    pub restored: Vec<String>,
}

fn read_json(file: &Path) -> Option<Map<String, Value>> {
    match serde_json::from_slice::<Value>(&std::fs::read(file).ok()?).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

fn write_json(lane: &InLane<DurabilityIo>, file: &Path, value: &Value) -> io::Result<()> {
    state::write_json(lane, file, value, &state::Opts { mode: 0o644, ..Default::default() }).map(|_| ()).map_err(|error| io::Error::other(error.to_string()))
}

/// A plain `writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)`.
fn write_plain_json(file: &Path, value: &Map<String, Value>) -> io::Result<()> {
    let mut text = serde_json::to_string_pretty(value).map_err(io::Error::other)?;
    text.push('\n');
    std::fs::write(file, text)
}

fn complete_route(route: Option<&Value>) -> Option<Value> {
    let route = route?;
    let text = |key: &str| route.get(key).and_then(Value::as_str).is_some_and(|s| !mixdog_js::js_trim(s).is_empty());
    (route.is_object() && text("provider") && text("model")).then(|| route.clone())
}

/// `definitionFile`: `AGENT.md`, or the archived copy of a deleted bot (its chat is kept, so it moves with the others).
fn definition_file(dir: &Path) -> Option<PathBuf> {
    if dir.join("AGENT.md").exists() {
        return Some(dir.join("AGENT.md"));
    }
    (dir.join(DELETED_MARKER).exists() && dir.join(ARCHIVED_FILE).exists()).then(|| dir.join(ARCHIVED_FILE))
}

fn read_text(file: &Path) -> String {
    String::from_utf8_lossy(&std::fs::read(file).unwrap_or_default()).into_owned()
}

fn sub_dirs(root: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    let mut names: Vec<String> = entries.flatten().filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir())).map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

/// `evidenceKind`: the explicit kind; else, for an unmarked user-made agent that is no shipped role, `bot` on the
/// dialog's avatar and default body or the creation greeting of its home thread.
fn evidence_kind(facts: &Facts, id: &str, frontmatter_kind: Option<&Value>, manifest: &Map<String, Value>, body: &str) -> Option<String> {
    if let Some(explicit) = explicit_kind(frontmatter_kind) {
        return Some(explicit);
    }
    if id.is_empty() || id == "lead" || facts.shipped.join("agents").join(id).join("AGENT.md").exists() {
        return None;
    }
    if truthy(manifest.get("avatar")) && is_dialog_default_body(body) {
        return Some("bot".into());
    }
    facts.greeted.contains(id).then(|| "bot".into())
}

/// The agent ids under `agents/` the evidence rule may need a home thread of: the caller asks the sessions about
/// them before the lane job.
pub fn evidence_candidates(data: &Path, shipped: &Path) -> Vec<String> {
    let root = data.join("agents");
    sub_dirs(&root)
        .into_iter()
        .filter(|id| id != "lead" && !id.starts_with('.') && !shipped.join("agents").join(id).join("AGENT.md").exists())
        .filter(|id| definition_file(&root.join(id)).is_some())
        .collect()
}

/// `classifyBotIds`: the `agents/` ids the rule classifies as bots (Mixy's `lead` never).
fn classify_bot_ids(data: &Path, facts: &Facts) -> Vec<String> {
    let root = data.join("agents");
    let mut bots = Vec::new();
    for id in sub_dirs(&root) {
        if id == "lead" {
            continue;
        }
        let dir = root.join(&id);
        let Some(file) = definition_file(&dir) else { continue };
        let (frontmatter, body) = read_document(&read_text(&file));
        if evidence_kind(facts, &id, frontmatter.get("kind"), &manifest_of(&dir), &body).as_deref() == Some("bot") {
            bots.push(id);
        }
    }
    bots.sort();
    bots
}

/// `mixyToMigrate`: whether `agents/lead` holds a Mixy the user made or used, never v1.3.0's untouched `{"created": true}`.
fn mixy_to_migrate(data: &Path, facts: &Facts) -> bool {
    let dir = data.join("agents").join("lead");
    let manifest = manifest_of(&dir);
    if manifest.get("created") != Some(&Value::Bool(true)) {
        return false;
    }
    let named = manifest.get("name").is_some_and(|name| !mixdog_js::js_trim(&mixdog_js::value_to_string(name)).is_empty());
    let present = |key: &str| manifest.get(key).is_some_and(|value| !value.is_null());
    let identity = named || present("avatar") || present("connectors") || dir.join("PERSONA.md").exists() || dir.join("AGENT.md").exists();
    identity || facts.mixy_chatted
}

// --- Content fingerprints (the re-sync rule) ---

fn folder_files(dir: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => walk(&path, out),
                Ok(kind) if kind.is_file() && !path.to_string_lossy().ends_with(".lock") => out.push(path),
                _ => {}
            }
        }
    }
    let mut files = Vec::new();
    walk(dir, &mut files);
    files.sort_by_key(|path| path.to_string_lossy().into_owned());
    files
}

/// A JSON value with every object's keys sorted, nested ones included.
fn canonical(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        Value::Object(map) => {
            let sorted: BTreeSet<&String> = map.keys().collect();
            Value::Object(sorted.into_iter().map(|key| (key.clone(), canonical(&map[key]))).collect())
        }
        other => other.clone(),
    }
}

/// A folder's files as one hash; `agent.json` without the keys only the store writes (a bot's route, Mixy's thread id
/// and created flag), so changing a bot's model never counts as editing its definition.
fn folder_hash(dir: &Path) -> String {
    let mut hash = Sha256::new();
    for file in folder_files(dir) {
        let mut bytes = std::fs::read(&file).unwrap_or_default();
        if file.file_name().is_some_and(|name| name == "agent.json") && file.parent() == Some(dir) {
            if let Some(mut manifest) = read_json(&file) {
                for key in SPLIT_STORE_ONLY_KEYS {
                    manifest.shift_remove(key);
                }
                bytes = serde_json::to_vec(&canonical(&Value::Object(manifest))).unwrap_or_default();
            }
        }
        let relative = file.strip_prefix(dir).unwrap_or(&file);
        hash.update(relative.to_string_lossy().as_bytes());
        hash.update([0]);
        hash.update(&bytes);
        hash.update([0]);
    }
    let hex: String = hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
    hex[..24].to_owned()
}

fn newest_change(dir: &Path) -> f64 {
    folder_files(dir)
        .iter()
        .filter_map(|file| std::fs::metadata(file).ok()?.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|age| age.as_secs_f64() * 1000.0)
        .fold(0.0, f64::max)
}

fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn remove_best_effort(path: &Path) {
    let _ = std::fs::remove_dir_all(path);
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |age| age.as_millis() as i64)
}

/// A staging or set-aside folder an earlier run left (`.<id>.<pid>-<time>.<kind>`): the id, the pid-time tag, the kind.
fn leftover(name: &str) -> Option<(&str, &str, &str)> {
    let rest = name.strip_prefix('.')?;
    let (stem, kind) = rest.strip_suffix(".staging").map(|s| (s, "staging")).or_else(|| rest.strip_suffix(".old").map(|s| (s, "old")))?;
    let (id, tag) = stem.rsplit_once('.')?;
    let (pid, time) = tag.split_once('-')?;
    let digits = |text: &str| !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit());
    (!id.is_empty() && digits(pid) && digits(time)).then_some((id, tag, kind))
}

/// A staging folder goes; a set-aside `.old` the manifest names as retired is a committed swap's rest and goes; any
/// other `.old` is the bot as it was before a run that never committed: it is put back.
fn sweep_leftovers(bots_root: &Path, retired: &HashSet<String>) -> io::Result<()> {
    let Ok(entries) = std::fs::read_dir(bots_root) else { return Ok(()) };
    let names: Vec<String> = entries.flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
    for name in names {
        let Some((id, tag, kind)) = leftover(&name) else { continue };
        let path = bots_root.join(&name);
        if kind == "staging" || retired.contains(&name) {
            remove_best_effort(&path);
            continue;
        }
        let target = bots_root.join(id);
        if target.exists() {
            let pid = tag.split_once('-').map_or("0", |(pid, _)| pid);
            let aside = bots_root.join(format!(".{id}.{pid}-0.staging"));
            std::fs::rename(&target, &aside)?;
            remove_best_effort(&aside);
        }
        std::fs::rename(&path, &target)?;
    }
    Ok(())
}

/// The finished split's record as on disk now.
fn read_manifest_now(bots_root: &Path) -> Option<Map<String, Value>> {
    read_json(&bots_root.join(MANIFEST)).filter(|manifest| manifest.get("version").and_then(Value::as_i64) == Some(MANIFEST_VERSION))
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::as_array).map(|list| list.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default()
}

/// A bot's `agent.json` in `staging`, with `route` (when complete) over what the copy carries.
fn write_staged_manifest(staging: &Path, route: Option<&Value>) -> io::Result<()> {
    let mut manifest = read_json(&staging.join("agent.json")).unwrap_or_default();
    if let Some(route) = complete_route(route) {
        manifest.insert("route".into(), route);
    }
    write_plain_json(&staging.join("agent.json"), &manifest)
}

/// `migrateBotsToOwnStore`: the split, and on every later start the re-sync (`backup` first whenever something is to
/// be copied). Runs under the cross-process migration lock: a second process waits, then reads the profile as it is.
pub fn migrate_bots_to_own_store(lane: &InLane<DurabilityIo>, data: &Path, facts: &Facts, backup: &dyn Fn(&InLane<DurabilityIo>)) -> SplitReport {
    let opts = state::LockOpts { timeout: Some(LOCK_WAIT), ..Default::default() };
    match state::with_lock(lane, &data.join(LOCK_FILE), &opts, || migrate_locked(lane, data, facts, backup)) {
        Ok(report) => report,
        Err(error) => {
            let done = read_manifest_now(&data.join(BOTS_DIR));
            tracing::warn!("[bot-split] another start is migrating; this one reads the profile as it is: {error}");
            SplitReport { failed: true, busy: true, bots: strings(done.as_ref().and_then(|m| m.get("bots"))), mixy: done.as_ref().is_some_and(|m| m.get("mixy") == Some(&Value::Bool(true))), ..Default::default() }
        }
    }
}

/// What one run of the split changed, undone in reverse on a failure before the commit.
struct Change {
    target: PathBuf,
    old: Option<PathBuf>,
}

fn migrate_locked(lane: &InLane<DurabilityIo>, data: &Path, facts: &Facts, backup: &dyn Fn(&InLane<DurabilityIo>)) -> SplitReport {
    let bots_root = data.join(BOTS_DIR);
    let done = read_manifest_now(&bots_root);
    let run_tag = format!("{}-{}", std::process::id(), now_ms());
    let mut changes: Vec<Change> = Vec::new();
    let mut backed_up = false;
    let outcome = (|| -> io::Result<Map<String, Value>> {
        let mut before_copy = || {
            if !backed_up {
                backed_up = true;
                backup(lane);
            }
        };
        // `stage`: a copy of `source` (or an empty folder) to swap in; `swap_in`: atomic renames, the replaced
        // folder set aside as `.old` until the commit.
        let stage = |id: &str, source: Option<&Path>| -> io::Result<PathBuf> {
            let staging = bots_root.join(format!(".{id}.{run_tag}.staging"));
            remove_best_effort(&staging);
            match source {
                Some(source) => copy_dir(source, &staging)?,
                None => std::fs::create_dir_all(&staging)?,
            }
            Ok(staging)
        };
        let swap_in = |changes: &mut Vec<Change>, id: &str, staging: PathBuf, replace: bool| -> io::Result<()> {
            let target = bots_root.join(id);
            let mut old = None;
            if replace && target.exists() {
                let aside = bots_root.join(format!(".{id}.{run_tag}.old"));
                std::fs::rename(&target, &aside)?;
                old = Some(aside);
            }
            if let Err(error) = std::fs::rename(&staging, &target) {
                remove_best_effort(&staging);
                // Should this fail too, the next start's sweep puts the `.old` back.
                if let Some(old) = &old {
                    std::fs::rename(old, &target)?;
                }
                return Err(error);
            }
            changes.push(Change { target, old });
            Ok(())
        };

        std::fs::create_dir_all(&bots_root)?;
        let retired_names: HashSet<String> = strings(done.as_ref().and_then(|m| m.get("retired"))).into_iter().collect();
        sweep_leftovers(&bots_root, &retired_names)?;
        // Committed set-asides the sweep could not remove stay named for a later start.
        let mut retired: Vec<String> = retired_names.iter().filter(|name| bots_root.join(name).exists()).cloned().collect();
        let mut copies = done.as_ref().and_then(|m| m.get("copies")).and_then(Value::as_object).cloned().unwrap_or_default();
        let mut bots: BTreeSet<String> = strings(done.as_ref().and_then(|m| m.get("bots"))).into_iter().collect();
        let record = |copies: &mut Map<String, Value>, id: &str, source: &Path| {
            copies.insert(id.to_owned(), serde_json::json!({ "source": folder_hash(source), "copy": folder_hash(&bots_root.join(id)), "at": now_ms() }));
        };
        let own_route = |id: &str| complete_route(facts.routes.get(id));

        // 1. Bots in agents/ not yet in the store.
        for id in classify_bot_ids(data, facts) {
            if bots.contains(&id) {
                continue;
            }
            let source = data.join("agents").join(&id);
            if !bots_root.join(&id).exists() {
                before_copy();
                let staging = stage(&id, Some(&source))?;
                write_staged_manifest(&staging, own_route(&id).as_ref())?;
                swap_in(&mut changes, &id, staging, false)?;
            }
            bots.insert(id.clone());
            record(&mut copies, &id, &source);
        }
        // 2. Migrated bots edited in agents/ after their copy (a 1.3.0 round trip).
        for id in if done.is_some() { bots.iter().cloned().collect() } else { Vec::new() } {
            let source = data.join("agents").join(&id);
            let target = bots_root.join(&id);
            let Some(entry) = copies.get(&id).cloned() else { continue };
            if !target.exists() || !source.exists() {
                continue;
            }
            let at = entry.get("at").and_then(Value::as_f64).unwrap_or(0.0);
            let source_changed = Some(folder_hash(&source)) != entry.get("source").and_then(Value::as_str).map(str::to_owned) && newest_change(&source) > at;
            if !source_changed {
                continue;
            }
            if Some(folder_hash(&target)) != entry.get("copy").and_then(Value::as_str).map(str::to_owned) {
                tracing::warn!("[bot-split] {id}: edited in both agents/ and bots/; the bots/ copy is kept");
                continue;
            }
            before_copy();
            let route = read_json(&target.join("agent.json")).and_then(|manifest| manifest.get("route").cloned());
            let staging = stage(&id, Some(&source))?;
            write_staged_manifest(&staging, route.as_ref())?;
            swap_in(&mut changes, &id, staging, true)?;
            record(&mut copies, &id, &source);
        }
        // 3. Mixy: made or used in agents/lead; bots/mixy keeps what it has.
        let mut mixy = done.as_ref().is_some_and(|m| m.get("mixy") == Some(&Value::Bool(true)));
        let lead_dir = data.join("agents").join("lead");
        let mixy_dir = bots_root.join(MIXY_BOT_ID);
        let mixy_entry = copies.get(MIXY_BOT_ID).cloned();
        let lead_edited = mixy_entry.as_ref().is_some_and(|entry| {
            mixy_dir.exists()
                && Some(folder_hash(&lead_dir)) != entry.get("source").and_then(Value::as_str).map(str::to_owned)
                && newest_change(&lead_dir) > entry.get("at").and_then(Value::as_f64).unwrap_or(0.0)
        });
        if mixy_to_migrate(data, facts) && (mixy_entry.is_none() || lead_edited) {
            let current = if mixy_dir.exists() { read_json(&mixy_dir.join("agent.json")).unwrap_or_default() } else { Map::new() };
            let untouched = mixy_entry.as_ref().is_some_and(|entry| Some(folder_hash(&mixy_dir)) == entry.get("copy").and_then(Value::as_str).map(str::to_owned));
            if mixy_entry.is_some() && !untouched {
                tracing::warn!("[bot-split] Mixy: edited in both agents/lead and bots/mixy; bots/mixy is kept");
            } else {
                before_copy();
                // A first copy fills what bots/mixy lacks (the host may have written its flag or route there); a
                // re-sync takes agents/lead's identity.
                let staging = stage(MIXY_BOT_ID, (mixy_dir.exists() && mixy_entry.is_none()).then_some(mixy_dir.as_path()))?;
                for file in folder_files(&lead_dir) {
                    let name = file.strip_prefix(&lead_dir).unwrap_or(&file).to_path_buf();
                    if name == Path::new("agent.json") || (staging.join(&name).exists() && mixy_entry.is_none()) {
                        continue;
                    }
                    if let Some(parent) = staging.join(&name).parent() {
                        std::fs::create_dir_all(parent)?;
                    }
                    std::fs::copy(&file, staging.join(&name))?;
                }
                let lead = read_json(&lead_dir.join("agent.json")).unwrap_or_default();
                let mut manifest = Map::new();
                for key in MIXY_IDENTITY_KEYS {
                    if let Some(value) = lead.get(key) {
                        manifest.insert(key.to_owned(), value.clone());
                    }
                }
                if mixy_entry.is_none() {
                    manifest.extend(current.clone());
                }
                if let Some(created) = current.get("created").filter(|value| value.is_boolean()) {
                    manifest.insert("created".into(), created.clone());
                }
                if let Some(route) = complete_route(current.get("route")).or_else(|| complete_route(facts.mixy_thread_route.as_ref())).or_else(|| complete_route(facts.lead_route.as_ref())) {
                    manifest.insert("route".into(), route);
                }
                manifest.insert("homeSessionId".into(), Value::String(MIXY_LEGACY_HOME_SESSION_ID.into()));
                write_plain_json(&staging.join("agent.json"), &manifest)?;
                swap_in(&mut changes, MIXY_BOT_ID, staging, true)?;
                record(&mut copies, MIXY_BOT_ID, &lead_dir);
                mixy = true;
            }
        }
        retired.extend(changes.iter().filter_map(|change| change.old.as_ref()).filter_map(|old| old.file_name()).map(|name| name.to_string_lossy().into_owned()));
        retired.sort();
        let mut next = Map::new();
        next.insert("version".into(), Value::from(MANIFEST_VERSION));
        next.insert("completedAt".into(), done.as_ref().and_then(|m| m.get("completedAt").cloned()).filter(|v| truthy(Some(v))).unwrap_or_else(|| Value::String(iso_now())));
        next.insert("bots".into(), Value::from(bots.iter().cloned().collect::<Vec<_>>()));
        next.insert("mixy".into(), Value::Bool(mixy));
        next.insert("mixyHomeSessionId".into(), if mixy { Value::String(MIXY_LEGACY_HOME_SESSION_ID.into()) } else { Value::Null });
        next.insert("copies".into(), Value::Object(copies));
        if !retired.is_empty() {
            next.insert("retired".into(), Value::from(retired));
        }
        // The commit point: once this lands, nothing of this run is undone.
        if done.is_none() || !changes.is_empty() || done.as_ref() != Some(&next) {
            write_json(lane, &bots_root.join(MANIFEST), &Value::Object(next.clone()))?;
        }
        Ok(next)
    })();
    let next = match outcome {
        Ok(next) => next,
        Err(error) => {
            // Undo this run: what it added goes, what it replaced comes back.
            for Change { target, old } in changes.drain(..).rev() {
                let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let aside = bots_root.join(format!(".{name}.{run_tag}.staging"));
                if std::fs::rename(&target, &aside).is_ok() {
                    if let Some(old) = old {
                        let _ = std::fs::rename(old, &target);
                    }
                    remove_best_effort(&aside);
                }
            }
            if let Ok(entries) = std::fs::read_dir(&bots_root) {
                for entry in entries.flatten() {
                    if entry.file_name().to_string_lossy().ends_with(&format!(".{run_tag}.staging")) {
                        remove_best_effort(&entry.path());
                    }
                }
            }
            tracing::warn!("[bot-split] migration failed; the profile is unchanged: {error}");
            return SplitReport { failed: true, bots: strings(done.as_ref().and_then(|m| m.get("bots"))), mixy: done.as_ref().is_some_and(|m| m.get("mixy") == Some(&Value::Bool(true))), ..Default::default() };
        }
    };
    // Committed. Removing the set-aside copies is best-effort: the manifest names them as retired.
    for change in &changes {
        if let Some(old) = &change.old {
            remove_best_effort(old);
        }
    }
    let bots = strings(next.get("bots"));
    let mixy = next.get("mixy") == Some(&Value::Bool(true));
    if done.is_some() && changes.is_empty() {
        return SplitReport { skipped: true, bots, mixy, ..Default::default() };
    }
    SplitReport { bots, mixy, changed: changes.iter().filter_map(|change| change.target.file_name()).map(|n| n.to_string_lossy().into_owned()).collect(), ..Default::default() }
}

fn iso_now() -> String {
    chrono_like_iso(now_ms())
}

/// `new Date(ms).toISOString()` for a time after 1970.
fn chrono_like_iso(ms: i64) -> String {
    let (secs, millis) = (ms.div_euclid(1000), ms.rem_euclid(1000));
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z", rest / 3600, rest % 3600 / 60, rest % 60)
}

// --- The kind stamp ---

/// `delegatedAgentIds`: the agent ids a Lead delegated work to (`agent-workers.json`), lower-cased.
fn delegated_agent_ids(data: &Path) -> HashSet<String> {
    let workers = read_json(&data.join("agent-workers.json")).and_then(|doc| doc.get("workers").cloned());
    let rows: Vec<Value> = match workers {
        Some(Value::Array(rows)) => rows,
        Some(Value::Object(map)) => map.into_iter().map(|(_, row)| row).collect(),
        _ => Vec::new(),
    };
    let text = |row: &Value, key: &str| match row.get(key) {
        Some(Value::String(text)) => mixdog_js::js_trim(text).to_owned(),
        _ => String::new(),
    };
    let mut ids = HashSet::new();
    for row in &rows {
        let agent = text(row, "agent").to_lowercase();
        let mut owner = text(row, "ownerSessionId");
        if owner.is_empty() {
            owner = text(row, "parentSessionId");
        }
        if agent.is_empty() || agent == "lead" || owner.is_empty() {
            continue;
        }
        if agent_id_of_home_session(&owner).is_some() || owner.starts_with("sess_rmem_") {
            continue;
        }
        ids.insert(agent);
    }
    ids
}

/// `withAgentKindMarker`: the `AGENT.md` text with `kind: agent` in its front matter, every other line kept.
pub fn with_agent_kind_marker(text: &str) -> String {
    let marker = "kind: agent";
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let Some((head_end, close_start, close_end)) = front_matter_block(text) else {
        return format!("---{eol}{marker}{eol}---{eol}{eol}{text}");
    };
    let mut lines: Vec<&str> = text[head_end..close_start].split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line)).collect();
    match lines.iter().position(|line| line.starts_with("kind:")) {
        Some(at) => lines[at] = marker,
        None => lines.push(marker),
    }
    format!("{}{}{}{}", &text[..head_end], lines.join(eol), &text[close_start..close_end], &text[close_end..])
}

/// `^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))`: the end of the opening line, and the start and end of the
/// closing one.
fn front_matter_block(text: &str) -> Option<(usize, usize, usize)> {
    let rest = text.strip_prefix("---")?;
    let rest_trimmed = rest.trim_start_matches([' ', '\t']);
    let after_dashes = text.len() - rest_trimmed.len();
    let head_end = after_dashes + if rest_trimmed.starts_with("\r\n") { 2 } else if rest_trimmed.starts_with('\n') { 1 } else { return None };
    for at in head_end..=text.len() {
        if !text.is_char_boundary(at) {
            continue;
        }
        let tail = &text[at..];
        let Some(after_newline) = tail.strip_prefix("\r\n").map(|rest| (rest, 2)).or_else(|| tail.strip_prefix('\n').map(|rest| (rest, 1))) else { continue };
        let Some(after_rule) = after_newline.0.strip_prefix("---") else { continue };
        let spaces = after_rule.trim_start_matches([' ', '\t']);
        let used = at + after_newline.1 + 3 + (after_rule.len() - spaces.len());
        if spaces.is_empty() {
            return Some((head_end, at, used));
        }
        if spaces.starts_with("\r\n") {
            return Some((head_end, at, used + 2));
        }
        if spaces.starts_with('\n') {
            return Some((head_end, at, used + 1));
        }
    }
    None
}

fn stamp_file(file: &Path) -> io::Result<()> {
    std::fs::write(file, with_agent_kind_marker(&read_text(file)))
}

/// The first half of `migrateAgentKinds`, under the lock: the stamps are written, and each bot to bring back has its
/// files copied to `agents/<id>`. The caller stores each returned route in the config and calls [`finish_kind_stamp`];
/// a failure writes no record, so the next start retries (every step is idempotent).
pub fn stamp_agent_kinds(lane: &InLane<DurabilityIo>, data: &Path, facts: &Facts, backup: &dyn Fn(&InLane<DurabilityIo>)) -> KindStage {
    let opts = state::LockOpts { timeout: Some(LOCK_WAIT), ..Default::default() };
    let staged = state::with_lock(lane, &data.join(LOCK_FILE), &opts, || -> io::Result<KindStage> {
        if read_json(&data.join(KIND_RECORD)).is_some_and(|record| record.get("version").and_then(Value::as_i64) == Some(KIND_VERSION)) {
            return Ok(KindStage { skipped: true, ..Default::default() });
        }
        let agents_root = data.join("agents");
        let bots_root = data.join(BOTS_DIR);
        let split = read_manifest_now(&bots_root);
        let delegated = delegated_agent_ids(data);
        let (mut stamp, mut restore): (Vec<String>, Vec<String>) = (Vec::new(), Vec::new());
        for id in sub_dirs(&agents_root) {
            if id.starts_with('.') || id == "lead" || facts.hidden.contains(&id) || STARTERS.contains(&id.as_str()) {
                continue;
            }
            if facts.shipped.join("agents").join(&id).join("AGENT.md").exists() {
                continue;
            }
            let dir = agents_root.join(&id);
            let Some(file) = definition_file(&dir) else { continue };
            let (frontmatter, body) = read_document(&read_text(&file));
            // A split bot is judged on its bots/ copy, before the explicit-kind skip: an interrupted restore may
            // already have stamped agents/<id> while bots/<id> is still there, and the next run must finish it.
            if split.is_some() && bots_root.join(&id).exists() {
                let bot_kind = definition_file(&bots_root.join(&id)).map(|bot_file| read_document(&read_text(&bot_file)).0.get("kind").cloned());
                if delegated.contains(&id) && !bot_kind.as_ref().is_some_and(|kind| truthy(kind.as_ref())) {
                    restore.push(id);
                }
                continue;
            }
            if truthy(frontmatter.get("kind")) {
                continue;
            }
            if split.as_ref().is_some_and(|split| strings(split.get("bots")).contains(&id)) {
                continue;
            }
            let bot = evidence_kind(facts, &id, frontmatter.get("kind"), &manifest_of(&dir), &body).as_deref() == Some("bot");
            if !bot || delegated.contains(&id) {
                stamp.push(id);
            }
        }
        if !stamp.is_empty() || !restore.is_empty() {
            backup(lane);
        }
        for id in &stamp {
            if let Some(file) = definition_file(&agents_root.join(id)) {
                stamp_file(&file)?;
            }
        }
        // The bot's files (edited since the split) are the definition to keep; its route goes to the config.
        let mut restoring = Vec::new();
        for id in restore {
            let (source, target) = (bots_root.join(&id), agents_root.join(&id));
            copy_dir(&source, &target)?;
            let route = read_json(&source.join("agent.json")).and_then(|manifest| manifest.get("route").cloned());
            if let Some(mut manifest) = read_json(&target.join("agent.json")) {
                for key in KIND_STORE_ONLY_KEYS {
                    manifest.shift_remove(key);
                }
                write_plain_json(&target.join("agent.json"), &manifest)?;
            }
            restoring.push((id, complete_route(route.as_ref())));
        }
        stamp.sort();
        Ok(KindStage { stamped: stamp, restore: restoring, ..Default::default() })
    });
    match staged {
        Ok(Ok(stage)) => stage,
        Ok(Err(error)) => {
            tracing::warn!("[agent-kind] migration failed; it is retried next start: {error}");
            KindStage { failed: true, ..Default::default() }
        }
        Err(error) => {
            tracing::warn!("[agent-kind] migration failed; it is retried next start: {error}");
            KindStage { failed: true, ..Default::default() }
        }
    }
}

/// The second half of `migrateAgentKinds`, under the lock: for each restored bot the split manifest forgets it, its
/// `agents/<id>` is stamped and only then is `bots/<id>` deleted, which is what ends the restore; then the record is
/// written.
pub fn finish_kind_stamp(lane: &InLane<DurabilityIo>, data: &Path, stage: &KindStage) -> KindReport {
    let opts = state::LockOpts { timeout: Some(LOCK_WAIT), ..Default::default() };
    let done = state::with_lock(lane, &data.join(LOCK_FILE), &opts, || -> io::Result<KindReport> {
        let (agents_root, bots_root) = (data.join("agents"), data.join(BOTS_DIR));
        let mut split = read_manifest_now(&bots_root);
        let mut restored = Vec::new();
        for (id, _) in &stage.restore {
            if let Some(split) = split.as_mut() {
                let mut copies = split.get("copies").and_then(Value::as_object).cloned().unwrap_or_default();
                copies.shift_remove(id);
                let bots: Vec<String> = strings(split.get("bots")).into_iter().filter(|bot| bot != id).collect();
                split.insert("bots".into(), Value::from(bots));
                split.insert("copies".into(), Value::Object(copies));
                write_json(lane, &bots_root.join(MANIFEST), &Value::Object(split.clone()))?;
            }
            if let Some(file) = definition_file(&agents_root.join(id)) {
                stamp_file(&file)?;
            }
            remove_best_effort(&bots_root.join(id));
            restored.push(id.clone());
        }
        restored.sort();
        let record = serde_json::json!({ "version": KIND_VERSION, "completedAt": iso_now(), "stamped": stage.stamped, "restored": restored });
        write_json(lane, &data.join(KIND_RECORD), &record)?;
        Ok(KindReport { stamped: stage.stamped.clone(), restored, ..Default::default() })
    });
    match done {
        Ok(Ok(report)) => report,
        Ok(Err(error)) => {
            tracing::warn!("[agent-kind] migration failed; it is retried next start: {error}");
            KindReport { failed: true, ..Default::default() }
        }
        Err(error) => {
            tracing::warn!("[agent-kind] migration failed; it is retried next start: {error}");
            KindReport { failed: true, ..Default::default() }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lane() -> mixdog_rt::DurabilityIo {
        mixdog_rt::testing::tokens().durability_io
    }

    #[test]
    fn the_marker_goes_into_the_front_matter_and_keeps_every_other_line() {
        assert_eq!(with_agent_kind_marker("---\nname: a\n---\nBody\n"), "---\nname: a\nkind: agent\n---\nBody\n");
        assert_eq!(with_agent_kind_marker("---\nkind: bot\nname: a\n---\nBody"), "---\nkind: agent\nname: a\n---\nBody");
        assert_eq!(with_agent_kind_marker("---\r\nname: a\r\n---\r\nBody\r\n"), "---\r\nname: a\r\nkind: agent\r\n---\r\nBody\r\n");
        assert_eq!(with_agent_kind_marker("Body only\n"), "---\nkind: agent\n---\n\nBody only\n");
    }

    #[test]
    fn a_leftover_folder_is_read_by_its_name() {
        assert_eq!(leftover(".bob.12-345.staging"), Some(("bob", "12-345", "staging")));
        assert_eq!(leftover(".a.b.9-1.old"), Some(("a.b", "9-1", "old")));
        assert_eq!(leftover(".bob.old"), None);
        assert_eq!(leftover("bob"), None);
    }

    #[test]
    fn the_iso_time_matches_to_iso_string() {
        assert_eq!(chrono_like_iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(chrono_like_iso(1_700_000_000_123), "2023-11-14T22:13:20.123Z");
    }

    #[allow(clippy::disallowed_methods, reason = "test setup writes a profile")]
    fn agent(data: &Path, id: &str, text: &str, manifest: &str) {
        let dir = data.join("agents").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("AGENT.md"), text).unwrap();
        std::fs::write(dir.join("agent.json"), manifest).unwrap();
    }

    async fn run_on<R: Send + 'static>(job: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> R {
        mixdog_core_base::support::on_lane(lane(), &mixdog_rt::CancellationToken::new(), job).await.unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_split_copies_a_bot_once_and_leaves_the_original_and_a_workflow_agent() {
        let data = tempfile::tempdir().unwrap();
        let path = data.path().to_path_buf();
        let bot_body = "Hi\n- Help the user in a natural, friendly conversation, in the language they write in.\n- Ask a short question when a request is unclear, and say plainly when something is outside what you do.\n- Keep replies as short or as detailed as the moment needs.\n";
        agent(&path, "buddy", &format!("---\nname: buddy\n---\n{bot_body}"), "{\"avatar\":{\"x\":1}}");
        agent(&path, "worker-x", "---\nname: wx\n---\nDo work.\n", "{}");
        let mut facts = Facts { shipped: path.join("shipped"), ..Default::default() };
        facts.routes.insert("buddy".into(), serde_json::json!({ "provider": "p", "model": "m" }));
        let backups = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = backups.clone();
        let (dir, with) = (path.clone(), facts.clone());
        let report = run_on(move |lane| migrate_bots_to_own_store(lane, &dir, &with, &|_| {
            counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }))
        .await;
        assert_eq!(report.bots, ["buddy"]);
        assert_eq!(report.changed, ["buddy"]);
        assert_eq!(backups.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(path.join("agents/buddy/AGENT.md").exists(), "the original stays");
        assert!(!path.join("bots/worker-x").exists());
        let copied = read_json(&path.join("bots/buddy/agent.json")).unwrap();
        assert_eq!(copied["route"]["model"], "m");
        let manifest = read_json(&path.join("bots/migration.json")).unwrap();
        assert_eq!(manifest["version"], 1);
        assert_eq!(manifest["bots"], serde_json::json!(["buddy"]));
        // A second start changes nothing and makes no backup.
        let (dir, with) = (path.clone(), facts);
        let again = run_on(move |lane| migrate_bots_to_own_store(lane, &dir, &with, &|_| unreachable!("nothing is copied"))).await;
        assert!(again.skipped);
        assert_eq!(again.bots, ["buddy"]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_kind_stamp_marks_a_workflow_agent_and_runs_once() {
        let data = tempfile::tempdir().unwrap();
        let path = data.path().to_path_buf();
        agent(&path, "measurer", "---\nname: m\n---\nMeasure.\n", "{}");
        agent(&path, "greeted-bot", "---\nname: g\n---\nHello.\n", "{}");
        agent(&path, "marked", "---\nkind: bot\n---\nHello.\n", "{}");
        let mut facts = Facts { shipped: path.join("shipped"), ..Default::default() };
        facts.greeted.insert("greeted-bot".into());
        let (dir, with) = (path.clone(), facts.clone());
        let report = run_on(move |lane| {
            let stage = stamp_agent_kinds(lane, &dir, &with, &|_| {});
            assert!(stage.restore.is_empty());
            finish_kind_stamp(lane, &dir, &stage)
        })
        .await;
        assert_eq!(report.stamped, ["measurer"]);
        assert!(read_text(&path.join("agents/measurer/AGENT.md")).contains("kind: agent"));
        assert!(!read_text(&path.join("agents/greeted-bot/AGENT.md")).contains("kind:"));
        assert!(read_text(&path.join("agents/marked/AGENT.md")).contains("kind: bot"));
        let (dir, with) = (path.clone(), facts);
        let again = run_on(move |lane| stamp_agent_kinds(lane, &dir, &with, &|_| unreachable!("it ran already"))).await;
        assert!(again.skipped);
    }
}
