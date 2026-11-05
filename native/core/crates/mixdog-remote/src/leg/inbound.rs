//! What arrives on the desktop leg, classified once (remote-relay-envelope.ts and
//! remote-relay-inbound.ts): control answers, client lifecycle, claims, media, push verdicts and
//! phone frames. Nothing is parsed inside a phone frame.

use serde_json::Value;

use super::frame::{Payload, decode_binary_frame};

#[derive(Clone, Debug, PartialEq)]
pub enum Inbound {
    Capabilities(Value),
    /// A `clients-list` / `client-revoked` / `ice-servers` answer to a request.
    ControlAnswer(Value),
    NativePushResult(Value),
    WebPushSubscriptions(Value),
    WebPushResult(Value),
    PairCode(Value),
    ClientClaim(Value),
    /// `credential_id` is empty on a relay that does not name it: the leg stays untrusted.
    ClientOpen { client_id: String, credential_id: String },
    ClientClose(String),
    Media(Value),
    /// The relay refused an oversize frame instead of dropping the leg.
    FrameTooLarge(Value),
    Frame { client_id: String, payload: Payload },
    Ignored,
}

/// One relay message as an envelope. A binary frame becomes a `Frame`; text that is not a JSON
/// object is dropped.
pub fn read_message(text: Option<&str>, binary: Option<&[u8]>) -> Option<Inbound> {
    if let Some(raw) = binary {
        let frame = decode_binary_frame(raw)?;
        return Some(Inbound::Frame { client_id: frame.client_id, payload: frame.payload });
    }
    let value: Value = serde_json::from_str(text?).ok()?;
    value.is_object().then(|| classify(value))
}

fn string_field(envelope: &Value, name: &str) -> Option<String> {
    envelope.get(name).and_then(Value::as_str).map(str::to_owned)
}

pub fn classify(envelope: Value) -> Inbound {
    let kind = envelope.get("type").and_then(Value::as_str).unwrap_or_default().to_owned();
    match kind.as_str() {
        "relay-capabilities" => Inbound::Capabilities(envelope),
        "clients-list" | "client-revoked" | "ice-servers" => Inbound::ControlAnswer(envelope),
        "native-push-result" => Inbound::NativePushResult(envelope),
        "webpush-subscriptions" => Inbound::WebPushSubscriptions(envelope),
        "webpush-result" => Inbound::WebPushResult(envelope),
        "pair-code-issued" | "pair-code-used" => Inbound::PairCode(envelope),
        "client-claim" => Inbound::ClientClaim(envelope),
        "client-open" => match string_field(&envelope, "clientId") {
            Some(client_id) => Inbound::ClientOpen {
                client_id,
                credential_id: string_field(&envelope, "browserClientId").unwrap_or_default(),
            },
            None => Inbound::Ignored,
        },
        "client-close" => string_field(&envelope, "clientId").map_or(Inbound::Ignored, Inbound::ClientClose),
        "frame-too-large" => Inbound::FrameTooLarge(envelope),
        "frame" => match (string_field(&envelope, "clientId"), string_field(&envelope, "data")) {
            (Some(client_id), Some(data)) => Inbound::Frame { client_id, payload: Payload::Text(data) },
            _ => Inbound::Ignored,
        },
        other if other.starts_with("media-") => Inbound::Media(envelope),
        _ => Inbound::Ignored,
    }
}
