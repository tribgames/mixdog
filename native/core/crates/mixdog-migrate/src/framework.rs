//! The item framework every kind plugs into (SM §11.5, FORMAT.md §10): one manifest, one
//! journal, one state machine, one disposal and quarantine. A kind group supplies an
//! `ItemDriver`; the `Migrator` (`crate::run`) owns ordering, journaling, crash recovery,
//! disposal, quarantine and the completion marker.
//!
//! Driver contract:
//! - `plan` enumerates exactly its source set and adds items (and shared sources) to the
//!   `PlanSink`; it never writes.
//! - `stage` (convert and preserve contracts) writes output under
//!   `cx.stage_dir(key)` only, which the framework empties first; it must produce the
//!   same bytes on every run (SM §11.3.4). `Staged::Quarantine` ends the item.
//!   For retain items `stage` names the expected code.
//! - `publish` makes the staged output the target. It must accept a target it published
//!   itself in an earlier, interrupted run (self-identification, FORMAT.md §10.4) and
//!   answer `Blocked::TargetConflict` for any other existing target.
//! - `verify` reads the target back with a reader independent of the old-format readers
//!   and compares it with the source (retire items: proves nothing references them).
//! - Every step is idempotent: a resume re-enters the step the journal says is next.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_store::schema::blob::BLOB_DIR;
use mixdog_store::schema::bounded::Digest;
use mixdog_store::schema::migration::Contract;
use mixdog_store::schema::migration::ItemState;
use mixdog_store::schema::migration::Manifest;
use mixdog_store::schema::migration::ManifestItem;
use mixdog_store::schema::migration::QuarantineCode;
use mixdog_store::schema::migration::Root;
use mixdog_store::schema::migration::Roots;
use mixdog_store::schema::migration::STAGE_DIR;
use mixdog_store::schema::migration::SourceFile;
use mixdog_store::schema::migration::StagedEntry;
use mixdog_store::schema::migration::Target;
use serde_json::Map;
use serde_json::Value;

use crate::durable;
use crate::error::Blocked;
use crate::error::Result;
use crate::plan::PlanSink;
use crate::plan::escape_key;

/// `<D>`, `<H>` and `<P>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationRoots {
    pub data: PathBuf,
    pub home: PathBuf,
    pub profile: Option<PathBuf>,
}

impl MigrationRoots {
    pub fn root(&self, root: Root) -> Option<&Path> {
        match root {
            Root::Data => Some(&self.data),
            Root::Home => Some(&self.home),
            Root::Profile => self.profile.as_deref(),
        }
    }

    /// Absolute path of a root-relative `/`-separated path.
    pub fn resolve(&self, root: Root, rel: &str) -> Result<PathBuf> {
        let base = self
            .root(root)
            .ok_or_else(|| Blocked::journal(format!("{rel}: no {root:?} root")))?;
        Ok(rel.split('/').fold(base.to_path_buf(), |p, seg| p.join(seg)))
    }

    pub fn to_schema(&self) -> Roots {
        Roots {
            data: self.data.to_string_lossy().into_owned(),
            home: self.home.to_string_lossy().into_owned(),
            profile: self
                .profile
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
        }
    }
}

/// Processing order: every item of a wave reaches `verified` or `quarantined` before the
/// next wave starts. Within a wave items run in key order (sessions with bounded
/// parallelism), so items sharing a target file never interleave.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Wave {
    /// Preserved stores (settings first by key order), retire, retain, the ledger.
    Stores,
    /// Items that need verified settings (profile config keys, state tables, the record of the
    /// session metadata). None reads a migrated session, so they settle before the sessions do.
    Settings,
    /// Session items (CPU-bound conversion, bounded parallelism).
    Sessions,
    /// The index over every published session.
    Index,
}

impl Wave {
    /// Whether the core waits for this wave before it serves: everything but the sessions and their index, which a
    /// serving core takes in one by one ([`crate::run::Back`]).
    pub fn before_serving(self) -> bool {
        self <= Wave::Settings
    }
}

/// Outcome of `ItemDriver::stage`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Staged {
    Output {
        output_sha256: String,
        replaced_surrogates: u64,
    },
    Quarantine {
        code: QuarantineCode,
        detail: String,
    },
}

