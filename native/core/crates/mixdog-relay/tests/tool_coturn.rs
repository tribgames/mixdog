//! The cases of `deploy/coturn/reserved-ports.test.mjs` and `stun-probe.test.mjs` against the relay's own subcommands, the
//! `udp-sink` and `turn-credential` helpers, and (on unix) the cases of `render-turnserver-conf.test.mjs`, which run the
//! unchanged `render-turnserver-conf.sh` under bash.

#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "a test thread sleeps to see that nothing more arrives, and the render cases run bash on the shipped script"
)]

use std::io;
use std::net::{Ipv4Addr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use mixdog_fsio::Unlaned;
use mixdog_relay::ice::turn::{turn_password, verify_turn_credential};
use mixdog_relay::tools::coturn::credential::credential_line;
use mixdog_relay::tools::coturn::reserved_ports::{
    add_ranges, covers_range, format_ranges, missing_ranges, parse_ranges, run, subtract_ranges,
};
use mixdog_relay::tools::coturn::stun_probe::{
    Mapped, STUN_RC, STUN_RM, STUN_RTO_MS, binding_request, parse_binding_response, probe_stun, retransmit_schedule,
};
use mixdog_relay::tools::coturn::udp_sink;

// ---- reserved-ports ----

/// A stand-in for /proc/sys/net/ipv4/ip_local_reserved_ports and the unit's record file.
struct Sysctl {
    _dir: tempfile::TempDir,
    proc: PathBuf,
    record: PathBuf,
}

impl Sysctl {
    fn new(initial: &str) -> Sysctl {
        let dir = tempfile::tempdir().expect("temp dir");
        let proc = dir.path().join("proc");
        let record = dir.path().join("added");
        mixdog_fsio::write(&Unlaned, &proc, format!("{initial}\n")).expect("write proc");
        Sysctl { _dir: dir, proc, record }
    }

    fn value(&self) -> String {
        mixdog_fsio::read_to_string(&Unlaned, &self.proc).expect("read proc").trim().to_owned()
    }

    fn set(&self, text: &str) {
        mixdog_fsio::write(&Unlaned, &self.proc, format!("{text}\n")).expect("write proc");
    }

    fn run(&self, args: &[&str]) -> Result<String, String> {
        self.run_failing_write(0, args)
    }

    /// Runs with a writer that fails on the nth write (1-based; 0 never), as a failed save or a crash would.
    fn run_failing_write(&self, nth: usize, args: &[&str]) -> Result<String, String> {
        let argv: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
        let mut writes = 0;
        run(&argv, &self.proc, &mut |path: &Path, data: &str| {
            writes += 1;
            if writes == nth {
                return Err(io::Error::other(format!("write {nth} failed")));
            }
            mixdog_fsio::write(&Unlaned, path, data)
        })
    }

    fn apply(&self, min: &str, max: &str) -> Result<String, String> {
        self.run(&["apply", min, max, self.record.to_str().expect("utf8")])
    }

    fn release(&self) -> Result<String, String> {
        self.run(&["release", self.record.to_str().expect("utf8")])
    }

    fn record_text(&self) -> String {
        mixdog_fsio::read_to_string(&Unlaned, &self.record).expect("read record").trim().to_owned()
    }

    /// The ranges the ownership record names.
    fn recorded(&self) -> String {
        self.record_text().split_once(' ').map_or(String::new(), |(_, ranges)| ranges.to_owned())
    }

    fn state(&self) -> String {
        self.record_text().split(' ').next().unwrap_or_default().to_owned()
    }
}

fn fmt(text: &str) -> String {
    format_ranges(&parse_ranges(text).expect("ranges"))
}

#[test]
fn port_lists_parse_merge_and_print_the_way_the_kernel_reads_them() {
    assert!(parse_ranges("").unwrap().is_empty());
    assert_eq!(parse_ranges("8080,10000-10010").unwrap(), vec![(8080, 8080), (10000, 10010)]);
    assert_eq!(parse_ranges("10-20, 15-30,31,5").unwrap(), vec![(5, 5), (10, 31)], "overlapping and adjacent ranges join");
    assert_eq!(fmt("10000-10010,8080"), "8080,10000-10010");
    for bad in ["a", "10-", "-5", "20-10", "70000", "1-65536", "1;2"] {
        assert!(parse_ranges(bad).unwrap_err().starts_with("not a port range"), "{bad}");
    }
}

#[test]
fn missing_added_and_removed_parts_are_exact() {
    let current = parse_ranges("8080,50000-60000").unwrap();
    assert_eq!(format_ranges(&missing_ranges(&current, 49152, 65535)), "49152-49999,60001-65535");
    assert_eq!(format_ranges(&missing_ranges(&current, 50000, 60000)), "");
    assert!(covers_range(&current, 50100, 59999));
    assert!(!covers_range(&current, 49999, 60000));
    let added = missing_ranges(&current, 49152, 65535);
    assert_eq!(format_ranges(&add_ranges(&current, &added)), "8080,49152-65535");
    assert_eq!(format_ranges(&subtract_ranges(&add_ranges(&current, &added), &added)), "8080,50000-60000");
}

#[test]
fn apply_reserves_only_the_missing_part_and_leaves_what_others_reserved() {
    let s = Sysctl::new("8080,10000-10010");
    assert!(s.apply("49152", "65535").unwrap().contains("added: 49152-65535"));
    assert_eq!(s.value(), "8080,10000-10010,49152-65535");
    assert_eq!(s.recorded(), "49152-65535");
    assert!(s.run(&["covers", "49152", "65535"]).unwrap().starts_with("reserved:"));

    let overlap = Sysctl::new("50000-60000");
    overlap.apply("49152", "65535").unwrap();
    assert_eq!(overlap.value(), "49152-65535");
    assert_eq!(overlap.recorded(), "49152-49999,60001-65535", "only the missing parts are ours");
}

#[test]
fn release_takes_back_only_what_apply_added_keeping_reservations_others_made_meanwhile() {
    let s = Sysctl::new("50000-60000");
    s.apply("49152", "65535").unwrap();
    s.set(&format!("{},9000", s.value()));
    assert!(s.release().unwrap().contains("released 49152-49999,60001-65535"));
    assert_eq!(s.value(), "9000,50000-60000", "the pre-existing range and the later one stay");
}

#[test]
fn a_range_that_was_already_reserved_is_neither_recorded_nor_released() {
    let s = Sysctl::new("1000,49000-65535");
    assert!(s.apply("49152", "65535").unwrap().contains("nothing, already reserved"));
    assert_eq!(s.value(), "1000,49000-65535", "unchanged");
    assert_eq!(s.recorded(), "");
    assert_eq!(s.release().unwrap(), "nothing to release");
    assert_eq!(s.value(), "1000,49000-65535");
    // Containment, not equality: the wider reservation covers the range.
    assert!(s.run(&["covers", "49152", "65535"]).unwrap().starts_with("reserved:"));
}

#[test]
fn an_apply_after_a_crash_keeps_owning_what_the_interrupted_one_added() {
    let s = Sysctl::new("8080");
    s.apply("49152", "65535").unwrap();
    s.apply("49152", "65535").unwrap();
    assert_eq!(s.recorded(), "49152-65535");
    s.release().unwrap();
    assert_eq!(s.value(), "8080");
}

#[test]
fn ownership_is_recorded_before_the_reservation_changes_a_failed_save_leaves_nothing_reserved() {
    let s = Sysctl::new("8080");
    // Write 1 is the record's pending save.
    let record = s.record.to_str().unwrap();
    assert!(s.run_failing_write(1, &["apply", "49152", "65535", record]).unwrap_err().contains("write 1 failed"));
    assert_eq!(s.value(), "8080", "the sysctl was not touched");
    assert!(!mixdog_fsio::exists(&Unlaned, &s.record).unwrap());
}

#[test]
fn a_crash_between_the_steps_leaves_a_record_that_releases_whatever_was_reserved() {
    // Dies at the sysctl write (2): pending record, nothing reserved yet.
    let before = Sysctl::new("8080");
    let record = before.record.to_str().unwrap().to_owned();
    assert!(before.run_failing_write(2, &["apply", "49152", "65535", &record]).unwrap_err().contains("write 2 failed"));
    assert_eq!(before.value(), "8080");
    assert_eq!(before.state(), "pending");
    assert_eq!(before.recorded(), "49152-65535");
    before.release().unwrap();
    assert_eq!(before.value(), "8080");

    // Dies after the sysctl write but before it is confirmed (write 3, the applied save): the reservation is in place AND the
    // record already names it.
    let after = Sysctl::new("8080");
    let record = after.record.to_str().unwrap().to_owned();
    assert!(after.run_failing_write(3, &["apply", "49152", "65535", &record]).unwrap_err().contains("write 3 failed"));
    assert_eq!(after.value(), "8080,49152-65535");
    assert_eq!(after.state(), "pending");
    assert_eq!(after.recorded(), "49152-65535");
    // The next start does not mistake it for somebody else's, and a release takes it back.
    after.apply("49152", "65535").unwrap();
    assert_eq!(after.state(), "applied");
    assert_eq!(after.recorded(), "49152-65535");
    after.release().unwrap();
    assert_eq!(after.value(), "8080");
    assert_eq!(after.state(), "released");
    assert_eq!(after.release().unwrap(), "nothing to release", "a second release is a no-op");

    // A start that failed after the reservation (what ExecStopPost cleans up) with no further apply.
    let failed = Sysctl::new("");
    let record = failed.record.to_str().unwrap().to_owned();
    assert!(failed.run_failing_write(3, &["apply", "49152", "65535", &record]).unwrap_err().contains("write 3 failed"));
    failed.release().unwrap();
    assert_eq!(failed.value(), "");
}

#[test]
fn a_release_whose_sysctl_write_fails_keeps_the_record_so_it_can_be_retried() {
    let s = Sysctl::new("8080");
    s.apply("49152", "65535").unwrap();
    let record = s.record.to_str().unwrap().to_owned();
    assert!(s.run_failing_write(1, &["release", &record]).unwrap_err().contains("write 1 failed"));
    assert_eq!(s.value(), "8080,49152-65535");
    assert_eq!(s.recorded(), "49152-65535");
    s.release().unwrap();
    assert_eq!(s.value(), "8080");
}

#[test]
fn a_damaged_ownership_record_is_refused_not_guessed_at() {
    let s = Sysctl::new("");
    mixdog_fsio::write(&Unlaned, &s.record, "garbage\n").unwrap();
    assert!(s.release().unwrap_err().contains("not an ownership record"));
    assert!(s.apply("49152", "65535").unwrap_err().contains("not an ownership record"));
}

#[test]
fn covers_fails_naming_what_is_reserved_when_the_range_is_not_wholly_in_the_set() {
    let s = Sysctl::new("49152-65000");
    assert!(s.run(&["covers", "49152", "65535"]).unwrap_err().contains("not wholly reserved (reserved: 49152-65000)"));
    let empty = Sysctl::new("");
    assert!(empty.run(&["covers", "49152", "65535"]).unwrap_err().contains("reserved: none"));
}

#[test]
fn a_bad_command_or_port_is_refused() {
    let s = Sysctl::new("");
    assert!(s.run(&["nope"]).unwrap_err().contains("usage"));
    assert!(s.run(&[]).unwrap_err().contains("usage"));
    assert!(s.apply("0", "10").unwrap_err().contains("not a port"));
    assert!(s.apply("10", "70000").unwrap_err().contains("not a port"));
    assert!(s.apply("10", "9").unwrap_err().contains("not a port range"), "a reversed range is refused before anything is written");
    assert!(!mixdog_fsio::exists(&Unlaned, &s.record).unwrap());
}

// ---- stun-probe ----

const COOKIE: [u8; 4] = [0x21, 0x12, 0xa4, 0x42];
const ID: [u8; 12] = [9; 12];

/// One attribute, padded to a multiple of 4 as RFC 8489 section 14 requires.
fn attribute(kind: u16, value: &[u8]) -> Vec<u8> {
    let mut out = kind.to_be_bytes().to_vec();
    out.extend((value.len() as u16).to_be_bytes());
    out.extend(value);
    out.resize(4 + value.len().div_ceil(4) * 4, 0);
    out
}

/// XOR-MAPPED-ADDRESS value for an IPv4 `address:port`.
fn mapped_ipv4(address: [u8; 4], port: u16) -> Vec<u8> {
    let mut value = vec![0u8, 1];
    value.extend((port ^ 0x2112).to_be_bytes());
    value.extend((0..4).map(|index| address[index] ^ COOKIE[index]));
    value
}

/// A Binding success response around `body`; `length` overrides the header's length field.
fn response_with(body: &[u8], id: &[u8], length: Option<u16>, kind: u16) -> Vec<u8> {
    let mut message = kind.to_be_bytes().to_vec();
    message.extend(length.unwrap_or(body.len() as u16).to_be_bytes());
    message.extend(COOKIE);
    message.extend(id);
    message.extend(body);
    message
}

fn response(body: &[u8]) -> Vec<u8> {
    response_with(body, &ID, None, 0x0101)
}

fn mapped(address: [u8; 4], port: u16) -> Vec<u8> {
    attribute(0x0020, &mapped_ipv4(address, port))
}

fn parse(message: &[u8]) -> Option<Mapped> {
    parse_binding_response(message, &ID)
}

#[test]
fn a_binding_request_is_a_bare_rfc_8489_header() {
    let id = [7u8; 12];
    let request = binding_request(&id);
    assert_eq!(request.len(), 20);
    assert_eq!(request[0..2], [0, 1]);
    assert_eq!(request[2..4], [0, 0]);
    assert_eq!(request[4..8], COOKIE);
    assert_eq!(request[8..], id);
}

#[test]
fn the_mapped_address_is_un_xored_skipping_other_attributes_and_foreign_replies_are_ignored() {
    assert_eq!(parse(&response(&mapped([203, 0, 113, 9], 54321))), Some(Mapped { address: Ipv4Addr::new(203, 0, 113, 9), port: 54321 }));
    let software = attribute(0x8022, b"coturn-x");
    let odd = attribute(0x8028, b"abc"); // 3 bytes of value + 1 of padding
    let body = [software, odd, mapped([198, 51, 100, 7], 3478)].concat();
    assert_eq!(parse(&response(&body)), Some(Mapped { address: Ipv4Addr::new(198, 51, 100, 7), port: 3478 }));
    assert_eq!(parse_binding_response(&response(&mapped([203, 0, 113, 9], 1)), &[1; 12]), None);
    assert_eq!(parse(&response_with(&mapped([203, 0, 113, 9], 1), &ID, None, 0x0111)), None);
    assert_eq!(parse(&[0u8; 20]), None);
}

#[test]
fn truncated_or_inconsistent_messages_are_refused_not_read_around() {
    let good = response(&mapped([203, 0, 113, 9], 54321));
    assert!(parse(&good).is_some());
    // Truncated header.
    for size in [0, 3, 19] {
        assert_eq!(parse(&good[..size]), None, "header {size}");
    }
    // Datagram cut inside the attribute: the length field promises more than arrived.
    for size in [21, 23, 24, 27, 31] {
        assert_eq!(parse(&good[..size]), None, "cut at {size}");
    }
    // Length field larger / smaller than what follows, or not a multiple of 4.
    let one = mapped([203, 0, 113, 9], 1);
    for length in [16, 8, 10] {
        assert_eq!(parse(&response_with(&one, &ID, Some(length), 0x0101)), None, "length {length}");
    }
    // Bytes after the message the header describes.
    assert_eq!(parse(&[good.clone(), vec![0; 4]].concat()), None);
    // An attribute that overruns the message, or whose padding is missing.
    let mut overrun = attribute(0x8022, b"coturn-x");
    overrun[2..4].copy_from_slice(&40u16.to_be_bytes());
    assert_eq!(parse(&response(&overrun)), None);
    // A value of 5 bytes needs 3 bytes of padding that the message does not carry.
    assert_eq!(parse(&response(&[&[0x80, 0x28, 0x00, 0x05][..], b"abcd"].concat())), None);
    // A bare attribute header with no room for its value.
    assert_eq!(parse(&response(&[0x80, 0x22, 0x00, 0x04])), None);
    // A well-formed attribute list followed by a fragment of another.
    assert_eq!(parse(&response(&[one, vec![0x80, 0x22]].concat())), None);
}

#[test]
fn a_xor_mapped_address_must_be_the_complete_8_byte_ipv4_form() {
    let value = mapped_ipv4([203, 0, 113, 9], 5000);
    for bad in [value[..7].to_vec(), value[..4].to_vec(), [value.clone(), vec![0; 4]].concat(), Vec::new()] {
        assert_eq!(parse(&response(&attribute(0x0020, &bad))), None, "length {}", bad.len());
    }
    let mut ipv6 = vec![0u8; 20];
    ipv6[1] = 2;
    assert_eq!(parse(&response(&attribute(0x0020, &ipv6))), None, "IPv6 form");
    let mut unknown = value.clone();
    unknown[1] = 3;
    assert_eq!(parse(&response(&attribute(0x0020, &unknown))), None);
    // A bad mapped attribute poisons the message even after a good one.
    let body = [mapped([203, 0, 113, 9], 1), attribute(0x0020, &value[..7])].concat();
    assert_eq!(parse(&response(&body)), None);
}

#[test]
fn the_retransmission_schedule_is_the_rfc_8489_6_2_1_one() {
    assert_eq!((STUN_RTO_MS, STUN_RC, STUN_RM), (500, 7, 16));
    let (sends, end) = retransmit_schedule(Duration::from_millis(STUN_RTO_MS));
    let ms: Vec<u128> = sends.iter().map(Duration::as_millis).collect();
    assert_eq!(ms, [0, 500, 1500, 3500, 7500, 15500, 31500]);
    assert_eq!(end, Duration::from_millis(39_500));
}

/// A UDP endpoint that records when each datagram arrived; `reply(count, request)` may answer.
struct Endpoint {
    port: u16,
    received: Arc<Mutex<Vec<(Instant, Vec<u8>)>>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Endpoint {
    fn start(reply: impl Fn(usize, &[u8]) -> Option<Vec<Vec<u8>>> + Send + 'static) -> Endpoint {
        let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind");
        socket.set_read_timeout(Some(Duration::from_millis(20))).unwrap();
        let port = socket.local_addr().unwrap().port();
        let received = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let (received, stop) = (received.clone(), stop.clone());
            std::thread::spawn(move || {
                let mut buffer = [0u8; 2048];
                while !stop.load(Ordering::SeqCst) {
                    let Ok((size, remote)) = socket.recv_from(&mut buffer) else { continue };
                    let count = {
                        let mut log = received.lock().unwrap();
                        log.push((Instant::now(), buffer[..size].to_vec()));
                        log.len()
                    };
                    for answer in reply(count, &buffer[..size]).unwrap_or_default() {
                        let _ = socket.send_to(&answer, remote);
                    }
                }
            })
        };
        Endpoint { port, received, stop, thread: Some(thread) }
    }

    fn count(&self) -> usize {
        self.received.lock().unwrap().len()
    }
}

impl Drop for Endpoint {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn answer_for(request: &[u8], body: &[u8], length: Option<u16>) -> Vec<u8> {
    response_with(body, &request[8..20], length, 0x0101)
}

#[test]
fn probe_stun_resends_the_same_request_on_the_doubling_schedule_and_answers_on_a_later_copy() {
    let rto = Duration::from_millis(20);
    let server = Endpoint::start(|count, request| {
        (count == 3).then(|| vec![answer_for(request, &mapped([198, 51, 100, 7], 4000), None)])
    });
    let found = probe_stun("127.0.0.1", server.port, rto).expect("answered");
    assert_eq!(found, Mapped { address: Ipv4Addr::new(198, 51, 100, 7), port: 4000 });
    let log = server.received.lock().unwrap().clone();
    assert_eq!(log.len(), 3, "an answered transaction sends nothing more");
    assert!(log.iter().all(|(_, request)| *request == log[0].1), "every copy is the same transaction");
    // The sends are at 0, 1 and 3 rto after the first (the timer may only fire late). The server stamps each copy when ITS thread
    // wakes, which on a loaded machine is late by an unbounded, per-copy amount, so one gap is no evidence of the sender's wait:
    // the distances from the first copy are, and the schedule itself is pinned by the retransmit_schedule check above.
    assert!(log[1].0 - log[0].0 >= rto - Duration::from_millis(15));
    assert!(log[2].0 - log[0].0 >= 3 * rto - Duration::from_millis(15));
    std::thread::sleep(rto * 6);
    assert_eq!(server.count(), 3);
}

#[test]
fn probe_stun_gives_up_after_rc_requests_and_rm_times_the_rto_of_silence() {
    let rto = Duration::from_millis(10);
    let server = Endpoint::start(|_, _| None);
    let started = Instant::now();
    let error = probe_stun("127.0.0.1", server.port, rto).expect_err("silent server");
    let elapsed = started.elapsed();
    assert!(error.starts_with("no STUN reply from 127.0.0.1:"), "{error}");
    assert_eq!(server.count(), STUN_RC as usize);
    // The sends are at 0, 1, 3, 7, 15, 31 and 63 RTO; the transaction fails Rm RTO after the last, at 79 RTO.
    assert!(elapsed >= rto * 79 - Duration::from_millis(5), "{elapsed:?}");
}

#[test]
fn probe_stun_ignores_a_malformed_reply_and_keeps_waiting_for_a_good_one() {
    let server = Endpoint::start(|count, request| {
        let body = mapped([127, 0, 0, 1], 9);
        Some(vec![if count == 1 { answer_for(request, &body, Some(4)) } else { answer_for(request, &body, None) }])
    });
    let found = probe_stun("127.0.0.1", server.port, Duration::from_millis(20)).expect("second copy answered");
    assert_eq!(found.address, Ipv4Addr::LOCALHOST);
    assert_eq!(server.count(), 2);
}

// ---- udp-sink ----

#[test]
fn the_udp_sink_echoes_and_counts_until_it_is_told_to_stop() {
    let sink = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let address = sink.local_addr().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let thread = {
        let stop = stop.clone();
        std::thread::spawn(move || udp_sink::serve(&sink, &stop).expect("served"))
    };
    let client = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    client.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut buffer = [0u8; 64];
    for text in [&b"one"[..], b"two", b"three"] {
        client.send_to(text, address).unwrap();
        let (size, _) = client.recv_from(&mut buffer).expect("echo");
        assert_eq!(&buffer[..size], text);
    }
    stop.store(true, Ordering::SeqCst);
    assert_eq!(thread.join().unwrap(), 3);
}

// ---- turn-credential ----

#[test]
fn turn_credential_prints_the_username_and_password_coturn_recomputes() {
    let secret = "s".repeat(40);
    let now = 1_893_499_200_000;
    let line = credential_line(&secret, "verify-good", now);
    let (username, credential) = line.split_once(' ').expect("two fields");
    assert_eq!(username, format!("{}:verify-good", now / 1000 + 86_400));
    assert_eq!(credential, turn_password(&secret, username));
    assert!(verify_turn_credential(&secret, Some(username), Some(credential), now));
    // An offset of -25 hours (what verify-turn.sh asks for) makes the credential expired by an hour.
    let expired = credential_line(&secret, "verify-expired", now - 90_000_000);
    let (username, credential) = expired.split_once(' ').unwrap();
    assert!(!verify_turn_credential(&secret, Some(username), Some(credential), now));
}

// ---- render-turnserver-conf.sh (unix: the script stays shell) ----

#[cfg(unix)]
mod render {
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::process::Command;

    fn deploy(name: &str) -> String {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../apps/relay/deploy/coturn").join(name);
        mixdog_fsio::canonicalize(&mixdog_fsio::Unlaned, root).expect("deploy file").to_string_lossy().into_owned()
    }

    fn values() -> BTreeMap<&'static str, &'static str> {
        BTreeMap::from([
            ("TURN_PORT", "3478"),
            ("TURN_TLS_PORT", "5349"),
            ("TURN_MIN_PORT", "49152"),
            ("TURN_MAX_PORT", "65535"),
            ("TURN_PUBLIC_IP", "198.51.100.7"),
            ("TURN_REALM", "relay.example.com"),
            ("TURN_USER_QUOTA", "12"),
            ("TURN_AUTH_SECRET", "not-a-marker-@TURN_PORT@-secret"),
        ])
    }

    fn bash(script: &str) -> std::process::Output {
        Command::new("bash").args(["--noprofile", "--norc", "-c", script]).output().expect("bash")
    }

    fn assignments(values: &BTreeMap<&str, &str>) -> Vec<String> {
        values.iter().map(|(name, value)| format!("{name}='{value}'")).collect()
    }

    /// Sources the renderer under `set -Eeuo pipefail` (as provision-coturn.sh runs) and renders `template` with `values`.
    fn render(values: &BTreeMap<&str, &str>, template: &str) -> std::process::Output {
        let mut lines = vec!["set -Eeuo pipefail".to_owned(), format!("source '{}'", deploy("render-turnserver-conf.sh"))];
        lines.extend(assignments(values));
        lines.push(format!("render_turnserver_conf '{template}'"));
        bash(&lines.join("\n"))
    }

    #[test]
    fn every_marker_of_the_template_is_filled() {
        let result = render(&values(), &deploy("turnserver.conf.template"));
        assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
        let text = String::from_utf8(result.stdout).unwrap();
        let conf: Vec<&str> = text.split('\n').collect();
        for line in [
            "listening-port=3478",
            "tls-listening-port=5349",
            "min-port=49152",
            "max-port=65535",
            "external-ip=198.51.100.7",
            "realm=relay.example.com",
            "user-quota=12",
            // A marker-like text inside the secret is left as it is.
            "static-auth-secret=not-a-marker-@TURN_PORT@-secret",
        ] {
            assert!(conf.contains(&line), "missing: {line}");
        }
        // No relay-load limit is configured (the template says why).
        for option in ["max-bps", "bps-capacity", "total-quota"] {
            assert!(!conf.iter().any(|line| line.starts_with(&format!("{option}="))), "{option}");
        }
        let marker = regex::Regex::new(r"@TURN_[A-Z_]+@").unwrap();
        assert!(!conf.iter().filter(|line| !line.starts_with("static-auth-secret=")).any(|line| marker.is_match(line)));
    }

    #[test]
    fn a_variable_left_unset_fails_instead_of_rendering_an_empty_value() {
        let mut rest = values();
        rest.remove("TURN_USER_QUOTA");
        let result = render(&rest, &deploy("turnserver.conf.template"));
        assert!(!result.status.success());
        assert!(result.stdout.is_empty());
    }

    #[test]
    fn a_missing_template_stops_provisioning_when_rendered_inside_a_command_substitution() {
        // provision-coturn.sh calls the renderer as CONF="$(render_turnserver_conf ...)", where bash turns errexit off for the
        // function body.
        let mut lines = vec!["set -Eeuo pipefail".to_owned(), format!("source '{}'", deploy("render-turnserver-conf.sh"))];
        lines.extend(assignments(&values()));
        lines.push("CONF=\"$(render_turnserver_conf '/nonexistent/missing-turnserver.conf.template')\"".to_owned());
        lines.push("echo \"continued conf-length=${#CONF}\"".to_owned());
        let result = bash(&lines.join("\n"));
        assert!(!result.status.success());
        assert!(!String::from_utf8_lossy(&result.stdout).contains("continued"));
    }

    #[test]
    fn a_template_marker_the_renderer_does_not_know_fails_the_render_without_the_secret_in_the_error() {
        let directory = tempfile::tempdir().unwrap();
        let template = directory.path().join("turnserver.conf.template");
        mixdog_fsio::write(&mixdog_fsio::Unlaned, &template, "static-auth-secret=@TURN_AUTH_SECRET@\nunknown=@TURN_UNKNOWN@\n").unwrap();
        let result = render(&values(), template.to_str().unwrap());
        assert!(!result.status.success());
        assert!(result.stdout.is_empty());
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(stderr.contains("@TURN_UNKNOWN@"));
        assert!(!stderr.contains(values()["TURN_AUTH_SECRET"]));
    }
}
