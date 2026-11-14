#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "the port file is read and written once, as a lane job or at start-up, never on an async thread")]
//! The page server's loopback port: bound on 127.0.0.1, never on a port a fetch client or a browser refuses, and remembered in a port
//! file so the next start asks for the same one.

use std::io::ErrorKind;
use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::path::Path;

/// Ports the WHATWG Fetch spec blocks ("bad port"): fetch and Chromium refuse to connect to them, so a loopback server a fetch client or a
/// browser context must reach cannot live on one. <https://fetch.spec.whatwg.org/#port-blocking>
pub const FETCH_BLOCKED_PORTS: &[u16] = &[
    0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513,
    514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697,
    10080,
];

/// How many more OS-assigned ports are taken after a blocked one.
const FETCH_SAFE_ATTEMPTS: usize = 16;

fn bind(port: u16) -> std::io::Result<TcpListener> {
    TcpListener::bind(SocketAddr::new(Ipv4Addr::LOCALHOST.into(), port))
}

/// A listener on 127.0.0.1. The preferred port is used when it is free and fetch-safe; a busy, refused or blocked one falls back to an
/// OS-assigned port, taken again (at most 16 more times) until it is not fetch-blocked. A foreign listener is never reused.
pub fn bind_loopback(preferred: Option<u16>) -> std::io::Result<TcpListener> {
    if let Some(port) = preferred.filter(|port| !FETCH_BLOCKED_PORTS.contains(port)) {
        match bind(port) {
            Ok(listener) => return Ok(listener),
            Err(error) if matches!(error.kind(), ErrorKind::AddrInUse | ErrorKind::PermissionDenied) => {}
            Err(error) => return Err(error),
        }
    }
    for _ in 0..=FETCH_SAFE_ATTEMPTS {
        let listener = bind(0)?;
        if !FETCH_BLOCKED_PORTS.contains(&listener.local_addr()?.port()) {
            return Ok(listener);
        }
    }
    Err(std::io::Error::other("no fetch-safe loopback port was assigned"))
}

/// The port a port file names: an integer in 1..=65535, else none.
pub fn read_port_file(path: &Path) -> Option<u16> {
    let text = std::fs::read_to_string(path).ok()?;
    text.trim().parse::<u16>().ok().filter(|port| *port != 0)
}

pub fn write_port_file(path: &Path, port: u16) -> std::io::Result<()> {
    if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, port.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocked_list_has_the_spec_ports() {
        for port in [1, 22, 25, 6000, 6697, 10080] {
            assert!(FETCH_BLOCKED_PORTS.contains(&port), "{port}");
        }
        assert!(!FETCH_BLOCKED_PORTS.contains(&8080));
    }

    #[test]
    fn a_free_preferred_port_is_used() {
        let probe = bind(0).unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        if FETCH_BLOCKED_PORTS.contains(&port) {
            return;
        }
        let listener = bind_loopback(Some(port)).unwrap();
        assert_eq!(listener.local_addr().unwrap().port(), port);
        assert!(listener.local_addr().unwrap().ip().is_loopback());
    }

    #[test]
    fn a_busy_preferred_port_is_not_shared() {
        let held = bind(0).unwrap();
        let port = held.local_addr().unwrap().port();
        let listener = bind_loopback(Some(port)).unwrap();
        assert_ne!(listener.local_addr().unwrap().port(), port);
    }

    #[test]
    fn a_fetch_blocked_preferred_port_is_skipped() {
        let listener = bind_loopback(Some(6000)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert_ne!(port, 6000);
        assert!(!FETCH_BLOCKED_PORTS.contains(&port));
    }

    #[test]
    fn no_preference_takes_an_os_port() {
        let listener = bind_loopback(None).unwrap();
        assert!(!FETCH_BLOCKED_PORTS.contains(&listener.local_addr().unwrap().port()));
    }

    #[test]
    fn port_file_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("page-server.port");
        assert_eq!(read_port_file(&path), None);
        write_port_file(&path, 43117).unwrap();
        assert_eq!(read_port_file(&path), Some(43117));
        std::fs::write(&path, " 8080\n").unwrap();
        assert_eq!(read_port_file(&path), Some(8080));
        for bad in ["", "0", "70000", "abc", "-1"] {
            std::fs::write(&path, bad).unwrap();
            assert_eq!(read_port_file(&path), None, "{bad:?}");
        }
    }
}
