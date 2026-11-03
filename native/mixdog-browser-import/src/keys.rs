//! Chrome OSCrypt master-key resolution from `Local State`.
//!
//! v10 keys are DPAPI-wrapped and unwrapped in-process. v20 keys are
//! App-Bound and can only be unwrapped by an elevated process that talks to
//! Chrome's elevation service: a manual import launches the admin helper with
//! the `runas` verb, which raises one UAC prompt and returns the 32-byte key
//! over a local named pipe that accepts only the helper it launched (see
//! [`crate::abe_client`]).

use std::path::Path;

use anyhow::Result;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chromium_importer::chromium::crypt_unprotect_data;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::abe_client;
use crate::failure::{Classify, Failure};

/// How the App-Bound ("v20") key may be unwrapped for one import.
pub struct V20Route<'a> {
    /// The `runas` admin helper (`bitwarden_chromium_import_helper.exe`), used
    /// for a manual import. Absent in a dev build.
    pub admin_exe: Option<&'a str>,
    /// A key from an earlier elevated unwrap that the desktop kept and sent
    /// over stdin. When present it is used and the admin helper never runs.
    pub saved_key: Option<&'a [u8]>,
    /// Whether the admin helper (a UAC prompt) may run. An automatic import
    /// never allows it: without a saved key it fails instead of prompting.
    pub allow_elevation: bool,
}

/// An App-Bound key together with the hash of the `app_bound_encrypted_key`
/// text it belongs to, so the desktop can tell when Chrome rotated it.
pub struct BoundV20Key {
    /// Wiped on drop, so every early return (a rejected key included) clears it.
    pub key: Zeroizing<Vec<u8>>,
    pub blob_sha256: String,
}

#[derive(Deserialize)]
struct LocalState {
    os_crypt: Option<OsCrypt>,
}

#[derive(Deserialize)]
struct OsCrypt {
    encrypted_key: Option<String>,
    app_bound_encrypted_key: Option<String>,
}

// Every failure here is reduced to a `Failure` class: serde and base64 errors
// can quote the Local State text they choke on, and that must never reach the
// user-visible stderr.

fn read_os_crypt(local_state_path: &Path) -> Result<OsCrypt> {
    let text = std::fs::read_to_string(local_state_path).classify(Failure::DataUnreadable)?;
    let state: LocalState = serde_json::from_str(&text).classify(Failure::DataUnreadable)?;
    state.os_crypt.classify(Failure::DataUnreadable)
}

/// The base64 `app_bound_encrypted_key` from Local State. It is encrypted at
/// rest (not a secret), so it may be read without elevation; the elevated key
/// provider reads it the same way before unwrapping.
pub fn read_app_bound_encrypted_key(local_state_path: &Path) -> Result<String> {
    read_os_crypt(local_state_path)?
        .app_bound_encrypted_key
        .classify(Failure::DataUnreadable)
}

/// Resolve the DPAPI-wrapped v10 master key.
pub fn v10_key(local_state_path: &Path) -> Result<Vec<u8>> {
    let encoded = read_os_crypt(local_state_path)?
        .encrypted_key
        .classify(Failure::DataUnreadable)?;
    let bytes = BASE64_STANDARD
        .decode(&encoded)
        .classify(Failure::DataUnreadable)?;
    if bytes.len() <= 5 || &bytes[..5] != b"DPAPI" {
        return Err(Failure::DataUnreadable.into());
    }
    crypt_unprotect_data(&bytes[5..], 0).classify(Failure::DecryptionFailed)
}

