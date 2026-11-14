//! The desktop's old pending-revoke record (`pc-access-revokes.json`, `pc-access.ts`
//! `pendingRevokesFile`) taken into the roster's owed access, once. The record held the access keys of
//! unpaired phones whose revoke was not confirmed yet, and an `unknown` marker while revocations may be
//! missing. The roster owes the same keys itself now, so what an upgrade finds in the file joins them
//! there; the file is then renamed to `.folded` (kept, never read again).

#![allow(clippy::disallowed_methods, reason = "the record is read and renamed only in a lane job (the caller proves the lane)")]

use std::path::Path;

use mixdog_rt::InLane;
use mixdog_store::fsio::WriteLane;
use serde_json::Value;

use crate::identity::roster::{MAX_OWED_KEYS, is_controller_key};
use crate::identity::{Roster, SecretError};
use crate::identity::secret::read_raw;

/// Under the data directory, where the desktop kept its own records.
const DIR: &str = "desktop";
const FILE: &str = "pc-access-revokes.json";
const FOLDED: &str = "pc-access-revokes.json.folded";

/// What the record said.
#[derive(Debug, PartialEq, Eq)]
struct Record {
    keys: Vec<String>,
    /// Revocations may be missing (an `unknown` marker, or a record that cannot be read).
    unknown: bool,
}

impl Record {
    fn damaged() -> Self {
        Self { keys: Vec::new(), unknown: true }
    }
}

/// `{ keys, unknown }` as `parsePending` read it; anything else is damage, whose revocations are unknown.
fn parse(bytes: &[u8]) -> Record {
    let Ok(Value::Object(object)) = serde_json::from_slice::<Value>(bytes) else { return Record::damaged() };
    let Some(Value::Array(listed)) = object.get("keys") else { return Record::damaged() };
    if listed.len() > MAX_OWED_KEYS {
        return Record::damaged();
    }
    let mut keys: Vec<String> = Vec::new();
    for key in listed {
        match key.as_str() {
            Some(key) if is_controller_key(key) => {
                if !keys.iter().any(|held| held == key) {
                    keys.push(key.to_owned());
                }
            }
            _ => return Record::damaged(),
        }
    }
    let unknown = match object.get("unknown") {
        None | Some(Value::Null) => false,
        Some(Value::Number(number)) if number.is_i64() || number.is_u64() => true,
        Some(_) => return Record::damaged(),
    };
    Record { keys, unknown }
}

/// Merges the old record under `data_dir` into the roster's owed access and renames it to `.folded`;
/// true when there was a record. A missing record changes nothing. The roster is written before the
/// rename, so a rename that fails leaves the record to be merged again (every key is held already, so
/// nothing is owed twice); an unreadable record is owed as unknown revocations, like a damaged one.
pub fn fold<L: WriteLane>(data_dir: &Path, roster: &mut Roster, lane: &InLane<L>) -> Result<bool, SecretError> {
    let path = data_dir.join(DIR).join(FILE);
    let record = match read_raw(lane, &path) {
        Ok(None) => return Ok(false),
        Ok(Some(bytes)) => parse(&bytes),
        Err(_) => Record::damaged(),
    };
    roster.owe_access(lane, &record.keys, record.unknown)?;
    std::fs::rename(&path, path.with_file_name(FOLDED))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use mixdog_rt::CancellationToken;

    use super::*;
    use crate::e2ee::generate_claim_key_pair;

    fn on_lane<R: Send + 'static>(job: impl FnOnce(&InLane<mixdog_rt::DurabilityIo>) -> R + Send + 'static) -> R {
        let out = Arc::new(Mutex::new(None));
        let slot = out.clone();
        mixdog_rt::testing::tokens()
            .durability_io
            .submit(&CancellationToken::new(), move |lane| {
                *slot.lock().unwrap() = Some(job(lane));
            })
            .unwrap();
        out.lock().unwrap().take().unwrap()
    }

    fn write_record(dir: &Path, text: &str) {
        std::fs::create_dir_all(dir.join(DIR)).unwrap();
        std::fs::write(dir.join(DIR).join(FILE), text).unwrap();
    }

    #[test]
    fn fold_merges_and_renames_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_path_buf();
        let (a, b) = (generate_claim_key_pair().public_key, generate_claim_key_pair().public_key);
        write_record(&path, &format!("{{\"keys\":[\"{a}\",\"{b}\",\"{a}\"],\"unknown\":null}}"));
        let roster_dir = path.join("remote");
        std::fs::create_dir_all(&roster_dir).unwrap();
        let (owed, again, reloaded) = on_lane({
            let (path, a) = (path.clone(), a.clone());
            move |lane| {
                let mut roster = Roster::load(lane, &roster_dir).unwrap();
                // One of the keys is owed by the roster already: it is not owed twice.
                roster.owe_access(lane, &[a], false).unwrap();
                assert!(fold(&path, &mut roster, lane).unwrap());
                let owed = roster.owed_access();
                let again = fold(&path, &mut roster, lane).unwrap();
                (owed, again, Roster::load(lane, &roster_dir).unwrap().owed_access())
            }
        });
        assert_eq!(owed.keys, vec![a, b]);
        assert_eq!(owed.unknown, 0);
        assert!(!again, "the record is folded once");
        assert_eq!(reloaded, owed, "the merge is durable");
        assert!(!path.join(DIR).join(FILE).exists());
        assert!(path.join(DIR).join(FOLDED).exists());
    }

    #[test]
    fn fold_keeps_the_unknown_marker_and_reads_damage_as_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_path_buf();
        let key = generate_claim_key_pair().public_key;
        assert_eq!(parse(format!("{{\"keys\":[\"{key}\"],\"unknown\":1700000000000}}").as_bytes()), Record { keys: vec![key], unknown: true });
        for damaged in ["not json", "[]", "{\"keys\":[\"short\"]}", "{\"keys\":{}}", "{\"keys\":[],\"unknown\":\"x\"}"] {
            assert_eq!(parse(damaged.as_bytes()), Record::damaged(), "{damaged}");
        }
        write_record(&path, "garbage");
        let roster_dir = path.join("remote");
        std::fs::create_dir_all(&roster_dir).unwrap();
        let owed = on_lane(move |lane| {
            let mut roster = Roster::load(lane, &roster_dir).unwrap();
            fold(&path, &mut roster, lane).unwrap();
            roster.owed_access()
        });
        assert_eq!((owed.keys.len(), owed.unknown), (0, 1));
    }

    #[test]
    fn fold_ignores_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_path_buf();
        let owed = on_lane(move |lane| {
            let mut roster = Roster::load(lane, &path).unwrap();
            assert!(!fold(&path, &mut roster, lane).unwrap());
            roster.owed_access()
        });
        assert_eq!((owed.keys.len(), owed.unknown), (0, 0));
        assert!(!dir.path().join(DIR).exists(), "nothing is created");
    }
}
