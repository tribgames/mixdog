//! The language data: highlight.js 10.7.3 definitions dumped as uncompiled mode graphs, and the hook table for the few functions a definition holds.
//!
//! A dumped graph keeps object identity (a mode or keyword table shared by several modes is one entry),
//! because the compiler's result depends on it: `compileMode` mutates shared objects.

pub(crate) mod callbacks;
pub(crate) mod callbacks_extra;
mod generated_index;

use serde_json::Value;

/// A value of a dumped object, as JavaScript holds it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Raw {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    /// A `RegExp`: its `source` (the flags are ignored, as `compileLanguage` ignores them).
    Re(String),
    /// A plain object of the same graph, by index.
    Obj(usize),
    /// A function of the hook table, by id.
    Cb(String),
    Arr(Vec<Raw>),
}

impl Raw {
    /// JavaScript truthiness.
    pub(crate) fn truthy(&self) -> bool {
        match self {
            Raw::Null => false,
            Raw::Bool(b) => *b,
            Raw::Num(n) => *n != 0.0 && !n.is_nan(),
            Raw::Str(s) => !s.is_empty(),
            Raw::Re(_) | Raw::Obj(_) | Raw::Cb(_) | Raw::Arr(_) => true,
        }
    }

    /// `source(value)` of core.js for a string or a `RegExp`; `None` for anything falsy.
    pub(crate) fn source(&self) -> Option<&str> {
        match self {
            Raw::Str(s) if !s.is_empty() => Some(s),
            Raw::Re(s) => Some(s),
            _ => None,
        }
    }
}

/// A plain object: ordered fields, as `Object.keys` lists them.
#[derive(Debug, Clone, Default)]
pub(crate) struct RawObject {
    pub(crate) frozen: bool,
    pub(crate) fields: Vec<(String, Raw)>,
}

impl RawObject {
    pub(crate) fn get(&self, key: &str) -> Option<&Raw> {
        self.fields.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    /// The field when it is JavaScript-truthy.
    pub(crate) fn truthy(&self, key: &str) -> Option<&Raw> {
        self.get(key).filter(|v| v.truthy())
    }

    pub(crate) fn flag(&self, key: &str) -> bool {
        self.get(key).is_some_and(Raw::truthy)
    }

    pub(crate) fn set(&mut self, key: &str, value: Raw) {
        match self.fields.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = value,
            None => self.fields.push((key.to_string(), value)),
        }
    }

    pub(crate) fn remove(&mut self, key: &str) -> Option<Raw> {
        let at = self.fields.iter().position(|(k, _)| k == key)?;
        Some(self.fields.remove(at).1)
    }

    pub(crate) fn string(&self, key: &str) -> Option<&str> {
        match self.get(key) {
            Some(Raw::Str(s)) => Some(s),
            _ => None,
        }
    }
}

/// One dumped language.
#[derive(Debug, Clone)]
pub(crate) struct RawLanguage {
    pub(crate) name: String,
    pub(crate) root: usize,
    pub(crate) objects: Vec<RawObject>,
}

/// The facts of the registry: registration order of all highlight.js languages, the final alias table,
/// and the names this crate carries.
#[derive(Debug, Clone)]
pub(crate) struct RegistryFacts {
    pub(crate) order: Vec<String>,
    pub(crate) aliases: Vec<(String, String)>,
}

fn raw_value(v: &Value) -> Raw {
    match v {
        Value::Null => Raw::Null,
        Value::Bool(b) => Raw::Bool(*b),
        Value::Number(n) => Raw::Num(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => Raw::Str(s.clone()),
        Value::Array(items) => Raw::Arr(items.iter().map(raw_value).collect()),
        Value::Object(map) => {
            if let Some(Value::String(src)) = map.get("re") {
                Raw::Re(src.clone())
            } else if let Some(Value::String(id)) = map.get("cb") {
                Raw::Cb(id.clone())
            } else if let Some(Value::Number(n)) = map.get("o") {
                Raw::Obj(n.as_u64().unwrap_or(0) as usize)
            } else {
                Raw::Null
            }
        }
    }
}

fn parse_language(name: &str, text: &str) -> Option<RawLanguage> {
    let doc: Value = serde_json::from_str(text).ok()?;
    let root = doc.get("root")?.as_u64()? as usize;
    let objects: Vec<RawObject> = doc
        .get("objects")?
        .as_array()?
        .iter()
        .map(|o| {
            let frozen = o.get("frozen").and_then(Value::as_bool).unwrap_or(false);
            let fields: Vec<(String, Raw)> = o
                .get("f")
                .and_then(Value::as_array)
                .map(|pairs| {
                    pairs
                        .iter()
                        .filter_map(|pair| {
                            let pair = pair.as_array()?;
                            Some((pair.first()?.as_str()?.to_string(), raw_value(pair.get(1)?)))
                        })
                        .collect()
                })
                .unwrap_or_default();
            RawObject { frozen, fields }
        })
        .collect();
    Some(RawLanguage {
        name: name.to_string(),
        root,
        objects,
    })
}

/// Every language carried by the crate, in registration order.
pub(crate) fn load_languages() -> Vec<RawLanguage> {
    generated_index::LANGUAGES
        .iter()
        .filter_map(|(name, text)| parse_language(name, text))
        .collect()
}

pub(crate) fn load_registry() -> RegistryFacts {
    let doc: Value = serde_json::from_str(generated_index::REGISTRY).unwrap_or(Value::Null);
    let order = doc
        .get("order")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let aliases = doc
        .get("aliases")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|pair| {
                    let pair = pair.as_array()?;
                    Some((
                        pair.first()?.as_str()?.to_string(),
                        pair.get(1)?.as_str()?.to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    RegistryFacts { order, aliases }
}
