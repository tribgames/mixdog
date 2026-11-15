//! `stun-probe <host> [port=3478]`: sends one STUN Binding request (RFC 8489) over UDP and prints the address the server saw.
//! Run it from outside the VPS to prove the UDP path through the provider firewall. Exit 0 with `<address>:<port>` on stdout,
//! 1 on timeout or a malformed reply, 2 on a missing host.

use std::io;
use std::net::{Ipv4Addr, SocketAddr, ToSocketAddrs, UdpSocket};
use std::process::ExitCode;
use std::time::{Duration, Instant};

use crate::ice::turn::TURN_DEFAULT_PORT;

// RFC 8489 section 5: the fixed magic cookie and the 20-byte header; section 14.2: the XOR-MAPPED-ADDRESS attribute and its
// IPv4 family value; IANA STUN registry: Binding request 0x0001, Binding success response 0x0101.
const MAGIC_COOKIE: u32 = 0x2112_a442;
const HEADER_BYTES: usize = 20;
const BINDING_REQUEST: u16 = 0x0001;
const BINDING_SUCCESS: u16 = 0x0101;
const XOR_MAPPED_ADDRESS: u16 = 0x0020;
const FAMILY_IPV4: u8 = 0x01;
/// RFC 8489 section 5: the transaction ID is 96 bits.
pub const TRANSACTION_ID_BYTES: usize = 12;
/// RFC 8489 section 14.2: reserved byte, family byte, X-Port (2), X-Address (4 for IPv4).
const XOR_MAPPED_IPV4_BYTES: usize = 8;

/// RFC 8489 section 6.2.1 retransmission: the first RTO is 500 ms ("RECOMMENDED" on fixed-line access), doubling after each of
/// Rc = 7 requests; after the last, Rm = 16 times the RTO is waited. With these defaults requests go out at 0, 500, 1500, 3500,
/// 7500, 15500 and 31500 ms and the transaction fails at 39500 ms.
pub const STUN_RTO_MS: u64 = 500;
pub const STUN_RC: u32 = 7;
pub const STUN_RM: u32 = 16;

/// The address a STUN server saw.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mapped {
    pub address: Ipv4Addr,
    pub port: u16,
}

pub fn binding_request(transaction_id: &[u8; TRANSACTION_ID_BYTES]) -> [u8; HEADER_BYTES] {
    let mut message = [0u8; HEADER_BYTES];
    message[0..2].copy_from_slice(&BINDING_REQUEST.to_be_bytes());
    message[4..8].copy_from_slice(&MAGIC_COOKIE.to_be_bytes());
    message[8..].copy_from_slice(transaction_id);
    message
}

/// The IPv4 XOR-MAPPED-ADDRESS of a Binding success response to `transaction_id`, or None. The whole message must be well
/// formed (RFC 8489 sections 5 and 14): a header of 20 bytes, a length field that is a multiple of 4 and equals the rest of the
/// datagram, every attribute (padded to 4 bytes) inside it, and a XOR-MAPPED-ADDRESS that is exactly the 8-byte IPv4 form.
/// Anything else (truncated, over-long, inconsistent) is refused rather than read around.
pub fn parse_binding_response(message: &[u8], transaction_id: &[u8; TRANSACTION_ID_BYTES]) -> Option<Mapped> {
    if message.len() < HEADER_BYTES {
        return None;
    }
    let be16 = |at: usize| usize::from(u16::from_be_bytes([message[at], message[at + 1]]));
    if be16(0) != usize::from(BINDING_SUCCESS) || message[4..8] != MAGIC_COOKIE.to_be_bytes() {
        return None;
    }
    if message[8..HEADER_BYTES] != transaction_id[..] {
        return None;
    }
    let body_bytes = be16(2);
    if !body_bytes.is_multiple_of(4) || HEADER_BYTES + body_bytes != message.len() {
        return None;
    }
    let mut mapped = None;
    let mut offset = HEADER_BYTES;
    while offset < message.len() {
        if offset + 4 > message.len() {
            return None;
        }
        let kind = be16(offset);
        let length = be16(offset + 2);
        let next = offset + 4 + length.next_multiple_of(4);
        if next > message.len() {
            return None;
        }
        if kind == usize::from(XOR_MAPPED_ADDRESS) {
            let value = &message[offset + 4..offset + 4 + length];
            if length != XOR_MAPPED_IPV4_BYTES || value[1] != FAMILY_IPV4 {
                return None;
            }
            let cookie = &message[4..8];
            if mapped.is_none() {
                mapped = Some(Mapped {
                    address: Ipv4Addr::new(value[4] ^ cookie[0], value[5] ^ cookie[1], value[6] ^ cookie[2], value[7] ^ cookie[3]),
                    port: u16::from_be_bytes([value[2], value[3]]) ^ (MAGIC_COOKIE >> 16) as u16,
                });
            }
        }
        offset = next;
    }
    mapped
}

