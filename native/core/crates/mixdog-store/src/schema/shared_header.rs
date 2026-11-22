//! A session header whose values are shared, not copied.
//!
//! A header is a map of every session key to its JSON value (FORMAT.md §5). Here each value is behind its own reference count: a copy of the header is one count per key, a change replaces only
//! the values it names, and the copies keep sharing the rest. The encoding is the map's own (the keys in insertion
//! order), so a log written with either type reads as the other.

use std::fmt;
use std::sync::Arc;

use indexmap::IndexMap;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;
use serde::de::MapAccess;
use serde::de::Visitor;
use serde::ser::SerializeMap;
use serde_json::Map;
use serde_json::Value;

/// A session header: the keys in insertion order, each value shared by every copy of the header that still holds it.
#[derive(Clone, Default, PartialEq)]
pub struct SharedHeader {
    entries: IndexMap<String, Arc<Value>>,
}

impl SharedHeader {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.entries.contains_key(key)
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.entries.get(key).map(|value| &**value)
    }

    /// The value with its count, for a holder that keeps it past the header (a request built from a catalog).
    pub fn get_shared(&self, key: &str) -> Option<&Arc<Value>> {
        self.entries.get(key)
    }

    /// The value to change in place. A value another copy of the header still holds is copied first, this once.
    pub fn get_mut(&mut self, key: &str) -> Option<&mut Value> {
        self.entries.get_mut(key).map(Arc::make_mut)
    }

    /// Sets `key`, keeping its place if it is there already (as the map does). Returns the value it replaced.
    pub fn insert(&mut self, key: String, value: Value) -> Option<Arc<Value>> {
        self.entries.insert(key, share(value))
    }

    /// [`Self::insert`] of a value that is already shared: another header's, or one kept once for many sessions.
    pub fn insert_shared(&mut self, key: String, value: Arc<Value>) -> Option<Arc<Value>> {
        self.entries.insert(key, value)
    }

    /// Removes `key`, the keys after it keeping their order (the map's `shift_remove`).
    pub fn shift_remove(&mut self, key: &str) -> Option<Arc<Value>> {
        self.entries.shift_remove(key)
    }

    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.entries.keys()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &Value)> {
        self.entries.iter().map(|(key, value)| (key, &**value))
    }

    /// The entries with their counts, for a copy into another header that shares the values.
    pub fn iter_shared(&self) -> impl Iterator<Item = (&String, &Arc<Value>)> {
        self.entries.iter()
    }

    /// The header as a plain map: a copy of every value, for a caller that needs the map itself.
    pub fn to_map(&self) -> Map<String, Value> {
        self.iter().map(|(key, value)| (key.clone(), value.clone())).collect()
    }
}

/// A value of at least this many bytes of text is held once in the process: every header that is given an equal one holds
/// the same allocation. A session's tool definitions, its deferred catalog and its prompt texts are such values, the same in
/// every session of a route, and each loaded session held its own copy of them.
const SHARED_ONCE_MIN_BYTES: usize = 2048;

/// The large values headers hold now, by content hash. An entry whose headers are all gone is dropped when its bucket is
/// next read, and the whole table is swept as it doubles.
struct SharedOnce {
    held: std::collections::HashMap<u64, Vec<std::sync::Weak<Value>>>,
    sweep_at: usize,
}

static SHARED_ONCE: std::sync::Mutex<Option<SharedOnce>> = std::sync::Mutex::new(None);

/// Whether `value` holds at least `left` bytes of text (strings and keys), counted only as far as that.
fn weighs(value: &Value, left: &mut usize) -> bool {
    match value {
        Value::String(text) => *left = left.saturating_sub(text.len()),
        Value::Array(items) => return items.iter().any(|item| weighs(item, left)),
        Value::Object(map) => {
            return map.iter().any(|(key, item)| {
                *left = left.saturating_sub(key.len());
                *left == 0 || weighs(item, left)
            });
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => *left = left.saturating_sub(1),
    }
    *left == 0
}

/// Whether the two are written as the same bytes. The value's own equality is wider: it takes `0.0` for `-0.0` and an
/// object for another with its members in a different order, and a header given the other one's allocation would then be
/// written back (a header read, a checkpoint) as bytes it never held.
pub(crate) fn same_encoding(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => match (a.is_f64(), b.is_f64()) {
            (true, true) => a.as_f64().map(f64::to_bits) == b.as_f64().map(f64::to_bits),
            (false, false) => a == b,
            _ => false,
        },
        (Value::Array(a), Value::Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same_encoding(a, b)),
        (Value::Object(a), Value::Object(b)) => a.len() == b.len() && a.iter().zip(b).all(|((key_a, a), (key_b, b))| key_a == key_b && same_encoding(a, b)),
        (Value::Number(_) | Value::Array(_) | Value::Object(_), _) | (_, Value::Number(_) | Value::Array(_) | Value::Object(_)) => false,
        _ => a == b,
    }
}

