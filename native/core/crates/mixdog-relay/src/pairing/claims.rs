//! The approval handoff (`POST /claim`, `GET /claim/<claimId>`, and the desktop's `claim-approve` and `claim-deny` frames). A
//! browser that has no credential yet claims one for a desktop; the desktop's user decides, and the credential comes back sealed
//! to the browser's throwaway key. The claim id (an unguessable UUID only the claimant was given) is the poll's secret.
//!
//! The pool of claims is bounded as a whole and per desktop and per source address. A claim is pending for [`CLAIM_TTL_MS`]; an
//! approved one stays readable for [`APPROVED_CLAIM_RETAIN_MS`] (or until its client registers) so a lost poll answer can be asked
//! for again, and an expired one keeps answering `expired` for [`EXPIRED_CLAIM_RETAIN_MS`]; after that it is `unknown`.

use serde_json::{Value, json};

use super::{MAX_JSON_BODY_BYTES, Oversize, Pairing, field_text, lock, read_json, reply_json, reply_status};
use crate::http1::util::{browser_socket_origin_allowed, client_ip, decoded_request_path};
use crate::http1::{Request, ResponseWriter};
use crate::ids::is_routing_id;
use crate::rate_limit::now_ms;
use crate::store::{ClientProfile, ProfileInput, client_profile};

pub const MAX_PENDING_CLAIMS: usize = 64;
/// The global pool is shared by every desktop on the box, so it also needs a per-target and per-source share: otherwise one
/// caller (or one named device) fills all 64 slots and every other install gets `busy` until they expire.
pub const MAX_PENDING_CLAIMS_PER_DEVICE: usize = 8;
pub const MAX_PENDING_CLAIMS_PER_SOURCE: usize = 8;
/// Long enough to walk to the desktop and answer the prompt there.
pub const CLAIM_TTL_MS: i64 = 300_000;
pub const APPROVED_CLAIM_RETAIN_MS: i64 = 60_000;
pub const EXPIRED_CLAIM_RETAIN_MS: i64 = 60_000;

/// The name a claim carries when the browser gave none.
const DEFAULT_CLAIM_NAME: &str = "Web app";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimStatus {
    Pending,
    Approved,
    Denied,
    Expired,
}

impl ClaimStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Denied => "denied",
            Self::Expired => "expired",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Claim {
    pub id: String,
    pub device_id: String,
    pub client_id: String,
    pub public_key: String,
    pub profile: ClientProfile,
    /// The address the claim came from.
    pub source: String,
    pub status: ClaimStatus,
    /// The plaintext credential the desktop's approval minted, kept until the claim is forgotten.
    pub token: String,
    /// The opaque box the desktop sealed the pairing material in, as it sent it.
    pub sealed: Value,
    pub expires_at: i64,
}

/// What the desktop's approval asks the handler to do next.
#[derive(Debug, PartialEq, Eq)]
pub enum Approval {
    /// Not this desktop's claim, not pending, or lapsed (and then marked so): nothing more.
    Ignored,
    /// Register this browser, then [`Claims::finish_approval`].
    Register { client_id: String, profile: ClientProfile },
}

/// The pending claims (`claims`): a map in insertion order.
#[derive(Debug, Default)]
pub struct Claims {
    rows: Vec<Claim>,
}

impl Claims {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    pub fn get(&self, id: &str) -> Option<&Claim> {
        self.rows.iter().find(|claim| claim.id == id)
    }

    fn get_mut(&mut self, id: &str) -> Option<&mut Claim> {
        self.rows.iter_mut().find(|claim| claim.id == id)
    }

    pub fn insert(&mut self, claim: Claim) {
        self.rows.retain(|held| held.id != claim.id);
        self.rows.push(claim);
    }

    /// `sweepExpiredClaims`: an approved claim whose retention is over and an expired one that has been told so long enough are
    /// forgotten; anything else lapses to `expired`.
    pub fn sweep(&mut self, now: i64) {
        self.rows.retain_mut(|claim| {
            if claim.expires_at > now {
                return true;
            }
            if matches!(claim.status, ClaimStatus::Approved | ClaimStatus::Expired) {
                return false;
            }
            claim.status = ClaimStatus::Expired;
            claim.expires_at = now + EXPIRED_CLAIM_RETAIN_MS;
            true
        });
    }

    /// `answerClaimPoll`: an id this relay does not hold (a restart, or retention over) is `unknown`, which the client answers by
    /// claiming again; `expired` is a claim that really lapsed. An approved claim answers with the credential to anyone who
    /// presents its id until its retention passes or the client registers.
    pub fn poll(&self, id: &str) -> Value {
        let Some(claim) = self.get(id) else { return json!({ "status": "unknown" }) };
        if claim.status != ClaimStatus::Approved {
            return json!({ "status": claim.status.as_str() });
        }
        json!({ "status": "approved", "clientId": claim.client_id, "token": claim.token, "sealed": claim.sealed })
    }

