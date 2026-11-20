//! Command activity of one tab, read from the private OSC markers Mixdog's shell integration
//! prints:
//!   ESC ] 697 ; P BEL        a prompt is showing
//!   ESC ] 697 ; C BEL        the line just entered starts running
//!   ESC ] 697 ; D ; <n> BEL  the command finished with exit code n
//! (ST = ESC \ is accepted in place of BEL.) The scanner removes every complete marker from the
//! stream before it is buffered or shown, so a replay trimmed mid-sequence can never expose
//! marker text. It works on bytes, on the reader thread.

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::time::Duration;

use mixdog_rt::TimerHandle;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Marker {
    Prompt,
    Start,
    Done { exit_code: Option<i64> },
}

const PREFIX: &[u8] = b"\x1b]697;";
/// Longest marker body worth waiting for across chunks ("D;-2147483648").
const MAX_BODY: usize = 24;

fn parse(body: &[u8]) -> Option<Marker> {
    match body {
        b"P" => Some(Marker::Prompt),
        b"C" => Some(Marker::Start),
        b"D" => Some(Marker::Done { exit_code: None }),
        _ => {
            let digits = body.strip_prefix(b"D;")?;
            let negative = digits.first() == Some(&b'-');
            let digits = if negative { &digits[1..] } else { digits };
            if digits.is_empty() || digits.len() > 10 || !digits.iter().all(u8::is_ascii_digit) {
                return None;
            }
            let value: i64 = std::str::from_utf8(digits).ok()?.parse().ok()?;
            Some(Marker::Done { exit_code: Some(if negative { -value } else { value }) })
        }
    }
}

fn find<T: PartialEq>(haystack: &[T], needle: &[T], from: usize) -> Option<usize> {
    haystack.get(from..)?.windows(needle.len()).position(|w| w == needle).map(|at| at + from)
}

/// Streaming marker reader and stripper over decoded text. Positions and the 24-character
/// marker bound count UTF-16 units, as the Node twin counts string indices. A chunk ending where
/// a marker may begin holds that tail back until the next chunk (or [`flush`](Self::flush))
/// decides it; every complete marker is removed from the returned text. The tail is released on
/// the next chunk, at the end of the stream, or by the tab's 50 ms flush ([`crate::terminal::HELD_FLUSH`]).
#[derive(Default)]
pub struct MarkerScanner {
    carry: Vec<u16>,
}

impl MarkerScanner {
    /// Release held-back text as output.
    pub fn flush(&mut self) -> String {
        String::from_utf16_lossy(&std::mem::take(&mut self.carry))
    }

    /// Text is held back, waiting for the chunk that decides whether it starts a marker.
    pub fn is_holding(&self) -> bool {
        !self.carry.is_empty()
    }

    pub fn scan(&mut self, data: &str) -> (String, Vec<Marker>) {
        let mut input = std::mem::take(&mut self.carry);
        input.extend(data.encode_utf16());
        let prefix: Vec<u16> = PREFIX.iter().map(|b| u16::from(*b)).collect();
        let mut markers = Vec::new();
        let mut out: Vec<u16> = Vec::with_capacity(input.len());
        let mut from = 0usize;
        let mut search = 0usize;
        while let Some(start) = find(&input, &prefix, search) {
            let body = start + prefix.len();
            let window = &input[body..(body + MAX_BODY + 2).min(input.len())];
            let bel = window.iter().position(|u| *u == 0x07);
            let st = find(window, &[0x1b, u16::from(b'\\')], 0);
            let end = match (bel, st) {
                (Some(b), Some(s)) => Some(b.min(s)),
                (b, s) => b.or(s),
            };
            match end {
                None if input.len() - body <= MAX_BODY => {
                    // Unterminated so far: hold it for the rest.
                    out.extend_from_slice(&input[from..start]);
                    self.carry = input[start..].to_vec();
                    return (String::from_utf16_lossy(&out), markers);
                }
                None => search = body,
                Some(end) if end > MAX_BODY => search = body,
                Some(end) => {
                    let ascii: Option<Vec<u8>> = window[..end].iter().map(|u| u8::try_from(*u).ok().filter(u8::is_ascii)).collect();
                    if let Some(marker) = ascii.and_then(|b| parse(&b)) {
                        markers.push(marker);
                    }
                    out.extend_from_slice(&input[from..start]);
                    let terminator = if Some(end) == bel { 1 } else { 2 };
                    from = body + end + terminator;
                    search = from;
                }
            }
        }
        // A chunk ending inside the prefix itself ("…\x1b]69").
        let held = (1..=(prefix.len() - 1).min(input.len() - from)).rev().find(|length| input.ends_with(&prefix[..*length])).unwrap_or(0);
        out.extend_from_slice(&input[from..input.len() - held]);
        self.carry = input[input.len() - held..].to_vec();
        (String::from_utf16_lossy(&out), markers)
    }
}

