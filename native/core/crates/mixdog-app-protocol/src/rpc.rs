//! The JSON-RPC envelope (P §3): the parity message kinds with no `"jsonrpc"`
//! member, string-or-integer ids, one message per WebSocket text frame.
//! Mixdog adds two top-level notification fields: `emittedAtMs` and `feed`.

use mixdog_protocol::FeedEpoch;
use mixdog_protocol::FeedId;
use mixdog_protocol::JsonValue;
use serde::Deserialize;
use serde::Serialize;

use crate::limits::CloseCode;

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
pub struct FeedStamp {
    pub id: FeedId,
    pub epoch: FeedEpoch,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub seq: u64,
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
    /// Not on the wire: the JSON pointers into `params` of the strings that held an unpaired
    /// surrogate escape, read as U+FFFD ([`decode_inbound_text`]). A service that must refuse
    /// what Node refuses for a lone code unit reads them (decisions.md "frame-lone-surrogate").
    #[serde(skip)]
    pub lone_surrogates: Vec<String>,
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct JsonRpcResponse {
    pub id: RequestId,
    pub result: JsonValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct JsonRpcError {
    pub error: JsonRpcErrorBody,
    pub id: RequestId,
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
/// (decisions.md "frame-lone-surrogate"). A request names where in its params that happened.
pub fn decode_inbound_text(frame: &str, max_inbound_frame_bytes: usize) -> InboundText {
    if frame.len() > max_inbound_frame_bytes {
        return InboundText::TooLarge;
    }
    let read = mixdog_js::json_well_formed_str(frame);
    let replaced = matches!(read, std::borrow::Cow::Owned(_));
    match serde_json::from_str::<JsonRpcMessage>(&read) {
        Ok(JsonRpcMessage::Request(mut request)) => {
            if replaced {
                request.lone_surrogates = mixdog_js::json_lone_surrogate_pointers(frame)
                    .into_iter()
                    .filter_map(|pointer| pointer.strip_prefix("/params").filter(|rest| rest.is_empty() || rest.starts_with('/')).map(str::to_owned))
                    .collect();
            }
            InboundText::Message(JsonRpcMessage::Request(request))
        }
        Ok(message) => InboundText::Message(message),
        Err(_) => InboundText::Invalid,
    }
}