    /// `pendingClaimId`: idempotent, so a phone that reloads mid-approval (a backgrounded web app is discarded freely) resumes the
    /// request the user is already looking at instead of raising a second prompt on the desktop. A different key is a different
    /// container and does get its own request.
    pub fn pending_id(&self, device_id: &str, client_id: &str, public_key: &str) -> Option<String> {
        self.rows
            .iter()
            .find(|claim| {
                claim.status == ClaimStatus::Pending && claim.device_id == device_id && claim.client_id == client_id && claim.public_key == public_key
            })
            .map(|claim| claim.id.clone())
    }

    /// `claimQuotaExceeded`.
    pub fn quota_exceeded(&self, device_id: &str, source: &str) -> bool {
        let device_claims = self.rows.iter().filter(|claim| claim.device_id == device_id).count();
        let source_claims = self.rows.iter().filter(|claim| claim.source == source).count();
        self.rows.len() >= MAX_PENDING_CLAIMS || device_claims >= MAX_PENDING_CLAIMS_PER_DEVICE || source_claims >= MAX_PENDING_CLAIMS_PER_SOURCE
    }

    /// `releaseApprovedClaim`: the client holds the answer, so the re-read window of the claim that minted this credential closes.
    pub fn release_token(&mut self, token: &str) {
        self.rows.retain(|claim| !(claim.status == ClaimStatus::Approved && claim.token == token));
    }

    /// The first half of `approveClaim`: only the desktop the claim named may answer it, and only while it is pending. A lapsed
    /// claim is not deleted: a poll must still read `expired`, which only `unknown` differs from.
    pub fn begin_approval(&mut self, id: &str, device_id: &str, now: i64) -> Approval {
        let Some(claim) = self.get_mut(id) else { return Approval::Ignored };
        if claim.device_id != device_id || claim.status != ClaimStatus::Pending {
            return Approval::Ignored;
        }
        if claim.expires_at <= now {
            claim.status = ClaimStatus::Expired;
            claim.expires_at = now + EXPIRED_CLAIM_RETAIN_MS;
            return Approval::Ignored;
        }
        Approval::Register { client_id: claim.client_id.clone(), profile: claim.profile.clone() }
    }

    /// The second half of `approveClaim`, once the registration answered: a refused one (the device is full) is a denial. From here
    /// the claim only lives to be re-read by a poller whose answer was lost. A claim that is no longer pending (it was denied or
    /// lapsed while the credential was being written) keeps its state.
    pub fn finish_approval(&mut self, id: &str, token: Option<String>, sealed: Value, now: i64) {
        let Some(claim) = self.get_mut(id).filter(|claim| claim.status == ClaimStatus::Pending) else { return };
        match token {
            None => claim.status = ClaimStatus::Denied,
            Some(token) => {
                claim.token = token;
                claim.sealed = sealed;
                claim.status = ClaimStatus::Approved;
                claim.expires_at = now + APPROVED_CLAIM_RETAIN_MS;
            }
        }
    }

    /// `denyClaim`: only the desktop the claim named may answer it.
    pub fn deny(&mut self, id: &str, device_id: &str) {
        if let Some(claim) = self.get_mut(id).filter(|claim| claim.device_id == device_id) {
            claim.status = ClaimStatus::Denied;
        }
    }
}

/// `/^[A-Za-z0-9_-]{86,88}$/`.
fn is_public_key(value: &str) -> bool {
    (86..=88).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// What a browser asked for in its claim.
struct ClaimRequest<'a> {
    device_id: &'a str,
    client_id: &'a str,
    public_key: &'a str,
    ticket: Option<&'a str>,
    retry: bool,
    profile: ClientProfile,
    source: &'a str,
}

/// What the pool decided.
enum Started {
    Offline,
    Busy,
    /// A pending claim for the same device, client and key already exists.
    Resumed(String),
    Opened(String),
}

