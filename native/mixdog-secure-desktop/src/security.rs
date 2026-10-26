//! Install secret, security-descriptor (SDDL) strings, constant-time secret
//! comparison, and the on-disk install state. The pure parts (SDDL building,
//! secret handling, state (de)serialization) carry the security-critical logic
//! and are unit-tested here; the current-user SID lookup lives in the Windows
//! layer and is injected as a string.

use std::time::{Duration, Instant};

use base64::{
    engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD},
    Engine as _,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};

use crate::paths::STATE_SCHEMA_VERSION;

/// 256-bit install secret. Large enough that it is never guessed; it is
/// defense-in-depth behind the pipe DACL, not the only gate.
pub const SECRET_BYTES: usize = 32;

/// The install state persisted under the ACL-protected state directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallState {
    /// On-disk schema version; a newer helper refuses an unknown schema.
    pub schema: u32,
    /// The Mixdog product/helper version that performed the install.
    pub product_version: String,
    /// SID (string form, e.g. `S-1-5-21-...`) of the user who opted in. The
    /// pipe and state-file DACLs grant exactly this SID and SYSTEM.
    pub user_sid: String,
    /// Base64 of the 32-byte install secret.
    pub secret: String,
    /// The app-facing pipe name the helper serves.
    pub pipe_name: String,
    /// Unix-epoch milliseconds the install completed.
    pub installed_at_ms: u64,
    /// The paired phones' control-grant public keys, one per paired phone,
    /// enrolled by an admin-gated `install`/`enroll` (elevated UAC, or the
    /// credential-logon path): base64url, unpadded, of the 65-byte uncompressed
    /// P-256 point. The helper accepts new input and `sas` only under a grant
    /// one of these keys signed ([`GrantBook`]); with none enrolled it refuses
    /// them all. The state file is writable by SYSTEM and Administrators only,
    /// so a process of the installing user can read these keys but never add or
    /// remove one — enrolling a key requires the elevated or logon path, which
    /// is the privilege-escalation guard (a same-user process must not be able
    /// to add a key and then drive its own UAC prompt).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub controller_keys: Vec<String>,
    /// Legacy single-key field written by installs before the key set (schema
    /// unchanged). Read for back-compat and folded into `controller_keys` by
    /// [`Self::from_json`]; never written again.
    #[serde(default, rename = "controllerKey", skip_serializing)]
    controller_key_legacy: Option<String>,
    /// The app-delegation policy (the "approve once, then paired phones
    /// auto-enroll" model). Absent/`default` on installs made before it, and on
    /// installs that did not opt in — both read as delegation disabled.
    #[serde(default, skip_serializing_if = "DelegationPolicy::is_default")]
    pub delegation: DelegationPolicy,
}

/// How the genuine signed Mixdog app may enroll/revoke phone keys **without
/// elevation** after a one-time elevated opt-in.
///
/// Stored only in the SYSTEM/Administrators-writable install state, never as a
/// bearer secret the app holds: the app asks the service and the service
/// decides. Only an elevated path ([`InstallState::enable_delegation`], reached
/// from the elevated `install`) can set `enabled`, so no unelevated process can
/// grant itself delegation — a same-user process cannot write this file. The
/// service re-reads it on every delegated request, so [`disable`]
/// (`InstallState::disable_delegation`) takes effect at once, across reconnect
/// and reboot; re-enabling after a disable needs elevation again (another
/// `install`).
///
/// It is an explicit, permanent delegation to the authorized app: approving it
/// trusts the app as it runs on this PC. The residual risk is documented in the
/// crate README Security section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DelegationPolicy {
    /// Whether delegated (unelevated, app-authorized) enroll/revoke is allowed.
    pub enabled: bool,
    /// The authorized app's exact Authenticode signer subject DN, captured from
    /// the release signer pin at opt-in. The service verifies the calling
    /// EXE's signer against this (plus the profile EKU) before honoring a
    /// delegated request. `None` on a never-delegated install.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_subject: Option<String>,
    /// The authorized app's Artifact Signing certificate-profile EKU, captured
    /// with the subject.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_profile_eku: Option<String>,
}

impl DelegationPolicy {
    /// A default (never-opted-in) policy, not serialized so the on-disk state of
    /// an install that never delegated is unchanged.
    pub fn is_default(&self) -> bool {
        !self.enabled && self.app_subject.is_none() && self.app_profile_eku.is_none()
    }

    /// The authorized app signer (subject + profile EKU) when delegation is
    /// enabled and both were recorded; `None` otherwise. The service uses this
    /// to decide; `None` means no delegated request is honored.
    pub fn authorized_signer(&self) -> Option<(&str, &str)> {
        if !self.enabled {
            return None;
        }
        match (self.app_subject.as_deref(), self.app_profile_eku.as_deref()) {
            (Some(subject), Some(eku)) => Some((subject, eku)),
            _ => None,
        }
    }
}

/// The maximum number of enrolled phone keys. Reuses the relay's cap on clients
/// paired to one desktop, `MAX_PAIRED_CLIENTS_PER_DEVICE` (256) in
/// `apps/relay/lib/device-store-auth.mjs`, so the helper never holds more keys
/// than the relay would ever pair to this PC.
pub const MAX_CONTROLLER_KEYS: usize = 256;

impl InstallState {
    pub fn new(product_version: &str, user_sid: &str, pipe_name: &str, installed_at_ms: u64) -> Self {
        InstallState {
            schema: STATE_SCHEMA_VERSION,
            product_version: product_version.to_string(),
            user_sid: user_sid.to_string(),
            secret: generate_secret(),
            pipe_name: pipe_name.to_string(),
            installed_at_ms,
            controller_keys: Vec::new(),
            controller_key_legacy: None,
            delegation: DelegationPolicy::default(),
        }
    }

    /// Opt in to app delegation, recording the authorized app signer (subject +
    /// Artifact Signing profile EKU). Only the elevated `install` reaches this,
    /// which is the privilege-escalation guard: the state file an unelevated
    /// process can read it cannot write.
    pub fn enable_delegation(&mut self, app_subject: &str, app_profile_eku: &str) {
        self.delegation = DelegationPolicy {
            enabled: true,
            app_subject: Some(app_subject.to_string()),
            app_profile_eku: Some(app_profile_eku.to_string()),
        };
    }

    /// Disable delegation (a security disable). The recorded app identity is
    /// kept for audit, but no delegated request is honored until an elevated
    /// `install` enables it again.
    pub fn disable_delegation(&mut self) {
        self.delegation.enabled = false;
    }

    /// Enroll each of `keys` (see [`Self::enroll_key`]). Used when `install`
    /// is given zero or more `--controller-key` values.
    pub fn with_controller_keys(mut self, keys: &[String]) -> Result<Self, String> {
        for key in keys {
            self.enroll_key(key)?;
        }
        Ok(self)
    }

    /// Add one phone's control-grant key, if not already enrolled and the cap
    /// is not reached. Returns whether it was newly added. Refuses anything
    /// that is not an uncompressed P-256 point, and refuses once
    /// [`MAX_CONTROLLER_KEYS`] keys are enrolled.
    pub fn enroll_key(&mut self, key: &str) -> Result<bool, String> {
        let point = decode_controller_key(key).ok_or("controller key is not an uncompressed P-256 point")?;
        if self.controller_keys.iter().any(|enrolled| decode_controller_key(enrolled) == Some(point)) {
            return Ok(false);
        }
        if self.controller_keys.len() >= MAX_CONTROLLER_KEYS {
            return Err(format!(
                "the helper already has the maximum of {MAX_CONTROLLER_KEYS} enrolled phone keys"
            ));
        }
        self.controller_keys.push(key.trim().to_string());
        Ok(true)
    }

    /// Remove one phone's key (matched as a decoded point, so padding or case
    /// of the base64url does not matter). Returns whether a key was removed.
    /// The others are kept.
    pub fn revoke_key(&mut self, key: &str) -> bool {
        let Some(point) = decode_controller_key(key) else {
            return false;
        };
        let before = self.controller_keys.len();
        self.controller_keys.retain(|enrolled| decode_controller_key(enrolled) != Some(point));
        self.controller_keys.len() != before
    }

    /// Whether `key` is one of the enrolled keys (compared as decoded points).
    pub fn is_key_enrolled(&self, key: &str) -> bool {
        match decode_controller_key(key) {
            Some(point) => self.controller_keys.iter().any(|enrolled| decode_controller_key(enrolled) == Some(point)),
            None => false,
        }
    }

    /// The enrolled controller keys, decoded; empty when none is enrolled. The
    /// helper verifies a grant against every one of these.
    pub fn controller_keys_bytes(&self) -> Vec<[u8; CONTROLLER_KEY_BYTES]> {
        self.controller_keys.iter().filter_map(|key| decode_controller_key(key)).collect()
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).expect("install state always serializes")
    }

    pub fn from_json(text: &str) -> Result<Self, String> {
        let mut state: InstallState =
            serde_json::from_str(text).map_err(|error| format!("invalid install state: {error}"))?;
        if state.schema != STATE_SCHEMA_VERSION {
            return Err(format!(
                "install state schema {} is not supported (expected {STATE_SCHEMA_VERSION})",
                state.schema
            ));
        }
        if BASE64.decode(state.secret.trim()).map(|s| s.len()) != Ok(SECRET_BYTES) {
            return Err("install state secret is malformed".into());
        }
        if !is_sid_literal(&state.user_sid) {
            return Err("install state user SID is malformed".into());
        }
        // Fold a legacy single key into the set, then validate every key and
        // the cap. A same-user process cannot exploit this read path: the
        // state file is writable by SYSTEM/Administrators only, so the keys it
        // reads were written by an elevated or logon-path operation.
        if let Some(legacy) = state.controller_key_legacy.take() {
            if !state.controller_keys.iter().any(|key| key == &legacy) {
                state.controller_keys.push(legacy);
            }
        }
        if state.controller_keys.iter().any(|key| decode_controller_key(key).is_none()) {
            return Err("install state controller key is malformed".into());
        }
        if state.controller_keys.len() > MAX_CONTROLLER_KEYS {
            return Err(format!(
                "install state has more than the maximum of {MAX_CONTROLLER_KEYS} controller keys"
            ));
        }
        Ok(state)
    }
}

/// A fresh base64-encoded 256-bit secret from the OS CSPRNG.
pub fn generate_secret() -> String {
    let mut bytes = [0u8; SECRET_BYTES];
    rand::rng().fill_bytes(&mut bytes);
    BASE64.encode(bytes)
}

