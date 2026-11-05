//! Session items (SM §11.4): one item per session id, converted from the 1.4.5 json, the
//! dev log, or the pair, with its archive, pending archive jobs, turn checkpoint, pending
//! messages and worker row; published as `sessions/<id>/` and verified by digest.

pub mod ids;
pub mod model;
pub mod observe;
pub mod restore;
pub mod source;
pub mod target;
pub mod write;

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_store::schema::frame::LOG_FILE_PREFIX;
use mixdog_store::schema::migration::Contract;
use mixdog_store::schema::migration::ItemKind;
use mixdog_store::schema::migration::KindGroup;
use mixdog_store::schema::migration::ManifestItem;
use mixdog_store::schema::migration::QuarantineCode;
use mixdog_store::schema::migration::Root;
use mixdog_store::schema::migration::SourceFile;
use mixdog_store::schema::migration::StagedEntry;
use mixdog_store::schema::migration::Target;
use mixdog_store::schema::record::Record;

use crate::durable;
use crate::error::Blocked;
use crate::error::Result;
use crate::framework::BlobStatus;
use crate::framework::ItemContext;
use crate::framework::ItemDriver;
use crate::framework::MigrationRoots;
use crate::framework::SessionMetaSource;
use crate::framework::Staged;
use crate::framework::Verdict;
use crate::framework::Wave;
use crate::plan;
use crate::plan::PlanSink;
use crate::stores::is_interrupted_write;
use source::ARCHIVE_SUFFIX;
use source::Fail;
use source::JSON_SUFFIX;
use source::LOG_SUFFIX;
use source::PENDING_SUFFIX;
use source::is_session_id;

pub const SESSIONS_DIR: &str = "sessions";
const CHECKPOINT_DIR: &str = "turn-checkpoints";

/// What a file directly under `sessions/` is to the migration.
#[derive(Debug, PartialEq, Eq)]
enum Entry {
    /// A source of session `id`.
    Session(String),
    /// A sidecar of session `id` (archive, pending jobs): orphaned without the session.
    Sidecar(String),
    /// Set aside by 1.4.5/dev (`carried_set_aside`).
    SetAside,
    /// Interrupted write, never renamed.
    Tmp,
    /// Not in the source set.
    Unknown,
}

fn with_id<'a>(name: &'a str, suffix: &str) -> Option<&'a str> {
    name.strip_suffix(suffix).filter(|id| is_session_id(id))
}

/// `<kind>-<ms>-<hex>` of a dev log set aside (`session-log-writer.mjs:217`).
fn is_aside_tail(tail: &str) -> bool {
    let mut parts = tail.rsplitn(3, '-');
    let (Some(hex), Some(ms), Some(kind)) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    !hex.is_empty()
        && hex.bytes().all(|b| b.is_ascii_hexdigit())
        && !ms.is_empty()
        && ms.bytes().all(|b| b.is_ascii_digit())
        && !kind.is_empty()
        && kind.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
}

fn classify(name: &str) -> Entry {
    if let Some(id) = with_id(name, JSON_SUFFIX).or_else(|| with_id(name, LOG_SUFFIX)) {
        return Entry::Session(id.into());
    }
    if let Some(id) = with_id(name, ARCHIVE_SUFFIX).or_else(|| with_id(name, PENDING_SUFFIX)) {
        return Entry::Sidecar(id.into());
    }
    if is_interrupted_write(name) {
        return Entry::Tmp;
    }
    let set_aside = |base: &str, tail: &dyn Fn(&str) -> bool| {
        name.find(base)
            .filter(|at| is_session_id(&name[..*at]))
            .and_then(|at| name[at + base.len()..].strip_prefix('.'))
            .is_some_and(tail)
    };
    if set_aside(JSON_SUFFIX, &|t| t.starts_with("corrupt-"))
        || set_aside(PENDING_SUFFIX, &|t| t.starts_with("corrupt-"))
        || set_aside(LOG_SUFFIX, &|t| t.starts_with("torn-") || is_aside_tail(t))
    {
        return Entry::SetAside;
    }
    Entry::Unknown
}

