//! `provider-accounts.json` on disk, with Node's damage handling
//! (`atomic-file.mjs`, through `mixdog-statefile`): a damaged file is moved aside to
//! `<file>.corrupt-<ms>` and the last good copy `<file>.bak` (kept by every
//! write) is restored; a roster a newer build wrote is left untouched, reads
//! see no accounts and writes refuse.

use std::io;
use std::path::Path;
use std::path::PathBuf;

use mixdog_statefile::Invalid;
use mixdog_statefile::Opts;
use mixdog_statefile::Peek;
use mixdog_statefile::StateError;
use serde_json::Value;
use serde_json::json;

use super::AccountError;
use super::MAX_ACCOUNTS;
use super::is_account_provider;
use super::valid_account_id;
use crate::oauth::CredentialIo;

pub(crate) fn empty_roster() -> Value {
    json!({ "version": 1, "providers": {} })
}

/// `validate` of `provider-accounts.mjs`: damage, or a newer build's roster.
fn validate(value: &Value) -> Result<(), Invalid> {
    let damaged = |why: &str| Invalid::Damaged(why.to_owned());
    let version = value.get("version");
    if let Some(v) = version.and_then(Value::as_u64)
        && v > 1
    {
        return Err(Invalid::Unsupported("Provider account settings are newer than this build.".to_owned()));
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

/// Node's token-file options: `{ mode: 0o600, secret, fsyncDir, backup }`.
fn write_opts() -> Opts {
    Opts { secret: true, fsync_dir: true, backup: true, ..Opts::default() }
}

/// The roster, or the empty one when missing, unsupported, or damaged with no
/// good copy. Never throws for damage. The first read is a read-lane job; a damaged
/// file is recovered under its lock on the durability lane, and while another writer
/// holds the lock for the whole wait it is left in place and the answer is the empty
/// roster.
pub(crate) async fn read_roster(io: &CredentialIo, path: PathBuf) -> io::Result<Value> {
    let first = path.clone();
    let peeked = io.read_job(move |lane| mixdog_statefile::peek(lane, &first, Some(&validate))).await?;
    match peeked {
        Peek::Value(value) => Ok(value),
        Peek::Absent | Peek::Unsupported => Ok(empty_roster()),
        Peek::Damaged(_) => {
            let recovered = io
                .write_job(move |lane| {
                    mixdog_statefile::read_json(lane, &path, Some(&validate), &Opts { secret: true, ..Opts::default() })
                })
                .await?;
            Ok(recovered.unwrap_or_else(empty_roster))
        }
    }
}

/// Read-modify-write under the file's lock (a durability-lane job body). A roster that parses
/// yet fails validation is recovered first, then the update runs: the replaced version is kept
/// as `<file>.bak` (damaged bytes never are). `mutate` changes the roster, which must validate.
pub(crate) fn update_roster(
    lane: &mixdog_rt::InLane<mixdog_rt::DurabilityIo>,
    path: &Path,
    mutate: impl FnOnce(&mut Value) -> Result<(), AccountError>,
) -> io::Result<Result<Value, AccountError>> {
    mixdog_statefile::read_json(lane, path, Some(&validate), &Opts { secret: true, ..Opts::default() })?;
    let updated = mixdog_statefile::update_json(
        lane,
        path,
        |current| {
            let mut roster = current.unwrap_or_else(empty_roster);
            match validate(&roster) {
                Err(Invalid::Unsupported(_)) => {
                    return Err(AccountError::Unsupported("Provider account settings are newer than this build.".into()));
                }
                Err(Invalid::Damaged(why)) => return Err(AccountError::Rejected(why)),
                Ok(()) => {}
            }
            mutate(&mut roster)?;
            if let Err(Invalid::Damaged(why) | Invalid::Unsupported(why)) = validate(&roster) {
                return Err(AccountError::Rejected(why));
            }
            Ok(Some(roster))
        },
        &write_opts(),
    );
    match updated {
        Ok(roster) => Ok(Ok(roster.unwrap_or_else(empty_roster))),
        Err(StateError::Mutator(error)) => Ok(Err(error)),
        Err(StateError::Io(error)) => Err(error),
        // `ELOCKTIMEOUT`: a write cannot go on without the lock.
        Err(StateError::Lock(error)) => Err(io::Error::new(io::ErrorKind::TimedOut, error.to_string())),
    }
}
