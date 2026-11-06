//! The write side of the agent definitions: Node's `workflow-agents-api/agent-editor.mjs`
//! `saveAgentDefinition`, `deleteAgentDefinition` (the archive), `restoreAgentDefinition` and the
//! read behind `getAgentDefinition`, byte for byte as Node writes the files.
//!
//! Synchronous file work: the service gathers what the store rules need on an interactive job
//! (`plan_*`, which read through [`Folders`]), then writes on a durability job (`*_files`), so
//! no function here needs a lane proof of the other kind. Not ported: the avatar and connector
//! edits, PERSONA.md writes, `expectedRevision` and a route given with a save; a payload naming
//! one is refused instead of dropping it.
#![allow(clippy::disallowed_methods, reason = "lane job bodies: the service runs these functions on io lanes")]

use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;

use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_statefile as state;
use serde_json::Map;
use serde_json::Value;
use sha2::Digest as _;
use sha2::Sha256;

use super::avatar::AvatarUpdate;
use super::avatar::ImageWrite;
use super::avatar::avatar_update;
use super::avatar::is_image_file;
use super::avatar::normalize_agent_avatar;
use super::avatar::poster_file;
use super::avatar::shown;
use super::avatar::state_path;
use super::connectors::ApprovedToolChange;
use super::connectors::assert_not_widened;
use super::connectors::policy_input;
use super::files::DELETED_MARKER;
use super::files::FIXED_SLOTS;
use super::files::Folders;
use super::files::LEAD_ID;
use super::files::Lane;
use super::files::entry_file;
use super::files::entry_path;
use super::files::manifest_of;
use mixdog_core_config::config::bot_migration;
use mixdog_core_config::config::agent_routes::agent_editor_id;
use mixdog_core_config::workflow::ids::agent_id_from_name;
use mixdog_core_config::workflow::ids::available_workflow_id;
use mixdog_core_config::workflow::ids::clean;
use mixdog_core_config::workflow::ids::one_line;
use mixdog_core_config::workflow::pack::Definition;
use mixdog_core_config::workflow::pack::ShippedKind;
use mixdog_core_config::workflow::pack::absorb_kind_equal_to_shipped;
use mixdog_core_config::workflow::pack::read_text_safe;

pub(super) const PERSONA_FILE: &str = "PERSONA.md";
/// Written before a purge deletes the bot's routines.
const PURGING_MARKER: &str = ".purging";
/// The default entry's archive.
const ARCHIVED_AGENT_FILE: &str = "AGENT.md.archived";

fn is_fixed(id: &str) -> bool {
    FIXED_SLOTS.iter().any(|slot| slot.0 == id)
}

/// `DEFINITION_WRITE`: every definition file is atomic, keeps the replaced copy as `.bak`.
fn definition_write() -> state::Opts {
    state::Opts { backup: true, mode: 0o644, ..state::Opts::default() }
}

fn write_text(lane: &InLane<DurabilityIo>, file: &Path, text: &str, opts: &state::Opts) -> Result<(), String> {
    state::write_file(lane, file, text.as_bytes(), opts).map(drop).map_err(|error| error.to_string())
}

fn write_manifest(lane: &InLane<DurabilityIo>, file: &Path, manifest: &Map<String, Value>) -> Result<(), String> {
    state::write_json(lane, file, &Value::Object(manifest.clone()), &definition_write()).map(drop).map_err(|error| error.to_string())
}

/// `readManifestForUpdate`: `{}` when `agent.json` is missing; a damaged one gets its last good
/// copy back first, and with none it is refused and left alone.
fn read_manifest_for_update(lane: &InLane<DurabilityIo>, dir: &Path) -> Result<Map<String, Value>, String> {
    let file = dir.join("agent.json");
    let validate = |value: &Value| {
        if value.is_object() { Ok(()) } else { Err(state::Invalid::Damaged("not a JSON object".into())) }
    };
    let opts = state::Opts { keep_without_backup: true, mode: 0o644, ..state::Opts::default() };
    match state::read_json(lane, &file, Some(&validate), &opts).map_err(|error| error.to_string())? {
        Some(Value::Object(manifest)) => Ok(manifest),
        _ if !file.exists() => Ok(Map::new()),
        _ => Err(format!(
            "{} is damaged and has no good copy to restore; it was left untouched. Fix or delete the file, then save again",
            file.display()
        )),
    }
}