/// Constant-time comparison of two secret strings. Length differences short
/// out, but the byte comparison over the shared prefix does not branch on
/// content, so a same-length guess cannot be timed character by character.
pub fn secret_matches(expected: &str, candidate: &str) -> bool {
    let a = expected.as_bytes();
    let b = candidate.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Length of each handshake nonce, in bytes. 128 bits is ample to make nonce
/// reuse (and therefore a replayed tag) negligible across the lifetime of an
/// install.
pub const NONCE_BYTES: usize = 16;

/// Domain-separation labels for the two directions of the challenge-response.
/// The server's tag and the client's tag cover different labels so one can
/// never be replayed as the other. These are the literal ASCII bytes named in
/// the IPC spec's handshake section.
pub const SERVER_LABEL: &[u8] = b"server";
pub const CLIENT_LABEL: &[u8] = b"client";

/// A fresh base64 nonce for the challenge-response handshake.
pub fn generate_nonce() -> String {
    let mut bytes = [0u8; NONCE_BYTES];
    rand::rng().fill_bytes(&mut bytes);
    BASE64.encode(bytes)
}

/// Decode a base64 nonce, accepting only the exact nonce length so a peer
/// cannot steer the HMAC input with an over- or under-sized value.
pub fn decode_nonce(encoded: &str) -> Option<Vec<u8>> {
    let bytes = BASE64.decode(encoded.trim()).ok()?;
    (bytes.len() == NONCE_BYTES).then_some(bytes)
}

/// The raw HMAC key: the 32 secret bytes (the stored secret is their base64).
/// An unparseable secret yields an empty key, which simply never matches a
/// legitimate peer; `InstallState::from_json` already rejects a malformed
/// secret before the helper runs.
pub fn secret_key(secret_b64: &str) -> Vec<u8> {
    BASE64.decode(secret_b64.trim()).unwrap_or_default()
}

/// `HMAC-SHA256(key, label ‖ first ‖ second)`, base64-encoded. The fixed-length
/// nonces make the concatenation unambiguous.
pub fn auth_tag(secret_b64: &str, label: &[u8], first: &[u8], second: &[u8]) -> String {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&secret_key(secret_b64))
        .expect("HMAC accepts a key of any length");
    mac.update(label);
    mac.update(first);
    mac.update(second);
    BASE64.encode(mac.finalize().into_bytes())
}

/// The server's proof it knows the secret: `HMAC(secret, "server" ‖ client ‖
/// server)`. Sent before the client proves anything, so the client aborts
/// without ever revealing its own tag if this fails.
pub fn server_auth_tag(secret_b64: &str, client_nonce: &[u8], server_nonce: &[u8]) -> String {
    auth_tag(secret_b64, SERVER_LABEL, client_nonce, server_nonce)
}

/// The client's proof it knows the secret: `HMAC(secret, "client" ‖ server ‖
/// client)`. A different label and nonce order than the server's tag, so
/// neither can be replayed as the other.
pub fn client_auth_tag(secret_b64: &str, server_nonce: &[u8], client_nonce: &[u8]) -> String {
    auth_tag(secret_b64, CLIENT_LABEL, server_nonce, client_nonce)
}

// ---- Control grants ---------------------------------------------------------
//
// The install secret and the pipe DACL admit the installing user's processes —
// all of them, not only the Mixdog app. Input injected by this SYSTEM helper
// is not subject to UIPI, so a same-user process that could drive the helper
// could click "Yes" on its own UAC prompt. The helper therefore authorizes new
// input and `sas` itself, with a grant only the paired phone can produce: a
// signature by the phone's enrolled P-256 key over a one-shot challenge the
// helper issued on this connection. The app relays challenges and grants but
// cannot forge them.

/// An enrolled controller key: the uncompressed P-256 point `0x04 ‖ X ‖ Y`
/// that Web Crypto's `exportKey('raw', …)` produces.
pub const CONTROLLER_KEY_BYTES: usize = 65;

/// A grant signature: ECDSA P-256 over SHA-256 in IEEE P1363 form (`r ‖ s`),
/// which is what Web Crypto's `sign({name: 'ECDSA', hash: 'SHA-256'}, …)`
/// returns and what CNG's `BCryptVerifySignature` takes.
pub const GRANT_SIGNATURE_BYTES: usize = 64;

/// Domain-separation prefix of the signed grant payload, so a signature made
/// for anything else can never verify as a grant.
pub const GRANT_CONTEXT: &[u8] = b"mixdog-secure-desktop-grant-v1";

/// How often the helper issues a fresh challenge while control is active: the
/// relay's liveness probe, `DESKTOP_LIVENESS_PROBE_MS` (2 s,
/// `apps/relay/lib/relay-legs.mjs`) — the time a silent leg gets to answer a
/// ping. Grants ride the path that carries the phone's input, so the phone
/// proves it is still signing at the rate the relay proves a leg is alive.
pub const GRANT_REFRESH: Duration = Duration::from_secs(2);

/// The relay's `DESKTOP_HANDSHAKE_STALL_MS` (4 s, same file): how long a leg
/// may miss a turn before it is probed.
const RELAY_HANDSHAKE_STALL: Duration = Duration::from_secs(4);

/// How long a grant stays live, measured on the helper's monotonic clock from
/// when the helper **issued** the challenge it answers — never from a phone
/// timestamp, so clock skew cannot stretch it and an app that sits on a signed
/// grant only burns its life. It is the relay's bound on a silent leg,
/// `DESKTOP_HANDSHAKE_STALL_MS` + `DESKTOP_LIVENESS_PROBE_MS` = 6 s: the
/// longest a missed turn is tolerated before the relay closes the leg. So a
/// grant outlives a missed refresh exactly as long as the path itself would
/// stay up, and stops authorizing input once the path would be dropped. It is
/// also the longest a same-user process could keep injecting after the phone
/// stops signing. `secure-desktop-grant.test.mjs` pins both values to the
/// relay constants.
pub const GRANT_LIFETIME: Duration =
    Duration::from_secs(RELAY_HANDSHAKE_STALL.as_secs() + GRANT_REFRESH.as_secs());

/// Base64 (standard alphabet, padded) of raw bytes — the wire form of nonces
/// and challenges.
pub fn encode_nonce(bytes: &[u8]) -> String {
    BASE64.encode(bytes)
}

/// A fresh random challenge of [`NONCE_BYTES`].
pub fn generate_challenge() -> Vec<u8> {
    let mut bytes = vec![0u8; NONCE_BYTES];
    rand::rng().fill_bytes(&mut bytes);
    bytes
}

/// Decode an enrolled controller key (base64url, unpadded), accepting only an
/// uncompressed 65-byte point.
pub fn decode_controller_key(encoded: &str) -> Option<[u8; CONTROLLER_KEY_BYTES]> {
    let bytes = URL_SAFE_NO_PAD.decode(encoded.trim()).ok()?;
    let key: [u8; CONTROLLER_KEY_BYTES] = bytes.try_into().ok()?;
    (key[0] == 0x04).then_some(key)
}

/// The exact bytes the phone signs:
/// `"mixdog-secure-desktop-grant-v1" ‖ 0x00 ‖ connectionNonce(16) ‖
/// challenge(16) ‖ epoch (u64 big-endian)`. Fixed-length fields keep it
/// unambiguous.
pub fn grant_payload(connection_nonce: &[u8], challenge: &[u8], epoch: u64) -> Vec<u8> {
    let mut payload = Vec::with_capacity(GRANT_CONTEXT.len() + 1 + 2 * NONCE_BYTES + 8);
    payload.extend_from_slice(GRANT_CONTEXT);
    payload.push(0);
    payload.extend_from_slice(connection_nonce);
    payload.extend_from_slice(challenge);
    payload.extend_from_slice(&epoch.to_be_bytes());
    payload
}

/// Why a grant was refused. Each maps to a stable `error` code for the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantRefusal {
    /// The challenge or signature is not well-formed base64 of the right size.
    Malformed,
    /// The challenge was never issued on this connection, or was already used
    /// (one shot: replays land here).
    UnknownChallenge,
    /// The challenge is older than [`GRANT_LIFETIME`].
    Expired,
    /// No video run has been declared yet.
    NoEpoch,
    /// Signed for a different video run than the current one.
    WrongEpoch,
    /// The signature does not verify under the enrolled key.
    BadSignature,
}

impl GrantRefusal {
    pub fn code(self) -> &'static str {
        match self {
            GrantRefusal::Malformed => "grant_malformed",
            GrantRefusal::UnknownChallenge => "grant_unknown_challenge",
            GrantRefusal::Expired => "grant_expired_challenge",
            GrantRefusal::NoEpoch => "grant_no_video_run",
            GrantRefusal::WrongEpoch => "grant_wrong_video_run",
            GrantRefusal::BadSignature => "grant_bad_signature",
        }
    }
}

struct OpenChallenge {
    bytes: Vec<u8>,
    issued: Instant,
}

/// One connection's grant state: its handshake nonce, the challenges it has
/// issued and not yet seen answered, when it last issued one, the current
/// video run, and until when the latest accepted grant keeps control live.
/// Pure; the clock is passed in.
pub struct GrantBook {
    connection_nonce: Vec<u8>,
    open: Vec<OpenChallenge>,
    /// When the latest challenge was issued: the refresh cadence runs from
    /// here, independent of which challenges are still open (an accepted
    /// grant consumes its challenge, and must not make the next one due).
    last_issued: Option<Instant>,
    epoch: Option<u64>,
    live_until: Option<Instant>,
}

impl GrantBook {
    pub fn new(connection_nonce: Vec<u8>) -> Self {
        GrantBook { connection_nonce, open: Vec::new(), last_issued: None, epoch: None, live_until: None }
    }

    pub fn connection_nonce(&self) -> &[u8] {
        &self.connection_nonce
    }

    /// Declare the current video run. A different run ends the live grant (it
    /// was signed for what the phone saw before) and makes a fresh challenge
    /// due at once, so control resumes after one round trip rather than at
    /// the next refresh — a run changes exactly when a secure-desktop prompt
    /// appears. Returns whether it changed.
    pub fn set_epoch(&mut self, epoch: u64) -> bool {
        if self.epoch == Some(epoch) {
            return false;
        }
        self.epoch = Some(epoch);
        self.live_until = None;
        self.restart_cadence();
        true
    }

    /// Whether a grant is live at `now`.
    pub fn live(&self, now: Instant) -> bool {
        self.live_until.is_some_and(|until| now < until)
    }

    /// End the live grant and forget every open challenge.
    pub fn revoke(&mut self) {
        self.open.clear();
        self.live_until = None;
    }

