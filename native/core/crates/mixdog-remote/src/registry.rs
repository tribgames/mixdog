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
/// set, empty while its page is hidden or the app backgrounded, the browser id its direct
/// Web Push subscription is keyed by, the visualize panels its page shows
/// (`setVisualizePanels`) and whether the app is in the foreground (`setForeground`).
#[derive(Default)]
struct Screen {
    sessions: HashSet<String>,
    browser_id: String,
    /// A leg that never reported panels views none (`visualizePanelSessionIds?.has(..) === true`).
    visualize: HashSet<String>,
    /// Node's `RelayClientState.background`, `false` when the client is created
    /// (`remote-relay-clients.ts:294`), set by `setForeground(false)`.
    background: bool,
    /// The page reads the visualize lane (Node's `clientReadsLane(lanes, 'visualize')`, `remote-relay-clients.ts:124`): every page that has
    /// the visualize store loaded registers it, whatever it shows or whether it is in the foreground. Made by `visualize/command`
    /// `lane` on this connection; it ends with the connection.
    visualize_lane: bool,
}

/// One `ui/screenSessions/changed` of a bridged phone. `sessions`, `visualize` and `foreground` are
/// optional on the wire (Node's `setScreenSessions`, `setVisualizePanels` and `setForeground` were
/// separate calls): a report without one leaves the last stated value.
pub struct ScreenReport<'a> {
    pub sessions: Option<HashSet<String>>,
    pub browser_id: Option<&'a str>,
    /// The sessions whose visualize panel the page has on screen.
    pub visualize: Option<&'a [String]>,
    /// `setForeground`'s first parameter: false = the app is backgrounded.
    pub foreground: Option<bool>,
}

