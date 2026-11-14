//! Generation 2 of the desktop-profile move: the files a profile holds that the first pass did not list (the saved SSH
//! hosts, their port forwards, the paired PCs, the server windows to restore) move from `<P>` to `<D>/desktop/` once the
//! first pass has completed with a profile, in the same start or a later one.
//!
//! The pass is journaled in `migration/profile-gen.json` (one file, republished after every item step): an item goes
//! planned -> staged (copied, hashed) -> published (renamed into `<D>`) -> disposed (source removed), and a crash at any
//! point resumes from the recorded state. It is idempotent: a marker at generation 2 ends the call before anything is
//! read. Only the names in [`FILES`] (and their `.bak`, the copy the desktop's atomic writer keeps) are ever looked at.
//! A target that already holds other bytes is kept as it is; the source is then set aside as `<name>.superseded`
//! in the profile, never deleted, so nothing the person had is lost. Bytes are never changed; a secret is copied with
//! owner-only access created with the file.

use std::path::Path;
use std::path::PathBuf;

use mixdog_store::schema::migration::ItemKind;
use mixdog_store::schema::migration::PROFILE_GEN_PATH;
use serde::Deserialize;
use serde::Serialize;

use super::fsx;
use crate::durable;
use crate::error::Blocked;
use crate::error::Result;
use crate::framework::MigrationRoots;

/// The generation this pass brings a profile to.
pub const GENERATION: u32 = 2;

/// Where the staged copies wait (outside `migration/stage`, which a first pass removes when it completes).
const STAGE_DIR: &str = "migration/profile-gen-stage";
const BACKUP_SUFFIX: &str = ".bak";
const SUPERSEDED_SUFFIX: &str = ".superseded";

struct File {
    name: &'static str,
    kind: ItemKind,
    /// Relative to `<D>`.
    target: &'static str,
    /// Credential-bearing: moved with owner-only access.
    secret: bool,
}

