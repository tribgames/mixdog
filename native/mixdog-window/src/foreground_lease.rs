//! The foreground-lock leases of the process that hosts the Computer Use
//! bridge, owned by one native thread of this module.
//!
//! Windows gives LockSetForegroundWindow to a process that may set the
//! foreground. A pooled Computer Use worker rarely may, the process the user
//! works in does, and the lock then belongs to that process, so this thread
//! both takes and ends it. The thread does nothing else (no accessibility
//! call, no wait on any acknowledgement), so a lease ends at its deadline on
//! this thread's own clock however long the JavaScript event loop is blocked.
//! The protection stays best effort: Windows also lifts the lock on the user's
//! Alt key or click.
//!
//! All times are milliseconds on QueryPerformanceCounter, the clock the worker
//! reads too (MixForegroundLock.cs), so its deadlines compare across processes.
//!
//! One lease at a time. A lease ends at the earliest of its deadline
//! (`MAX_HOLD_MS` at most, however long was asked), the release by the request
//! that took it, the end of the worker that asked, and the end of the thread.
//! An unlock that is not proven (false: Windows may have lifted the lock) is
//! retried on a short schedule and reported as unknown, never as released; one
//! whose call could not be made is reported as failed and retried every
//! second, and no new lease starts until an unlock call answers.

use std::collections::VecDeque;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use napi::bindgen_prelude::{Error, Function, Result};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi_derive::napi;

/// No lease holds every other app's foreground changes for longer.
const MAX_HOLD_MS: f64 = 1000.0;
/// Delays before each further attempt of one unlock that did not succeed.
const UNLOCK_RETRY_MS: [u64; 3] = [10, 20, 40];
/// While unlock calls keep failing outright, one more is tried this often.
const FAILED_RETRY_MS: u64 = 1000;
/// Ended leases kept to answer a release that arrives after the end.
const RECENT_LEASES: usize = 64;

const LSFW_LOCK: u32 = 1;
const LSFW_UNLOCK: u32 = 2;

// ---------------------------------------------------------------------------
// The system calls the lease thread makes.

/// What a LockSetForegroundWindow call returned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Call {
    pub ok: bool,
    /// GetLastError after a false return, else 0.
    pub error: u32,
}

/// The calls of the lease thread; an `Err` is a call that could not be made.
/// The production implementation is `Win32`; tests stand in for user32.
pub trait Native: Send + 'static {
    /// Milliseconds on the performance counter.
    fn now(&self) -> std::result::Result<f64, String>;
    fn foreground_process_id(&self) -> std::result::Result<u32, String>;
    /// LockSetForegroundWindow(LSFW_LOCK).
    fn lock(&self) -> std::result::Result<Call, String>;
    /// LockSetForegroundWindow(LSFW_UNLOCK): false when this process does not
    /// hold the lock, which includes Windows having lifted it.
    fn unlock(&self) -> std::result::Result<Call, String>;
}

type Hwnd = isize;

#[link(name = "user32", kind = "raw-dylib")]
extern "system" {
    fn GetForegroundWindow() -> Hwnd;
    fn GetWindowThreadProcessId(hwnd: Hwnd, process_id: *mut u32) -> u32;
    fn LockSetForegroundWindow(code: u32) -> i32;
}

#[link(name = "kernel32", kind = "raw-dylib")]
extern "system" {
    fn QueryPerformanceCounter(count: *mut i64) -> i32;
    fn QueryPerformanceFrequency(frequency: *mut i64) -> i32;
}

fn lock_set_foreground(code: u32) -> Call {
    let ok = unsafe { LockSetForegroundWindow(code) } != 0;
    let error = if ok { 0 } else { std::io::Error::last_os_error().raw_os_error().unwrap_or(0) as u32 };
    Call { ok, error }
}

/// The real user32 and kernel32.
pub struct Win32 {
    ticks_per_ms: f64,
}

impl Win32 {
    pub fn new() -> std::result::Result<Self, String> {
        let mut frequency = 0i64;
        if unsafe { QueryPerformanceFrequency(&mut frequency) } == 0 || frequency <= 0 {
            return Err("QueryPerformanceFrequency failed".to_owned());
        }
        Ok(Self { ticks_per_ms: frequency as f64 / 1000.0 })
    }
}

impl Native for Win32 {
    fn now(&self) -> std::result::Result<f64, String> {
        let mut count = 0i64;
        if unsafe { QueryPerformanceCounter(&mut count) } == 0 {
            return Err("QueryPerformanceCounter failed".to_owned());
        }
        Ok(count as f64 / self.ticks_per_ms)
    }

    fn foreground_process_id(&self) -> std::result::Result<u32, String> {
        let window = unsafe { GetForegroundWindow() };
        if window == 0 {
            return Ok(0);
        }
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(window, &mut pid) };
        Ok(pid)
    }

    fn lock(&self) -> std::result::Result<Call, String> {
        Ok(lock_set_foreground(LSFW_LOCK))
    }

    fn unlock(&self) -> std::result::Result<Call, String> {
        Ok(lock_set_foreground(LSFW_UNLOCK))
    }
}

// ---------------------------------------------------------------------------
// Facts: the thread's account of one lease, reported with its answer and end.

#[derive(Clone, Debug, PartialEq)]
pub enum Fact {
    Int(i64),
    Num(f64),
    Text(String),
    List(Vec<Fact>),
}

impl From<u32> for Fact {
    fn from(value: u32) -> Self {
        Fact::Int(i64::from(value))
    }
}
impl From<i64> for Fact {
    fn from(value: i64) -> Self {
        Fact::Int(value)
    }
}
impl From<f64> for Fact {
    fn from(value: f64) -> Self {
        Fact::Num(value)
    }
}
impl From<&str> for Fact {
    fn from(value: &str) -> Self {
        Fact::Text(value.to_owned())
    }
}
impl From<String> for Fact {
    fn from(value: String) -> Self {
        Fact::Text(value)
    }
}

