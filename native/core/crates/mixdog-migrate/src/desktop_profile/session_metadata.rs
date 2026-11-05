//! `desktop-session-metadata.json` (SPEC §4.11): titles, names, archive/favorite/retire
//! stamps, legacy project assignments and read cursors, read exactly as the desktop's
//! `readSessionMetadata` reads them, then handed to the session conversion item as one
//! `meta` change per session.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_store::schema::bounded::Digest;
use mixdog_store::schema::migration::ManifestItem;
use mixdog_store::schema::migration::QuarantineCode;
use mixdog_store::schema::migration::Root;
use mixdog_store::schema::record::Header;
use serde_json::Map;
use serde_json::Number;
use serde_json::Value;

use super::Staged;
use super::error::ApplyError;
use super::error::Step;
use super::fsx;
use super::jsvalue;
use super::source;
use super::source::Parsed;
use super::state_tables;
use super::title;
use crate::durable;
use crate::error::Blocked;
use crate::framework::ItemContext;
use crate::json::utf16_len;

/// File name under `<P>`.
pub const SESSION_METADATA_FILE: &str = "desktop-session-metadata.json";
const SESSION_STAGE_FILE: &str = "session-meta.json";

const MAX_MESSAGE_COUNT: i64 = 10_000_000;
const MAX_PROJECT_LEN: usize = 32_768;

/// A session's read cursor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadState {
    pub message_count: u64,
    pub revision: u64,
    /// The session's `compactCount` the count was recorded under; absent on a cursor from
    /// before the field.
    pub epoch: Option<u64>,
}

/// Everything the desktop kept about one session; the `meta{set}` record body.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct MetaSet {
    pub title: Option<String>,
    pub name: Option<String>,
    pub archived_at: Option<Number>,
    pub favorite_at: Option<Number>,
    /// Legacy sidebar project assignment, kept as stored (`""` = no project).
    pub project: Option<String>,
    pub read_state: Option<ReadState>,
    pub retired_at: Option<Number>,
}

impl MetaSet {
    /// The header keys of the `meta` record's `set`.
    pub fn to_set(&self) -> Header {
        let mut set = Map::new();
        if let Some(title) = &self.title {
            set.insert("title".into(), title.clone().into());
        }
        if let Some(name) = &self.name {
            set.insert("name".into(), name.clone().into());
        }
        if let Some(at) = &self.archived_at {
            set.insert("archivedAt".into(), Value::Number(at.clone()));
        }
        if let Some(at) = &self.favorite_at {
            set.insert("favoriteAt".into(), Value::Number(at.clone()));
        }
        if let Some(project) = &self.project {
            set.insert("project".into(), project.clone().into());
        }
        if let Some(read) = &self.read_state {
            let mut cursor = Map::new();
            cursor.insert("messageCount".into(), read.message_count.into());
            cursor.insert("revision".into(), read.revision.into());
            if let Some(epoch) = read.epoch {
                cursor.insert("epoch".into(), epoch.into());
            }
            set.insert("readState".into(), Value::Object(cursor));
        }
        if let Some(at) = &self.retired_at {
            set.insert("retiredAt".into(), Value::Number(at.clone()));
        }
        set
    }
}

/// The file's entries by session id; ids with nothing valid stored are absent.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SessionMetadata {
    entries: BTreeMap<String, MetaSet>,
}

impl SessionMetadata {
    /// A shape that is not version 2 is empty, by the desktop's own rule.
    pub fn from_value(value: &Value) -> Self {
        let mut metadata = Self::default();
        let Some(root) = jsvalue::object(value) else {
            return metadata;
        };
        if root.get("version").and_then(jsvalue::safe_integer) != Some(2) {
            return metadata;
        }
        let map = |key: &str| root.get(key).and_then(jsvalue::object);
        for (id, value) in map("titles").into_iter().flatten() {
            if let Some(title) = text_entry(id, value, title::generated_title) {
                metadata.entry(id).title = Some(title);
            }
        }
        for (id, value) in map("names").into_iter().flatten() {
            if let Some(name) = text_entry(id, value, title::normalized_name) {
                metadata.entry(id).name = Some(name);
            }
        }
        for (id, value) in map("archived").into_iter().flatten() {
            if let Some(at) = stamp_entry(id, value) {
                metadata.entry(id).archived_at = Some(at);
            }
        }
        for (id, value) in map("favorites").into_iter().flatten() {
            if let Some(at) = stamp_entry(id, value) {
                metadata.entry(id).favorite_at = Some(at);
            }
        }
        for (id, value) in map("projects").into_iter().flatten() {
            let valid = jsvalue::is_session_id(id);
            if let Some(project) = value.as_str().filter(|text| valid && utf16_len(text) <= MAX_PROJECT_LEN) {
                metadata.entry(id).project = Some(project.to_owned());
            }
        }
        for (id, value) in map("reads").into_iter().flatten() {
            if let Some(read) = read_entry(id, value) {
                metadata.entry(id).read_state = Some(read);
            }
        }
        for (id, value) in map("retired").into_iter().flatten() {
            if let Some(at) = stamp_entry(id, value) {
                metadata.entry(id).retired_at = Some(at);
            }
        }
        metadata
    }

