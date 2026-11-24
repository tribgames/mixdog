//! The connection limit: a place is held for as long as the descriptor is, an upgraded socket included.

use std::sync::{Arc, Mutex};

use mixdog_relay::http1::{Handler, HandlerFuture, Limits, PrefixedIo, Request, ResponseWriter, UpgradeRequest};
use mixdog_relay::net::{MAX_CONNECTIONS, Server};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::sync::mpsc;

struct Keep(Mutex<mpsc::UnboundedSender<PrefixedIo>>);

impl Handler for Keep {
    fn request(&self, _request: Request, _response: ResponseWriter) -> HandlerFuture {
        Box::pin(async {})
    }

    fn upgrade(&self, upgrade: UpgradeRequest) {
        let _ = self.0.lock().unwrap().send(upgrade.into_stream());
    }
}

// On one thread the connection's task runs to its end, the hand-off and the return of `serve_tcp` included, before the test
// resumes: nothing here waits for it.
#[tokio::test(flavor = "current_thread")]
async fn an_upgraded_socket_holds_its_place_in_the_connection_limit_until_it_is_dropped() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let server = Server::start(0, None, Arc::new(Keep(Mutex::new(tx))), Limits::default()).await.unwrap();
    assert_eq!(server.free_connection_slots(), MAX_CONNECTIONS);
    let mut client = TcpStream::connect(("127.0.0.1", server.port())).await.unwrap();
    client.write_all(b"GET /desktop HTTP/1.1\r\nHost: h\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n").await.unwrap();
    let socket = rx.recv().await.expect("the upgrade reached the handler");
    assert_eq!(server.free_connection_slots(), MAX_CONNECTIONS - 1);
    drop(socket);
    assert_eq!(server.free_connection_slots(), MAX_CONNECTIONS);
}
