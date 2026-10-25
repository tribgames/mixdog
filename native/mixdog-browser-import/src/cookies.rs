//! Offline Chrome cookie decryption.
//!
//! Reads the profile cookie database without conflating the database schema
//! with its encryption version. Every encrypted value in schema 24 or newer
//! is domain-bound, including v10 values. Failures are counted, never omitted
//! from the encrypted import report or converted into replacement characters.

use std::path::{Path, PathBuf};

use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use anyhow::{anyhow, Result};
use chromium_importer::chromium::crypt_unprotect_data;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

use crate::failure::{Classify, Failure};
use crate::{keys, snapshot};

/// Chrome stores timestamps as microseconds since 1601-01-01 UTC.
const CHROME_EPOCH_OFFSET_SECS: i64 = 11_644_473_600;
const IV_SIZE: usize = 12;
const TAG_SIZE: usize = 16;
const DOMAIN_BOUND_SCHEMA: i64 = 24;
const DOMAIN_HASH_SIZE: usize = 32;
const MAX_COOKIES: usize = 1_000_000;

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
    #[serde(rename = "partitionKey", skip_serializing_if = "Option::is_none")]
    pub partition_key: Option<CookiePartitionKey>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CookiePartitionKey {
    top_level_site: String,
    has_cross_site_ancestor: bool,
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
    value: Zeroizing<Vec<u8>>,
    encrypted_value: Vec<u8>,
    top_frame_site_key: String,
    has_cross_site_ancestor: Option<i64>,
    is_secure: i64,
    is_httponly: i64,
    has_expires: i64,
    is_persistent: i64,
    expires_utc: i64,
    samesite: i64,
}

