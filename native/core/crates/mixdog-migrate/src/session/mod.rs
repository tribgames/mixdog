//! Session items (SM §11.4): one item per session id, converted from the 1.4.5 json, the
//! dev log, or the pair, with its archive, pending archive jobs, turn checkpoint, pending
//! messages and worker row; published as `sessions/<id>/` and verified by digest.

pub mod archived;
pub mod context_blobs;
pub mod ids;
pub mod listed;
pub mod model;
pub mod observe;
mod pending;
pub mod restore;
pub mod source;
pub mod splice;
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
use crate::temp_files;
use source::ARCHIVE_SUFFIX;
use source::Fail;
use source::JSON_SUFFIX;
use source::LOG_SUFFIX;
use source::PENDING_SUFFIX;
use source::is_session_id;

pub const SESSIONS_DIR: &str = "sessions";
/// In a session item's stage directory: its dangling references, counted when it is verified. A serving core writes to the
/// session from then on, records a migration never writes among them, so its log is not read again for the count.
const DANGLING_FILE: &str = "dangling";
const CHECKPOINT_DIR: &str = "turn-checkpoints";
/// `<data>/archive-damage/<id>.json`: what was skipped of a session's compaction archive sidecars
/// because it could not be read (the session converts and opens without it).
pub const ARCHIVE_DAMAGE_DIR: &str = "archive-damage";
/// Shared files under `<D>` that session items read.
const SHARED_FILES: [&str; 6] =
    [source::LEGACY_SPOOL, source::AGENT_WORKERS, source::LEAD_WORKERS, source::AGENT_RELEASED, archived::SESSION_SUMMARIES, archived::SESSION_SUMMARIES_LOG];

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
    // Interrupted writes: a session save (`<id>.json.<12 hex>.tmp`) and a compaction capture of a sidecar (`<sidecar>.mixdog-tmp-<8 hex>`).
    if temp_files::session_save_base(name).is_some_and(|base| with_id(base, JSON_SUFFIX).is_some())
        || temp_files::compaction_publish_base(name).is_some_and(|base| with_id(base, ARCHIVE_SUFFIX).or_else(|| with_id(base, PENDING_SUFFIX)).is_some())
    {
        return Entry::Tmp;
    }
    let set_aside = |base: &str, tail: &dyn Fn(&str) -> bool| {
        name.find(base).filter(|at| is_session_id(&name[..*at])).and_then(|at| name[at + base.len()..].strip_prefix('.')).is_some_and(tail)
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
    office: context_blobs::OfficeExtractor,
}

impl SessionDriver {
    pub fn new(metas: Vec<Arc<dyn SessionMetaSource>>, office: context_blobs::OfficeExtractor) -> Self {
        Self { metas, office }
    }
}

#[cfg(test)]
thread_local! {
    /// The sessions whose records a plan read, in order (a test counts them).
    pub(crate) static PLAN_READS: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn note_plan_read(id: &str) {
    #[cfg(test)]
    PLAN_READS.with(|reads| reads.borrow_mut().push(id.to_owned()));
    #[cfg(not(test))]
    let _ = id;
}

/// A migrating parent read once: its header, and its user messages that have the shape of a completion notification.
struct Loaded {
    header: Option<mixdog_store::schema::record::Header>,
    notices: Vec<String>,
}

fn load_parent(roots: &MigrationRoots, parent: &str, files: &[String]) -> Result<Loaded> {
    note_plan_read(parent);
    let find = |suffix: &str| files.iter().find(|f| **f == format!("{SESSIONS_DIR}/{parent}{suffix}"));
    let json = match find(JSON_SUFFIX) {
        Some(f) => Some(durable::read(&roots.resolve(Root::Data, f)?)?),
        None => None,
    };
    let log = match find(LOG_SUFFIX) {
        Some(f) => Some(durable::open_buffered(&roots.resolve(Root::Data, f)?)?),
        None => None,
    };
    let (header, messages) = match source::header_and_messages(parent, json.as_deref(), log, &mut 0) {
        Ok((header, messages)) => (Some(header), messages),
        Err(Fail::Blocked(b)) => return Err(b),
        Err(Fail::Quarantine(..)) => return Ok(Loaded { header: None, notices: Vec::new() }),
    };
    let notices = messages
        .iter()
        .filter(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))
        .filter_map(|m| m.get("content").and_then(|c| c.as_str()))
        .filter(|c| c.contains(archived::NOTIFICATION_MARKER))
        .map(str::to_owned)
        .collect();
    Ok(Loaded { header, notices })
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
        Ok(Record::Session(s)) => Ok(s.origin.map(|o| (o.migration.manifest_sha256.as_str().to_string(), o.migration.item_key.as_str().to_string()))),
        _ => Ok(None),
    }
}