/// `setLeadConnectorPolicy(next)`: Mixy's `agent.json` takes the policy (`None` removes it),
/// every other key kept.
pub(super) fn set_lead_connectors(lane: &InLane<DurabilityIo>, dir: &Path, next: Option<Value>) -> Result<(), String> {
    let mut manifest = read_manifest_for_update(lane, dir)?;
    match next {
        Some(policy) => {
            manifest.insert("connectors".into(), policy);
        }
        None => {
            manifest.shift_remove("connectors");
        }
    }
    std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    write_manifest(lane, &dir.join("agent.json"), &manifest)
}

/// `assertManifestWritable(file)`: a read-only `agent.json` is a standing refusal, not a
/// transient lock; it is refused up front.
pub(super) fn assert_writable(file: &Path) -> Result<(), String> {
    let code = if cfg!(windows) { "EPERM" } else { "EACCES" };
    let refused = || format!("{} is not writable ({code}); make it writable, then save again", file.display());
    match std::fs::metadata(file) {
        Ok(meta) if meta.permissions().readonly() => Err(refused()),
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(refused()),
        _ => Ok(()),
    }
}

/// `hiddenManifest`: the keys the editor does not show.
fn hidden_manifest(mut manifest: Map<String, Value>) -> Map<String, Value> {
    for key in ["id", "name", "description", "entry"] {
        manifest.shift_remove(key);
    }
    manifest
}

/// `hiddenFrontmatter`: the frontmatter the editor does not show.
fn hidden_frontmatter(frontmatter: &Map<String, Value>) -> Map<String, Value> {
    let mut rest = frontmatter.clone();
    rest.shift_remove("name");
    rest.shift_remove("description");
    rest
}

/// `stableJson`: the pairs sorted by key, as JSON.
fn stable_json(map: &Map<String, Value>) -> String {
    let mut pairs: Vec<(&String, &Value)> = map.iter().collect();
    pairs.sort_by_key(|(key, _)| key.encode_utf16().collect::<Vec<u16>>());
    mixdog_js::json_stringify(&Value::Array(pairs.into_iter().map(|(key, value)| Value::Array(vec![Value::String(key.clone()), value.clone()])).collect()))
}

/// `serializeFrontmatterDoc`: `key: value` lines, null values left out.
fn frontmatter_doc(meta: &[(String, Value)], body: &str) -> String {
    let mut lines = vec!["---".to_owned()];
    for (key, value) in meta {
        if value.is_null() {
            continue;
        }
        lines.push(format!("{key}: {}", mixdog_js::value_to_string(value)));
    }
    lines.push("---".into());
    lines.push(String::new());
    format!("{}\n{}\n", lines.join("\n"), mixdog_js::js_trim(body))
}

fn remove_file(path: &Path) {
    let _ = std::fs::remove_file(path);
}

fn is_archived(dir: &Path) -> bool {
    dir.join(DELETED_MARKER).exists()
}

/// A purge of the agent is under way or was cut short: its marker with the definition archived
/// or already gone.
fn purge_pending(dir: &Path) -> bool {
    dir.join(PURGING_MARKER).exists() && (is_archived(dir) || !dir.join("AGENT.md").exists())
}

/// `leavesFolder(rel)`.
fn leaves_folder(rel: &Path) -> bool {
    use std::path::Component;
    rel.is_absolute() || matches!(rel.components().next(), Some(Component::ParentDir | Component::Prefix(_) | Component::RootDir))
}

