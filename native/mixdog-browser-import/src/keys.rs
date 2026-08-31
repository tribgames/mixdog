//! Chrome OSCrypt master-key resolution from `Local State`.
//!
//! v10 keys are DPAPI-wrapped and unwrapped in-process. v20 keys are
//! App-Bound and require the elevated helper (see [`crate::abe_client`]).

use std::path::Path;

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chromium_importer::chromium::crypt_unprotect_data;
use serde::Deserialize;

use crate::abe_client;

#[derive(Deserialize)]
struct LocalState {
    os_crypt: Option<OsCrypt>,
}

#[derive(Deserialize)]
struct OsCrypt {
    encrypted_key: Option<String>,
    app_bound_encrypted_key: Option<String>,
}

fn read_os_crypt(local_state_path: &Path) -> Result<OsCrypt> {
    let text = std::fs::read_to_string(local_state_path)
        .map_err(|e| anyhow!("failed to read Local State: {}", e))?;
    let state: LocalState =
        serde_json::from_str(&text).map_err(|e| anyhow!("failed to parse Local State: {}", e))?;
    state
        .os_crypt
        .ok_or_else(|| anyhow!("Local State has no os_crypt section"))
}

/// Resolve the DPAPI-wrapped v10 master key.
pub fn v10_key(local_state_path: &Path) -> Result<Vec<u8>> {
    let encoded = read_os_crypt(local_state_path)?
        .encrypted_key
        .ok_or_else(|| anyhow!("Local State has no encrypted_key"))?;
    let bytes = BASE64_STANDARD
        .decode(&encoded)
        .map_err(|e| anyhow!("encrypted_key is not valid base64: {}", e))?;
    if bytes.len() <= 5 || &bytes[..5] != b"DPAPI" {
        return Err(anyhow!("encrypted_key is not DPAPI-prefixed"));
    }
    crypt_unprotect_data(&bytes[5..], 0).map_err(|e| anyhow!("failed to unprotect v10 key: {}", e))
}

/// Resolve the App-Bound v20 master key via the elevated helper (raises UAC).
pub async fn v20_key(local_state_path: &Path, admin_exe: &str) -> Result<Vec<u8>> {
    let encoded = read_os_crypt(local_state_path)?
        .app_bound_encrypted_key
        .ok_or_else(|| anyhow!("Local State has no app_bound_encrypted_key"))?;
    abe_client::unwrap_app_bound_key(admin_exe, &encoded).await
}
