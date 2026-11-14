//! The recording format shared by the recorder (which writes what the PowerShell hosts did) and the fake backend
//! (which replays it).
//!
//! A log is JSON lines. A line is one of:
//!
//! * a call: `{"seq":n,"obj":id,"kind":"get|put|putref|call|enum-next","member":"Name","flags":2,"lcid":0,"dispid":123,
//!   "args":[V...],"named":[["Name",V]...],"value":V,"result":V,"error":{...}}`. `args` are the positional arguments
//!   in the order the host wrote them; `value` is the assigned value of a put; `result` is the answer (`null` for the
//!   end of an enumeration); `error` replaces `result` when the call failed.
//! * a boundary marker: `{"seq":n,"boundary":"operation|snapshot|issues","name":"...","payload":{...}}`.
//! * a reviewed allowance: `{"allow":{"member":"Name","kind":"get","repeats":1}}`: after a call to that member of that
//!   kind, up to `repeats` immediately following identical recorded calls (a property PowerShell's binder read twice
//!   where the port reads once) are skipped.
//!
//! `V` is a typed value: `{"t":"i4","v":5}`, `{"t":"str","v":"x"}`, `{"t":"missing"}`, `{"t":"obj","v":id}` and so on
//! (see [`encode_value`]); arrays are `{"t":"array","dims":[[lbound,len],...],"data":[...]}` with `data` in storage
//! (column-major) order. `error` is `{"hresult":n,"inner_hresult":n,"message":"...","inner_message":"...",
//! "unknown_member":false}`.

use serde_json::Map;
use serde_json::Value as Json;
use serde_json::json;

use super::Dim;
use super::Kind;
use super::Obj;
use super::SafeArray;
use super::Value;
use super::value::Decimal;

/// The failure a recorded call ended in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ErrorRecord {
    /// `$_.Exception.HResult`.
    pub hresult: i32,
    /// The HRESULT of the innermost exception.
    pub inner_hresult: i32,
    /// `$_.Exception.Message`.
    pub message: String,
    /// The innermost exception's message.
    pub inner_message: String,
    /// The member does not exist.
    pub unknown_member: bool,
}

/// How a recorded call ended.
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    /// An answer, as a typed value (`{"t":"empty"}` for a put or a method with no result).
    Result(Json),
    /// The end of an enumeration.
    End,
    /// A failure.
    Error(ErrorRecord),
}

/// One recorded call.
#[derive(Clone, Debug, PartialEq)]
pub struct CallEntry {
    /// The order of the entry in the log.
    pub seq: u64,
    /// The receiver's object id.
    pub obj: u64,
    /// What the access was.
    pub kind: Kind,
    /// The member name.
    pub member: String,
    /// The Invoke flags.
    pub flags: u32,
    /// The LCID the binder passed.
    pub lcid: Option<u32>,
    /// The DISPID.
    pub dispid: Option<i32>,
    /// Positional arguments, typed.
    pub args: Vec<Json>,
    /// Named arguments, typed.
    pub named: Vec<(String, Json)>,
    /// The assigned value of a put, typed.
    pub value: Option<Json>,
    /// How it ended.
    pub outcome: Outcome,
}

/// A marker the recorder wrote around an operation, a snapshot or an issues call.
#[derive(Clone, Debug, PartialEq)]
pub struct Boundary {
    /// The order of the marker in the log.
    pub seq: u64,
    /// `operation`, `snapshot` or `issues`.
    pub kind: String,
    /// The operation's name.
    pub name: String,
    /// What the host was given (the operation JSON), when recorded.
    pub payload: Option<Json>,
}

/// One line of a log.
#[derive(Clone, Debug, PartialEq)]
pub enum Entry {
    /// A call.
    Call(CallEntry),
    /// A marker.
    Boundary(Boundary),
}

/// A reviewed allowance for a property the recording reads more often than the port does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Allowance {
    /// The member.
    pub member: String,
    /// The kind of access.
    pub kind: Kind,
    /// How many identical repeats right after a call may be skipped.
    pub repeats: u32,
}

/// A whole log.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CallLog {
    /// The recorded lines in order.
    pub entries: Vec<Entry>,
    /// The reviewed allowances.
    pub allowances: Vec<Allowance>,
}