/// `archivableEntry`: the entry named inside `dir` whose folder resolves inside too, else the
/// folder's `AGENT.md`.
fn archivable_entry(dir: &Path, entry: &Path) -> PathBuf {
    let inside = || -> Option<()> {
        let rel = entry.strip_prefix(dir).ok().filter(|rel| !rel.as_os_str().is_empty())?;
        if leaves_folder(rel) {
            return None;
        }
        let real_dir = std::fs::canonicalize(dir).ok()?;
        let real_parent = std::fs::canonicalize(entry.parent()?).ok()?;
        let within = real_parent.strip_prefix(&real_dir).ok()?;
        (!leaves_folder(within)).then_some(())
    };
    if inside().is_some() { entry.to_path_buf() } else { dir.join("AGENT.md") }
}

fn archived_entry(entry: &Path) -> PathBuf {
    let mut name = entry.as_os_str().to_owned();
    name.push(".archived");
    PathBuf::from(name)
}

/// What a save needs from the stores, read on an interactive job.
pub(super) struct SavePlan {
    pub id: String,
    name: String,
    description: String,
    /// The frontmatter of the definition in effect; `None` for an id with none (a new agent).
    current: Option<Map<String, Value>>,
    user_dir: PathBuf,
    user_has_file: bool,
    store_active: bool,
    migrated: bool,
}

