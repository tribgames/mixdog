//! Decoder for values recorded through the shared Node encoder
//! `benchmarks/rust-core/recorders/lib/exact.mjs`.
//!
//! JSON cannot hold every JavaScript value, so the encoder writes what it cannot hold as a tagged object
//! `{"$exact": kind, ...}`. [`Exact::decode`] maps each tag to an explicit variant, keeps object keys in
//! recorded order and fails on an unknown tag or a tag object of the wrong shape. [`Exact::plain`] lifts a
//! value a Rust entry returned (plain JSON, no tags) into the same type, so a replay compares whole values.

use base64::Engine as _;
use serde_json::Value;
use std::path::Path;

const TAG: &str = "$exact";

/// A JavaScript value as recorded. Object keys keep their recorded order.
#[derive(Debug, Clone, PartialEq)]
pub enum Exact {
    Null,
    Bool(bool),
    /// A finite number other than -0 (those have their own variants).
    Number(f64),
    String(String),
    Array(Vec<Exact>),
    Object(Vec<(String, Exact)>),
    Undefined,
    NaN,
    Infinity,
    NegInfinity,
    NegZero,
    /// An empty array slot.
    Hole,
    /// The decimal text of a bigint.
    BigInt(String),
    /// `ms` and `iso` are `None` for an invalid date.
    Date { ms: Option<i64>, iso: Option<String> },
    /// `type_name` is the JS class (`Buffer`, `Uint8Array`, `ArrayBuffer`, ...).
    Bytes { type_name: String, bytes: Vec<u8> },
    Map(Vec<(Exact, Exact)>),
    Set(Vec<Exact>),
    /// `code` and `cause` are `None` when the error had no such own property; `props` are its other
    /// own enumerable properties, in order. The stack is never recorded.
    Error { name: String, message: String, code: Option<Box<Exact>>, cause: Option<Box<Exact>>, props: Vec<(String, Exact)> },
}

impl Exact {
    /// Decodes an encoded value; the error names the path of the offending part.
    pub fn decode(value: &Value) -> Result<Exact, String> {
        decode_at(value, "$")
    }

    /// Reads and decodes a recording file, panicking with the path when it cannot.
    pub fn load(path: impl AsRef<Path>) -> Exact {
        let path = path.as_ref();
        let text = crate::read_string(path);
        let value: Value =
            serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));
        Exact::decode(&value).unwrap_or_else(|e| panic!("decode {}: {e}", path.display()))
    }

    /// A plain JSON value (what a Rust entry returns): no key is read as a tag.
    pub fn plain(value: &Value) -> Exact {
        match value {
            Value::Null => Exact::Null,
            Value::Bool(b) => Exact::Bool(*b),
            Value::Number(n) => number(n.as_f64().expect("serde_json numbers are f64-representable")),
            Value::String(s) => Exact::String(s.clone()),
            Value::Array(items) => Exact::Array(items.iter().map(Exact::plain).collect()),
            Value::Object(map) => Exact::Object(map.iter().map(|(k, v)| (k.clone(), Exact::plain(v))).collect()),
        }
    }

    /// The plain JSON form, when the value holds no tagged part; the error names the first one.
    pub fn to_plain(&self) -> Result<Value, String> {
        to_plain_at(self, "$")
    }

    /// The member `key` of an object; panics naming the key when absent or not an object.
    pub fn get(&self, key: &str) -> &Exact {
        self.try_get(key).unwrap_or_else(|| panic!("recording: no key {key:?} in {self:?}"))
    }

    pub fn try_get(&self, key: &str) -> Option<&Exact> {
        match self {
            Exact::Object(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Exact::String(s) => s,
            other => panic!("recording: expected a string, found {other:?}"),
        }
    }

    pub fn as_f64(&self) -> f64 {
        match self {
            Exact::Number(n) => *n,
            Exact::NegZero => -0.0,
            Exact::NaN => f64::NAN,
            Exact::Infinity => f64::INFINITY,
            Exact::NegInfinity => f64::NEG_INFINITY,
            other => panic!("recording: expected a number, found {other:?}"),
        }
    }

    pub fn as_bool(&self) -> bool {
        match self {
            Exact::Bool(b) => *b,
            other => panic!("recording: expected a boolean, found {other:?}"),
        }
    }

    pub fn as_array(&self) -> &[Exact] {
        match self {
            Exact::Array(items) => items,
            other => panic!("recording: expected an array, found {other:?}"),
        }
    }

    pub fn entries(&self) -> &[(String, Exact)] {
        match self {
            Exact::Object(entries) => entries,
            other => panic!("recording: expected an object, found {other:?}"),
        }
    }
}

/// A finite JSON number: -0 keeps its own variant so it never equals 0.
fn number(n: f64) -> Exact {
    if n == 0.0 && n.is_sign_negative() { Exact::NegZero } else { Exact::Number(n) }
}

/// The recorded number as a Rust f64 maps to its exact variant (NaN, the infinities and -0 included).
impl From<f64> for Exact {
    fn from(n: f64) -> Exact {
        if n.is_nan() {
            Exact::NaN
        } else if n == f64::INFINITY {
            Exact::Infinity
        } else if n == f64::NEG_INFINITY {
            Exact::NegInfinity
        } else {
            number(n)
        }
    }
}

