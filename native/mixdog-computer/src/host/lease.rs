//! The desktop host's foreground-lock lease over stdio: a request line on
//! stdout, its answer on stdin (MixForegroundLockHost, MixForegroundLock.cs:328-443).
//! Only the process that started this host holds the write end of its stdin,
//! so nothing else can answer, and an answer counts only when it names the
//! request waiting: its action and sequence, and for a release the lease.
#![cfg_attr(not(windows), allow(dead_code, reason = "only Windows has a foreground lock to lease"))]

use crate::lease_api::{ForegroundLease, LeaseAnswer, NoLease};
use serde_json::{json, Value};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::Duration;

/// How long a request waits for its answer (AnswerTimeoutMs, :338).
const ANSWER_TIMEOUT_MS: f64 = 250.0;

/// The answers this process's stdin carries.
static STDIN: Channel = Channel::new();

/// The lease channel this host was started with (FromEnvironment, :349-353).
pub(super) fn from_env() -> Box<dyn ForegroundLease> {
    #[cfg(windows)]
    if crate::config::host_foreground_lock() {
        use crate::protocol::{write_line, FGLOCK_MARKER};
        return Box::new(StdioLease {
            channel: &STDIN,
            now: crate::platform::lease_now_ms,
            send: Box::new(|request| write_line(FGLOCK_MARKER, request)),
        });
    }
    Box::new(NoLease)
}

/// One answer line from stdin, without its marker.
pub(super) fn receive(body: &str) {
    STDIN.receive(body);
}

/// Stdin closed: nothing can answer any more.
pub(super) fn input_ended() {
    STDIN.input_ended();
}

/// The request waiting for its answer.
struct Waiter {
    kind: &'static str,
    action: i64,
    seq: i64,
    lease: i64,
    reply: Option<Reply>,
}

/// An answer naming the waiting request: "ack action seq lease answer
/// deadline" or "released action seq lease outcome".
struct Reply {
    lease: i64,
    /// The acquire's answer, or how the release ended.
    word: String,
    deadline: Option<String>,
}

struct State {
    waiting: Option<Waiter>,
    input_ended: bool,
}

/// Where the stdin reader leaves an answer for the request thread.
struct Channel {
    state: Mutex<State>,
    answered: Condvar,
}

/// An id as the host writes it: digits only (TryId, :354-358).
fn id(text: &str) -> Option<i64> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

impl Channel {
    const fn new() -> Channel {
        Channel {
            state: Mutex::new(State { waiting: None, input_ended: false }),
            answered: Condvar::new(),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Hands an answer to the request it names; anything else is dropped
    /// (Receive, :362-381).
    fn receive(&self, body: &str) {
        let parts: Vec<&str> = body.split(' ').collect();
        if parts.len() < 5 {
            return;
        }
        let (Some(action), Some(seq), Some(lease)) = (id(parts[1]), id(parts[2]), id(parts[3])) else {
            return;
        };
        let mut state = self.state();
        let Some(waiter) = state.waiting.as_mut() else { return };
        if waiter.reply.is_some() || waiter.kind != parts[0] || waiter.action != action || waiter.seq != seq {
            return;
        }
        if waiter.kind == "released" && waiter.lease != 0 && waiter.lease != lease {
            return;
        }
        waiter.reply = Some(Reply {
            lease,
            word: parts[4].to_string(),
            deadline: parts.get(5).map(|deadline| deadline.to_string()),
        });
        self.answered.notify_all();
    }

    /// Wakes the request waiting and refuses every later one (InputEnded,
    /// :383-390).
    fn input_ended(&self) {
        self.state().input_ended = true;
        self.answered.notify_all();
    }
}

/// The lease as this host asks for it (IMixLeaseChannel, :317-326).
struct StdioLease<'a> {
    channel: &'a Channel,
    /// The lease clock, in milliseconds.
    now: fn() -> f64,
    /// Writes one request to the host.
    send: Box<dyn Fn(&Value) + 'a>,
}

impl StdioLease<'_> {
    /// Sends `request` and waits until `until` on the lease clock for the
    /// answer of `kind` naming it (Ask, :417-442).
    fn ask(&self, kind: &'static str, action: i64, seq: u32, lease: u32, request: &Value, until: f64) -> Option<Reply> {
        {
            let mut state = self.channel.state();
            if state.input_ended {
                return None;
            }
            state.waiting = Some(Waiter { kind, action, seq: seq.into(), lease: lease.into(), reply: None });
        }
        (self.send)(request);
        let mut state = self.channel.state();
        loop {
            let answered = state.waiting.as_ref().is_none_or(|waiter| waiter.reply.is_some());
            let left = until - (self.now)();
            if answered || state.input_ended || left.is_nan() || left <= 0.0 {
                break;
            }
            // A wake that brought no answer waits again, never past `until`.
            let wait = Duration::from_millis(left.min(ANSWER_TIMEOUT_MS).ceil() as u64);
            state = match self.channel.answered.wait_timeout(state, wait) {
                Ok((state, _)) => state,
                Err(poisoned) => poisoned.into_inner().0,
            };
        }
        state.waiting.take()?.reply
    }
}

