//! The one publisher of the `remote` section. WP-REMOTE owns the whole value
//! `{info, settings, claims, clients, controllerKeys, owedKeys, pairCode}`: every change is
//! published as the complete value (never a member merge in the daemon), and the first publish
//! happens at construction so the app snapshot never lacks the section.
//!
//! State changes enter through [`RemoteSection::update`]; the pair code arrives through
//! [`RemoteSection::set_pair_code`], which is what the composition's `PairCodeEffects::publish`
//! calls. Publication never waits (`StatePublisher::publish`), so it happens under the lock and
//! two changes can never reach the feed out of order.

use std::sync::{Arc, Mutex};

use bytes::Bytes;
use mixdog_core_api::state::{SectionChange, StatePublisher};
use mixdog_protocol::{RemotePairCode, SectionName};
use serde::Serialize;
use serde_json::{Value, json};

use crate::clients::ClaimRequest;
use crate::identity::{ControllerKeyRecord, OwedAccess};
use crate::pair_code::PairCodeView;

/// Values above this encode as a stub the client pages (`INLINE_MAX`, SPEC R2).
const INLINE_MAX: usize = 256 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSectionValue {
    /// Relay status, URL, token presence, E2EE identity fingerprint (today's `remoteAccessInfo`).
    pub info: Value,
    /// Device-wide `remoteAccess` settings (enabled, name, aliases).
    pub settings: Value,
    pub claims: Vec<Value>,
    /// Paired devices as Settings › Connection lists them: the relay's record with the user's
    /// local `alias`, and `pendingRemoval` while an unpair is queued.
    pub clients: Vec<Value>,
    pub controller_keys: Vec<ControllerKeyRecord>,
    pub owed_keys: OwedAccess,
    pub pair_code: Option<RemotePairCode>,
}

impl Default for RemoteSectionValue {
    fn default() -> Self {
        Self {
            info: Value::Null,
            settings: Value::Null,
            claims: Vec::new(),
            clients: Vec::new(),
            controller_keys: Vec::new(),
            owed_keys: OwedAccess { keys: Vec::new(), unknown: 0 },
            pair_code: None,
        }
    }
}

/// A pending claim as the section lists it.
pub fn claim_value(claim: &ClaimRequest) -> Value {
    json!({
        "claimId": claim.claim_id,
        "clientId": claim.client_id,
        "name": claim.name,
        "platform": claim.platform,
        "browser": claim.browser,
        "method": match claim.method {
            crate::clients::ClaimMethod::Qr => "qr",
            crate::clients::ClaimMethod::Code => "code",
            crate::clients::ClaimMethod::Retry => "retry",
        },
        "requestedAt": claim.requested_at,
        "expiresAt": claim.expires_at,
    })
}

pub struct RemoteSection {
    publisher: Arc<dyn StatePublisher>,
    state: Mutex<(RemoteSectionValue, Bytes)>,
}

fn encode(value: &RemoteSectionValue) -> Bytes {
    Bytes::from(serde_json::to_vec(value).unwrap_or_default())
}

fn publish(publisher: &dyn StatePublisher, value: &RemoteSectionValue, bytes: &Bytes) {
    let change = if bytes.len() > INLINE_MAX {
        SectionChange::Stub { count: value.clients.len() as u64 }
    } else {
        SectionChange::Set(bytes.clone())
    };
    publisher.publish(SectionName::Remote, None, change);
}

impl RemoteSection {
    /// Builds the publisher and publishes `initial` at once: the first publish at startup.
    pub fn new(publisher: Arc<dyn StatePublisher>, initial: RemoteSectionValue) -> Self {
        let bytes = encode(&initial);
        publish(publisher.as_ref(), &initial, &bytes);
        Self { publisher, state: Mutex::new((initial, bytes)) }
    }

    /// Applies `change` and publishes the whole value if it changed anything.
    pub fn update(&self, change: impl FnOnce(&mut RemoteSectionValue)) {
        let mut guard = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let (value, bytes) = &mut *guard;
        change(value);
        let next = encode(value);
        if next != *bytes {
            *bytes = next;
            publish(self.publisher.as_ref(), value, bytes);
        }
    }

    /// The pair code leaves or enters the section; the rest of the value is untouched.
    pub fn set_pair_code(&self, code: Option<&PairCodeView>) {
        self.update(|value| {
            value.pair_code = code.map(|c| RemotePairCode { code: c.code.clone(), expires_at: c.expires_at as i64 });
        });
    }

    pub fn snapshot(&self) -> RemoteSectionValue {
        self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner).0.clone()
    }
}
