//! The forward cases of the desktop's `connections/ports.test.mjs`, with scripted tunnels and loopback ports (no ssh runs and no
//! port is bound).

use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicU16, AtomicUsize, Ordering};

use mixdog_ssh::command::{FailureClass, SshError};
use mixdog_rt::DurabilityIo;

use super::*;
use crate::paths::ConnectionsPaths;

struct FakeTunnel {
    local: u16,
    state: watch::Sender<TunnelState>,
    revived: AtomicUsize,
}

#[async_trait]
impl ForwardTunnel for FakeTunnel {
    fn local_port(&self) -> u16 {
        self.local
    }

    fn state(&self) -> watch::Receiver<TunnelState> {
        self.state.subscribe()
    }

    fn revive(&self) {
        self.revived.fetch_add(1, Ordering::SeqCst);
    }

    async fn stop(&self) {
        self.state.send_replace(TunnelState::Stopped { failure: None });
    }
}

/// Every tunnel starts up at once, unless `fail` holds a message: then it stops with that failure.
#[derive(Default)]
struct Tunnels {
    made: Mutex<Vec<(u16, Arc<FakeTunnel>)>>,
    fail: Mutex<Option<String>>,
}

impl Tunnels {
    fn count(&self) -> usize {
        self.made.lock().unwrap().len()
    }

    fn tunnel(&self, index: usize) -> Arc<FakeTunnel> {
        self.made.lock().unwrap()[index].1.clone()
    }

    fn stopped(&self, index: usize) -> bool {
        matches!(*self.tunnel(index).state.borrow(), TunnelState::Stopped { failure: None })
    }

    fn revived(&self) -> Vec<usize> {
        self.made.lock().unwrap().iter().map(|(_, tunnel)| tunnel.revived.load(Ordering::SeqCst)).collect()
    }
}

impl TunnelFactory for Tunnels {
    fn start(&self, local: u16, remote: u16) -> Arc<dyn ForwardTunnel> {
        let initial = match self.fail.lock().unwrap().clone() {
            Some(message) => TunnelState::Stopped { failure: Some(SshError::new(message, FailureClass::Terminal)) },
            None => TunnelState::Up,
        };
        let tunnel = Arc::new(FakeTunnel { local, state: watch::channel(initial).0, revived: AtomicUsize::new(0) });
        self.made.lock().unwrap().push((remote, tunnel.clone()));
        tunnel
    }
}

struct Loopback {
    busy: HashSet<u16>,
    next_free: AtomicU16,
}

#[async_trait]
impl LocalPorts for Loopback {
    async fn is_free(&self, port: u16) -> bool {
        !self.busy.contains(&port)
    }

    fn free_port(&self) -> io::Result<u16> {
        Ok(self.next_free.fetch_add(1, Ordering::SeqCst))
    }
}

struct Rig {
    ports: ServerPortForwards,
    tunnels: Arc<Tunnels>,
    store: Arc<PortForwardStore>,
}

fn io_lane() -> DurabilityIo {
    mixdog_rt::testing::tokens().durability_io
}

fn store_in(dir: &Path) -> Arc<PortForwardStore> {
    Arc::new(PortForwardStore::new(&ConnectionsPaths::new(dir), io_lane()))
}

fn rig(store: Arc<PortForwardStore>, busy: &[u16]) -> Rig {
    let tunnels = Arc::new(Tunnels::default());
    let local = Arc::new(Loopback { busy: busy.iter().copied().collect(), next_free: AtomicU16::new(50_000) });
    let ports = ServerPortForwards::with_parts("box".to_owned(), store.clone(), tunnels.clone(), local, Duration::from_millis(200));
    Rig { ports, tunnels, store }
}

fn listening(port: u16) -> ListeningPort {
    ListeningPort { port, addresses: vec!["0.0.0.0".to_owned()], process: None, pid: None }
}

fn active(remote_port: u16, local_port: u16) -> PortForward {
    PortForward { remote_port, local_port, status: PortForwardStatus::Active, message: None }
}

fn saved(remote_port: u16, local_port: u16) -> SavedPortForward {
    SavedPortForward { remote_port, local_port }
}