/// `resolveSaveTarget` and the facts of the save.
/// `fixed` is the id the save was queued under: the target is resolved once, before queuing.
pub(super) fn plan_save(folders: &Folders, lane: &Lane, payload: &Map<String, Value>, fixed: Option<&str>) -> Result<SavePlan, String> {
    let given = agent_editor_id(&clean(payload.get("id")));
    if payload.contains_key("id") && given.is_empty() {
        return Err("agent id must contain letters/numbers (dashes and dots allowed)".into());
    }
    if !given.is_empty() && folders.hidden.contains(&given) {
        return Err(format!("agent \"{given}\" is internal and cannot be edited"));
    }
    let name = one_line(payload.get("name"));
    if name.is_empty() && given.is_empty() {
        return Err("agent name must not be empty".into());
    }
    let migration = bot_migration(lane, &folders.data);
    let store_active = migration.is_some();
    let migrated: HashSet<String> = migration
        .as_ref()
        .and_then(|m| m.get("bots"))
        .and_then(Value::as_array)
        .map(|bots| bots.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default();
    let id = if let Some(fixed) = fixed {
        fixed.to_owned()
    } else if given.is_empty() {
        available_workflow_id(&agent_id_from_name(&name), |candidate| {
            folders.load(lane, candidate).is_some()
                || is_archived(&folders.user_dir(lane, candidate))
                || migrated.contains(candidate)
                || (store_active
                    && (folders.data.join("agents").join(candidate).exists() || folders.data.join("bots").join(candidate).exists()))
        })
    } else {
        given
    };
    let current = folders.load(lane, &id).map(|loaded| loaded.definition.frontmatter);
    let user_dir = folders.user_dir(lane, &id);
    Ok(SavePlan {
        name,
        description: one_line(payload.get("description")),
        current,
        user_has_file: user_dir.join("AGENT.md").exists(),
        user_dir,
        store_active,
        migrated: migrated.contains(&id),
        id,
    })
}

/// What a save did, for the effects that follow it.
pub(super) struct SaveDone {
    pub existed: bool,
    /// Made anew under an archived agent's id: its kept route goes.
    pub reclaimed: bool,
}

/// `saveLocked`'s file half: the checks, then `AGENT.md` and `agent.json`.
pub(super) fn save_files(
    folders: &Folders,
    lane: &InLane<DurabilityIo>,
    plan: &SavePlan,
    payload: &Map<String, Value>,
    no_widen: Option<Option<&ApprovedToolChange>>,
    now: &dyn Fn() -> String,
) -> Result<SaveDone, String> {
    let id = &plan.id;
    let body = mixdog_js::js_trim(&match payload.get("body") {
        Some(value) if mixdog_core_config::workflow::ids::truthy(Some(value)) => mixdog_js::value_to_string(value),
        _ => String::new(),
    })
    .to_owned();
    if purge_pending(&plan.user_dir) {
        return Err(format!("agent \"{id}\" is being deleted for good; its id cannot be reused until that finishes"));
    }
    // Opt-in: without `expectedRevision` the last write wins.
    if let Some(expected) = payload.get("expectedRevision") {
        let source = if plan.user_has_file { plan.user_dir.clone() } else { folders.shipped_dir(id) };
        if mixdog_core_config::workflow::ids::js_string(expected) != revision(&source) {
            return Err(format!("AGENT_DEFINITION_CONFLICT: agent \"{id}\" changed since it was loaded"));
        }
    }
    let existed = plan.current.is_some();
    let reclaimed = !existed && is_archived(&plan.user_dir);
    let kind = match payload.get("kind") {
        None => None,
        Some(_) if existed => return Err("an agent's kind is set when it is created and cannot change".into()),
        Some(Value::String(kind)) if kind == "bot" || kind == "agent" => Some(kind.clone()),
        Some(_) => return Err("agent kind must be \"bot\", \"agent\" or absent".into()),
    };
    let name = if plan.name.is_empty() { id.clone() } else { plan.name.clone() };
    let shipped = folders.shipped_dir(id);
    let mut manifest = hidden_manifest(if plan.user_has_file {
        read_manifest_for_update(lane, &plan.user_dir)?
    } else {
        manifest_of(&shipped)
    });
    let data = &folders.data;
    let store_bot = !existed && kind.as_deref() == Some("bot") && plan.store_active;
    if !existed && plan.store_active {
        let taken = if store_bot {
            data.join("agents").join(id).exists()
        } else {
            data.join("bots").join(id).exists() || plan.migrated
        };
        if taken {
            return Err(format!("agent id \"{id}\" is already in use; pick another name"));
        }
    }
    let dir = if store_bot { data.join("bots").join(id) } else { plan.user_dir.clone() };
    let in_store = dir == data.join("bots").join(id);
    let update = apply_manifest_edits(&mut manifest, payload, &dir, no_widen)?;
    // PERSONA.md: written when given and non-empty, removed when given empty, untouched when absent.
    let persona = payload.get("persona").map(|value| {
        mixdog_js::js_trim(&if value.is_null() { String::new() } else { mixdog_js::value_to_string(value) }).to_owned()
    });
    let definition = Definition { name: name.clone(), description: plan.description.clone(), body: body.clone(), fields: Vec::new() };
    let absorbed = !in_store
        && persona.as_deref().is_none_or(str::is_empty)
        && stable_json(&manifest) == stable_json(&hidden_manifest(manifest_of(&shipped)))
        && absorb_kind_equal_to_shipped(
            &folders.shipped,
            data,
            &ShippedKind { dir: "agents", entry: "AGENT.md", files: &["AGENT.md", "agent.json"] },
            id,
            &definition,
            now,
        )
        .map_err(|error| error.to_string())?;
    if !absorbed {
        let mut extra = plan.current.as_ref().map(hidden_frontmatter).unwrap_or_default();
        if let Some(kind) = kind {
            extra.insert("kind".into(), Value::String(kind));
        }
        write_agent_files(lane, &dir, &definition, &extra, &manifest)?;
        match persona.as_deref() {
            Some("") => remove_file(&dir.join(PERSONA_FILE)),
            Some(text) => write_text(lane, &dir.join(PERSONA_FILE), &format!("{text}\n"), &definition_write())?,
            None => {}
        }
        // Only the images the manifest names stay.
        let writes = update.map(|update| update.writes).unwrap_or_default();
        sync_avatar_files(lane, &dir, manifest.get("avatar").and_then(normalize_agent_avatar).as_ref(), &writes)?;
    }
    Ok(SaveDone { existed, reclaimed })
}

/// `writeAgentFiles`.
fn write_agent_files(
    lane: &InLane<DurabilityIo>,
    dir: &Path,
    definition: &Definition,
    extra: &Map<String, Value>,
    manifest: &Map<String, Value>,
) -> Result<(), String> {
    let mut meta: Vec<(String, Value)> = vec![("name".into(), Value::String(definition.name.clone()))];
    if !definition.description.is_empty() {
        meta.push(("description".into(), Value::String(definition.description.clone())));
    }
    std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let mut front = meta.clone();
    for (key, value) in extra {
        match front.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = value.clone(),
            None => front.push((key.clone(), value.clone())),
        }
    }
    // Both are JavaScript objects there: integer-like keys come first, ascending.
    let front: Map<String, Value> = front.into_iter().collect();
    let front: Vec<(String, Value)> = mixdog_js::js_object_keys(&front).into_iter().map(|key| (key.clone(), front[key].clone())).collect();
    write_text(lane, &dir.join("AGENT.md"), &frontmatter_doc(&front, &definition.body), &definition_write())?;
    // loadAgentDefinition prefers the manifest for name/description.
    let mut json: Map<String, Value> = meta.into_iter().collect();
    for (key, value) in manifest {
        json.insert(key.clone(), value.clone());
    }
    let json: Map<String, Value> = mixdog_js::js_object_keys(&json).into_iter().map(|key| (key.clone(), json[key].clone())).collect();
    write_manifest(lane, &dir.join("agent.json"), &json)?;
    remove_file(&dir.join(PURGING_MARKER));
    remove_file(&dir.join(DELETED_MARKER));
    remove_file(&dir.join(ARCHIVED_AGENT_FILE));
    Ok(())
}