/// A desktop `meta` change without the legacy `title` its session's own title outranks.
/// The desktop's legacy `titles` map named a session only when the session had no usable
/// title of its own (`desktop-state.ts`: `names` > `row.title` > `titles` > preview); applied
/// as a `meta` change it would replace an AI or user title. `None`: nothing left to record.
pub fn without_outranked_title(
    header: &mixdog_store::schema::record::Header,
    mut set: mixdog_store::schema::record::Header,
) -> Option<mixdog_store::schema::record::Header> {
    let own = header.get("title").and_then(serde_json::Value::as_str).unwrap_or_default();
    if crate::desktop_profile::has_own_title(own) {
        set.shift_remove("title");
    }
    (!set.is_empty()).then_some(set)
}

fn ours(cx: &ItemContext<'_>, item: &ManifestItem, dir: &std::path::Path) -> Result<bool> {
    Ok(target_origin(dir)? == Some((cx.manifest_sha256.to_string(), item.key.as_str().to_string())))
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
        assert_eq!(classify("sess_a.compaction-archive.jsonl.mixdog-tmp-0123abcd"), Entry::Tmp);
        assert_eq!(classify("sess_a.compaction-archive.pending.mixdog-tmp-0123abcd"), Entry::Tmp);
        assert_eq!(classify("sess_a.json.bak"), Entry::Unknown);
        // Only the 8-digit capture temp and the 12-digit save temp are session-directory formats.
        assert_eq!(classify("sess_a.compaction-archive.jsonl.mixdog-tmp-0123456789abcdef"), Entry::Unknown);
        assert_eq!(classify("sess_a.json.mixdog-tmp-0123456789abcdef"), Entry::Unknown);
        assert_eq!(classify("sess_a.compaction-archive.jsonl.mixdog-tmp-0123abc"), Entry::Unknown);
        assert_eq!(classify("sess_a.json.0123456789abcdef01234567.tmp"), Entry::Unknown);
    }

    fn header(value: serde_json::Value) -> mixdog_store::schema::record::Header {
        value.as_object().cloned().expect("an object")
    }

    #[test]
    fn a_session_title_outranks_the_legacy_desktop_title() {
        let set = header(serde_json::json!({ "title": "흠", "archivedAt": 1, "readState": { "messageCount": 2, "revision": 1 } }));
        let kept = without_outranked_title(&header(serde_json::json!({ "title": "인사 메시지" })), set.clone()).unwrap();
        assert_eq!(kept.get("title"), None);
        assert_eq!(kept.get("archivedAt"), Some(&serde_json::json!(1)));
        assert!(kept.contains_key("readState"));
        for untitled in [serde_json::json!({}), serde_json::json!({ "title": "   " })] {
            assert_eq!(without_outranked_title(&header(untitled), set.clone()).unwrap().get("title"), Some(&serde_json::json!("흠")));
        }
    }

    #[test]
    fn a_change_that_held_only_the_outranked_title_is_dropped() {
        let own = header(serde_json::json!({ "title": "러스트 마이그레이션 세션 이어받기" }));
        assert_eq!(without_outranked_title(&own, header(serde_json::json!({ "title": "러스트 마이그레이션이어서" }))), None);
    }
}

fn add(sink: &mut PlanSink, key: String, kind: ItemKind, contract: Contract, sources: Vec<SourceFile>) -> Result<()> {
    sink.add_item(plan::item(&key, KindGroup::Data, kind, contract, sources, None)?)
}

/// The files directly under `sessions/` and `turn-checkpoints/` as the migration takes them, by their paths under `<D>`.
#[derive(Default)]
struct Listing {
    /// Each session's own files (its json, its log, its sidecars, its turn checkpoint), by session id.
    sessions: BTreeMap<String, Vec<String>>,
    set_aside: Vec<String>,
    tmp: Vec<String>,
    /// Sidecars and turn checkpoints of a session that has no record.
    orphan_sidecars: Vec<String>,
    orphan_checkpoints: Vec<String>,
}