#[tokio::test]
async fn a_forward_takes_the_servers_port_number_when_it_is_free_here_any_free_port_otherwise() {
    let dir = tempfile::tempdir().unwrap();
    let f = rig(store_in(dir.path()), &[5173]);
    assert_eq!(f.ports.forward(3000, None).await.unwrap(), active(3000, 3000));
    assert_eq!(f.ports.forward(5173, None).await.unwrap().local_port, 50_000, "busy here: a free port instead");
    let privileged = f.ports.forward(80, None).await.unwrap();
    assert!(privileged.local_port >= LOWEST_LOCAL_PORT, "a server port below 1024 maps to an unprivileged local port");
    assert_eq!(f.store.get("box").await.unwrap(), [saved(80, 50_001), saved(3000, 3000), saved(5173, 50_000)]);
    // The asked-for local port is used as is or refused.
    assert_eq!(f.ports.forward(9000, Some(443)).await.unwrap_err().code, PortErrorCode::PortPrivileged);
    let busy = f.ports.forward(9000, Some(5173)).await.unwrap_err();
    assert_eq!((busy.code, busy.to_string()), (PortErrorCode::PortBusy, "port-busy: Port 5173 on this PC is already in use.".to_owned()));
    assert_eq!(f.ports.forward(0, None).await.unwrap_err().code, PortErrorCode::PortInvalid);
    assert_eq!(f.ports.forward(9000, Some(0)).await.unwrap_err().code, PortErrorCode::PortInvalid);
    assert_eq!(f.tunnels.count(), 3, "refusals start no ssh");
    // A second request for a forwarded port joins it.
    assert_eq!(f.ports.forward(3000, None).await.unwrap().local_port, 3000);
    assert_eq!(f.tunnels.count(), 3);
    assert_eq!(f.ports.browser_url(3000).unwrap(), "http://127.0.0.1:3000/");
    assert_eq!(f.ports.browser_url(4000).unwrap_err().code, PortErrorCode::PortNotActive);
}

#[tokio::test]
async fn two_requests_for_one_port_share_one_start() {
    let dir = tempfile::tempdir().unwrap();
    let f = rig(store_in(dir.path()), &[]);
    let (first, second) = tokio::join!(f.ports.forward(3000, None), f.ports.forward(3000, None));
    assert_eq!(first.unwrap(), second.unwrap());
    assert_eq!(f.tunnels.count(), 1);
}

#[tokio::test]
async fn forwards_are_saved_per_server_stop_forgets_one_closing_keeps_them_and_reconnecting_restores_them() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_in(dir.path());
    let first = rig(store.clone(), &[]);
    first.ports.forward(3000, None).await.unwrap();
    first.ports.forward(8080, Some(18_080)).await.unwrap();
    first.ports.stop(8080).await;
    assert!(first.tunnels.stopped(1));
    assert_eq!(store.get("box").await.unwrap(), [saved(3000, 3000)]);
    first.ports.forward(8080, Some(18_080)).await.unwrap();
    first.ports.close_all().await;
    assert!((0..first.tunnels.count()).all(|index| first.tunnels.stopped(index)), "the window closed: every ssh child stops");
    assert_eq!(store.get("box").await.unwrap(), [saved(3000, 3000), saved(8080, 18_080)], "the saved list stays");
    assert_eq!(first.ports.forward(3000, None).await.unwrap_err().code, PortErrorCode::WindowClosed);

    // The server window opens again: its connection restores the saved forwards.
    let second = rig(store.clone(), &[]);
    tokio::join!(second.ports.restore(), second.ports.restore());
    assert_eq!(second.ports.list().forwards, [active(3000, 3000), active(8080, 18_080)]);
    assert_eq!(second.tunnels.count(), 2, "two restore calls share one pass");
    // A later reconnect wakes the running ones instead of starting more.
    second.ports.restore().await;
    assert_eq!(second.tunnels.count(), 2);
    assert_eq!(second.tunnels.revived(), [1, 1]);
    // A saved local port taken meanwhile: any free one.
    let third = rig(store, &[18_080]);
    third.ports.restore().await;
    let moved = third.ports.list().forwards.into_iter().find(|entry| entry.remote_port == 8080).unwrap();
    assert_eq!(moved.local_port, 50_000);
}

