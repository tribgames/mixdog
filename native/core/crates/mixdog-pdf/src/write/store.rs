//! The object store of a document under edit: pdf-lib's `PDFContext` (indirect objects by reference, the next free
//! object number, the trailer's `Root`, `Encrypt`, `Info` and `ID`), with a record of which objects were assigned
//! since the document was loaded.
//!
//! Objects are the reader's [`Obj`]: a dictionary or stream sits in an `Arc`, so an edit goes through
//! [`ObjectStore::modify`], which clones what is shared (`Arc::make_mut`) and marks the object dirty.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use crate::object::{Dict, Obj, Ref};
use crate::stream::{ByteStream, FilterSpec, PdfStream};

/// How many references a lookup follows before it gives up (a reference that leads back to itself).
const MAX_REFERENCE_CHAIN: usize = 32;

/// One indirect object with its generation.
#[derive(Debug, Clone)]
pub(crate) struct Slot {
    pub(crate) generation: i64,
    pub(crate) obj: Obj,
}

/// The trailer entries a rewrite keeps: `Root`, `Encrypt`, `Info` and `ID` (pdf-lib's `trailerInfo`).
#[derive(Debug, Clone, Default)]
pub struct TrailerInfo {
    pub root: Option<Ref>,
    pub encrypt: Option<Ref>,
    pub info: Option<Ref>,
    /// The `/ID` array, a direct object.
    pub id: Option<Obj>,
}

/// Indirect objects by number, ascending.
#[derive(Debug, Clone, Default)]
pub struct ObjectStore {
    slots: BTreeMap<i64, Slot>,
    /// The largest object number ever assigned (`PDFContext.largestObjectNumber`): deleting does not lower it.
    largest: i64,
    dirty: BTreeSet<i64>,
    pub trailer: TrailerInfo,
}

impl ObjectStore {
    pub fn new() -> Self {
        ObjectStore::default()
    }

    /// The object read from a file: not dirty.
    pub(crate) fn insert_loaded(&mut self, r: Ref, obj: Obj) {
        self.largest = self.largest.max(r.num);
        self.slots.insert(r.num, Slot { generation: r.generation, obj });
    }

    /// `PDFContext.nextRef`: the next free object number, generation 0.
    pub fn next_ref(&mut self) -> Ref {
        self.largest += 1;
        Ref::new(self.largest, 0)
    }

    /// `PDFContext.largestObjectNumber`.
    pub fn largest_object_number(&self) -> i64 {
        self.largest
    }

    /// `PDFContext.assign`: the object `r` names becomes `obj`.
    pub fn assign(&mut self, r: Ref, obj: Obj) {
        self.largest = self.largest.max(r.num);
        self.dirty.insert(r.num);
        self.slots.insert(r.num, Slot { generation: r.generation, obj });
    }

    /// `PDFContext.register`: `obj` under a new reference.
    pub fn register(&mut self, obj: Obj) -> Ref {
        let r = self.next_ref();
        self.assign(r, obj);
        r
    }

    /// `PDFContext.delete`: whether there was an object.
    pub fn delete(&mut self, r: Ref) -> bool {
        if !self.holds(r) {
            return false;
        }
        self.dirty.insert(r.num);
        self.slots.remove(&r.num).is_some()
    }

    fn holds(&self, r: Ref) -> bool {
        self.slots.get(&r.num).is_some_and(|slot| slot.generation == r.generation)
    }

    /// The object `r` names, a reference left as it is.
    pub fn get(&self, r: Ref) -> Option<&Obj> {
        self.slots.get(&r.num).filter(|slot| slot.generation == r.generation).map(|slot| &slot.obj)
    }

    /// `PDFContext.lookup`: follows references to the object (a dangling reference is `None`, JavaScript's
    /// `undefined`; a `null` object is [`Obj::Null`]).
    pub fn resolve<'a>(&'a self, obj: &'a Obj) -> Option<&'a Obj> {
        let mut current = obj;
        for _ in 0..MAX_REFERENCE_CHAIN {
            match current {
                Obj::Ref(r) => current = self.get(*r)?,
                other => return Some(other),
            }
        }
        None
    }

    /// The dictionary of a dictionary or stream object, references followed.
    pub fn resolve_dict<'a>(&'a self, obj: &'a Obj) -> Option<&'a Arc<Dict>> {
        self.resolve(obj)?.dict_or_stream_dict()
    }

    /// `dict.lookup(key)`: the value under `key`, references followed.
    pub fn lookup<'a>(&'a self, dict: &'a Dict, key: &str) -> Option<&'a Obj> {
        self.resolve(dict.get_raw(key)?)
    }

    /// The dictionary object `r` names (a stream's dictionary too).
    pub fn dict(&self, r: Ref) -> Option<&Arc<Dict>> {
        self.get(r)?.dict_or_stream_dict()
    }

    /// Edits the object `r` names in place and marks it dirty; `None` when there is no such object.
    pub fn modify<T>(&mut self, r: Ref, edit: impl FnOnce(&mut Obj) -> T) -> Option<T> {
        let slot = self.slots.get_mut(&r.num).filter(|slot| slot.generation == r.generation)?;
        self.dirty.insert(r.num);
        Some(edit(&mut slot.obj))
    }

    /// Edits the dictionary of the dictionary or stream object `r` names; `None` when it is neither.
    pub fn modify_dict<T>(&mut self, r: Ref, edit: impl FnOnce(&mut Dict) -> T) -> Option<T> {
        self.modify(r, |obj| match obj {
            Obj::Dict(dict) => Some(edit(Arc::make_mut(dict))),
            Obj::Stream(stream) => Some(edit(Arc::make_mut(&mut Arc::make_mut(stream).dict))),
            _ => None,
        })
        .flatten()
    }

    /// The objects in ascending number order (pdf-lib's `enumerateIndirectObjects`).
    pub fn iter(&self) -> impl Iterator<Item = (Ref, &Obj)> {
        self.slots.iter().map(|(num, slot)| (Ref::new(*num, slot.generation), &slot.obj))
    }

    pub fn len(&self) -> usize {
        self.slots.len()
    }

    pub fn is_empty(&self) -> bool {
        self.slots.is_empty()
    }

    /// Whether any object was assigned, modified or deleted since the document was loaded.
    pub fn is_dirty(&self) -> bool {
        !self.dirty.is_empty()
    }

    /// The numbers of the objects assigned, modified or deleted since the document was loaded.
    pub fn dirty_numbers(&self) -> impl Iterator<Item = i64> + '_ {
        self.dirty.iter().copied()
    }
}

/// A stream object over `bytes` as they are to be written (already encoded as `chain` says). The dictionary keeps
/// what the caller put in it; `Length` is written on save.
pub fn stream_object(dict: Dict, bytes: Vec<u8>, chain: Vec<FilterSpec>) -> Obj {
    let raw = ByteStream::from_vec(bytes);
    Obj::Stream(Arc::new(PdfStream::new(Arc::new(dict), &raw, chain, None, false, false)))
}