/// `filterSessionIds` of `desktop-state.ts:50-94`: a session id is `[A-Za-z0-9_-]+`, anything else
/// is dropped from the reported list.
fn is_session_id(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

enum Link {
    Local { device: String, kind: LocalKind },
    /// `generation`: the open of the peer this connection was made for (`connect_relay_in`); a connection resolves only to that open's
    /// record, never to a replacement's. None for a connection registered without one.
    Relay { peer_id: String, generation: Option<u64>, screen: Screen },
}

/// `setForeground`'s browser id is clipped to this many UTF-16 units.
const BROWSER_ID_MAX: usize = 64;

impl Inner {
    /// The paired device `peer_id` is attached as, for a connection made for `generation` (any, when it has none).
    fn described(&self, peer_id: &str, generation: Option<u64>) -> Option<&Described> {
        if generation.is_some_and(|made_for| self.generations.get(peer_id) != Some(&made_for)) {
            return None;
        }
        self.peers.get(peer_id)
    }

    fn attached(&self, peer_id: &str, generation: Option<u64>) -> bool {
        self.described(peer_id, generation).is_some()
    }
}

#[derive(Default)]
struct Inner {
    connections: HashMap<u64, Link>,
    /// Relay peer id → the paired device it is attached as.
    peers: HashMap<String, Described>,
    /// The open (`ClientTable` generation) each attached peer is: an id is reused when the relay re-announces it, so removing or
    /// changing what belongs to a peer names the generation it was made for, and is decided here, with the change. Absent for a peer
    /// attached without one (`attach_peer`).
    generations: HashMap<String, u64>,
    /// Relay peers revoked for their lifetime: live at an unpair, or admitted while one was in force. Only the screen reads it
    /// (Node's `revoked` set in `screen-access-publisher.ts`); the peer keeps its credential and everything else it holds.
    screen_revoked: HashSet<String>,
    /// Phones whose leg is a transport session: the last authenticated liveness (ms on `clock`)
    /// and whether the phone said it went to the background. Such a leg shows a session only
    /// while live (`foreground.ts` `legShowsSession`).
    transport: HashMap<String, TransportLeg>,
}

#[derive(Clone, Copy)]
struct TransportLeg {
    /// The open this leg belongs to; none for a leg set without one.
    generation: Option<u64>,
    live_at: Option<u64>,
    background: bool,
}

pub struct DeviceRegistry {
    inner: Mutex<Inner>,
    /// Orders the live view's writes to a phone against the end of its screen access: a write holds it from its check through the
    /// entry of its bytes into the phone's stream ([`write_view`](Self::write_view)), and [`revoke_screen`](Self::revoke_screen)
    /// takes it, so a write either entered before the revocation or is refused. Taken before `inner`, and a writer takes nothing
    /// under it that a holder of the runtime's state, a transport session or `inner` waits on it with.
    view_writes: Mutex<()>,
    /// Counts every change of who is attached or what is shown, written after the change is in
    /// place: what a caller waits on instead of polling [`describe`](Self::describe) and friends.
    changes: tokio::sync::watch::Sender<u64>,
    /// Monotonic milliseconds; replaceable so a test drives time by hand.
    clock: Box<dyn Fn() -> u64 + Send + Sync>,
}

impl DeviceRegistry {
    pub fn with_clock(clock: Box<dyn Fn() -> u64 + Send + Sync>) -> Self {
        Self { inner: Mutex::default(), view_writes: Mutex::default(), changes: tokio::sync::watch::Sender::new(0), clock }
    }

    /// The peer's leg is a transport session: it shows nothing until it shows liveness.
    pub fn set_peer_transport(&self, peer_id: &str) {
        self.inner().transport.insert(peer_id.to_owned(), TransportLeg { generation: None, live_at: None, background: false });
        self.changed();
    }

    /// [`set_peer_transport`](Self::set_peer_transport) for the open `generation`; a leg of a newer open stays.
    pub fn set_peer_transport_in(&self, generation: u64, peer_id: &str) {
        {
            let mut inner = self.inner();
            if inner.transport.get(peer_id).is_some_and(|leg| leg.generation.is_some_and(|held| held > generation)) {
                return;
            }
            inner.transport.insert(peer_id.to_owned(), TransportLeg { generation: Some(generation), live_at: None, background: false });
        }
        self.changed();
    }

    /// Authenticated inbound on the peer's transport session (`noteLegLive`), for the open `generation`.
    pub fn note_peer_live_in(&self, generation: u64, peer_id: &str) {
        let now = (self.clock)();
        if let Some(leg) = self.inner().transport.get_mut(peer_id).filter(|leg| leg.generation == Some(generation)) {
            leg.live_at = Some(now);
        }
    }

    /// The phone's session said `close{suspended}`: the leg of the open `generation` is in the background from now on.
    pub fn set_peer_background_in(&self, generation: u64, peer_id: &str) {
        if let Some(leg) = self.inner().transport.get_mut(peer_id).filter(|leg| leg.generation == Some(generation)) {
            leg.background = true;
        }
        self.changed();
    }

    fn leg_shows(&self, inner: &Inner, peer_id: &str, generation: Option<u64>) -> bool {
        match inner.transport.get(peer_id) {
            None => true,
            // A transport leg of another open of the id is not this connection's leg.
            Some(leg) if generation.is_some() && leg.generation.is_some() && leg.generation != generation => false,
            Some(leg) => {
                !leg.background
                    && leg.live_at.is_some_and(|at| (self.clock)().saturating_sub(at) < crate::transport::consts::FOREGROUND_STALE_MS)
            }
        }
    }

    /// The change counter: it moves after every attach, detach, connect, disconnect and screen report.
    pub fn watch(&self) -> tokio::sync::watch::Receiver<u64> {
        self.changes.subscribe()
    }

    fn changed(&self) {
        self.changes.send_modify(|count| *count += 1);
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A relay peer attached as the paired device `credential`. `device` is the device's display
    /// name (what `client.deviceName()` returns in Node); `browser` is what the device reported
    /// in its claim.
    pub fn attach_peer(&self, peer_id: &str, credential: &str, device: &str, browser: &str) {
        let kind = if browser == MIXDOG_DESKTOP_CLIENT_BROWSER { LinkKind::RemoteDesktop } else { LinkKind::Phone };
        {
            let mut inner = self.inner();
            inner.generations.remove(peer_id);
            inner.peers.insert(peer_id.to_owned(), Described { device: device.to_owned(), credential: credential.to_owned(), kind });
        }
        self.changed();
    }

    /// [`attach_peer`](Self::attach_peer) as the open `generation`: refused (false) while a newer open of the id is attached.
    pub fn attach_peer_in(&self, generation: u64, peer_id: &str, credential: &str, device: &str, browser: &str) -> bool {
        let kind = if browser == MIXDOG_DESKTOP_CLIENT_BROWSER { LinkKind::RemoteDesktop } else { LinkKind::Phone };
        {
            let mut inner = self.inner();
            if inner.generations.get(peer_id).is_some_and(|held| *held > generation) {
                return false;
            }
            inner.generations.insert(peer_id.to_owned(), generation);
            inner.peers.insert(peer_id.to_owned(), Described { device: device.to_owned(), credential: credential.to_owned(), kind });
        }
        self.changed();
        true
    }

    /// The peer's screen access ends for its lifetime; it stays attached under its credential.
    pub fn revoke_screen(&self, peer_id: &str) {
        let _writes = self.view_writes.lock().unwrap_or_else(PoisonError::into_inner);
        self.inner().screen_revoked.insert(peer_id.to_owned());
    }

    /// [`revoke_screen`](Self::revoke_screen) for the open `generation`: nothing for another open of the id.
    pub fn revoke_screen_in(&self, generation: u64, peer_id: &str) {
        let _writes = self.view_writes.lock().unwrap_or_else(PoisonError::into_inner);
        let mut inner = self.inner();
        if inner.generations.get(peer_id) == Some(&generation) {
            inner.screen_revoked.insert(peer_id.to_owned());
        }
    }

    /// One write of the live view (a browser frame, a WebRTC signal) to the peer: `write` runs, and puts the bytes into the phone's
    /// stream, only while the peer is attached and may still view (the patched Node's `mayWrite`, asked at the write), in one step
    /// with [`revoke_screen`](Self::revoke_screen). False when it was refused.
    pub fn write_view(&self, peer_id: &str, generation: u64, write: &mut dyn FnMut()) -> bool {
        let _writes = self.view_writes.lock().unwrap_or_else(PoisonError::into_inner);
        let allowed = {
            let inner = self.inner();
            inner.attached(peer_id, Some(generation)) && !inner.screen_revoked.contains(peer_id)
        };
        if allowed {
            write();
        }
        allowed
    }

    /// Whether the relay peer behind `connection` is revoked for the screen.
    pub fn screen_revoked(&self, connection: u64) -> bool {
        let inner = self.inner();
        matches!(inner.connections.get(&connection), Some(Link::Relay { peer_id, generation, .. }) if inner.attached(peer_id, *generation) && inner.screen_revoked.contains(peer_id))
    }

    /// Whether `connection` is a relay connection whose peer is attached (past its handshake, not yet closed by the relay).
    pub fn peer_attached(&self, connection: u64) -> bool {
        let inner = self.inner();
        matches!(inner.connections.get(&connection), Some(Link::Relay { peer_id, generation, .. }) if inner.attached(peer_id, *generation))
    }

    /// The relay client id behind `connection` while its peer is attached.
    pub fn attached_peer(&self, connection: u64) -> Option<String> {
        let inner = self.inner();
        match inner.connections.get(&connection) {
            Some(Link::Relay { peer_id, generation, .. }) if inner.attached(peer_id, *generation) => Some(peer_id.clone()),
            _ => None,
        }
    }

    /// Every connection of the paired credential still attached, in the order they were opened (Node's client registry is a `Map`
    /// iterated in admission order, and an unpair ends their browser streams in that order).
    pub fn connections_of(&self, credential: &str) -> Vec<u64> {
        let inner = self.inner();
        let mut ids: Vec<u64> = inner
            .connections
            .iter()
            .filter_map(|(id, link)| match link {
                Link::Relay { peer_id, generation, .. } if !credential.is_empty() && inner.described(peer_id, *generation).is_some_and(|d| d.credential == credential) => Some(*id),
                _ => None,
            })
            .collect();
        ids.sort_unstable();
        ids
    }

    /// `client-close`, a revoke or the loss of the leg.
    pub fn detach_peer(&self, peer_id: &str) {
        {
            let mut inner = self.inner();
            inner.peers.remove(peer_id);
            inner.generations.remove(peer_id);
            inner.screen_revoked.remove(peer_id);
            inner.transport.remove(peer_id);
        }
        self.changed();
    }

    /// `client-close`, a revoke or the loss of the leg, for the open `generation` of the id: what belongs to another open (a
    /// replacement attached since) is left, each part decided here with its removal. True when anything was removed.
    pub fn detach_peer_in(&self, generation: u64, peer_id: &str) -> bool {
        let removed = {
            let mut inner = self.inner();
            let mut removed = false;
            if inner.generations.get(peer_id) == Some(&generation) {
                inner.generations.remove(peer_id);
                removed |= inner.peers.remove(peer_id).is_some();
                removed |= inner.screen_revoked.remove(peer_id);
            }
            if inner.transport.get(peer_id).is_some_and(|leg| leg.generation == Some(generation)) {
                inner.transport.remove(peer_id);
                removed = true;
            }
            removed
        };
        if removed {
            self.changed();
        }
        removed
    }

    pub fn detach_all_peers(&self) {
        {
            let mut inner = self.inner();
            inner.peers.clear();
            inner.generations.clear();
            inner.screen_revoked.clear();
            inner.transport.clear();
        }
        self.changed();
    }

    /// The server accepted a local connection.
    pub fn connect_local(&self, connection: u64, device: &str, kind: LocalKind) {
        self.inner().connections.insert(connection, Link::Local { device: device.to_owned(), kind });
        self.changed();
    }

    /// The server accepted the connection a relay peer's bridge opened. It shows nothing until
    /// the phone reports a set.
    pub fn connect_relay(&self, connection: u64, peer_id: &str) {
        self.inner()
            .connections
            .insert(connection, Link::Relay { peer_id: peer_id.to_owned(), generation: None, screen: Screen::default() });
        self.changed();
    }

    /// [`connect_relay`](Self::connect_relay) for the connection the bridge opened for the open `generation` of the peer: it
    /// resolves to that open's record only, so once a replacement is attached the old connection is attached to nothing and its
    /// screen reports count for no one.
    pub fn connect_relay_in(&self, connection: u64, peer_id: &str, generation: u64) {
        self.inner()
            .connections
            .insert(connection, Link::Relay { peer_id: peer_id.to_owned(), generation: Some(generation), screen: Screen::default() });
        self.changed();
    }

    /// `ui/screenSessions/changed` from `connection`: false when it is no relay connection (the
    /// caller then treats it as the desktop's own report). The set replaces the last one; a
    /// browser id is kept until the phone states another.
    pub fn report_screen(&self, connection: u64, report: ScreenReport<'_>) -> bool {
        {
            let mut inner = self.inner();
            let Some(Link::Relay { screen, .. }) = inner.connections.get_mut(&connection) else { return false };
            if let Some(sessions) = report.sessions {
                screen.sessions = sessions.into_iter().filter(|id| is_session_id(id)).collect();
            }
            if let Some(id) = report.browser_id {
                screen.browser_id = slice_utf16(id, BROWSER_ID_MAX);
            }
            if let Some(panels) = report.visualize {
                screen.visualize = panels.iter().filter(|id| is_session_id(id)).cloned().collect();
            }
            if let Some(foreground) = report.foreground {
                screen.background = !foreground;
            }
        }
        self.changed();
        true
    }

    /// Whether a connection of the paired credential still attached shows `thread_id`: the
    /// question of native and relay Web Push.
    pub fn credential_shows(&self, credential: &str, thread_id: &str) -> bool {
        self.shown_by(|described, _| !credential.is_empty() && described.credential == credential, thread_id)
    }

    /// Every session some paired device views as a visualize panel: Node's `viewsSessionLane(id,
    /// REMOTE_VISUALIZE_LANE)` over all its clients (`remote-relay.ts:611`), each judged by
    /// `clientViewsSessionLane` (`remote-relay-clients.ts:134-141`). A client counts only with a
    /// live channel (a peer attached after its handshake) in the foreground, and only for the
    /// panels it reported.
    pub fn visualize_viewed_sessions(&self) -> std::collections::BTreeSet<String> {
        let inner = self.inner();
        inner
            .connections
            .values()
            .filter_map(|link| match link {
                Link::Relay { peer_id, generation, screen } if inner.attached(peer_id, *generation) && !screen.background => {
                    Some(screen.visualize.iter().cloned())
                }
                _ => None,
            })
            .flatten()
            .collect()
    }

    /// A relay connection's page registers (or drops) the visualize lane. False when `connection` is no relay connection.
    pub fn set_visualize_lane(&self, connection: u64, on: bool) -> bool {
        let mut inner = self.inner();
        let Some(Link::Relay { screen, .. }) = inner.connections.get_mut(&connection) else { return false };
        screen.visualize_lane = on;
        true
    }

    /// The attached relay connections a visualize change goes to: those whose page registered the visualize lane (Node's `readsVisualize`
    /// = `clientReadsLane(lanes, 'visualize')`, `remote-relay-push-lanes.ts`), not only those showing the session's panel (that is
    /// `clientViewsSessionLane`, a different predicate), so the event that opens the panel reaches a phone still on chat; or every
    /// attached one when `everyone` (an `openUrl`, which Node broadcast to all clients). In the order the connections were made.
    pub fn visualize_connections(&self, everyone: bool) -> Vec<u64> {
        let inner = self.inner();
        let mut ids: Vec<u64> = inner
            .connections
            .iter()
            .filter_map(|(id, link)| match link {
                Link::Relay { peer_id, generation, screen } if inner.attached(peer_id, *generation) && (everyone || screen.visualize_lane) => {
                    Some(*id)
                }
                _ => None,
            })
            .collect();
        ids.sort_unstable();
        ids
    }

    /// Whether any attached paired device shows `thread_id`: Node's `viewsSessionLane` (the
    /// desktop asks it before it opens a visualize tab for a session phones are watching).
    pub fn any_device_shows(&self, thread_id: &str) -> bool {
        self.shown_by(|_, _| true, thread_id)
    }
    /// Whether an attached connection that reported `browser_id` shows `thread_id`: the question
    /// of direct Web Push. Never answers for a credential.
    pub fn browser_shows(&self, browser_id: &str, thread_id: &str) -> bool {
        self.shown_by(|_, screen| !browser_id.is_empty() && screen.browser_id == browser_id, thread_id)
    }

    fn shown_by(&self, which: impl Fn(&Described, &Screen) -> bool, thread_id: &str) -> bool {
        let inner = self.inner();
        inner.connections.values().any(|link| match link {
            // Node's `legShowsSession` / `legacyLegShows`: a leg reported hidden shows nothing, whatever set it painted last.
            Link::Relay { peer_id, generation, screen } => {
                !screen.background
                    && screen.sessions.contains(thread_id)
                    && self.leg_shows(&inner, peer_id, *generation)
                    && inner.described(peer_id, *generation).is_some_and(|described| which(described, screen))
            }
            Link::Local { .. } => false,
        })
    }

    pub fn disconnect(&self, connection: u64) {
        self.inner().connections.remove(&connection);
        self.changed();
    }

    /// `None` for a connection the server never registered, or a relay peer no longer paired.
    pub fn describe(&self, connection: u64) -> Option<Described> {
        let inner = self.inner();
        match inner.connections.get(&connection)? {
            Link::Local { device, kind } => {
                Some(Described { device: device.clone(), credential: String::new(), kind: LinkKind::Local(*kind) })
            }
            Link::Relay { peer_id, generation, .. } => inner.described(peer_id, *generation).cloned(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The relay re-announces an id: the old open's teardown, which runs after the new open attached, leaves the new open's entry,
    /// its screen revocation and its transport leg alone, whichever part comes first.
    #[test]
    fn a_replacement_that_attached_before_an_old_opens_detach_keeps_its_registry_entry() {
        let registry = DeviceRegistry::default();
        assert!(registry.attach_peer_in(1, "p", "cred", "Pixel", "Safari"));
        // The replacement attaches before the old open's close reaches the registry.
        assert!(registry.attach_peer_in(2, "p", "cred", "Pixel", "Safari"));
        registry.set_peer_transport_in(2, "p");
        registry.revoke_screen_in(2, "p");
        assert!(!registry.detach_peer_in(1, "p"), "the old open detaches nothing");
        registry.revoke_screen_in(1, "p");
        registry.note_peer_live_in(1, "p");
        registry.set_peer_background_in(1, "p");
        let inner = registry.inner();
        assert!(inner.peers.contains_key("p") && inner.screen_revoked.contains("p") && inner.transport.get("p").is_some_and(|leg| !leg.background));
        drop(inner);
        // A late attach of the old open is refused, and the replacement's own detach removes everything it holds.
        assert!(!registry.attach_peer_in(1, "p", "cred", "Pixel", "Safari"));
        assert!(registry.detach_peer_in(2, "p"));
        let inner = registry.inner();
        assert!(inner.peers.is_empty() && inner.screen_revoked.is_empty() && inner.transport.is_empty() && inner.generations.is_empty());
    }

    /// A connection resolves only to the open it was made for: once a replacement of the peer is attached, the old connection is
    /// attached to nothing, shows no session, and its screen report counts for no one; the replacement's own connection does.
    #[test]
    fn an_old_connection_never_resolves_through_the_replacements_peer_record() {
        let registry = DeviceRegistry::default();
        registry.attach_peer_in(1, "p", "cred", "Pixel", "Safari");
        registry.connect_relay_in(10, "p", 1);
        let report = |sessions: &[&str]| ScreenReport {
            sessions: Some(sessions.iter().map(|id| (*id).to_owned()).collect()),
            browser_id: None,
            visualize: None,
            foreground: None,
        };
        registry.report_screen(10, report(&["thread"]));
        assert!(registry.any_device_shows("thread") && registry.peer_attached(10));
        // The relay re-announces the id; the replacement attaches before the old connection's cleanup has run.
        registry.attach_peer_in(2, "p", "cred", "Pixel", "Safari");
        registry.connect_relay_in(11, "p", 2);
        assert!(!registry.peer_attached(10) && registry.describe(10).is_none(), "the old connection is attached to nothing");
        assert!(!registry.any_device_shows("thread"), "its screen report counts for no one");
        assert!(registry.connections_of("cred") == vec![11]);
        registry.report_screen(11, report(&["thread"]));
        assert!(registry.any_device_shows("thread") && registry.peer_attached(11));
    }

    /// A visualize change goes to the connections whose page registered the visualize lane (Node's `clientReadsLane`), not to those
    /// whose panel is on screen: a phone in the foreground on chat, with no panel reported, still receives the event that opens it; a
    /// connection that never registered receives none, unless the event names a URL to open (every attached phone).
    #[test]
    fn a_visualize_change_goes_to_the_connections_that_registered_the_lane_whatever_they_show() {
        let registry = DeviceRegistry::default();
        for (connection, peer, generation) in [(10, "chat", 1), (11, "never", 2), (12, "gone", 3)] {
            registry.attach_peer_in(generation, peer, "cred", "Pixel", "Safari");
            registry.connect_relay_in(connection, peer, generation);
        }
        // `chat` is in the foreground on a session with no visualize panel reported.
        registry.report_screen(10, ScreenReport { sessions: Some(["chat-thread".to_owned()].into()), browser_id: None, visualize: None, foreground: Some(true) });
        assert!(registry.visualize_connections(false).is_empty(), "no lane is registered yet");
        assert!(registry.set_visualize_lane(10, true) && registry.set_visualize_lane(12, true));
        assert!(!registry.set_visualize_lane(99, true), "no such connection");
        registry.detach_peer_in(3, "gone");
        assert_eq!(registry.visualize_connections(false), vec![10], "registered and attached; no panel needed");
        assert_eq!(registry.visualize_connections(true), vec![10, 11], "a URL to open goes to every attached phone");
    }
}


impl Default for DeviceRegistry {
    fn default() -> Self {
        let start = std::time::Instant::now();
        Self::with_clock(Box::new(move || start.elapsed().as_millis() as u64))
    }
}
