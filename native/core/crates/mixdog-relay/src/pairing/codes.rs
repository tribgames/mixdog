//! Six-digit pairing codes and one-time tickets (`lib/pair-codes.mjs`, pairing v2). The main PC asks for a short-lived code
//! for its device route while Settings -> Connection is open; a phone, another PC or a browser enters it and learns the route
//! plus a one-time ticket. The code never grants access: the ticket only lets the following claim say "entered a code" on the
//! approval dialog, and the desktop still decides. Codes and tickets are secrets of a few minutes' life: they are held in
//! memory only and never written to any log or to disk.
//!
//! Every method that reads the clock has an `_at` form taking `Date.now()` as an argument; the plain form reads
//! [`now_ms`], the clock of `mixdog_rt`.

use std::collections::{BTreeMap, HashMap};

use ring::rand::{SecureRandom, SystemRandom};
use serde_json::{Value, json};

use crate::ids::is_routing_id;
use crate::js::{js_slice, js_trim};
use crate::rate_limit::now_ms;

pub const PAIR_CODE_TTL_MS: i64 = 300_000;
pub const MAX_PAIR_CODE_BODY_BYTES: usize = 1_024;
pub const MAX_PRESENCE_IDS: usize = 16;
pub const MAX_NAME_LENGTH: usize = 80;
/// The longest lease the relay echoes in its answer (`message.lease.slice(0, 64)`).
pub const MAX_LEASE_ECHO: usize = 64;

const MAX_ACTIVE_PAIR_CODES: usize = 10_000;
const MAX_PENDING_TICKETS: usize = 4_096;
const CODE_ATTEMPTS: usize = 50;

// Wrong guesses. A 6-digit space is only safe because attempts are scarce: each source gets a handful per window and then an
// exponentially growing lockout, and the whole code space shares one budget so a botnet of sources still cannot enumerate it
// inside a code's five-minute life.
pub const IP_FAILS_PER_STRIKE: u32 = 5;
pub const IP_BACKOFF_BASE_MS: i64 = 60_000;
const IP_BACKOFF_MAX_MS: i64 = 60 * 60_000;
const IP_STATE_TTL_MS: i64 = 60 * 60_000;
const MAX_IP_STATES: usize = 10_000;
pub const GLOBAL_FAIL_LIMIT: usize = 60;
const GLOBAL_FAIL_WINDOW_MS: i64 = 10 * 60_000;

/// `cleanName`: a desktop's name for itself. A non-string is the empty name; control characters are dropped, then
/// `String(name).trim().slice(0, 80)` in UTF-16 code units.
pub fn clean_name(value: Option<&str>) -> String {
    let Some(text) = value else { return String::new() };
    let stripped: String = text.chars().filter(|c| !matches!(*c, '\u{0}'..='\u{1f}' | '\u{7f}')).collect();
    js_slice(js_trim(&stripped), MAX_NAME_LENGTH)
}

/// `/^[A-Za-z0-9_-]{8,64}$/`.
pub fn is_lease(value: &str) -> bool {
    (8..=64).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `/^\d{6}$/`.
fn is_code(value: &str) -> bool {
    value.len() == 6 && value.bytes().all(|b| b.is_ascii_digit())
}

/// `/^[0-9a-f]{32}$/`.
fn is_ticket(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The ids a presence request asks about: the first [`MAX_PRESENCE_IDS`] entries of `body.ids` when it is an array, else none.
/// An entry is any JSON value; the caller keeps the strings that are routing ids of known devices.
pub fn presence_ids(body: &Value) -> Vec<&Value> {
    body.get("ids").and_then(Value::as_array).map_or_else(Vec::new, |ids| ids.iter().take(MAX_PRESENCE_IDS).collect())
}

/// The answer to a desktop's `pair-code-request`: `lease` is the request's lease cut to 64 code units, or empty when it was not
/// a string.
pub fn issued_answer(lease: Option<&str>, result: &Issue) -> Value {
    let lease = lease.map_or_else(String::new, |text| js_slice(text, MAX_LEASE_ECHO));
    match result {
        Issue::Ok { code, ttl_ms, .. } => {
            json!({"type": "pair-code-issued", "lease": lease, "ok": true, "code": code, "expiresInMs": ttl_ms})
        }
        Issue::Invalid | Issue::Full => json!({"type": "pair-code-issued", "lease": lease, "ok": false}),
    }
}

/// What [`PairCodes::issue`] answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Issue {
    Ok { code: String, lease: String, ttl_ms: i64 },
    Invalid,
    Full,
}

/// What [`PairCodes::resolve`] answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolve {
    Ok { device_id: String, name: String, ticket: String, lease: String },
    Limited { retry_after_ms: i64 },
    Invalid,
}

struct CodeRow {
    device_id: String,
    lease: String,
    name: String,
    expires_at: i64,
}

