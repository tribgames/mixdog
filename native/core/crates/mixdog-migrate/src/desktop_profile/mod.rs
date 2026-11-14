//! The `desktopProfile` kind group of the one-time migration (SPEC §4.11): locating the
//! Electron profile `<P>`, planning its items, and converting, moving and verifying
//! them. It plugs into the item framework (`crate::framework`) as an `ItemDriver`; the
//! manifest, journal, state machine, disposal and quarantine are the framework's.
//!
//! Every file is read the way the desktop reads it: the same validation, the same
//! normalization (session titles included) and, for a damaged state file, the same
//! restore of its `.bak` (the damaged file is kept as an expected `carried_set_aside`).
//!
//! The session items take the desktop's per-session metadata from this driver
//! (`SessionMetaSource`).

// The migration is a sanctioned blocking-I/O home (RL §13): it runs once, before the runtime,
// on its own thread, reading the Electron profile and the state database directly.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "one-time migration: blocking std::fs and rusqlite on the migration thread"
)]

mod config_values;
mod error;
mod fsx;
mod jsvalue;
mod locate;
mod plan;
mod preserve;
mod session_metadata;
mod source;
mod state_tables;
pub mod supplement;
mod title;

#[cfg(test)]
mod tests;

use mixdog_store::schema::migration::Contract;
use mixdog_store::schema::migration::ItemKind;
use mixdog_store::schema::migration::KindGroup;
use mixdog_store::schema::migration::ManifestItem;
use mixdog_store::schema::migration::QuarantineCode;
use mixdog_store::schema::migration::StagedEntry;
use mixdog_store::schema::migration::StateTable;
use mixdog_store::schema::migration::Target;
use serde_json::Map;
use serde_json::Value;

pub use locate::USER_DATA_ENV;
pub use locate::desktop_profile_dir;
pub use locate::desktop_profile_dir_with;
pub use plan::SESSION_METADATA_KEY;
pub use session_metadata::MetaSet;
pub use session_metadata::ReadState;
pub use session_metadata::SESSION_METADATA_FILE;
pub use session_metadata::SessionMetadata;
pub use state_tables::ProjectRow;
pub use state_tables::RoomRow;

use error::ApplyError;
use error::Step;
use crate::error::Blocked;
use crate::error::Result;
use crate::framework::ItemContext;
use crate::framework::ItemDriver;
use crate::framework::MigrationRoots;
use crate::framework::SessionMetaSource;
use crate::framework::Staged as Stage;
use crate::framework::Verdict;
use crate::framework::Wave;
use crate::plan::PlanSink;

/// What a staged item will publish: the journal's `staged` entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Staged {
    pub output_sha256: String,
    pub replaced_surrogates: u64,
}

fn unhandled(item: &ManifestItem) -> ApplyError {
    ApplyError::quarantine(
        QuarantineCode::SchemaViolation,
        format!("{} has no conversion step", item.key.as_str()),
    )
}

/// The one source file of a single-file item.
fn single_source(item: &ManifestItem) -> Step<&mixdog_store::schema::migration::SourceFile> {
    match item.sources.as_slice() {
        [file] => Ok(file),
        _ => Err(ApplyError::quarantine(
            QuarantineCode::SchemaViolation,
            format!("{} does not have exactly one source", item.key.as_str()),
        )),
    }
}

fn profile_dir<'a>(cx: &'a ItemContext<'_>) -> Step<&'a std::path::Path> {
    cx.roots
        .profile
        .as_deref()
        .ok_or_else(|| Blocked::journal("a desktopProfile item without a profile root").into())
}

fn state_table(item: &ManifestItem) -> Step<StateTable> {
    match &item.target {
        Some(Target::StateTable { table }) => Ok(*table),
        _ => Err(unhandled(item)),
    }
}

/// Which step family converts or moves an item.
enum Family {
    State,
    Config,
    Preserve,
    SessionMetadata,
    /// A damaged file set aside while its `.bak` was restored.
    SetAside,
}

fn family_of(item: &ManifestItem) -> Step<Family> {
    match item.kind {
        ItemKind::DesktopProjects | ItemKind::AgentRooms => Ok(Family::State),
        ItemKind::AgentGreetings
        | ItemKind::NotificationPreferences
        | ItemKind::RetentionState
        | ItemKind::RemoteActivated
        | ItemKind::UnclassifiedWorkspace => Ok(Family::Config),
        ItemKind::RemoteAccessSettings
        | ItemKind::RemoteClients
        | ItemKind::RelayDevice
        | ItemKind::RelayDeviceRevocations
        | ItemKind::RelayE2ee
        | ItemKind::PairingToken
        | ItemKind::NativePush
        | ItemKind::PcAccessRevokes
        | ItemKind::SelectedFileGrants
        | ItemKind::EditorBackups
        | ItemKind::EditorRecovery
        | ItemKind::NewTaskReceipts => Ok(Family::Preserve),
        ItemKind::SessionMetadata => Ok(Family::SessionMetadata),
        ItemKind::SetAside => Ok(Family::SetAside),
        _ => Err(unhandled(item)),
    }
}

/// The framework's driver for `desktopProfile`.
#[derive(Default)]
pub struct DesktopProfileDriver {
    metadata: session_metadata::MetadataCache,
}

impl DesktopProfileDriver {
    pub fn new() -> Self {
        Self::default()
    }

