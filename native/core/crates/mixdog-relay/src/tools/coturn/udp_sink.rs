//! `udp-sink <address> <port>`: a UDP listener that counts, and echoes, what it receives: the "peer" behind a TURN relay for
//! `verify-turn.sh`. It prints `ready` once bound and, on SIGTERM, `received=<count>`, so the script can tell whether the relay
//! delivered. Exit 0 after SIGTERM, 1 on a socket error, 2 on bad arguments.

use std::io::{self, Write};
use std::net::{SocketAddr, ToSocketAddrs, UdpSocket};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// How often a quiet sink looks at its stop flag.
const POLL: Duration = Duration::from_millis(50);

/// Echoes every datagram to its sender and counts it, until `stop` is set; returns how many it got.
pub fn serve(socket: &UdpSocket, stop: &AtomicBool) -> io::Result<u64> {
    socket.set_read_timeout(Some(POLL))?;
    let mut received = 0u64;
    let mut buffer = vec![0u8; 65_536];
    while !stop.load(Ordering::SeqCst) {
        match socket.recv_from(&mut buffer) {
            Ok((size, remote)) => {
                received += 1;
                // Like the Node sink, a failed echo is not fatal to the count.
                let _ = socket.send_to(&buffer[..size], remote);
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut | io::ErrorKind::Interrupted | io::ErrorKind::ConnectionReset
                ) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(received)
}

static TERMINATED: AtomicBool = AtomicBool::new(false);

#[cfg(unix)]
extern "C" fn on_terminate(_signal: libc::c_int) {
    TERMINATED.store(true, Ordering::SeqCst);
}

fn bind(address: &str, port: u16) -> io::Result<UdpSocket> {
    let target = (address, port)
        .to_socket_addrs()?
        .find(SocketAddr::is_ipv4)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("no IPv4 address for {address}")))?;
    UdpSocket::bind(target)
}

pub fn main(args: &[String]) -> ExitCode {
    let (address, port) = (args.first(), args.get(1));
    let (Some(address), Some(port)) = (address.filter(|a| !a.is_empty()), port.filter(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))) else {
        eprintln!("usage: mixdog-relay udp-sink <address> <port>");
        return ExitCode::from(2);
    };
    let outcome = port.parse::<u16>().map_err(|_| format!("bad port: {port}")).and_then(|port| bind(address, port).map_err(|error| error.to_string()));
    let socket = match outcome {
        Ok(socket) => socket,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(1);
        }
    };
    #[cfg(unix)]
    // SAFETY: the handler only stores into an atomic, which is async-signal-safe.
    unsafe {
        libc::signal(libc::SIGTERM, on_terminate as extern "C" fn(libc::c_int) as libc::sighandler_t);
    }
    println!("ready");
    let _ = io::stdout().flush();
    match serve(&socket, &TERMINATED) {
        Ok(received) => {
            println!("received={received}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(1)
        }
    }
}