struct TicketRow {
    device_id: String,
    expires_at: i64,
}

#[derive(Clone, Copy)]
struct IpState {
    fails: u32,
    strikes: u32,
    blocked_until: i64,
    seen_at: i64,
}

/// A `Map` that keeps insertion order: the oldest entry is the one evicted at a cap, and setting a key again moves it last.
struct Ordered<V> {
    next: u64,
    rows: HashMap<String, (u64, V)>,
    order: BTreeMap<u64, String>,
}

impl<V> Ordered<V> {
    fn new() -> Self {
        Self { next: 0, rows: HashMap::new(), order: BTreeMap::new() }
    }

    fn len(&self) -> usize {
        self.rows.len()
    }

    fn get(&self, key: &str) -> Option<&V> {
        self.rows.get(key).map(|(_, value)| value)
    }

    fn remove(&mut self, key: &str) -> Option<V> {
        let (seq, value) = self.rows.remove(key)?;
        self.order.remove(&seq);
        Some(value)
    }

    fn insert(&mut self, key: String, value: V) {
        drop(self.remove(&key));
        let seq = self.next;
        self.next += 1;
        self.order.insert(seq, key.clone());
        self.rows.insert(key, (seq, value));
    }

    fn remove_oldest(&mut self) -> bool {
        let Some(key) = self.order.values().next().cloned() else { return false };
        drop(self.remove(&key));
        true
    }

    fn retain(&mut self, keep: impl Fn(&V) -> bool) {
        let dead: Vec<String> = self.rows.iter().filter(|(_, (_, value))| !keep(value)).map(|(key, _)| key.clone()).collect();
        for key in dead {
            drop(self.remove(&key));
        }
    }
}

/// Bytes from the operating system's CSPRNG; `None` when it fails.
fn random_bytes<const N: usize>() -> Option<[u8; N]> {
    let mut bytes = [0u8; N];
    SystemRandom::new().fill(&mut bytes).ok()?;
    Some(bytes)
}

/// `crypto.randomInt(0, 1_000_000)`: uniform, by rejecting the top of the 32-bit range that would bias the remainder.
fn random_below_million() -> Option<u32> {
    const LIMIT: u32 = (u32::MAX / 1_000_000) * 1_000_000;
    loop {
        let value = u32::from_le_bytes(random_bytes::<4>()?);
        if value < LIMIT {
            return Some(value % 1_000_000);
        }
    }
}

pub struct PairCodes {
    codes: HashMap<String, CodeRow>,
    by_device: HashMap<String, String>,
    tickets: Ordered<TicketRow>,
    ip_states: Ordered<IpState>,
    global_fails: Vec<i64>,
}

impl Default for PairCodes {
    fn default() -> Self {
        Self::new()
    }
}

impl PairCodes {
    pub fn new() -> Self {
        Self { codes: HashMap::new(), by_device: HashMap::new(), tickets: Ordered::new(), ip_states: Ordered::new(), global_fails: Vec::new() }
    }

    fn sweep(&mut self, now: i64) {
        let dead: Vec<String> = self.codes.iter().filter(|(_, row)| row.expires_at <= now).map(|(code, _)| code.clone()).collect();
        for code in dead {
            let Some(row) = self.codes.remove(&code) else { continue };
            if self.by_device.get(&row.device_id) == Some(&code) {
                self.by_device.remove(&row.device_id);
            }
        }
        self.tickets.retain(|row| row.expires_at > now);
    }

    /// Issues a fresh relay-chosen code under a desktop-named lease. The caller never picks or sees any other code, so it
    /// cannot probe the code space. One live code per device; the lease's expiry is fixed at issue time. `lease` and `name` are
    /// the request's fields, `None` when they are not strings.
    pub fn issue(&mut self, device_id: &str, lease: Option<&str>, name: Option<&str>) -> Issue {
        self.issue_at(device_id, lease, name, now_ms())
    }

    /// [`Self::issue`] at a given time.
    pub fn issue_at(&mut self, device_id: &str, lease: Option<&str>, name: Option<&str>, now: i64) -> Issue {
        let Some(lease) = lease.filter(|text| is_lease(text)) else { return Issue::Invalid };
        if !is_routing_id(device_id) {
            return Issue::Invalid;
        }
        self.sweep(now);
        self.clear(device_id);
        if self.codes.len() >= MAX_ACTIVE_PAIR_CODES {
            return Issue::Full;
        }
        let mut code = None;
        for _ in 0..CODE_ATTEMPTS {
            let Some(value) = random_below_million() else { break };
            let candidate = format!("{value:06}");
            if !self.codes.contains_key(&candidate) {
                code = Some(candidate);
                break;
            }
        }
        let Some(code) = code else { return Issue::Full };
        self.codes.insert(
            code.clone(),
            CodeRow { device_id: device_id.to_owned(), lease: lease.to_owned(), name: clean_name(name), expires_at: now + PAIR_CODE_TTL_MS },
        );
        self.by_device.insert(device_id.to_owned(), code.clone());
        Issue::Ok { code, lease: lease.to_owned(), ttl_ms: PAIR_CODE_TTL_MS }
    }