fn decode_at(value: &Value, path: &str) -> Result<Exact, String> {
    Ok(match value {
        Value::Null => Exact::Null,
        Value::Bool(b) => Exact::Bool(*b),
        Value::Number(n) => {
            let f = n.as_f64().ok_or_else(|| format!("{path}: number {n} is not an f64"))?;
            if f == 0.0 && f.is_sign_negative() {
                return Err(format!("{path}: a raw -0 (the encoder tags -0)"));
            }
            Exact::Number(f)
        }
        Value::String(s) => Exact::String(s.clone()),
        Value::Array(items) => Exact::Array(
            items.iter().enumerate().map(|(i, x)| decode_at(x, &format!("{path}[{i}]"))).collect::<Result<_, _>>()?,
        ),
        Value::Object(map) => match map.get(TAG) {
            None => Exact::Object(
                map.iter()
                    .map(|(k, v)| decode_at(v, &format!("{path}.{k}")).map(|x| (k.clone(), x)))
                    .collect::<Result<_, _>>()?,
            ),
            Some(kind) => decode_tag(kind, map, path)?,
        },
    })
}

fn decode_tag(kind: &Value, map: &serde_json::Map<String, Value>, path: &str) -> Result<Exact, String> {
    let kind = kind.as_str().ok_or_else(|| format!("{path}: tag {kind} is not a string"))?;
    let shape = |allowed: &[&str], required: &[&str]| -> Result<(), String> {
        if let Some(extra) = map.keys().find(|k| *k != TAG && !allowed.contains(&k.as_str())) {
            return Err(format!("{path}: tag {kind:?} has an unexpected key {extra:?}"));
        }
        if let Some(missing) = required.iter().find(|k| !map.contains_key(**k)) {
            return Err(format!("{path}: tag {kind:?} lacks {missing:?}"));
        }
        Ok(())
    };
    let string = |key: &str| -> Result<String, String> {
        map[key].as_str().map(str::to_owned).ok_or_else(|| format!("{path}.{key}: not a string"))
    };
    let array = |key: &str| -> Result<&Vec<Value>, String> {
        map[key].as_array().ok_or_else(|| format!("{path}.{key}: not an array"))
    };
    fn pair<'v>(item: &'v Value, at: &str) -> Result<(&'v Value, &'v Value), String> {
        match item.as_array().map(Vec::as_slice) {
            Some([a, b]) => Ok((a, b)),
            _ => Err(format!("{at}: not a [key, value] pair")),
        }
    }
    let simple = |variant: Exact| shape(&[], &[]).map(|()| variant);
    match kind {
        "undefined" => simple(Exact::Undefined),
        "NaN" => simple(Exact::NaN),
        "Infinity" => simple(Exact::Infinity),
        "-Infinity" => simple(Exact::NegInfinity),
        "-0" => simple(Exact::NegZero),
        "hole" => simple(Exact::Hole),
        "bigint" => {
            shape(&["value"], &["value"])?;
            Ok(Exact::BigInt(string("value")?))
        }
        "date" => {
            shape(&["ms", "iso"], &["ms", "iso"])?;
            match (&map["ms"], &map["iso"]) {
                (Value::Null, Value::Null) => Ok(Exact::Date { ms: None, iso: None }),
                (Value::Number(ms), Value::String(iso)) => Ok(Exact::Date {
                    ms: Some(ms.as_i64().ok_or_else(|| format!("{path}.ms: not an integer"))?),
                    iso: Some(iso.clone()),
                }),
                _ => Err(format!("{path}: date needs ms and iso both null or both set")),
            }
        }
        "bytes" => {
            shape(&["type", "base64"], &["type", "base64"])?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(string("base64")?)
                .map_err(|e| format!("{path}.base64: {e}"))?;
            Ok(Exact::Bytes { type_name: string("type")?, bytes })
        }
        "map" => {
            shape(&["entries"], &["entries"])?;
            let mut out = Vec::new();
            for (i, item) in array("entries")?.iter().enumerate() {
                let at = format!("{path}.entries[{i}]");
                let (k, v) = pair(item, &at)?;
                out.push((decode_at(k, &format!("{at}[0]"))?, decode_at(v, &format!("{at}[1]"))?));
            }
            Ok(Exact::Map(out))
        }
        "set" => {
            shape(&["values"], &["values"])?;
            let values = array("values")?
                .iter()
                .enumerate()
                .map(|(i, x)| decode_at(x, &format!("{path}.values[{i}]")))
                .collect::<Result<_, _>>()?;
            Ok(Exact::Set(values))
        }
        "error" => {
            shape(&["name", "message", "code", "cause", "props"], &["name", "message", "props"])?;
            let optional = |key: &str| -> Result<Option<Box<Exact>>, String> {
                map.get(key).map(|v| decode_at(v, &format!("{path}.{key}")).map(Box::new)).transpose()
            };
            let props = match &map["props"] {
                Value::Object(props) => props
                    .iter()
                    .map(|(k, v)| decode_at(v, &format!("{path}.props.{k}")).map(|x| (k.clone(), x)))
                    .collect::<Result<_, _>>()?,
                _ => return Err(format!("{path}.props: not an object")),
            };
            Ok(Exact::Error {
                name: string("name")?,
                message: string("message")?,
                code: optional("code")?,
                cause: optional("cause")?,
                props,
            })
        }
        "object" => {
            shape(&["entries"], &["entries"])?;
            let mut out = Vec::new();
            for (i, item) in array("entries")?.iter().enumerate() {
                let at = format!("{path}.entries[{i}]");
                let (k, v) = pair(item, &at)?;
                let key = k.as_str().ok_or_else(|| format!("{at}[0]: key is not a string"))?;
                out.push((key.to_owned(), decode_at(v, &format!("{path}.{key}"))?));
            }
            Ok(Exact::Object(out))
        }
        other => Err(format!("{path}: unknown tag {other:?}")),
    }
}