#[tokio::test]
async fn new_listening_ports_are_suggested_never_forwarded_on_their_own() {
    let dir = tempfile::tempdir().unwrap();
    let f = rig(store_in(dir.path()), &[]);
    assert_eq!(f.ports.list().detected, None, "before the core pushes the first list nothing is detected");
    let mut view = f.ports.view();
    f.ports.update(vec![listening(22)]);
    assert!(f.ports.list().suggested.is_empty(), "what listened before the first look is not new");
    f.ports.update(vec![listening(22), listening(3000), listening(5000)]);
    assert_eq!(f.ports.list().suggested, [3000, 5000]);
    assert_eq!(f.tunnels.count(), 0, "nothing forwarded automatically");
    f.ports.dismiss(5000);
    f.ports.forward(3000, None).await.unwrap();
    assert!(f.ports.list().suggested.is_empty(), "a forwarded or ignored port is no longer offered");
    f.ports.update(vec![listening(22)]);
    assert_eq!(f.ports.list().detected.unwrap().iter().map(|port| port.port).collect::<Vec<_>>(), [22]);
    assert!(view.has_changed().unwrap(), "the panel's watch heard the changes");
    assert_eq!(view.borrow_and_update().forwards, [active(3000, 3000)]);
}

struct Feed(watch::Receiver<Vec<ListeningPort>>);

impl PortsSource for Feed {
    fn ports(&self) -> watch::Receiver<Vec<ListeningPort>> {
        self.0.clone()
    }
}

#[tokio::test]
async fn a_followed_source_feeds_the_panel_until_the_window_closes() {
    let dir = tempfile::tempdir().unwrap();
    let f = rig(store_in(dir.path()), &[]);
    let (sender, receiver) = watch::channel(vec![listening(22)]);
    f.ports.follow(&Feed(receiver));
    let mut view = f.ports.view();
    view.wait_for(|now| now.detected.is_some()).await.unwrap();
    sender.send_replace(vec![listening(22), listening(8000)]);
    view.wait_for(|now| now.suggested == [8000]).await.unwrap();
    f.ports.close_all().await;
    sender.send_replace(Vec::new());
    tokio::task::yield_now().await;
    assert_eq!(f.ports.list().suggested, [8000], "a closed panel hears nothing more");
}

#[tokio::test]
async fn a_failed_forward_shows_its_reason_and_a_new_request_replaces_it() {
    let dir = tempfile::tempdir().unwrap();
    let f = rig(store_in(dir.path()), &[]);
    *f.tunnels.fail.lock().unwrap() = Some("Permission denied (publickey).".to_owned());
    let failed = f.ports.forward(3000, None).await.unwrap();
    assert_eq!((failed.status, failed.message.as_deref()), (PortForwardStatus::Error, Some("Permission denied (publickey).")));
    assert_eq!(f.ports.browser_url(3000).unwrap_err().code, PortErrorCode::PortNotActive);
    *f.tunnels.fail.lock().unwrap() = None;
    assert_eq!(f.ports.forward(3000, None).await.unwrap(), active(3000, 3000));
    assert!(f.tunnels.stopped(0), "the failed tunnel is closed");
    assert_eq!(f.tunnels.count(), 2);
}

#[tokio::test]
async fn a_forward_that_is_not_ready_in_time_shows_as_an_error_while_the_tunnel_keeps_trying() {
    let dir = tempfile::tempdir().unwrap();
    let f = rig(store_in(dir.path()), &[]);
    let slow = Arc::new(FakeTunnel { local: 3000, state: watch::channel(TunnelState::Starting).0, revived: AtomicUsize::new(0) });
    let inner = f.ports.inner.clone();
    let late = inner.ready(slow.as_ref()).await;
    assert_eq!(late, Err("The ssh tunnel is not ready after 200 ms.".to_owned()));
    let entry = Forward { preferred: 3000, tunnel: slow.clone(), last_error: late.err() };
    let shown = forward_view(3000, &entry);
    assert_eq!((shown.status, shown.message.as_deref()), (PortForwardStatus::Error, Some("The ssh tunnel is not ready after 200 ms.")));
    slow.state.send_replace(TunnelState::Up);
    assert_eq!(forward_view(3000, &Forward { last_error: None, ..entry }).status, PortForwardStatus::Active);
}