#[derive(Clone, Debug, Default)]
pub struct Facts(Vec<(&'static str, Fact)>);

/// Tenths of a millisecond, the precision the facts keep.
fn round(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn json_text(text: &str, out: &mut String) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

impl Fact {
    fn write(&self, out: &mut String) {
        match self {
            Fact::Int(value) => out.push_str(&value.to_string()),
            Fact::Num(value) if value.is_finite() => out.push_str(&value.to_string()),
            Fact::Num(_) => out.push_str("null"),
            Fact::Text(text) => json_text(text, out),
            Fact::List(items) => {
                out.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    item.write(out);
                }
                out.push(']');
            }
        }
    }
}

impl Facts {
    fn set(&mut self, key: &'static str, value: impl Into<Fact>) {
        let value = value.into();
        match self.0.iter_mut().find(|(name, _)| *name == key) {
            Some(entry) => entry.1 = value,
            None => self.0.push((key, value)),
        }
    }

    /// A time in milliseconds, rounded; nothing when the clock could not be read.
    fn set_time(&mut self, key: &'static str, value: Option<f64>) {
        if let Some(value) = value {
            self.set(key, round(value));
        }
    }

    fn push(&mut self, key: &'static str, value: Fact) {
        match self.0.iter_mut().find(|(name, _)| *name == key) {
            Some((_, Fact::List(items))) => items.push(value),
            _ => self.0.push((key, Fact::List(vec![value]))),
        }
    }

    #[cfg(test)]
    pub fn get(&self, key: &str) -> Option<&Fact> {
        self.0.iter().find(|(name, _)| *name == key).map(|(_, value)| value)
    }

    pub fn to_json(&self) -> String {
        let mut out = String::from("{");
        for (index, (key, value)) in self.0.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            json_text(key, &mut out);
            out.push(':');
            value.write(&mut out);
        }
        out.push('}');
        out
    }
}

// ---------------------------------------------------------------------------
// Requests, answers, events.

/// An acquire request of one worker: its own number, process, action and
/// sequence; how long it asks the lock held; and the instant (on the
/// performance counter) after which it no longer waits for the answer.
#[derive(Clone, Copy, Debug)]
pub struct Request {
    pub instance: u32,
    pub pid: u32,
    pub action: u32,
    pub seq: u32,
    pub hold_ms: u32,
    pub answer_by: f64,
}

/// A release request. `lease` 0 names no lease: the request alone says which.
#[derive(Clone, Copy, Debug)]
pub struct End {
    pub instance: u32,
    pub action: u32,
    pub seq: u32,
    pub lease: u32,
}

/// The answer to an acquire request. `answer` is one of unavailable, busy,
/// expired, refused, locked, quarantined. `holding`: the thread may still hold
/// the lock (a lease, or an unlock it has not proven) after the answer.
#[derive(Clone, Debug)]
pub struct Answer {
    pub holding: bool,
    pub lease: u32,
    pub answer: &'static str,
    pub deadline_at: f64,
    pub facts: Facts,
}

/// The end of a lease. `outcome` is released, unknown or failed, or none for a
/// release that names nothing this thread took. `reply`: a worker asked for
/// the release and is waiting for it.
#[derive(Clone, Debug)]
pub struct Released {
    pub holding: bool,
    pub instance: u32,
    pub action: u32,
    pub seq: u32,
    pub lease: u32,
    pub outcome: &'static str,
    pub reply: bool,
    pub facts: Option<Facts>,
}

impl Released {
    pub fn to_json(&self) -> String {
        let mut outcome = String::new();
        json_text(self.outcome, &mut outcome);
        format!(
            "{{\"holding\":{},\"instance\":{},\"action\":{},\"seq\":{},\"lease\":{},\"outcome\":{},\"reply\":{},\"facts\":{}}}",
            self.holding,
            self.instance,
            self.action,
            self.seq,
            self.lease,
            outcome,
            self.reply,
            self.facts.as_ref().map_or_else(|| "null".to_owned(), Facts::to_json),
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Unlock {
    Released,
    Unknown,
    Failed,
}

impl Unlock {
    fn as_str(self) -> &'static str {
        match self {
            Unlock::Released => "released",
            Unlock::Unknown => "unknown",
            Unlock::Failed => "failed",
        }
    }
}

// ---------------------------------------------------------------------------
// The lease owner: all state lives on the lease thread.

#[derive(Clone, Copy, Debug)]
struct Retry {
    at: Instant,
    /// The number of the attempt this retry makes (an ending lease's unlock).
    retries: usize,
}

#[derive(Clone, Debug)]
struct Held {
    id: u32,
    instance: u32,
    action: u32,
    seq: u32,
    acquired_at: f64,
    deadline_at: f64,
    facts: Facts,
    /// When the deadline is due on this thread's own timer.
    timer: Option<Instant>,
    retry: Option<Retry>,
    reply_wanted: bool,
    release: Option<Unlock>,
    unlock_attempts: i64,
}

impl Held {
    fn owned_by(&self, end: &End) -> bool {
        self.instance == end.instance
            && self.action == end.action
            && self.seq == end.seq
            && (end.lease == 0 || end.lease == self.id)
    }
}

/// The clock, which no step that holds or ends a lock may die of: a call that
/// fails gives nothing, recorded on the lease's facts when there is one, and a
/// deadline read that way counts as reached, so a failing clock ends a lease
/// rather than keeping it.
fn clock(native: &dyn Native, facts: Option<&mut Facts>) -> Option<f64> {
    match native.now() {
        Ok(value) => Some(value),
        Err(error) => {
            if let Some(facts) = facts {
                facts.set("clock_error", error);
            }
            None
        }
    }
}

struct Owner<N: Native> {
    native: N,
    emit: Box<dyn Fn(Released) + Send>,
    generation: u32,
    /// The lease holding the lock.
    lease: Option<Held>,
    /// A lease whose unlock is still being tried; no new lease starts meanwhile.
    ending: Option<Held>,
    /// A lease whose unlock calls all failed outright; retried until one answers.
    failed: Option<Held>,
    recent: VecDeque<((u32, u32, u32), Held)>,
}

impl<N: Native> Owner<N> {
    fn new(native: N, emit: Box<dyn Fn(Released) + Send>) -> Self {
        Self { native, emit, generation: 0, lease: None, ending: None, failed: None, recent: VecDeque::new() }
    }

    /// Whether this thread may still hold the lock: a lease, or an unlock not proven.
    fn holding(&self) -> bool {
        self.lease.is_some() || self.ending.is_some() || self.failed.is_some()
    }

    fn facts_of(&self, id: u32) -> Option<Facts> {
        [&self.lease, &self.ending, &self.failed]
            .into_iter()
            .flatten()
            .chain(self.recent.iter().map(|(_, held)| held))
            .find(|held| held.id == id)
            .map(|held| held.facts.clone())
    }

    fn acquire(&mut self, request: &Request) -> Answer {
        let mut facts = Facts::default();
        facts.set("lease", 0u32);
        facts.set("host_pid", std::process::id());
        facts.set("worker_pid", request.pid);
        let mut answer = "unavailable";
        let mut lease = 0;
        let mut deadline_at = 0.0;
        match clock(&self.native, None) {
            None => facts.set("reason", "the lease clock failed"),
            Some(received_at) => {
                facts.set("received_at", round(received_at));
                facts.set("answer_by", round(request.answer_by));
                if self.ending.is_some() || self.failed.is_some() {
                    answer = "quarantined";
                } else if self.lease.is_some() {
                    answer = "busy";
                } else if received_at >= request.answer_by {
                    // The worker stopped waiting: a lock taken now would protect nothing.
                    answer = "expired";
                } else {
                    let taken = self
                        .native
                        .foreground_process_id()
                        .map(|pid| facts.set("foreground_pid", pid))
                        .and_then(|()| self.native.lock());
                    match taken {
                        Err(reason) => facts.set("reason", reason),
                        Ok(call) if !call.ok => {
                            answer = "refused";
                            facts.set("error", call.error);
                        }
                        Ok(_) => {
                            self.generation += 1;
                            lease = self.generation;
                            facts.set("lease", lease);
                            (answer, deadline_at) = self.hold(request, lease, received_at, facts.clone());
                        }
                    }
                }
            }
        }
        // A taken lease keeps the facts of its own, which its end may have added to.
        let facts = match lease {
            0 => {
                facts.set("answer", answer);
                facts
            }
            id => self.facts_of(id).unwrap_or(facts),
        };
        Answer { holding: self.holding(), lease, answer, deadline_at, facts }
    }

    /// A lock was taken: the lease begins, and ends at once when it was taken
    /// too late for the worker or with no clock to bound it. Immutable from
    /// here: no later request extends it.
    fn hold(&mut self, request: &Request, id: u32, received_at: f64, facts: Facts) -> (&'static str, f64) {
        let mut held = Held {
            id,
            instance: request.instance,
            action: request.action,
            seq: request.seq,
            acquired_at: received_at,
            deadline_at: received_at,
            facts,
            timer: None,
            retry: None,
            reply_wanted: false,
            release: None,
            unlock_attempts: 0,
        };
        let acquired = clock(&self.native, Some(&mut held.facts));
        if let Some(acquired) = acquired {
            held.acquired_at = acquired;
        }
        held.deadline_at = held.acquired_at + MAX_HOLD_MS.min(f64::from(request.hold_ms));
        held.facts.set("acquired_at", round(held.acquired_at));
        held.facts.set("deadline_at", round(held.deadline_at));
        match acquired {
            Some(acquired) if acquired < request.answer_by => {
                held.facts.set("answer", "locked");
                let deadline_at = held.deadline_at;
                self.schedule(&mut held);
                self.lease = Some(held);
                ("locked", deadline_at)
            }
            _ => {
                held.facts.set("answer", "expired");
                self.end(held, "expired");
                ("expired", 0.0)
            }
        }
    }

    /// A timer may fire a little early or late; one that fires early waits out the rest.
    fn schedule(&self, held: &mut Held) {
        let delay = match clock(&self.native, Some(&mut held.facts)) {
            None => 0,
            Some(now) => (held.deadline_at - now).ceil().max(0.0) as u64,
        };
        held.timer = Some(Instant::now() + Duration::from_millis(delay));
    }

    fn deadline_due(&mut self) {
        let Some(mut held) = self.lease.take() else { return };
        held.timer = None;
        let now = clock(&self.native, Some(&mut held.facts));
        if now.is_some_and(|now| now < held.deadline_at) {
            self.schedule(&mut held);
            self.lease = Some(held);
            return;
        }
        held.facts.set_time("expired_at", now);
        self.end(held, "deadline");
    }

    fn end(&mut self, mut held: Held, by: &'static str) {
        held.timer = None;
        held.facts.set("released_by", by);
        let requested_at = clock(&self.native, Some(&mut held.facts));
        held.facts.set_time("unlock_requested_at", requested_at);
        held.facts.set("unlock_attempts", 0i64);
        self.ending = Some(held);
        self.attempt(0);
    }

    fn unlock_once(&self, held: &mut Held) -> Unlock {
        held.unlock_attempts += 1;
        held.facts.set("unlock_attempts", held.unlock_attempts);
        match self.native.unlock() {
            Ok(call) => {
                held.facts.push("unlock_errors", Fact::from(if call.ok { 0 } else { call.error }));
                if call.ok {
                    Unlock::Released
                } else {
                    Unlock::Unknown
                }
            }
            Err(error) => {
                held.facts.push("unlock_errors", Fact::from(error));
                Unlock::Failed
            }
        }
    }

    /// A false unlock says this process no longer holds the lock, which may be
    /// Windows having lifted it: that is no proof the lease ended here, so it is
    /// reported as unknown, never as released. A call that cannot be made is failed.
    fn attempt(&mut self, retries: usize) {
        let Some(mut held) = self.ending.take() else { return };
        held.retry = None;
        let outcome = self.unlock_once(&mut held);
        if outcome != Unlock::Released && retries < UNLOCK_RETRY_MS.len() {
            held.retry = Some(Retry {
                at: Instant::now() + Duration::from_millis(UNLOCK_RETRY_MS[retries]),
                retries: retries + 1,
            });
            self.ending = Some(held);
            return;
        }
        self.finish(held, outcome);
    }

    fn finish(&mut self, mut held: Held, outcome: Unlock) {
        let ended_at = clock(&self.native, Some(&mut held.facts));
        held.release = Some(outcome);
        held.facts.set("release", outcome.as_str());
        held.facts.set_time("ended_at", ended_at);
        if let Some(ended_at) = ended_at {
            held.facts.set("held_ms", round(ended_at - held.acquired_at));
            held.facts.set("late_ms", round(ended_at - held.deadline_at));
        }
        held.retry = None;
        // A new lease can only begin with a lock Windows grants while no lock is
        // held, so after an unknown end it may; after failed calls it waits for an
        // unlock call that answers at all.
        if outcome == Unlock::Failed {
            let mut again = held.clone();
            again.retry = Some(Retry {
                at: Instant::now() + Duration::from_millis(FAILED_RETRY_MS),
                retries: 0,
            });
            self.failed = Some(again);
        }
        self.remember(held.clone());
        let released = self.released(&held, outcome.as_str(), held.reply_wanted);
        (self.emit)(released);
    }

    fn remember(&mut self, held: Held) {
        let key = (held.instance, held.action, held.seq);
        self.recent.retain(|(known, _)| *known != key);
        self.recent.push_back((key, held));
        if self.recent.len() > RECENT_LEASES {
            self.recent.pop_front();
        }
    }

    fn released(&self, held: &Held, outcome: &'static str, reply: bool) -> Released {
        Released {
            holding: self.holding(),
            instance: held.instance,
            action: held.action,
            seq: held.seq,
            lease: held.id,
            outcome,
            reply,
            facts: Some(held.facts.clone()),
        }
    }

    fn retry_failed(&mut self) {
        let Some(mut held) = self.failed.take() else { return };
        held.retry = None;
        let outcome = self.unlock_once(&mut held);
        if outcome == Unlock::Failed {
            held.retry = Some(Retry {
                at: Instant::now() + Duration::from_millis(FAILED_RETRY_MS),
                retries: 0,
            });
            self.failed = Some(held);
            return;
        }
        let resolved_at = clock(&self.native, Some(&mut held.facts));
        held.facts.set("resolved", outcome.as_str());
        held.facts.set_time("resolved_at", resolved_at);
        // The ended lease the worker may still ask about carries the same account.
        if let Some((_, recent)) = self.recent.iter_mut().find(|(_, recent)| recent.id == held.id) {
            recent.facts = held.facts.clone();
        }
        let released = self.released(&held, held.release.map_or("none", Unlock::as_str), false);
        (self.emit)(released);
    }

    /// Only the request that took a lease ends it: the same worker, action and
    /// sequence, and the lease itself when the worker knows it. An older
    /// request's release gets its own lease's outcome and leaves a newer lease alone.
    fn release(&mut self, end: &End) {
        if self.lease.as_ref().is_some_and(|held| held.owned_by(end)) {
            if let Some(mut held) = self.lease.take() {
                held.reply_wanted = true;
                let requested_at = clock(&self.native, Some(&mut held.facts));
                held.facts.set_time("release_requested_at", requested_at);
                self.end(held, "worker");
            }
            return;
        }
        if let Some(held) = self.ending.as_mut().filter(|held| held.owned_by(end)) {
            held.reply_wanted = true;
            return;
        }
        let key = (end.instance, end.action, end.seq);
        let ended = self.recent.iter().find(|(known, held)| *known == key && held.owned_by(end));
        if let Some((_, held)) = ended {
            let released = self.released(held, held.release.map_or("none", Unlock::as_str), true);
            (self.emit)(released);
            return;
        }
        // Nothing this request took holds the lock: it was refused or never answered.
        (self.emit)(Released {
            holding: self.holding(),
            instance: end.instance,
            action: end.action,
            seq: end.seq,
            lease: end.lease,
            outcome: "none",
            reply: true,
            facts: None,
        });
    }

    fn gone(&mut self, instance: u32) {
        if self.lease.as_ref().is_some_and(|held| held.instance == instance) {
            if let Some(held) = self.lease.take() {
                self.end(held, "worker_gone");
            }
        }
        self.recent.retain(|(_, held)| held.instance != instance);
    }

    /// The app is going away: one bounded round of unlock calls, then the true
    /// end state, which the caller unlocks itself unless this says released or none.
    fn dispose(&mut self) -> &'static str {
        let held = self.lease.take().or(self.ending.take()).or(self.failed.take());
        let Some(mut held) = held else { return "none" };
        let mut outcome = Unlock::Failed;
        for _ in 0..=UNLOCK_RETRY_MS.len() {
            outcome = self.unlock_once(&mut held);
            if outcome == Unlock::Released {
                break;
            }
        }
        outcome.as_str()
    }

    /// The earliest timer of a lease: its deadline, or the retry of an unlock.
    fn next_timer(&self) -> Option<Instant> {
        let deadline = self.lease.as_ref().and_then(|held| held.timer);
        let retry = |held: &Option<Held>| held.as_ref().and_then(|held| held.retry).map(|retry| retry.at);
        [deadline, retry(&self.ending), retry(&self.failed)].into_iter().flatten().min()
    }

    fn timers_due(&mut self) {
        let now = Instant::now();
        if self.lease.as_ref().and_then(|held| held.timer).is_some_and(|at| at <= now) {
            self.deadline_due();
        }
        if let Some(retry) = self.ending.as_ref().and_then(|held| held.retry).filter(|retry| retry.at <= now) {
            self.attempt(retry.retries);
        }
        if self.failed.as_ref().and_then(|held| held.retry).is_some_and(|retry| retry.at <= now) {
            self.retry_failed();
        }
    }
}

// ---------------------------------------------------------------------------
// The thread.

enum Command {
    Acquire(Request, Sender<Answer>),
    Release(End),
    Gone(u32),
    Dispose(Sender<&'static str>),
}

/// The lease owner's thread. Dropping the handle without `dispose` ends the
/// thread too, after one round of unlock calls.
pub struct LeaseThread {
    commands: Sender<Command>,
}

fn run<N: Native>(mut owner: Owner<N>, commands: mpsc::Receiver<Command>) {
    loop {
        let received = match owner.next_timer() {
            Some(at) => commands.recv_timeout(at.saturating_duration_since(Instant::now())),
            None => commands.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        match received {
            Ok(Command::Acquire(request, reply)) => {
                let _ = reply.send(owner.acquire(&request));
            }
            Ok(Command::Release(end)) => owner.release(&end),
            Ok(Command::Gone(instance)) => owner.gone(instance),
            Ok(Command::Dispose(reply)) => {
                let _ = reply.send(owner.dispose());
                return;
            }
            Err(RecvTimeoutError::Timeout) => owner.timers_due(),
            Err(RecvTimeoutError::Disconnected) => {
                owner.dispose();
                return;
            }
        }
    }
}

const THREAD_ENDED: &str = "the lease thread ended";

impl LeaseThread {
    /// Starts the lease owner; `emit` is called on its thread with each lease
    /// end that was not answered to a request.
    pub fn start<N: Native>(native: N, emit: impl Fn(Released) + Send + 'static) -> std::io::Result<Self> {
        let (commands, receiver) = mpsc::channel();
        let owner = Owner::new(native, Box::new(emit));
        std::thread::Builder::new().name("mixdog-fglease".to_owned()).spawn(move || run(owner, receiver))?;
        Ok(Self { commands })
    }

    /// Takes a lease for the request, or says why not.
    pub fn request(&self, request: Request) -> std::result::Result<Answer, String> {
        let (reply, answer) = mpsc::channel();
        self.commands.send(Command::Acquire(request, reply)).map_err(|_| THREAD_ENDED.to_owned())?;
        answer.recv().map_err(|_| THREAD_ENDED.to_owned())
    }

    pub fn end(&self, end: End) -> std::result::Result<(), String> {
        self.commands.send(Command::Release(end)).map_err(|_| THREAD_ENDED.to_owned())
    }

    /// The worker `instance` is gone: a lease it holds ends now.
    pub fn gone(&self, instance: u32) -> std::result::Result<(), String> {
        self.commands.send(Command::Gone(instance)).map_err(|_| THREAD_ENDED.to_owned())
    }

    /// Ends any lease with one bounded round of unlock calls and stops the
    /// thread: released, unknown or failed, or none when nothing was held.
    pub fn dispose(self) -> &'static str {
        let (reply, outcome) = mpsc::channel();
        match self.commands.send(Command::Dispose(reply)) {
            Ok(()) => outcome.recv().unwrap_or("failed"),
            // The thread already ended and unlocked on its way out.
            Err(_) => "none",
        }
    }
}

// ---------------------------------------------------------------------------
// The Node-API surface.

static THREAD: Mutex<Option<LeaseThread>> = Mutex::new(None);

fn thread() -> std::sync::MutexGuard<'static, Option<LeaseThread>> {
    THREAD.lock().unwrap_or_else(PoisonError::into_inner)
}

fn failure(reason: String) -> Error {
    Error::from_reason(reason)
}

#[napi(object)]
pub struct LeaseRequest {
    pub instance: u32,
    pub pid: u32,
    pub action: u32,
    pub seq: u32,
    pub hold_ms: u32,
    pub answer_by: f64,
}

#[napi(object)]
pub struct LeaseAnswer {
    pub holding: bool,
    pub lease: u32,
    /// unavailable, busy, expired, refused, locked or quarantined.
    pub answer: String,
    pub deadline_at: f64,
    /// The thread's facts for the lease, as JSON.
    pub facts: String,
}

#[napi(object)]
pub struct LeaseEnd {
    pub instance: u32,
    pub action: u32,
    pub seq: u32,
    pub lease: u32,
}

#[napi(object)]
pub struct LeaseUnlock {
    /// released or unknown.
    pub outcome: String,
    pub error: Option<u32>,
}

/// Starts the lease thread. `on_event` is called on the JavaScript thread with
/// the JSON of each lease end the thread reports (outcome released, unknown or
/// failed, or none; `reply` true when a worker asked for it). It never keeps
/// the event loop alive. Fails when a lease thread is already running.
#[napi]
pub fn lease_start(on_event: Function<'_, String, ()>) -> Result<()> {
    let mut running = thread();
    if running.is_some() {
        return Err(failure("the lease thread is already running".to_owned()));
    }
    let on_event = on_event.build_threadsafe_function::<String>().callee_handled::<false>().weak::<true>().build()?;
    let native = Win32::new().map_err(failure)?;
    let lease = LeaseThread::start(native, move |released| {
        // A loop that is gone cannot receive it; nothing this thread holds changes.
        on_event.call(released.to_json(), ThreadsafeFunctionCallMode::NonBlocking);
    })
    .map_err(|error| failure(format!("the lease thread could not start: {error}")))?;
    *running = Some(lease);
    Ok(())
}

/// Asks the lease thread for a lease and waits for its answer: the thread
/// takes the lock and holds it to its own deadline, whatever this thread does.
#[napi]
pub fn lease_request(request: LeaseRequest) -> Result<LeaseAnswer> {
    let running = thread();
    let lease = running.as_ref().ok_or_else(|| failure(THREAD_ENDED.to_owned()))?;
    let answer = lease
        .request(Request {
            instance: request.instance,
            pid: request.pid,
            action: request.action,
            seq: request.seq,
            hold_ms: request.hold_ms,
            answer_by: request.answer_by,
        })
        .map_err(failure)?;
    Ok(LeaseAnswer {
        holding: answer.holding,
        lease: answer.lease,
        answer: answer.answer.to_owned(),
        deadline_at: answer.deadline_at,
        facts: answer.facts.to_json(),
    })
}

/// A worker's release of the lease its request took; the thread reports the
/// end through `on_event` (with `reply` true).
#[napi]
pub fn lease_end(end: LeaseEnd) -> Result<()> {
    let running = thread();
    let lease = running.as_ref().ok_or_else(|| failure(THREAD_ENDED.to_owned()))?;
    lease
        .end(End { instance: end.instance, action: end.action, seq: end.seq, lease: end.lease })
        .map_err(failure)
}

/// The worker `instance` exited or was retired: a lease it holds ends now.
#[napi]
pub fn lease_gone(instance: u32) -> Result<()> {
    let running = thread();
    let lease = running.as_ref().ok_or_else(|| failure(THREAD_ENDED.to_owned()))?;
    lease.gone(instance).map_err(failure)
}

/// Ends any lease and stops the thread: released, unknown or failed, or none
/// when nothing was held or no thread was running. A later `lease_start`
/// starts a new one.
#[napi]
pub fn lease_dispose() -> String {
    match thread().take() {
        Some(lease) => lease.dispose().to_owned(),
        None => "none".to_owned(),
    }
}

/// One LockSetForegroundWindow(LSFW_UNLOCK) from the calling thread, for a
/// lease thread that ended and may have left the lock held: the lock belongs
/// to the process, so any of its threads may end it. False is unknown, as on
/// the lease thread.
#[napi]
pub fn lease_unlock() -> LeaseUnlock {
    let call = lock_set_foreground(LSFW_UNLOCK);
    if call.ok {
        LeaseUnlock { outcome: "released".to_owned(), error: None }
    } else {
        LeaseUnlock { outcome: "unknown".to_owned(), error: Some(call.error) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering::SeqCst};
    use std::sync::Arc;
    use std::thread::sleep;

    const UNLOCK_TRUE: u32 = 0;
    const UNLOCK_FALSE: u32 = 1;
    const UNLOCK_FAILS: u32 = 2;

    /// What the test tells the stand-in, and what the thread did with it.
    #[derive(Default)]
    struct Shared {
        locks: AtomicU32,
        unlocks: AtomicU32,
        unlock_calls: AtomicU32,
        lock_refused: AtomicU32,
        /// How long a lock call takes.
        lock_sleep_ms: AtomicU32,
        unlock_mode: AtomicU32,
        clock_fails: AtomicU32,
        lock_at: Mutex<f64>,
        unlock_at: Mutex<f64>,
    }

    struct Fake {
        shared: Arc<Shared>,
        start: Instant,
    }

    impl Fake {
        fn now_ms(&self) -> f64 {
            self.start.elapsed().as_secs_f64() * 1000.0
        }
    }

    impl Native for Fake {
        fn now(&self) -> std::result::Result<f64, String> {
            if self.shared.clock_fails.load(SeqCst) == 1 {
                return Err("QueryPerformanceCounter failed".to_owned());
            }
            Ok(self.now_ms())
        }
        fn foreground_process_id(&self) -> std::result::Result<u32, String> {
            Ok(4242)
        }
        fn lock(&self) -> std::result::Result<Call, String> {
            if self.shared.lock_refused.load(SeqCst) == 1 {
                return Ok(Call { ok: false, error: 5 });
            }
            sleep(Duration::from_millis(u64::from(self.shared.lock_sleep_ms.load(SeqCst))));
            *self.shared.lock_at.lock().unwrap() = self.now_ms();
            self.shared.locks.fetch_add(1, SeqCst);
            Ok(Call { ok: true, error: 0 })
        }
        fn unlock(&self) -> std::result::Result<Call, String> {
            self.shared.unlock_calls.fetch_add(1, SeqCst);
            match self.shared.unlock_mode.load(SeqCst) {
                UNLOCK_FAILS => Err("LockSetForegroundWindow failed".to_owned()),
                UNLOCK_FALSE => Ok(Call { ok: false, error: 5 }),
                _ => {
                    *self.shared.unlock_at.lock().unwrap() = self.now_ms();
                    self.shared.unlocks.fetch_add(1, SeqCst);
                    Ok(Call { ok: true, error: 0 })
                }
            }
        }
    }

    struct Rig {
        thread: LeaseThread,
        shared: Arc<Shared>,
        events: mpsc::Receiver<Released>,
        started: Instant,
    }

    fn rig() -> Rig {
        let shared = Arc::new(Shared::default());
        let (events_out, events) = mpsc::channel();
        let started = Instant::now();
        let fake = Fake { shared: shared.clone(), start: started };
        let thread = LeaseThread::start(fake, move |released| {
            let _ = events_out.send(released);
        })
        .unwrap();
        Rig { thread, shared, events, started }
    }

    impl Rig {
        fn now(&self) -> f64 {
            self.started.elapsed().as_secs_f64() * 1000.0
        }

        fn acquire(&self, instance: u32, action: u32, seq: u32, hold_ms: u32) -> Answer {
            self.acquire_by(instance, action, seq, hold_ms, self.now() + 250.0)
        }

        fn acquire_by(&self, instance: u32, action: u32, seq: u32, hold_ms: u32, answer_by: f64) -> Answer {
            self.thread.request(Request { instance, pid: 321, action, seq, hold_ms, answer_by }).unwrap()
        }

        fn release(&self, instance: u32, action: u32, seq: u32, lease: u32) {
            self.thread.end(End { instance, action, seq, lease }).unwrap();
        }

        fn event(&self) -> Released {
            self.events.recv_timeout(Duration::from_secs(5)).expect("no event")
        }
    }

    fn text(facts: &Facts, key: &str) -> String {
        match facts.get(key) {
            Some(Fact::Text(text)) => text.clone(),
            other => panic!("fact {key}: {other:?}"),
        }
    }

    fn number(facts: &Facts, key: &str) -> f64 {
        match facts.get(key) {
            Some(Fact::Num(value)) => *value,
            Some(Fact::Int(value)) => *value as f64,
            other => panic!("fact {key}: {other:?}"),
        }
    }

    #[test]
    fn a_lease_ends_at_its_deadline_on_the_lease_thread() {
        let rig = rig();
        let answer = rig.acquire(1, 7, 1, 250);
        assert_eq!(answer.answer, "locked");
        assert!(answer.holding);
        assert_eq!(rig.shared.unlocks.load(SeqCst), 0);
        // Nothing but the thread's own timer ends it.
        let ended = rig.event();
        assert_eq!((ended.outcome, ended.reply, ended.lease), ("released", false, answer.lease));
        assert!(!ended.holding);
        let hold = answer.deadline_at - *rig.shared.lock_at.lock().unwrap();
        assert!((249.99..251.0).contains(&hold), "deadline {hold} ms after the lock");
        let late = *rig.shared.unlock_at.lock().unwrap() - answer.deadline_at;
        assert!((-0.01..50.0).contains(&late), "unlocked {late} ms after the deadline");
        let facts = ended.facts.unwrap();
        assert_eq!(text(&facts, "release"), "released");
        assert_eq!(text(&facts, "released_by"), "deadline");
        assert_eq!(number(&facts, "foreground_pid"), 4242.0);
        assert_eq!(number(&facts, "worker_pid"), 321.0);
        let held = number(&facts, "held_ms");
        assert!((250.0..300.0).contains(&held), "held {held}");
        assert!(facts.get("expired_at").is_some());
    }

    #[test]
    fn a_lease_holds_at_most_a_second_whatever_was_asked() {
        let rig = rig();
        let answer = rig.acquire(1, 7, 1, 60_000);
        assert_eq!(answer.answer, "locked");
        let held = answer.deadline_at - *rig.shared.lock_at.lock().unwrap();
        assert!((999.9..1001.0).contains(&held), "{held}");
        rig.release(1, 7, 1, answer.lease);
        assert_eq!(rig.event().outcome, "released");
    }

    #[test]
    fn a_release_names_its_own_lease_and_a_stale_one_leaves_a_newer_lease_alone() {
        let rig = rig();
        let first = rig.acquire(1, 7, 1, 100).lease;
        rig.release(1, 7, 1, first);
        let ended = rig.event();
        assert_eq!((ended.lease, ended.outcome, ended.reply), (first, "released", true));
        assert_eq!(text(&ended.facts.unwrap(), "released_by"), "worker");
        let second = rig.acquire(1, 7, 2, 1_000);
        assert_eq!(second.answer, "locked");
        // The first lease's release once more, and the newer request naming the old lease.
        rig.release(1, 7, 1, first);
        let again = rig.event();
        assert_eq!((again.lease, again.outcome, again.reply), (first, "released", true));
        rig.release(1, 7, 2, first);
        let stale = rig.event();
        assert_eq!((stale.lease, stale.outcome, stale.reply), (first, "none", true));
        assert!(stale.facts.is_none());
        assert_eq!(rig.shared.unlocks.load(SeqCst), 1, "the newer lease still holds the lock");
        assert!(stale.holding);
        // Another worker's or action's release does not end it either, and lease 0 names none.
        rig.release(2, 7, 2, 0);
        assert_eq!(rig.event().outcome, "none");
        rig.release(1, 8, 2, 0);
        assert_eq!(rig.event().outcome, "none");
        rig.release(1, 7, 2, 0);
        let ended = rig.event();
        assert_eq!((ended.lease, ended.outcome), (second.lease, "released"));
        assert_eq!(rig.shared.unlocks.load(SeqCst), 2);
    }

    #[test]
    fn a_release_that_arrives_while_the_unlock_is_retried_is_answered_with_its_outcome() {
        let rig = rig();
        rig.shared.unlock_mode.store(UNLOCK_FALSE, SeqCst);
        let lease = rig.acquire(1, 7, 1, 1_000).lease;
        rig.release(1, 7, 1, lease);
        // The first unlock is not proven: the end is still being retried.
        rig.release(1, 7, 1, lease);
        let ended = rig.event();
        assert_eq!((ended.lease, ended.outcome, ended.reply), (lease, "unknown", true));
        assert_eq!(rig.shared.unlock_calls.load(SeqCst), 4);
    }

    #[test]
    fn a_request_whose_worker_stopped_waiting_is_refused_before_any_lock_is_taken() {
        let rig = rig();
        let answer = rig.acquire_by(1, 7, 1, 100, rig.now() - 1.0);
        assert_eq!((answer.answer, answer.lease), ("expired", 0));
        assert_eq!(rig.shared.locks.load(SeqCst), 0);
        assert_eq!(text(&answer.facts, "answer"), "expired");
        assert!(!answer.holding);
    }

    #[test]
    fn a_lock_taken_too_late_for_the_worker_is_ended_at_once_and_answered_expired() {
        let rig = rig();
        // The lock call outlasts the worker's wait.
        rig.shared.lock_sleep_ms.store(60, SeqCst);
        let answer = rig.acquire_by(1, 7, 1, 100, rig.now() + 20.0);
        assert_eq!((answer.answer, answer.lease, answer.deadline_at), ("expired", 1, 0.0));
        assert_eq!(text(&answer.facts, "answer"), "expired");
        assert_eq!(text(&answer.facts, "released_by"), "expired");
        assert_eq!(rig.shared.locks.load(SeqCst), 1);
        assert_eq!(rig.shared.unlocks.load(SeqCst), 1);
        assert!(!answer.holding);
        assert_eq!(rig.event().outcome, "released");
    }

    #[test]
    fn a_lock_windows_refuses_is_refused_with_its_error() {
        let rig = rig();
        rig.shared.lock_refused.store(1, SeqCst);
        let answer = rig.acquire(1, 7, 1, 100);
        assert_eq!((answer.answer, answer.lease), ("refused", 0));
        assert_eq!(number(&answer.facts, "error"), 5.0);
        assert!(!answer.holding);
        // The request that was refused took nothing: its release says so.
        rig.release(1, 7, 1, 0);
        assert_eq!(rig.event().outcome, "none");
    }

    #[test]
    fn a_second_request_is_busy_while_a_lease_holds_the_lock() {
        let rig = rig();
        let first = rig.acquire(1, 7, 1, 1_000);
        assert_eq!(first.answer, "locked");
        let second = rig.acquire(2, 8, 1, 1_000);
        assert_eq!((second.answer, second.lease), ("busy", 0));
        assert_eq!(rig.shared.locks.load(SeqCst), 1);
        rig.release(1, 7, 1, first.lease);
        assert_eq!(rig.event().outcome, "released");
    }

    #[test]
    fn a_clock_that_fails_before_any_lock_is_unavailable_with_its_reason() {
        let rig = rig();
        rig.shared.clock_fails.store(1, SeqCst);
        let answer = rig.acquire(1, 7, 1, 100);
        assert_eq!((answer.answer, answer.lease), ("unavailable", 0));
        assert_eq!(text(&answer.facts, "reason"), "the lease clock failed");
        assert_eq!(rig.shared.locks.load(SeqCst), 0);
    }

    #[test]
    fn an_unlock_that_is_not_proven_is_retried_never_reported_released_and_holds_off_new_leases() {
        let rig = rig();
        // A false unlock: Windows may have lifted the lock already, so it is unknown.
        rig.shared.unlock_mode.store(UNLOCK_FALSE, SeqCst);
        let unknown = rig.acquire(1, 7, 1, 1_000).lease;
        rig.release(1, 7, 1, unknown);
        // Asked while the unlock is still being retried.
        let held_off = rig.acquire(2, 8, 1, 1_000);
        assert_eq!((held_off.answer, held_off.lease), ("quarantined", 0));
        assert!(held_off.holding);
        let ended = rig.event();
        assert_eq!((ended.lease, ended.outcome, ended.reply), (unknown, "unknown", true));
        assert_eq!(rig.shared.unlock_calls.load(SeqCst), 4, "the unlock was tried again");
        let facts = ended.facts.unwrap();
        assert_eq!((text(&facts, "release"), number(&facts, "unlock_attempts")), ("unknown".to_owned(), 4.0));
        assert_eq!(
            facts.get("unlock_errors"),
            Some(&Fact::List(vec![Fact::Int(5), Fact::Int(5), Fact::Int(5), Fact::Int(5)]))
        );
        // Once those retries settle, a lock Windows grants may begin a new lease.
        rig.shared.unlock_mode.store(UNLOCK_TRUE, SeqCst);
        let next = rig.acquire(2, 8, 2, 1_000);
        assert_eq!(next.answer, "locked");
        rig.release(2, 8, 2, next.lease);
        assert_eq!(rig.event().outcome, "released");
    }

    #[test]
    fn unlock_calls_that_fail_outright_are_failed_and_no_lease_starts_until_one_answers() {
        let rig = rig();
        rig.shared.unlock_mode.store(UNLOCK_FAILS, SeqCst);
        let failing = rig.acquire(1, 7, 3, 1_000).lease;
        rig.release(1, 7, 3, failing);
        let ended = rig.event();
        assert_eq!((ended.lease, ended.outcome, ended.reply), (failing, "failed", true));
        assert!(ended.holding);
        assert_eq!(
            ended.facts.unwrap().get("unlock_errors").cloned(),
            Some(Fact::List(vec![Fact::from("LockSetForegroundWindow failed"); 4]))
        );
        let held_off = rig.acquire(2, 8, 4, 1_000);
        assert_eq!(held_off.answer, "quarantined");
        rig.shared.unlock_mode.store(UNLOCK_TRUE, SeqCst);
        // The retry a second after the failure answers: the lease is then resolved.
        let resolved = rig.event();
        assert_eq!((resolved.lease, resolved.outcome, resolved.reply), (failing, "failed", false));
        assert!(!resolved.holding);
        assert_eq!(text(&resolved.facts.unwrap(), "resolved"), "released");
        // A release asked after that gets the end's own account.
        rig.release(1, 7, 3, failing);
        assert_eq!(rig.event().outcome, "failed");
        let next = rig.acquire(2, 8, 5, 1_000);
        assert_eq!(next.answer, "locked");
        assert!(rig.events.try_recv().is_err(), "no other event");
    }

    #[test]
    fn a_clock_that_fails_at_the_deadline_still_ends_the_lease_and_the_thread_lives_on() {
        let rig = rig();
        assert_eq!(rig.acquire(1, 7, 1, 100).answer, "locked");
        // From here every clock read fails, and the unlock is unproven.
        rig.shared.clock_fails.store(1, SeqCst);
        rig.shared.unlock_mode.store(UNLOCK_FALSE, SeqCst);
        let ended = rig.event();
        assert_eq!(ended.outcome, "unknown");
        let facts = ended.facts.unwrap();
        assert_eq!(
            (text(&facts, "released_by"), number(&facts, "unlock_attempts")),
            ("deadline".to_owned(), 4.0)
        );
        assert!(text(&facts, "clock_error").contains("QueryPerformanceCounter failed"));
        // With the clock back the thread answers the next request.
        rig.shared.clock_fails.store(0, SeqCst);
        rig.shared.unlock_mode.store(UNLOCK_TRUE, SeqCst);
        assert_eq!(rig.acquire(2, 8, 1, 100).answer, "locked");
    }

    #[test]
    fn a_worker_that_is_gone_ends_its_lease_and_is_forgotten() {
        let rig = rig();
        let lease = rig.acquire(1, 7, 1, 1_000).lease;
        let other = rig.acquire(2, 7, 1, 1_000);
        assert_eq!(other.answer, "busy");
        // A gone worker that holds nothing changes nothing.
        rig.thread.gone(2).unwrap();
        rig.thread.gone(1).unwrap();
        let ended = rig.event();
        assert_eq!((ended.lease, ended.outcome, ended.reply), (lease, "released", false));
        assert_eq!(text(&ended.facts.unwrap(), "released_by"), "worker_gone");
        // Its ended lease is forgotten: a late release names nothing.
        rig.release(1, 7, 1, lease);
        assert_eq!(rig.event().outcome, "none");
    }

    #[test]
    fn only_the_latest_ended_leases_are_remembered() {
        let rig = rig();
        for seq in 1..=(RECENT_LEASES as u32 + 1) {
            let lease = rig.acquire(1, 7, seq, 1_000).lease;
            rig.release(1, 7, seq, lease);
            assert_eq!(rig.event().outcome, "released");
        }
        rig.release(1, 7, 1, 0);
        assert_eq!(rig.event().outcome, "none");
        rig.release(1, 7, 2, 0);
        assert_eq!(rig.event().outcome, "released");
    }

    #[test]
    fn dispose_reports_how_the_thread_ended_the_lock() {
        let none = rig();
        assert_eq!(none.thread.dispose(), "none");

        let failing = rig();
        assert_eq!(failing.acquire(1, 7, 1, 1_000).answer, "locked");
        failing.shared.unlock_mode.store(UNLOCK_FAILS, SeqCst);
        let shared = failing.shared.clone();
        assert_eq!(failing.thread.dispose(), "failed");
        assert_eq!(shared.unlock_calls.load(SeqCst), 4);

        let unproven = rig();
        unproven.shared.unlock_mode.store(UNLOCK_FALSE, SeqCst);
        assert_eq!(unproven.acquire(1, 7, 1, 1_000).answer, "locked");
        assert_eq!(unproven.thread.dispose(), "unknown");

        let clean = rig();
        assert_eq!(clean.acquire(1, 7, 1, 1_000).answer, "locked");
        let shared = clean.shared.clone();
        assert_eq!(clean.thread.dispose(), "released");
        assert_eq!(shared.unlocks.load(SeqCst), 1);
    }

    #[test]
    fn a_thread_whose_handle_is_dropped_unlocks_on_its_way_out() {
        let rig = rig();
        assert_eq!(rig.acquire(1, 7, 1, 1_000).answer, "locked");
        let Rig { thread, shared, .. } = rig;
        drop(thread);
        let until = Instant::now() + Duration::from_secs(5);
        while shared.unlocks.load(SeqCst) == 0 && Instant::now() < until {
            sleep(Duration::from_millis(5));
        }
        assert_eq!(shared.unlocks.load(SeqCst), 1);
    }

    #[test]
    fn facts_are_json_with_their_text_escaped() {
        let mut facts = Facts::default();
        facts.set("answer", "locked");
        facts.set("lease", 3u32);
        facts.set("held_ms", 250.5);
        facts.set("reason", "a \"quoted\"\nreason\\");
        facts.push("unlock_errors", Fact::Int(0));
        facts.push("unlock_errors", Fact::from("failed"));
        facts.set_time("expired_at", None);
        assert_eq!(
            facts.to_json(),
            "{\"answer\":\"locked\",\"lease\":3,\"held_ms\":250.5,\"reason\":\"a \\\"quoted\\\"\\nreason\\\\\",\"unlock_errors\":[0,\"failed\"]}"
        );
        let released = Released {
            holding: false,
            instance: 1,
            action: 7,
            seq: 2,
            lease: 0,
            outcome: "none",
            reply: true,
            facts: None,
        };
        assert_eq!(
            released.to_json(),
            "{\"holding\":false,\"instance\":1,\"action\":7,\"seq\":2,\"lease\":0,\"outcome\":\"none\",\"reply\":true,\"facts\":null}"
        );
    }
}
