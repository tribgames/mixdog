//! The desktop's own leg to the relay (`/desktop`): framing, classification of what arrives,
//! the relay's per-connection capabilities, request/response control envelopes and the
//! dial/redial loop. The relay is untrusted and parses no phone payload.

pub mod caps;
pub mod control;
pub mod frame;
pub mod inbound;
pub mod redial;
pub mod socket;

use serde_json::{Value, json};

pub use caps::{NativePlatform, RelayCaps};
pub use control::{ControlError, ControlRequests};
pub use inbound::Inbound;
pub use socket::{LegConfig, LegEvent, Outgoing, run_leg};

/// The maximum message this leg accepts: the largest frame the relay may route to it.
pub const MAX_WS_PAYLOAD_BYTES: u64 = 71_303_168;

/// Everything a fresh leg sends before any frame, in order (remote-relay.ts onOpen): lanes, name,
/// version, then the phone token so no client leg can bind before it.
pub fn open_envelopes(pc_name: &str, app_version: Option<(&str, Option<&str>)>, client_token: &str) -> Vec<Value> {
    let mut frames = vec![
        json!({
            "type": "desktop-lanes", "media": true, "e2ee": 1, "maxPayloadBytes": MAX_WS_PAYLOAD_BYTES,
            "textFrames": 1, "pairV2": 1,
        }),
        json!({ "type": "desktop-name", "name": pc_name }),
    ];
    if let Some((version, renderer_release)) = app_version {
        let mut frame = json!({ "type": "desktop-version", "appVersion": version });
        if let (Some(release), Some(map)) = (renderer_release, frame.as_object_mut()) {
            map.insert("rendererRelease".into(), Value::from(release));
        }
        frames.push(frame);
    }
    frames.push(json!({ "type": "set-client-token", "token": client_token }));
    frames
}