fn listing(roots: &MigrationRoots) -> Result<Listing> {
    let mut found = Listing::default();
    let mut sidecars = Vec::new();
    for (name, is_dir) in durable::list_dir(&roots.data.join(SESSIONS_DIR))? {
        if is_dir {
            continue;
        }
        let rel = format!("{SESSIONS_DIR}/{name}");
        match classify(&name) {
            Entry::Session(id) => found.sessions.entry(id).or_default().push(rel),
            Entry::Sidecar(id) => sidecars.push((id, rel)),
            Entry::SetAside => found.set_aside.push(rel),
            Entry::Tmp => found.tmp.push(rel),
            Entry::Unknown => {}
        }
    }
    for (id, rel) in sidecars {
        match found.sessions.get_mut(&id) {
            Some(files) => files.push(rel),
            None => found.orphan_sidecars.push(rel),
        }
    }
    for (name, is_dir) in durable::list_dir(&roots.data.join(CHECKPOINT_DIR))? {
        let (false, Some(id)) = (is_dir, with_id(&name, ".json").or_else(|| with_id(&name, ".jsonl"))) else { continue };
        let rel = format!("{CHECKPOINT_DIR}/{name}");
        match found.sessions.get_mut(id) {
            Some(files) => files.push(rel),
            None => found.orphan_checkpoints.push(rel),
        }
    }
    Ok(found)
}