    /// Parses the file's bytes; also returns the lone surrogates replaced.
    pub fn parse(bytes: &[u8]) -> Step<(Self, u64)> {
        let Parsed {
            value,
            replaced_surrogates,
        } = source::parse_json(bytes)?;
        Ok((Self::from_value(&value), replaced_surrogates))
    }

    fn entry(&mut self, id: &str) -> &mut MetaSet {
        self.entries.entry(id.to_owned()).or_default()
    }

    /// The `meta` change for `session_id`, if the desktop kept anything about it.
    pub fn meta_for(&self, session_id: &str) -> Option<&MetaSet> {
        self.entries.get(session_id)
    }

    /// Entries naming no migrated session: normal (the desktop never forgets archived
    /// ids), retired with the file and counted as `dangling`.
    pub fn dangling(&self, is_migrated: impl Fn(&str) -> bool) -> u64 {
        self.entries.keys().filter(|id| !is_migrated(id)).count() as u64
    }

    /// The entries of migrated sessions, `id -> set`, as a JSON object.
    fn migrated(&self, is_migrated: impl Fn(&str) -> bool) -> Map<String, Value> {
        self.entries
            .iter()
            .filter(|(id, _)| is_migrated(id))
            .map(|(id, meta)| (id.clone(), Value::Object(meta.to_set())))
            .collect()
    }
}

/// A title or name through the desktop's own normalization; nothing left means no entry.
fn text_entry(id: &str, value: &Value, normalize: fn(&str) -> String) -> Option<String> {
    if !jsvalue::is_session_id(id) {
        return None;
    }
    Some(normalize(value.as_str()?)).filter(|text| !text.is_empty())
}

fn stamp_entry(id: &str, value: &Value) -> Option<Number> {
    if !jsvalue::is_session_id(id) {
        return None;
    }
    // `const at = Number(value); Number.isFinite(at) && at > 0`
    let at = jsvalue::to_number(value);
    if !at.is_finite() || at <= 0.0 {
        return None;
    }
    jsvalue::json_number(at)
}

fn read_entry(id: &str, value: &Value) -> Option<ReadState> {
    if !jsvalue::is_session_id(id) {
        return None;
    }
    let cursor = jsvalue::object(value)?;
    // Every field goes through `Number(...)` first, as the desktop's reader does; a missing
    // field is `Number(undefined)`, NaN.
    let number = |name: &str| cursor.get(name).map_or(f64::NAN, jsvalue::to_number);
    let message_count = number("messageCount");
    let revision = number("revision");
    if !jsvalue::is_integer(message_count) || message_count < 0.0 || message_count > MAX_MESSAGE_COUNT as f64 {
        return None;
    }
    if !jsvalue::is_safe_integer(revision) || revision < 1.0 {
        return None;
    }
    let epoch = number("epoch");
    let stamped = cursor.contains_key("epoch") && jsvalue::is_safe_integer(epoch) && epoch >= 0.0;
    Some(ReadState {
        message_count: message_count as u64,
        revision: revision as u64,
        epoch: stamped.then_some(epoch as u64),
    })
}

fn is_migrated(cx: &ItemContext<'_>, id: &str) -> bool {
    cx.has_item(&format!("session/{id}"))
}

/// The metadata file, parsed from the shared source of the manifest; empty when the
/// manifest carries none.
pub(super) fn load(cx: &ItemContext<'_>) -> Step<(SessionMetadata, u64)> {
    let shared = cx
        .manifest
        .shared
        .iter()
        .map(|shared| &shared.file)
        .find(|file| file.root == Root::Profile && file.path == SESSION_METADATA_FILE);
    let Some(file) = shared else {
        return Ok(Default::default());
    };
    SessionMetadata::parse(&source::read_source(cx, file)?)
}

/// The parsed file, once per manifest: every session item asks for its entry.
#[derive(Default)]
pub(super) struct MetadataCache(Mutex<Option<(String, Shared)>>);

type Shared = Arc<(SessionMetadata, u64)>;