fn kind_of(name: &str) -> Result<Kind, String> {
    Kind::from_name(name).ok_or_else(|| format!("unknown call kind \"{name}\""))
}

fn int(object: &Map<String, Json>, key: &str) -> Result<i64, String> {
    object.get(key).and_then(Json::as_i64).ok_or_else(|| format!("\"{key}\" is missing or not an integer"))
}

fn text(object: &Map<String, Json>, key: &str) -> Result<String, String> {
    object.get(key).and_then(Json::as_str).map(str::to_owned).ok_or_else(|| format!("\"{key}\" is missing or not a string"))
}

fn error_record(object: &Map<String, Json>) -> Result<ErrorRecord, String> {
    let hresult = int(object, "hresult")? as i32;
    Ok(ErrorRecord {
        hresult,
        inner_hresult: object.get("inner_hresult").and_then(Json::as_i64).map_or(hresult, |v| v as i32),
        message: object.get("message").and_then(Json::as_str).unwrap_or_default().to_owned(),
        inner_message: object.get("inner_message").and_then(Json::as_str).unwrap_or_default().to_owned(),
        unknown_member: object.get("unknown_member").and_then(Json::as_bool).unwrap_or(false),
    })
}

fn call_entry(object: &Map<String, Json>) -> Result<CallEntry, String> {
    let kind = kind_of(&text(object, "kind")?)?;
    let named = match object.get("named") {
        Some(Json::Array(pairs)) => pairs
            .iter()
            .map(|pair| match pair.as_array().map(Vec::as_slice) {
                Some([Json::String(name), value]) => Ok((name.clone(), value.clone())),
                _ => Err("\"named\" holds [name, value] pairs".to_owned()),
            })
            .collect::<Result<Vec<_>, _>>()?,
        _ => Vec::new(),
    };
    let outcome = if let Some(Json::Object(error)) = object.get("error") {
        Outcome::Error(error_record(error)?)
    } else {
        match object.get("result") {
            Some(Json::Null) => Outcome::End,
            Some(value) => Outcome::Result(value.clone()),
            None => Outcome::Result(json!({"t": "empty"})),
        }
    };
    Ok(CallEntry {
        seq: int(object, "seq")? as u64,
        obj: int(object, "obj")? as u64,
        kind,
        member: object.get("member").and_then(Json::as_str).unwrap_or_default().to_owned(),
        flags: int(object, "flags")? as u32,
        lcid: object.get("lcid").and_then(Json::as_u64).map(|v| v as u32),
        dispid: object.get("dispid").and_then(Json::as_i64).map(|v| v as i32),
        args: object.get("args").and_then(Json::as_array).cloned().unwrap_or_default(),
        named,
        value: object.get("value").cloned(),
        outcome,
    })
}

impl CallLog {
    /// Parses a log (blank lines are skipped). The error names the line.
    pub fn parse(source: &str) -> Result<CallLog, String> {
        let mut log = CallLog::default();
        for (number, line) in source.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let at = |message: String| format!("call log line {}: {message}", number + 1);
            let parsed: Json = serde_json::from_str(line).map_err(|error| at(error.to_string()))?;
            let Json::Object(object) = parsed else {
                return Err(at("a line is a JSON object".to_owned()));
            };
            if let Some(Json::Object(allow)) = object.get("allow") {
                log.allowances.push(Allowance {
                    member: text(allow, "member").map_err(&at)?,
                    kind: kind_of(&text(allow, "kind").map_err(&at)?).map_err(&at)?,
                    repeats: allow.get("repeats").and_then(Json::as_u64).unwrap_or(1) as u32,
                });
            } else if object.contains_key("boundary") {
                log.entries.push(Entry::Boundary(Boundary {
                    seq: int(&object, "seq").map_err(&at)? as u64,
                    kind: text(&object, "boundary").map_err(&at)?,
                    name: object.get("name").and_then(Json::as_str).unwrap_or_default().to_owned(),
                    payload: object.get("payload").cloned(),
                }));
            } else {
                log.entries.push(Entry::Call(call_entry(&object).map_err(&at)?));
            }
        }
        Ok(log)
    }

    /// The log as JSON lines.
    pub fn to_lines(&self) -> String {
        let mut out = String::new();
        for allowance in &self.allowances {
            let line = json!({"allow": {"member": allowance.member, "kind": allowance.kind.name(), "repeats": allowance.repeats}});
            out.push_str(&line.to_string());
            out.push('\n');
        }
        for entry in &self.entries {
            out.push_str(&entry_line(entry).to_string());
            out.push('\n');
        }
        out
    }
}