impl Pairing {
    /// Desktop online, no duplicate request, quota available: records the claim and asks the desktop for approval. A request with no
    /// ticket is never labelled a code; a client retrying a code-started pairing says so, and the dialog calls it a retry.
    fn start_claim(&self, asked: ClaimRequest<'_>) -> Started {
        let ClaimRequest { device_id, client_id, public_key, ticket, retry, profile, source } = asked;
        if !self.hub.desktop_open(device_id) {
            return Started::Offline;
        }
        let now = now_ms();
        // The pool is read and written under one lock, so two requests cannot both take the last place.
        let mut claims = lock(&self.claims);
        if let Some(existing) = claims.pending_id(device_id, client_id, public_key) {
            return Started::Resumed(existing);
        }
        if claims.quota_exceeded(device_id, source) {
            return Started::Busy;
        }
        let method = if lock(&self.codes).take_ticket(ticket, device_id) {
            "code"
        } else if retry {
            "retry"
        } else {
            "qr"
        };
        let id = uuid::Uuid::new_v4().to_string();
        let expires_at = now + CLAIM_TTL_MS;
        let frame = json!({
            "type": "client-claim",
            "claimId": id,
            "clientId": client_id,
            "publicKey": public_key,
            "expiresAt": expires_at,
            "method": method,
            "name": profile.name,
            "platform": profile.platform,
            "browser": profile.browser,
        });
        if !self.hub.send_to_desktop(device_id, &frame) {
            return Started::Offline;
        }
        claims.insert(Claim {
            id: id.clone(),
            device_id: device_id.to_owned(),
            client_id: client_id.to_owned(),
            public_key: public_key.to_owned(),
            profile,
            source: source.to_owned(),
            status: ClaimStatus::Pending,
            token: String::new(),
            sealed: Value::Null,
            expires_at,
        });
        Started::Opened(id)
    }

    /// `approveClaim`: the approval itself. Only then does a credential exist for that container.
    pub(super) async fn approve_claim(&self, device_id: &str, message: &Value) {
        let Some(claim_id) = message.get("claimId").and_then(Value::as_str) else { return };
        let approval = lock(&self.claims).begin_approval(claim_id, device_id, now_ms());
        let Approval::Register { client_id, profile } = approval else { return };
        let profile = ProfileInput { name: Value::String(profile.name), platform: Value::String(profile.platform), browser: Value::String(profile.browser) };
        let registered = self.hub.store().register_client(device_id, &client_id, &profile).await;
        let sealed = message.get("sealed").cloned().unwrap_or(Value::Null);
        lock(&self.claims).finish_approval(claim_id, registered.map(|client| client.token), sealed, now_ms());
    }

    /// `denyClaim`.
    pub(super) fn deny_claim(&self, device_id: &str, message: &Value) {
        let Some(claim_id) = message.get("claimId").and_then(Value::as_str) else { return };
        lock(&self.claims).deny(claim_id, device_id);
    }
}

/// `handleClaimRequest`.
pub(super) async fn handle(pairing: &Pairing, mut request: Request, mut response: ResponseWriter) {
    let Some((_, pathname)) = decoded_request_path(&request.url) else {
        reply_status(&mut response, 400, &[]);
        return;
    };
    lock(&pairing.claims).sweep(now_ms());
    if request.method == "GET"
        && let Some(claim_id) = pathname.strip_prefix("/claim/")
    {
        let answer = lock(&pairing.claims).poll(claim_id);
        reply_json(&mut response, 200, &answer, &[]);
        return;
    }
    if request.method != "POST" || pathname != "/claim" {
        reply_status(&mut response, 405, &[]);
        return;
    }
    if !browser_socket_origin_allowed(&request.headers, request.encrypted) {
        reply_status(&mut response, 403, &[]);
        return;
    }
    let Ok(body) = read_json(&mut request, MAX_JSON_BODY_BYTES, Oversize::Destroy).await else {
        reply_status(&mut response, 400, &[]);
        return;
    };
    let device_id = field_text(&body, "deviceId");
    let client_id = field_text(&body, "clientId");
    let public_key = field_text(&body, "publicKey");
    if !is_routing_id(&device_id) || !is_routing_id(&client_id) || !is_public_key(&public_key) || !pairing.hub.store().is_known(&device_id) {
        pairing.reject_unauthorized(&request, &mut response, 404);
        return;
    }
    let profile = client_profile(&ProfileInput::from_value(&body), DEFAULT_CLAIM_NAME);
    let source = client_ip(request.remote_address.as_deref());
    let ticket = body.get("ticket").and_then(Value::as_str);
    let retry = body.get("retry") == Some(&Value::Bool(true));
    let asked = ClaimRequest { device_id: &device_id, client_id: &client_id, public_key: &public_key, ticket, retry, profile, source };
    match pairing.start_claim(asked) {
        Started::Offline => reply_json(&mut response, 503, &json!({ "status": "offline" }), &[]),
        Started::Busy => reply_json(&mut response, 503, &json!({ "status": "busy" }), &[]),
        Started::Resumed(id) | Started::Opened(id) => reply_json(&mut response, 202, &json!({ "claimId": id }), &[]),
    }
}
