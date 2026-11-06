//! Who is on the other end of a connection: the registry the server's approvals read to stamp a
//! decision with the device and kind that answered it (P §8.1). The server registers a
//! connection when the transport accepts it and removes it when it ends; this PC registers each
//! paired phone's relay peer when the bridge opens it, with the credential the relay named.
//!
//! One short critical section per call, no I/O, so an approval never waits on a relay leg.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard, PoisonError};

use mixdog_js::slice_utf16;

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
    /// The display name.
    pub device: String,
    /// The paired credential id; empty for a local connection.
    pub credential: String,
    pub kind: LinkKind,
}

/// What a bridged phone said it is looking at (`ui/screenSessions/changed`): the whole effective
/// set, empty while its page is hidden or the app backgrounded, and the browser id its direct
/// Web Push subscription is keyed by.
#[derive(Default)]
struct Screen {
    sessions: HashSet<String>,
    browser_id: String,
}

enum Link {
    Local { device: String, kind: LocalKind },
    Relay { peer_id: String, screen: Screen },
}

/// `setForeground`'s browser id is clipped to this many UTF-16 units.
const BROWSER_ID_MAX: usize = 64;

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

    /// A relay peer attached as the paired device `credential`. `device` is the device's display
    /// name (what `client.deviceName()` returns in Node); `browser` is what the device reported
    /// in its claim.
    pub fn attach_peer(&self, peer_id: &str, credential: &str, device: &str, browser: &str) {
        let kind = if browser == MIXDOG_DESKTOP_CLIENT_BROWSER { LinkKind::RemoteDesktop } else { LinkKind::Phone };
        self.inner()
            .peers
            .insert(peer_id.to_owned(), Described { device: device.to_owned(), credential: credential.to_owned(), kind });
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

    /// The server accepted the connection a relay peer's bridge opened. It shows nothing until
    /// the phone reports a set.
    pub fn connect_relay(&self, connection: u64, peer_id: &str) {
        self.inner()
            .connections
            .insert(connection, Link::Relay { peer_id: peer_id.to_owned(), screen: Screen::default() });
    }

    /// `ui/screenSessions/changed` from `connection`: false when it is no relay connection (the
    /// caller then treats it as the desktop's own report). The set replaces the last one; a
    /// browser id is kept until the phone states another.
    pub fn report_screen(&self, connection: u64, sessions: HashSet<String>, browser_id: Option<&str>) -> bool {
        let mut inner = self.inner();
        let Some(Link::Relay { screen, .. }) = inner.connections.get_mut(&connection) else { return false };
        screen.sessions = sessions;
        if let Some(id) = browser_id {
            screen.browser_id = slice_utf16(id, BROWSER_ID_MAX);
        }
        true
    }

    /// Whether a connection of the paired credential still attached shows `thread_id`: the
    /// question of native and relay Web Push.
    pub fn credential_shows(&self, credential: &str, thread_id: &str) -> bool {
        self.shown_by(|described, _| !credential.is_empty() && described.credential == credential, thread_id)
    }

    /// Whether an attached connection that reported `browser_id` shows `thread_id`: the question
    /// of direct Web Push. Never answers for a credential.
    pub fn browser_shows(&self, browser_id: &str, thread_id: &str) -> bool {
        self.shown_by(|_, screen| !browser_id.is_empty() && screen.browser_id == browser_id, thread_id)
    }

    fn shown_by(&self, which: impl Fn(&Described, &Screen) -> bool, thread_id: &str) -> bool {
        let inner = self.inner();
        inner.connections.values().any(|link| match link {
            Link::Relay { peer_id, screen } => {
                screen.sessions.contains(thread_id) && inner.peers.get(peer_id).is_some_and(|described| which(described, screen))
            }
            Link::Local { .. } => false,
        })
    }

    pub fn disconnect(&self, connection: u64) {
        self.inner().connections.remove(&connection);
    }

    /// `None` for a connection the server never registered, or a relay peer no longer paired.
    pub fn describe(&self, connection: u64) -> Option<Described> {
        let inner = self.inner();
        match inner.connections.get(&connection)? {
            Link::Local { device, kind } => {
                Some(Described { device: device.clone(), credential: String::new(), kind: LinkKind::Local(*kind) })
            }
            Link::Relay { peer_id, .. } => inner.peers.get(peer_id).cloned(),
        }
    }
}