pub struct SessionDriver {
    metas: Vec<Arc<dyn SessionMetaSource>>,
}

impl SessionDriver {
    pub fn new(metas: Vec<Arc<dyn SessionMetaSource>>) -> Self {
        Self { metas }
    }
}

fn target_dir(cx: &ItemContext<'_>, id: &str) -> PathBuf {
    cx.roots.data.join(SESSIONS_DIR).join(id)
}

fn session_id(item: &ManifestItem) -> &str {
    item.key.as_str().strip_prefix("session/").unwrap_or_default()
}

/// The migration origin of an existing target's `session` frame, if it has one.
fn target_origin(dir: &std::path::Path) -> Result<Option<(String, String)>> {
    let first = dir.join(format!("{LOG_FILE_PREFIX}000000"));
    let Some(bytes) = durable::read_optional(&first)? else {
        return Ok(None);
    };
    let (frames, _) = crate::frame::scan(&bytes, 0);
    let Some(frame) = frames.first() else {
        return Ok(None);
    };
    match serde_json::from_slice::<Record>(&bytes[frame.payload.clone()]) {
        Ok(Record::Session(s)) => Ok(s.origin.map(|o| {
            (
                o.migration.manifest_sha256.as_str().to_string(),
                o.migration.item_key.as_str().to_string(),
            )
        })),
        _ => Ok(None),
    }
}

fn ours(cx: &ItemContext<'_>, item: &ManifestItem, dir: &std::path::Path) -> Result<bool> {
    Ok(target_origin(dir)?
        == Some((cx.manifest_sha256.to_string(), item.key.as_str().to_string())))
}

impl ItemDriver for SessionDriver {
    fn plan(&self, roots: &MigrationRoots, sink: &mut PlanSink) -> Result<()> {
        let data = Root::Data;
        let mut sessions: BTreeMap<String, Vec<SourceFile>> = BTreeMap::new();
        let mut sidecars: Vec<(String, String)> = Vec::new();
        let add = |sink: &mut PlanSink, key: String, kind, contract, sources| -> Result<()> {
            sink.add_item(plan::item(&key, KindGroup::Data, kind, contract, sources, None)?)
        };
        for (name, is_dir) in durable::list_dir(&roots.data.join(SESSIONS_DIR))? {
            if is_dir {
                continue;
            }
            let rel = format!("{SESSIONS_DIR}/{name}");
            match classify(&name) {
                Entry::Session(id) => sessions.entry(id).or_default().push(sink.source(data, &rel, false)?),
                Entry::Sidecar(id) => sidecars.push((id, rel)),
                Entry::SetAside => {
                    let s = sink.source(data, &rel, false)?;
                    add(sink, plan::retain_key(data, &rel), ItemKind::SetAside, Contract::Retain, vec![s])?;
                }
                Entry::Tmp => {
                    let s = sink.source(data, &rel, false)?;
                    add(sink, plan::retire_key(data, &rel), ItemKind::Retired, Contract::Retire, vec![s])?;
                }
                Entry::Unknown => {}
            }
        }
        for (id, rel) in sidecars {
            let s = sink.source(data, &rel, false)?;
            match sessions.get_mut(&id) {
                Some(sources) => sources.push(s),
                None => add(sink, plan::retire_key(data, &rel), ItemKind::Retired, Contract::Retire, vec![s])?,
            }
        }
        for (name, is_dir) in durable::list_dir(&roots.data.join(CHECKPOINT_DIR))? {
            let id = with_id(&name, ".json").or_else(|| with_id(&name, ".jsonl"));
            let (false, Some(id)) = (is_dir, id) else { continue };
            let rel = format!("{CHECKPOINT_DIR}/{name}");
            let s = sink.source(data, &rel, false)?;
            match sessions.get_mut(id) {
                Some(sources) => sources.push(s),
                None => add(sink, plan::retire_key(data, &rel), ItemKind::OrphanCheckpoint, Contract::Retire, vec![s])?,
            }
        }
        for (id, sources) in &sessions {
            sink.add_item(plan::item(
                &format!("session/{id}"),
                KindGroup::Data,
                ItemKind::Session,
                Contract::Convert,
                sources.clone(),
                Some(Target::Session { id: id.clone() }),
            )?)?;
        }
        // Shared files: pending spools and worker indexes.
        let mut shared: Vec<String> = durable::list_dir(&roots.data.join(source::SPOOL_DIR))?
            .into_iter()
            .filter(|(n, d)| !d && n.ends_with(".json"))
            .map(|(n, _)| format!("{}/{n}", source::SPOOL_DIR))
            .collect();
        shared.extend(
            [source::LEGACY_SPOOL, source::AGENT_WORKERS, source::LEAD_WORKERS]
                .iter()
                .filter(|n| durable::is_file(&roots.data.join(n)))
                .map(|n| n.to_string()),
        );
        for rel in shared {
            let file = sink.source(data, &rel, false)?;
            let bytes = durable::read(&roots.resolve(data, &rel)?)?;
            match source::shared_session_ids(&rel, &bytes) {
                None => add(sink, plan::retain_key(data, &rel), ItemKind::Retired, Contract::Retain, vec![file.clone()])?,
                Some(ids) => {
                    let consumers: BTreeSet<String> =
                        ids.into_iter().filter(|id| sessions.contains_key(id)).collect();
                    if consumers.is_empty() {
                        add(sink, plan::retire_key(data, &rel), ItemKind::Retired, Contract::Retire, vec![file.clone()])?;
                    }
                    for id in consumers {
                        sink.add_shared(file.clone(), &format!("session/{id}"));
                    }
                }
            }
        }
        Ok(())
    }

