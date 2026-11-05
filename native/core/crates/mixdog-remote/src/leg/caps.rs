//! What the relay told THIS leg about itself (remote-relay-capabilities.ts). Every value
//! describes one connection: `reset` runs on every open, so a leg whose relay omits its
//! capabilities frame holds nothing from the last one.

use serde_json::Value;

pub const RELAY_DEFAULT_MAX_FRAME_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativePlatform {
    Apns,
    Fcm,
}

impl NativePlatform {
    pub fn name(self) -> &'static str {
        match self {
            Self::Apns => "apns",
            Self::Fcm => "fcm",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RelayCaps {
    binary_frames: bool,
    text_frames: bool,
    declared_limit: Option<u64>,
    noticed_limit: Option<u64>,
    native_platforms: Vec<NativePlatform>,
    web_push: bool,
    ice: bool,
}

/// What a `relay-capabilities` frame changes for the rest of the desktop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CapsUpdate {
    /// The relay can deliver native push: stored tokens are bound again.
    pub rebind_native_push: bool,
}

fn positive(value: &Value) -> Option<u64> {
    value.as_u64().filter(|n| *n > 0)
}

impl RelayCaps {
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    pub fn handle(&mut self, envelope: &Value) -> CapsUpdate {
        self.binary_frames = envelope.get("binaryFrames") == Some(&Value::from(1));
        // An acknowledgement, not an inference: `textFrames` on open is only a request.
        self.text_frames = envelope.get("textFrames") == Some(&Value::from(1));
        if let Some(limit) = envelope.get("maxFrameBytes").and_then(positive) {
            self.declared_limit = Some(limit);
        }
        self.native_platforms = match (envelope.get("nativePush"), envelope.get("nativePushPlatforms")) {
            (Some(on), Some(Value::Array(names))) if on.as_u64() == Some(1) => names
                .iter()
                .filter_map(|name| match name.as_str() {
                    Some("apns") => Some(NativePlatform::Apns),
                    Some("fcm") => Some(NativePlatform::Fcm),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        self.web_push = envelope.get("webPush") == Some(&Value::from(1));
        self.ice = envelope.get("ice") == Some(&Value::from(1));
        CapsUpdate { rebind_native_push: !self.native_platforms.is_empty() }
    }

    /// A refusal notice proved the ceiling smaller than believed.
    pub fn learn_refused_limit(&mut self, limit: u64) {
        self.noticed_limit = Some(self.noticed_limit.map_or(limit, |known| known.min(limit)));
    }

    /// The smallest known ceiling, so this leg's own check is never more permissive than the relay's.
    pub fn frame_limit(&self) -> u64 {
        [self.declared_limit, self.noticed_limit]
            .into_iter()
            .flatten()
            .min()
            .unwrap_or(RELAY_DEFAULT_MAX_FRAME_BYTES)
    }

    pub fn binary_frames(&self) -> bool {
        self.binary_frames
    }

    pub fn text_frames(&self) -> bool {
        self.text_frames
    }

    pub fn native_platforms(&self) -> &[NativePlatform] {
        &self.native_platforms
    }

    pub fn can_deliver_native(&self, platform: NativePlatform) -> bool {
        self.native_platforms.contains(&platform)
    }

    /// The relay owns the Web Push sender identity.
    pub fn web_push(&self) -> bool {
        self.web_push
    }

    /// The relay can issue TURN credentials.
    pub fn ice(&self) -> bool {
        self.ice
    }
}
