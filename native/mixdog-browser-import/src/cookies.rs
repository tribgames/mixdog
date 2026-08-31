//! Offline Chrome cookie decryption.
//!
//! Reads the profile `Cookies` SQLite database and decrypts each
//! `encrypted_value`. Chrome uses one OSCrypt master key per version:
//! `v20` (App-Bound) values carry a 32-byte domain-hash metadata prefix that
//! must be stripped after AES-256-GCM; `v10` values do not; anything else is a
//! legacy DPAPI blob.

use std::path::{Path, PathBuf};

use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use anyhow::{anyhow, Result};
use chromium_importer::chromium::crypt_unprotect_data;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use zeroize::Zeroize;

use crate::keys;

/// Chrome stores timestamps as microseconds since 1601-01-01 UTC.
const CHROME_EPOCH_OFFSET_SECS: i64 = 11_644_473_600;
const IV_SIZE: usize = 12;
const TAG_SIZE: usize = 16;
/// App-Bound (v20) cookie plaintext is prefixed with a 32-byte domain hash.
const V20_METADATA_PREFIX: usize = 32;

/// A decrypted cookie shaped for the desktop importer's `cookies.set` loop.
#[derive(Serialize)]
pub struct Cookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    pub secure: bool,
    #[serde(rename = "httpOnly")]
    pub http_only: bool,
    pub session: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires: Option<f64>,
    #[serde(rename = "sameSite", skip_serializing_if = "Option::is_none")]
    pub same_site: Option<String>,
}

impl Drop for Cookie {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

struct RawCookie {
    host_key: String,
    name: String,
    path: String,
    encrypted_value: Vec<u8>,
    is_secure: i64,
    is_httponly: i64,
    has_expires: i64,
    is_persistent: i64,
    expires_utc: i64,
    samesite: i64,
}

#[derive(Default)]
pub struct DecryptKeys {
    pub v10: Option<Vec<u8>>,
    pub v20: Option<Vec<u8>>,
}

/// An owned copy of the cookie database. Reading a copy avoids touching the
/// live profile and keeps working even if Chrome left a journal behind.
pub struct CookieDb {
    raws: Vec<RawCookie>,
}

impl CookieDb {
    fn from_connection(conn: &Connection) -> Result<Self> {
        let mut statement = conn.prepare(
            "SELECT host_key, name, path, encrypted_value, is_secure, is_httponly, \
             has_expires, is_persistent, expires_utc, samesite FROM cookies",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(RawCookie {
                host_key: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                encrypted_value: row.get(3)?,
                is_secure: row.get(4)?,
                is_httponly: row.get(5)?,
                has_expires: row.get(6)?,
                is_persistent: row.get(7)?,
                expires_utc: row.get(8)?,
                samesite: row.get(9)?,
            })
        })?;
        let mut raws = Vec::new();
        for row in rows {
            raws.push(row?);
        }
        Ok(Self { raws })
    }

    pub fn load(db_path: &Path) -> Result<Self> {
        let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(|e| anyhow!("failed to open cookie database: {}", e))?;
        Self::from_connection(&conn)
    }

    /// Which encryption versions are present, so only the needed keys — and
    /// only the UAC prompt for v20 — are requested.
    pub fn versions_present(&self) -> (bool, bool) {
        let mut v10 = false;
        let mut v20 = false;
        for raw in &self.raws {
            if raw.encrypted_value.starts_with(b"v20") {
                v20 = true;
            } else if raw.encrypted_value.starts_with(b"v10") {
                v10 = true;
            }
        }
        (v10, v20)
    }

    pub fn decrypt(self, keys: &DecryptKeys) -> Vec<Cookie> {
        let mut cookies = Vec::with_capacity(self.raws.len());
        for raw in self.raws {
            let Some(value) = decrypt_value(&raw.encrypted_value, keys) else {
                continue;
            };
            let session = raw.has_expires == 0 || raw.is_persistent == 0;
            let expires = if session {
                None
            } else {
                let seconds = (raw.expires_utc / 1_000_000) - CHROME_EPOCH_OFFSET_SECS;
                (seconds > 0).then_some(seconds as f64)
            };
            let same_site = match raw.samesite {
                0 => Some("none".to_string()),
                1 => Some("lax".to_string()),
                2 => Some("strict".to_string()),
                _ => None,
            };
            cookies.push(Cookie {
                name: raw.name,
                value,
                domain: raw.host_key,
                path: raw.path,
                secure: raw.is_secure != 0,
                http_only: raw.is_httponly != 0,
                session,
                expires,
                same_site,
            });
        }
        cookies
    }
}

fn decrypt_gcm(key: &[u8], blob: &[u8], strip_prefix: usize) -> Result<Vec<u8>> {
    if blob.len() < IV_SIZE + TAG_SIZE {
        return Err(anyhow!("cookie ciphertext is too short"));
    }
    let cipher = Aes256Gcm::new_from_slice(key)?;
    let nonce = Nonce::try_from(&blob[..IV_SIZE])?;
    let mut plaintext = cipher
        .decrypt(&nonce, &blob[IV_SIZE..])
        .map_err(|e| anyhow!("cookie decryption failed: {}", e))?;
    if strip_prefix > 0 {
        if plaintext.len() < strip_prefix {
            plaintext.zeroize();
            return Err(anyhow!("cookie plaintext shorter than its metadata prefix"));
        }
        plaintext.drain(..strip_prefix);
    }
    Ok(plaintext)
}