fn hash_of(value: &Value, state: &mut impl std::hash::Hasher) {
    use std::hash::Hash;
    match value {
        Value::Null => 0u8.hash(state),
        Value::Bool(flag) => (1u8, flag).hash(state),
        Value::Number(number) if number.is_f64() => (6u8, number.as_f64().map(f64::to_bits)).hash(state),
        Value::Number(number) => (2u8, number).hash(state),
        Value::String(text) => (3u8, text).hash(state),
        Value::Array(items) => {
            (4u8, items.len()).hash(state);
            items.iter().for_each(|item| hash_of(item, state));
        }
        Value::Object(map) => {
            (5u8, map.len()).hash(state);
            for (key, item) in map {
                key.hash(state);
                hash_of(item, state);
            }
        }
    }
}

/// `value` behind a count: its own, or for a large value the one every header with an equal value holds.
fn share(value: Value) -> Arc<Value> {
    if !weighs(&value, &mut { SHARED_ONCE_MIN_BYTES }) {
        return Arc::new(value);
    }
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    hash_of(&value, &mut hasher);
    let hash = std::hash::Hasher::finish(&hasher);
    let mut guard = SHARED_ONCE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let table = guard.get_or_insert_with(|| SharedOnce { held: std::collections::HashMap::new(), sweep_at: 64 });
    let bucket = table.held.entry(hash).or_default();
    bucket.retain(|held| held.strong_count() > 0);
    if let Some(held) = bucket.iter().filter_map(std::sync::Weak::upgrade).find(|held| same_encoding(held, &value)) {
        return held;
    }
    let value = Arc::new(value);
    bucket.push(Arc::downgrade(&value));
    if table.held.len() >= table.sweep_at {
        table.held.retain(|_, bucket| {
            bucket.retain(|held| held.strong_count() > 0);
            !bucket.is_empty()
        });
        table.sweep_at = (table.held.len() * 2).max(64);
    }
    value
}

/// What the folds of a header read and change of it, whichever type holds it (`completion_receipts`, `work_stops`).
pub trait HeaderMap {
    fn value(&self, key: &str) -> Option<&Value>;
    fn value_mut(&mut self, key: &str) -> Option<&mut Value>;
    /// The value at `key` to change in place, `default()` set there first when the header has none.
    fn value_or_insert(&mut self, key: &str, default: fn() -> Value) -> &mut Value;
}

impl HeaderMap for Map<String, Value> {
    fn value(&self, key: &str) -> Option<&Value> {
        self.get(key)
    }

    fn value_mut(&mut self, key: &str) -> Option<&mut Value> {
        self.get_mut(key)
    }

    fn value_or_insert(&mut self, key: &str, default: fn() -> Value) -> &mut Value {
        self.entry(key).or_insert_with(default)
    }
}

impl HeaderMap for SharedHeader {
    fn value(&self, key: &str) -> Option<&Value> {
        self.get(key)
    }

    fn value_mut(&mut self, key: &str) -> Option<&mut Value> {
        self.get_mut(key)
    }

    fn value_or_insert(&mut self, key: &str, default: fn() -> Value) -> &mut Value {
        Arc::make_mut(self.entries.entry(key.to_owned()).or_insert_with(|| Arc::new(default())))
    }
}

impl<T: HeaderMap + Clone> HeaderMap for Arc<T> {
    fn value(&self, key: &str) -> Option<&Value> {
        (**self).value(key)
    }

    fn value_mut(&mut self, key: &str) -> Option<&mut Value> {
        Arc::make_mut(self).value_mut(key)
    }

