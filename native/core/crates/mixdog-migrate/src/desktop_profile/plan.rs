//! Planning the `desktopProfile` kind group (SPEC §4.11). The listed names are the whole
//! source set: any other file in `<P>` (Electron- and Chromium-owned state, browser
//! stores, `last-launch-version`, orphans) is never opened, listed or hashed.

use std::io;
use std::path::Path;

use mixdog_protocol::config::keys;
use mixdog_store::schema::migration::Contract;
use mixdog_store::schema::migration::ItemKind;
use mixdog_store::schema::migration::KindGroup;
use mixdog_store::schema::migration::ManifestItem;
use mixdog_store::schema::migration::Root;
use mixdog_store::schema::migration::SourceFile;
use mixdog_store::schema::migration::StateTable;
use mixdog_store::schema::migration::Target;

use super::config_values;
use super::preserve;
use super::session_metadata::SESSION_METADATA_FILE;
use super::source;
use super::state_tables;
use crate::error::Blocked;
use crate::error::Result;
use crate::plan::PlanSink;
use crate::plan::item;
use crate::plan::retain_key;
use crate::plan::retire_key;

/// The key of the item that applies the desktop's per-session metadata.
pub const SESSION_METADATA_KEY: &str = "desktopProfile/sessionMetadata";

/// Where a converted or preserved file lands.
enum Destination {
    State(StateTable),
    Config(&'static str),
    /// Relative to `<D>`.
    Data(&'static str),
}

/// What the desktop does with a damaged file: restore `<file>.bak` when the file fails
/// the reader's own validation (`readJsonState`), or keep no backup at all.
#[derive(Clone, Copy)]
enum Backup {
    /// The desktop keeps no usable `.bak`, or it is not a JSON state backup.
    None,
    /// `.bak` is retired with the file.
    Retire,
    /// `.bak` replaces a file that fails `Check`.
    Restore(Check),
}

/// The desktop reader's validation of a state file.
#[derive(Clone, Copy)]
enum Check {
    Projects,
    Rooms,
    Notifications,
    /// Any JSON.
    Json,
}

struct Kind {
    file: &'static str,
    kind: ItemKind,
    destination: Destination,
    /// Credential-bearing or written owner-only by the desktop.
    secret: bool,
    backup: Backup,
}

const fn kind(file: &'static str, kind: ItemKind, destination: Destination, secret: bool, backup: Backup) -> Kind {
    Kind {
        file,
        kind,
        destination,
        secret,
        backup,
    }
}

const FILE_KINDS: &[Kind] = &[
    kind("desktop-projects.json", ItemKind::DesktopProjects, Destination::State(StateTable::Projects), false, Backup::Restore(Check::Projects)),
    kind("agent-rooms.json", ItemKind::AgentRooms, Destination::State(StateTable::Rooms), false, Backup::Restore(Check::Rooms)),
    kind("agent-greetings.json", ItemKind::AgentGreetings, Destination::Config(keys::AGENTS_GREETED), false, Backup::None),
    kind("notification-preferences.json", ItemKind::NotificationPreferences, Destination::Config(keys::NOTIFICATIONS), false, Backup::Restore(Check::Notifications)),
    kind("session-auto-retention.json", ItemKind::RetentionState, Destination::Config(keys::DESKTOP_RETENTION_STATE), false, Backup::None),
    kind("remote-activated.json", ItemKind::RemoteActivated, Destination::Config(keys::REMOTE_ACTIVATED_AT), true, Backup::None),
    kind("remote-access-settings.json", ItemKind::RemoteAccessSettings, Destination::Data("remote/settings.json"), true, Backup::None),
    kind("remote-clients.json", ItemKind::RemoteClients, Destination::Data("remote/clients.json"), true, Backup::None),
    kind("relay-device.json", ItemKind::RelayDevice, Destination::Data("remote/device.json"), true, Backup::Restore(Check::Json)),
    kind("relay-device-revocations.json", ItemKind::RelayDeviceRevocations, Destination::Data("remote/device-revocations.json"), true, Backup::Restore(Check::Json)),
    kind("relay-e2ee.json", ItemKind::RelayE2ee, Destination::Data("remote/e2ee.json"), true, Backup::None),
    kind("remote-bridge.token", ItemKind::PairingToken, Destination::Data("remote/pairing-token"), true, Backup::Retire),
    kind("remote-native-push.json", ItemKind::NativePush, Destination::Data("remote/native-push.json"), true, Backup::None),
    kind("pc-access-revokes.json", ItemKind::PcAccessRevokes, Destination::Data("desktop/pc-access-revokes.json"), false, Backup::None),
    kind("selected-file-grants.json", ItemKind::SelectedFileGrants, Destination::Data("desktop/selected-file-grants.json"), true, Backup::None),
];

/// Retired as one item (`remote-push.json`: U-DS2, the store of the deleted direct push path).
const WEB_PUSH_FILE: &str = "remote-push.json";
const LLM_TITLE_LOG: &str = "llm-title.log";
const UNCLASSIFIED_WORKSPACE: &str = "workspace/unclassified";
/// Whole directories that are re-created by the core: every file in them retires.
const RETIRED_TREES: &[&str] = &[
    "new-task-receipts",
    "document-previews",
    "document-preview-pages",
    "shell-integration",
];
const BRIDGES_DIR: &str = "bridges";
const BRIDGE_SUFFIX: &str = "-bridge.json";

fn key_name(kind: ItemKind) -> String {
    match serde_json::to_value(kind) {
        Ok(serde_json::Value::String(name)) => name,
        other => unreachable!("an item kind serializes to a string, got {other:?}"),
    }
}

fn resolve(profile: &Path, relative: &str) -> std::path::PathBuf {
    source::resolve(profile, relative)
}

/// The source entry of `relative` when it is a regular file; absent otherwise.
fn source_file(profile: &Path, sink: &PlanSink, relative: &str, secret: bool) -> Result<Option<SourceFile>> {
    let path = resolve(profile, relative);
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() => sink.source(Root::Profile, relative, secret).map(Some),
        Ok(_) => Ok(None),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(Blocked::io("stat", &path, error)),
    }
}

/// Regular files under `relative`, as `relative/...` paths in byte order.
fn files_under(profile: &Path, relative: &str) -> Result<Vec<String>> {
    let mut found = Vec::new();
    for path in crate::durable::walk_files(&resolve(profile, relative))? {
        found.push(format!("{relative}/{path}"));
    }
    Ok(found)
}

fn sources(profile: &Path, sink: &PlanSink, paths: &[String], secret: bool) -> Result<Vec<SourceFile>> {
    let mut files = Vec::with_capacity(paths.len());
    for path in paths {
        files.extend(source_file(profile, sink, path, secret)?);
    }
    Ok(files)
}

fn kind_item(kind: ItemKind, contract: Contract, sources: Vec<SourceFile>, target: Option<Target>) -> Result<ManifestItem> {
    let key = format!("desktopProfile/{}", key_name(kind));
    item(&key, KindGroup::DesktopProfile, kind, contract, sources, target)
}

fn retire_item(file: SourceFile) -> Result<ManifestItem> {
    let key = retire_key(Root::Profile, &file.path);
    item(&key, KindGroup::DesktopProfile, ItemKind::Retired, Contract::Retire, vec![file], None)
}

/// A damaged file the desktop would have set aside: kept in quarantine as an expected
/// `carried_set_aside`, while its `.bak` is restored.
fn set_aside_item(file: SourceFile) -> Result<ManifestItem> {
    let key = retain_key(Root::Profile, &file.path);
    item(&key, KindGroup::DesktopProfile, ItemKind::SetAside, Contract::Retain, vec![file], None)
}

/// `.desktop-session-metadata.json.<24hex>.tmp`, an interrupted atomic write.
fn is_session_metadata_tmp(name: &str) -> bool {
    name.strip_prefix(".desktop-session-metadata.json.")
        .and_then(|rest| rest.strip_suffix(".tmp"))
        .is_some_and(|id| id.len() == 24 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
}

/// Whether the desktop's reader accepts `file` (it parses and passes the check).
fn usable(profile: &Path, file: &SourceFile, check: Check) -> Result<bool> {
    if file.size > source::MAX_CONVERTED_BYTES {
        return Ok(false);
    }
    let bytes = crate::durable::read(&resolve(profile, &file.path))?;
    let Ok(parsed) = source::parse_json(&bytes) else {
        return Ok(false);
    };
    Ok(match check {
        Check::Json => true,
        Check::Projects => state_tables::project_rows(&parsed.value).is_ok(),
        Check::Rooms => state_tables::room_rows(&parsed.value).is_ok(),
        Check::Notifications => config_values::notifications(&parsed.value).is_ok(),
    })
}

fn destination(kind: &Kind) -> (Contract, Target) {
    match &kind.destination {
        Destination::State(table) => (Contract::Convert, Target::StateTable { table: *table }),
        Destination::Config(key) => (Contract::Convert, Target::ConfigKey { key: (*key).to_owned() }),
        Destination::Data(path) => (
            Contract::Preserve,
            Target::File {
                root: Root::Data,
                path: (*path).to_owned(),
            },
        ),
    }
}

/// Adds the profile's items to `sink`. A missing profile adds nothing.
pub(super) fn plan(profile: &Path, sink: &mut PlanSink) -> Result<()> {
    let mut retired = Vec::new();
    let mut items = Vec::new();

    for kind in FILE_KINDS {
        let Some(file) = source_file(profile, sink, kind.file, kind.secret)? else {
            continue;
        };
        let backup = match kind.backup {
            Backup::None => None,
            Backup::Retire | Backup::Restore(_) => source_file(profile, sink, &format!("{}.bak", kind.file), kind.secret)?,
        };
        let (contract, target) = destination(kind);
        let restore = match (kind.backup, &backup) {
            (Backup::Restore(check), Some(backup)) => !usable(profile, &file, check)? && usable(profile, backup, check)?,
            _ => false,
        };
        if restore {
            // The desktop reads the last good copy and sets the damaged file aside.
            let backup = backup.expect("a restore has a backup");
            items.push(kind_item(kind.kind, contract, vec![backup], Some(target))?);
            items.push(set_aside_item(file)?);
        } else {
            items.push(kind_item(kind.kind, contract, vec![file], Some(target))?);
            retired.extend(backup);
        }
    }

    if let Some(file) = source_file(profile, sink, SESSION_METADATA_FILE, true)? {
        sink.add_shared(file, SESSION_METADATA_KEY);
        items.push(kind_item(ItemKind::SessionMetadata, Contract::Convert, Vec::new(), Some(Target::Sessions))?);
    }
    for (name, is_dir) in crate::durable::list_dir(profile)? {
        if !is_dir && is_session_metadata_tmp(&name) {
            retired.extend(source_file(profile, sink, &name, true)?);
        }
    }

    if let Some(file) = source_file(profile, sink, WEB_PUSH_FILE, true)? {
        items.push(kind_item(ItemKind::WebPush, Contract::Retire, vec![file], None)?);
    }

    for (kind, dir, secret, target) in [
        (ItemKind::EditorBackups, "editor-backups", true, "desktop/editor-backups"),
        (ItemKind::EditorRecovery, "editor-recovery", false, "desktop/editor-recovery"),
    ] {
        debug_assert_eq!(preserve::source_dir(kind), Some(dir));
        let files = sources(profile, sink, &files_under(profile, dir)?, secret)?;
        if !files.is_empty() {
            let target = Target::File {
                root: Root::Data,
                path: target.to_owned(),
            };
            items.push(kind_item(kind, Contract::Preserve, files, Some(target))?);
        }
    }

    if std::fs::symlink_metadata(resolve(profile, UNCLASSIFIED_WORKSPACE)).is_ok_and(|meta| meta.is_dir()) {
        let target = Target::ConfigKey {
            key: keys::DESKTOP_UNCLASSIFIED_WORKSPACE_ROOT.to_owned(),
        };
        items.push(kind_item(ItemKind::UnclassifiedWorkspace, Contract::Preserve, Vec::new(), Some(target))?);
    }

    retired.extend(source_file(profile, sink, LLM_TITLE_LOG, false)?);
    for tree in RETIRED_TREES {
        retired.extend(sources(profile, sink, &files_under(profile, tree)?, false)?);
    }
    let bridges: Vec<String> = files_under(profile, BRIDGES_DIR)?
        .into_iter()
        .filter(|path| path.matches('/').count() == 1 && path.ends_with(BRIDGE_SUFFIX))
        .collect();
    retired.extend(sources(profile, sink, &bridges, true)?);

    for file in retired {
        items.push(retire_item(file)?);
    }
    for item in items {
        sink.add_item(item)?;
    }
    Ok(())
}
