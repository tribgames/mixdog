//! The page server's listener: a hyper 1 HTTP/1 accept loop on the loopback port `ports::bind_loopback` chose. The port a previous run used
//! is asked for first (`read_port_file`) and the one taken is written back, so a page frame's CSP origin survives a restart when it can.

use std::convert::Infallible;
use std::net::TcpListener as StdListener;
use std::path::Path;
use std::sync::Weak;
use std::time::Duration;

use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use super::ports::{bind_loopback, read_port_file, write_port_file};
use super::serve::PageServer;
use crate::error::WsResult;

/// Binds the loopback listener (a blocking job: the caller runs it on a lane) and remembers the port in `port_file`.
pub(super) fn bind(port_file: &Path) -> WsResult<(StdListener, u16)> {
    let listener = bind_loopback(read_port_file(port_file))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    // The file only records a preference for the next start: a store that cannot be written costs that and nothing else.
    let _ = write_port_file(port_file, port);
    Ok((listener, port))
}

/// Serves `listener` until the returned task is aborted or the server is gone. Must run inside the tokio runtime.
pub(super) fn spawn_accept_loop(listener: StdListener, server: Weak<PageServer>, port: u16) -> std::io::Result<JoinHandle<()>> {
    let listener = TcpListener::from_std(listener)?;
    Ok(tokio::spawn(async move {
        loop {
            let stream = match listener.accept().await {
                Ok((stream, _)) => stream,
                // Out of descriptors or an aborted handshake: wait a moment, the listener itself is fine.
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
            };
            let server = server.clone();
            tokio::spawn(async move {
                let service = service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
                    let server = server.clone();
                    async move {
                        let (parts, _) = request.into_parts();
                        let response = match server.upgrade() {
                            Some(server) => server.respond(&parts.method, parts.headers.get(hyper::header::HOST), parts.uri.path(), port).await,
                            None => super::serve::refuse(hyper::StatusCode::SERVICE_UNAVAILABLE),
                        };
                        Ok::<_, Infallible>(response)
                    }
                });
                // A client that resets or leaves mid-response ends only its own connection.
                let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), service).await;
            });
        }
    }))
}
