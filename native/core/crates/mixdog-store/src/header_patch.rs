//! The nested part of a header change (FORMAT.md §5.2 `meta`): `patch` names keys whose value is an object and carries, for
//! each, a change of that object's members, to any depth. A header key that is a map with one member changed (the
//! transcript-cache book's receipts, the compaction telemetry) is then written as that member; written whole, the book
//! alone was 276 MB of one session's 593 MB log.
//!
//! Writers state whole values. The log's writer, which holds the header each record lands on, writes the nested form when
//! it says the same in fewer bytes ([`narrowed`]); a header a change was computed against in memory can lose records that
//! never reach the log, so nothing above the writer can choose.

use std::collections::BTreeMap;
use std::collections::HashMap;

use serde_json::Map;
use serde_json::Value;

use crate::schema::record::HeaderChange;
use crate::schema::shared_header::HeaderMap;
use crate::schema::shared_header::same_encoding;

/// The keys other records fold into (`completion_receipts`, `work_stops`): a change of one is never narrowed against a
/// value those records may have moved within the same batch.
const FOLDED: [&str; 3] = ["completionReceipts", "stoppedWork", "owedStops"];

/// Applies `change` inside `object`: remove, merge, then the nested changes.
pub fn apply(object: &mut Map<String, Value>, change: &HeaderChange) {
    for key in &change.unset {
        object.shift_remove(key);
    }
    for (key, value) in &change.set {
        object.insert(key.clone(), value.clone());
    }
    apply_patches(object, &change.patch);
}

/// The `patch` of a change, on a header whose `unset` and `set` are applied: each named key's object takes its change. A
/// key that holds no object holds an empty one first.
pub fn apply_patches<H: HeaderMap + ?Sized>(header: &mut H, patch: &BTreeMap<String, HeaderChange>) {
    for (key, change) in patch {
        let value = header.value_or_insert(key, || Value::Object(Map::new()));
        if !value.is_object() {
            *value = Value::Object(Map::new());
        }
        if let Value::Object(object) = value {
            apply(object, change);
        }
    }
}

/// The change that makes `before` into `after`, member by member; `None` when the nested form cannot say it (it keeps the
/// members' order, and adds new ones last).
fn between(before: &Map<String, Value>, after: &Map<String, Value>) -> Option<HeaderChange> {
    let mut change = HeaderChange { unset: before.keys().filter(|key| !after.contains_key(*key)).cloned().collect(), ..HeaderChange::default() };
    for (key, value) in after {
        match (before.get(key), value) {
            (Some(was), now) if same_encoding(was, now) => {}
            (Some(Value::Object(was)), Value::Object(now)) => match between(was, now) {
                Some(inner) => drop(change.patch.insert(key.clone(), inner)),
                None => drop(change.set.insert(key.clone(), value.clone())),
            },
            _ => drop(change.set.insert(key.clone(), value.clone())),
        }
    }
    let mut made = before.clone();
    apply(&mut made, &change);
    (made.len() == after.len() && made.iter().zip(after).all(|((a, x), (b, y))| a == b && same_encoding(x, y))).then_some(change)
}

/// What the keys of the header are at one point of a write batch, where the batch's earlier changes moved them.
#[derive(Default)]
pub(crate) struct Moved(HashMap<String, Option<Value>>);

impl Moved {
    fn object<'a, H: HeaderMap + ?Sized>(&'a self, header: &'a H, key: &str) -> Option<&'a Map<String, Value>> {
        match self.0.get(key) {
            Some(moved) => moved.as_ref().and_then(Value::as_object),
            None => header.value(key).and_then(Value::as_object),
        }
    }

    /// `change` is written next: the object-valued keys it leaves, for the changes after it in the batch.
    fn note<H: HeaderMap + ?Sized>(&mut self, header: &H, change: &HeaderChange) {
        for key in &change.unset {
            self.0.insert(key.clone(), None);
        }
        for (key, value) in &change.set {
            self.0.insert(key.clone(), value.is_object().then(|| value.clone()));
        }
        for (key, inner) in &change.patch {
            let mut object = self.object(header, key).cloned().unwrap_or_default();
            apply(&mut object, inner);
            self.0.insert(key.clone(), Some(Value::Object(object)));
        }
    }

