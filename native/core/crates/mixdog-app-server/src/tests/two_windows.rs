//! The desktop's own connection and two window sockets: only the desktop's connection registers and votes that the
//! desktop is on; a window is a view that sees what its subscriptions show.

use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use bytes::Bytes;
use mixdog_core_api::ApprovalPresence;
use mixdog_core_api::CoreError;
use mixdog_core_api::DesktopPresence;
use mixdog_core_api::FeedSource;
use mixdog_core_api::Reply;
use mixdog_core_api::ServerRequestSink;
use mixdog_core_api::Subscribe;
use mixdog_core_api::call::WindowRole;
use mixdog_core_api::call::WindowScope;
use mixdog_core_api::feed::Window;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ServerRequestId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::server_request::PendingServerRequest;
use mixdog_protocol::ConnectionKind;
use serde_json::json;

use super::Client;
use super::Rig;
use crate::ClientHook;

#[derive(Default)]
struct Counts {
    registered: AtomicUsize,
    ready: AtomicUsize,
}

impl ClientHook for Counts {
    fn registered(&self, _kind: ConnectionKind) {
        self.registered.fetch_add(1, Ordering::SeqCst);
    }

    fn desktop_ready(&self) {
        self.ready.fetch_add(1, Ordering::SeqCst);
    }
}

/// Connection 1 is the desktop's own; 2 and 3 are the sockets of windows `w-1` and `w-2`.
fn rig() -> (Rig, Arc<Counts>) {
    let rig = Rig::new();
    let scope = |id: ConnectionId| match id.0 {
        2 => Some(WindowScope { id: Arc::from("w-1"), role: WindowRole::Main }),
        3 => Some(WindowScope { id: Arc::from("w-2"), role: WindowRole::Server { connection_id: "c-9".to_owned() } }),
        _ => None,
    };
    assert!(rig.server.set_window_of(Arc::new(scope)).is_ok());
    let counts = Arc::new(Counts::default());
    assert!(rig.outgoing.set_client_hook(counts.clone()).is_ok());
    (rig, counts)
}

async fn subscribe_app(client: &Client) {
    client.request(1, "app/subscribe", json!({}));
    client.response(1).await;
}

async fn watch(client: &Client, thread: &str) {
    client.request(2, "thread/resume", json!({ "threadId": thread, "window": { "lastItems": 10 } }));
    client.response(2).await;
}

#[tokio::test(start_paused = true)]
async fn windows_are_views_of_the_one_desktop() {
    let (rig, counts) = rig();
    assert!(!rig.outgoing.desktop_attached());
    let main = rig.ready(1, json!({}));
    let first = rig.ready(2, json!({}));
    let second = rig.ready(3, json!({}));
    assert_eq!(counts.registered.load(Ordering::SeqCst), 1, "one registration per desktop, not per window");

    // A window's feed going live is not the desktop being on, with the desktop's own connection absent from it.
    subscribe_app(&first).await;
    subscribe_app(&second).await;
    assert!(!rig.outgoing.desktop_attached(), "windows alone never vote");
    assert_eq!(counts.ready.load(Ordering::SeqCst), 0);

    subscribe_app(&main).await;
    assert!(rig.outgoing.desktop_attached());
    assert_eq!(counts.ready.load(Ordering::SeqCst), 1, "one control thread per desktop");

    // Presence is the desktop's: a window closing changes nothing.
    drop(first);
    assert!(rig.outgoing.desktop_attached());
    drop(second);
    assert!(rig.outgoing.desktop_attached());
    assert_eq!(counts.ready.load(Ordering::SeqCst), 1);
    assert_eq!(counts.registered.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn an_approval_reaches_every_window_that_shows_its_thread() {
    let (rig, _) = rig();
    let thread = rig.core.mock.directory().insert(ThreadId::from("t1"));
    let feed: Arc<dyn FeedSource> = thread.feed().clone();
    thread.set_handler(Arc::new(move |_| {
        Ok::<Reply, CoreError>(Reply::Subscribe(Subscribe {
            result: json!({}),
            feed: feed.clone(),
            window: Window::LastItems(10),
            resume_from: None,
        }))
    }));
    let main = rig.ready(1, json!({}));
    let first = rig.ready(2, json!({}));
    let second = rig.ready(3, json!({}));
    let bystander = rig.ready(4, json!({}));
    for client in [&main, &first, &second] {
        watch(client, "t1").await;
    }
    let frame = json!({ "id": "ap1", "method": "item/tool/requestApproval", "params": { "threadId": "t1" } });
    rig.outgoing.publish(PendingServerRequest {
        id: ServerRequestId("ap1".to_owned()),
        method: Method("item/tool/requestApproval"),
        thread: ThreadId::from("t1"),
        surface: ThreadId::from("t1"),
        order: 1,
        frame: Bytes::from(frame.to_string()),
    });
    for client in [&main, &first, &second] {
        let frames = client.frames(1).await;
        assert_eq!(frames[0].body["id"], json!("ap1"));
    }
    assert!(bystander.drain().is_empty(), "a connection that shows nothing of the thread is not asked");

    // Closing a window leaves the request open for the others.
    drop(first);
    assert!(rig.outgoing.answerable(&ThreadId::from("t1"), &ThreadId::from("t1")));
}