/// When each of the `STUN_RC` requests goes out, counted from the first, and when the transaction fails.
pub fn retransmit_schedule(rto: Duration) -> (Vec<Duration>, Duration) {
    let sends: Vec<Duration> = (0..STUN_RC).map(|sent| rto * ((1u32 << sent) - 1)).collect();
    let end = sends[sends.len() - 1] + rto * STUN_RM;
    (sends, end)
}

fn resolve_ipv4(host: &str, port: u16) -> io::Result<SocketAddr> {
    (host, port)
        .to_socket_addrs()?
        .find(SocketAddr::is_ipv4)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("no IPv4 address for {host}")))
}

/// One Binding transaction with the RFC 8489 section 6.2.1 schedule. `rto` exists so a test can run the same schedule at a
/// smaller scale. A reply that is not a well-formed answer to this transaction is ignored and the wait goes on.
pub fn probe_stun(host: &str, port: u16, rto: Duration) -> Result<Mapped, String> {
    let target = resolve_ipv4(host, port).map_err(|error| error.to_string())?;
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).map_err(|error| error.to_string())?;
    let transaction_id: [u8; TRANSACTION_ID_BYTES] = rand::random();
    let request = binding_request(&transaction_id);
    let (sends, end) = retransmit_schedule(rto);
    let started = Instant::now();
    let mut buffer = [0u8; 2048];
    for index in 0..sends.len() {
        socket.send_to(&request, target).map_err(|error| error.to_string())?;
        let until = started + sends.get(index + 1).copied().unwrap_or(end);
        loop {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            socket.set_read_timeout(Some(left.max(Duration::from_millis(1)))).map_err(|error| error.to_string())?;
            match socket.recv_from(&mut buffer) {
                Ok((size, _)) => {
                    if let Some(mapped) = parse_binding_response(&buffer[..size], &transaction_id) {
                        return Ok(mapped);
                    }
                }
                Err(error) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut | io::ErrorKind::ConnectionReset) => {}
                Err(error) => return Err(error.to_string()),
            }
        }
    }
    Err(format!("no STUN reply from {host}:{port}"))
}

pub fn main(args: &[String]) -> ExitCode {
    let Some(host) = args.first().filter(|host| !host.is_empty()) else {
        eprintln!("usage: mixdog-relay stun-probe <host> [port={TURN_DEFAULT_PORT}]");
        return ExitCode::from(2);
    };
    let port = match args.get(1).filter(|port| !port.is_empty()) {
        None => TURN_DEFAULT_PORT,
        Some(port) => match port.parse::<u16>() {
            Ok(port) => port,
            Err(_) => {
                eprintln!("not a port: {port}");
                return ExitCode::from(1);
            }
        },
    };
    match probe_stun(host, port, Duration::from_millis(STUN_RTO_MS)) {
        Ok(Mapped { address, port }) => {
            println!("{address}:{port}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("{message}");
            ExitCode::from(1)
        }
    }
}