    fn stage_step(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Step<Staged> {
        match family_of(item)? {
            Family::State => state_tables::stage(cx, item, state_table(item)?),
            Family::Config => config_values::stage(cx, item),
            Family::Preserve => preserve::stage(cx, item),
            Family::SessionMetadata => session_metadata::stage(cx, &self.metadata, item),
            Family::SetAside => Err(ApplyError::quarantine(
                QuarantineCode::CarriedSetAside,
                "damaged; the desktop reads the last good .bak instead and sets this file aside",
            )),
        }
    }

    fn publish_step(&self, cx: &ItemContext<'_>, item: &ManifestItem, staged: &StagedEntry) -> Step<()> {
        match family_of(item)? {
            Family::State => state_tables::publish(cx, item),
            Family::Config => config_values::publish(cx, item, staged.output_sha256.as_str()),
            Family::Preserve => preserve::publish(cx, item),
            // The session items write the `meta` records; this item records its own count.
            Family::SessionMetadata => session_metadata::publish(cx, &self.metadata, item),
            Family::SetAside => Ok(()),
        }
    }

    fn verify_step(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Step<mixdog_store::schema::bounded::Digest> {
        match family_of(item)? {
            Family::State => state_tables::verify(cx, item, state_table(item)?),
            Family::Config => config_values::verify(cx, item),
            Family::Preserve => preserve::verify(cx, item),
            Family::SessionMetadata => session_metadata::verify(cx, &self.metadata, item),
            Family::SetAside => Err(unhandled(item)),
        }
    }
}

impl ItemDriver for DesktopProfileDriver {
    fn plan(&self, roots: &MigrationRoots, sink: &mut PlanSink) -> Result<()> {
        match roots.profile.as_deref() {
            Some(profile) => plan::plan(profile, sink, false),
            None => Ok(()),
        }
    }

    fn plan_late(&self, roots: &MigrationRoots, sink: &mut PlanSink) -> Result<()> {
        match roots.profile.as_deref() {
            Some(profile) => plan::plan(profile, sink, true),
            None => Ok(()),
        }
    }

    fn owns(&self, item: &ManifestItem) -> bool {
        item.group == KindGroup::DesktopProfile
    }

    fn wave(&self, item: &ManifestItem) -> Wave {
        match family_of(item) {
            Ok(Family::State | Family::Config | Family::SessionMetadata) => Wave::Settings,
            _ => Wave::Stores,
        }
    }

    fn stage(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<Stage> {
        debug_assert_ne!(item.contract, Contract::Retire);
        match self.stage_step(cx, item) {
            Ok(staged) => Ok(Stage::Output {
                output_sha256: staged.output_sha256,
                replaced_surrogates: staged.replaced_surrogates,
            }),
            Err(ApplyError::Quarantine(failure)) => Ok(Stage::Quarantine {
                code: failure.code,
                detail: failure.detail,
            }),
            Err(ApplyError::Blocked(blocked)) => Err(blocked),
        }
    }

    fn publish(&self, cx: &ItemContext<'_>, item: &ManifestItem, staged: &StagedEntry) -> Result<()> {
        match self.publish_step(cx, item, staged) {
            Ok(()) => Ok(()),
            Err(ApplyError::Blocked(blocked)) => Err(blocked),
            Err(ApplyError::Quarantine(failure)) => Err(Blocked::journal(failure.detail)),
        }
    }

    fn verify(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<Verdict> {
        // Nothing in the data dir refers to a retired profile file (the desktop's own
        // state files are converted from their own items).
        if item.contract == Contract::Retire {
            return Ok(Verdict::Verified { digest: None });
        }
        match self.verify_step(cx, item) {
            Ok(digest) => Ok(Verdict::Verified { digest: Some(digest) }),
            Err(ApplyError::Quarantine(failure)) => Ok(Verdict::Quarantine {
                code: failure.code,
                detail: failure.detail,
            }),
            Err(ApplyError::Blocked(blocked)) => Err(blocked),
        }
    }

    fn dangling(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<u64> {
        if item.kind != ItemKind::SessionMetadata {
            return Ok(0);
        }
        match session_metadata::dangling(cx, item) {
            Ok(count) => Ok(count),
            Err(ApplyError::Blocked(blocked)) => Err(blocked),
            Err(ApplyError::Quarantine(failure)) => Err(Blocked::journal(failure.detail)),
        }
    }

    fn withdraw(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<()> {
        let outcome = match family_of(item) {
            Ok(Family::State) => state_tables::withdraw(cx, item),
            Ok(Family::Config) => config_values::withdraw(cx, item),
            Ok(Family::Preserve) => preserve::withdraw(cx, item),
            Ok(Family::SessionMetadata) => session_metadata::withdraw(cx, item),
            _ => Ok(()),
        };
        match outcome {
            Ok(()) => Ok(()),
            Err(ApplyError::Blocked(blocked)) => Err(blocked),
            Err(ApplyError::Quarantine(failure)) => Err(Blocked::journal(failure.detail)),
        }
    }

    /// Moved files are copies: the source is deleted at disposal.
    fn keeps_sources(&self, _item: &ManifestItem) -> bool {
        false
    }
}

impl SessionMetaSource for DesktopProfileDriver {
    fn session_meta(&self, cx: &ItemContext<'_>, session_id: &str) -> Result<Option<Map<String, Value>>> {
        match session_metadata::session_meta(cx, &self.metadata, session_id) {
            Ok(set) => Ok(set),
            Err(ApplyError::Blocked(blocked)) => Err(blocked),
            Err(ApplyError::Quarantine(failure)) => Err(Blocked::journal(failure.detail)),
        }
    }
}