/// One entry as the JSON object a log line holds.
pub fn entry_line(entry: &Entry) -> Json {
    match entry {
        Entry::Boundary(boundary) => {
            let mut object = Map::new();
            object.insert("seq".into(), json!(boundary.seq));
            object.insert("boundary".into(), json!(boundary.kind));
            object.insert("name".into(), json!(boundary.name));
            if let Some(payload) = &boundary.payload {
                object.insert("payload".into(), payload.clone());
            }
            Json::Object(object)
        }
        Entry::Call(call) => {
            let mut object = Map::new();
            object.insert("seq".into(), json!(call.seq));
            object.insert("obj".into(), json!(call.obj));
            object.insert("kind".into(), json!(call.kind.name()));
            object.insert("member".into(), json!(call.member));
            object.insert("flags".into(), json!(call.flags));
            if let Some(lcid) = call.lcid {
                object.insert("lcid".into(), json!(lcid));
            }
            if let Some(dispid) = call.dispid {
                object.insert("dispid".into(), json!(dispid));
            }
            object.insert("args".into(), Json::Array(call.args.clone()));
            if !call.named.is_empty() {
                object.insert("named".into(), Json::Array(call.named.iter().map(|(name, value)| json!([name, value])).collect()));
            }
            if let Some(value) = &call.value {
                object.insert("value".into(), value.clone());
            }
            match &call.outcome {
                Outcome::Result(result) => {
                    object.insert("result".into(), result.clone());
                }
                Outcome::End => {
                    object.insert("result".into(), Json::Null);
                }
                Outcome::Error(error) => {
                    object.insert(
                        "error".into(),
                        json!({
                            "hresult": error.hresult,
                            "inner_hresult": error.inner_hresult,
                            "message": error.message,
                            "inner_message": error.inner_message,
                            "unknown_member": error.unknown_member,
                        }),
                    );
                }
            }
            Json::Object(object)
        }
    }
}

fn float(tag: &str, value: f64) -> Json {
    match serde_json::Number::from_f64(value) {
        Some(number) => json!({"t": tag, "v": number}),
        None => json!({"t": tag, "v": value.to_string()}),
    }
}

/// A value as its typed JSON. `object_id` names an object (the recording's id for it).
pub fn encode_value(value: &Value, object_id: &dyn Fn(&Obj) -> u64) -> Json {
    match value {
        Value::Empty => json!({"t": "empty"}),
        Value::Null => json!({"t": "null"}),
        Value::Missing => json!({"t": "missing"}),
        Value::Bool(v) => json!({"t": "bool", "v": v}),
        Value::I1(v) => json!({"t": "i1", "v": v}),
        Value::I2(v) => json!({"t": "i2", "v": v}),
        Value::I4(v) => json!({"t": "i4", "v": v}),
        Value::I8(v) => json!({"t": "i8", "v": v}),
        Value::UI1(v) => json!({"t": "ui1", "v": v}),
        Value::UI2(v) => json!({"t": "ui2", "v": v}),
        Value::UI4(v) => json!({"t": "ui4", "v": v}),
        Value::UI8(v) => json!({"t": "ui8", "v": v}),
        Value::R4(v) => float("r4", f64::from(*v)),
        Value::R8(v) => float("r8", *v),
        Value::Currency(v) => json!({"t": "cy", "v": v}),
        Value::Date(v) => float("date", *v),
        Value::Str(v) => json!({"t": "str", "v": v}),
        Value::Error(v) => json!({"t": "error", "v": v}),
        Value::Decimal(v) => json!({"t": "decimal", "v": v.to_string()}),
        Value::Dispatch(object) => json!({"t": "obj", "v": object_id(object)}),
        Value::Unknown(object) => json!({"t": "unknown", "v": object_id(object)}),
        Value::Array(array) => json!({
            "t": "array",
            "dims": array.dims().iter().map(|dim| json!([dim.lbound, dim.len])).collect::<Vec<_>>(),
            "data": array.data().iter().map(|item| encode_value(item, object_id)).collect::<Vec<_>>(),
        }),
    }
}

