//! Item `index`: a fresh `index/store.sqlite` projected from every verified session
//! (SM §11.5 phase 3). The projection itself is the store's catalog writer
//! (`IndexProjector`, WP-STORE); this module builds it into the stage, publishes it by a
//! rename, and verifies it independently: every catalog row has `projected_offset` = the
//! size of its newest log file and `row_count` = the fold's row count.

// The migration is a sanctioned blocking-I/O home (RL §13): it runs once, before the
// runtime, on its own thread.
#![allow(
    clippy::disallowed_types,
    reason = "one-time migration: the index database read back directly on the migration thread"
)]

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use mixdog_store::schema::migration::Contract;
use mixdog_store::schema::migration::ItemKind;
use mixdog_store::schema::migration::KindGroup;
use mixdog_store::schema::migration::ManifestItem;
use mixdog_store::schema::migration::QuarantineCode;
use mixdog_store::schema::migration::StagedEntry;
use mixdog_store::schema::migration::Target;
use rusqlite::Connection;
use rusqlite::OpenFlags;

use crate::durable;
use crate::error::Blocked;
use crate::error::Result;
use crate::framework::ItemContext;
use crate::framework::ItemDriver;
use crate::framework::MigrationRoots;
use crate::framework::Staged;
use crate::framework::Verdict;
use crate::framework::Wave;
use crate::plan;
use crate::plan::PlanSink;
use crate::session::target;

pub const INDEX_PATH: &str = "index/store.sqlite";
pub const INDEX_KEY: &str = "index";
const STAGED_FILE: &str = "store.sqlite";

/// The store's catalog writer: projects the given sessions of `data` into a new index
/// database at `db` (absent before the call; closed, without WAL, after it).
pub trait IndexProjector: Send + Sync {
    fn project(&self, data: &Path, db: &Path, sessions: &[String]) -> std::result::Result<(), String>;

    /// The index a core is serving from, when the sessions convert behind one: the item then builds no database of its own.
    fn serving(&self) -> Option<&dyn ServingIndex> {
        None
    }
}

/// The open index of a serving core, which holds the database the item would otherwise publish.
pub trait ServingIndex: Send + Sync {
    /// Brings the published session `session` of `data` into the index; one it already holds is left as it is.
    fn adopt(&self, data: &Path, session: &str) -> std::result::Result<(), String>;
}

pub struct IndexDriver {
    projector: Arc<dyn IndexProjector>,
}

impl IndexDriver {
    pub fn new(projector: Arc<dyn IndexProjector>) -> Self {
        Self { projector }
    }
}

/// `(row_count, newest file size)` per session as the target reader folds it.
fn expected(cx: &ItemContext<'_>, sessions: &[String]) -> Result<BTreeMap<String, (u64, u64)>> {
    let mut out = BTreeMap::new();
    for id in sessions {
        let dir = cx.roots.data.join("sessions").join(id);
        let folded = target::read_session(cx, &dir).map_err(|detail| Blocked::journal(format!("{id}: {detail}")))?;
        out.insert(id.clone(), (folded.rows.len() as u64, folded.newest_file_size));
    }
    Ok(out)
}

fn projected(db: &Path) -> Result<BTreeMap<String, (u64, u64)>> {
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| Blocked::sqlite("open", db, e))?;
    let mut stmt = conn
        .prepare("SELECT id, row_count, projected_offset FROM sessions")
        .map_err(|e| Blocked::sqlite("read", db, e))?;
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, (r.get::<_, i64>(1)? as u64, r.get::<_, i64>(2)? as u64)))
        })
        .map_err(|e| Blocked::sqlite("read", db, e))?;
    rows.collect::<std::result::Result<_, _>>()
        .map_err(|e| Blocked::sqlite("read", db, e))
}

fn sessions(cx: &ItemContext<'_>) -> Vec<String> {
    cx.verified_sessions().map(str::to_string).collect()
}

/// The sha256 of the migrated session ids, one per line: what the item of a serving index stages and verifies. The rows
/// themselves move with the core's own writes, so only that each session is held is the migration's to say.
fn held(sessions: &[String]) -> String {
    durable::sha256_hex(sessions.iter().map(|id| format!("{id}\n")).collect::<String>().as_bytes())
}