fn decrypt_value(encrypted: &[u8], keys: &DecryptKeys) -> Option<String> {
    let bytes = if encrypted.starts_with(b"v20") {
        decrypt_gcm(keys.v20.as_deref()?, &encrypted[3..], V20_METADATA_PREFIX)
    } else if encrypted.starts_with(b"v10") {
        decrypt_gcm(keys.v10.as_deref()?, &encrypted[3..], 0)
    } else if encrypted.is_empty() {
        Ok(Vec::new())
    } else {
        crypt_unprotect_data(encrypted, 0).map_err(|e| anyhow!("legacy cookie DPAPI failed: {}", e))
    };
    let mut bytes = bytes.ok()?;
    let value = String::from_utf8_lossy(&bytes).into_owned();
    bytes.zeroize();
    Some(value)
}

fn chrome_user_data_dir() -> Result<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")
        .ok_or_else(|| anyhow!("LOCALAPPDATA is not set"))?;
    Ok(PathBuf::from(local)
        .join("Google")
        .join("Chrome")
        .join("User Data"))
}

fn cookie_db_path(profile_dir: &Path) -> Option<PathBuf> {
    let network = profile_dir.join("Network").join("Cookies");
    if network.exists() {
        return Some(network);
    }
    let legacy = profile_dir.join("Cookies");
    legacy.exists().then_some(legacy)
}

fn admin_helper_path() -> Result<PathBuf> {
    let current = std::env::current_exe()
        .map_err(|e| anyhow!("failed to resolve current executable: {}", e))?;
    let helper = current
        .parent()
        .ok_or_else(|| anyhow!("current executable has no parent directory"))?
        .join("bitwarden_chromium_import_helper.exe");
    if !helper.exists() {
        return Err(anyhow!("elevated helper was not found next to the importer"));
    }
    Ok(helper)
}

/// A temporary copy of the cookie database (plus any journal siblings) that is
/// deleted on drop.
struct TempCookieDb {
    base: PathBuf,
}

impl TempCookieDb {
    fn path(&self) -> &Path {
        &self.base
    }
}

impl Drop for TempCookieDb {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm"] {
            let path = sibling(&self.base, suffix);
            let _ = std::fs::remove_file(path);
        }
    }
}

fn sibling(base: &Path, suffix: &str) -> PathBuf {
    if suffix.is_empty() {
        base.to_path_buf()
    } else {
        PathBuf::from(format!("{}{}", base.display(), suffix))
    }
}

fn copy_db_to_temp(src: &Path) -> Result<TempCookieDb> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let base = std::env::temp_dir().join(format!(
        "mixdog-cookies-{}-{}.db",
        stamp,
        rand::random::<u32>()
    ));
    std::fs::copy(src, &base).map_err(|e| anyhow!("failed to copy cookie database: {}", e))?;
    let temp = TempCookieDb { base };
    for suffix in ["-wal", "-shm"] {
        let journal = sibling(src, suffix);
        if journal.exists() {
            let _ = std::fs::copy(&journal, sibling(&temp.base, suffix));
        }
    }
    Ok(temp)
}

/// Decrypt every cookie for a Chrome profile, requesting elevation only when a
/// v20 (App-Bound) cookie is present.
pub async fn import_chrome_cookies(profile: &str) -> Result<Vec<Cookie>> {
    let user_data = chrome_user_data_dir()?;
    let local_state = user_data.join("Local State");
    let profile_dir = user_data.join(profile);
    let source = cookie_db_path(&profile_dir)
        .ok_or_else(|| anyhow!("cookie database not found for the selected profile"))?;

    let temp = copy_db_to_temp(&source)?;
    let db = CookieDb::load(temp.path())?;
    let (needs_v10, needs_v20) = db.versions_present();

    let mut keys = DecryptKeys::default();
    if needs_v10 {
        keys.v10 = Some(keys::v10_key(&local_state)?);
    }
    if needs_v20 {
        let helper = admin_helper_path()?;
        let helper = helper
            .to_str()
            .ok_or_else(|| anyhow!("helper path is not valid unicode"))?;
        keys.v20 = Some(keys::v20_key(&local_state, helper).await?);
    }

    Ok(db.decrypt(&keys))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::aead::Aead;

    fn encrypt_v(version: &[u8], key: &[u8], plaintext: &[u8]) -> Vec<u8> {
        let cipher = Aes256Gcm::new_from_slice(key).expect("cipher");
        let nonce = Nonce::try_from(&[0x11_u8; IV_SIZE][..]).expect("nonce");
        let ciphertext = cipher.encrypt(&nonce, plaintext).expect("encrypt");
        let mut out = version.to_vec();
        out.extend_from_slice(&[0x11_u8; IV_SIZE]);
        out.extend_from_slice(&ciphertext);
        out
    }

    #[test]
    fn v20_strips_the_32_byte_domain_prefix() {
        let key = [0x42_u8; 32];
        let mut plaintext = vec![0xAB_u8; V20_METADATA_PREFIX];
        plaintext.extend_from_slice(b"session=secret-value");
        let blob = encrypt_v(b"v20", &key, &plaintext);
        let keys = DecryptKeys {
            v10: None,
            v20: Some(key.to_vec()),
        };
        assert_eq!(
            decrypt_value(&blob, &keys).as_deref(),
            Some("session=secret-value")
        );
    }

    #[test]
    fn v10_keeps_the_full_plaintext() {
        let key = [0x24_u8; 32];
        let blob = encrypt_v(b"v10", &key, b"token=abc");
        let keys = DecryptKeys {
            v10: Some(key.to_vec()),
            v20: None,
        };
        assert_eq!(decrypt_value(&blob, &keys).as_deref(), Some("token=abc"));
    }

    #[test]
    fn missing_key_skips_the_cookie() {
        let key = [0x24_u8; 32];
        let blob = encrypt_v(b"v20", &key, &[0_u8; V20_METADATA_PREFIX]);
        assert!(decrypt_value(&blob, &DecryptKeys::default()).is_none());
    }
}