    /// `change` as the log takes it on `header` behind the batch's earlier changes: the nested form of every object it
    /// sets over an object, when the whole change is then fewer bytes; `None` to write it as it is.
    pub(crate) fn narrowed<H: HeaderMap + ?Sized>(&mut self, header: &H, change: &HeaderChange) -> Option<HeaderChange> {
        let mut narrow = change.clone();
        for (key, value) in &change.set {
            let Value::Object(after) = value else { continue };
            // A key the change also removes is set anew, not changed: its members before are not the value's base.
            if FOLDED.contains(&key.as_str()) || change.patch.contains_key(key) || change.unset.contains(key) {
                continue;
            }
            let Some(inner) = self.object(header, key).and_then(|before| between(before, after)) else { continue };
            narrow.set.shift_remove(key);
            narrow.patch.insert(key.clone(), inner);
        }
        self.note(header, change);
        let fewer = narrow.patch.len() > change.patch.len()
            && serde_json::to_vec(&narrow).is_ok_and(|narrow| serde_json::to_vec(change).is_ok_and(|whole| narrow.len() < whole.len()));
        fewer.then_some(narrow)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::schema::record::Header;

    fn map(value: Value) -> Header {
        let Value::Object(map) = value else { unreachable!() };
        map
    }

    fn set(key: &str, value: Value) -> HeaderChange {
        HeaderChange { set: map(json!({ key: value })), ..HeaderChange::default() }
    }

    /// A map-valued key set again with one member changed, one removed and one added is written as those members, to any
    /// depth, and the header it gives is byte for byte the one the whole value gives.
    #[test]
    fn a_map_set_again_is_written_as_the_members_that_changed_and_folds_to_the_same_bytes() {
        let filler = "r".repeat(600);
        let book = |touched: i64, extra: bool| {
            let mut receipts = map(json!({ "a": { "at": 1, "digest": filler }, "b": { "at": touched, "digest": filler }, "c": { "at": 3, "digest": filler } }));
            if extra {
                receipts.shift_remove("a");
                receipts.insert("d".into(), json!({ "at": 9, "digest": filler }));
            }
            json!({ "v": 5, "receipts": receipts, "sent": true })
        };
        let header = map(json!({ "title": "t", "book": book(2, false) }));
        let whole = set("book", book(7, true));
        let narrow = Moved::default().narrowed(&header, &whole).expect("fewer bytes");
        assert!(narrow.set.is_empty());
        let inner = &narrow.patch["book"].patch["receipts"];
        assert_eq!((inner.unset.clone(), inner.set.keys().map(String::as_str).collect::<Vec<_>>()), (vec!["a".to_owned()], vec!["d"]));
        assert_eq!(inner.patch["b"].set, map(json!({ "at": 7 })));
        // One of the three members the whole value holds is new and written in full; the other two are not written again.
        assert!(serde_json::to_vec(&narrow).unwrap().len() * 2 < serde_json::to_vec(&whole).unwrap().len());
        let (mut by_whole, mut by_narrow) = (header.clone(), header.clone());
        apply(&mut by_whole, &whole);
        apply(&mut by_narrow, &narrow);
        assert_eq!(serde_json::to_string(&by_narrow).unwrap(), serde_json::to_string(&by_whole).unwrap());
        // A change read from a log written before `patch` existed says what it said.
        let old: HeaderChange = serde_json::from_str(r#"{"set":{"title":"n"},"unset":["book"]}"#).unwrap();
        assert!(old.patch.is_empty());
        assert_eq!(serde_json::to_string(&old).unwrap(), r#"{"set":{"title":"n"},"unset":["book"]}"#);
    }

    /// What the nested form cannot say stays whole: a value whose members come in another order, one that is no shorter
    /// nested, a key another record folds into, and a key that held no object.
    #[test]
    fn a_change_the_nested_form_cannot_say_or_shorten_is_written_whole() {
        let filler = "r".repeat(600);
        let header = map(json!({ "book": { "a": filler, "b": 1 }, "small": { "a": 1 }, "completionReceipts": { "x": true, "y": filler }, "text": "t" }));
        for whole in [
            set("book", json!({ "b": 2, "a": filler })),
            set("small", json!({ "a": 2 })),
            set("completionReceipts", json!({ "y": filler })),
            set("text", json!({ "a": filler })),
            set("absent", json!({ "a": filler })),
        ] {
            assert_eq!(Moved::default().narrowed(&header, &whole), None, "{whole:?}");
        }
        // A change that removes the key and sets it replaces the value: nested against the members it removed, it would
        // fold to those members without the removed ones' place, here to `{"b":2}` in place of the value it states.
        let replaced = HeaderChange { unset: vec!["book".into()], ..set("book", json!({ "a": filler, "b": 2 })) };
        assert_eq!(Moved::default().narrowed(&header, &replaced), None);
        let mut folded = header.clone();
        apply(&mut folded, &replaced);
        assert_eq!(folded["book"], json!({ "a": filler, "b": 2 }));
    }

    /// Two changes of one batch: the second is narrowed against what the first leaves, not against the header before it.
    #[test]
    fn a_change_is_narrowed_against_the_batchs_earlier_changes() {
        let filler = "r".repeat(600);
        let header = map(json!({ "book": { "a": filler, "n": 1 } }));
        let mut moved = Moved::default();
        let first = set("book", json!({ "a": filler, "n": 2, "m": filler }));
        let first_written = moved.narrowed(&header, &first).unwrap_or(first);
        let second = set("book", json!({ "a": filler, "n": 2, "m": filler, "z": 1 }));
        let second_written = moved.narrowed(&header, &second).expect("narrowed");
        assert_eq!(second_written.patch["book"].set, map(json!({ "z": 1 })), "only what the second change adds");
        let mut folded = header.clone();
        apply(&mut folded, &first_written);
        apply(&mut folded, &second_written);
        assert_eq!(folded["book"], json!({ "a": filler, "n": 2, "m": filler, "z": 1 }));
        let mut gone = Moved::default();
        gone.narrowed(&header, &HeaderChange { unset: vec!["book".into()], ..HeaderChange::default() });
        assert_eq!(gone.narrowed(&header, &second), None, "the key the batch removed holds no object to change");
    }
}
