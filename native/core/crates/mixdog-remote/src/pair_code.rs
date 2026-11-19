//! The main PC's 6-digit pairing code (pairing v2), published in the `remote` section as
//! `pairCode: {code, expiresAt} | null`. The relay holds the code → device-route mapping; a code
//! is valid for five minutes and single use. A code is a secret of a few minutes' life: it is
//! never logged here and goes nowhere but the relay and the section.
//!
//! A code is wanted while a pairing view holds it. A view is owned by the connection it came
//! through ([`PairOwner`]: the connection's id and its lifetime token). The view takes its hold
//! with `ensure`; the hold ends when the view `release`s it or its connection closes
//! ([`PairCode::connection_closed`]), and the code is wanted while any hold of a live owner
//! exists: an owner whose lifetime has ended does not count even before its close hook ran, and
//! it cannot take or renew a hold. There is no lease and no heartbeat: an open view is served
//! until its hold ends. Holds are only ever created by [`PairCode::want`], never by the end of
//! a startup.
//! While a code is wanted there is always a current code or a request in flight: a used or
//! expired code is replaced at once (the core ticker calls [`PairCode::on_tick`]), and the next
//! one is requested [`PAIR_CODE_RENEW_BEFORE_MS`] ahead of the current one's expiry so the screen
//! never shows a gap. A request the relay leaves unanswered for
//! [`PAIR_CODE_REQUEST_TIMEOUT_MS`] means it cannot issue codes ([`PairCode::unsupported`]).
//! Changes of the code reach the screen through the `remote` section; the unsupported state is
//! read from the `ensure` answer.

use std::collections::BTreeMap;

use mixdog_rt::CancellationToken;
use serde_json::{Value, json};

/// The connection a pairing view came through: its id, and the token that is cancelled when
/// the connection closes (it is cancelled before the close hook runs).
#[derive(Clone, Debug)]
pub struct PairOwner {
    pub id: u64,
    pub alive: CancellationToken,
}

/// The owner's connection has closed, or never held the code: nothing is taken or renewed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NotHeld;

pub const PAIR_CODE_TTL_MS: u64 = 300_000;
/// While the screen stays open the next code is requested this long before the shown one expires.
pub const PAIR_CODE_RENEW_BEFORE_MS: u64 = 30_000;
/// A request unanswered this long means the relay cannot issue codes (older relay).
pub const PAIR_CODE_REQUEST_TIMEOUT_MS: u64 = 5_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PairCodeView {
    /// Six digits, no separator.
    pub code: String,
    pub expires_at: u64,
}

impl PairCodeView {
    /// The member value of the `remote` section.
    pub fn to_value(view: Option<&Self>) -> Value {
        view.map_or(Value::Null, |v| json!({ "code": v.code, "expiresAt": v.expires_at }))
    }
}

/// What the manager does to the world; the core wires each to its owner.
pub trait PairCodeEffects {
    /// Writes a frame to the open relay leg; false when there is none.
    fn send(&mut self, envelope: Value) -> bool;
    /// Hands the change to the `remote` section's one publisher (`RemoteSection::set_pair_code`),
    /// which publishes the whole section value.
    fn publish(&mut self, code: Option<&PairCodeView>);
    /// Asks the core ticker to call `on_tick` at `at_ms` (epoch ms); replaces an earlier request.
    fn wake_at(&mut self, at_ms: u64);
    /// The clock a request is stamped with when it is submitted to the leg (epoch ms).
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
    }
}

struct Held {
    view: PairCodeView,
    lease: String,
}

struct Pending {
    lease: String,
    /// When the request was written to the leg.
    at: u64,
}

pub struct PairCode {
    current: Option<Held>,
    pending: Option<Pending>,
    /// The pairing views that hold the code, by owner id, each with its owner's lifetime; the code is wanted while the
    /// lifetime of any has not ended.
    holds: BTreeMap<u64, CancellationToken>,
    /// The relay cannot issue codes: it refused, or never answered a request.
    unsupported: bool,
    /// The name the screen's last ask carried; later requests (renewals) reuse it.
    host_name: String,
}

impl Default for PairCode {
    fn default() -> Self {
        Self::new()
    }
}