/// Outcome of `ItemDriver::verify`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Verified { digest: Option<Digest> },
    Quarantine { code: QuarantineCode, detail: String },
}

/// One kind group's planning, conversion and verification.
pub trait ItemDriver: Send + Sync {
    fn plan(&self, roots: &MigrationRoots, sink: &mut PlanSink) -> Result<()>;
    /// Plans the late pass: the migration already completed with no profile named, and `roots`
    /// names one now. Only what a profile adds is planned; the default plans nothing.
    fn plan_late(&self, _roots: &MigrationRoots, _sink: &mut PlanSink) -> Result<()> {
        Ok(())
    }
    /// Whether this driver handles `item` (by kind).
    fn owns(&self, item: &ManifestItem) -> bool;
    fn wave(&self, item: &ManifestItem) -> Wave;
    fn stage(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<Staged>;
    fn publish(&self, cx: &ItemContext<'_>, item: &ManifestItem, staged: &StagedEntry)
    -> Result<()>;
    fn verify(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<Verdict>;
    /// References of a verified item that name nothing (reported, never quarantined);
    /// recounted when `complete.json` is written.
    fn dangling(&self, _cx: &ItemContext<'_>, _item: &ManifestItem) -> Result<u64> {
        Ok(0)
    }
    /// Removes a published target before the item's sources move to quarantine.
    fn withdraw(&self, _cx: &ItemContext<'_>, _item: &ManifestItem) -> Result<()> {
        Ok(())
    }
    /// The header keys the conversion of session `session` takes from other kind groups ([`SessionMetaSource`]: the name a
    /// person gave it in the desktop, its archive mark), for a list row shown before the session is converted.
    fn listed_meta(&self, _cx: &ItemContext<'_>, _session: &str) -> Result<Map<String, Value>> {
        Ok(Map::new())
    }
    /// Whether disposal of a verified item keeps its sources (they are the target).
    fn keeps_sources(&self, item: &ManifestItem) -> bool {
        item.contract == Contract::Preserve || matches!(item.target, Some(Target::Ledger))
    }
}

/// Header keys another kind group sets on a migrated session (one `meta` frame each),
/// e.g. the desktop's per-session metadata (SPEC §4.11).
pub trait SessionMetaSource: Send + Sync {
    fn session_meta(
        &self,
        cx: &ItemContext<'_>,
        session_id: &str,
    ) -> Result<Option<Map<String, Value>>>;
}

/// Test seam: called with a point name before and after every journal append and
/// publication step; an error stops the run there as a kill would.
pub type FaultHook = Arc<dyn Fn(&str) -> Result<()> + Send + Sync>;

/// Status of a referenced blob, by hashing it (SM §11.6 `attachments`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BlobStatus {
    Ok,
    Dangling,
    Corrupt,
}

/// Blob statuses of one run (a blob is hashed once whichever item references it).
#[derive(Default)]
pub struct BlobStatuses(Mutex<HashMap<String, BlobStatus>>);

/// The migrated sessions as items of a later wave see them (SPEC §4.11): the session wave
/// is settled before `Wave::Index` starts.
pub trait SessionView {
    /// Whether `session/<id>` reached `verified`.
    fn is_migrated(&self, session_id: &str) -> bool;
    /// The folded header of a migrated session as published (`None` when not migrated).
    fn folded_header(&self, session_id: &str) -> Result<Option<Map<String, Value>>>;
}

impl SessionView for ItemContext<'_> {
    fn is_migrated(&self, session_id: &str) -> bool {
        self.state(&format!("session/{session_id}")) == Some(ItemState::Verified)
    }

    fn folded_header(&self, session_id: &str) -> Result<Option<Map<String, Value>>> {
        if !self.is_migrated(session_id) {
            return Ok(None);
        }
        let dir = self.roots.data.join("sessions").join(session_id);
        crate::session::target::read_session(self, &dir)
            .map(|folded| Some(folded.header))
            .map_err(|detail| Blocked::StoreSchema {
                key: format!("session/{session_id}"),
                detail,
            })
    }
}

/// What one item step sees.
pub struct ItemContext<'a> {
    pub roots: &'a MigrationRoots,
    pub manifest: &'a Manifest,
    pub manifest_sha256: &'a str,
    pub(crate) fault: Option<&'a FaultHook>,
    pub(crate) blobs: &'a BlobStatuses,
    /// Item states when the current wave started.
    pub(crate) states: &'a BTreeMap<String, ItemState>,
}

