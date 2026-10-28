//! Offline Chrome saved-password import.
//!
//! The upstream `chromium_importer::import_logins` resolves the v20 key itself
//! through the elevated (UAC) admin helper. Exactly as [`crate::cookies`]
//! already does for cookies, this module reads the `Login Data` database
//! directly and decrypts it with the master key resolved by [`crate::keys`]
//! (the `runas` admin helper for a v20 key).
//! Only AES-256-GCM `v10` and `v20` values are decrypted (the v10 key is
//! unwrapped from DPAPI by [`crate::keys`]); legacy bare-DPAPI values are
//! rejected. The AES-GCM split/length rules mirror the upstream
//! `WindowsCryptoService` so the decrypted output is identical.

use std::path::Path;

use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use anyhow::{anyhow, Result};
use rusqlite::types::Value;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use zeroize::{Zeroize, Zeroizing};

use crate::cookies::{chrome_user_data_dir, resolve_profile_dir, DecryptKeys};
use crate::failure::{Classify, Failure};
use crate::{keys, snapshot};

const IV_SIZE: usize = 12;
const TAG_SIZE: usize = 16;
/// The two login databases Chrome keeps; account logins may be absent.
const LOGIN_DATABASES: [&str; 2] = ["Login Data", "Login Data For Account"];

/// A decrypted saved login, shaped for the desktop importer. Wiped on drop so
/// the plaintext password never lingers after the sealed envelope is built.
#[derive(Serialize)]
pub struct Credential {
    pub url: String,
    pub username: String,
    pub password: String,
    pub note: String,
    /// When Chrome last used the login (else last changed, else created), in
    /// ms since the Unix epoch; metadata only, absent when Chrome has no date.
    #[serde(rename = "lastUsedAt", skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<i64>,
}

impl Drop for Credential {
    fn drop(&mut self) {
        self.url.zeroize();
        self.username.zeroize();
        self.password.zeroize();
        self.note.zeroize();
    }
}

struct RawLogin {
    url: String,
    username: String,
    encrypted_password: Zeroizing<Vec<u8>>,
    encrypted_note: Zeroizing<Vec<u8>>,
    last_used_at: Option<i64>,
}

/// Milliseconds between the Windows epoch Chrome counts from (1601-01-01) and
/// the Unix epoch.
const CHROME_EPOCH_OFFSET_MS: i64 = 11_644_473_600_000;

/// Chrome stores times as microseconds since 1601-01-01 UTC; 0 means unset.
fn chrome_micros_to_unix_ms(micros: i64) -> Option<i64> {
    if micros <= 0 {
        return None;
    }
    let ms = micros / 1000 - CHROME_EPOCH_OFFSET_MS;
    (ms > 0).then_some(ms)
}

/// The recency columns this Chrome's schema has, best first: `date_last_used`,
/// else `date_password_modified`, else `date_created`. The names are fixed
/// constants, never input.
fn recency_columns(conn: &Connection) -> rusqlite::Result<Vec<&'static str>> {
    let mut statement = conn.prepare("SELECT name FROM pragma_table_info('logins')")?;
    let present = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(["date_last_used", "date_password_modified", "date_created"]
        .into_iter()
        .filter(|name| present.iter().any(|column| column == name))
        .collect())
}

/// The first usable date among a row's candidate values (best column first).
/// A NULL, text, blob, zero or negative value is skipped, never an error.
fn first_valid_recency(values: impl IntoIterator<Item = Value>) -> Option<i64> {
    values.into_iter().find_map(|value| match value {
        Value::Integer(micros) => chrome_micros_to_unix_ms(micros),
        _ => None,
    })
}

fn table_exists(conn: &Connection, table: &str) -> rusqlite::Result<bool> {
    conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1")?
        .exists([table])
}

fn read_login_file(path: &Path, out: &mut Vec<RawLogin>) -> Result<()> {
    // A consistent private snapshot; fails if Chrome still holds the database.
    let temp = snapshot::snapshot(path, "login")?;
    // SQLite's own error text is dropped; only the class is ever reported.
    let conn = Connection::open_with_flags(temp.path(), OpenFlags::SQLITE_OPEN_READ_WRITE)
        .classify(Failure::DataUnreadable)?;
    read_logins(&conn, out).classify(Failure::DataUnreadable)
}