impl PairCode {
    pub fn new() -> Self {
        Self { current: None, pending: None, holds: BTreeMap::new(), unsupported: false, host_name: String::new() }
    }

    /// Whether a view of a connection that is still open holds the code.
    fn wanted(&self) -> bool {
        self.holds.values().any(|alive| !alive.is_cancelled())
    }

    /// The relay cannot issue codes (it refused one, or never answered a request).
    pub fn unsupported(&self) -> bool {
        self.unsupported
    }

    pub fn current(&self) -> Option<&PairCodeView> {
        self.current.as_ref().map(|held| &held.view)
    }

    /// Submits a request to the leg; its time is the clock's at that moment, whatever the caller's `now` was.
    fn request(&mut self, fx: &mut dyn PairCodeEffects) {
        let mut raw = [0u8; 16];
        rand::fill(&mut raw[..]);
        let lease: String = raw.iter().map(|b| format!("{b:02x}")).collect();
        if fx.send(json!({ "type": "pair-code-request", "lease": lease, "name": self.host_name })) {
            self.pending = Some(Pending { lease, at: fx.now_ms() });
        }
    }

    /// A request unanswered for the timeout: the relay cannot issue codes.
    fn expire_pending(&mut self, now_ms: u64) {
        if self.pending.as_ref().is_some_and(|p| now_ms.saturating_sub(p.at) > PAIR_CODE_REQUEST_TIMEOUT_MS) {
            self.pending = None;
            self.unsupported = true;
        }
    }

    /// While wanted there is a live code or a request in flight: an expired code leaves, and a
    /// missing or soon-ending one is asked for again (the relay keeps one code per PC, so the
    /// reply replaces any earlier one).
    fn keep_supplied(&mut self, fx: &mut dyn PairCodeEffects, now_ms: u64) {
        if self.current.as_ref().is_some_and(|held| held.view.expires_at <= now_ms) {
            self.drop_current(fx);
        }
        if !self.wanted() || self.unsupported || self.pending.is_some() {
            return;
        }
        let ending = self.current.as_ref().is_none_or(|held| held.view.expires_at <= now_ms + PAIR_CODE_RENEW_BEFORE_MS);
        if ending {
            self.request(fx);
        }
    }

    /// Asks the core ticker for the next instant something here changes on its own: the end of a
    /// request's wait, the renewal lead, the code's expiry.
    fn arm(&self, fx: &mut dyn PairCodeEffects, now_ms: u64) {
        let mut next: Option<u64> = None;
        let mut note = |at: u64| {
            if at > now_ms {
                next = Some(next.map_or(at, |earlier| earlier.min(at)));
            }
        };
        if let Some(pending) = &self.pending {
            note(pending.at + PAIR_CODE_REQUEST_TIMEOUT_MS + 1);
        }
        if let Some(held) = &self.current {
            note(held.view.expires_at);
            if self.wanted() && self.pending.is_none() && !self.unsupported {
                note(held.view.expires_at.saturating_sub(PAIR_CODE_RENEW_BEFORE_MS));
            }
        }
        if let Some(at) = next {
            fx.wake_at(at);
        }
    }

    fn drop_current(&mut self, fx: &mut dyn PairCodeEffects) {
        if self.current.take().is_some() {
            fx.publish(None);
        }
    }

    /// A pairing view of `owner` opened: it takes a hold (the one way a hold is created), and a code
    /// is asked for unless a live one is not about to end or a request is out. Asking again changes
    /// nothing. An owner whose connection has already closed is refused and holds nothing.
    pub fn want(&mut self, fx: &mut dyn PairCodeEffects, host_name: &str, now_ms: u64, owner: &PairOwner) -> Result<(), NotHeld> {
        if owner.alive.is_cancelled() {
            self.release(fx, owner.id);
            return Err(NotHeld);
        }
        self.holds.insert(owner.id, owner.alive.clone());
        self.host_name = host_name.to_owned();
        self.expire_pending(now_ms);
        self.keep_supplied(fx, now_ms);
        self.arm(fx, now_ms);
        Ok(())
    }