/// The whole source set of the pass. `window-state*.json`, `pane-layout.json`, `desktop-pet.json` and the vault files are
/// not here: they are never opened.
const FILES: &[File] = &[
    File { name: "ssh-hosts.json", kind: ItemKind::SshHosts, target: "desktop/ssh-hosts.json", secret: false },
    File { name: "port-forwards.json", kind: ItemKind::PortForwards, target: "desktop/port-forwards.json", secret: false },
    File { name: "remote-hosts.json", kind: ItemKind::RemoteHosts, target: "desktop/remote-hosts.json", secret: true },
    File { name: "server-windows.json", kind: ItemKind::ServerWindows, target: "desktop/server-windows.json", secret: false },
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum State {
    Planned,
    /// Copied into the stage and hashed.
    Staged,
    /// In `<D>` (or already there with the same bytes); the source is still in `<P>`.
    Published,
    /// The source is removed: the item moved.
    Disposed,
    /// `<D>` held other bytes and keeps them; the source was set aside in `<P>`.
    Superseded,
    /// The source was no longer there when the item came up.
    Gone,
}

impl State {
    fn done(self) -> bool {
        matches!(self, State::Disposed | State::Superseded | State::Gone)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Item {
    file: String,
    kind: ItemKind,
    target: String,
    sha256: String,
    size: u64,
    secret: bool,
    state: State,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Marker {
    generation: u32,
    profile: String,
    items: Vec<Item>,
}

/// What a call left: the generation the data dir is at, and the files in `<D>` this pass moved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupplementOutcome {
    pub generation: u32,
    /// Source file names (relative to the profile) whose bytes now stand at their target.
    pub moved: Vec<String>,
}

fn resolve(base: &Path, relative: &str) -> PathBuf {
    super::source::resolve(base, relative)
}

fn read_marker(path: &Path) -> Result<Option<Marker>> {
    match durable::read_optional(path)? {
        Some(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| Blocked::journal(format!("profile-gen.json: {e}"))),
        None => Ok(None),
    }
}

fn save(path: &Path, marker: &Marker) -> Result<()> {
    durable::publish_file(path, &serde_json::to_vec(marker).expect("marker encodes"))
}

/// A regular file at `path` (a directory, a link or nothing is not one).
fn regular(path: &Path) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata.is_file()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(Blocked::io("stat", path, error)),
    }
}

/// The items of a profile: each listed file and its `.bak`, when it is a regular file.
fn plan(profile: &Path) -> Result<Vec<Item>> {
    let mut items = Vec::new();
    for file in FILES {
        for suffix in ["", BACKUP_SUFFIX] {
            let name = format!("{}{suffix}", file.name);
            let path = resolve(profile, &name);
            if !regular(&path)? {
                continue;
            }
            let (size, sha256) = durable::hash_file(&path)?;
            items.push(Item {
                target: format!("{}{suffix}", file.target),
                file: name,
                kind: file.kind,
                sha256,
                size,
                secret: file.secret,
                state: State::Planned,
            });
        }
    }
    Ok(items)
}

/// Brings the profile named by `roots.profile` to generation 2; does nothing when no profile is named and no pass is under way.
pub fn run(roots: &MigrationRoots) -> Result<SupplementOutcome> {
    run_with(roots, &|_| Ok(()))
}

/// [`run`] with a fault seam: `fault(point)` is called before each step that changes the disk, and an error from it stops the pass there.
pub fn run_with(roots: &MigrationRoots, fault: &dyn Fn(&str) -> Result<()>) -> Result<SupplementOutcome> {
    let data = &roots.data;
    let marker_path = data.join(PROFILE_GEN_PATH);
    let mut marker = match read_marker(&marker_path)? {
        Some(marker) if marker.generation >= GENERATION => {
            return Ok(SupplementOutcome { generation: marker.generation, moved: Vec::new() });
        }
        // A pass under way continues with the profile it planned from, whatever the run names now.
        Some(marker) => marker,
        None => {
            let Some(profile) = roots.profile.as_deref() else {
                return Ok(SupplementOutcome { generation: 1, moved: Vec::new() });
            };
            let items = plan(profile)?;
            let marker = Marker {
                generation: if items.is_empty() { GENERATION } else { 1 },
                profile: profile.to_string_lossy().into_owned(),
                items,
            };
            fault("supplement:plan:before")?;
            save(&marker_path, &marker)?;
            marker
        }
    };
    let profile = PathBuf::from(&marker.profile);
    for index in 0..marker.items.len() {
        while !marker.items[index].state.done() {
            step(data, &profile, &marker_path, &mut marker, index, fault)?;
        }
    }
    if marker.generation < GENERATION {
        marker.generation = GENERATION;
        fault("supplement:done:before")?;
        save(&marker_path, &marker)?;
    }
    durable::remove_dir_all(&data.join(STAGE_DIR))?;
    let moved = marker
        .items
        .iter()
        .filter(|item| item.state == State::Disposed)
        .map(|item| item.file.clone())
        .collect();
    Ok(SupplementOutcome { generation: marker.generation, moved })
}

/// Takes one item one state forward and records it.
fn step(
    data: &Path,
    profile: &Path,
    marker_path: &Path,
    marker: &mut Marker,
    index: usize,
    fault: &dyn Fn(&str) -> Result<()>,
) -> Result<()> {
    let item = marker.items[index].clone();
    let source = resolve(profile, &item.file);
    let target = resolve(data, &item.target);
    let staged = resolve(&data.join(STAGE_DIR), &item.file);
    let next = match item.state {
        State::Planned => {
            if !regular(&source)? {
                marker.items[index].state = State::Gone;
                return save(marker_path, marker);
            }
            fault(&format!("supplement:stage:{}:before", item.file))?;
            let (size, sha256) = fsx::copy_new(&source, &staged, item.secret).map_err(|e| Blocked::io("write", &staged, e))?;
            // What was copied is what is moved, even when the file changed after it was planned.
            let item = &mut marker.items[index];
            item.size = size;
            item.sha256 = sha256;
            State::Staged
        }
        State::Staged => {
            fault(&format!("supplement:publish:{}:before", item.file))?;
            if regular(&target)? && durable::hash_file(&target)?.1 == item.sha256 {
                State::Published
            } else if std::fs::symlink_metadata(&target).is_ok() {
                // Something else stands there: it stays; what the profile held is set aside, not deleted.
                let mut aside = source.clone().into_os_string();
                aside.push(SUPERSEDED_SUFFIX);
                // A source already set aside by a run that was cut before it recorded it stays where it is.
                if regular(&source)? {
                    durable::durable_rename(&source, Path::new(&aside))?;
                }
                State::Superseded
            } else if regular(&staged)? {
                if let Some(parent) = target.parent() {
                    durable::create_dir_all(parent)?;
                }
                durable::durable_rename(&staged, &target)?;
                State::Published
            } else {
                // The stage is gone and nothing was published: copy again.
                State::Planned
            }
        }
        State::Published => {
            fault(&format!("supplement:delete:{}:before", item.file))?;
            // A source that changed since it was copied is given back, not deleted.
            durable::remove_if_planned(&source, item.size, &item.sha256)?;
            State::Disposed
        }
        State::Disposed | State::Superseded | State::Gone => return Ok(()),
    };
    marker.items[index].state = next;
    save(marker_path, marker)
}