    fn prune(&mut self, now: Instant) {
        self.open.retain(|open| now.saturating_duration_since(open.issued) <= GRANT_LIFETIME);
    }

    /// Whether a fresh challenge is due: none was issued since control was
    /// activated or the video run changed
    /// ([`restart_cadence`](Self::restart_cadence)), or the last one
    /// was issued at least [`GRANT_REFRESH`] ago — whether or not it has been
    /// answered. Expired challenges are dropped, so at most
    /// `GRANT_LIFETIME / GRANT_REFRESH + 1` are ever open.
    pub fn needs_challenge(&mut self, now: Instant) -> bool {
        self.prune(now);
        self.last_issued
            .is_none_or(|last| now.saturating_duration_since(last) >= GRANT_REFRESH)
    }

    /// Record `challenge` as issued at `now`; the next is due
    /// [`GRANT_REFRESH`] later.
    pub fn issue(&mut self, now: Instant, challenge: Vec<u8>) {
        self.prune(now);
        self.open.push(OpenChallenge { bytes: challenge, issued: now });
        self.last_issued = Some(now);
    }

    /// Control was activated (or, via [`set_epoch`](Self::set_epoch), the
    /// video run changed): the next challenge is due at once. Nothing else
    /// restarts the cadence.
    pub fn restart_cadence(&mut self) {
        self.last_issued = None;
    }

    /// Check a grant. The named challenge is consumed by this attempt whatever
    /// its outcome, so each challenge yields at most one verification and a
    /// grant can never be replayed. `verify(payload, signature)` checks the
    /// signature against the enrolled key. On success the grant is live until
    /// its challenge's issue time plus [`GRANT_LIFETIME`].
    pub fn accept(
        &mut self,
        now: Instant,
        challenge_b64: &str,
        epoch: u64,
        signature_b64: &str,
        verify: impl FnOnce(&[u8], &[u8]) -> bool,
    ) -> Result<(), GrantRefusal> {
        let challenge = decode_nonce(challenge_b64).ok_or(GrantRefusal::Malformed)?;
        let index = self
            .open
            .iter()
            .position(|open| open.bytes == challenge)
            .ok_or(GrantRefusal::UnknownChallenge)?;
        let issued = self.open.remove(index).issued;
        if now.saturating_duration_since(issued) > GRANT_LIFETIME {
            return Err(GrantRefusal::Expired);
        }
        match self.epoch {
            None => return Err(GrantRefusal::NoEpoch),
            Some(current) if current != epoch => return Err(GrantRefusal::WrongEpoch),
            Some(_) => {}
        }
        let signature = BASE64
            .decode(signature_b64.trim())
            .ok()
            .filter(|bytes| bytes.len() == GRANT_SIGNATURE_BYTES)
            .ok_or(GrantRefusal::Malformed)?;
        if !verify(&grant_payload(&self.connection_nonce, &challenge, epoch), &signature) {
            return Err(GrantRefusal::BadSignature);
        }
        let until = issued + GRANT_LIFETIME;
        self.live_until = Some(self.live_until.map_or(until, |current| current.max(until)));
        Ok(())
    }
}

/// Verify an ECDSA P-256 / SHA-256 signature (`r ‖ s`) with CNG: the payload
/// is hashed with SHA-256 and `BCryptVerifySignature` checks the signature
/// over that hash (https://learn.microsoft.com/windows/win32/api/bcrypt/nf-bcrypt-bcryptverifysignature).
/// The key is imported as a `BCRYPT_ECCPUBLIC_BLOB` — a `BCRYPT_ECCKEY_BLOB`
/// header (`BCRYPT_ECDSA_PUBLIC_P256_MAGIC`, 32-byte coordinates) followed by
/// X and Y (https://learn.microsoft.com/windows/win32/api/bcrypt/ns-bcrypt-bcrypt_ecckey_blob)
/// — through the ECDSA P-256 algorithm pseudo-handle, available from
/// Windows 10 (https://learn.microsoft.com/windows/win32/seccng/cng-algorithm-pseudo-handles).
#[cfg(windows)]
pub fn ecdsa_p256_verify(public_key: &[u8; CONTROLLER_KEY_BYTES], message: &[u8], signature: &[u8]) -> bool {
    use sha2::{Digest, Sha256};
    use windows::Win32::Security::Cryptography::{
        BCryptDestroyKey, BCryptImportKeyPair, BCryptVerifySignature, BCRYPT_ECCPUBLIC_BLOB,
        BCRYPT_ECDSA_P256_ALG_HANDLE, BCRYPT_ECDSA_PUBLIC_P256_MAGIC, BCRYPT_FLAGS, BCRYPT_KEY_HANDLE,
    };
    if signature.len() != GRANT_SIGNATURE_BYTES || public_key[0] != 0x04 {
        return false;
    }
    let mut blob = Vec::with_capacity(8 + CONTROLLER_KEY_BYTES - 1);
    blob.extend_from_slice(&BCRYPT_ECDSA_PUBLIC_P256_MAGIC.to_le_bytes());
    blob.extend_from_slice(&32u32.to_le_bytes());
    blob.extend_from_slice(&public_key[1..]);
    let digest = Sha256::digest(message);
    unsafe {
        let mut key = BCRYPT_KEY_HANDLE(std::ptr::null_mut());
        if BCryptImportKeyPair(BCRYPT_ECDSA_P256_ALG_HANDLE, None, BCRYPT_ECCPUBLIC_BLOB, &mut key, &blob, 0)
            .is_err()
        {
            return false;
        }
        let status = BCryptVerifySignature(key, None, &digest, signature, BCRYPT_FLAGS(0));
        let _ = BCryptDestroyKey(key);
        status.is_ok()
    }
}

// ---- Software SAS policy -----------------------------------------------------

/// `HKLM\…\Policies\System` value that decides who may call `SendSAS`: 0 none,
/// 1 services, 2 Ease of Access (uiAccess) apps, 3 both — the "Disable or
/// enable software Secure Attention Sequence" policy that the `SendSAS` docs
/// name (https://learn.microsoft.com/windows/win32/api/sas/nf-sas-sendsas).
pub const SOFTWARE_SAS_POLICY_KEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System";
pub const SOFTWARE_SAS_POLICY_VALUE: &str = "SoftwareSASGeneration";
/// The value that lets services simulate the SAS.
pub const SOFTWARE_SAS_SERVICES: u32 = 1;

/// What the service may do about the software-SAS policy before `SendSAS`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SasPolicy {
    /// Services are already allowed (1 or 3): send as is.
    Allowed,
    /// Nobody set the policy: set it to services-only for the one call and
    /// delete it afterwards, leaving the machine as it was.
    EnableTemporarily,
    /// An administrator set it to exclude services (0, 2, or a value this
    /// build does not know): never overridden; reported as
    /// `sas_disabled_by_policy`.
    DisabledByPolicy,
}

/// Decide from the current `SoftwareSASGeneration` value (`None` = absent).
pub fn sas_policy(software_sas_generation: Option<u32>) -> SasPolicy {
    match software_sas_generation {
        None => SasPolicy::EnableTemporarily,
        Some(1) | Some(3) => SasPolicy::Allowed,
        Some(_) => SasPolicy::DisabledByPolicy,
    }
}

/// Schema of the [`SasPolicyMarker`] file.
const SAS_MARKER_SCHEMA: u32 = 1;

/// The service's record that **it created** `SoftwareSASGeneration`, and with
/// which value. Written durably *before* the value is set, so no crash can
/// leave a value of ours that no marker names; resolved (and removed) right
/// after the SAS, and at the next service start if the service died first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SasPolicyMarker {
    pub schema: u32,
    /// The registry key and value the marker is about.
    pub key: String,
    pub value: String,
    /// The DWORD the service wrote.
    pub wrote: u32,
}

impl SasPolicyMarker {
    pub fn new(wrote: u32) -> Self {
        SasPolicyMarker {
            schema: SAS_MARKER_SCHEMA,
            key: SOFTWARE_SAS_POLICY_KEY.into(),
            value: SOFTWARE_SAS_POLICY_VALUE.into(),
            wrote,
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("the SAS marker always serializes")
    }

    /// The value the service wrote, if `text` is a marker of ours (this
    /// schema, this key and value); `None` for anything else — including a
    /// marker torn by a crash while it was being written, which, written
    /// before the value, proves the value was never set.
    pub fn ours(text: &str) -> Option<u32> {
        let marker: SasPolicyMarker = serde_json::from_str(text).ok()?;
        (marker.schema == SAS_MARKER_SCHEMA
            && marker.key == SOFTWARE_SAS_POLICY_KEY
            && marker.value == SOFTWARE_SAS_POLICY_VALUE)
            .then_some(marker.wrote)
    }
}

/// The registry value and the service's marker, abstracted so the ownership
/// rules are tested against a fake registry.
pub trait SasPolicyStore {
    /// The current `SoftwareSASGeneration`; `None` when absent.
    fn value(&mut self) -> Result<Option<u32>, String>;
    fn set_value(&mut self, data: u32) -> Result<(), String>;
    fn delete_value(&mut self) -> Result<(), String>;
    /// The marker's text; `None` when there is none.
    fn marker(&mut self) -> Result<Option<String>, String>;
    /// Write the marker durably: it must be on disk before the value is set.
    fn write_marker(&mut self, text: &str) -> Result<(), String>;
    fn clear_marker(&mut self) -> Result<(), String>;
}

/// How a marker was resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SasCleanup {
    /// No marker: nothing of ours to undo.
    Nothing,
    /// The value still held what we wrote: removed.
    Removed,
    /// The value no longer holds what we wrote — an administrator changed or
    /// removed it (current value attached): left as it is.
    LeftAlone(Option<u32>),
    /// The marker is not ours (torn or foreign): the registry is untouched.
    UnrecognizedMarker,
}

/// Resolve the marker, if any: delete the value **only** if the marker is
/// ours and the value still equals what it records; then clear the marker.
/// A failed deletion keeps the marker, so the next attempt (next SAS, next
/// service start) retries.
pub fn restore_software_sas(store: &mut impl SasPolicyStore) -> Result<SasCleanup, String> {
    let Some(text) = store.marker()? else {
        return Ok(SasCleanup::Nothing);
    };
    let outcome = match SasPolicyMarker::ours(&text) {
        None => SasCleanup::UnrecognizedMarker,
        Some(wrote) => match store.value()? {
            Some(current) if current == wrote => {
                store.delete_value()?;
                SasCleanup::Removed
            }
            other => SasCleanup::LeftAlone(other),
        },
    };
    store.clear_marker()?;
    Ok(outcome)
}