impl ItemContext<'_> {
    /// The journaled state of `key` when this wave started (earlier waves are settled).
    pub fn state(&self, key: &str) -> Option<ItemState> {
        self.states.get(key).copied()
    }

    /// Session ids whose item was verified in an earlier wave.
    pub fn verified_sessions(&self) -> impl Iterator<Item = &str> {
        self.states.iter().filter_map(|(k, s)| {
            (*s == ItemState::Verified)
                .then_some(())
                .and_then(|()| k.strip_prefix("session/"))
        })
    }

    /// `<D>/migration/stage/<escaped key>/`.
    pub fn stage_dir(&self, key: &str) -> PathBuf {
        self.roots.data.join(STAGE_DIR).join(escape_key(key))
    }

    pub fn source_path(&self, file: &SourceFile) -> Result<PathBuf> {
        self.roots.resolve(file.root, &file.path)
    }

    /// The bytes of a source, checked against its manifest size and hash.
    pub fn read_source(&self, file: &SourceFile) -> Result<Vec<u8>> {
        let path = self.source_path(file)?;
        let bytes = durable::read(&path)?;
        if bytes.len() as u64 != file.size || durable::sha256_hex(&bytes) != file.sha256 {
            return Err(Blocked::SourceChanged { path });
        }
        Ok(bytes)
    }

    /// A source opened for a streaming read: a session log is read this way, never whole. The
    /// caller reads what it needs, then `verify`s the handle against the manifest size and hash
    /// before it trusts anything it read.
    pub fn open_source(&self, file: &SourceFile) -> Result<durable::OpenFile> {
        durable::open_verified(&self.source_path(file)?, file.size, &file.sha256)
    }

    /// Shared sources `key` consumes, in manifest order.
    pub fn shared_for(&self, key: &str) -> Vec<&SourceFile> {
        self.manifest
            .shared
            .iter()
            .filter(|s| s.consumers.iter().any(|c| c == key))
            .map(|s| &s.file)
            .collect()
    }

    /// Whether the manifest has an item with this key.
    pub fn has_item(&self, key: &str) -> bool {
        self.manifest
            .items
            .binary_search_by(|i| i.key.as_str().cmp(key))
            .is_ok()
    }

    pub fn fault(&self, point: &str) -> Result<()> {
        match self.fault {
            Some(hook) => hook(point),
            None => Ok(()),
        }
    }

    /// `<D>/prompt-attachments/sha256/<ab>/<hex>`.
    pub fn blob_path(&self, hex: &str) -> PathBuf {
        self.roots.data.join(BLOB_DIR).join(&hex[..2]).join(hex)
    }

    /// Publishes `bytes` into the blob store (idempotent by content); returns its hex.
    pub fn put_blob(&self, bytes: &[u8]) -> Result<String> {
        let hex = durable::sha256_hex(bytes);
        let path = self.blob_path(&hex);
        if !durable::exists(&path)? {
            self.fault("blob:before")?;
            durable::publish_file(&path, bytes)?;
            self.fault("blob:after")?;
        }
        self.blobs.0.lock().expect("blob statuses").insert(hex.clone(), BlobStatus::Ok);
        Ok(hex)
    }

    /// Hashes the blob `hex` once per run.
    pub fn blob_status(&self, hex: &str) -> Result<BlobStatus> {
        if let Some(status) = self.blobs.0.lock().expect("blob statuses").get(hex) {
            return Ok(*status);
        }
        let path = self.blob_path(hex);
        let status = if !durable::exists(&path)? {
            BlobStatus::Dangling
        } else if durable::hash_file(&path)?.1 == hex {
            BlobStatus::Ok
        } else {
            BlobStatus::Corrupt
        };
        self.blobs
            .0
            .lock()
            .expect("blob statuses")
            .insert(hex.to_string(), status);
        Ok(status)
    }
}