#[derive(Default)]
pub struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        let mut input = std::mem::take(&mut self.pending);
        input.extend_from_slice(bytes);
        let mut text = String::new();
        let mut rest = input.as_slice();
        loop {
            match std::str::from_utf8(rest) {
                Ok(valid) => {
                    text.push_str(valid);
                    return text;
                }
                Err(error) => {
                    let (valid, after) = rest.split_at(error.valid_up_to());
                    text.push_str(&String::from_utf8_lossy(valid));
                    match error.error_len() {
                        None => {
                            self.pending = after.to_vec();
                            return text;
                        }
                        Some(length) => {
                            text.push('\u{FFFD}');
                            rest = &after[length..];
                        }
                    }
                }
            }
        }
    }

    /// The end of the stream: a character left incomplete is lost.
    pub fn finish(&mut self) -> String {
        if std::mem::take(&mut self.pending).is_empty() { String::new() } else { "\u{FFFD}".to_owned() }
    }
}

/// `finished`: a command completed while no view had the tab focused; the next focus clears it
/// back to `idle`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ActivityState {
    Idle,
    Running,
    Finished,
}

impl ActivityState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Running => "running",
            Self::Finished => "finished",
        }
    }
}

/// How long a view's focus holds without being renewed (`TERMINAL_FOCUS_LEASE_MS`): the renderer renews it every 10 s while it
/// shows the tab, so a window that vanished without closing its connection cannot keep the tab focused.
pub const FOCUS_LEASE: Duration = Duration::from_secs(30);

/// The lease of one view's focus: which arming is current, and its timer.
struct FocusLease {
    epoch: u64,
    timer: Option<TimerHandle>,
}

impl FocusLease {
    fn cancel(self) {
        if let Some(timer) = self.timer {
            let _ = timer.cancel();
        }
    }
}

/// One tab's activity state. Starts unknown (`None`); only markers move it, so a shell without
/// integration never leaves unknown. A view's focus lasts until it unfocuses, its connection
/// closes, or its lease ([`FOCUS_LEASE`]) lapses unrenewed.
pub struct ActivityTracker {
    current: Option<ActivityState>,
    focus: BTreeSet<String>,
    leases: BTreeMap<String, FocusLease>,
    last_epoch: u64,
    infer_start_from_submit: bool,
}

impl ActivityTracker {
    /// `infer_start_from_submit`: the integration reports prompts only (cmd), so a line
    /// submitted at a prompt is what starts a command.
    pub fn new(infer_start_from_submit: bool) -> Self {
        Self { current: None, focus: BTreeSet::new(), leases: BTreeMap::new(), last_epoch: 0, infer_start_from_submit }
    }

    pub fn state(&self) -> Option<ActivityState> {
        self.current
    }

    fn set(&mut self, state: Option<ActivityState>) -> Option<Option<ActivityState>> {
        if self.current == state {
            return None;
        }
        self.current = state;
        Some(state)
    }

    /// Each method returns the new state when it changed.
    pub fn marker(&mut self, marker: Marker) -> Option<Option<ActivityState>> {
        if marker == Marker::Start {
            return self.set(Some(ActivityState::Running));
        }
        if self.current == Some(ActivityState::Running) {
            let next = if self.focus.is_empty() { ActivityState::Finished } else { ActivityState::Idle };
            return self.set(Some(next));
        }
        if marker == Marker::Prompt && self.current.is_none() {
            return self.set(Some(ActivityState::Idle));
        }
        None
    }

    /// Input written to the PTY (keystrokes, pastes, agent commands).
    pub fn input(&mut self, data: &str) -> Option<Option<ActivityState>> {
        let settled = matches!(self.current, Some(ActivityState::Idle | ActivityState::Finished));
        if !self.infer_start_from_submit || !settled || !data.contains('\r') {
            return None;
        }
        self.set(Some(ActivityState::Running))
    }

