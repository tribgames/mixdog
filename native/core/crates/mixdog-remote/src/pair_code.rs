//! The main PC's 6-digit pairing code (pairing v2), published in the `remote` section as
//! `pairCode: {code, expiresAt} | null`. The relay holds the code → device-route mapping; a code
//! is valid for five minutes and single use. A code is a secret of a few minutes' life: it is
//! never logged here and goes nowhere but the relay and the section.
//!
//! The section is the only way to follow it: there is no ensure/renew heartbeat. A change is
//! published when a code is issued, replaced or consumed; at `expiresAt` the core ticker calls
//! [`PairCode::on_tick`], which publishes `null` — nothing polls.

use serde_json::{Value, json};

pub const PAIR_CODE_TTL_MS: u64 = 300_000;

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
}

struct Held {
    view: PairCodeView,
    lease: String,
}

pub struct PairCode {
    current: Option<Held>,
    pending: Option<String>,
    /// A code is wanted (Settings › Connection is open).
    wanted: bool,
}

impl Default for PairCode {
    fn default() -> Self {
        Self::new()
    }
}

impl PairCode {
    pub fn new() -> Self {
        Self { current: None, pending: None, wanted: false }
    }

    pub fn current(&self) -> Option<&PairCodeView> {
        self.current.as_ref().map(|held| &held.view)
    }

    fn request(&mut self, fx: &mut dyn PairCodeEffects, host_name: &str) {
        let mut raw = [0u8; 16];
        rand::fill(&mut raw[..]);
        let lease: String = raw.iter().map(|b| format!("{b:02x}")).collect();
        if fx.send(json!({ "type": "pair-code-request", "lease": lease, "name": host_name })) {
            self.pending = Some(lease);
        }
    }

    fn drop_current(&mut self, fx: &mut dyn PairCodeEffects) {
        if self.current.take().is_some() {
            fx.publish(None);
        }
    }

    /// The screen opened: ask for a code unless one is live or on its way.
    pub fn want(&mut self, fx: &mut dyn PairCodeEffects, host_name: &str, now_ms: u64) {
        self.wanted = true;
        if self.current.as_ref().is_some_and(|held| held.view.expires_at > now_ms) || self.pending.is_some() {
            return;
        }
        self.request(fx, host_name);
    }

    /// A new code on request (the user pressed "new code"): the relay's reply replaces the old.
    pub fn renew(&mut self, fx: &mut dyn PairCodeEffects, host_name: &str) {
        self.wanted = true;
        self.pending = None;
        self.request(fx, host_name);
    }

    /// The screen closed: withdraw the code from the relay.
    pub fn release(&mut self, fx: &mut dyn PairCodeEffects) {
        self.wanted = false;
        let held = self.current.is_some() || self.pending.is_some();
        self.pending = None;
        self.drop_current(fx);
        if held {
            fx.send(json!({ "type": "pair-code-clear" }));
        }
    }

    /// The relay answered a `pair-code-request`. A refusal or an answer in no usable form means
    /// the relay cannot issue codes: the section shows none.
    pub fn on_issued(&mut self, fx: &mut dyn PairCodeEffects, envelope: &Value, now_ms: u64) {
        let Some(lease) = self.pending.take_if(|lease| envelope.get("lease").and_then(Value::as_str) == Some(lease)) else {
            return;
        };
        let code = envelope.get("code").and_then(Value::as_str).filter(|c| c.len() == 6 && c.bytes().all(|b| b.is_ascii_digit()));
        let ttl = envelope.get("expiresInMs").and_then(Value::as_f64).filter(|t| *t > 0.0);
        let (true, Some(code), Some(ttl)) = (envelope.get("ok") == Some(&Value::Bool(true)), code, ttl) else {
            self.drop_current(fx);
            return;
        };
        let expires_at = now_ms + (ttl as u64).min(PAIR_CODE_TTL_MS);
        let view = PairCodeView { code: code.to_owned(), expires_at };
        // The relay keeps one code per PC, so this replaces any earlier one.
        self.current = Some(Held { view: view.clone(), lease });
        fx.publish(Some(&view));
        fx.wake_at(expires_at);
    }

    /// The relay redeemed a code; only the lease that owns it is spent.
    pub fn on_used(&mut self, fx: &mut dyn PairCodeEffects, envelope: &Value) {
        let owns = self
            .current
            .as_ref()
            .is_some_and(|held| envelope.get("lease").and_then(Value::as_str) == Some(held.lease.as_str()));
        if owns {
            self.drop_current(fx);
        }
    }

    /// A relay leg opened: it holds nothing of ours. The section no longer shows the old code,
    /// and a wanted one is asked for again.
    pub fn on_connected(&mut self, fx: &mut dyn PairCodeEffects, host_name: &str) {
        self.pending = None;
        self.drop_current(fx);
        if self.wanted {
            self.request(fx, host_name);
        }
    }

    /// The core ticker reached a requested wake time: an expired code leaves the section. A
    /// wake for a code that was replaced meanwhile finds it live and changes nothing.
    pub fn on_tick(&mut self, fx: &mut dyn PairCodeEffects, now_ms: u64) {
        if self.current.as_ref().is_some_and(|held| held.view.expires_at <= now_ms) {
            self.drop_current(fx);
        }
    }
}