/// `applyManifestEdits`: a save's avatar and connectors applied to `manifest`; the avatar update
/// (its image writes) when the save gives one.
fn apply_manifest_edits(
    manifest: &mut Map<String, Value>,
    payload: &Map<String, Value>,
    dir: &Path,
    no_widen: Option<Option<&ApprovedToolChange>>,
) -> Result<Option<AvatarUpdate>, String> {
    // New custom images arrive as checked bytes, stored under content hashes.
    let update = payload.get("avatar").map(|value| avatar_update(value, dir)).transpose()?;
    match update.as_ref() {
        Some(AvatarUpdate { avatar: Some(avatar), .. }) => {
            manifest.insert("avatar".into(), avatar.clone());
        }
        Some(_) => {
            manifest.shift_remove("avatar");
        }
        None => {}
    }
    // Connectors: a policy replaces the saved one, null removes the field, absent leaves it.
    if let Some(value) = payload.get("connectors") {
        let connectors = policy_input(value)?;
        if let Some(approved) = no_widen {
            assert_not_widened(manifest.get("connectors"), connectors.as_ref(), approved)?;
        }
        match connectors {
            Some(policy) => {
                manifest.insert("connectors".into(), policy);
            }
            None => {
                manifest.shift_remove("connectors");
            }
        }
    }
    Ok(update)
}

/// `syncAvatarFiles`: writes the images of an update, then drops every avatar image the stored
/// avatar no longer names.
fn sync_avatar_files(lane: &InLane<DurabilityIo>, dir: &Path, avatar: Option<&Value>, writes: &[ImageWrite]) -> Result<(), String> {
    let image_opts = state::Opts { mode: 0o644, ..state::Opts::default() };
    for write in writes {
        std::fs::create_dir_all(dir.join("avatar")).map_err(|error| error.to_string())?;
        state::write_file(lane, &dir.join(&write.path), &write.bytes, &image_opts).map_err(|error| error.to_string())?;
    }
    let mut keep: HashSet<String> = HashSet::new();
    if let Some(states) = avatar.filter(|a| a["kind"] == "custom").and_then(|a| a["states"].as_object()) {
        for file in states.values().filter_map(Value::as_str) {
            keep.insert(state_path(file));
            keep.insert(state_path(&poster_file(file)));
        }
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_image_file(&name) && !keep.contains(&name) {
                remove_file(&entry.path());
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(dir.join("avatar")) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !keep.contains(&format!("avatar/{name}")) {
                remove_file(&entry.path());
            }
        }
    }
    Ok(())
}