    fn owns(&self, item: &ManifestItem) -> bool {
        item.group == KindGroup::Data
            && match item.kind {
                ItemKind::Session | ItemKind::OrphanCheckpoint | ItemKind::SetAside => true,
                ItemKind::Retired => {
                    let rel = item.key.as_str().split_once("/data/").map_or("", |(_, r)| r);
                    rel.starts_with("sessions/")
                        || rel.starts_with("session-pending/")
                        || [source::LEGACY_SPOOL, source::AGENT_WORKERS, source::LEAD_WORKERS].contains(&rel)
                }
                _ => false,
            }
    }

    fn wave(&self, item: &ManifestItem) -> Wave {
        if item.kind == ItemKind::Session {
            Wave::Sessions
        } else {
            Wave::Stores
        }
    }

    fn stage(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<Staged> {
        match item.contract {
            Contract::Retain if item.kind == ItemKind::SetAside => {
                return Ok(Staged::Quarantine {
                    code: QuarantineCode::CarriedSetAside,
                    detail: "set aside by Mixdog before the update; never loaded".into(),
                });
            }
            Contract::Retain => {
                return Ok(Staged::Quarantine {
                    code: QuarantineCode::ParseError,
                    detail: "a shared session file does not parse".into(),
                });
            }
            _ => {}
        }
        let id = session_id(item);
        let fail = |f: Fail| match f {
            Fail::Quarantine(code, detail) => Ok(Staged::Quarantine { code, detail }),
            Fail::Blocked(b) => Err(b),
        };
        let mut model = match source::read(cx, item, id) {
            Ok(m) => m,
            Err(f) => return fail(f),
        };
        for meta in &self.metas {
            if let Some(set) = meta.session_meta(cx, id)? {
                model.metas.push(set);
            }
        }
        let source_digest = observe::Observable::of_source(cx, &model)?.digest();
        let files = match write::frames(cx, &model, item.key.as_str(), &source_digest) {
            Ok(files) => files,
            Err(f) => return fail(f),
        };
        let stage = cx.stage_dir(item.key.as_str());
        let mut all = Vec::new();
        for (no, bytes) in files.iter().enumerate() {
            durable::write_synced(&stage.join(format!("{LOG_FILE_PREFIX}{no:06}")), bytes)?;
            all.extend_from_slice(bytes);
        }
        Ok(Staged::Output {
            output_sha256: durable::sha256_hex(&all),
            replaced_surrogates: model.replaced_surrogates,
        })
    }

    fn publish(&self, cx: &ItemContext<'_>, item: &ManifestItem, _staged: &StagedEntry) -> Result<()> {
        let target = target_dir(cx, session_id(item));
        if durable::exists(&target)? {
            if ours(cx, item, &target)? {
                return Ok(());
            }
            return Err(Blocked::TargetConflict {
                key: item.key.as_str().into(),
                path: target,
            });
        }
        durable::publish_dir(&cx.stage_dir(item.key.as_str()), &target)
    }

    fn verify(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<Verdict> {
        if item.contract == Contract::Retire {
            return Ok(Verdict::Verified { digest: None });
        }
        let mismatch = |detail: String| Verdict::Quarantine {
            code: QuarantineCode::DigestMismatch,
            detail,
        };
        let folded = match target::read_session(cx, &target_dir(cx, session_id(item))) {
            Ok(f) => f,
            Err(detail) => return Ok(mismatch(detail)),
        };
        let Some(origin) = &folded.origin else {
            return Ok(mismatch("the target has no migration origin".into()));
        };
        if origin.item_key.as_str() != item.key.as_str()
            || origin.manifest_sha256.as_str() != cx.manifest_sha256
            || folded.id != session_id(item)
        {
            return Ok(mismatch("the target names another item".into()));
        }
        let digest = folded.observable(cx)?.digest();
        if digest != origin.source_digest.as_str() {
            return Ok(mismatch(format!("target {digest} ≠ source {}", origin.source_digest.as_str())));
        }
        Ok(Verdict::Verified {
            digest: Some(crate::json::digest(&digest)),
        })
    }

    fn dangling(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<u64> {
        if item.kind != ItemKind::Session {
            return Ok(0);
        }
        let folded = target::read_session(cx, &target_dir(cx, session_id(item)))
            .map_err(|detail| Blocked::journal(format!("{}: {detail}", item.key.as_str())))?;
        let refs: BTreeSet<String> = folded.rows.iter().flat_map(|r| r.refs.iter().cloned()).collect();
        let mut dangling = 0;
        for r in refs {
            dangling += u64::from(cx.blob_status(&r)? == BlobStatus::Dangling);
        }
        Ok(dangling)
    }

    fn withdraw(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<()> {
        if item.kind != ItemKind::Session {
            return Ok(());
        }
        let target = target_dir(cx, session_id(item));
        if durable::exists(&target)? && ours(cx, item, &target)? {
            durable::remove_dir_all(&target)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sessions_dir_entries_classify() {
        assert_eq!(classify("sess_a.json"), Entry::Session("sess_a".into()));
        assert_eq!(classify("sess_a.log.jsonl"), Entry::Session("sess_a".into()));
        assert_eq!(classify("sess_a.compaction-archive.jsonl"), Entry::Sidecar("sess_a".into()));
        assert_eq!(classify("sess_a.json.corrupt-1792542203590"), Entry::SetAside);
        assert_eq!(classify("sess_a.log.jsonl.torn-1-ab"), Entry::SetAside);
        assert_eq!(classify("sess_a.log.jsonl.foreign-1793-0a1b2c3d"), Entry::SetAside);
        assert_eq!(classify("sess_a.json.fa4245bfe458.tmp"), Entry::Tmp);
        assert_eq!(classify("sess_a.json.bak"), Entry::Unknown);
    }
}