/// Lowercase hex SHA-256 of the exact `app_bound_encrypted_key` text.
fn blob_sha256(encoded: &str) -> String {
    Sha256::digest(encoded.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Resolve the App-Bound v20 master key: the saved key when one was supplied,
/// otherwise through the elevated admin helper (one UAC prompt) when allowed.
pub async fn bound_v20_key(local_state_path: &Path, route: &V20Route<'_>) -> Result<BoundV20Key> {
    // Confirm a v20 key exists before anything is used or elevated.
    let encoded = read_app_bound_encrypted_key(local_state_path)?;
    let blob_sha256 = blob_sha256(&encoded);
    if let Some(saved) = route.saved_key {
        return Ok(BoundV20Key {
            key: Zeroizing::new(saved.to_vec()),
            blob_sha256,
        });
    }
    if !route.allow_elevation {
        return Err(Failure::SavedKeyRequired.into());
    }
    let admin_exe = route.admin_exe.classify(Failure::ElevationFailed)?;
    Ok(BoundV20Key {
        key: Zeroizing::new(abe_client::unwrap_app_bound_key(admin_exe, &encoded).await?),
        blob_sha256,
    })
}

/// [`bound_v20_key`] without the binding, for importers that do not keep it.
pub async fn v20_key(local_state_path: &Path, route: &V20Route<'_>) -> Result<Vec<u8>> {
    // The caller owns (and wipes) the key from here on.
    Ok(std::mem::take(&mut *bound_v20_key(local_state_path, route).await?.key))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOCAL_STATE: &str = r#"{
        "os_crypt": {
            "encrypted_key": "REBBUEkAAQID",
            "app_bound_encrypted_key": "QVBQQgEAAADQjJ3fARXREYx6AMBPwpfr"
        }
    }"#;

    fn write_local_state(contents: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("mx-ls-{:016x}.json", rand::random::<u64>()));
        std::fs::write(&path, contents).expect("write local state");
        path
    }

    #[test]
    fn reads_the_app_bound_encrypted_key() {
        let path = write_local_state(LOCAL_STATE);
        let encoded = read_app_bound_encrypted_key(&path).expect("app-bound key");
        assert_eq!(encoded, "QVBQQgEAAADQjJ3fARXREYx6AMBPwpfr");
        std::fs::remove_file(&path).ok();
    }

    fn route(saved_key: Option<&[u8]>, allow_elevation: bool) -> V20Route<'_> {
        V20Route {
            admin_exe: None,
            saved_key,
            allow_elevation,
        }
    }

    #[tokio::test]
    async fn a_saved_key_is_bound_to_the_blob_and_never_needs_the_admin_helper() {
        let path = write_local_state(LOCAL_STATE);
        let saved = [0x5a_u8; 32];
        // No admin helper is configured: reaching for it would be an error.
        for allow_elevation in [true, false] {
            let bound = bound_v20_key(&path, &route(Some(&saved), allow_elevation))
                .await
                .expect("saved key");
            assert_eq!(bound.key.as_slice(), saved);
            assert_eq!(
                bound.blob_sha256,
                "aa27776be59cf00b623e52bc05336bcb587648479fbe081721ee4b03132dbf04"
            );
        }
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn without_a_saved_key_an_import_that_may_not_elevate_fails_instead_of_prompting() {
        use crate::failure::user_message;

        let path = write_local_state(LOCAL_STATE);
        let error = match bound_v20_key(&path, &route(None, false)).await {
            Ok(_) => panic!("must not resolve a key"),
            Err(error) => error,
        };
        assert_eq!(user_message(&error), "A saved Chrome key is required.");
        // Where elevation is allowed but the helper is missing, the failure is the elevation one.
        let error = match bound_v20_key(&path, &route(None, true)).await {
            Ok(_) => panic!("must not resolve a key"),
            Err(error) => error,
        };
        assert_eq!(user_message(&error), "Elevation was cancelled or failed.");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn missing_app_bound_key_is_an_error() {
        let path = write_local_state(r#"{ "os_crypt": { "encrypted_key": "REBBUEk=" } }"#);
        assert!(read_app_bound_encrypted_key(&path).is_err());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn local_state_text_never_reaches_the_reported_message() {
        use crate::failure::user_message;

        // serde's type error would quote the unexpected string value.
        for contents in [
            r#"{ "os_crypt": "SECRET-LOCAL-STATE-VALUE" }"#,
            r#"{ "os_crypt": { "encrypted_key": 42 } }"#,
            "SECRET-NOT-JSON",
            r#"{ "os_crypt": { "encrypted_key": "SECRET***not-base64" } }"#,
        ] {
            let path = write_local_state(contents);
            for error in [
                read_app_bound_encrypted_key(&path).unwrap_err(),
                v10_key(&path).unwrap_err(),
            ] {
                assert_eq!(user_message(&error), "Chrome data could not be read.");
                assert!(!format!("{error:?}").contains("SECRET"), "{error:?}");
            }
            std::fs::remove_file(&path).ok();
        }
        let missing = std::env::temp_dir().join("mx-ls-does-not-exist.json");
        assert_eq!(
            user_message(&read_app_bound_encrypted_key(&missing).unwrap_err()),
            "Chrome data could not be read."
        );
    }

    #[test]
    fn rejects_a_v10_key_without_the_dpapi_prefix() {
        // base64("not-dpapi") has no "DPAPI" prefix once decoded.
        let path = write_local_state(r#"{ "os_crypt": { "encrypted_key": "bm90LWRwYXBp" } }"#);
        assert!(v10_key(&path).is_err());
        std::fs::remove_file(&path).ok();
    }
}