/// What delete, restore and purge need, read on an interactive job.
#[derive(Clone)]
pub(super) struct LifecyclePlan {
    pub id: String,
    dir: PathBuf,
    shipped: PathBuf,
}

/// The start of `deleteUnlocked`: the refusals, with the folder to act on.
pub(super) fn plan_delete(folders: &Folders, lane: &Lane, agent_id: &str) -> Result<LifecyclePlan, String> {
    let id = agent_editor_id(agent_id);
    if id.is_empty() {
        return Err(format!("unknown agent \"{agent_id}\""));
    }
    if folders.hidden.contains(&id) {
        return Err(format!("agent \"{id}\" is internal and cannot be deleted"));
    }
    if !folders.has_user_file(lane, &id) {
        if is_fixed(&id) {
            return Err(format!("agent \"{id}\" has no user override to reset"));
        }
        if folders.load(lane, &id).is_none() {
            return Err(format!("agent \"{id}\" not found"));
        }
    }
    Ok(LifecyclePlan { dir: folders.user_dir(lane, &id), shipped: folders.shipped_dir(&id), id })
}

/// `deleteUnlocked`'s file half. A built-in override is removed; a custom agent is archived.
pub(super) fn delete_files(lane: &InLane<DurabilityIo>, plan: &LifecyclePlan) -> Result<(), String> {
    let dir = &plan.dir;
    if is_fixed(&plan.id) {
        return match std::fs::remove_dir_all(dir) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
            _ => Ok(()),
        };
    }
    let agent_file = dir.join("AGENT.md");
    let agent_archive = dir.join(ARCHIVED_AGENT_FILE);
    if agent_file.exists() && agent_archive.exists() {
        return Err(format!(
            "agent \"{}\" cannot be deleted: {} already exists; move or remove it first",
            plan.id,
            agent_archive.display()
        ));
    }
    let entry = archivable_entry(dir, &entry_path(dir, &manifest_of(dir)));
    std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    // A stray purge marker goes before any rename.
    remove_file(&dir.join(PURGING_MARKER));
    if agent_file.exists() {
        std::fs::rename(&agent_file, &agent_archive).map_err(|error| error.to_string())?;
    }
    if entry != agent_file && entry.exists() && !archived_entry(&entry).exists() {
        std::fs::rename(&entry, archived_entry(&entry)).map_err(|error| error.to_string())?;
    }
    write_text(lane, &dir.join(DELETED_MARKER), "deleted\n", &state::Opts::default())
}

/// The start of `restoreUnlocked`: the refusals, with the folder to act on.
pub(super) fn plan_restore(folders: &Folders, lane: &Lane, agent_id: &str) -> Result<LifecyclePlan, String> {
    let id = agent_editor_id(agent_id);
    if id.is_empty() || folders.hidden.contains(&id) || is_fixed(&id) {
        return Err(format!("unknown agent \"{agent_id}\""));
    }
    let dir = folders.user_dir(lane, &id);
    if !is_archived(&dir) {
        return Err(format!("agent \"{id}\" is not deleted"));
    }
    Ok(LifecyclePlan { dir, shipped: folders.shipped_dir(&id), id })
}

