//! The phones attached through the relay: per-client encrypted channels, pairing claims, and the
//! paired-device list the relay reports (`list-clients`, `revoke-client`).

pub mod claims;
pub mod table;

use serde_json::{Map, Value, json};

pub use claims::{ClaimBindings, ClaimMethod, ClaimRequest, ClaimStep};
pub use table::{ClientTable, MAX_CLIENTS, Received, ReadyContext};

use crate::identity::ClientInfo;

/// The challenge members this core offers: exactly what its channel implements.
pub fn challenge_flags(binary_frames: bool, deflate: bool, transport: bool) -> Vec<&'static str> {
    let mut flags = vec!["mediaE2ee"];
    if binary_frames {
        flags.push("binaryFrames");
    }
    if deflate {
        flags.push("deflate");
    }
    if binary_frames && transport {
        flags.push("transportWebrtc");
    }
    flags
}

/// `list-clients` payload rows → display records (offline unless the caller marks them).
pub fn parse_client_list(rows: &Value) -> Vec<ClientInfo> {
    let Some(rows) = rows.as_array() else { return Vec::new() };
    rows.iter()
        .filter_map(|row| {
            let id = row.get("id")?.as_str().filter(|id| !id.is_empty())?;
            let text = |name: &str| row.get(name).and_then(Value::as_str).unwrap_or_default().to_owned();
            let time = |name: &str| row.get(name).and_then(Value::as_f64).map_or(0, |t| t as i64);
            Some(ClientInfo {
                id: id.to_owned(),
                name: text("name"),
                platform: text("platform"),
                browser: text("browser"),
                created_at: time("createdAt"),
                last_seen_at: time("lastSeenAt"),
                online: row.get("online") == Some(&Value::Bool(true)),
                pending_removal: false,
            })
        })
        .collect()
}

/// The payload of a `revoke-client` request.
pub fn revoke_payload(client_id: &str) -> Map<String, Value> {
    match json!({ "clientId": client_id }) {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}