/// Every verified session brought into the serving index (a session verified by a run that ended before it was taken in
/// included).
fn adopt_all(cx: &ItemContext<'_>, index: &dyn ServingIndex, sessions: &[String]) -> Result<()> {
    for id in sessions {
        index.adopt(&cx.roots.data, id).map_err(|os_error| Blocked::Io {
            op: "adopt_session",
            path: cx.roots.data.join("sessions").join(id),
            os_error,
        })?;
    }
    Ok(())
}

impl ItemDriver for IndexDriver {
    fn plan(&self, roots: &MigrationRoots, sink: &mut PlanSink) -> Result<()> {
        let _ = roots;
        sink.add_item(plan::item(
            INDEX_KEY,
            KindGroup::Data,
            ItemKind::Index,
            Contract::Convert,
            Vec::new(),
            Some(Target::Index),
        )?)
    }

    fn owns(&self, item: &ManifestItem) -> bool {
        item.kind == ItemKind::Index
    }

    fn wave(&self, _item: &ManifestItem) -> Wave {
        Wave::Index
    }

    fn stage(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<Staged> {
        if let Some(index) = self.projector.serving() {
            let sessions = sessions(cx);
            adopt_all(cx, index, &sessions)?;
            return Ok(Staged::Output {
                output_sha256: held(&sessions),
                replaced_surrogates: 0,
            });
        }
        let stage = cx.stage_dir(item.key.as_str());
        durable::create_dir_all(&stage)?;
        let db = stage.join(STAGED_FILE);
        durable::step(durable::Step::Project, &db, &[]);
        self.projector
            .project(&cx.roots.data, &db, &sessions(cx))
            .map_err(|os_error| Blocked::Io {
                op: "project_index",
                path: db.clone(),
                os_error,
            })?;
        durable::step(durable::Step::Projected, &db, &[]);
        durable::sync_file(&db)?;
        Ok(Staged::Output {
            output_sha256: durable::hash_file(&db)?.1,
            replaced_surrogates: 0,
        })
    }

    fn publish(&self, cx: &ItemContext<'_>, item: &ManifestItem, staged: &StagedEntry) -> Result<()> {
        // The serving core's index is the target, and it is in place.
        if self.projector.serving().is_some() {
            return Ok(());
        }
        let target = cx.roots.data.join(INDEX_PATH);
        let stage = cx.stage_dir(item.key.as_str()).join(STAGED_FILE);
        if !durable::exists(&stage)? {
            // Renamed by an interrupted run: the target is the staged file.
            if durable::exists(&target)? && durable::hash_file(&target)?.1 == staged.output_sha256.as_str() {
                return Ok(());
            }
            return Err(Blocked::TargetConflict {
                key: item.key.as_str().into(),
                path: target,
            });
        }
        if durable::exists(&target)? {
            return Err(Blocked::TargetConflict {
                key: item.key.as_str().into(),
                path: target,
            });
        }
        durable::create_dir_all(target.parent().expect("index dir"))?;
        durable::durable_rename(&stage, &target)
    }

    fn verify(&self, cx: &ItemContext<'_>, _item: &ManifestItem) -> Result<Verdict> {
        let db = cx.roots.data.join(INDEX_PATH);
        if let Some(index) = self.projector.serving() {
            // A run that staged, then ended, may have verified sessions the index was never given.
            let sessions = sessions(cx);
            adopt_all(cx, index, &sessions)?;
            let have = projected(&db)?;
            if let Some(missing) = sessions.iter().find(|id| !have.contains_key(*id)) {
                return Err(Blocked::journal(format!("the serving index holds no row of {missing}")));
            }
            return Ok(Verdict::Verified {
                digest: Some(crate::json::hex_digest(&held(&sessions))),
            });
        }
        let want = expected(cx, &sessions(cx))?;
        let have = projected(&db)?;
        if want != have {
            return Ok(Verdict::Quarantine {
                code: QuarantineCode::DigestMismatch,
                detail: format!("{} catalog rows, {} sessions; projection differs", have.len(), want.len()),
            });
        }
        let text = want
            .iter()
            .map(|(id, (rows, size))| format!("{id} {rows} {size}\n"))
            .collect::<String>();
        Ok(Verdict::Verified {
            digest: Some(crate::json::hex_digest(&durable::sha256_hex(text.as_bytes()))),
        })
    }

    fn withdraw(&self, cx: &ItemContext<'_>, _item: &ManifestItem) -> Result<()> {
        if self.projector.serving().is_some() {
            return Ok(());
        }
        // A derived index that does not verify is rebuilt by the runtime from the logs.
        durable::remove_file(&cx.roots.data.join(INDEX_PATH)).map(drop)
    }
}
