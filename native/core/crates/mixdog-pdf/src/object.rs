//! The objects of a PDF file as pdf.js's parser yields them: numbers (one kind, as in JavaScript, so `1.0` is an
//! integer where pdf.js asks `Number.isInteger`), strings as bytes, names and commands as strings of Latin-1
//! characters, arrays, dictionaries, streams, indirect references, and the two markers `EOF` and `CIRCULAR_REF`.
//!
//! A [`Dict`] holds raw values: an indirect reference stays a [`Obj::Ref`] until a lookup goes through the
//! [`crate::Xref`] (`Xref::get`, the counterpart of pdf.js's `Dict.get` that fetches on a reference).

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use crate::stream::PdfStream;

/// An indirect reference: `num gen R`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Ref {
    pub num: i64,
    pub generation: i64,
}

impl Ref {
    pub fn new(num: i64, generation: i64) -> Self {
        Ref { num, generation }
    }
}

impl fmt::Display for Ref {
    /// pdf.js's `Ref.toString()`: `12R`, or `12R3` for a non-zero generation.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.generation == 0 {
            write!(f, "{}R", self.num)
        } else {
            write!(f, "{}R{}", self.num, self.generation)
        }
    }
}

/// One PDF object.
#[derive(Debug, Clone)]
pub enum Obj {
    Null,
    Bool(bool),
    /// Integers and reals alike (a JavaScript number).
    Num(f64),
    /// A string's bytes (literal or hex, decrypted when the file is encrypted).
    Str(Arc<[u8]>),
    /// A name without the slash, `#xx` escapes resolved; each byte is one char (Latin-1).
    Name(Arc<str>),
    Array(Arc<Vec<Obj>>),
    Dict(Arc<Dict>),
    Stream(Arc<PdfStream>),
    Ref(Ref),
    /// An operator or keyword (`obj`, `R`, `endobj`, `BT`, `[`, `<<`, ...), as pdf.js's `Cmd`.
    Cmd(Arc<str>),
    /// pdf.js's `EOF` symbol: the lexer is at the end of the data.
    Eof,
    /// pdf.js's `CIRCULAR_REF` symbol: a fetch met a reference that is being fetched.
    CircularRef,
}

impl Obj {
    pub fn name(s: &str) -> Obj {
        Obj::Name(Arc::from(s))
    }

    pub fn cmd(s: &str) -> Obj {
        Obj::Cmd(Arc::from(s))
    }

    pub fn string(bytes: &[u8]) -> Obj {
        Obj::Str(Arc::from(bytes))
    }

    /// `isCmd(obj, cmd)`.
    pub fn is_cmd(&self, cmd: &str) -> bool {
        matches!(self, Obj::Cmd(c) if &**c == cmd)
    }

    /// `isName(obj, name)`.
    pub fn is_name(&self, name: &str) -> bool {
        matches!(self, Obj::Name(n) if &**n == name)
    }

    /// `Number.isInteger(obj)`: a finite number without a fraction.
    pub fn as_int(&self) -> Option<i64> {
        match self {
            Obj::Num(n) if n.is_finite() && n.fract() == 0.0 => Some(*n as i64),
            _ => None,
        }
    }