/// Pending spools, worker indexes and release markers; a file naming no session that migrates is retired.
fn plan_shared_files(
    roots: &MigrationRoots,
    sink: &mut PlanSink,
    sessions: &BTreeMap<String, Vec<String>>,
    reaped: Vec<(String, Vec<String>)>,
    loaded: &std::cell::RefCell<BTreeMap<String, Loaded>>,
) -> Result<()> {
    let data = Root::Data;
    let mut shared: Vec<String> = durable::list_dir(&roots.data.join(source::SPOOL_DIR))?
        .into_iter()
        .filter(|(n, d)| !d && n.ends_with(".json"))
        .map(|(n, _)| format!("{}/{n}", source::SPOOL_DIR))
        .collect();
    shared.extend(SHARED_FILES.iter().filter(|n| durable::is_file(&roots.data.join(n))).map(|n| n.to_string()));
    let mut link_parents: BTreeSet<String> = BTreeSet::new();
    for (child, parents) in reaped {
        if sessions.contains_key(&child) || parents.is_empty() {
            continue;
        }
        let migrating: Vec<String> = parents.into_iter().filter(|p| sessions.contains_key(p)).collect();
        if migrating.is_empty() {
            let key = plan::retire_key(data, &format!("{}/{child}", archived::DROPPED_PREFIX));
            add(sink, key, ItemKind::OrphanArchivedAgent, Contract::Retire, Vec::new())?;
        }
        link_parents.extend(migrating);
    }
    // Read only when a tombstone without a `sessionId` needs its session found.
    let mut candidates = None;
    for rel in shared {
        let file = sink.source(data, &rel, false)?;
        let bytes = durable::read(&roots.resolve(data, &rel)?)?;
        let named = if archived::LINK_FILES[1..].contains(&rel.as_str()) { Some((Vec::new(), Vec::new())) } else { source::shared_session_ids(&rel, &bytes) };
        match named {
            None => add(sink, plan::retain_key(data, &rel), ItemKind::Retired, Contract::Retain, vec![file.clone()])?,
            Some((mut ids, ownerless)) => {
                if archived::LINK_FILES.contains(&rel.as_str()) {
                    ids.extend(link_parents.iter().cloned());
                }
                // One no session owns is dropped with the rows without a session.
                if !ownerless.is_empty() {
                    if candidates.is_none() {
                        candidates = Some(source::session_candidates(
                            sessions.iter().map(|(id, sources)| (id.as_str(), sources.as_slice())),
                            |id| loaded.borrow().get(id).and_then(|l| l.header.clone()),
                            |id, f| {
                                note_plan_read(id);
                                durable::read(&roots.resolve(data, f)?)
                            },
                            |_, f| durable::open_buffered(&roots.resolve(data, f)?),
                        )?);
                    }
                    let all = candidates.as_deref().unwrap_or_default();
                    ids.extend(ownerless.iter().filter_map(|t| source::recover_owner(t, all)).map(|c| c.id().to_string()));
                }
                let consumers: BTreeSet<String> = ids.into_iter().filter(|id| sessions.contains_key(id)).collect();
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

#[cfg(test)]
mod pending_tests;

impl ItemDriver for SessionDriver {
    fn plan(&self, roots: &MigrationRoots, sink: &mut PlanSink) -> Result<()> {
        let data = Root::Data;
        // A session's own files are named here and no more: they are hashed when the session is converted. What is
        // hashed now is each file that is an item of its own.
        let Listing { mut sessions, set_aside, tmp, orphan_sidecars, orphan_checkpoints } = listing(roots)?;
        let own_items = [
            (set_aside, ItemKind::SetAside, Contract::Retain),
            (tmp, ItemKind::Retired, Contract::Retire),
            (orphan_sidecars, ItemKind::Retired, Contract::Retire),
            (orphan_checkpoints, ItemKind::OrphanCheckpoint, Contract::Retire),
        ];
        let ahead: Vec<String> = own_items.iter().flat_map(|(rels, ..)| rels.iter().cloned()).collect();
        sink.hash_ahead(data, &ahead)?;
        for (rels, kind, contract) in own_items {
            for rel in rels {
                let key = if contract == Contract::Retain { plan::retain_key(data, &rel) } else { plan::retire_key(data, &rel) };
                let source = sink.source(data, &rel, false)?;
                add(sink, key, kind, contract, vec![source])?;
            }
        }
        // A reaped agent child (no session of its own) is read through the parents its links name: each parent
        // that migrates consumes the link files; a child none of whose parents migrates is dropped, counted.
        let links: Vec<Option<Vec<u8>>> = archived::LINK_FILES.iter().map(|name| durable::read_optional(&roots.data.join(name))).collect::<Result<_>>()?;
        let reaped = archived::parents(links[0].as_deref(), links[1].as_deref(), links[2].as_deref());
        // A worker row whose session record is gone is listed with no header, but a reaped child's row is not a session: its
        // result lives in the parents that migrate, and a child none of whose parents is anywhere is dropped (the loop below).
        let mut row_ids: BTreeSet<String> = BTreeSet::new();
        for name in [source::AGENT_WORKERS, source::LEAD_WORKERS] {
            let Some(bytes) = durable::read_optional(&roots.data.join(name))? else { continue };
            row_ids.extend(source::worker_row_session_ids(&bytes));
        }
        // A child is reaped when a parent that migrates carries its completion notification (what the archive extractor reads),
        // or when none of its parents is anywhere (the orphan, dropped below). Each parent is read once, whatever its children.
        // A row naming only parents that are nowhere is dropped without reading anything (the exception below).
        let loaded: std::cell::RefCell<BTreeMap<String, Loaded>> = std::cell::RefCell::new(BTreeMap::new());
        let reaped_child = |id: &String, sessions: &BTreeMap<String, Vec<String>>| -> Result<bool> {
            if sessions.contains_key(id) {
                return Ok(false);
            }
            for (child, parents) in reaped.iter().filter(|(child, parents)| child == id && !parents.is_empty()) {
                if !parents.iter().any(|p| sessions.contains_key(p) || row_ids.contains(p)) {
                    return Ok(true);
                }
                for (parent, files) in parents.iter().filter_map(|p| sessions.get(p).map(|files| (p, files))) {
                    if !loaded.borrow().contains_key(parent) {
                        let found = load_parent(roots, parent, files)?;
                        loaded.borrow_mut().insert(parent.clone(), found);
                    }
                    if loaded.borrow()[parent].notices.iter().any(|content| archived::notification(content, child).is_some()) {
                        return Ok(true);
                    }
                }
            }
            Ok(false)
        };
        let mut hosts = Vec::new();
        for id in &row_ids {
            if !reaped_child(id, &sessions)? {
                hosts.push(id.clone());
            }
        }
        for id in hosts {
            sessions.entry(id).or_default();
        }
        for (id, files) in &sessions {
            sink.add_item(plan::late_item(
                &format!("session/{id}"),
                KindGroup::Data,
                ItemKind::Session,
                Contract::Convert,
                data,
                files.clone(),
                Some(Target::Session { id: id.clone() }),
            )?)?;
        }
        plan_shared_files(roots, sink, &sessions, reaped, &loaded)
    }

    fn owns(&self, item: &ManifestItem) -> bool {
        item.group == KindGroup::Data
            && match item.kind {
                ItemKind::Session | ItemKind::OrphanCheckpoint | ItemKind::OrphanArchivedAgent | ItemKind::SetAside => true,
                ItemKind::Retired => {
                    let rel = item.key.as_str().split_once("/data/").map_or("", |(_, r)| r);
                    rel.starts_with("sessions/") || rel.starts_with("session-pending/") || SHARED_FILES.contains(&rel)
                }
                _ => false,
            }
    }

    fn wave(&self, item: &ManifestItem) -> Wave {
        if item.kind == ItemKind::Session { Wave::Sessions } else { Wave::Stores }
    }

    fn stage(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<Staged> {
        match item.contract {
            Contract::Retain if item.kind == ItemKind::SetAside => {
                return Ok(Staged::Quarantine { code: QuarantineCode::CarriedSetAside, detail: "set aside by Mixdog before the update; never loaded".into() });
            }
            Contract::Retain => {
                return Ok(Staged::Quarantine { code: QuarantineCode::ParseError, detail: "a shared session file does not parse".into() });
            }
            _ => {}
        }
        let id = session_id(item);
        let fail = |f: Fail| match f {
            Fail::Quarantine(code, detail) => Ok(Staged::Quarantine { code, detail }),
            Fail::Blocked(b) => Err(b),
        };
        let mut model = match source::read(cx, item, id, &self.office) {
            Ok(m) => m,
            Err(f) => return fail(f),
        };
        for meta in &self.metas {
            if let Some(set) = meta.session_meta(cx, id)?
                && let Some(set) = without_outranked_title(&model.header, set)
            {
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
        if !model.archive_damage.is_empty() {
            let note = serde_json::json!({ "session": id, "skipped": model.archive_damage });
            let bytes = serde_json::to_vec_pretty(&note).map_err(|e| Blocked::journal(format!("{id}: archive damage note: {e}")))?;
            durable::publish_file(&cx.roots.data.join(ARCHIVE_DAMAGE_DIR).join(format!("{id}.json")), &bytes)?;
        }
        Ok(Staged::Output { output_sha256: durable::sha256_hex(&all), replaced_surrogates: model.replaced_surrogates })
    }

    fn listed_meta(&self, cx: &ItemContext<'_>, session: &str) -> Result<serde_json::Map<String, serde_json::Value>> {
        let mut all = serde_json::Map::new();
        for meta in &self.metas {
            all.extend(meta.session_meta(cx, session)?.unwrap_or_default());
        }
        Ok(all)
    }

    fn retention_facts(&self, cx: &ItemContext<'_>, item: &ManifestItem, fields: &[&str]) -> Result<Option<crate::framework::RetentionFacts>> {
        if item.kind != ItemKind::Session {
            return Ok(None);
        }
        let id = session_id(item);
        // With what this read takes of the header itself: the link a worker row would give, the title a desktop title
        // yields to, and what was read of its output.
        let fields: Vec<&str> = fields.iter().copied().chain(["parentSessionId", "title", "readState"]).collect();
        let (mut header, messages) = match source::skim(cx, item, id, &fields) {
            Ok(read) => read,
            Err(Fail::Blocked(blocked)) => return Err(blocked),
            Err(Fail::Quarantine(..)) => return Ok(None),
        };
        for meta in &self.metas {
            if let Some(set) = meta.session_meta(cx, id)?
                && let Some(set) = without_outranked_title(&header, set)
            {
                header.extend(set);
            }
        }
        // The worker row its conversion would install: the product keeps a row that still owes something past a delete.
        let consumed = cx.shared_for(item.key.as_str());
        match source::worker_of(cx, id, &header, &consumed) {
            Ok(Some(worker)) => header.extend(worker),
            Ok(None) => {}
            Err(Fail::Blocked(blocked)) => return Err(blocked),
            Err(Fail::Quarantine(..)) => return Ok(None),
        }
        // A child reaped with no session of its own is read through this parent, which alone carries its result.
        let mut links: [Option<Vec<u8>>; 3] = [None, None, None];
        for (slot, name) in links.iter_mut().zip(archived::LINK_FILES) {
            if let Some(file) = consumed.iter().find(|file| file.path == name) {
                *slot = Some(cx.read_source(file)?);
            }
        }
        let carries = archived::parents(links[0].as_deref(), links[1].as_deref(), links[2].as_deref())
            .iter()
            .any(|(child, parents)| parents.iter().any(|parent| parent == id) && !cx.has_item(&format!("session/{child}")));
        header.insert("messageCount".into(), messages.into());
        let read_through = header.get("readState").and_then(|state| state.get("messageCount")).and_then(serde_json::Value::as_u64);
        let pending = item.sources.iter().any(|file| file.path.starts_with(&format!("{CHECKPOINT_DIR}/")) || file.path.ends_with(PENDING_SUFFIX))
            || consumed.iter().any(|file| file.path == source::LEGACY_SPOOL || file.path.starts_with(&format!("{}/", source::SPOOL_DIR)));
        let tool_results = cx.roots.data.join("tool-results").join(mixdog_store::offload_sources::safe_segment(id));
        let bound = pending || carries || read_through.is_some_and(|read| read < messages) || durable::exists(&tool_results)?;
        Ok(Some(crate::framework::RetentionFacts { header, bound }))
    }

    fn publish(&self, cx: &ItemContext<'_>, item: &ManifestItem, _staged: &StagedEntry) -> Result<()> {
        let target = target_dir(cx, session_id(item));
        if durable::exists(&target)? {
            if ours(cx, item, &target)? {
                return Ok(());
            }
            return Err(Blocked::TargetConflict { key: item.key.as_str().into(), path: target });
        }
        // The migration runs behind a serving core: a session folder appearing is a change of that session's log.
        let _writing = mixdog_store::log_epoch::writing_dir(&target);
        durable::publish_dir(&cx.stage_dir(item.key.as_str()), &target)
    }

    fn verify(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<Verdict> {
        if item.contract == Contract::Retire {
            return Ok(Verdict::Verified { digest: None });
        }
        let mismatch = |detail: String| Verdict::Quarantine { code: QuarantineCode::DigestMismatch, detail };
        let folded = match target::read_session(cx, &target_dir(cx, session_id(item))) {
            Ok(f) => f,
            Err(detail) => return Ok(mismatch(detail)),
        };
        let Some(origin) = &folded.origin else {
            return Ok(mismatch("the target has no migration origin".into()));
        };
        if origin.item_key.as_str() != item.key.as_str() || origin.manifest_sha256.as_str() != cx.manifest_sha256 || folded.id != session_id(item) {
            return Ok(mismatch("the target names another item".into()));
        }
        let observable = folded.observable(cx)?;
        let digest = observable.digest();
        if digest != origin.source_digest.as_str() {
            return Ok(mismatch(format!("target {digest} ≠ source {}", origin.source_digest.as_str())));
        }
        let dangling = observable.attachments.values().filter(|status| **status == BlobStatus::Dangling).count();
        durable::publish_file(&cx.stage_dir(item.key.as_str()).join(DANGLING_FILE), dangling.to_string().as_bytes())?;
        Ok(Verdict::Verified { digest: Some(crate::json::digest(&digest)) })
    }

    fn dangling(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<u64> {
        if item.kind != ItemKind::Session {
            return Ok(0);
        }
        let path = cx.stage_dir(item.key.as_str()).join(DANGLING_FILE);
        // A session an earlier build verified has no count of its own.
        let Some(bytes) = durable::read_optional(&path)? else { return Ok(0) };
        std::str::from_utf8(&bytes)
            .ok()
            .and_then(|count| count.parse().ok())
            .ok_or_else(|| Blocked::journal(format!("{}: not a count", path.display())))
    }

    fn withdraw(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<()> {
        if item.kind != ItemKind::Session {
            return Ok(());
        }
        let target = target_dir(cx, session_id(item));
        let _writing = mixdog_store::log_epoch::writing_dir(&target);
        if durable::exists(&target)? && ours(cx, item, &target)? {
            // Keep the origin intact until the entire target is out of view.
            // An interrupted recursive delete could remove the origin first.
            let stage = cx.stage_dir(item.key.as_str());
            durable::create_dir_all(&stage)?;
            durable::durable_rename(&target, &stage.join("withdrawn"))?;
        }
        Ok(())
    }
}