    /// `client` names one view (a connection). Focusing clears `finished`.
    pub fn set_focus(&mut self, client: &str, focused: bool) -> Option<Option<ActivityState>> {
        if !focused {
            self.focus.remove(client);
            if let Some(lease) = self.leases.remove(client) {
                lease.cancel();
            }
            return None;
        }
        self.focus.insert(client.to_owned());
        if self.current == Some(ActivityState::Finished) {
            return self.set(Some(ActivityState::Idle));
        }
        None
    }

    /// Starts (or renews) the lease of `client`'s focus: `arm` is given the arming's number and returns the timer that, at the end of the
    /// lease, calls [`Self::lapse_focus`] with it. A renewal replaces the earlier timer.
    pub fn lease_focus(&mut self, client: &str, arm: impl FnOnce(u64) -> Option<TimerHandle>) {
        self.last_epoch += 1;
        let epoch = self.last_epoch;
        let timer = arm(epoch);
        if let Some(old) = self.leases.insert(client.to_owned(), FocusLease { epoch, timer }) {
            old.cancel();
        }
    }

    /// The lease numbered `epoch` of `client`'s focus ran out: the focus ends. A lease renewed since (another number) or ended is left.
    pub fn lapse_focus(&mut self, client: &str, epoch: u64) {
        if self.leases.get(client).is_some_and(|lease| lease.epoch == epoch) {
            self.leases.remove(client);
            self.focus.remove(client);
        }
    }

    /// Whether `client`'s focus stands.
    pub fn focused_by(&self, client: &str) -> bool {
        self.focus.contains(client)
    }

    /// The shell exited: nothing reports any more.
    pub fn exit(&mut self) -> Option<Option<ActivityState>> {
        self.focus.clear();
        for (_, lease) in std::mem::take(&mut self.leases) {
            lease.cancel();
        }
        self.set(None)
    }
}

#[cfg(test)]
mod focus_lease {
    use super::*;

    fn finished_after_a_command(tracker: &mut ActivityTracker) -> Option<ActivityState> {
        tracker.marker(Marker::Start);
        tracker.marker(Marker::Done { exit_code: Some(0) });
        tracker.state()
    }

    /// A view whose focus lease lapses no longer counts as focused: a command that completes then leaves the tab `finished`, not `idle`
    /// (a window that vanished without closing its connection cannot keep a tab focused).
    #[test]
    fn a_lapsed_focus_no_longer_keeps_the_tab_idle() {
        let mut tracker = ActivityTracker::new(false);
        tracker.set_focus("view", true);
        tracker.lease_focus("view", |_| None);
        tracker.lapse_focus("view", tracker.last_epoch);
        assert!(!tracker.focused_by("view"));
        assert_eq!(finished_after_a_command(&mut tracker), Some(ActivityState::Finished));
    }

    /// A renewal makes the earlier arming's lapse stale: the focus stands.
    #[test]
    fn a_renewed_focus_survives_the_earlier_lapse() {
        let mut tracker = ActivityTracker::new(false);
        tracker.set_focus("view", true);
        tracker.lease_focus("view", |_| None);
        let first = tracker.last_epoch;
        tracker.set_focus("view", true);
        tracker.lease_focus("view", |_| None);
        tracker.lapse_focus("view", first);
        assert!(tracker.focused_by("view"));
        assert_eq!(finished_after_a_command(&mut tracker), Some(ActivityState::Idle));
    }

    /// An unfocus ends the lease with the focus; a later lapse of its arming finds nothing.
    #[test]
    fn an_unfocus_ends_the_lease() {
        let mut tracker = ActivityTracker::new(false);
        tracker.set_focus("view", true);
        tracker.lease_focus("view", |_| None);
        let epoch = tracker.last_epoch;
        tracker.set_focus("view", false);
        tracker.set_focus("other", true);
        tracker.lapse_focus("view", epoch);
        assert!(tracker.focused_by("other"));
        assert!(!tracker.focused_by("view"));
    }

    /// The lease is the 30 s of `TERMINAL_FOCUS_LEASE_MS`, longer than the renderer's 10 s renewal.
    #[test]
    fn the_lease_is_thirty_seconds() {
        assert_eq!(FOCUS_LEASE, Duration::from_secs(30));
    }
}
