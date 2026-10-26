//! Install secret, security-descriptor (SDDL) strings, constant-time secret
//! comparison, and the on-disk install state. The pure parts (SDDL building,
//! secret handling, state (de)serialization) carry the security-critical logic
//! and are unit-tested here; the current-user SID lookup lives in the Windows
//! layer and is injected as a string.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
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
}

impl InstallState {
    pub fn new(product_version: &str, user_sid: &str, pipe_name: &str, installed_at_ms: u64) -> Self {
        InstallState {
            schema: STATE_SCHEMA_VERSION,
            product_version: product_version.to_string(),
            user_sid: user_sid.to_string(),
            secret: generate_secret(),
            pipe_name: pipe_name.to_string(),
            installed_at_ms,
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).expect("install state always serializes")
    }

    pub fn from_json(text: &str) -> Result<Self, String> {
        let state: InstallState =
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
/// read-only. The user never needs to write it after install.
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