    fn value_or_insert(&mut self, key: &str, default: fn() -> Value) -> &mut Value {
        Arc::make_mut(self).value_or_insert(key, default)
    }
}

/// As the map's index: the value at a key the header holds.
impl std::ops::Index<&str> for SharedHeader {
    type Output = Value;

    fn index(&self, key: &str) -> &Value {
        self.get(key).expect("no entry found for key")
    }
}

impl From<Map<String, Value>> for SharedHeader {
    fn from(map: Map<String, Value>) -> Self {
        Self { entries: map.into_iter().map(|(key, value)| (key, share(value))).collect() }
    }
}

impl FromIterator<(String, Value)> for SharedHeader {
    fn from_iter<I: IntoIterator<Item = (String, Value)>>(entries: I) -> Self {
        Self { entries: entries.into_iter().map(|(key, value)| (key, share(value))).collect() }
    }
}

impl fmt::Debug for SharedHeader {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_map().entries(self.iter()).finish()
    }
}

impl Serialize for SharedHeader {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.entries.len()))?;
        for (key, value) in &self.entries {
            map.serialize_entry(key, &**value)?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for SharedHeader {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Entries;

        impl<'de> Visitor<'de> for Entries {
            type Value = SharedHeader;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a session header object")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<SharedHeader, A::Error> {
                let mut header = SharedHeader::new();
                // A key written twice keeps its first place and its last value, as the map reads it.
                while let Some((key, value)) = access.next_entry::<String, Value>()? {
                    header.insert(key, value);
                }
                Ok(header)
            }
        }

        deserializer.deserialize_map(Entries)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn sample() -> Map<String, Value> {
        let Value::Object(map) = json!({
            "id": "s1",
            "tools": [{ "name": "read", "schema": { "type": "object" } }],
            "model": "m",
            "usage": { "turns": 3 },
        }) else {
            unreachable!()
        };
        map
    }

    /// The header reads and writes as the map does: the same bytes, the keys in the same order, either way round.
    #[test]
    fn the_encoding_is_the_maps() {
        let map = sample();
        let header = SharedHeader::from(map.clone());
        let bytes = serde_json::to_vec(&header).unwrap();
        assert_eq!(bytes, serde_json::to_vec(&map).unwrap());
        assert_eq!(serde_json::from_slice::<SharedHeader>(&bytes).unwrap(), header);
        assert_eq!(serde_json::from_slice::<Map<String, Value>>(&bytes).unwrap(), header.to_map());
    }

    /// A copy shares every value; a change to one key of the copy leaves the original as it was and the other values
    /// shared.
    #[test]
    fn a_copy_shares_its_values_until_one_is_changed() {
        let original = SharedHeader::from(sample());
        let mut copy = original.clone();
        for key in ["id", "tools", "model", "usage"] {
            assert!(Arc::ptr_eq(original.get_shared(key).unwrap(), copy.get_shared(key).unwrap()), "{key}");
        }
        copy.insert("model".into(), json!("other"));
        copy.get_mut("usage").unwrap()["turns"] = json!(4);
        assert_eq!(original.get("model"), Some(&json!("m")));
        assert_eq!(original.get("usage"), Some(&json!({ "turns": 3 })));
        assert_eq!(copy.get("usage"), Some(&json!({ "turns": 4 })));
        assert!(Arc::ptr_eq(original.get_shared("tools").unwrap(), copy.get_shared("tools").unwrap()));
    }

    /// A key set again keeps its place; a key removed closes the gap; a key set after its removal goes last.
    #[test]
    fn the_keys_keep_the_maps_order() {
        let mut header = SharedHeader::from(sample());
        let mut map = sample();
        header.insert("tools".into(), json!([]));
        map.insert("tools".into(), json!([]));
        header.shift_remove("id");
        map.shift_remove("id");
        header.insert("id".into(), json!("s2"));
        map.insert("id".into(), json!("s2"));
        assert_eq!(header.keys().collect::<Vec<_>>(), map.keys().collect::<Vec<_>>());
        assert_eq!(header.to_map(), map);
        assert_eq!((header.len(), header.contains_key("id"), header.contains_key("gone")), (4, true, false));
    }

    /// A large value is one allocation for every header given an equal one, however each came by it (read from bytes, set,
    /// converted from a map), and a small value is each header's own. A header that changes its large value in place takes
    /// a copy and leaves the others' as it was; that copy is its own until a header is given the value again.
    #[test]
    fn a_large_value_is_held_once_by_every_header_that_holds_an_equal_one() {
        let catalog = json!((0..64).map(|n| json!({ "name": format!("tool-{n}"), "description": "d".repeat(64) })).collect::<Vec<_>>());
        let map = |model: &str| {
            let Value::Object(map) = json!({ "model": model, "deferredToolCatalog": catalog.clone() }) else { unreachable!() };
            map
        };
        let first = SharedHeader::from(map("a"));
        let read: SharedHeader = serde_json::from_slice(&serde_json::to_vec(&map("b")).unwrap()).unwrap();
        let mut set = SharedHeader::new();
        set.insert("deferredToolCatalog".into(), catalog.clone());
        for other in [&read, &set] {
            assert!(Arc::ptr_eq(first.get_shared("deferredToolCatalog").unwrap(), other.get_shared("deferredToolCatalog").unwrap()));
        }
        let (small_a, small_b) = (SharedHeader::from(map("m")), SharedHeader::from(map("m")));
        assert!(!Arc::ptr_eq(small_a.get_shared("model").unwrap(), small_b.get_shared("model").unwrap()), "a small value is not looked up");

        set.get_mut("deferredToolCatalog").unwrap()[0]["name"] = json!("changed");
        assert_eq!(first.get("deferredToolCatalog"), Some(&catalog));
        assert!(Arc::ptr_eq(first.get_shared("deferredToolCatalog").unwrap(), read.get_shared("deferredToolCatalog").unwrap()));
        assert!(!Arc::ptr_eq(first.get_shared("deferredToolCatalog").unwrap(), set.get_shared("deferredToolCatalog").unwrap()));
        let given = || SharedHeader::from_iter([("deferredToolCatalog".to_owned(), set.get("deferredToolCatalog").unwrap().clone())]);
        let (changed, again) = (given(), given());
        assert!(Arc::ptr_eq(changed.get_shared("deferredToolCatalog").unwrap(), again.get_shared("deferredToolCatalog").unwrap()));
        assert!(!Arc::ptr_eq(changed.get_shared("deferredToolCatalog").unwrap(), first.get_shared("deferredToolCatalog").unwrap()));
    }

    /// Two large values that are equal as values and written differently (a negative zero, the members in another order)
    /// are not one allocation: each header is written back as the bytes it was read from.
    #[test]
    fn a_header_given_a_value_written_differently_keeps_its_own_bytes() {
        let filler = "d".repeat(4096);
        for (one, other) in [
            (format!(r#"{{"big":{{"text":"{filler}","offset":0.0}}}}"#), format!(r#"{{"big":{{"text":"{filler}","offset":-0.0}}}}"#)),
            (format!(r#"{{"big":{{"text":"{filler}","offset":1}}}}"#), format!(r#"{{"big":{{"offset":1,"text":"{filler}"}}}}"#)),
        ] {
            let first: SharedHeader = serde_json::from_str(&one).unwrap();
            let second: SharedHeader = serde_json::from_str(&other).unwrap();
            let again: SharedHeader = serde_json::from_str(&one).unwrap();
            assert_eq!(serde_json::to_string(&first).unwrap(), one);
            assert_eq!(serde_json::to_string(&second).unwrap(), other, "the second header is written as it was read");
            assert!(Arc::ptr_eq(first.get_shared("big").unwrap(), again.get_shared("big").unwrap()), "the same bytes are still one allocation");
        }
    }

    /// A key written twice in the bytes keeps its first place and its last value, as the map reads it.
    #[test]
    fn a_repeated_key_reads_as_the_map_reads_it() {
        let bytes = br#"{"a":1,"b":2,"a":3}"#;
        let header: SharedHeader = serde_json::from_slice(bytes).unwrap();
        let map: Map<String, Value> = serde_json::from_slice(bytes).unwrap();
        assert_eq!(header.to_map(), map);
        assert_eq!(header.keys().collect::<Vec<_>>(), map.keys().collect::<Vec<_>>());
    }
}
