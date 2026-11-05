//! Control messages of the stream core: the authenticated cumulative ack, repair, and
//! ping/pong (`readRemoteTransportControl`). Signals (offer/answer/candidate/close) are
//! validated by the carrier owner and pass through as JSON.

use serde_json::Value;

use super::consts::{MAX_ACK_RANGES, MAX_RECORDS_IN_FLIGHT};
use super::TransportError;

const VERSION: u64 = 1;
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// Cumulative over opened records, plus the selective ranges the receiver holds complete.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ack {
    pub through: u64,
    pub ranges: Vec<(u64, u64)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Repair {
    pub sequences: Vec<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ping {
    pub pong: bool,
    pub id: u64,
    pub sent: Option<u64>,
}

/// A message that came out of an authenticated control box, with that box's control-domain
/// sequence. Only these can release or re-send sender buffers, and the sequence orders acks
/// against repairs that arrive on different lanes. The fields are only set by
/// [`read_control`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Authenticated<T> {
    pub(super) message: T,
    pub(super) control_sequence: u64,
}

impl<T> Authenticated<T> {
    pub fn message(&self) -> &T {
        &self.message
    }
    pub fn control_sequence(&self) -> u64 {
        self.control_sequence
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Control {
    Ack(Authenticated<Ack>),
    Repair(Authenticated<Repair>),
    Ping(Authenticated<Ping>),
    /// A signal: parsed by the carrier owner.
    Signal(Value),
}

fn safe_integer(value: &Value) -> Option<u64> {
    if let Some(number) = value.as_u64() {
        return (number <= MAX_SAFE_INTEGER).then_some(number);
    }
    let float = value.as_f64()?;
    (float >= 0.0 && float.fract() == 0.0 && float <= MAX_SAFE_INTEGER as f64).then_some(float as u64)
}

fn positive(value: &Value, what: &str) -> Result<u64, TransportError> {
    safe_integer(value).filter(|number| *number >= 1).ok_or_else(|| TransportError::invalid(what))
}

fn ack_ranges(value: &Value, through: u64) -> Result<Vec<(u64, u64)>, TransportError> {
    let entries = value.as_array().filter(|entries| entries.len() <= MAX_ACK_RANGES).ok_or_else(|| TransportError::invalid("ack ranges"))?;
    let mut floor = through + 1;
    let mut ranges = Vec::with_capacity(entries.len());
    for entry in entries {
        let pair = entry.as_array().filter(|pair| pair.len() == 2).ok_or_else(|| TransportError::invalid("ack range"))?;
        let (Some(first), Some(last)) = (safe_integer(&pair[0]), safe_integer(&pair[1])) else {
            return Err(TransportError::invalid("ack range"));
        };
        if first < floor || last < first || last > through + MAX_RECORDS_IN_FLIGHT {
            return Err(TransportError::invalid("ack range"));
        }
        floor = last + 2;
        ranges.push((first, last));
    }
    Ok(ranges)
}

/// Reads one OPENED control box (`value` is its JSON, `sequence` its control sequence). A stale
/// copy yields `None`; malformed content is an error.
pub fn read_control(value: &Value, sequence: u64, stale: bool) -> Result<Option<Control>, TransportError> {
    if stale {
        return Ok(None);
    }
    let input = value.as_object().ok_or_else(|| TransportError::invalid("control"))?;
    let version_ok = || input.get("v").and_then(safe_integer) == Some(VERSION);
    let kind = input.get("t").and_then(Value::as_str);
    let control = match kind {
        Some("ack") => {
            if !version_ok() {
                return Err(TransportError::invalid("version"));
            }
            let through = input.get("through").and_then(safe_integer).ok_or_else(|| TransportError::invalid("ack"))?;
            let ranges = match input.get("ranges") {
                None => Vec::new(),
                Some(ranges) => ack_ranges(ranges, through)?,
            };
            Control::Ack(Authenticated { message: Ack { through, ranges }, control_sequence: sequence })
        }
        Some("repair") => {
            if !version_ok() {
                return Err(TransportError::invalid("version"));
            }
            let list = input
                .get("sequences")
                .and_then(Value::as_array)
                .filter(|list| !list.is_empty() && list.len() as u64 <= MAX_RECORDS_IN_FLIGHT)
                .ok_or_else(|| TransportError::invalid("repair"))?;
            let mut floor = 0;
            let mut sequences = Vec::with_capacity(list.len());
            for item in list {
                let item = positive(item, "repair")?;
                if item <= floor {
                    return Err(TransportError::invalid("repair order"));
                }
                floor = item;
                sequences.push(item);
            }
            Control::Repair(Authenticated { message: Repair { sequences }, control_sequence: sequence })
        }
        Some(t @ ("ping" | "pong")) => {
            if !version_ok() {
                return Err(TransportError::invalid("version"));
            }
            let sent = match (t, input.get("sent")) {
                ("ping", Some(sent)) => Some(safe_integer(sent).ok_or_else(|| TransportError::invalid("ping sent"))?),
                _ => None,
            };
            let id = positive(input.get("id").unwrap_or(&Value::Null), "ping id")?;
            Control::Ping(Authenticated { message: Ping { pong: t == "pong", id, sent }, control_sequence: sequence })
        }
        _ => Control::Signal(value.clone()),
    };
    Ok(Some(control))
}

/// `JSON.stringify(remoteTransportAck(through, ranges))`: the control plaintext to seal.
pub fn ack_json(through: u64, ranges: &[(u64, u64)]) -> String {
    if ranges.is_empty() {
        return format!(r#"{{"v":1,"t":"ack","through":{through}}}"#);
    }
    let list: Vec<String> = ranges.iter().map(|(first, last)| format!("[{first},{last}]")).collect();
    format!(r#"{{"v":1,"t":"ack","through":{through},"ranges":[{}]}}"#, list.join(","))
}

pub fn repair_json(sequences: &[u64]) -> String {
    let list: Vec<String> = sequences.iter().map(u64::to_string).collect();
    format!(r#"{{"v":1,"t":"repair","sequences":[{}]}}"#, list.join(","))
}

/// A ping (with `sent` when given) or the pong answering `id`.
pub fn ping_json(id: u64, sent: Option<u64>) -> String {
    match sent {
        Some(sent) => format!(r#"{{"v":1,"t":"ping","id":{id},"sent":{sent}}}"#),
        None => format!(r#"{{"v":1,"t":"ping","id":{id}}}"#),
    }
}

pub fn pong_json(id: u64) -> String {
    format!(r#"{{"v":1,"t":"pong","id":{id}}}"#)
}