impl MetadataCache {
    fn get(&self, cx: &ItemContext<'_>) -> Step<Shared> {
        let mut slot = self.0.lock().expect("metadata cache");
        if let Some((manifest, loaded)) = slot.as_ref()
            && manifest == cx.manifest_sha256
        {
            return Ok(Arc::clone(loaded));
        }
        let loaded = Arc::new(load(cx)?);
        *slot = Some((cx.manifest_sha256.to_owned(), Arc::clone(&loaded)));
        Ok(loaded)
    }
}

/// The `meta{set}` header keys for a migrated session (`SessionMetaSource`). A file that
/// does not parse sets nothing; its item is quarantined and the file kept.
pub(super) fn session_meta(cx: &ItemContext<'_>, cache: &MetadataCache, session_id: &str) -> Step<Option<Header>> {
    match cache.get(cx) {
        Ok(loaded) => Ok(loaded.0.meta_for(session_id).map(MetaSet::to_set)),
        Err(ApplyError::Quarantine(_)) => Ok(None),
        Err(blocked) => Err(blocked),
    }
}

fn meta_key(item: &ManifestItem) -> String {
    format!("migration:{}", item.key.as_str())
}

fn dangling_key(item: &ManifestItem) -> String {
    format!("{}:dangling", meta_key(item))
}

/// Publishes the item's own record in `state/core.sqlite`: the manifest it ran under and
/// the entries naming no migrated session. The count must outlive the source file, which
/// disposal deletes before the completion marker counts it.
pub(super) fn publish(cx: &ItemContext<'_>, cache: &MetadataCache, item: &ManifestItem) -> Step<()> {
    let dangling = cache.get(cx)?.0.dangling(|id| is_migrated(cx, id));
    state_tables::put_meta(
        cx,
        &[
            (meta_key(item), cx.manifest_sha256.to_owned()),
            (dangling_key(item), dangling.to_string()),
        ],
    )
}

pub(super) fn withdraw(cx: &ItemContext<'_>, item: &ManifestItem) -> Step<()> {
    state_tables::delete_meta(cx, &[meta_key(item), dangling_key(item)])
}

/// Entries naming no migrated session, counted as `dangling`.
pub(super) fn dangling(cx: &ItemContext<'_>, item: &ManifestItem) -> Step<u64> {
    state_tables::get_meta(cx, &dangling_key(item))?
        .and_then(|count| count.parse().ok())
        .ok_or_else(|| Blocked::journal("a verified sessionMetadata item has no dangling count").into())
}

fn applied(metadata: &SessionMetadata, cx: &ItemContext<'_>) -> Value {
    Value::Object(metadata.migrated(|id| is_migrated(cx, id)))
}

/// Stage of `desktopProfile/sessionMetadata`: validates the file and records what is
/// applied to the migrated sessions. The `meta` records themselves are written by the
/// session items, which ask `session_meta`.
pub(super) fn stage(cx: &ItemContext<'_>, cache: &MetadataCache, item: &ManifestItem) -> Step<Staged> {
    let loaded = cache.get(cx)?;
    let (metadata, replaced_surrogates) = (&loaded.0, loaded.1);
    let bytes = source::canonical_text(&applied(metadata, cx)).into_bytes();
    let path = cx.stage_dir(item.key.as_str()).join(SESSION_STAGE_FILE);
    fsx::write_new(&path, &bytes, true).map_err(|error| ApplyError::io("write", &path, error))?;
    Ok(Staged {
        output_sha256: durable::sha256_hex(&bytes),
        replaced_surrogates,
    })
}