/// `restoreUnlocked`'s file half: the archived files moved back, the tombstone gone.
pub(super) fn restore_files(plan: &LifecyclePlan) -> Result<(), String> {
    let (id, dir) = (&plan.id, &plan.dir);
    // Its routines may already be gone: only the purge can finish.
    if dir.join(PURGING_MARKER).exists() {
        return Err(format!("agent \"{id}\" is being deleted for good and cannot be restored; delete it again to finish"));
    }
    let agent_file = dir.join("AGENT.md");
    let entry = archivable_entry(dir, &entry_path(dir, &manifest_of(dir)));
    let mut moves = vec![(dir.join(ARCHIVED_AGENT_FILE), agent_file.clone())];
    if entry != agent_file {
        moves.push((archived_entry(&entry), entry));
    }
    let kept: Vec<&(PathBuf, PathBuf)> = moves.iter().filter(|(from, _)| from.exists()).collect();
    if kept.is_empty() && !plan.shipped.join("AGENT.md").exists() {
        return Err(format!("agent \"{id}\" was deleted before deleted agents were kept, so it cannot be restored"));
    }
    let free: Vec<&&(PathBuf, PathBuf)> = kept.iter().filter(|(_, to)| !to.exists()).collect();
    if !kept.is_empty() && free.is_empty() {
        return Err(format!("agent \"{id}\" cannot be restored: {} already exists; move or remove it first", kept[0].1.display()));
    }
    for (from, to) in free.into_iter().map(|pair| &**pair) {
        std::fs::rename(from, to).map_err(|error| error.to_string())?;
    }
    remove_file(&dir.join(DELETED_MARKER));
    Ok(())
}

/// The start of `purgeUnlocked`: the refusals, with the folder to act on.
pub(super) fn plan_purge(folders: &Folders, lane: &Lane, agent_id: &str) -> Result<LifecyclePlan, String> {
    let id = agent_editor_id(agent_id);
    if id.is_empty() || folders.hidden.contains(&id) || is_fixed(&id) {
        return Err(format!("unknown agent \"{agent_id}\""));
    }
    Ok(LifecyclePlan { dir: folders.user_dir(lane, &id), shipped: folders.shipped_dir(&id), id })
}

/// `purgeUnlocked`'s eligibility and the first write of `purgeFiles`: `false` when there is
/// nothing to purge (a live agent, or one deleted before archiving existed); otherwise the
/// purge marker is down, so a restore is refused from here on.
pub(super) fn purge_begin(lane: &InLane<DurabilityIo>, plan: &LifecyclePlan) -> Result<bool, String> {
    let dir = &plan.dir;
    // A marker beside a live definition is only removed.
    if !purge_pending(dir) {
        remove_file(&dir.join(PURGING_MARKER));
        if !is_archived(dir) {
            return Ok(false);
        }
    }
    write_text(lane, &dir.join(PURGING_MARKER), "purging\n", &state::Opts::default())?;
    Ok(true)
}

/// `purgeFiles`: everything the agent left goes.
pub(super) fn purge_remove(plan: &LifecyclePlan) -> Result<(), String> {
    match std::fs::remove_dir_all(&plan.dir) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
        _ => Ok(()),
    }
}

/// `purgeFiles` for a starter whose packaged copy still resolves: only its tombstone stays, so
/// the packaged copy stays gone.
pub(super) fn purge_tombstone(lane: &InLane<DurabilityIo>, plan: &LifecyclePlan) -> Result<(), String> {
    std::fs::create_dir_all(&plan.dir).map_err(|error| error.to_string())?;
    write_text(lane, &plan.dir.join(DELETED_MARKER), "deleted\n", &state::Opts::default())
}

/// `readAvatarImage(dir, file)`: one state image as a data URL, with its still first frame
/// (`""` when it has none).
fn avatar_image(dir: &Path, file: &str) -> Option<Value> {
    let read = |path: String| std::fs::read(dir.join(path)).ok().and_then(|bytes| shown(&bytes));
    let image = read(state_path(file))?;
    let poster = if image.animated && !is_image_file(file) { read(state_path(&poster_file(file))) } else { None };
    let poster = poster.filter(|poster| poster.still_png).map_or_else(String::new, |poster| poster.url);
    Some(serde_json::json!({ "file": file, "url": image.url, "poster": poster }))
}

