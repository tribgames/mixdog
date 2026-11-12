//! The pairing token (`remote-bridge.token`, the name 1.4.5 used) and the E2EE identity
//! (`relay-e2ee.json`). Both are secrets: owner-only, replaced atomically.

use std::path::Path;

use mixdog_rt::InLane;
use mixdog_store::fsio::WriteLane;
use rand::RngCore;

use super::device::hex;
use super::secret::{SecretError, read_secret, write_secret};
use crate::e2ee::ServerIdentity;

const TOKEN_FILE: &str = "pairing-token";
const E2EE_FILE: &str = "e2ee.json";

fn valid_token(text: &str) -> bool {
    (32..=128).contains(&text.len()) && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn write_token<L: WriteLane>(lane: &InLane<L>, path: &Path) -> Result<String, SecretError> {
    let mut bytes = [0u8; 24];
    rand::rng().fill_bytes(&mut bytes);
    let token = hex(&bytes);
    write_secret(lane, path, token.as_bytes())?;
    Ok(token)
}

pub fn load_or_create_pairing_token<L: WriteLane>(lane: &InLane<L>, dir: &Path) -> Result<String, SecretError> {
    let path = dir.join(TOKEN_FILE);
    if let Some(bytes) = read_secret(lane, &path)? {
        let text = mixdog_js::js_trim(&String::from_utf8_lossy(&bytes)).to_owned();
        if valid_token(&text) {
            return Ok(text);
        }
    }
    write_token(lane, &path)
}

/// A new relay routing token: every previously paired browser is revoked.
pub fn rotate_pairing_token<L: WriteLane>(lane: &InLane<L>, dir: &Path) -> Result<String, SecretError> {
    write_token(lane, &dir.join(TOKEN_FILE))
}

fn write_identity<L: WriteLane>(lane: &InLane<L>, path: &Path) -> Result<ServerIdentity, SecretError> {
    let identity = ServerIdentity::generate();
    write_secret(lane, path, identity.to_json().as_bytes())?;
    Ok(identity)
}

/// A corrupt or pre-release identity is replaced rather than weakening the link.
pub fn load_or_create_e2ee_identity<L: WriteLane>(lane: &InLane<L>, dir: &Path) -> Result<ServerIdentity, SecretError> {
    let path = dir.join(E2EE_FILE);
    if let Some(bytes) = read_secret(lane, &path)?
        && let Some(identity) = std::str::from_utf8(&bytes).ok().and_then(ServerIdentity::from_json)
    {
        return Ok(identity);
    }
    write_identity(lane, &path)
}

/// A new E2EE identity: every paired phone must pair again.
pub fn rotate_e2ee_identity<L: WriteLane>(lane: &InLane<L>, dir: &Path) -> Result<ServerIdentity, SecretError> {
    write_identity(lane, &dir.join(E2EE_FILE))
}