impl ForegroundLease for StdioLease<'_> {
    /// Acquire (:391-407) with the caller's reading of its answer (:160-193).
    fn acquire(&self, action: i64, seq: u32, hold_ms: u32, answer_by: f64) -> LeaseAnswer {
        if action <= 0 {
            return LeaseAnswer::NoRequest;
        }
        // No answer could ever count, and JSON has no number for it.
        if !answer_by.is_finite() {
            return LeaseAnswer::NoAnswer;
        }
        // "0.###" in the C#: at most three decimals.
        let request = json!({
            "op": "acquire",
            "action": action,
            "seq": seq,
            "hold_ms": hold_ms,
            "answer_by": (answer_by * 1000.0).round() / 1000.0,
        });
        let Some(reply) = self.ask("ack", action, seq, 0, &request, answer_by) else {
            return LeaseAnswer::NoAnswer;
        };
        let deadline_at = reply.deadline.and_then(|deadline| deadline.parse::<f64>().ok());
        let (Ok(lease), Some(deadline_at)) = (u32::try_from(reply.lease), deadline_at.filter(|at| at.is_finite()))
        else {
            return LeaseAnswer::NoAnswer;
        };
        if reply.word != "locked" || lease == 0 {
            return LeaseAnswer::Refused(reply.word);
        }
        if (self.now)() >= deadline_at {
            // Still a hold the host opened: its release names the lease.
            return LeaseAnswer::ExpiredOnArrival { lease, deadline_at };
        }
        LeaseAnswer::Locked { lease, deadline_at }
    }

    /// Release (:408-416); an answer that is none of the host's words, or no
    /// answer, is no_ack (:236-239).
    fn release(&self, action: i64, seq: u32, lease: u32) -> String {
        let request = json!({ "op": "release", "action": action, "seq": seq, "lease": lease });
        let until = (self.now)() + ANSWER_TIMEOUT_MS;
        match self.ask("released", action, seq, lease, &request, until) {
            Some(reply) if matches!(reply.word.as_str(), "released" | "failed" | "unknown" | "none") => reply.word,
            _ => "no_ack".into(),
        }
    }

    fn offered(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::time::Instant;

    /// A monotonic stand-in for the lease clock.
    fn now() -> f64 {
        static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
        1000.0 + START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
    }

    fn at(offset: f64) -> String {
        format!("{:.3}", now() + offset)
    }

    /// A host that answers each request, as it is written, with the next feed
    /// of answer bodies; the requests it saw are kept.
    struct Host {
        channel: Channel,
        feeds: RefCell<Vec<Vec<String>>>,
        requests: RefCell<Vec<String>>,
    }

    impl Host {
        fn new(feeds: &[&[String]]) -> Host {
            Host {
                channel: Channel::new(),
                feeds: RefCell::new(feeds.iter().rev().map(|feed| feed.to_vec()).collect()),
                requests: RefCell::new(Vec::new()),
            }
        }
        fn lease(&self) -> StdioLease<'_> {
            StdioLease {
                channel: &self.channel,
                now,
                send: Box::new(|request| {
                    self.requests.borrow_mut().push(request.to_string());
                    for body in self.feeds.borrow_mut().pop().unwrap_or_default() {
                        self.channel.receive(&body);
                    }
                }),
            }
        }
    }

    // The feed of foreground-lock-worker.test.mjs:63-71, as the stdin reader
    // hands it over: only the answer naming the request counts.
    #[test]
    fn only_the_answer_naming_the_request_counts() {
        let deadline = at(60_000.0);
        let host = Host::new(&[&[
            format!("ack 99 1 5 locked {deadline}"),
            format!("ack 7 2 5 locked {deadline}"),
            "released 7 1 5 released".to_string(),
            format!("ack 7 x 5 locked {deadline}"),
            String::new(),
            format!("ack 7 1 12 locked {deadline}"),
            format!("ack 7 1 13 locked {deadline}"),
        ]]);
        let answer = host.lease().acquire(7, 1, 100, 1234.56789);
        assert_eq!(answer, LeaseAnswer::Locked { lease: 12, deadline_at: deadline.parse().unwrap() });
        assert_eq!(
            *host.requests.borrow(),
            [r#"{"op":"acquire","action":7,"seq":1,"hold_ms":100,"answer_by":1234.568}"#]
        );
        assert!(host.channel.state().waiting.is_none());
    }

    #[test]
    fn ids_are_digits_only() {
        assert_eq!(id("12"), Some(12));
        for text in ["", "x", "+1", "-1", " 1", "1.0", "99999999999999999999"] {
            assert_eq!(id(text), None, "{text:?}");
        }
    }

    #[test]
    fn a_release_naming_another_lease_is_ignored() {
        let feed = ["released 7 1 13 released".to_string(), "released 7 1 12 released".to_string()];
        let host = Host::new(&[&feed[..1], &feed]);
        let lease = host.lease();
        assert_eq!(lease.release(7, 1, 12), "no_ack");
        assert_eq!(lease.release(7, 1, 12), "released");
        assert_eq!(host.requests.borrow()[0], r#"{"op":"release","action":7,"seq":1,"lease":12}"#);
        // A release that names no lease takes the answer for any.
        let host = Host::new(&[&feed[..1]]);
        assert_eq!(host.lease().release(7, 1, 0), "released");
    }

    #[test]
    fn a_release_outcome_outside_the_hosts_words_is_no_ack() {
        for (word, outcome) in
            [("failed", "failed"), ("unknown", "unknown"), ("none", "none"), ("locked", "no_ack"), ("", "no_ack")]
        {
            let host = Host::new(&[&[format!("released 7 1 12 {word}")]]);
            assert_eq!(host.lease().release(7, 1, 12), outcome, "{word:?}");
        }
    }

    // Nothing naming the request in time: no lock, and the unanswered release
    // is no_ack, since the host may still hold a lease it granted late.
    #[test]
    fn no_answer_in_time_leaves_the_release_to_ask() {
        let host = Host::new(&[&[format!("ack 7 3 14 locked {}", at(60_000.0))]]);
        let lease = host.lease();
        let asked = now();
        assert_eq!(lease.acquire(7, 4, 100, asked + 30.0), LeaseAnswer::NoAnswer);
        assert!(now() >= asked + 30.0);
        // The answer arriving after the wait names no request waiting.
        host.channel.receive(&format!("ack 7 4 14 locked {}", at(60_000.0)));
        assert!(host.channel.state().waiting.is_none());
        assert_eq!(lease.release(7, 4, 0), "no_ack");
        assert_eq!(host.requests.borrow().len(), 2);
    }

    #[test]
    fn an_answer_by_already_past_asks_without_waiting() {
        let host = Host::new(&[&[format!("ack 7 1 5 locked {}", at(60_000.0))]]);
        let lease = host.lease();
        assert!(matches!(lease.acquire(7, 1, 100, now() - 1.0), LeaseAnswer::Locked { lease: 5, .. }));
        assert_eq!(lease.acquire(7, 2, 100, now() - 1.0), LeaseAnswer::NoAnswer);
        assert_eq!(host.requests.borrow().len(), 2);
        // A time no clock reaches sends nothing.
        assert_eq!(lease.acquire(7, 3, 100, f64::NAN), LeaseAnswer::NoAnswer);
        assert_eq!(host.requests.borrow().len(), 2);
    }

    // A lease whose deadline passed before its answer arrived protects nothing.
    #[test]
    fn a_lease_past_its_deadline_is_expired_on_arrival() {
        let host = Host::new(&[&[format!("ack 7 3 15 locked {}", at(-1.0))]]);
        assert!(matches!(
            host.lease().acquire(7, 3, 100, now() + 250.0),
            LeaseAnswer::ExpiredOnArrival { lease: 15, .. }
        ));
    }

    #[test]
    fn an_answer_without_a_lock_is_refused_in_the_hosts_word() {
        let deadline = at(60_000.0);
        let host = Host::new(&[
            &[format!("ack 7 1 0 refused {deadline}")],
            &[format!("ack 7 2 0 locked {deadline}")],
            &["ack 7 3 0 unavailable 0.000".to_string()],
        ]);
        let lease = host.lease();
        assert_eq!(lease.acquire(7, 1, 100, now() + 250.0), LeaseAnswer::Refused("refused".into()));
        assert_eq!(lease.acquire(7, 2, 100, now() + 250.0), LeaseAnswer::Refused("locked".into()));
        assert_eq!(lease.acquire(7, 3, 100, now() + 250.0), LeaseAnswer::Refused("unavailable".into()));
    }

    #[test]
    fn an_ack_that_cannot_be_read_is_no_answer() {
        let host = Host::new(&[
            &["ack 7 1 5 locked".to_string()],
            &["ack 7 2 5 locked soon".to_string()],
            &["ack 7 3 5 locked inf".to_string()],
            &["ack 7 4 4294967296 locked 1.000".to_string()],
        ]);
        let lease = host.lease();
        for seq in 1..=4 {
            assert_eq!(lease.acquire(7, seq, 100, now() + 250.0), LeaseAnswer::NoAnswer, "{seq}");
        }
    }

    #[test]
    fn a_delivery_outside_a_request_is_never_asked_for() {
        let host = Host::new(&[]);
        let lease = host.lease();
        assert!(lease.offered());
        assert_eq!(lease.acquire(0, 1, 100, now() + 250.0), LeaseAnswer::NoRequest);
        assert_eq!(lease.acquire(-3, 1, 100, now() + 250.0), LeaseAnswer::NoRequest);
        assert!(host.requests.borrow().is_empty());
    }

    #[test]
    fn the_end_of_input_refuses_every_later_request_unsent() {
        let host = Host::new(&[]);
        host.channel.input_ended();
        let lease = host.lease();
        assert_eq!(lease.acquire(7, 1, 100, now() + 60_000.0), LeaseAnswer::NoAnswer);
        assert_eq!(lease.release(7, 1, 0), "no_ack");
        assert!(host.requests.borrow().is_empty());
    }

    #[test]
    fn the_end_of_input_wakes_the_request_waiting() {
        static CHANNEL: Channel = Channel::new();
        let lease = StdioLease {
            channel: &CHANNEL,
            now,
            // The reader's thread sees the input end while the request waits.
            send: Box::new(|_| drop(std::thread::spawn(|| CHANNEL.input_ended()))),
        };
        let asked = Instant::now();
        assert_eq!(lease.acquire(7, 1, 100, now() + 60_000.0), LeaseAnswer::NoAnswer);
        assert!(asked.elapsed() < Duration::from_secs(30));
    }

    #[test]
    fn an_answer_from_the_readers_thread_reaches_the_request_waiting() {
        static CHANNEL: Channel = Channel::new();
        let lease = StdioLease {
            channel: &CHANNEL,
            now,
            send: Box::new(|_| {
                drop(std::thread::spawn(|| {
                    std::thread::sleep(Duration::from_millis(20));
                    CHANNEL.receive(&format!("ack 7 1 9 locked {}", at(60_000.0)));
                }))
            }),
        };
        let asked = Instant::now();
        assert!(matches!(lease.acquire(7, 1, 100, now() + 60_000.0), LeaseAnswer::Locked { lease: 9, .. }));
        assert!(asked.elapsed() < Duration::from_secs(30));
    }

    #[test]
    fn without_its_environment_switch_no_lease_is_offered() {
        if !crate::config::host_foreground_lock() {
            assert!(!from_env().offered());
        }
    }
}
