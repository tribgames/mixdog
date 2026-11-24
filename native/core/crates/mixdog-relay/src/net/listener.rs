//! The listener: `server.listen(port, '0.0.0.0')`. IPv4 only, the bound port reported (for `PORT=0`), every connection
//! given the address of its peer as Node reports it, and the TLS handshake done in front of the HTTP layer when the relay
//! terminates TLS itself.

use std::io;
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::Duration;

use rustls::ServerConfig;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};
use tokio::task::JoinHandle;
use tokio_rustls::TlsAcceptor;

use crate::http1::{ConnInfo, Handler, Lifecycle, Limits, serve_admitted};

/// `tls.Server`'s `handshakeTimeout`.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(120);

/// How long the accept loop waits after the system refuses a connection (out of descriptors) before it asks again.
const ACCEPT_RETRY: Duration = Duration::from_millis(100);

/// The most connections held at once: the service file's `LimitNOFILE=65535`, less 1024 descriptors kept for the data files, the
/// logs and the relay's own outgoing connections. Past it the loop stops accepting and the kernel backlog queues the callers,
/// instead of a stalled handshake (120 s) or header read (60 s) being able to exhaust descriptors.
pub const MAX_CONNECTIONS: usize = 65_535 - 1_024;

/// A listening HTTP/1.1 (or HTTPS) server.
pub struct Server {
    port: u16,
    lifecycle: Arc<Lifecycle>,
    slots: Arc<Semaphore>,
    stop: watch::Sender<bool>,
    accept: JoinHandle<()>,
}

/// The text of the error `server.listen` throws, which `startRelay` reports after `[relay] failed to start:`:
/// `listen EADDRINUSE: address already in use 0.0.0.0:9800`.
pub fn bind_error_message(error: &io::Error, port: u16) -> String {
    let code = mixdog_js::uv_error::error_code(error).unwrap_or("UNKNOWN");
    let description = match code {
        "EADDRINUSE" => "address already in use",
        "EACCES" => "permission denied",
        "EADDRNOTAVAIL" => "address not available",
        _ => return format!("listen {code}: {error} 0.0.0.0:{port}"),
    };
    format!("listen {code}: {description} 0.0.0.0:{port}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_listen_error_reads_as_nodes_does() {
        let in_use = io::Error::from(io::ErrorKind::AddrInUse);
        // The kind alone carries no OS code: the text is built from the code `error_code` finds.
        let text = bind_error_message(&in_use, 9800);
        assert!(text.starts_with("listen ") && text.ends_with(" 0.0.0.0:9800"), "{text}");
    }
}

impl Server {
    /// Binds `0.0.0.0:port` and serves every connection with `handler`. `tls` makes the server speak TLS.
    pub async fn start(port: u16, tls: Option<Arc<ServerConfig>>, handler: Arc<dyn Handler>, limits: Limits) -> io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)).await?;
        let port = listener.local_addr()?.port();
        let lifecycle = Arc::new(Lifecycle::default());
        let (stop, stopped) = watch::channel(false);
        let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
        let accept = tokio::spawn(accept_loop(listener, tls.map(TlsAcceptor::from), handler, limits, lifecycle.clone(), slots.clone(), stopped));
        Ok(Self { port, lifecycle, slots, stop, accept })
    }

    /// The port the server listens on: the one asked for, or the one the system chose for port 0.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// The places of the connection limit not held by a connection.
    pub fn free_connection_slots(&self) -> usize {
        self.slots.available_permits()
    }

    /// `server.closeAllConnections()`.
    pub fn terminate_connections(&self) {
        self.lifecycle.destroy_all();
    }

    /// `server.close()`: stops accepting, closes the connections that are waiting for a request, and resolves when the last
    /// connection (an upgraded socket included) is gone.
    pub async fn close(self) {
        let _ = self.stop.send(true);
        let _ = self.accept.await;
        self.lifecycle.begin_close();
        self.lifecycle.closed().await;
    }
}
async fn accept_loop(
    listener: TcpListener,
    tls: Option<TlsAcceptor>,
    handler: Arc<dyn Handler>,
    limits: Limits,
    lifecycle: Arc<Lifecycle>,
    slots: Arc<Semaphore>,
    mut stopped: watch::Receiver<bool>,
) {
    loop {
        let accepted = tokio::select! {
            _ = stopped.changed() => return,
            accepted = listener.accept() => accepted,
        };
        match accepted {
            Ok((tcp, _)) => {
                // At the limit this one accepted socket waits for a place, and the rest queue in the kernel backlog; no place is
                // held by the loop itself, so the free count is the limit less the connections.
                let slot = tokio::select! {
                    _ = stopped.changed() => return,
                    slot = slots.clone().acquire_owned() => slot.expect("the semaphore is never closed"),
                };
                let (tls, handler, limits, lifecycle) = (tls.clone(), handler.clone(), limits.clone(), lifecycle.clone());
                tokio::spawn(serve_tcp(tcp, tls, handler, limits, lifecycle, slot));
            }
            Err(_) => mixdog_rt::time::sleep(ACCEPT_RETRY).await,
        }
    }
}
async fn serve_tcp(tcp: TcpStream, tls: Option<TlsAcceptor>, handler: Arc<dyn Handler>, limits: Limits, lifecycle: Arc<Lifecycle>, slot: OwnedSemaphorePermit) {
    // `http.createServer` defaults `noDelay` to true.
    let _ = tcp.set_nodelay(true);
    let remote_address = tcp.peer_addr().ok().map(|peer| peer.ip().to_string());
    match tls {
        None => serve_admitted(tcp, ConnInfo { remote_address, encrypted: false }, handler, limits, lifecycle, Some(slot)).await,
        Some(acceptor) => {
            // A failed or stalled handshake closes the socket and nothing else (no `tlsClientError` listener).
            if let Ok(Ok(stream)) = mixdog_rt::time::timeout(HANDSHAKE_TIMEOUT, acceptor.accept(tcp)).await {
                serve_admitted(stream, ConnInfo { remote_address, encrypted: true }, handler, limits, lifecycle, Some(slot)).await;
            }
        }
    }
}
