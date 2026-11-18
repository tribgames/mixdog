//! A session header whose values are shared, not copied.
//!
//! A header is a map of every session key to its JSON value (FORMAT.md §5), and a few of its values are large: the tool
//! catalogs are hundreds of kilobytes, against a few kilobytes for everything else together. A session keeps its header
//! in several places at once (the acked state, the projected state, the copy other threads read) and makes a new copy on
//! every record that touches it, hundreds of times in a run. As a plain map each of those copies is a deep copy of every
//! value, the catalogs included, which was a third of what the core held at the peak of a run and most of what it
//! allocated and freed.
//!
//! Here each value is behind its own reference count: a copy of the header is one count per key, a change replaces only
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
        self.entries.insert(key, Arc::new(value))
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

impl From<Map<String, Value>> for SharedHeader {
    fn from(map: Map<String, Value>) -> Self {
        Self { entries: map.into_iter().map(|(key, value)| (key, Arc::new(value))).collect() }
    }
}

impl FromIterator<(String, Value)> for SharedHeader {
    fn from_iter<I: IntoIterator<Item = (String, Value)>>(entries: I) -> Self {
        Self { entries: entries.into_iter().map(|(key, value)| (key, Arc::new(value))).collect() }
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
