//! The JSON-RPC envelope (P §3): the parity message kinds with no `"jsonrpc"`
//! member, string-or-integer ids, one message per WebSocket text frame.
//! Mixdog adds two top-level notification fields: `emittedAtMs` and `feed`.

use mixdog_protocol::FeedEpoch;
use mixdog_protocol::FeedId;
use mixdog_protocol::JsonValue;
use serde::Deserialize;
use serde::Serialize;

use crate::limits::CloseCode;

pub use mixdog_js::LoneAt;

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(untagged)]
pub enum RequestId {
    String(String),
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    Integer(i64),
}

impl std::fmt::Display for RequestId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::String(value) => f.write_str(value),
            Self::Integer(value) => write!(f, "{value}"),
        }
    }
}

/// W3C trace context carried on requests.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct W3cTraceContext {
    pub traceparent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracestate: Option<String>,
}

/// Position of a notification in its feed (P §6.1, X1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct FeedStamp {
    pub id: FeedId,
    pub epoch: FeedEpoch,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub seq: u64,
    /// A frame that stands for the run `from..=seq` (consecutive text appends of one item the writer coalesced). Only a connection
    /// that announced `feedRanges` at initialize gets one; resume positions stay single seqs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub from: Option<u64>,
}

/// Any message that can be decoded off the wire or encoded onto it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(untagged)]
pub enum JsonRpcMessage {
    Request(JsonRpcRequest),
    Notification(JsonRpcNotification),
    Response(JsonRpcResponse),
    Error(JsonRpcError),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct JsonRpcRequest {
    pub id: RequestId,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<JsonValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace: Option<W3cTraceContext>,
    /// Not on the wire: where in `params` an unpaired surrogate escape was read as U+FFFD
    /// ([`decode_inbound_text`]). The server refuses a request holding one outside its free-text
    /// fields ([`crate::free_text`]) before any service runs (decisions.md "frame-lone-surrogate").
    #[serde(skip)]
    #[cfg_attr(feature = "codegen", schemars(skip), ts(skip))]
    pub lone_surrogates: Vec<mixdog_js::LoneAt>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct JsonRpcNotification {
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<JsonValue>,
    /// Emission time of a server notification (a flattened field).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub emitted_at_ms: Option<i64>,
    /// Present on every notification that belongs to a feed; absent on
    /// connection-scoped notifications and client notifications.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feed: Option<FeedStamp>,
    /// Not on the wire: where in `params` of a client's notification an unpaired surrogate escape
    /// was read as U+FFFD (as [`JsonRpcRequest::lone_surrogates`]).
    #[serde(skip)]
    #[cfg_attr(feature = "codegen", schemars(skip), ts(skip))]
    pub lone_surrogates: Vec<mixdog_js::LoneAt>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct JsonRpcResponse {
    pub id: RequestId,
    pub result: JsonValue,
    /// Not on the wire: where in `result` of a client's answer an unpaired surrogate escape was
    /// read as U+FFFD (as [`JsonRpcRequest::lone_surrogates`]).
    #[serde(skip)]
    #[cfg_attr(feature = "codegen", schemars(skip), ts(skip))]
    pub lone_surrogates: Vec<mixdog_js::LoneAt>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct JsonRpcError {
    pub error: JsonRpcErrorBody,
    pub id: RequestId,
    /// Not on the wire: where in `error` of a client's error answer an unpaired surrogate escape
    /// was read as U+FFFD (as [`JsonRpcRequest::lone_surrogates`]).
    #[serde(skip)]
    #[cfg_attr(feature = "codegen", schemars(skip), ts(skip))]
    pub lone_surrogates: Vec<mixdog_js::LoneAt>,
}

impl JsonRpcMessage {
    /// Where the message's payload (`params`, `result`, `error`) held an unpaired surrogate escape.
    pub fn lone_surrogates(&self) -> &[mixdog_js::LoneAt] {
        match self {
            Self::Request(m) => &m.lone_surrogates,
            Self::Notification(m) => &m.lone_surrogates,
            Self::Response(m) => &m.lone_surrogates,
            Self::Error(m) => &m.lone_surrogates,
        }
    }
}

/// `data` is always `{"reason": "<camelCase>", …typed fields}` (`ErrorData`);
/// clients branch on `code` + `data.reason` only and never parse `message`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct JsonRpcErrorBody {
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub code: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<JsonValue>,
    pub message: String,
}

/// Outcome of decoding one inbound text frame (P §3 framing).
#[derive(Debug, Clone, PartialEq)]
pub enum InboundText {
    Message(JsonRpcMessage),
    /// Larger than `maxInboundFrameBytes`: close with 1009.
    TooLarge,
    /// Not a JSON-RPC message: no id to answer, close with 1007.
    Invalid,
}

impl InboundText {
    /// The close code a transport applies, if the frame ends the connection.
    pub fn close_code(&self) -> Option<CloseCode> {
        match self {
            Self::Message(_) => None,
            Self::TooLarge => Some(CloseCode::FrameTooBig),
            Self::Invalid => Some(CloseCode::InvalidFrame),
        }
    }
}

/// Decodes one inbound WebSocket text frame under the frame bound. A string escape of an unpaired
/// UTF-16 surrogate (`"\ud800"`, what JSON.stringify writes for text cut inside an emoji) is read as
/// U+FFFD: Node's `JSON.parse` accepts it, and a Rust string cannot hold the lone unit
/// (decisions.md "frame-lone-surrogate"). Every message kind names where in its payload (`params`,
/// `result`, `error`) that happened, values and keys apart ([`mixdog_js::LoneAt`]).
pub fn decode_inbound_text(frame: &str, max_inbound_frame_bytes: usize) -> InboundText {
    if frame.len() > max_inbound_frame_bytes {
        return InboundText::TooLarge;
    }
    let read = mixdog_js::json_well_formed_str(frame);
    let replaced = matches!(read, std::borrow::Cow::Owned(_));
    let Ok(mut message) = serde_json::from_str::<JsonRpcMessage>(&read) else { return InboundText::Invalid };
    if replaced {
        let found = mixdog_js::json_lone_surrogates(frame);
        // A place outside the payload (the id, the method name) keeps its whole pointer behind `#`: no free-text field
        // ([`crate::free_text`]) is there.
        let under = |prefix: &str| {
            found
                .iter()
                .map(|at| {
                    at.under(prefix).unwrap_or_else(|| match at {
                        mixdog_js::LoneAt::Value(pointer) => mixdog_js::LoneAt::Value(format!("#{pointer}")),
                        mixdog_js::LoneAt::Key(pointer) => mixdog_js::LoneAt::Key(format!("#{pointer}")),
                        mixdog_js::LoneAt::MergedKey(pointer) => mixdog_js::LoneAt::MergedKey(format!("#{pointer}")),
                        mixdog_js::LoneAt::Unit { pointer, at, unit } => mixdog_js::LoneAt::Unit { pointer: format!("#{pointer}"), at: *at, unit: *unit },
                    })
                })
                .collect::<Vec<_>>()
        };
        match &mut message {
            JsonRpcMessage::Request(m) => m.lone_surrogates = under("/params"),
            JsonRpcMessage::Notification(m) => m.lone_surrogates = under("/params"),
            JsonRpcMessage::Response(m) => m.lone_surrogates = under("/result"),
            JsonRpcMessage::Error(m) => m.lone_surrogates = under("/error"),
        }
    }
    InboundText::Message(message)
}