impl RawCookie {
    fn expired(&self, now: f64) -> bool {
        self.has_expires != 0
            && self.is_persistent != 0
            && self.expires_utc as f64 / 1_000_000.0 - CHROME_EPOCH_OFFSET_SECS as f64 <= now
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieImportFailures {
    decryption: usize,
    domain_mismatch: usize,
    invalid_encoding: usize,
    invalid_partition: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieImportReport {
    version: u8,
    source_count: usize,
    expired: usize,
    cookies: Vec<Cookie>,
    failures: CookieImportFailures,
}

enum DecodeError {
    Decryption,
    DomainMismatch,
    InvalidEncoding,
}

#[derive(Default)]
pub struct DecryptKeys {
    pub v10: Option<Vec<u8>>,
    pub v20: Option<Vec<u8>>,
}

impl Drop for DecryptKeys {
    fn drop(&mut self) {
        self.v10.zeroize();
        self.v20.zeroize();
    }
}

/// The cookie rows read into memory from a database snapshot (see
/// [`crate::snapshot`]), so the live profile is never written to.
pub struct CookieDb {
    schema_version: i64,
    raws: Vec<RawCookie>,
}

impl CookieDb {
    fn from_connection(conn: &Connection) -> Result<Self> {
        let schema_version: i64 = conn.query_row(
            "SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'version'",
            [],
            |row| row.get(0),
        )?;
        if schema_version < 1 {
            return Err(anyhow!("cookie database schema version is invalid"));
        }
        let columns = conn
            .prepare("PRAGMA table_info(cookies)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let has_partition = columns.iter().any(|name| name == "top_frame_site_key");
        let partition_column = if has_partition {
            "top_frame_site_key"
        } else {
            "''"
        };
        let ancestor_column = if columns.iter().any(|name| name == "has_cross_site_ancestor") {
            "has_cross_site_ancestor"
        } else {
            "NULL"
        };
        let mut statement = conn.prepare(&format!(
            "SELECT host_key, name, path, encrypted_value, value, is_secure, is_httponly, \
             has_expires, is_persistent, expires_utc, samesite, {partition_column}, {ancestor_column} FROM cookies",
        ))?;
        let rows = statement.query_map([], |row| {
            Ok(RawCookie {
                host_key: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                encrypted_value: row.get(3)?,
                value: Zeroizing::new(row.get_ref(4)?.as_bytes()?.to_vec()),
                is_secure: row.get(5)?,
                is_httponly: row.get(6)?,
                has_expires: row.get(7)?,
                is_persistent: row.get(8)?,
                expires_utc: row.get(9)?,
                samesite: row.get(10)?,
                top_frame_site_key: row.get(11)?,
                has_cross_site_ancestor: row.get(12)?,
            })
        })?;
        let mut raws = Vec::new();
        for row in rows {
            if raws.len() == MAX_COOKIES {
                return Err(anyhow!("cookie database exceeds the import limit"));
            }
            raws.push(row?);
        }
        Ok(Self {
            schema_version,
            raws,
        })
    }

    pub fn load(db_path: &Path) -> Result<Self> {
        // SQLite's own error text is dropped; only the class is ever reported.
        let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .classify(Failure::DataUnreadable)?;
        Self::from_connection(&conn).classify(Failure::DataUnreadable)
    }

    /// Which encryption versions are present, so only the needed keys — and
    /// only the UAC prompt for v20 — are requested.
    pub fn versions_present(&self, now: f64) -> (bool, bool) {
        let mut v10 = false;
        let mut v20 = false;
        for raw in &self.raws {
            if raw.expired(now) {
                continue;
            }
            if raw.encrypted_value.starts_with(b"v20") {
                v20 = true;
            } else if raw.encrypted_value.starts_with(b"v10") {
                v10 = true;
            }
        }
        (v10, v20)
    }

    pub fn decrypt(self, keys: &DecryptKeys, now: f64) -> CookieImportReport {
        let source_count = self.raws.len();
        let mut expired = 0;
        let mut cookies = Vec::with_capacity(self.raws.len());
        let mut failures = CookieImportFailures::default();
        for raw in self.raws {
            if raw.expired(now) {
                expired += 1;
                continue;
            }
            let partition_key = if raw.top_frame_site_key.is_empty() {
                None
            } else {
                // Missing ancestry cannot be guessed: it distinguishes cookies
                // even when their top-level site, name and domain are identical.
                let Some(ancestor @ (0 | 1)) = raw.has_cross_site_ancestor else {
                    failures.invalid_partition += 1;
                    continue;
                };
                Some(CookiePartitionKey {
                    top_level_site: raw.top_frame_site_key.clone(),
                    has_cross_site_ancestor: ancestor == 1,
                })
            };
            let value = match decode_value(&raw, self.schema_version, keys) {
                Ok(value) => value,
                Err(error) => {
                    match error {
                        DecodeError::Decryption => failures.decryption += 1,
                        DecodeError::DomainMismatch => failures.domain_mismatch += 1,
                        DecodeError::InvalidEncoding => failures.invalid_encoding += 1,
                    }
                    continue;
                }
            };
            let session = raw.has_expires == 0 || raw.is_persistent == 0;
            let expires = if session {
                None
            } else {
                // Keep past/zero expiries past: they must never become sessions.
                Some(raw.expires_utc as f64 / 1_000_000.0 - CHROME_EPOCH_OFFSET_SECS as f64)
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
                partition_key,
            });
        }
        CookieImportReport {
            version: 2,
            source_count,
            expired,
            cookies,
            failures,
        }
    }
}

fn decrypt_gcm(key: &[u8], blob: &[u8]) -> Result<Vec<u8>> {
    if blob.len() < IV_SIZE + TAG_SIZE {
        return Err(anyhow!("cookie ciphertext is too short"));
    }
    let cipher = Aes256Gcm::new_from_slice(key)?;
    let nonce = Nonce::try_from(&blob[..IV_SIZE])?;
    let plaintext = cipher
        .decrypt(&nonce, &blob[IV_SIZE..])
        .map_err(|e| anyhow!("cookie decryption failed: {}", e))?;
    Ok(plaintext)
}

fn decode_value(
    raw: &RawCookie,
    schema_version: i64,
    keys: &DecryptKeys,
) -> Result<String, DecodeError> {
    let encrypted = &raw.encrypted_value;
    if encrypted.is_empty() {
        return std::str::from_utf8(&raw.value)
            .map(str::to_owned)
            .map_err(|_| DecodeError::InvalidEncoding);
    }
    let bytes = if encrypted.starts_with(b"v20") {
        decrypt_gcm(
            keys.v20.as_deref().ok_or(DecodeError::Decryption)?,
            &encrypted[3..],
        )
    } else if encrypted.starts_with(b"v10") {
        decrypt_gcm(
            keys.v10.as_deref().ok_or(DecodeError::Decryption)?,
            &encrypted[3..],
        )
    } else {
        crypt_unprotect_data(encrypted, 0).map_err(|e| anyhow!("legacy cookie DPAPI failed: {}", e))
    };
    let bytes = Zeroizing::new(bytes.map_err(|_| DecodeError::Decryption)?);
    let value = if schema_version >= DOMAIN_BOUND_SCHEMA {
        let expected = Sha256::digest(raw.host_key.as_bytes());
        if !bytes.starts_with(&expected) {
            return Err(DecodeError::DomainMismatch);
        }
        &bytes[DOMAIN_HASH_SIZE..]
    } else {
        bytes.as_slice()
    };
    std::str::from_utf8(value)
        .map(str::to_owned)
        .map_err(|_| DecodeError::InvalidEncoding)
}

pub(crate) fn chrome_user_data_dir() -> Result<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA").classify(Failure::ProfileNotFound)?;
    Ok(PathBuf::from(local)
        .join("Google")
        .join("Chrome")
        .join("User Data"))
}

/// The directory of `profile` inside the Chrome user-data directory, accepted
/// only if, once both are canonicalized the same way, its parent is exactly the
/// canonical user-data directory. That rejects `..`, drive tricks and
/// junctions or symlinks pointing elsewhere; a missing profile is not found.
pub(crate) fn resolve_profile_dir(user_data: &Path, profile: &str) -> Result<PathBuf> {
    let root = std::fs::canonicalize(user_data).classify(Failure::ProfileNotFound)?;
    let dir = std::fs::canonicalize(user_data.join(profile)).classify(Failure::ProfileNotFound)?;
    if dir.parent() != Some(root.as_path()) {
        return Err(Failure::ProfileNotFound.into());
    }
    Ok(dir)
}

fn cookie_db_path(profile_dir: &Path) -> Option<PathBuf> {
    let network = profile_dir.join("Network").join("Cookies");
    if network.exists() {
        return Some(network);
    }
    let legacy = profile_dir.join("Cookies");
    legacy.exists().then_some(legacy)
}

/// Decrypt every cookie for a Chrome profile, resolving the v20 (App-Bound)
/// key through `route` only when a v20 cookie is present.
pub async fn import_chrome_cookies(
    profile: &str,
    route: &keys::V20Route<'_>,
) -> Result<CookieImportReport> {
    let user_data = chrome_user_data_dir()?;
    let local_state = user_data.join("Local State");
    let profile_dir = resolve_profile_dir(&user_data, profile)?;
    let source = cookie_db_path(&profile_dir).classify(Failure::ProfileNotFound)?;

    // A consistent private snapshot; fails if Chrome still holds the database.
    let temp = snapshot::snapshot(&source, "cookie")?;
    let db = CookieDb::load(temp.path())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| anyhow!("system clock is before the cookie expiry epoch"))?
        .as_secs_f64();
    let (needs_v10, needs_v20) = db.versions_present(now);

    let mut keys = DecryptKeys::default();
    if needs_v10 {
        keys.v10 = Some(keys::v10_key(&local_state)?);
    }
    if needs_v20 {
        keys.v20 = Some(keys::v20_key(&local_state, route).await?);
    }

    Ok(db.decrypt(&keys, now))
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

    fn fixture(schema: i64, partition_column: bool) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);")
            .unwrap();
        conn.execute(
            "INSERT INTO meta VALUES ('version', ?)",
            [schema.to_string()],
        )
        .unwrap();
        conn.execute_batch(&format!(
            "CREATE TABLE cookies (
                host_key TEXT, name TEXT, path TEXT, value TEXT, encrypted_value BLOB,
                is_secure INTEGER, is_httponly INTEGER, has_expires INTEGER,
                is_persistent INTEGER, expires_utc INTEGER, samesite INTEGER {}
            );",
            if partition_column {
                ", top_frame_site_key TEXT DEFAULT '', has_cross_site_ancestor INTEGER DEFAULT 1"
            } else {
                ""
            }
        ))
        .unwrap();
        conn
    }

    fn insert(conn: &Connection, domain: &str, plaintext: &str, encrypted: &[u8]) {
        conn.execute(
            "INSERT INTO cookies (host_key, name, path, value, encrypted_value,
                is_secure, is_httponly, has_expires, is_persistent, expires_utc, samesite)
             VALUES (?, 'SID', '/', ?, ?, 1, 1, 0, 0, 0, 0)",
            rusqlite::params![domain, plaintext, encrypted],
        )
        .unwrap();
    }

    #[test]
    fn database_schema_controls_domain_binding_for_both_encryption_versions() {
        let key = [0x42_u8; 32];
        let keys = DecryptKeys {
            v10: Some(key.to_vec()),
            v20: Some(key.to_vec()),
        };
        for schema in [23, 24, 25] {
            for encryption in [b"v10", b"v20"] {
                let conn = fixture(schema, schema >= 24);
                let mut plaintext = if schema >= 24 {
                    Sha256::digest(b".example.test").to_vec()
                } else {
                    Vec::new()
                };
                plaintext.extend_from_slice(b"exact-session-token");
                insert(
                    &conn,
                    ".example.test",
                    "",
                    &encrypt_v(encryption, &key, &plaintext),
                );
                let report = CookieDb::from_connection(&conn)
                    .unwrap()
                    .decrypt(&keys, 1_000_000.0);
                assert_eq!(report.source_count, 1);
                assert_eq!(report.cookies.len(), 1);
                assert_eq!(report.cookies[0].value, "exact-session-token");
                assert_eq!(report.cookies[0].domain, ".example.test");
            }
        }
    }

    #[test]
    fn profile_dir_must_resolve_directly_inside_user_data() {
        let base = std::env::temp_dir().join(format!("mx-prof-{:016x}", rand::random::<u64>()));
        let user_data = base.join("User Data");
        let outside = base.join("Outside");
        std::fs::create_dir_all(user_data.join("Default")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        let canonical = std::fs::canonicalize(&user_data).unwrap();
        assert_eq!(
            resolve_profile_dir(&user_data, "Default").unwrap(),
            canonical.join("Default")
        );
        // Case differences and trailing dots normalize to the same directory.
        assert!(resolve_profile_dir(&user_data, "default.").is_ok());

        for bad in ["..", ".", "../Outside", "..\\Outside", "Missing", "C:", "Default\\.."] {
            let error = resolve_profile_dir(&user_data, bad).unwrap_err();
            assert_eq!(error.downcast_ref::<Failure>(), Some(&Failure::ProfileNotFound), "{bad}");
        }

        // A junction inside User Data that points elsewhere is refused.
        let junction = user_data.join("Linked");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&outside)
            .output()
            .unwrap()
            .status
            .success();
        assert!(made, "mklink /J failed");
        assert!(resolve_profile_dir(&user_data, "Linked").is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn iv_and_tag_only_blob_is_authenticated_not_assumed_empty() {
        let key = [0x42_u8; 32];
        // A genuinely sealed empty plaintext is exactly IV+tag and authenticates.
        let sealed_empty = encrypt_v(b"", &key, b"");
        assert_eq!(sealed_empty.len(), IV_SIZE + TAG_SIZE);
        assert!(decrypt_gcm(&key, &sealed_empty).unwrap().is_empty());
        // The same length with an unauthenticated tag is corrupt or forged.
        assert!(decrypt_gcm(&key, &[0_u8; IV_SIZE + TAG_SIZE]).is_err());
        let mut tampered = sealed_empty;
        *tampered.last_mut().unwrap() ^= 1;
        assert!(decrypt_gcm(&key, &tampered).is_err());
    }

    #[test]
    fn plaintext_empty_values_and_expiry_are_preserved_without_decryption() {
        let conn = fixture(24, true);
        insert(&conn, "plain.example.test", "plain-token", b"");
        insert(&conn, "empty.example.test", "", b"");
        insert(
            &conn,
            "expired.example.test",
            "",
            b"v20-invalid-expired-token",
        );
        conn.execute(
            "UPDATE cookies SET has_expires=1, is_persistent=1, expires_utc=0
            WHERE host_key='expired.example.test'",
            [],
        )
        .unwrap();
        let db = CookieDb::from_connection(&conn).unwrap();
        assert_eq!(db.versions_present(1_000_000.0), (false, false));
        let report = db.decrypt(&DecryptKeys::default(), 1_000_000.0);
        assert_eq!(report.cookies.len(), 2);
        assert_eq!(report.cookies[0].value, "plain-token");
        assert_eq!(report.cookies[1].value, "");
        assert!(report.cookies[0].session);
        assert_eq!(report.expired, 1);
        assert_eq!(report.failures.decryption, 0);
    }

    #[test]
    fn failures_are_categorized_without_corrupting_or_broadening_cookies() {
        let key = [0x42_u8; 32];
        let conn = fixture(24, true);
        let mut valid = Sha256::digest(b".example.test").to_vec();
        valid.extend_from_slice(b"good-token");
        insert(&conn, ".example.test", "", &encrypt_v(b"v10", &key, &valid));
        insert(
            &conn,
            "other.example.test",
            "",
            &encrypt_v(b"v10", &key, &valid),
        );
        insert(&conn, ".example.test", "", &encrypt_v(b"v20", &key, &valid));
        insert(
            &conn,
            ".example.test",
            "",
            &encrypt_v(b"v10", &key, b"short"),
        );
        let mut invalid = Sha256::digest(b".example.test").to_vec();
        invalid.push(0xff);
        insert(
            &conn,
            ".example.test",
            "",
            &encrypt_v(b"v10", &key, &invalid),
        );
        insert(
            &conn,
            "partitioned.example.test",
            "partition-only-token",
            b"",
        );
        conn.execute("UPDATE cookies SET top_frame_site_key='https://top.example.test', has_cross_site_ancestor=2
            WHERE host_key='partitioned.example.test'", []).unwrap();
        let report = CookieDb::from_connection(&conn).unwrap().decrypt(
            &DecryptKeys {
                v10: Some(key.to_vec()),
                v20: None,
            },
            1_000_000.0,
        );
        assert_eq!(report.source_count, 6);
        assert_eq!(report.cookies.len(), 1);
        assert_eq!(report.cookies[0].value, "good-token");
        assert_eq!(report.failures.decryption, 1);
        assert_eq!(report.failures.domain_mismatch, 2);
        assert_eq!(report.failures.invalid_encoding, 1);
        assert_eq!(report.failures.invalid_partition, 1);
        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(json["version"], 2);
        assert_eq!(json["sourceCount"], 6);
        assert_eq!(json["failures"]["invalidPartition"], 1);
    }

    #[test]
    fn partitioned_values_keep_the_top_level_site_and_ancestry() {
        let conn = fixture(24, true);
        insert(&conn, "widget.example.test", "embedded-session", b"");
        insert(&conn, "widget.example.test", "same-site-session", b"");
        conn.execute(
            "UPDATE cookies SET top_frame_site_key='https://shop.example.test',
            has_cross_site_ancestor=1 WHERE rowid=1",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE cookies SET top_frame_site_key='https://shop.example.test',
            has_cross_site_ancestor=0 WHERE rowid=2",
            [],
        )
        .unwrap();
        let report = CookieDb::from_connection(&conn)
            .unwrap()
            .decrypt(&DecryptKeys::default(), 1_000_000.0);
        assert_eq!(report.cookies.len(), 2);
        let cross = report.cookies[0].partition_key.as_ref().unwrap();
        let same = report.cookies[1].partition_key.as_ref().unwrap();
        assert_eq!(cross.top_level_site, "https://shop.example.test");
        assert!(cross.has_cross_site_ancestor);
        assert!(!same.has_cross_site_ancestor);
        assert_eq!(report.failures.invalid_partition, 0);
    }
}