/// `getAgentAvatarImage`: a custom avatar's images as data URLs by state, `Null` for an agent
/// that is internal or has no custom avatar, or no idle image.
pub(super) fn avatar_images(folders: &Folders, lane: &Lane, agent_id: &str) -> Value {
    let id = agent_editor_id(agent_id);
    if id.is_empty() || folders.hidden.contains(&id) {
        return Value::Null;
    }
    // Mixy's face lives in her identity folder, beside no AGENT.md.
    let lead = id == LEAD_ID;
    let dir = if lead { folders.identity_dir(lane) } else { folders.user_dir(lane, &id) };
    // An archived agent's face stays readable for its archived chat.
    let archived = !lead && is_archived(&dir);
    let avatar = if lead || archived {
        manifest_of(&dir).get("avatar").and_then(normalize_agent_avatar).unwrap_or(Value::Null)
    } else {
        folders.avatar_of(lane, &id)
    };
    if avatar["kind"] != "custom" || (!lead && !archived && !folders.has_user_file(lane, &id)) {
        return Value::Null;
    }
    let mut states = Map::new();
    for (state, file) in avatar["states"].as_object().into_iter().flatten() {
        if let Some(image) = file.as_str().and_then(|file| avatar_image(&dir, file)) {
            states.insert(state.clone(), image);
        }
    }
    if states.contains_key("idle") { serde_json::json!({ "states": states }) } else { Value::Null }
}

/// What `getAgentDefinition` reads from the files besides the definition and the routes.
pub(super) struct ViewFacts {
    pub user_override: bool,
    /// The user copy's entry file, editable in place.
    pub path: Option<String>,
    pub avatar: Value,
    pub persona: String,
    pub revision: String,
}

/// The first half of `getAgentDefinition`: the refusals before the definition is read.
pub(super) fn view_id(folders: &Folders, agent_id: &str) -> Result<String, String> {
    let id = agent_editor_id(agent_id);
    if id.is_empty() {
        return Err(format!("unknown agent \"{agent_id}\""));
    }
    if folders.hidden.contains(&id) {
        return Err(format!("agent \"{id}\" is internal and cannot be edited"));
    }
    Ok(id)
}

/// `definitionDirRevision`: a hash of the three files an editor writes.
fn revision(dir: &Path) -> String {
    let manifest = manifest_of(dir);
    let entry = entry_file(&manifest);
    let mut hash = Sha256::new();
    for (name, file) in [
        ("agent.json".to_owned(), dir.join("agent.json")),
        (entry.clone(), entry_path(dir, &manifest)),
        (PERSONA_FILE.to_owned(), dir.join(PERSONA_FILE)),
    ] {
        hash.update(format!("{name}\0").as_bytes());
        match std::fs::read(&file) {
            Ok(bytes) => hash.update(&bytes),
            Err(_) => hash.update("\u{1}absent".as_bytes()),
        }
        hash.update(b"\0");
    }
    hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect::<String>()[..24].to_owned()
}

/// The file facts of `getAgentDefinition`.
pub(super) fn view_facts(folders: &Folders, lane: &Lane, id: &str) -> ViewFacts {
    let user_dir = folders.user_dir(lane, id);
    let user_override = user_dir.join("AGENT.md").exists();
    let source = if user_override { user_dir.clone() } else { folders.shipped_dir(id) };
    let manifest = manifest_of(&source);
    let path = user_override
        .then(|| entry_path(&user_dir, &manifest_of(&user_dir)))
        .filter(|entry| {
            let (Ok(real_dir), Ok(real_entry)) = (std::fs::canonicalize(&user_dir), std::fs::canonicalize(entry)) else { return false };
            real_entry.strip_prefix(&real_dir).is_ok_and(|rel| !leaves_folder(rel))
        })
        .map(|entry| entry.to_string_lossy().into_owned());
    ViewFacts {
        user_override,
        path,
        avatar: manifest.get("avatar").and_then(normalize_agent_avatar).unwrap_or(Value::Null),
        persona: read_text_safe(&source.join(PERSONA_FILE)),
        revision: revision(&source),
    }
}
