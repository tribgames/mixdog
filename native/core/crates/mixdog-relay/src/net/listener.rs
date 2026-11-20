//! The listener: `server.listen(port, '0.0.0.0')`. IPv4 only, the bound port reported (for `PORT=0`), every connection
//! given the address of its peer as Node reports it, and the TLS handshake done in front of the HTTP layer when the relay
//! terminates TLS itself.

use std::io;
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::Duration;

use rustls::ServerConfig;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio_rustls::TlsAcceptor;

use crate::http1::{ConnInfo, Handler, Lifecycle, Limits, serve_connection};

/// `tls.Server`'s `handshakeTimeout`.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(120);

/// How long the accept loop waits after the system refuses a connection (out of descriptors) before it asks again.
const ACCEPT_RETRY: Duration = Duration::from_millis(100);

/// A listening HTTP/1.1 (or HTTPS) server.
pub struct Server {
    port: u16,
    lifecycle: Arc<Lifecycle>,
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
        let accept = tokio::spawn(accept_loop(listener, tls.map(TlsAcceptor::from), handler, limits, lifecycle.clone(), stopped));
        Ok(Self { port, lifecycle, stop, accept })
    }

    /// The port the server listens on: the one asked for, or the one the system chose for port 0.
    pub fn port(&self) -> u16 {
        self.port
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
    mut stopped: watch::Receiver<bool>,
) {
    loop {
        let accepted = tokio::select! {
            _ = stopped.changed() => return,
            accepted = listener.accept() => accepted,
        };
        match accepted {
            Ok((tcp, _)) => {
                tokio::spawn(serve_tcp(tcp, tls.clone(), handler.clone(), limits.clone(), lifecycle.clone()));
            }
            Err(_) => mixdog_rt::time::sleep(ACCEPT_RETRY).await,
        }
    }
}
async fn serve_tcp(tcp: TcpStream, tls: Option<TlsAcceptor>, handler: Arc<dyn Handler>, limits: Limits, lifecycle: Arc<Lifecycle>) {
    // `http.createServer` defaults `noDelay` to true.
    let _ = tcp.set_nodelay(true);
    let remote_address = tcp.peer_addr().ok().map(|peer| peer.ip().to_string());
    match tls {
        None => serve_connection(tcp, ConnInfo { remote_address, encrypted: false }, handler, limits, lifecycle).await,
        Some(acceptor) => {
            // A failed or stalled handshake closes the socket and nothing else (no `tlsClientError` listener).
            if let Ok(Ok(stream)) = mixdog_rt::time::timeout(HANDSHAKE_TIMEOUT, acceptor.accept(tcp)).await {
                serve_connection(stream, ConnInfo { remote_address, encrypted: true }, handler, limits, lifecycle).await;
            }
        }
    }
}
