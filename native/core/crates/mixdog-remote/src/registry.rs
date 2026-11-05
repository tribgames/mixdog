//! Who is on the other end of a connection: the registry the server's approvals read to stamp a
//! decision with the device and kind that answered it (P §8.1). The server registers a
//! connection when the transport accepts it and removes it when it ends; this PC registers each
//! paired phone's relay peer when the bridge opens it, with the credential the relay named.
//!
//! One short critical section per call, no I/O, so an approval never waits on a relay leg.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

/// The `browser` a second PC's Mixdog desktop window reports in its pairing claim.
pub const MIXDOG_DESKTOP_CLIENT_BROWSER: &str = "Mixdog Desktop";

/// What Node stamps for a connection with no device name: `connectionDevice()`,
/// `(await client?.deviceName?.()) || 'Web app'` (apps/desktop/src/main/remote-session-methods.ts:42).
pub const DEFAULT_DEVICE_NAME: &str = "Web app";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkKind {
    /// A Mixdog desktop window on another PC, over the relay.
    RemoteDesktop,
    /// The phone app or a browser, over the relay.
    Phone,
    /// A local client (desktop window, TUI, CLI) with its own device name.
    Local(LocalKind),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalKind {
    Desktop,
    Tui,
    Cli,
    ChannelBridge,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Described {
    pub device: String,
    pub kind: LinkKind,
}

enum Link {
    Local { device: String, kind: LocalKind },
    Relay { peer_id: String },
}

#[derive(Default)]
struct Inner {
    connections: HashMap<u64, Link>,
    /// Relay peer id → the paired device it is attached as.
    peers: HashMap<String, Described>,
}

#[derive(Default)]
pub struct DeviceRegistry {
    inner: Mutex<Inner>,
}

impl DeviceRegistry {
    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A relay peer attached as a paired device. `device` is the device's display name (what
    /// `client.deviceName()` returns in Node); `browser` is what the device reported in its claim.
    pub fn attach_peer(&self, peer_id: &str, device: &str, browser: &str) {
        let kind = if browser == MIXDOG_DESKTOP_CLIENT_BROWSER { LinkKind::RemoteDesktop } else { LinkKind::Phone };
        self.inner().peers.insert(peer_id.to_owned(), Described { device: device.to_owned(), kind });
    }

    /// `client-close`, a revoke or the loss of the leg.
    pub fn detach_peer(&self, peer_id: &str) {
        self.inner().peers.remove(peer_id);
    }

    pub fn detach_all_peers(&self) {
        self.inner().peers.clear();
    }

    /// The server accepted a local connection.
    pub fn connect_local(&self, connection: u64, device: &str, kind: LocalKind) {
        self.inner().connections.insert(connection, Link::Local { device: device.to_owned(), kind });
    }

    /// The server accepted the connection a relay peer's bridge opened.
    pub fn connect_relay(&self, connection: u64, peer_id: &str) {
        self.inner().connections.insert(connection, Link::Relay { peer_id: peer_id.to_owned() });
    }

    pub fn disconnect(&self, connection: u64) {
        self.inner().connections.remove(&connection);
    }

    /// `None` for a connection the server never registered, or a relay peer no longer paired.
    pub fn describe(&self, connection: u64) -> Option<Described> {
        let inner = self.inner();
        match inner.connections.get(&connection)? {
            Link::Local { device, kind } => Some(Described { device: device.clone(), kind: LinkKind::Local(*kind) }),
            Link::Relay { peer_id } => inner.peers.get(peer_id).cloned(),
        }
    }
}