fn read_logins(conn: &Connection, out: &mut Vec<RawLogin>) -> Result<()> {
    // Upstream requires both tables; a profile missing either yields no logins.
    if !table_exists(conn, "logins")? || !table_exists(conn, "password_notes")? {
        return Ok(());
    }
    let recency = recency_columns(conn)?;
    let recency_select: String = recency.iter().map(|name| format!(", l.{name}")).collect();
    let mut statement = conn.prepare(&format!(
        "SELECT l.origin_url, l.username_value, l.password_value, pn.value{recency_select} \
         FROM logins l LEFT JOIN password_notes pn ON l.id = pn.parent_id \
         WHERE l.blacklisted_by_user = 0"
    ))?;
    let rows = statement.query_map([], |row| {
        Ok(RawLogin {
            url: row.get(0)?,
            username: row.get(1)?,
            encrypted_password: Zeroizing::new(
                row.get::<_, Option<Vec<u8>>>(2)?.unwrap_or_default(),
            ),
            encrypted_note: Zeroizing::new(row.get::<_, Option<Vec<u8>>>(3)?.unwrap_or_default()),
            last_used_at: first_valid_recency(
                (0..recency.len())
                    .map(|offset| row.get::<_, Value>(4 + offset))
                    .collect::<rusqlite::Result<Vec<_>>>()?,
            ),
        })
    })?;
    for row in rows {
        out.push(row?);
    }
    Ok(())
}

/// Which encryption versions appear across the collected logins, so only the
/// needed keys — and only the v20 elevation path when actually required — are
/// requested.
fn versions_present(raws: &[RawLogin]) -> (bool, bool) {
    let mut v10 = false;
    let mut v20 = false;
    for raw in raws {
        for blob in [&raw.encrypted_password, &raw.encrypted_note] {
            if blob.starts_with(b"v20") {
                v20 = true;
            } else if blob.starts_with(b"v10") {
                v10 = true;
            }
        }
    }
    (v10, v20)
}

/// Decrypt one encrypted value, matching the upstream Windows rules: an empty
/// blob means an empty value; only v10 and v20 are supported; everything else
/// is an error. A blob holding only the IV+tag is authenticated like any other
/// (a genuinely sealed empty plaintext yields ""), never assumed empty.
fn decrypt_value(encrypted: &[u8], keys: &DecryptKeys) -> Result<String> {
    if encrypted.is_empty() {
        return Ok(String::new());
    }
    if encrypted.len() < 3 {
        return Err(anyhow!("login value is too short"));
    }
    let (version, rest) = encrypted.split_at(3);
    let key = match version {
        b"v10" => keys.v10.as_deref(),
        b"v20" => keys.v20.as_deref(),
        _ => return Err(anyhow!("unsupported login encryption version")),
    }
    .ok_or_else(|| anyhow!("missing login decryption key"))?;

    if rest.len() < IV_SIZE + TAG_SIZE {
        return Err(anyhow!("login ciphertext is too short"));
    }
    let cipher = Aes256Gcm::new_from_slice(key)?;
    let nonce = Nonce::try_from(&rest[..IV_SIZE])?;
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(&nonce, &rest[IV_SIZE..])
            .classify(Failure::DecryptionFailed)?,
    );
    String::from_utf8(plaintext.to_vec()).map_err(|e| anyhow!("login value is not UTF-8: {}", e))
}

fn decrypt_logins(raws: Vec<RawLogin>, keys: &DecryptKeys) -> (Vec<Credential>, usize) {
    let mut credentials = Vec::with_capacity(raws.len());
    let mut failures = 0;
    for raw in raws {
        match decrypt_value(&raw.encrypted_password, keys) {
            Ok(password) => {
                // A note that fails to decrypt is dropped, not fatal (upstream).
                let note = decrypt_value(&raw.encrypted_note, keys).unwrap_or_default();
                credentials.push(Credential {
                    url: raw.url,
                    username: raw.username,
                    password,
                    note,
                    last_used_at: raw.last_used_at,
                });
            }
            Err(_) => failures += 1,
        }
    }
    (credentials, failures)
}

