//! Repair the connection-store root before its readers open. Profile generations 2/3 publish to `desktop/`, while the
//! composed stores use `userdata/`. Current files (even empty/corrupt/backup-only families) are authoritative: there are no
//! deletion tombstones with which to safely union the two lists. Both families are retained, with immutable recovery copies.
//! This uses the migration's durable publication, hashes, private file creation and per-step supplemental journal pattern.
//! It never changes profile-gen.json or deletes an original. Call after profile adoption, before composing connection stores.

use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use crate::durable;
use crate::error::{Blocked, Result};
use super::fsx;

pub const MARKER: &str = "migration/connections-adoption.json";
pub const RECOVERY: &str = "migration/connections-adoption/recovery";
const STAGE: &str = "migration/connections-adoption/stage";
const VERSION: u32 = 1;
pub const FILES: [&str; 4] = ["ssh-hosts.json", "port-forwards.json", "remote-hosts.json", "server-windows.json"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Root { Desktop, Userdata }
impl Root {
    fn name(self) -> &'static str { match self { Self::Desktop => "desktop", Self::Userdata => "userdata" } }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Copy {
    root: Root,
    file: String,
    size: u64,
    sha256: String,
    archived: bool,
    published: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Family {
    file: String,
    current_authoritative: bool,
    settled: bool,
    copies: Vec<Copy>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal { version: u32, complete: bool, families: Vec<Family> }

fn conflict(path: &Path) -> Blocked {
    Blocked::TargetConflict { key: "connections-adoption".into(), path: path.to_path_buf() }
}
fn regular(path: &Path) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() => Ok(true),
        Ok(_) => Err(conflict(path)), // Never follow a link or replace a directory.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(Blocked::io("stat", path, error)),
    }
}
fn names(data: &Path, root: Root, file: &str) -> Result<Vec<String>> {
    let mut found = Vec::new();
    for (name, _) in durable::list_dir(&data.join(root.name()))? {
        if name == file || name == format!("{file}.bak") || name.starts_with(&format!("{file}.corrupt-")) {
            regular(&data.join(root.name()).join(&name))?;
            found.push(name);
        }
    }
    found.sort();
    Ok(found)
}
fn plan(data: &Path) -> Result<Journal> {
    let mut families = Vec::new();
    for file in FILES { families.push(plan_family(data, file)?); }
    Ok(Journal { version: VERSION, complete: false, families })
}
fn plan_family(data: &Path, file: &str) -> Result<Family> {
    let current = names(data, Root::Userdata, file)?;
    let mut copies = Vec::new();
    for (root, names) in [(Root::Desktop, names(data, Root::Desktop, file)?), (Root::Userdata, current.clone())] {
        for file in names {
            let (size, sha256) = durable::hash_file(&data.join(root.name()).join(&file))?;
            copies.push(Copy { root, file, size, sha256, archived: false, published: false });
        }
    }
    Ok(Family { file: file.into(), current_authoritative: !current.is_empty(), settled: false, copies })
}
fn save(data: &Path, journal: &Journal) -> Result<()> {
    durable::publish_file(&data.join(MARKER), &serde_json::to_vec(journal).expect("journal serializes"))
}
fn validate(journal: &Journal) -> Result<()> {
    if journal.version != VERSION || journal.families.len() != FILES.len() { return Err(Blocked::journal("unsupported connections adoption plan")); }
    for (family, expected) in journal.families.iter().zip(FILES) {
        if family.file != expected { return Err(Blocked::journal("invalid connections adoption family")); }
        let mut seen = std::collections::BTreeSet::new();
        for copy in &family.copies {
            let name = &copy.file;
            if name.chars().any(|c| matches!(c, '/' | '\\' | ':')) || !(name == expected || name == &format!("{expected}.bak") || name.starts_with(&format!("{expected}.corrupt-")))
                || copy.sha256.len() != 64 || !copy.sha256.bytes().all(|b| b.is_ascii_hexdigit())
                || !seen.insert((copy.root.name(), name)) {
                return Err(Blocked::journal("invalid connections adoption source"));
            }
        }
        if family.current_authoritative != family.copies.iter().any(|copy| copy.root == Root::Userdata) {
            return Err(Blocked::journal("connections adoption authority does not match its evidence"));
        }
        if (family.settled && family.copies.iter().any(|copy| !copy.archived))
            || (journal.complete && !family.copies.is_empty() && !family.settled) {
            return Err(Blocked::journal("connections adoption completion precedes retained evidence"));
        }
    }
    Ok(())
}
fn matches(path: &Path, copy: &Copy) -> Result<bool> {
    Ok(regular(path)? && durable::hash_file(path)? == (copy.size, copy.sha256.clone()))
}
fn verify(path: &Path, copy: &Copy) -> Result<()> {
    if matches(path, copy)? { Ok(()) } else { Err(Blocked::SourceChanged { path: path.to_path_buf() }) }
}
fn private(copy: &Copy) -> bool { copy.file.starts_with("remote-hosts.json") }
fn verify_archive(path: &Path, copy: &Copy) -> Result<()> {
    verify(path, copy)?;
    if private(copy) && !fsx::is_owner_only(path).map_err(|error| Blocked::io("access", path, error))? { return Err(conflict(path)); }
    Ok(())
}

// A synced stage and target are on the same filesystem. A hard link publishes a complete file atomically WITHOUT replacing
// an existing target (rename_replace would race a newly appeared authoritative file). A live target never links to its recovery copy.
fn publish_new(stage: &Path, target: &Path, copy: &Copy) -> Result<()> {
    if regular(target)? {
        if !matches(target, copy)? { return Err(conflict(target)); }
    } else {
        if let Some(parent) = target.parent() { durable::create_dir_all(parent)?; }
        durable::step(durable::Step::Rename, target, &[]);
        std::fs::hard_link(stage, target).map_err(|error| Blocked::io("publish", target, error))?;
        durable::sync_dir(target.parent().expect("target parent"))?;
    }
    if private(copy) && !fsx::is_owner_only(target).map_err(|error| Blocked::io("access", target, error))? {
        return Err(conflict(target));
    }
    Ok(())
}
fn copy_to_stage(data: &Path, from: &Path, copy: &Copy) -> Result<PathBuf> {
    let stage = data.join(STAGE).join(copy.root.name()).join(&copy.file);
    if let Some(parent) = stage.parent() { durable::create_dir_all(parent)?; }
    verify(from, copy)?;
    let got = fsx::copy_new(from, &stage, private(copy)).map_err(|error| Blocked::io("stage", &stage, error))?;
    if got != (copy.size, copy.sha256.clone()) { return Err(Blocked::SourceChanged { path: from.to_path_buf() }); }
    Ok(stage)
}

/// One-time repair. Must run under the daemon's migration ownership before connection stores are opened.
pub fn run(data: &Path) -> Result<()> { run_with(data, &|_| Ok(())) }

/// Same fault seam as the profile supplement: tests cut a durable step, then resume the recorded plan.
pub fn run_with(data: &Path, fault: &dyn Fn(&str) -> Result<()>) -> Result<()> {
    let mut journal = match durable::read_optional(&data.join(MARKER))? {
        Some(bytes) => serde_json::from_slice::<Journal>(&bytes).map_err(|error| Blocked::journal(format!("connections-adoption: {error}")))?,
        None => {
            let journal = plan(data)?;
            // A profileless first boot must not suppress adoption of a desktop profile named on a later boot.
            if journal.families.iter().all(|family| family.copies.is_empty()) { return Ok(()); }
            fault("connections-adoption:plan:before")?;
            save(data, &journal)?;
            journal
        }
    };
    validate(&journal)?;
    if journal.complete {
        // Completion is durable before staging cleanup. A process can stop during any removal,
        // so a completed journal must resume cleanup before its otherwise-idempotent fast path.
        durable::remove_dir_all(&data.join(STAGE))?;
        // A first TUI boot can have current stores before an Electron profile is ever named. Only families with NO recorded
        // input may be added later; a settled family's later deletion must never reimport its retained originals.
        let mut extended = false;
        for old in &mut journal.families {
            if old.copies.is_empty() {
                let new = plan_family(data, &old.file)?;
                if !new.copies.is_empty() { *old = new; extended = true; }
            } else if old.current_authoritative && !old.copies.iter().any(|copy| copy.root == Root::Desktop) {
                // A later named profile can contribute losing legacy bytes to an already authoritative family. Archive them
                // without reconsidering that authority or reading/recreating its current file (which the user may have removed).
                for file in names(data, Root::Desktop, &old.file)? {
                    let (size, sha256) = durable::hash_file(&data.join("desktop").join(&file))?;
                    old.copies.push(Copy { root: Root::Desktop, file, size, sha256, archived: false, published: false });
                    old.settled = false;
                    extended = true;
                }
            }
        }
        if !extended { return Ok(()); }
        journal.complete = false;
        fault("connections-adoption:extend:before")?;
        save(data, &journal)?;
    }

    // Archive EVERY source family before any canonical publication. Originals are never removed, even on success.
    for family in 0..journal.families.len() {
        if journal.families[family].settled { continue; }
        for index in 0..journal.families[family].copies.len() {
            let copy = journal.families[family].copies[index].clone();
            let archive = data.join(RECOVERY).join(copy.root.name()).join(&copy.file);
            if copy.archived { verify_archive(&archive, &copy)?; continue; }
            fault(&format!("connections-adoption:archive:{}:{}:before", copy.root.name(), copy.file))?;
            if !regular(&archive)? {
                let stage = copy_to_stage(data, &data.join(copy.root.name()).join(&copy.file), &copy)?;
                publish_new(&stage, &archive, &copy)?;
            }
            verify_archive(&archive, &copy)?;
            fault(&format!("connections-adoption:archive:{}:{}:after", copy.root.name(), copy.file))?;
            journal.families[family].copies[index].archived = true;
            save(data, &journal)?;
        }
    }
    for (family, file) in FILES.iter().enumerate() {
        if journal.families[family].settled || journal.families[family].copies.is_empty() { continue; }
        if journal.families[family].current_authoritative {
            journal.families[family].settled = true;
            save(data, &journal)?;
            continue;
        }
        let chosen = &journal.families[family];
        // Any new trace must be one of our already/partially published exact files; a concurrent write is never overwritten.
        for name in names(data, Root::Userdata, &chosen.file)? {
            let expected = chosen.copies.iter().find(|copy| copy.root == Root::Desktop && copy.file == name);
            if !matches!(expected, Some(copy) if matches(&data.join("userdata").join(&name), copy)?) {
                return Err(conflict(&data.join("userdata").join(name)));
            }
        }
        for index in 0..journal.families[family].copies.len() {
            let copy = journal.families[family].copies[index].clone();
            // Corruption evidence is retained, never promoted into a live store or used to fabricate a new main document.
            if copy.root != Root::Desktop || !(copy.file == *file || copy.file == format!("{file}.bak")) { continue; }
            let target = data.join("userdata").join(&copy.file);
            if copy.published { verify(&target, &copy)?; continue; }
            fault(&format!("connections-adoption:publish:{}:before", copy.file))?;
            let stage = copy_to_stage(data, &data.join(RECOVERY).join("desktop").join(&copy.file), &copy)?;
            publish_new(&stage, &target, &copy)?;
            verify(&target, &copy)?;
            fault(&format!("connections-adoption:publish:{}:after", copy.file))?;
            journal.families[family].copies[index].published = true;
            save(data, &journal)?;
        }
        journal.families[family].settled = true;
        save(data, &journal)?;
    }
    fault("connections-adoption:complete:before")?;
    journal.complete = true;
    save(data, &journal)?;
    durable::remove_dir_all(&data.join(STAGE))?;
    Ok(())
}

#[cfg(test)]
mod tests;