fn number(value: &Json, tag: &str) -> Result<f64, String> {
    match value.get("v") {
        Some(Json::Number(number)) => number.as_f64().ok_or_else(|| format!("{tag}: not a number")),
        Some(Json::String(text)) => text.parse::<f64>().map_err(|_| format!("{tag}: \"{text}\" is not a number")),
        _ => Err(format!("{tag}: \"v\" is missing")),
    }
}

fn integer<T: TryFrom<i64>>(value: &Json, tag: &str) -> Result<T, String> {
    let wide = value.get("v").and_then(Json::as_i64).ok_or_else(|| format!("{tag}: \"v\" is not an integer"))?;
    T::try_from(wide).map_err(|_| format!("{tag}: {wide} is out of range"))
}

/// A typed JSON value back as a [`Value`]. `resolve` makes the object an id stands for.
pub fn decode_value(json: &Json, resolve: &mut dyn FnMut(u64) -> Obj) -> Result<Value, String> {
    let tag = json.get("t").and_then(Json::as_str).ok_or_else(|| "a value has a \"t\"".to_owned())?;
    Ok(match tag {
        "empty" => Value::Empty,
        "null" => Value::Null,
        "missing" => Value::Missing,
        "bool" => Value::Bool(json.get("v").and_then(Json::as_bool).ok_or("bool: \"v\" is not a boolean")?),
        "i1" => Value::I1(integer(json, tag)?),
        "i2" => Value::I2(integer(json, tag)?),
        "i4" => Value::I4(integer(json, tag)?),
        "i8" => Value::I8(integer(json, tag)?),
        "ui1" => Value::UI1(integer(json, tag)?),
        "ui2" => Value::UI2(integer(json, tag)?),
        "ui4" => Value::UI4(integer(json, tag)?),
        "ui8" => Value::UI8(json.get("v").and_then(Json::as_u64).ok_or("ui8: \"v\" is not an unsigned integer")?),
        "r4" => Value::R4(number(json, tag)? as f32),
        "r8" => Value::R8(number(json, tag)?),
        "cy" => Value::Currency(integer(json, tag)?),
        "date" => Value::Date(number(json, tag)?),
        "str" => Value::Str(json.get("v").and_then(Json::as_str).ok_or("str: \"v\" is not a string")?.to_owned()),
        "error" => Value::Error(integer(json, tag)?),
        "decimal" => {
            let text = json.get("v").and_then(Json::as_str).ok_or("decimal: \"v\" is not a string")?;
            Value::Decimal(Decimal::parse(text).ok_or_else(|| format!("decimal: \"{text}\" is not a decimal"))?)
        }
        "obj" => Value::Dispatch(resolve(json.get("v").and_then(Json::as_u64).ok_or("obj: \"v\" is not an id")?)),
        "unknown" => Value::Unknown(resolve(json.get("v").and_then(Json::as_u64).ok_or("unknown: \"v\" is not an id")?)),
        "array" => {
            let dims = json
                .get("dims")
                .and_then(Json::as_array)
                .ok_or("array: \"dims\" is missing")?
                .iter()
                .map(|dim| match dim.as_array().map(Vec::as_slice) {
                    Some([lbound, len]) => Ok(Dim {
                        lbound: lbound.as_i64().ok_or("array: a lower bound is not an integer")? as i32,
                        len: len.as_u64().ok_or("array: a length is not an unsigned integer")? as u32,
                    }),
                    _ => Err("array: a dimension is [lbound, len]"),
                })
                .collect::<Result<Vec<_>, _>>()?;
            let mut data = Vec::new();
            for item in json.get("data").and_then(Json::as_array).ok_or("array: \"data\" is missing")? {
                data.push(decode_value(item, resolve)?);
            }
            Value::Array(SafeArray::new(dims, data).ok_or("array: the element count is not the product of the lengths")?)
        }
        other => return Err(format!("unknown value type \"{other}\"")),
    })
}