/// How a SAS was sent by [`send_sas_under_policy`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SasSent {
    /// Services were already allowed: the policy was not touched.
    AsConfigured,
    /// Sent under a value the service created; how it was cleaned up.
    Temporarily(Result<SasCleanup, String>),
}

/// Send a SAS (`send`) under the software-SAS policy, owning any change:
///
/// 1. A marker an earlier attempt left is resolved first, so the decision
///    reads the administrator's value, not a leftover of ours.
/// 2. Services allowed (1 or 3): send, touching nothing. Excluded (0, 2, or
///    unknown): refuse (`sas_disabled_by_policy`), touching nothing.
/// 3. Absent: record the marker, then set services-only, send, and resolve
///    the marker ([`restore_software_sas`]) — removing the value only if it
///    still holds ours. A value that existed before is never written or
///    removed.
pub fn send_sas_under_policy(
    store: &mut impl SasPolicyStore,
    send: impl FnOnce() -> Result<(), String>,
) -> Result<SasSent, String> {
    restore_software_sas(store)?;
    match sas_policy(store.value()?) {
        SasPolicy::DisabledByPolicy => {
            Err("sas_disabled_by_policy: SoftwareSASGeneration excludes services; left as set".into())
        }
        SasPolicy::Allowed => send().map(|()| SasSent::AsConfigured),
        SasPolicy::EnableTemporarily => {
            store.write_marker(&SasPolicyMarker::new(SOFTWARE_SAS_SERVICES).to_json())?;
            let sent = store.set_value(SOFTWARE_SAS_SERVICES).and_then(|()| send());
            let cleanup = restore_software_sas(store);
            match (sent, cleanup) {
                (Ok(()), cleanup) => Ok(SasSent::Temporarily(cleanup)),
                (Err(error), Ok(_)) => Err(error),
                (Err(error), Err(cleanup)) => {
                    Err(format!("{error}; removing the temporary value failed: {cleanup} (marker kept)"))
                }
            }
        }
    }
}

/// Reject anything that is not a plain SID string. The SID is interpolated into
/// an SDDL string, so a non-SID value (spaces, parentheses, semicolons) must
/// never reach [`pipe_sddl`] or [`state_file_sddl`].
pub fn is_sid_literal(sid: &str) -> bool {
    let mut parts = sid.split('-');
    parts.next() == Some("S")
        && parts.next() == Some("1")
        && {
            let rest: Vec<&str> = parts.collect();
            !rest.is_empty()
                && rest.len() <= 16
                && rest
                    .iter()
                    .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
        }
}

/// `FILE_GENERIC_READ | FILE_GENERIC_EXECUTE` as a hex access mask: the only
/// rights the installing user is granted on the install directory and the
/// copied binary. Read + execute, never write/delete/change-permissions, so the
/// user who opted in cannot replace the SYSTEM-launched binary (the P1 finding).
pub const USER_READ_EXECUTE: &str = "0x1200a9";

/// SDDL for the app-facing named pipe. SYSTEM and Administrators get full
/// control (the helper runs as SYSTEM); the installing user gets read+write
/// (connect, read frames, send input). `P` blocks inherited ACEs; no `A` entry
/// for anyone else denies every other principal — including other standard
/// users on the box — by the absence of a grant. The `S:` mandatory-label ACE
/// pins the object at Medium integrity with no-write/read/execute-up, so a
/// low-integrity or AppContainer client (e.g. a sandboxed renderer) is denied
/// access outright, before the secret is ever evaluated.
pub fn pipe_sddl(user_sid: &str) -> Option<String> {
    is_sid_literal(user_sid).then(|| {
        format!("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;{user_sid})S:(ML;;NWNRNX;;;ME)")
    })
}

/// SDDL for the service <-> helper shutdown events: SYSTEM only, protected.
/// Both ends run as SYSTEM; no user process may signal (forge a stop) or wait
/// on (spoof an acknowledgement for) them.
pub const SHUTDOWN_EVENT_SDDL: &str = "D:P(A;;GA;;;SY)";

/// Length in hex characters of the per-launch shutdown-channel token.
pub const SHUTDOWN_TOKEN_HEX: usize = 2 * NONCE_BYTES;

