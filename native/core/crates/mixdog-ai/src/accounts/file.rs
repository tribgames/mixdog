//! `provider-accounts.json` on disk, with Node's damage handling
//! (`atomic-file.mjs`): a damaged file is moved aside to
//! `<file>.corrupt-<ms>` and the last good copy `<file>.bak` (kept by every
//! write) is restored; a roster a newer build wrote is left untouched, reads
//! see no accounts and writes refuse. Every function here is the body of a
//! lane job.

#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "every std::fs call in this module is the body of a lane job"
)]

use std::fs;
use std::io;
use std::path::Path;
use std::path::PathBuf;

use serde_json::Value;
use serde_json::json;

use super::AccountError;
use super::MAX_ACCOUNTS;
use super::is_account_provider;
use super::valid_account_id;
use crate::oauth::publish_bytes;
use crate::oauth::with_lock;

pub(crate) fn empty_roster() -> Value {
    json!({ "version": 1, "providers": {} })
}

enum Parsed {
    Absent,
    Ok(Value, Vec<u8>),
    /// A newer build's roster.
    Unsupported,
    Damaged(String),
}

fn validate(value: &Value) -> Result<(), Parsed> {
    let damaged = |why: &str| Parsed::Damaged(why.to_owned());
    let version = value.get("version");
    if let Some(v) = version.and_then(Value::as_u64)
        && v > 1
    {
        return Err(Parsed::Unsupported);
    }
    if version.and_then(Value::as_u64) != Some(1) {
        return Err(damaged("Provider account settings are unreadable."));
    }
    let Some(providers) = value.get("providers").and_then(Value::as_object) else {
        return Err(damaged("Provider account settings are unreadable."));
    };
    for (provider, pool) in providers {
        // A provider a newer build added is carried as is.
        if !is_account_provider(provider) {
            continue;
        }
        let Some(accounts) = pool
            .get("accounts")
            .and_then(Value::as_array)
            .filter(|a| a.len() <= MAX_ACCOUNTS)
        else {
            return Err(damaged("Invalid provider account list."));
        };
        let mut ids = Vec::new();
        for row in accounts {
            let id = row.get("id").and_then(Value::as_str).filter(|id| valid_account_id(id));
            let Some(id) = id else {
                return Err(damaged("Invalid provider account id."));
            };
            if ids.contains(&id) {
                return Err(damaged("Duplicate provider account id."));
            }
            ids.push(id);
        }
    }
    Ok(())
}

fn parse(content: Option<Vec<u8>>) -> Parsed {
    let Some(content) = content else {
        return Parsed::Absent;
    };
    let text = content.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&content);
    match serde_json::from_slice::<Value>(text) {
        Ok(value) => match validate(&value) {
            Ok(()) => Parsed::Ok(value, content),
            Err(other) => other,
        },
        Err(err) => Parsed::Damaged(err.to_string()),
    }
}

fn read_content(path: &Path) -> io::Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// The first `<file>.corrupt-<ms>` that does not exist yet.
fn quarantine_path(path: &Path) -> PathBuf {
    let mut stamp = chrono::Utc::now().timestamp_millis();
    while sibling(path, &format!(".corrupt-{stamp}")).exists() {
        stamp += 1;
    }
    sibling(path, &format!(".corrupt-{stamp}"))
}

/// Caller holds the lock. The file is re-read, so one another process has
/// repaired meanwhile is kept.
fn recover_locked(path: &Path) -> io::Result<Parsed> {
    let current = parse(read_content(path)?);
    let Parsed::Damaged(why) = &current else {
        return Ok(current);
    };
    let backup = parse(read_content(&sibling(path, ".bak"))?);
    let aside = quarantine_path(path);
    fs::rename(path, &aside)?;
    tracing::warn!(path = %path.display(), reason = %why, aside = %aside.display(), "provider accounts file is damaged");
    match backup {
        Parsed::Ok(value, bytes) => {
            publish_bytes(path, &bytes)?;
            Ok(Parsed::Ok(value, bytes))
        }
        _ => Ok(Parsed::Absent),
    }
}

/// The roster, or the empty one when missing, unsupported, or damaged with no
/// good copy. Never throws for damage.
pub(crate) fn read_roster(path: &Path) -> io::Result<Value> {
    match parse(read_content(path)?) {
        Parsed::Ok(value, _) => Ok(value),
        Parsed::Absent | Parsed::Unsupported => Ok(empty_roster()),
        Parsed::Damaged(_) => match with_lock(path, || recover_locked(path))? {
            Parsed::Ok(value, _) => Ok(value),
            _ => Ok(empty_roster()),
        },
    }
}

fn holds_no_data(content: &[u8]) -> bool {
    content.iter().all(|b| matches!(b, 0 | b' ' | b'\t' | b'\n' | b'\r'))
}

/// Read-modify-write under the file's lock. The replaced version is kept as
/// `<file>.bak` (damaged bytes never are). `mutate` returns the roster to
/// store, which must validate.
pub(crate) fn update_roster(
    path: &Path,
    mutate: impl FnOnce(&mut Value) -> Result<(), AccountError>,
) -> io::Result<Result<Value, AccountError>> {
    with_lock(path, || {
        let previous = read_content(path)?;
        let mut roster = match parse(previous.clone()) {
            Parsed::Absent => empty_roster(),
            Parsed::Ok(value, _) => value,
            Parsed::Unsupported => {
                return Ok(Err(AccountError::Unsupported(
                    "Provider account settings are newer than this build.".into(),
                )));
            }
            Parsed::Damaged(_) => match recover_locked(path)? {
                Parsed::Ok(value, _) => value,
                _ => empty_roster(),
            },
        };
        if let Err(err) = mutate(&mut roster) {
            return Ok(Err(err));
        }
        if let Err(Parsed::Damaged(why)) = validate(&roster) {
            return Ok(Err(AccountError::Rejected(why)));
        }
        if let Some(previous) = previous.filter(|p| !holds_no_data(p) && matches!(parse(Some(p.clone())), Parsed::Ok(..))) {
            publish_bytes(&sibling(path, ".bak"), &previous)?;
        }
        publish_bytes(path, &serde_json::to_vec_pretty(&roster).map_err(io::Error::other)?)?;
        Ok(Ok(roster))
    })
}