    /// `typeof obj === "number"`.
    pub fn as_num(&self) -> Option<f64> {
        match self {
            Obj::Num(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_name(&self) -> Option<&str> {
        match self {
            Obj::Name(n) => Some(n),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&[u8]> {
        match self {
            Obj::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&Arc<Vec<Obj>>> {
        match self {
            Obj::Array(a) => Some(a),
            _ => None,
        }
    }

    /// The dictionary of a [`Obj::Dict`] (not of a stream: see [`Obj::dict_or_stream_dict`]).
    pub fn as_dict(&self) -> Option<&Arc<Dict>> {
        match self {
            Obj::Dict(d) => Some(d),
            _ => None,
        }
    }

    pub fn as_stream(&self) -> Option<&Arc<PdfStream>> {
        match self {
            Obj::Stream(s) => Some(s),
            _ => None,
        }
    }

    /// The dictionary of a dictionary or of a stream (`if (obj instanceof BaseStream) obj = obj.dict`).
    pub fn dict_or_stream_dict(&self) -> Option<&Arc<Dict>> {
        match self {
            Obj::Dict(d) => Some(d),
            Obj::Stream(s) => Some(&s.dict),
            _ => None,
        }
    }

    pub fn as_ref_value(&self) -> Option<Ref> {
        match self {
            Obj::Ref(r) => Some(*r),
            _ => None,
        }
    }

    pub fn is_eof(&self) -> bool {
        matches!(self, Obj::Eof)
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Obj::Null)
    }
}

/// A dictionary: keys in insertion order, a repeated key replaces the value and keeps its place (a JavaScript `Map`).
#[derive(Debug, Clone, Default)]
pub struct Dict {
    entries: Vec<(Arc<str>, Obj)>,
    index: HashMap<Arc<str>, usize>,
    /// The reference this dictionary was fetched as (`Dict.objId`).
    pub obj_id: Option<String>,
    /// Set on the `/Encrypt` dictionary: its strings are not decrypted (`Dict.suppressEncryption`).
    pub suppress_encryption: bool,
}

impl Dict {
    pub fn new() -> Self {
        Dict::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn set(&mut self, key: &str, value: Obj) {
        if let Some(&at) = self.index.get(key) {
            self.entries[at].1 = value;
            return;
        }
        let key: Arc<str> = Arc::from(key);
        self.index.insert(key.clone(), self.entries.len());
        self.entries.push((key, value));
    }

    /// `Dict.setIfNotExists`.
    pub fn set_if_not_exists(&mut self, key: &str, value: Obj) {
        if !self.has(key) {
            self.set(key, value);
        }
    }

    pub fn has(&self, key: &str) -> bool {
        self.index.contains_key(key)
    }

    /// `Dict.getRaw`: the stored value, a reference left as it is. `None` is JavaScript's `undefined`.
    pub fn get_raw(&self, key: &str) -> Option<&Obj> {
        self.index.get(key).map(|&at| &self.entries[at].1)
    }

    /// `get_raw(key1)`, else `get_raw(key2)` (pdf.js's `dict.get("F", "Filter")`).
    pub fn get_raw2(&self, key1: &str, key2: &str) -> Option<&Obj> {
        self.get_raw(key1).or_else(|| self.get_raw(key2))
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|(k, _)| &**k)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &Obj)> {
        self.entries.iter().map(|(k, v)| (&**k, v))
    }

    pub fn delete(&mut self, key: &str) {
        let Some(at) = self.index.remove(key) else {
            return;
        };
        self.entries.remove(at);
        for slot in self.index.values_mut() {
            if *slot > at {
                *slot -= 1;
            }
        }
    }

    /// `Dict.merge`: the first value of each key wins; with `merge_sub_dicts` the dictionaries under one key are
    /// merged key by key. `None` where pdf.js returns the empty dictionary (nothing merged).
    pub fn merge(dicts: &[Obj], merge_sub_dicts: bool) -> Option<Dict> {
        let mut order: Vec<Arc<str>> = Vec::new();
        let mut properties: HashMap<Arc<str>, Vec<Obj>> = HashMap::new();
        for dict in dicts {
            let Obj::Dict(dict) = dict else {
                continue;
            };
            for (key, value) in &dict.entries {
                let property = properties.entry(key.clone()).or_insert_with(|| {
                    order.push(key.clone());
                    Vec::new()
                });
                let merges_in = merge_sub_dicts && matches!(value, Obj::Dict(_));
                if !property.is_empty() && !merges_in {
                    continue;
                }
                property.push(value.clone());
            }
        }
        let mut merged = Dict::new();
        for name in order {
            let values = &properties[&name];
            if values.len() == 1 || !matches!(values[0], Obj::Dict(_)) {
                merged.set(&name, values[0].clone());
                continue;
            }
            let mut sub = Dict::new();
            for value in values {
                if let Obj::Dict(d) = value {
                    for (key, value) in &d.entries {
                        sub.set_if_not_exists(key, value.clone());
                    }
                }
            }
            if !sub.is_empty() {
                merged.set(&name, Obj::Dict(Arc::new(sub)));
            }
        }
        if merged.is_empty() {
            None
        } else {
            Some(merged)
        }
    }
}