/// Verification: the file read afresh says what was staged. That every migrated session
/// header carries it is the session items' own verification, which folds the `meta`
/// records with the rest of the header.
pub(super) fn verify(cx: &ItemContext<'_>, cache: &MetadataCache, item: &ManifestItem) -> Step<Digest> {
    let value = applied(&cache.get(cx)?.0, cx);
    if state_tables::get_meta(cx, &meta_key(item))?.as_deref() != Some(cx.manifest_sha256) {
        return Err(ApplyError::quarantine(
            QuarantineCode::DigestMismatch,
            "the item's record names another manifest",
        ));
    }
    let staged = cx.stage_dir(item.key.as_str()).join(SESSION_STAGE_FILE);
    if durable::read_optional(&staged)?.is_some_and(|bytes| bytes != source::canonical_text(&value).as_bytes()) {
        return Err(ApplyError::quarantine(
            QuarantineCode::DigestMismatch,
            "the metadata differs from what was staged",
        ));
    }
    Ok(source::digest_value(&value))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> SessionMetadata {
        SessionMetadata::parse(text.as_bytes()).unwrap().0
    }

    #[test]
    fn reads_every_map_the_way_the_desktop_does() {
        let metadata = parse(
            r#"{"version":2,
            "titles":{"s1":"  hello \n world ","bad id":"x","s2":"   "},
            "names":{"s1":"My name"},
            "archived":{"s1":1700000000000,"s3":0,"s4":"no"},
            "favorites":{"s2":1700000000001},
            "projects":{"s1":"","s2":"C:/p"},
            "reads":{"s1":{"messageCount":4,"revision":2,"epoch":1},
                     "s2":{"messageCount":-1,"revision":2},
                     "s3":{"messageCount":1,"revision":0}},
            "retired":{"s9":5}}"#,
        );
        let s1 = metadata.meta_for("s1").unwrap();
        assert_eq!(s1.title.as_deref(), Some("hello world"));
        assert_eq!(s1.name.as_deref(), Some("My name"));
        assert_eq!(s1.archived_at, Some(Number::from(1_700_000_000_000u64)));
        assert_eq!(s1.project.as_deref(), Some(""));
        assert_eq!(
            s1.read_state,
            Some(ReadState {
                message_count: 4,
                revision: 2,
                epoch: Some(1)
            })
        );
        let s2 = metadata.meta_for("s2").unwrap();
        assert_eq!((s2.title.as_deref(), s2.read_state.clone()), (None, None));
        assert!(s2.favorite_at.is_some());
        assert!(metadata.meta_for("s3").is_none());
        assert!(metadata.meta_for("bad id").is_none());
        assert!(metadata.meta_for("s9").unwrap().retired_at.is_some());
    }

    /// Expected values are Node's `Number(...)` / `readSessionMetadata` output.
    #[test]
    fn numeric_strings_and_nulls_are_coerced_the_way_node_does() {
        let metadata = parse(
            r#"{"version":2,
            "archived":{"a":"1700000000000","b":"0x10","c":"","d":null,"e":[7],"f":true,"g":"Infinity","h":[1,2],"i":" 5 "},
            "reads":{"r1":{"messageCount":"4","revision":"7","epoch":null},
                     "r2":{"messageCount":4,"revision":7},
                     "r3":{"messageCount":"","revision":"1"},
                     "r4":{"messageCount":4.5,"revision":1},
                     "r5":{"messageCount":null,"revision":"1","epoch":"3"},
                     "r6":{"messageCount":1,"revision":"1","epoch":"x"}}}"#,
        );
        let archived = |id: &str| metadata.meta_for(id).and_then(|m| m.archived_at.clone());
        assert_eq!(archived("a"), Some(Number::from(1_700_000_000_000u64)));
        assert_eq!(archived("b"), Some(Number::from(16)));
        assert_eq!(archived("c"), None);
        assert_eq!(archived("d"), None);
        assert_eq!(archived("e"), Some(Number::from(7)));
        assert_eq!(archived("f"), Some(Number::from(1)));
        assert_eq!(archived("g"), None);
        assert_eq!(archived("h"), None);
        assert_eq!(archived("i"), Some(Number::from(5)));
        let read = |id: &str| metadata.meta_for(id).and_then(|m| m.read_state.clone());
        let state = |message_count, revision, epoch| Some(ReadState { message_count, revision, epoch });
        assert_eq!(read("r1"), state(4, 7, Some(0)));
        assert_eq!(read("r2"), state(4, 7, None));
        assert_eq!(read("r3"), state(0, 1, None));
        assert_eq!(read("r4"), None);
        assert_eq!(read("r5"), state(0, 1, Some(3)));
        assert_eq!(read("r6"), state(1, 1, None));
    }

    #[test]
    fn a_shape_that_is_not_version_two_is_empty() {
        assert_eq!(parse(r#"{"titles":{"s1":"a"}}"#), SessionMetadata::default());
        assert_eq!(parse(r#"{"version":1,"titles":{"s1":"a"}}"#), SessionMetadata::default());
        assert_eq!(parse("[1,2]"), SessionMetadata::default());
    }

    #[test]
    fn set_uses_the_record_key_names() {
        let metadata = parse(
            r#"{"version":2,"titles":{"s":"t"},"archived":{"s":1},"favorites":{"s":2},"retired":{"s":3},
            "reads":{"s":{"messageCount":1,"revision":1}}}"#,
        );
        let keys: Vec<_> = metadata.meta_for("s").unwrap().to_set().keys().cloned().collect();
        let mut keys = keys;
        keys.sort();
        assert_eq!(keys, ["archivedAt", "favoriteAt", "readState", "retiredAt", "title"]);
    }

    #[test]
    fn entries_without_a_migrated_session_are_dangling() {
        let metadata = parse(r#"{"version":2,"titles":{"a":"x","b":"y"},"archived":{"c":1}}"#);
        assert_eq!(metadata.dangling(|id| id == "a"), 2);
    }
}
