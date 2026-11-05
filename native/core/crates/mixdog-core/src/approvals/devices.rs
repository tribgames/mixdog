//! The real [`Devices`]: connection → device and kind, read from the remote crate's registry.

use std::sync::Arc;

use mixdog_core_api::ids::ConnectionId;
use mixdog_protocol::ConnectionKind;
use mixdog_remote::registry::{DeviceRegistry, LinkKind, LocalKind};

use super::{DeviceInfo, Devices};

/// Stamped on a decision from a connection the registry does not know (never registered, or a
/// relay peer that was unpaired meanwhile): Node's fallback for a connection with no device
/// name (remote-session-methods.ts:42).
pub const UNKNOWN_DEVICE: &str = mixdog_remote::registry::DEFAULT_DEVICE_NAME;

pub struct RegistryDevices(Arc<DeviceRegistry>);

impl RegistryDevices {
    pub fn new(registry: Arc<DeviceRegistry>) -> Self {
        Self(registry)
    }
}

impl Devices for RegistryDevices {
    fn describe(&self, connection: ConnectionId) -> DeviceInfo {
        let Some(found) = self.0.describe(connection.0) else {
            return DeviceInfo { device: UNKNOWN_DEVICE.into(), kind: ConnectionKind::Cli };
        };
        let kind = match found.kind {
            LinkKind::RemoteDesktop => ConnectionKind::RemoteDesktop,
            LinkKind::Phone => ConnectionKind::Phone,
            LinkKind::Local(LocalKind::Desktop) => ConnectionKind::Desktop,
            LinkKind::Local(LocalKind::Tui) => ConnectionKind::Tui,
            LinkKind::Local(LocalKind::Cli) => ConnectionKind::Cli,
            LinkKind::Local(LocalKind::ChannelBridge) => ConnectionKind::ChannelBridge,
        };
        DeviceInfo { device: found.device, kind }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describes_local_relay_and_unknown_connections() {
        let registry = Arc::new(DeviceRegistry::default());
        let devices = RegistryDevices::new(registry.clone());
        registry.connect_local(1, "desktop-1", LocalKind::Desktop);
        registry.connect_relay(2, "peer-a");
        registry.connect_relay(3, "peer-b");
        registry.attach_peer("peer-a", "Pixel", "Safari");
        registry.attach_peer("peer-b", "cred-b", "Mixdog Desktop");
        let info = |id| devices.describe(ConnectionId(id));
        assert_eq!(info(1), DeviceInfo { device: "desktop-1".into(), kind: ConnectionKind::Desktop });
        assert_eq!(info(2), DeviceInfo { device: "Pixel".into(), kind: ConnectionKind::Phone });
        assert_eq!(info(3).kind, ConnectionKind::RemoteDesktop);
        assert_eq!(info(9).device, UNKNOWN_DEVICE);
        // Unpairing detaches the peer: its late decision is stamped unknown, not as the old device.
        registry.detach_peer("peer-a");
        assert_eq!(info(2).device, UNKNOWN_DEVICE);
        registry.disconnect(1);
        assert_eq!(info(1).device, UNKNOWN_DEVICE);
    }
}