/// A fresh, unguessable per-launch token naming one helper's shutdown events.
/// Unguessable names mean nothing can pre-create (squat) them, and the service
/// additionally refuses an event that already exists.
pub fn generate_shutdown_token() -> String {
    let mut bytes = [0u8; NONCE_BYTES];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Whether `token` is a well-formed shutdown token (lowercase hex, exact
/// length) — the helper validates its command-line argument with this before
/// building object names from it.
pub fn is_shutdown_token(token: &str) -> bool {
    token.len() == SHUTDOWN_TOKEN_HEX
        && token.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// SDDL for the state file: SYSTEM and Administrators full, installing user
/// read-only, nobody else. The file holds public material (enrolled phones'
/// public keys, delegation policy, SID, versions) **and** the pipe secret; the
/// secret is shared by design with the installing user's app, which must read
/// it for the pipe's mutual HMAC handshake, so that user keeps read access and
/// every other principal is excluded. The user never writes it.
pub fn state_file_sddl(user_sid: &str) -> Option<String> {
    is_sid_literal(user_sid)
        .then(|| format!("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;{user_sid})"))
}

/// SDDL for the install directory (`%ProgramData%\Mixdog\SecureDesktop`), used
/// as the security descriptor the directory is *created* with so it is
/// protected atomically, before the secret is ever written. Owner
/// Administrators, primary group SYSTEM, a protected (`P`) DACL that grants
/// SYSTEM and Administrators full control and the installing user only
/// read+execute, inherited (`OICI`) by the binary and state file beneath it.
/// `P` strips every inherited ACE, so no user-writable ACE can leak in from
/// `%ProgramData%`.
pub fn state_dir_sddl(user_sid: &str) -> Option<String> {
    is_sid_literal(user_sid).then(|| {
        format!(
            "O:BAG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;{USER_READ_EXECUTE};;;{user_sid})"
        )
    })
}

/// SDDL for the copied service binary: owner Administrators, SYSTEM and
/// Administrators full, installing user read+execute only. Protected so no
/// inherited user-write ACE applies; this is what stops the user who installed
/// from overwriting the file the service runs as SYSTEM.
pub fn binary_sddl(user_sid: &str) -> Option<String> {
    is_sid_literal(user_sid).then(|| {
        format!("O:BAG:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;{USER_READ_EXECUTE};;;{user_sid})")
    })
}

/// The well-known SID of `NT AUTHORITY\SYSTEM`.
pub const SYSTEM_SID: &str = "S-1-5-18";

/// SIDs allowed to own or hold modify rights on the install path and its
/// ancestors: SYSTEM, the Administrators group, CREATOR OWNER (resolves to the
/// Administrators owner we set), and TrustedInstaller. Any other principal with
/// a path-modifying grant means the path is attacker-controllable.
pub const TRUSTED_PATH_SIDS: [&str; 4] = [
    SYSTEM_SID,
    "S-1-5-32-544",
    "S-1-3-0",
    "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
];

/// `true` for `NT AUTHORITY\SYSTEM`. Used by the client to confirm the pipe
/// server it connected to is the SYSTEM helper, not a same-name squatter.
pub fn is_system_sid(sid: &str) -> bool {
    sid.eq_ignore_ascii_case(SYSTEM_SID)
}

/// `true` if `sid` may own or modify a trusted install path.
pub fn is_trusted_path_sid(sid: &str) -> bool {
    TRUSTED_PATH_SIDS
        .iter()
        .any(|trusted| sid.eq_ignore_ascii_case(trusted))
}

/// Whether a path element is a file or a directory. The raw access bits `0x02`
/// and `0x04` mean *write / append file content* on a file but *create child
/// file / subdirectory* on a directory, so the two kinds need different
/// "modify" masks — conflating them (the P1 finding) let an admin-owned exe
/// that ordinary users could overwrite pass the check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathKind {
    File,
    Directory,
}

/// Bits that let a principal replace, redirect, or re-permission a **directory**
/// element: `DELETE`, `FILE_DELETE_CHILD`, `WRITE_DAC`, `WRITE_OWNER`,
/// `GENERIC_WRITE`, `GENERIC_ALL`. The create-child bits (`FILE_ADD_FILE` =
/// `0x02`, `FILE_ADD_SUBDIRECTORY` = `0x04`) are excluded on purpose: standard
/// Windows roots (`C:\`, `%ProgramData%`) grant users "create" there by
/// default, and creating a sibling cannot overwrite or redirect our
/// already-created, protected elements, so flagging them would be a false
/// positive.
pub const PATH_MODIFY_MASK_DIR: u32 = 0x0001_0000 // DELETE
    | 0x0000_0040 // FILE_DELETE_CHILD
    | 0x0004_0000 // WRITE_DAC
    | 0x0008_0000 // WRITE_OWNER
    | 0x4000_0000 // GENERIC_WRITE
    | 0x1000_0000; // GENERIC_ALL

/// Bits that let a principal modify a **file** element — i.e. overwrite the
/// SYSTEM-launched binary. Unlike the directory mask this **includes**
/// `FILE_WRITE_DATA` (`0x02`) and `FILE_APPEND_DATA` (`0x04`), which on a file
/// are the content-write rights: an admin-owned exe that ordinary users can
/// write must be rejected. `FILE_DELETE_CHILD` is meaningless on a file and
/// omitted.
pub const PATH_MODIFY_MASK_FILE: u32 = 0x0001_0000 // DELETE
    | 0x0000_0002 // FILE_WRITE_DATA
    | 0x0000_0004 // FILE_APPEND_DATA
    | 0x0004_0000 // WRITE_DAC
    | 0x0008_0000 // WRITE_OWNER
    | 0x4000_0000 // GENERIC_WRITE
    | 0x1000_0000; // GENERIC_ALL

/// `true` if an allow-ACE with this mask would let its holder modify a path
/// element of the given kind.
pub fn mask_can_modify_path(mask: u32, kind: PathKind) -> bool {
    let modify = match kind {
        PathKind::File => PATH_MODIFY_MASK_FILE,
        PathKind::Directory => PATH_MODIFY_MASK_DIR,
    };
    mask & modify != 0
}

/// Classification of a DACL ACE by its header `AceType`, for trusted-path
/// verification.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AceClass {
    /// A plain `ACCESS_ALLOWED` ACE: a mask followed by a single SID, which the
    /// verifier can read and check.
    Allow,
    /// A deny-family ACE: it only removes access, so it is safe to skip.
    Deny,
    /// Any other grant (object / callback allow ACEs) or an unknown type. Its
    /// in-memory layout differs from a plain allow ACE — an object ACE carries
    /// flags and a GUID before the SID — so the SID cannot be read at the plain
    /// offset. The verifier must **fail closed** rather than silently ignore a
    /// possible untrusted grant.
    Unsupported,
}

/// Classify a DACL ACE header type. Deny-family types are skipped; only the
/// plain allow type is parsed; every other (including object/callback *allow*)
/// type fails closed.
pub fn classify_ace_type(ace_type: u8) -> AceClass {
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0x00;
    const ACCESS_DENIED_ACE_TYPE: u8 = 0x01;
    const ACCESS_DENIED_OBJECT_ACE_TYPE: u8 = 0x06;
    const ACCESS_DENIED_CALLBACK_ACE_TYPE: u8 = 0x0A;
    const ACCESS_DENIED_CALLBACK_OBJECT_ACE_TYPE: u8 = 0x0C;
    match ace_type {
        ACCESS_ALLOWED_ACE_TYPE => AceClass::Allow,
        ACCESS_DENIED_ACE_TYPE
        | ACCESS_DENIED_OBJECT_ACE_TYPE
        | ACCESS_DENIED_CALLBACK_ACE_TYPE
        | ACCESS_DENIED_CALLBACK_OBJECT_ACE_TYPE => AceClass::Deny,
        _ => AceClass::Unsupported,
    }
}

/// SDDL for the Windows service object. SYSTEM and Administrators get full
/// control; Authenticated Users keep the default read set; the installing user
/// is additionally granted start/stop/query so the app can control the service
/// after the single install-time UAC prompt without prompting again. Service
/// access letters: RP=start, WP=stop, LC=query-status, CC=query-config,
/// SW=enumerate-dependents, LO=interrogate, CR=user-defined-control,
/// RC=read-control, DT=pause/continue.
pub fn service_sddl(user_sid: &str) -> Option<String> {
    is_sid_literal(user_sid).then(|| {
        format!(
            "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)\
             (A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)\
             (A;;CCLCSWLOCRRC;;;AU)\
             (A;;RPWPLCRC;;;{user_sid})"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_secrets_are_32_bytes_and_unique() {
        let a = generate_secret();
        let b = generate_secret();
        assert_ne!(a, b);
        assert_eq!(BASE64.decode(a).unwrap().len(), SECRET_BYTES);
    }

    #[test]
    fn secret_comparison_is_exact() {
        let secret = generate_secret();
        assert!(secret_matches(&secret, &secret.clone()));
        assert!(!secret_matches(&secret, &generate_secret()));
        assert!(!secret_matches("abc", "abcd"));
        assert!(!secret_matches("abc", "abd"));
        assert!(secret_matches("", ""));
    }

    #[test]
    fn only_plain_sids_are_accepted() {
        for good in [
            "S-1-5-18",
            "S-1-5-32-544",
            "S-1-5-21-1004336348-1177238915-682003330-512",
        ] {
            assert!(is_sid_literal(good), "expected {good:?} to be a SID");
        }
        for bad in [
            "",
            "S-1",
            "X-1-5-18",
            "S-2-5-18",
            "S-1-5-",
            "S-1-5-18 )(A;;GA;;;WD",
            "S-1-5-abc",
            "S-1-5-18;",
        ] {
            assert!(!is_sid_literal(bad), "expected {bad:?} to be rejected");
        }
    }

    #[test]
    fn sddl_embeds_only_validated_sids() {
        let sid = "S-1-5-21-1-2-3-1001";
        assert_eq!(
            pipe_sddl(sid).unwrap(),
            "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;S-1-5-21-1-2-3-1001)S:(ML;;NWNRNX;;;ME)"
        );
        assert_eq!(
            state_file_sddl(sid).unwrap(),
            "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;S-1-5-21-1-2-3-1001)"
        );
        // A malformed SID yields no SDDL rather than an injectable string.
        assert!(pipe_sddl("S-1-5-18)(A;;GA;;;WD").is_none());
        assert!(state_file_sddl("not-a-sid").is_none());
        assert!(service_sddl("bad").is_none());
        let service = service_sddl(sid).unwrap();
        assert!(service.ends_with("(A;;RPWPLCRC;;;S-1-5-21-1-2-3-1001)"));
        assert!(service.contains("(A;;CCLCSWRPWPDTLOCRRC;;;SY)"));
    }

    #[test]
    fn install_path_sddls_lock_out_user_writes_and_label_the_pipe() {
        let sid = "S-1-5-21-1-2-3-1001";
        // The directory is owned by Administrators, protected, and the user is
        // granted only read+execute (never write/delete).
        let dir = state_dir_sddl(sid).unwrap();
        assert!(dir.starts_with("O:BAG:SYD:P("));
        assert!(dir.contains(&format!("(A;OICI;{USER_READ_EXECUTE};;;{sid})")));
        assert!(!dir.contains("FA;;;S-1-5-21")); // user never gets full access
        // Same posture on the copied binary.
        let bin = binary_sddl(sid).unwrap();
        assert!(bin.starts_with("O:BAG:SYD:P("));
        assert!(bin.ends_with(&format!("(A;;{USER_READ_EXECUTE};;;{sid})")));
        // The pipe carries a Medium mandatory label that blocks low-IL clients.
        assert!(pipe_sddl(sid).unwrap().ends_with("S:(ML;;NWNRNX;;;ME)"));
        // Malformed SIDs still yield nothing for the new builders.
        assert!(state_dir_sddl("nope").is_none());
        assert!(binary_sddl("S-1-5-18)(x").is_none());
    }

    #[test]
    fn trusted_path_and_system_predicates() {
        assert!(is_system_sid("S-1-5-18"));
        assert!(is_system_sid("s-1-5-18"));
        assert!(!is_system_sid("S-1-5-32-544"));

        assert!(is_trusted_path_sid("S-1-5-18"));
        assert!(is_trusted_path_sid("S-1-5-32-544"));
        assert!(is_trusted_path_sid("S-1-3-0"));
        assert!(!is_trusted_path_sid("S-1-5-21-1-2-3-1001")); // a normal user
        assert!(!is_trusted_path_sid("S-1-1-0")); // Everyone

        // On a DIRECTORY, create-file/create-subdir are benign (the user may
        // create siblings under %ProgramData% without touching our element);
        // delete/write-dac/own/generic-write are not.
        assert!(!mask_can_modify_path(0x0000_0002, PathKind::Directory)); // FILE_ADD_FILE
        assert!(!mask_can_modify_path(0x0000_0004, PathKind::Directory)); // FILE_ADD_SUBDIRECTORY
        assert!(mask_can_modify_path(0x0001_0000, PathKind::Directory)); // DELETE
        assert!(mask_can_modify_path(0x0000_0040, PathKind::Directory)); // FILE_DELETE_CHILD
        assert!(mask_can_modify_path(0x0004_0000, PathKind::Directory)); // WRITE_DAC
        assert!(mask_can_modify_path(0x1000_0000, PathKind::Directory)); // GENERIC_ALL
        assert!(mask_can_modify_path(0x4000_0000, PathKind::Directory)); // GENERIC_WRITE

        // On a FILE, the SAME bits 0x02/0x04 are FILE_WRITE_DATA /
        // FILE_APPEND_DATA — content modification, so they MUST be rejected.
        // This is the P1 fix: an admin-owned exe writable by users must fail.
        assert!(mask_can_modify_path(0x0000_0002, PathKind::File)); // FILE_WRITE_DATA
        assert!(mask_can_modify_path(0x0000_0004, PathKind::File)); // FILE_APPEND_DATA
        assert!(mask_can_modify_path(0x0001_0000, PathKind::File)); // DELETE
        assert!(mask_can_modify_path(0x0004_0000, PathKind::File)); // WRITE_DAC
        assert!(mask_can_modify_path(0x4000_0000, PathKind::File)); // GENERIC_WRITE
        assert!(mask_can_modify_path(0x1000_0000, PathKind::File)); // GENERIC_ALL
        // FILE_DELETE_CHILD is meaningless on a file and not treated as modify.
        assert!(!mask_can_modify_path(0x0000_0040, PathKind::File));
        // Pure read/execute never counts as modify for either kind.
        assert!(!mask_can_modify_path(0x0012_00a9, PathKind::File)); // FILE_GENERIC_READ|EXECUTE
        assert!(!mask_can_modify_path(0x0012_00a9, PathKind::Directory));
    }

    #[test]
    fn ace_types_classify_allow_deny_and_fail_closed() {
        // Plain allow is parsed; deny-family is skipped.
        assert_eq!(classify_ace_type(0x00), AceClass::Allow);
        assert_eq!(classify_ace_type(0x01), AceClass::Deny); // ACCESS_DENIED
        assert_eq!(classify_ace_type(0x06), AceClass::Deny); // ACCESS_DENIED_OBJECT
        assert_eq!(classify_ace_type(0x0A), AceClass::Deny); // DENIED_CALLBACK
        assert_eq!(classify_ace_type(0x0C), AceClass::Deny); // DENIED_CALLBACK_OBJECT
        // Object/callback ALLOW aces and unknown types fail closed: the SID is
        // not at the plain offset, so they must not be silently ignored.
        assert_eq!(classify_ace_type(0x05), AceClass::Unsupported); // ALLOWED_OBJECT
        assert_eq!(classify_ace_type(0x09), AceClass::Unsupported); // ALLOWED_CALLBACK
        assert_eq!(classify_ace_type(0x0B), AceClass::Unsupported); // ALLOWED_CALLBACK_OBJECT
        assert_eq!(classify_ace_type(0x11), AceClass::Unsupported); // SYSTEM_AUDIT etc.
    }

    #[test]
    fn challenge_response_tags_match_only_with_the_shared_secret() {
        let secret = generate_secret();
        let client_nonce = decode_nonce(&generate_nonce()).unwrap();
        let server_nonce = decode_nonce(&generate_nonce()).unwrap();

        // Both parties holding the same secret and nonces agree on each tag.
        let server_tag = server_auth_tag(&secret, &client_nonce, &server_nonce);
        assert!(secret_matches(
            &server_tag,
            &server_auth_tag(&secret, &client_nonce, &server_nonce)
        ));
        let client_tag = client_auth_tag(&secret, &server_nonce, &client_nonce);
        assert!(secret_matches(
            &client_tag,
            &client_auth_tag(&secret, &server_nonce, &client_nonce)
        ));

        // The server's tag and the client's tag are not interchangeable: a
        // captured server tag cannot be replayed as the client's reply.
        assert!(!secret_matches(&server_tag, &client_tag));

        // A party without the real secret computes a different (useless) tag.
        let wrong = generate_secret();
        assert!(!secret_matches(
            &server_tag,
            &server_auth_tag(&wrong, &client_nonce, &server_nonce)
        ));
        assert!(!secret_matches(
            &client_tag,
            &client_auth_tag(&wrong, &server_nonce, &client_nonce)
        ));

        // Changing either nonce changes the tag (no fixed-nonce replay).
        let other_nonce = decode_nonce(&generate_nonce()).unwrap();
        assert!(!secret_matches(
            &server_tag,
            &server_auth_tag(&secret, &client_nonce, &other_nonce)
        ));
    }

    #[test]
    fn shutdown_tokens_are_fresh_hex_and_validated_strictly() {
        let a = generate_shutdown_token();
        let b = generate_shutdown_token();
        assert!(is_shutdown_token(&a) && is_shutdown_token(&b));
        assert_ne!(a, b);
        assert!(!is_shutdown_token(""));
        assert!(!is_shutdown_token(&a[1..]));
        assert!(!is_shutdown_token(&a.to_uppercase().replace(|c: char| c.is_ascii_digit(), "A")));
        assert!(!is_shutdown_token(&format!("{}\\", &a[1..])), "no path separators");
        let (stop, ack) = crate::paths::shutdown_event_names(&a);
        assert!(stop.starts_with(r"Global\") && ack.starts_with(r"Global\"));
        assert_ne!(stop, ack);
        assert!(stop.ends_with(&a) && ack.ends_with(&a));
    }

    /// Known-answer vector computed independently (Python `hmac`), shared with
    /// the TypeScript client test so both sides provably agree on the wire.
    #[test]
    fn auth_tags_match_the_shared_known_answer_vector() {
        let key_bytes: Vec<u8> = (0u8..32).collect();
        let key_b64 = BASE64.encode(&key_bytes);
        let secret = key_b64.as_str();
        let client_nonce = [0xAAu8; NONCE_BYTES];
        let server_nonce = [0xBBu8; NONCE_BYTES];
        assert_eq!(
            server_auth_tag(secret, &client_nonce, &server_nonce),
            "dEuYYaY1byiY4cjlZ7augOQsK58KQpWFOJEHJbvkvPI="
        );
        assert_eq!(
            client_auth_tag(secret, &server_nonce, &client_nonce),
            "u6+CvqeI2faMMsAAXKRZ0rlEFHvLJi8d+7lKZq13vYQ="
        );
    }

    #[test]
    fn nonces_decode_only_at_the_exact_length() {
        let good = generate_nonce();
        assert_eq!(decode_nonce(&good).unwrap().len(), NONCE_BYTES);
        assert!(decode_nonce("").is_none());
        assert!(decode_nonce("not-base64!!").is_none());
        // A valid base64 of the wrong length is rejected.
        assert!(decode_nonce(&BASE64.encode([0u8; NONCE_BYTES + 1])).is_none());
    }

    #[test]
    fn install_state_round_trips_and_validates() {
        let state = InstallState::new("0.1.0", "S-1-5-21-1-2-3-1001", crate::paths::PIPE_NAME, 123);
        let json = state.to_json();
        let parsed = InstallState::from_json(&json).expect("round trip");
        assert_eq!(parsed, state);
        assert!(InstallState::from_json("{}").is_err());
    }

    /// A valid controller key made distinct by `fill` (two leading body bytes),
    /// so more than 256 distinct keys can be generated for the cap test.
    fn a_key(fill: u16) -> String {
        let mut body = [7u8; 64];
        body[0] = (fill >> 8) as u8;
        body[1] = fill as u8;
        URL_SAFE_NO_PAD.encode([&[4u8][..], &body[..]].concat())
    }

    #[test]
    fn install_state_enrolls_only_valid_controller_keys() {
        let key = a_key(7);
        let state = InstallState::new("0.1.0", "S-1-5-18", crate::paths::PIPE_NAME, 0)
            .with_controller_keys(std::slice::from_ref(&key))
            .unwrap();
        let parsed = InstallState::from_json(&state.to_json()).unwrap();
        assert_eq!(parsed.controller_keys_bytes()[0][0], 4);
        assert!(parsed.is_key_enrolled(&key));
        // A state without a key still parses (the helper then refuses control),
        // and no key field is written at all.
        let bare = InstallState::new("0.1.0", "S-1-5-18", crate::paths::PIPE_NAME, 0);
        assert!(!bare.to_json().contains("controllerKey"));
        assert!(InstallState::from_json(&bare.to_json()).unwrap().controller_keys_bytes().is_empty());
        // Compressed points, wrong lengths and non-base64url are refused.
        let compressed = URL_SAFE_NO_PAD.encode([&[2u8][..], &[7u8; 64][..]].concat());
        for bad in [compressed.as_str(), "AAAA", "not base64!"] {
            assert!(InstallState::new("0.1.0", "S-1-5-18", "p", 0)
                .with_controller_keys(&[bad.to_string()])
                .is_err());
            let mut forged = bare.clone();
            forged.controller_keys = vec![bad.to_string()];
            assert!(InstallState::from_json(&forged.to_json()).is_err());
        }
    }

    #[test]
    fn a_legacy_single_key_state_is_read_as_a_one_key_set() {
        // Installs before the key set wrote `controllerKey`; it must still read.
        let legacy = format!(
            r#"{{"schema":1,"productVersion":"0.1.0","userSid":"S-1-5-18","secret":"{}","pipeName":"p","installedAtMs":0,"controllerKey":"{}"}}"#,
            generate_secret(),
            a_key(5),
        );
        let parsed = InstallState::from_json(&legacy).unwrap();
        assert!(parsed.is_key_enrolled(&a_key(5)));
        // Re-serializing drops the legacy field for the new plural one.
        let round = parsed.to_json();
        assert!(!round.contains("\"controllerKey\""));
        assert!(round.contains("controllerKeys"));
    }

    #[test]
    fn enroll_is_idempotent_adds_others_and_revoke_removes_only_its_own() {
        let mut state = InstallState::new("0.1.0", "S-1-5-18", "p", 0);
        assert_eq!(state.enroll_key(&a_key(1)), Ok(true));
        assert_eq!(state.enroll_key(&a_key(1)), Ok(false), "already enrolled");
        assert_eq!(state.enroll_key(&a_key(2)), Ok(true));
        assert_eq!(state.controller_keys_bytes().len(), 2);
        assert!(state.revoke_key(&a_key(1)));
        assert!(!state.revoke_key(&a_key(1)), "already gone");
        assert!(state.is_key_enrolled(&a_key(2)) && !state.is_key_enrolled(&a_key(1)));
    }

    #[test]
    fn delegation_is_off_until_an_elevated_opt_in_records_the_app_signer() {
        let mut state = InstallState::new("0.1.0", "S-1-5-18", "p", 0);
        // Fresh install: delegation is off and serializes to nothing (the
        // on-disk shape of a never-delegated install is unchanged).
        assert!(state.delegation.is_default());
        assert_eq!(state.delegation.authorized_signer(), None);
        assert!(!state.to_json().contains("delegation"));
        // The elevated opt-in records the authorized app signer.
        state.enable_delegation("CN=TRIBGAMES", "1.3.6.1.4.1.311.97.1.2.3");
        assert_eq!(state.delegation.authorized_signer(), Some(("CN=TRIBGAMES", "1.3.6.1.4.1.311.97.1.2.3")));
        let round = InstallState::from_json(&state.to_json()).unwrap();
        assert_eq!(round.delegation, state.delegation, "the policy round-trips");
        // A security disable stops honoring delegated requests at once, but
        // keeps the recorded identity for audit; re-enabling needs elevation.
        state.disable_delegation();
        assert_eq!(state.delegation.authorized_signer(), None, "no delegated request is honored");
        assert_eq!(state.delegation.app_subject.as_deref(), Some("CN=TRIBGAMES"), "identity kept for audit");
    }

    #[test]
    fn an_install_made_before_delegation_reads_as_disabled() {
        let legacy = format!(
            r#"{{"schema":1,"productVersion":"0.1.0","userSid":"S-1-5-18","secret":"{}","pipeName":"p","installedAtMs":0}}"#,
            generate_secret(),
        );
        let parsed = InstallState::from_json(&legacy).unwrap();
        assert!(parsed.delegation.is_default() && parsed.delegation.authorized_signer().is_none());
    }

    #[test]
    fn the_key_set_is_capped_at_the_relay_pairing_limit() {
        let mut state = InstallState::new("0.1.0", "S-1-5-18", "p", 0);
        for fill in 0..MAX_CONTROLLER_KEYS as u16 {
            state.controller_keys.push(a_key(fill));
        }
        assert_eq!(state.controller_keys.len(), MAX_CONTROLLER_KEYS);
        assert!(state.enroll_key(&a_key(MAX_CONTROLLER_KEYS as u16)).is_err(), "the cap is enforced");
    }

    // ---- control grants (pure) ----

    const NONCE: [u8; NONCE_BYTES] = [0x11; NONCE_BYTES];

    /// A book with `epoch` declared and one challenge issued at `at`.
    fn book_with_challenge(epoch: u64, at: Instant) -> (GrantBook, String) {
        let mut book = GrantBook::new(NONCE.to_vec());
        book.set_epoch(epoch);
        let challenge = generate_challenge();
        book.issue(at, challenge.clone());
        (book, encode_nonce(&challenge))
    }

    fn signature() -> String {
        BASE64.encode([9u8; GRANT_SIGNATURE_BYTES])
    }

    #[test]
    fn a_grant_for_an_open_challenge_and_the_current_run_goes_live_for_its_lifetime() {
        let t0 = Instant::now();
        let (mut book, challenge) = book_with_challenge(4, t0);
        let mut signed = Vec::new();
        let at = t0 + Duration::from_millis(300);
        let result = book.accept(at, &challenge, 4, &signature(), |payload, _| {
            signed = payload.to_vec();
            true
        });
        assert_eq!(result, Ok(()));
        assert_eq!(signed, grant_payload(&NONCE, &decode_nonce(&challenge).unwrap(), 4));
        // Live from the challenge's issue time, not from receipt.
        assert!(book.live(t0 + GRANT_LIFETIME - Duration::from_millis(1)));
        assert!(!book.live(t0 + GRANT_LIFETIME));
    }

    #[test]
    fn a_bad_signature_is_refused_and_consumes_the_challenge() {
        let t0 = Instant::now();
        let (mut book, challenge) = book_with_challenge(1, t0);
        assert_eq!(book.accept(t0, &challenge, 1, &signature(), |_, _| false), Err(GrantRefusal::BadSignature));
        assert!(!book.live(t0));
        // The same challenge cannot be tried again, even with a good signature.
        assert_eq!(
            book.accept(t0, &challenge, 1, &signature(), |_, _| true),
            Err(GrantRefusal::UnknownChallenge)
        );
    }

    #[test]
    fn an_expired_challenge_is_refused() {
        let t0 = Instant::now();
        let (mut book, challenge) = book_with_challenge(1, t0);
        let late = t0 + GRANT_LIFETIME + Duration::from_millis(1);
        assert_eq!(book.accept(late, &challenge, 1, &signature(), |_, _| true), Err(GrantRefusal::Expired));
        assert!(!book.live(late));
        // At exactly the lifetime it is still accepted (and lapses at once).
        let (mut edge, challenge) = book_with_challenge(1, t0);
        assert_eq!(edge.accept(t0 + GRANT_LIFETIME, &challenge, 1, &signature(), |_, _| true), Ok(()));
    }

    #[test]
    fn a_challenge_from_another_connection_or_a_forged_one_is_unknown() {
        let t0 = Instant::now();
        let (mut book, _) = book_with_challenge(1, t0);
        let (_, other_connection) = book_with_challenge(1, t0);
        assert_eq!(
            book.accept(t0, &other_connection, 1, &signature(), |_, _| true),
            Err(GrantRefusal::UnknownChallenge)
        );
        assert_eq!(book.accept(t0, "short", 1, &signature(), |_, _| true), Err(GrantRefusal::Malformed));
    }

    #[test]
    fn the_signed_payload_binds_the_connection_nonce() {
        // A signature over another connection's nonce does not verify here:
        // the verifier sees this connection's nonce in the payload.
        let t0 = Instant::now();
        let (mut book, challenge) = book_with_challenge(1, t0);
        let foreign = grant_payload(&[0x22; NONCE_BYTES], &decode_nonce(&challenge).unwrap(), 1);
        assert_eq!(
            book.accept(t0, &challenge, 1, &signature(), |payload, _| payload == foreign.as_slice()),
            Err(GrantRefusal::BadSignature)
        );
    }

    #[test]
    fn a_grant_for_another_run_or_before_any_run_is_refused_and_a_new_run_ends_the_grant() {
        let t0 = Instant::now();
        let (mut book, challenge) = book_with_challenge(5, t0);
        assert_eq!(book.accept(t0, &challenge, 4, &signature(), |_, _| true), Err(GrantRefusal::WrongEpoch));

        let mut fresh = GrantBook::new(NONCE.to_vec());
        let challenge = generate_challenge();
        fresh.issue(t0, challenge.clone());
        assert_eq!(
            fresh.accept(t0, &encode_nonce(&challenge), 1, &signature(), |_, _| true),
            Err(GrantRefusal::NoEpoch)
        );

        let (mut live, challenge) = book_with_challenge(5, t0);
        assert_eq!(live.accept(t0, &challenge, 5, &signature(), |_, _| true), Ok(()));
        assert!(!live.set_epoch(5), "re-declaring the same run changes nothing");
        assert!(live.live(t0));
        assert!(live.set_epoch(6));
        assert!(!live.live(t0), "a new run ends the grant");
    }

    #[test]
    fn a_replayed_grant_is_refused() {
        let t0 = Instant::now();
        let (mut book, challenge) = book_with_challenge(1, t0);
        assert_eq!(book.accept(t0, &challenge, 1, &signature(), |_, _| true), Ok(()));
        assert_eq!(
            book.accept(t0 + Duration::from_millis(10), &challenge, 1, &signature(), |_, _| true),
            Err(GrantRefusal::UnknownChallenge)
        );
    }

    #[test]
    fn an_accepted_grant_does_not_make_the_next_challenge_due_early() {
        let t0 = Instant::now();
        let (mut book, challenge) = book_with_challenge(1, t0);
        let answered = t0 + Duration::from_millis(200);
        assert_eq!(book.accept(answered, &challenge, 1, &signature(), |_, _| true), Ok(()));
        assert!(book.open.is_empty(), "the grant consumed the only open challenge");
        assert!(!book.needs_challenge(answered), "no new challenge right after a grant");
        assert!(!book.needs_challenge(t0 + GRANT_REFRESH - Duration::from_millis(1)));
        assert!(book.needs_challenge(t0 + GRANT_REFRESH), "due one refresh after the last issue");
        // Neither a refusal, re-declaring the same run, nor a revocation
        // restarts the cadence...
        assert_eq!(book.accept(answered, "AAAAAAAAAAAAAAAAAAAAAA==", 1, &signature(), |_, _| true),
            Err(GrantRefusal::UnknownChallenge));
        assert!(!book.set_epoch(1));
        book.revoke();
        assert!(!book.needs_challenge(answered));
        // ...only (re)activating control does.
        book.restart_cadence();
        assert!(book.needs_challenge(answered));
    }

    #[test]
    fn a_new_video_run_makes_a_challenge_due_at_once() {
        let t0 = Instant::now();
        let (mut book, challenge) = book_with_challenge(1, t0);
        assert_eq!(book.accept(t0, &challenge, 1, &signature(), |_, _| true), Ok(()));
        let switched = t0 + Duration::from_millis(100);
        assert!(!book.needs_challenge(switched), "mid-cadence");
        assert!(book.set_epoch(2), "the UAC prompt starts a new run");
        assert!(!book.live(switched), "the old grant ended with the run");
        assert!(book.needs_challenge(switched), "a challenge is due at once, not at the next refresh");
        // Once issued, the cadence runs from that issue.
        let challenge = generate_challenge();
        book.issue(switched, challenge.clone());
        assert!(!book.needs_challenge(switched + GRANT_REFRESH - Duration::from_millis(1)));
        assert_eq!(book.accept(switched, &encode_nonce(&challenge), 2, &signature(), |_, _| true), Ok(()));
        assert!(book.live(switched));
    }

    #[test]
    fn challenges_are_refreshed_on_cadence_and_expired_ones_dropped() {
        let t0 = Instant::now();
        let mut book = GrantBook::new(NONCE.to_vec());
        assert!(book.needs_challenge(t0), "none issued yet");
        book.issue(t0, generate_challenge());
        assert!(!book.needs_challenge(t0 + GRANT_REFRESH - Duration::from_millis(1)));
        assert!(book.needs_challenge(t0 + GRANT_REFRESH));
        // Issuing every refresh period never keeps more than lifetime/refresh + 1 open.
        let mut at = t0;
        for _ in 0..20 {
            at += GRANT_REFRESH;
            book.issue(at, generate_challenge());
            assert!(book.open.len() <= (GRANT_LIFETIME.as_millis() / GRANT_REFRESH.as_millis()) as usize + 1);
        }
        book.revoke();
        assert!(book.open.is_empty() && !book.live(at));
    }

    // ---- software SAS policy ----

    #[test]
    fn sas_policy_never_overrides_an_administrator() {
        assert_eq!(sas_policy(None), SasPolicy::EnableTemporarily);
        assert_eq!(sas_policy(Some(1)), SasPolicy::Allowed);
        assert_eq!(sas_policy(Some(3)), SasPolicy::Allowed);
        assert_eq!(sas_policy(Some(0)), SasPolicy::DisabledByPolicy);
        assert_eq!(sas_policy(Some(2)), SasPolicy::DisabledByPolicy, "Ease of Access only excludes services");
        assert_eq!(sas_policy(Some(99)), SasPolicy::DisabledByPolicy);
    }

    /// An in-memory registry value and marker file, with an operation log.
    #[derive(Default)]
    struct FakeRegistry {
        value: Option<u32>,
        marker: Option<String>,
        ops: Vec<String>,
        fail_delete: bool,
    }

    impl SasPolicyStore for FakeRegistry {
        fn value(&mut self) -> Result<Option<u32>, String> {
            Ok(self.value)
        }
        fn set_value(&mut self, data: u32) -> Result<(), String> {
            assert!(self.marker.is_some(), "the marker is written before the value");
            self.ops.push(format!("set {data}"));
            self.value = Some(data);
            Ok(())
        }
        fn delete_value(&mut self) -> Result<(), String> {
            if self.fail_delete {
                return Err("access denied".into());
            }
            self.ops.push("delete".into());
            self.value = None;
            Ok(())
        }
        fn marker(&mut self) -> Result<Option<String>, String> {
            Ok(self.marker.clone())
        }
        fn write_marker(&mut self, text: &str) -> Result<(), String> {
            self.ops.push("mark".into());
            self.marker = Some(text.into());
            Ok(())
        }
        fn clear_marker(&mut self) -> Result<(), String> {
            self.ops.push("unmark".into());
            self.marker = None;
            Ok(())
        }
    }

    #[test]
    fn an_absent_value_is_set_under_a_marker_and_removed_after_the_sas() {
        let registry = std::cell::RefCell::new(FakeRegistry::default());
        let sent = send_sas_under_policy(&mut RegistryCell(&registry), || {
            assert_eq!(registry.borrow().value, Some(1), "services are allowed during the call");
            Ok(())
        });
        assert_eq!(sent, Ok(SasSent::Temporarily(Ok(SasCleanup::Removed))));
        let registry = registry.into_inner();
        assert_eq!(registry.ops, ["mark", "set 1", "delete", "unmark"]);
        assert_eq!((registry.value, registry.marker), (None, None), "the machine is left as it was");
    }

    #[test]
    fn a_pre_existing_value_is_never_written_or_removed() {
        for existing in [1, 3] {
            let mut registry = FakeRegistry { value: Some(existing), ..Default::default() };
            assert_eq!(send_sas_under_policy(&mut registry, || Ok(())), Ok(SasSent::AsConfigured));
            assert!(registry.ops.is_empty());
            assert_eq!(registry.value, Some(existing));
        }
        for excluded in [0, 2, 99] {
            let mut registry = FakeRegistry { value: Some(excluded), ..Default::default() };
            let mut called = false;
            let result = send_sas_under_policy(&mut registry, || {
                called = true;
                Ok(())
            });
            assert!(result.unwrap_err().starts_with("sas_disabled_by_policy"));
            assert!(!called && registry.ops.is_empty());
            assert_eq!(registry.value, Some(excluded));
        }
    }

    #[test]
    fn an_administrator_change_between_set_and_delete_is_left_alone() {
        // The SAS call stands in for the window in which an admin acts.
        for (admin, left) in [(Some(0), Some(0)), (Some(3), Some(3)), (None, None)] {
            let registry = std::cell::RefCell::new(FakeRegistry::default());
            let mut store = RegistryCell(&registry);
            let sent = send_sas_under_policy(&mut store, || {
                registry.borrow_mut().value = admin;
                Ok(())
            });
            assert_eq!(sent, Ok(SasSent::Temporarily(Ok(SasCleanup::LeftAlone(left)))));
            let registry = registry.into_inner();
            assert_eq!(registry.value, admin, "the administrator's change survives");
            assert_eq!(registry.marker, None, "our marker is cleared");
            assert!(!registry.ops.contains(&"delete".to_string()));
        }
    }

    /// Lets the `send` closure reach the same fake the policy code drives.
    struct RegistryCell<'a>(&'a std::cell::RefCell<FakeRegistry>);

    impl SasPolicyStore for RegistryCell<'_> {
        fn value(&mut self) -> Result<Option<u32>, String> {
            self.0.borrow_mut().value()
        }
        fn set_value(&mut self, data: u32) -> Result<(), String> {
            self.0.borrow_mut().set_value(data)
        }
        fn delete_value(&mut self) -> Result<(), String> {
            self.0.borrow_mut().delete_value()
        }
        fn marker(&mut self) -> Result<Option<String>, String> {
            self.0.borrow_mut().marker()
        }
        fn write_marker(&mut self, text: &str) -> Result<(), String> {
            self.0.borrow_mut().write_marker(text)
        }
        fn clear_marker(&mut self) -> Result<(), String> {
            self.0.borrow_mut().clear_marker()
        }
    }

    #[test]
    fn a_crash_is_recovered_at_the_next_start() {
        // Crashed after setting, before removing: the marker names our value.
        let ours = SasPolicyMarker::new(SOFTWARE_SAS_SERVICES).to_json();
        let mut crashed = FakeRegistry { value: Some(1), marker: Some(ours.clone()), ..Default::default() };
        assert_eq!(restore_software_sas(&mut crashed), Ok(SasCleanup::Removed));
        assert_eq!((crashed.value, crashed.marker), (None, None));

        // Crashed after marking, before setting: nothing to remove.
        let mut early = FakeRegistry { marker: Some(ours.clone()), ..Default::default() };
        assert_eq!(restore_software_sas(&mut early), Ok(SasCleanup::LeftAlone(None)));
        assert!(early.marker.is_none());

        // An administrator changed it while the service was down: left alone.
        let mut changed = FakeRegistry { value: Some(0), marker: Some(ours.clone()), ..Default::default() };
        assert_eq!(restore_software_sas(&mut changed), Ok(SasCleanup::LeftAlone(Some(0))));
        assert_eq!(changed.value, Some(0));

        // A marker torn mid-write (so the value was never set) or about
        // something else never touches the registry.
        for foreign in [&ours[..ours.len() / 2], r#"{"schema":1,"key":"X","value":"Y","wrote":1}"#] {
            let mut torn = FakeRegistry { value: Some(1), marker: Some(foreign.into()), ..Default::default() };
            assert_eq!(restore_software_sas(&mut torn), Ok(SasCleanup::UnrecognizedMarker));
            assert_eq!(torn.value, Some(1));
            assert!(torn.marker.is_none());
        }

        // No marker: nothing happens.
        let mut clean = FakeRegistry { value: Some(1), ..Default::default() };
        assert_eq!(restore_software_sas(&mut clean), Ok(SasCleanup::Nothing));
        assert!(clean.ops.is_empty());
    }

    #[test]
    fn a_failed_removal_keeps_the_marker_and_the_next_sas_retries_it() {
        let mut registry = FakeRegistry { fail_delete: true, ..Default::default() };
        let sent = send_sas_under_policy(&mut registry, || Ok(())).unwrap();
        assert!(matches!(sent, SasSent::Temporarily(Err(_))));
        assert_eq!(registry.value, Some(1));
        assert!(registry.marker.is_some(), "kept for the retry");
        // The next request resolves the leftover first, so it reads "absent",
        // not "allowed", and still removes its own value afterwards.
        registry.fail_delete = false;
        registry.ops.clear();
        let sent = send_sas_under_policy(&mut registry, || Ok(()));
        assert_eq!(sent, Ok(SasSent::Temporarily(Ok(SasCleanup::Removed))));
        assert_eq!(registry.ops, ["delete", "unmark", "mark", "set 1", "delete", "unmark"]);
        assert_eq!((registry.value, registry.marker), (None, None));
    }

    // ---- ECDSA verification (CNG) ----

    /// A signature Web Crypto produced (`subtle.sign({name: 'ECDSA', hash:
    /// 'SHA-256'})` in Node) over `grant_payload(16×0x11, 16×0x22, 7)`, with
    /// its raw public key — the same vector the TypeScript grant test signs
    /// against, so the phone's signatures provably verify here.
    #[cfg(windows)]
    const WEBCRYPTO_KEY: &str =
        "BGmDdwJf4BSehYdpCvbHI135xhoxm4OLAwcr_bRgR1VAL6_vv3-RMLJdSP96rgjWFfZGJWWNEpQ0xJQDo3VGDx0";
    #[cfg(windows)]
    const WEBCRYPTO_SIGNATURE: &str =
        "QDG5C7xJRVBbZyZlxt5KWaaUgBoE3CYU9Cg6H2A4/EaKa6Kn61Istg/11rw3n998xAJusito4Kbh99L+rJx4Bg==";

    #[test]
    fn grant_payload_matches_the_shared_vector() {
        let payload = grant_payload(&[0x11; NONCE_BYTES], &[0x22; NONCE_BYTES], 7);
        let hex: String = payload.iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(
            hex,
            "6d6978646f672d7365637572652d6465736b746f702d6772616e742d7631001111111111111111111111111111111122222222222222222222222222222222\
             0000000000000007"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_web_crypto_signature_verifies_and_any_change_breaks_it() {
        let key = decode_controller_key(WEBCRYPTO_KEY).unwrap();
        let signature = BASE64.decode(WEBCRYPTO_SIGNATURE).unwrap();
        let payload = grant_payload(&[0x11; NONCE_BYTES], &[0x22; NONCE_BYTES], 7);
        assert!(ecdsa_p256_verify(&key, &payload, &signature));
        // Another epoch, another nonce, a flipped signature bit, another key.
        assert!(!ecdsa_p256_verify(&key, &grant_payload(&[0x11; NONCE_BYTES], &[0x22; NONCE_BYTES], 8), &signature));
        assert!(!ecdsa_p256_verify(&key, &grant_payload(&[0x12; NONCE_BYTES], &[0x22; NONCE_BYTES], 7), &signature));
        let mut flipped = signature.clone();
        flipped[10] ^= 1;
        assert!(!ecdsa_p256_verify(&key, &payload, &flipped));
        let (_, other) = cng::key_pair();
        assert!(!ecdsa_p256_verify(&other, &payload, &signature));
        assert!(!ecdsa_p256_verify(&key, &payload, &signature[..63]));
    }

    #[cfg(windows)]
    #[test]
    fn a_grant_signed_by_the_enrolled_key_goes_live_end_to_end() {
        let (private, public) = cng::key_pair();
        let t0 = Instant::now();
        let (mut book, challenge) = book_with_challenge(3, t0);
        let payload = grant_payload(&NONCE, &decode_nonce(&challenge).unwrap(), 3);
        let signed = BASE64.encode(cng::sign(&private, &payload));
        assert_eq!(
            book.accept(t0, &challenge, 3, &signed, |payload, signature| ecdsa_p256_verify(&public, payload, signature)),
            Ok(())
        );
        assert!(book.live(t0));
        // The same signature against a challenge of the same book is refused.
        let second = generate_challenge();
        book.issue(t0, second.clone());
        assert_eq!(
            book.accept(t0, &encode_nonce(&second), 3, &signed, |payload, signature| {
                ecdsa_p256_verify(&public, payload, signature)
            }),
            Err(GrantRefusal::BadSignature)
        );
    }

    /// A throwaway CNG P-256 signing key for the tests.
    #[cfg(windows)]
    mod cng {
        use sha2::{Digest, Sha256};
        use windows::Win32::Security::Cryptography::{
            BCryptDestroyKey, BCryptExportKey, BCryptFinalizeKeyPair, BCryptGenerateKeyPair, BCryptSignHash,
            BCRYPT_ECCPUBLIC_BLOB, BCRYPT_ECDSA_P256_ALG_HANDLE, BCRYPT_FLAGS, BCRYPT_KEY_HANDLE,
        };

        pub struct Key(BCRYPT_KEY_HANDLE);

        impl Drop for Key {
            fn drop(&mut self) {
                unsafe {
                    let _ = BCryptDestroyKey(self.0);
                }
            }
        }

        pub fn key_pair() -> (Key, [u8; super::CONTROLLER_KEY_BYTES]) {
            unsafe {
                let mut handle = BCRYPT_KEY_HANDLE(std::ptr::null_mut());
                assert!(BCryptGenerateKeyPair(BCRYPT_ECDSA_P256_ALG_HANDLE, &mut handle, 256, 0).is_ok());
                assert!(BCryptFinalizeKeyPair(handle, 0).is_ok());
                let mut blob = [0u8; 8 + 64];
                let mut written = 0u32;
                assert!(BCryptExportKey(handle, None, BCRYPT_ECCPUBLIC_BLOB, Some(&mut blob), &mut written, 0).is_ok());
                let mut public = [0u8; super::CONTROLLER_KEY_BYTES];
                public[0] = 4;
                public[1..].copy_from_slice(&blob[8..]);
                (Key(handle), public)
            }
        }

        pub fn sign(key: &Key, message: &[u8]) -> Vec<u8> {
            let digest = Sha256::digest(message);
            let mut signature = vec![0u8; super::GRANT_SIGNATURE_BYTES];
            let mut written = 0u32;
            unsafe {
                assert!(
                    BCryptSignHash(key.0, None, &digest, Some(&mut signature), &mut written, BCRYPT_FLAGS(0)).is_ok()
                );
            }
            signature
        }
    }

    #[test]
    fn install_state_rejects_a_bad_secret_or_sid() {
        let mut state = InstallState::new("0.1.0", "S-1-5-18", crate::paths::PIPE_NAME, 0);
        state.secret = "not-base64!!".into();
        assert!(InstallState::from_json(&state.to_json()).is_err());
        let mut state = InstallState::new("0.1.0", "S-1-5-18", crate::paths::PIPE_NAME, 0);
        state.user_sid = "bogus".into();
        assert!(InstallState::from_json(&state.to_json()).is_err());
    }
}
