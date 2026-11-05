//! TCP connections with `SO_KEEPALIVE` set before the first request byte.

use std::io;
use std::net::SocketAddr;

use mixdog_core_api::domain::keepalive::TcpKeepalive;
use socket2::SockRef;
use tokio::net::TcpSocket;
use tokio::net::TcpStream;

fn options(keepalive: &TcpKeepalive) -> socket2::TcpKeepalive {
    socket2::TcpKeepalive::new()
        .with_time(keepalive.idle)
        .with_interval(keepalive.interval)
        .with_retries(keepalive.count)
}

/// Connects to `addr` with the keepalive schedule applied to the socket
/// before the SYN is sent. A failed connect ends by the OS SYN retry
/// schedule; there is no application connect timer.
pub async fn connect(addr: SocketAddr, keepalive: &TcpKeepalive) -> io::Result<TcpStream> {
    let socket = if addr.is_ipv4() {
        TcpSocket::new_v4()?
    } else {
        TcpSocket::new_v6()?
    };
    SockRef::from(&socket).set_tcp_keepalive(&options(keepalive))?;
    let stream = socket.connect(addr).await?;
    stream.set_nodelay(true)?;
    Ok(stream)
}

/// Applies the schedule to an already accepted or connected stream.
pub fn apply(stream: &TcpStream, keepalive: &TcpKeepalive) -> io::Result<()> {
    SockRef::from(stream).set_tcp_keepalive(&options(keepalive))
}

/// Whether the OS reports `SO_KEEPALIVE` on for `stream` (the idle and
/// interval getters do not exist on every platform).
pub fn is_enabled(stream: &TcpStream) -> io::Result<bool> {
    SockRef::from(stream).keepalive()
}