    /// Withdraws the device's live code: `pair-code-clear`, or the close of its live desktop leg.
    pub fn clear(&mut self, device_id: &str) {
        if let Some(code) = self.by_device.remove(device_id) {
            self.codes.remove(&code);
        }
    }

    fn ip_state(&mut self, ip: &str, now: i64) -> Option<IpState> {
        let state = self.ip_states.get(ip).copied()?;
        if now - state.seen_at > IP_STATE_TTL_MS && state.blocked_until <= now {
            drop(self.ip_states.remove(ip));
            return None;
        }
        Some(state)
    }

    /// Milliseconds this source (or the whole code space) must still wait, else 0.
    pub fn retry_after_ms(&mut self, ip: &str) -> i64 {
        self.retry_after_ms_at(ip, now_ms())
    }

    /// [`Self::retry_after_ms`] at a given time.
    pub fn retry_after_ms_at(&mut self, ip: &str, now: i64) -> i64 {
        let ip_wait = self.ip_state(ip, now).map_or(0, |state| (state.blocked_until - now).max(0));
        self.global_fails.retain(|stamp| *stamp > now - GLOBAL_FAIL_WINDOW_MS);
        let global_wait = match self.global_fails.first() {
            Some(first) if self.global_fails.len() >= GLOBAL_FAIL_LIMIT => first + GLOBAL_FAIL_WINDOW_MS - now,
            _ => 0,
        };
        ip_wait.max(global_wait)
    }

    fn note_failure(&mut self, ip: &str, now: i64) {
        self.global_fails.push(now);
        let mut state = match self.ip_state(ip, now) {
            Some(state) => state,
            None => {
                if self.ip_states.len() >= MAX_IP_STATES {
                    self.ip_states.remove_oldest();
                }
                IpState { fails: 0, strikes: 0, blocked_until: 0, seen_at: now }
            }
        };
        drop(self.ip_states.remove(ip));
        state.seen_at = now;
        state.fails += 1;
        if state.fails >= IP_FAILS_PER_STRIKE {
            state.fails = 0;
            state.strikes += 1;
            let backoff = IP_BACKOFF_BASE_MS.saturating_mul(1i64.checked_shl(state.strikes - 1).unwrap_or(i64::MAX));
            state.blocked_until = now.saturating_add(backoff.min(IP_BACKOFF_MAX_MS));
        }
        self.ip_states.insert(ip.to_owned(), state);
    }

    /// Looks a code up for one caller. A right code is consumed (single use): it is deleted before the ticket is minted.
    pub fn resolve(&mut self, code: Option<&str>, ip: &str) -> Resolve {
        self.resolve_at(code, ip, now_ms())
    }

    /// [`Self::resolve`] at a given time.
    pub fn resolve_at(&mut self, code: Option<&str>, ip: &str, now: i64) -> Resolve {
        self.sweep(now);
        let wait = self.retry_after_ms_at(ip, now);
        if wait > 0 {
            return Resolve::Limited { retry_after_ms: wait };
        }
        let row = code.filter(|text| is_code(text)).and_then(|text| self.codes.remove(text));
        let Some(row) = row else {
            self.note_failure(ip, now);
            return Resolve::Invalid;
        };
        self.by_device.remove(&row.device_id);
        let Some(ticket) = self.mint_ticket(&row.device_id, now) else { return Resolve::Invalid };
        Resolve::Ok { device_id: row.device_id, name: row.name, ticket, lease: row.lease }
    }

    fn mint_ticket(&mut self, device_id: &str, now: i64) -> Option<String> {
        while self.tickets.len() >= MAX_PENDING_TICKETS {
            if !self.tickets.remove_oldest() {
                break;
            }
        }
        let bytes = random_bytes::<16>()?;
        let ticket: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        self.tickets.insert(ticket.clone(), TicketRow { device_id: device_id.to_owned(), expires_at: now + PAIR_CODE_TTL_MS });
        Some(ticket)
    }

    /// True once, for a live ticket minted for this device.
    pub fn take_ticket(&mut self, ticket: Option<&str>, device_id: &str) -> bool {
        self.take_ticket_at(ticket, device_id, now_ms())
    }

    /// [`Self::take_ticket`] at a given time.
    pub fn take_ticket_at(&mut self, ticket: Option<&str>, device_id: &str, now: i64) -> bool {
        let Some(ticket) = ticket.filter(|text| is_ticket(text)) else { return false };
        match self.tickets.remove(ticket) {
            Some(row) => row.device_id == device_id && row.expires_at > now,
            None => false,
        }
    }
}
