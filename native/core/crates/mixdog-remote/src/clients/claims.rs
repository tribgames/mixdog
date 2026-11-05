//! Pairing claims (remote-relay-client-lifecycle.ts `answerRelayClaim`). Approval material is
//! sealed to the claimant's key only, once: a redelivery with the same key shares the decision
//! and sends nothing more; one with another key means the transcript conflicts and the claim is
//! denied.

use std::collections::HashMap;

use serde_json::{Value, json};

use crate::e2ee::{PairingMaterial, is_claim_public_key};

const DEFAULT_CLAIM_TTL_MS: u64 = 300_000;
const CLAIM_ID_MAX: usize = 80;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClaimMethod {
    Qr,
    Code,
    Retry,
}

/// What the desktop asks its user (or policy) to decide.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaimRequest {
    pub claim_id: String,
    pub client_id: String,
    pub name: String,
    pub platform: String,
    pub browser: String,
    pub method: ClaimMethod,
    pub requested_at: u64,
    pub expires_at: u64,
}

#[derive(Debug, PartialEq)]
pub enum ClaimStep {
    /// Malformed, or a redelivery that shares the earlier decision.
    Ignore,
    /// The same claim id arrived with another key or client: denied, and the first one too.
    Conflict(Value),
    Ask(ClaimRequest),
}

struct Binding {
    public_key: String,
    client_id: String,
    expires_at: u64,
    conflicted: bool,
}

#[derive(Default)]
pub struct ClaimBindings {
    bindings: HashMap<String, Binding>,
}

fn clip(value: Option<&str>, max: usize) -> String {
    mixdog_js::slice_utf16(value.unwrap_or_default(), max)
}

pub fn deny(claim_id: &str) -> Value {
    json!({ "type": "claim-deny", "claimId": claim_id })
}

impl ClaimBindings {
    pub fn deliver(&mut self, envelope: &Value, now_ms: u64) -> ClaimStep {
        let claim_id = envelope.get("claimId").and_then(Value::as_str).unwrap_or_default();
        let Some(public_key) = envelope.get("publicKey").and_then(Value::as_str).filter(|k| is_claim_public_key(k))
        else {
            return ClaimStep::Ignore;
        };
        if claim_id.is_empty() {
            return ClaimStep::Ignore;
        }
        let client_id = {
            let id = clip(envelope.get("clientId").and_then(Value::as_str), CLAIM_ID_MAX);
            if id.is_empty() { clip(Some(claim_id), CLAIM_ID_MAX) } else { id }
        };
        self.bindings.retain(|_, binding| binding.expires_at > now_ms);
        if let Some(bound) = self.bindings.get_mut(claim_id) {
            if bound.public_key != public_key || bound.client_id != client_id {
                bound.conflicted = true;
                return ClaimStep::Conflict(deny(claim_id));
            }
            return ClaimStep::Ignore;
        }
        let expires_at = envelope
            .get("expiresAt")
            .and_then(Value::as_u64)
            .filter(|at| *at > now_ms)
            .unwrap_or(now_ms + DEFAULT_CLAIM_TTL_MS);
        self.bindings.insert(
            claim_id.to_owned(),
            Binding { public_key: public_key.to_owned(), client_id: client_id.clone(), expires_at, conflicted: false },
        );
        let text = |name: &str, max: usize| clip(envelope.get(name).and_then(Value::as_str), max);
        let name = text("name", 80);
        ClaimStep::Ask(ClaimRequest {
            claim_id: claim_id.to_owned(),
            client_id,
            name: if name.is_empty() { "Web app".to_owned() } else { name },
            platform: text("platform", 80),
            browser: text("browser", 80),
            method: match envelope.get("method").and_then(Value::as_str) {
                Some("code") => ClaimMethod::Code,
                Some("retry") => ClaimMethod::Retry,
                _ => ClaimMethod::Qr,
            },
            requested_at: now_ms,
            expires_at,
        })
    }

    /// The relay envelope answering the decision. An approval is sealed only for the key the claim
    /// was bound to and only when no conflicting delivery has come in since.
    pub fn answer(&self, claim_id: &str, approved: bool, material: &PairingMaterial) -> Value {
        let sealed = approved
            .then(|| self.bindings.get(claim_id))
            .flatten()
            .filter(|binding| !binding.conflicted)
            .and_then(|binding| super::table::seal_approval(material, &binding.public_key));
        match sealed {
            Some(sealed) => json!({ "type": "claim-approve", "claimId": claim_id, "sealed": sealed }),
            None => deny(claim_id),
        }
    }

    /// The client id the claim was bound to, once an approval is sent.
    pub fn client_of(&self, claim_id: &str) -> Option<&str> {
        self.bindings.get(claim_id).map(|binding| binding.client_id.as_str())
    }
}