/// Decrypt every saved login for a Chrome profile, resolving the v20 key
/// through `route` (the admin helper) only when a v20 value is present.
pub async fn import_chrome_logins(
    profile: &str,
    route: &keys::V20Route<'_>,
) -> Result<Vec<Credential>> {
    let user_data = chrome_user_data_dir()?;
    let local_state = user_data.join("Local State");
    let profile_dir = resolve_profile_dir(&user_data, profile)?;

    let mut raws = Vec::new();
    for filename in LOGIN_DATABASES {
        let path = profile_dir.join(filename);
        if path.exists() {
            read_login_file(&path, &mut raws)?;
        }
    }
    if raws.is_empty() {
        return Ok(Vec::new());
    }

    let (needs_v10, needs_v20) = versions_present(&raws);
    let mut keys = DecryptKeys::default();
    if needs_v10 {
        keys.v10 = Some(keys::v10_key(&local_state)?);
    }
    if needs_v20 {
        keys.v20 = Some(keys::v20_key(&local_state, route).await?);
    }

    let (credentials, failures) = decrypt_logins(raws, &keys);
    // Every row failing to decrypt is an error (e.g. the key was wrong), but a
    // profile with genuinely no logins is not.
    if credentials.is_empty() && failures > 0 {
        return Err(Failure::DecryptionFailed.into());
    }
    Ok(credentials)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seal_value(version: &[u8], key: &[u8], plaintext: &[u8]) -> Vec<u8> {
        let cipher = Aes256Gcm::new_from_slice(key).expect("cipher");
        let nonce = Nonce::try_from(&[0x22_u8; IV_SIZE][..]).expect("nonce");
        let ciphertext = cipher.encrypt(&nonce, plaintext).expect("encrypt");
        let mut out = version.to_vec();
        out.extend_from_slice(&[0x22_u8; IV_SIZE]);
        out.extend_from_slice(&ciphertext);
        out
    }

    fn keys_with(key: [u8; 32]) -> DecryptKeys {
        DecryptKeys {
            v10: Some(key.to_vec()),
            v20: Some(key.to_vec()),
        }
    }

    #[test]
    fn decrypts_v10_and_v20_values() {
        let key = [0x42_u8; 32];
        let keys = keys_with(key);
        for version in [b"v10".as_slice(), b"v20".as_slice()] {
            let blob = seal_value(version, &key, b"hunter2");
            assert_eq!(decrypt_value(&blob, &keys).unwrap(), "hunter2");
        }
    }

    #[test]
    fn empty_blob_and_sealed_empty_value_decrypt_to_empty_but_unauthenticated_iv_tag_errors() {
        let key = [0x42_u8; 32];
        let keys = keys_with(key);
        assert_eq!(decrypt_value(b"", &keys).unwrap(), "");

        // A genuinely encrypted empty plaintext is exactly IV+tag and authenticates.
        for version in [b"v10".as_slice(), b"v20".as_slice()] {
            let sealed_empty = seal_value(version, &key, b"");
            assert_eq!(sealed_empty.len(), 3 + IV_SIZE + TAG_SIZE);
            assert_eq!(decrypt_value(&sealed_empty, &keys).unwrap(), "");
        }

        // The same length with an unauthenticated tag is corrupt or forged.
        let mut unauthenticated = b"v10".to_vec();
        unauthenticated.extend_from_slice(&[0_u8; IV_SIZE + TAG_SIZE]);
        assert!(decrypt_value(&unauthenticated, &keys).is_err());

        let mut tampered = seal_value(b"v10", &key, b"");
        *tampered.last_mut().unwrap() ^= 1;
        assert!(decrypt_value(&tampered, &keys).is_err());

        let wrong_key = keys_with([0x43_u8; 32]);
        assert!(decrypt_value(&seal_value(b"v10", &key, b""), &wrong_key).is_err());
    }

    #[test]
    fn unsupported_versions_and_missing_keys_error() {
        let keys = keys_with([0x42_u8; 32]);
        let mut legacy = b"v11".to_vec();
        legacy.extend_from_slice(&[0_u8; IV_SIZE + TAG_SIZE + 8]);
        assert!(decrypt_value(&legacy, &keys).is_err());

        // A v20 value with no v20 key present is a failure, not a panic.
        let blob = seal_value(b"v20", &[0x42_u8; 32], b"secret");
        let v10_only = DecryptKeys {
            v10: Some([0x42_u8; 32].to_vec()),
            v20: None,
        };
        assert!(decrypt_value(&blob, &v10_only).is_err());
    }

    #[test]
    fn version_scan_reports_only_present_versions() {
        let key = [0x42_u8; 32];
        let raws = vec![
            RawLogin {
                url: "https://a.test".into(),
                last_used_at: None,
                username: "a".into(),
                encrypted_password: Zeroizing::new(seal_value(b"v20", &key, b"p")),
                encrypted_note: Zeroizing::new(Vec::new()),
            },
            RawLogin {
                url: "https://b.test".into(),
                last_used_at: None,
                username: "b".into(),
                encrypted_password: Zeroizing::new(seal_value(b"v10", &key, b"p")),
                encrypted_note: Zeroizing::new(Vec::new()),
            },
        ];
        assert_eq!(versions_present(&raws), (true, true));
    }

    #[test]
    fn decrypt_logins_counts_failures_and_keeps_successes() {
        let key = [0x42_u8; 32];
        let raws = vec![
            RawLogin {
                url: "https://good.test".into(),
                last_used_at: None,
                username: "user".into(),
                encrypted_password: Zeroizing::new(seal_value(b"v10", &key, b"good")),
                encrypted_note: Zeroizing::new(Vec::new()),
            },
            RawLogin {
                url: "https://bad.test".into(),
                last_used_at: None,
                username: "user".into(),
                encrypted_password: Zeroizing::new(b"v10short".to_vec()),
                encrypted_note: Zeroizing::new(Vec::new()),
            },
        ];
        let (credentials, failures) = decrypt_logins(raws, &keys_with(key));
        assert_eq!(credentials.len(), 1);
        assert_eq!(credentials[0].url, "https://good.test");
        assert_eq!(credentials[0].password, "good");
        assert_eq!(failures, 1);
    }

    #[test]
    fn chrome_microseconds_since_1601_become_unix_milliseconds() {
        // 13_300_000_000_000_000 us after 1601-01-01 is 1_655_526_400_000 ms after 1970-01-01.
        assert_eq!(
            chrome_micros_to_unix_ms(13_300_000_000_000_000),
            Some(1_655_526_400_000)
        );
        assert_eq!(chrome_micros_to_unix_ms(0), None);
        assert_eq!(chrome_micros_to_unix_ms(-5), None);
    }

    fn recency_of(schema_columns: &str, values: &str) -> Option<i64> {
        let dir = std::env::temp_dir().join(format!("mx-recency-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("Login Data");
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(&format!(
                "CREATE TABLE logins (id INTEGER PRIMARY KEY, origin_url TEXT, username_value TEXT, \
                 password_value BLOB, blacklisted_by_user INTEGER DEFAULT 0{schema_columns});
                 CREATE TABLE password_notes (parent_id INTEGER, value BLOB);
                 INSERT INTO logins VALUES (1, 'https://site.test/', 'owner', x'00', 0{values});"
            ))
            .unwrap();
        }
        let mut raws = Vec::new();
        read_login_file(&db_path, &mut raws).unwrap();
        assert_eq!(raws.len(), 1);
        let recency = raws[0].last_used_at;
        std::fs::remove_dir_all(&dir).unwrap();
        recency
    }

    #[test]
    fn recency_reads_any_subset_of_columns_and_skips_invalid_values() {
        // 13_300_000_000_000_000 us is 1_655_526_400_000 ms; 13_400_000_000_000_000 us is 1_755_526_400_000 ms.
        // A single recency column (no COALESCE of one argument).
        assert_eq!(
            recency_of(", date_created INTEGER", ", 13300000000000000"),
            Some(1_655_526_400_000)
        );
        // No recency column at all.
        assert_eq!(recency_of("", ""), None);
        // A negative last-used and a text modified date are skipped for the valid created date.
        let all = ", date_last_used INTEGER, date_password_modified, date_created INTEGER";
        assert_eq!(
            recency_of(all, ", -5, 'garbage', 13300000000000000"),
            Some(1_655_526_400_000)
        );
        // The best valid column wins; a zero last-used falls back to the modified date.
        assert_eq!(
            recency_of(
                all,
                ", 13400000000000000, 13300000000000000, 13300000000000000"
            ),
            Some(1_755_526_400_000)
        );
        assert_eq!(
            recency_of(all, ", 0, 13400000000000000, NULL"),
            Some(1_755_526_400_000)
        );
    }

    #[test]
    fn reads_logins_from_a_synthetic_database() {
        let key = [0x42_u8; 32];
        let dir = std::env::temp_dir().join(format!("mx-logins-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("Login Data");
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(
                "CREATE TABLE logins (id INTEGER PRIMARY KEY, origin_url TEXT, username_value TEXT, \
                 password_value BLOB, blacklisted_by_user INTEGER DEFAULT 0);
                 CREATE TABLE password_notes (parent_id INTEGER, value BLOB);",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO logins (id, origin_url, username_value, password_value, blacklisted_by_user) \
                 VALUES (1, 'https://site.test/', 'owner', ?, 0)",
                [seal_value(b"v10", &key, b"s3cret")],
            )
            .unwrap();
            // A blacklisted row must be excluded.
            conn.execute(
                "INSERT INTO logins (id, origin_url, username_value, password_value, blacklisted_by_user) \
                 VALUES (2, 'https://blocked.test/', 'nobody', ?, 1)",
                [seal_value(b"v10", &key, b"nope")],
            )
            .unwrap();
        }
        let mut raws = Vec::new();
        read_login_file(&db_path, &mut raws).unwrap();
        assert_eq!(raws.len(), 1);
        let (credentials, failures) = decrypt_logins(raws, &keys_with(key));
        assert_eq!(failures, 0);
        assert_eq!(credentials.len(), 1);
        assert_eq!(credentials[0].url, "https://site.test/");
        assert_eq!(credentials[0].username, "owner");
        assert_eq!(credentials[0].password, "s3cret");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