fn to_plain_at(value: &Exact, path: &str) -> Result<Value, String> {
    Ok(match value {
        Exact::Null => Value::Null,
        Exact::Bool(b) => Value::Bool(*b),
        // An integral number is written as `JSON.stringify` writes it (`3`, never `3.0`): what a client sends and an integer
        // field of the core reads.
        Exact::Number(n) if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 => Value::from(*n as i64),
        Exact::Number(n) => serde_json::Number::from_f64(*n).map(Value::Number).ok_or_else(|| format!("{path}: {n}"))?,
        Exact::String(s) => Value::String(s.clone()),
        Exact::Array(items) => Value::Array(
            items.iter().enumerate().map(|(i, x)| to_plain_at(x, &format!("{path}[{i}]"))).collect::<Result<_, _>>()?,
        ),
        Exact::Object(entries) => Value::Object(
            entries
                .iter()
                .map(|(k, v)| to_plain_at(v, &format!("{path}.{k}")).map(|x| (k.clone(), x)))
                .collect::<Result<_, _>>()?,
        ),
        other => return Err(format!("{path}: {other:?} has no plain JSON form")),
    })
}

#[cfg(test)]
mod tests {
    use super::Exact;
    use serde_json::json;

    #[test]
    fn every_tag_decodes_to_its_variant_and_keys_keep_their_order() {
        let encoded = json!({
            "z": 1, "a": [{"$exact": "hole"}, {"$exact": "undefined"}],
            "n": [{"$exact": "NaN"}, {"$exact": "Infinity"}, {"$exact": "-Infinity"}, {"$exact": "-0"}],
            "b": {"$exact": "bigint", "value": "12345678901234567890"},
            "d": [{"$exact": "date", "ms": 0, "iso": "1970-01-01T00:00:00.000Z"}, {"$exact": "date", "ms": null, "iso": null}],
            "y": {"$exact": "bytes", "type": "Buffer", "base64": "AAH/"},
            "m": {"$exact": "map", "entries": [["k", 1]]},
            "s": {"$exact": "set", "values": [2]},
            "e": {"$exact": "error", "name": "TypeError", "message": "bad", "code": "E1", "props": {"x": true}},
            "o": {"$exact": "object", "entries": [["$exact", "own key"]]}
        });
        let decoded = Exact::decode(&encoded).expect("decodes");
        let keys: Vec<&str> = decoded.entries().iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["z", "a", "n", "b", "d", "y", "m", "s", "e", "o"]);
        assert_eq!(decoded.get("a"), &Exact::Array(vec![Exact::Hole, Exact::Undefined]));
        assert_eq!(decoded.get("n"), &Exact::Array(vec![Exact::NaN, Exact::Infinity, Exact::NegInfinity, Exact::NegZero]));
        assert_eq!(decoded.get("y"), &Exact::Bytes { type_name: "Buffer".into(), bytes: vec![0, 1, 255] });
        assert_eq!(decoded.get("m"), &Exact::Map(vec![(Exact::String("k".into()), Exact::Number(1.0))]));
        assert_eq!(
            decoded.get("e"),
            &Exact::Error {
                name: "TypeError".into(),
                message: "bad".into(),
                code: Some(Box::new(Exact::String("E1".into()))),
                cause: None,
                props: vec![("x".into(), Exact::Bool(true))],
            }
        );
        assert_eq!(decoded.get("o"), &Exact::Object(vec![("$exact".into(), Exact::String("own key".into()))]));
        assert_eq!(Exact::from(-0.0), Exact::NegZero);
        assert_ne!(Exact::plain(&json!(0)), Exact::NegZero);
    }

    #[test]
    fn an_unknown_tag_or_a_malformed_tag_fails_with_its_path() {
        assert_eq!(Exact::decode(&json!({"a": [{"$exact": "symbol"}]})).unwrap_err(), "$.a[0]: unknown tag \"symbol\"");
        assert!(Exact::decode(&json!({"$exact": "NaN", "x": 1})).unwrap_err().contains("unexpected key"));
        assert!(Exact::decode(&json!({"$exact": "bigint"})).unwrap_err().contains("lacks"));
    }
}