    /// A new code on request (the user pressed "new code"): the relay's reply replaces the old. Only
    /// a view that holds the code (and whose connection is open) can ask; a relay known to issue none
    /// is not asked again.
    pub fn renew(&mut self, fx: &mut dyn PairCodeEffects, host_name: &str, now_ms: u64, owner: &PairOwner) -> Result<(), NotHeld> {
        if owner.alive.is_cancelled() || !self.holds.get(&owner.id).is_some_and(|alive| !alive.is_cancelled()) {
            return Err(NotHeld);
        }
        self.host_name = host_name.to_owned();
        if !self.unsupported {
            // The shown code is cleared with the request: "new code" never hands the old one back while the relay's reply is awaited.
            self.drop_current(fx);
            self.pending = None;
            self.request(fx);
        }
        self.arm(fx, now_ms);
        Ok(())
    }

    /// The view of `owner` closed. It starts nothing; the code is withdrawn from the relay once no
    /// view of an open connection holds it.
    pub fn release(&mut self, fx: &mut dyn PairCodeEffects, owner: u64) {
        self.holds.remove(&owner);
        if self.wanted() {
            return;
        }
        let held = self.current.is_some() || self.pending.is_some();
        self.pending = None;
        self.drop_current(fx);
        if held {
            fx.send(json!({ "type": "pair-code-clear" }));
        }
    }

    /// The connection `owner` came through closed: every hold it owned ends, released or not.
    pub fn connection_closed(&mut self, fx: &mut dyn PairCodeEffects, owner: u64) {
        self.release(fx, owner);
    }

    /// The relay answered a `pair-code-request`. A refusal or an answer in no usable form means
    /// the relay cannot issue codes: the section shows none.
    pub fn on_issued(&mut self, fx: &mut dyn PairCodeEffects, envelope: &Value, now_ms: u64) {
        let Some(Pending { lease, .. }) = self.pending.take_if(|p| envelope.get("lease").and_then(Value::as_str) == Some(p.lease.as_str())) else {
            return;
        };
        let code = envelope.get("code").and_then(Value::as_str).filter(|c| c.len() == 6 && c.bytes().all(|b| b.is_ascii_digit()));
        let ttl = envelope.get("expiresInMs").and_then(Value::as_f64).filter(|t| *t > 0.0);
        let (true, Some(code), Some(ttl)) = (envelope.get("ok") == Some(&Value::Bool(true)), code, ttl) else {
            self.unsupported = true;
            self.drop_current(fx);
            return;
        };
        let expires_at = now_ms + (ttl as u64).min(PAIR_CODE_TTL_MS);
        let view = PairCodeView { code: code.to_owned(), expires_at };
        // The relay keeps one code per PC, so this replaces any earlier one.
        self.current = Some(Held { view: view.clone(), lease });
        fx.publish(Some(&view));
        self.arm(fx, now_ms);
    }

    /// The relay redeemed a code; only the lease that owns it is spent. A wanted code is replaced
    /// at once (the wake is already due), so a second phone can pair in the same visit.
    pub fn on_used(&mut self, fx: &mut dyn PairCodeEffects, envelope: &Value) {
        let owns = self
            .current
            .as_ref()
            .is_some_and(|held| envelope.get("lease").and_then(Value::as_str) == Some(held.lease.as_str()));
        if owns {
            self.drop_current(fx);
            if self.wanted() {
                fx.wake_at(0);
            }
        }
    }

    /// A relay leg opened: it holds nothing of ours. The section no longer shows the old code,
    /// a wanted one is asked for again, and a relay that could not issue codes is tried afresh.
    pub fn on_connected(&mut self, fx: &mut dyn PairCodeEffects, host_name: &str, now_ms: u64) {
        self.pending = None;
        self.unsupported = false;
        self.drop_current(fx);
        if self.wanted() {
            self.host_name = host_name.to_owned();
            self.request(fx);
        }
        self.arm(fx, now_ms);
    }

    /// The core ticker reached a requested wake time: a request may have gone unanswered, and an
    /// expired or soon-ending code is replaced while wanted. A wake for a code replaced meanwhile finds it live.
    pub fn on_tick(&mut self, fx: &mut dyn PairCodeEffects, now_ms: u64) {
        self.expire_pending(now_ms);
        self.keep_supplied(fx, now_ms);
        self.arm(fx, now_ms);
    }
}
