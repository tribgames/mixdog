//! The Office transaction journal (`core/journal.mjs`): one JSON record per transaction at
//! `<dataDir>/office-transactions/<id>.json`, written atomically, read back as `None` when missing or damaged, listed
//! newest first with the records older than 30 days (and the checkpoint file and baseline PDF they name) removed.
//!
//! A record is the JSON object Node writes (`version` 1 with `session` and `transaction` objects, `id`, `updatedAt`,
//! `startedAt`, `checkpoint`, `baselinePdf`); journals already on users' disks are recovered from, so the record stays
//! a `serde_json::Value` and only the fields the journal itself reads are looked at. Every function takes the proof of
//! the lane job it runs in.

use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use mixdog_fsio::{ReadProof, WriteProof};
use mixdog_js::time::date_parse;
use mixdog_js::{json_parse, locale_compare, value_to_string};
use mixdog_rt::InLane;
use mixdog_statefile::{Opts, StateError, WriteLane, parse_json_text};
use serde_json::Value;

use crate::data_dir::{JOURNAL_FOLDER, default_office_data_dir, resolve_from_process_cwd};

/// A record untouched for this long is removed by the next listing.
pub const RETENTION_MS: f64 = 30.0 * 24.0 * 60.0 * 60.0 * 1000.0;

/// `join(resolve(dataDir || defaultOfficeDataDir()), 'office-transactions')`: an empty `data_dir` is the default
/// data directory.
pub fn office_journal_directory(data_dir: &Path) -> io::Result<PathBuf> {
    let dir = if data_dir.as_os_str().is_empty() { default_office_data_dir()? } else { resolve_from_process_cwd(data_dir)? };
    Ok(dir.join(JOURNAL_FOLDER))
}

fn journal_path(id: &str, data_dir: &Path) -> io::Result<PathBuf> {
    Ok(office_journal_directory(data_dir)?.join(format!("{id}.json")))
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |since| since.as_secs_f64() * 1000.0)
}

fn state_error(error: StateError) -> io::Error {
    match error {
        StateError::Io(error) => error,
        other => io::Error::other(other.to_string()),
    }
}

/// `rm(path, { force: true })`: a missing file is not an error.
fn remove_forced<P: WriteProof>(proof: &P, path: &Path) -> io::Result<()> {
    match mixdog_fsio::remove_file(proof, path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// `writeOfficeJournal`: the record as two-space JSON and a newline, published atomically (temp file and rename). The
/// file is named for `record.id`; answers its path.
pub fn write_office_journal<L: WriteLane>(lane: &InLane<L>, record: &Value, data_dir: &Path) -> io::Result<PathBuf> {
    let id = record.get("id").map_or_else(|| "undefined".to_owned(), value_to_string);
    let target = journal_path(&id, data_dir)?;
    mixdog_statefile::write_json(lane, &target, record, &Opts::default()).map_err(state_error)?;
    Ok(target)
}

/// `removeOfficeJournal`.
pub fn remove_office_journal<P: WriteProof>(proof: &P, id: &str, data_dir: &Path) -> io::Result<()> {
    remove_forced(proof, &journal_path(id, data_dir)?)
}

/// `readOfficeJournal`: the record, or `None` for a missing file and for one a crash left empty, NUL-filled or
/// otherwise unparsable (it stays on disk for the retention sweep and never blocks the caller). A leading byte order
/// mark is skipped.
pub fn read_office_journal<P: ReadProof>(proof: &P, id: &str, data_dir: &Path) -> io::Result<Option<Value>> {
    match mixdog_fsio::read(proof, journal_path(id, data_dir)?) {
        Ok(bytes) => Ok(parse_json_text(&bytes).ok()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// `listOfficeJournals`: the data directory's `office-transactions` folder is created, every `*.json` in it (in name
/// order) is parsed, and the records come back newest first by `updatedAt`. With `cleanup`, a record whose `updatedAt`
/// (else `startedAt`, else the file's modification time) is more than 30 days old is removed with the `checkpoint` file
/// and `baselinePdf` it names, and so is a file that does not parse and was last modified that long ago.
pub fn list_office_journals<P: WriteProof>(proof: &P, data_dir: &Path, cleanup: bool) -> io::Result<Vec<Value>> {
    list_at(proof, data_dir, cleanup, now_ms())
}

/// The text of `value || ''`, or `None` when it is falsy: a non-empty string, a number but zero, `true`, an array or an
/// object.
fn truthy_text(value: Option<&Value>) -> Option<String> {
    let value = value?;
    let truthy = match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(text) => !text.is_empty(),
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::Bool(true) | Value::Array(_) | Value::Object(_) => true,
    };
    truthy.then(|| value_to_string(value))
}

fn mtime_ms<P: ReadProof>(proof: &P, path: &Path) -> io::Result<f64> {
    let modified = mixdog_fsio::metadata(proof, path)?.modified()?;
    Ok(modified.duration_since(UNIX_EPOCH).map_or(0.0, |since| since.as_secs_f64() * 1000.0))
}

/// What one file of the folder came to.
enum Outcome {
    Kept(Value),
    Removed,
}

/// The `try` of the listing's loop: any error in it is the `catch`'s to handle.
fn examine<P: WriteProof>(proof: &P, path: &Path, cleanup: bool, now: f64) -> io::Result<Outcome> {
    let bytes = mixdog_fsio::read(proof, path)?;
    // `JSON.parse` of the file's text: a byte order mark is a syntax error here.
    let record = json_parse(&String::from_utf8_lossy(&bytes)).map_err(io::Error::other)?;
    // `record.updatedAt` of a JSON `null` is a TypeError.
    if record.is_null() {
        return Err(io::Error::other("null record"));
    }
    let stamped = truthy_text(record.get("updatedAt")).or_else(|| truthy_text(record.get("startedAt"))).unwrap_or_default();
    let parsed = date_parse(&stamped);
    let updated_at = if parsed.is_nan() || parsed == 0.0 { mtime_ms(proof, path)? } else { parsed };
    if cleanup && now - updated_at > RETENTION_MS {
        for field in ["checkpoint", "baselinePdf"] {
            if let Some(file) = truthy_text(record.get(field)) {
                let _ = remove_forced(proof, Path::new(&file));
            }
        }
        remove_forced(proof, path)?;
        return Ok(Outcome::Removed);
    }
    Ok(Outcome::Kept(record))
}

fn list_at<P: WriteProof>(proof: &P, data_dir: &Path, cleanup: bool, now: f64) -> io::Result<Vec<Value>> {
    let directory = office_journal_directory(data_dir)?;
    mixdog_fsio::create_dir_all(proof, &directory)?;
    let mut names = Vec::new();
    for entry in mixdog_fsio::read_dir(proof, &directory)? {
        let name = entry?.file_name().to_string_lossy().into_owned();
        if name.ends_with(".json") {
            names.push(name);
        }
    }
    names.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    let mut records = Vec::new();
    for name in names {
        let path = directory.join(&name);
        match examine(proof, &path, cleanup, now) {
            Ok(Outcome::Kept(record)) => records.push(record),
            Ok(Outcome::Removed) => {}
            Err(_) => {
                // A file that does not parse waits for the retention sweep.
                if cleanup && mtime_ms(proof, &path).is_ok_and(|modified| now - modified > RETENTION_MS) {
                    remove_forced(proof, &path)?;
                }
            }
        }
    }
    let mut keyed: Vec<(String, Value)> = records
        .into_iter()
        .map(|record| (truthy_text(record.get("updatedAt")).unwrap_or_default(), record))
        .collect();
    keyed.sort_by(|left, right| locale_compare(&right.0, &left.0));
    Ok(keyed.into_iter().map(|(_, record)| record).collect())
}

#[cfg(test)]
mod tests {
    use mixdog_fsio::Unlaned;
    use mixdog_rt::{CancellationToken, DurabilityIo, LaneToken};
    use serde_json::json;

    use super::*;

    const DAY_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

    /// Runs `job` as a durability-lane job (the inline test backend runs it on this thread).
    fn on_lane<R: Send + 'static>(job: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> R {
        let lanes = mixdog_rt::testing::tokens();
        tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime")
            .block_on(async { lanes.durability_io.submit(&CancellationToken::new(), job).expect("submit").await.expect("job") })
    }

    fn write(record: &Value, dir: &Path) -> PathBuf {
        let (record, dir) = (record.clone(), dir.to_owned());
        on_lane(move |lane| write_office_journal(lane, &record, &dir).expect("write"))
    }

    /// `new Date(ms).toISOString()`.
    fn iso_time(ms: i64) -> String {
        let (days, rest) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
        // Civil date of a day count (days since 1970-01-01).
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let day_of_era = z.rem_euclid(146_097);
        let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
        let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
        let shifted_month = (5 * day_of_year + 2) / 153;
        let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
        let month = if shifted_month < 10 { shifted_month + 3 } else { shifted_month - 9 };
        let year = year_of_era + era * 400 + i64::from(month <= 2);
        let (hour, minute, second, milli) = (rest / 3_600_000, rest / 60_000 % 60, rest / 1000 % 60, rest % 1000);
        format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milli:03}Z")
    }

    fn put(dir: &Path, name: &str, bytes: &[u8]) {
        let folder = dir.join(JOURNAL_FOLDER);
        mixdog_fsio::create_dir_all(&Unlaned, &folder).expect("dir");
        mixdog_fsio::write(&Unlaned, folder.join(name), bytes).expect("put");
    }

    fn ids(records: &[Value]) -> Vec<String> {
        records.iter().map(|record| record["id"].as_str().unwrap_or("?").to_owned()).collect()
    }

    // Port of `a NUL-filled office journal reads as absent and does not block the listing` (core/journal.test.mjs).
    #[test]
    fn a_nul_filled_office_journal_reads_as_absent_and_does_not_block_the_listing() {
        let dir = tempfile::tempdir().expect("dir");
        write(&json!({ "id": "good", "updatedAt": "2026-03-01T00:00:00.000Z" }), dir.path());
        put(dir.path(), "bad.json", &[0; 32]);
        assert_eq!(read_office_journal(&Unlaned, "bad", dir.path()).expect("read"), None);
        assert_eq!(read_office_journal(&Unlaned, "good", dir.path()).expect("read").expect("record")["id"], "good");
        assert_eq!(ids(&list_at(&Unlaned, dir.path(), true, now_ms()).expect("list")), ["good"]);
    }

    #[test]
    fn a_record_is_two_space_json_and_a_newline_and_reads_back() {
        let dir = tempfile::tempdir().expect("dir");
        let record = json!({ "version": 1, "id": "office_tx_1", "session": { "id": "office_1" }, "updatedAt": "2026-03-01T00:00:00.000Z" });
        let path = write(&record, dir.path());
        assert_eq!(path, dir.path().join(JOURNAL_FOLDER).join("office_tx_1.json"));
        let text = String::from_utf8(mixdog_fsio::read(&Unlaned, &path).expect("file")).expect("utf8");
        assert_eq!(text, format!("{}\n", serde_json::to_string_pretty(&record).expect("json")));
        assert_eq!(read_office_journal(&Unlaned, "office_tx_1", dir.path()).expect("read"), Some(record));
        remove_office_journal(&Unlaned, "office_tx_1", dir.path()).expect("remove");
        remove_office_journal(&Unlaned, "office_tx_1", dir.path()).expect("remove again");
        assert_eq!(read_office_journal(&Unlaned, "office_tx_1", dir.path()).expect("read"), None);
    }

    #[test]
    fn a_missing_empty_invalid_or_bom_file_reads_without_failing() {
        let dir = tempfile::tempdir().expect("dir");
        assert_eq!(read_office_journal(&Unlaned, "none", dir.path()).expect("read"), None);
        put(dir.path(), "empty.json", b"");
        put(dir.path(), "bad.json", b"{not json");
        put(dir.path(), "bom.json", b"\xef\xbb\xbf{\"id\":\"bom\"}");
        assert_eq!(read_office_journal(&Unlaned, "empty", dir.path()).expect("read"), None);
        assert_eq!(read_office_journal(&Unlaned, "bad", dir.path()).expect("read"), None);
        assert_eq!(read_office_journal(&Unlaned, "bom", dir.path()).expect("read"), Some(json!({ "id": "bom" })));
    }

    #[test]
    fn the_listing_is_newest_first_and_skips_what_does_not_parse() {
        let dir = tempfile::tempdir().expect("dir");
        put(dir.path(), "a.json", br#"{"id":"a","updatedAt":"2026-03-01T00:00:00.000Z"}"#);
        put(dir.path(), "b.json", br#"{"id":"b","updatedAt":"2026-03-05T00:00:00.000Z"}"#);
        put(dir.path(), "c.json", br#"{"id":"c"}"#);
        put(dir.path(), "d.json", b"garbage");
        put(dir.path(), "e.txt", br#"{"id":"e"}"#);
        put(dir.path(), "f.json", b"\xef\xbb\xbf{\"id\":\"f\"}");
        put(dir.path(), "g.json", b"null");
        put(dir.path(), "i.json", br#"{"id":"i","updatedAt":"2026-03-01T00:00:00.000Z"}"#);
        let listed = list_at(&Unlaned, dir.path(), false, now_ms()).expect("list");
        assert_eq!(ids(&listed), ["b", "a", "i", "c"]);
    }

    #[test]
    fn records_older_than_thirty_days_go_with_their_checkpoint_and_baseline() {
        let dir = tempfile::tempdir().expect("dir");
        let now = now_ms();
        let stamp = |days: f64| iso_time((now - days * DAY_MS) as i64);
        let side = dir.path().join("side");
        mixdog_fsio::create_dir_all(&Unlaned, &side).expect("dir");
        let checkpoint = side.join("old.ck");
        let baseline = side.join("old.pdf");
        mixdog_fsio::write(&Unlaned, &checkpoint, b"ck").expect("ck");
        mixdog_fsio::write(&Unlaned, &baseline, b"pdf").expect("pdf");
        let keep = side.join("keep.ck");
        mixdog_fsio::write(&Unlaned, &keep, b"ck").expect("ck");
        write(&json!({ "id": "fresh", "updatedAt": stamp(1.0), "checkpoint": keep.display().to_string() }), dir.path());
        write(&json!({ "id": "month", "updatedAt": stamp(29.0) }), dir.path());
        write(&json!({ "id": "old", "updatedAt": stamp(31.0), "checkpoint": checkpoint.display().to_string(), "baselinePdf": baseline.display().to_string() }), dir.path());
        write(&json!({ "id": "started", "startedAt": stamp(45.0) }), dir.path());
        let kept = list_at(&Unlaned, dir.path(), true, now).expect("list");
        assert_eq!(ids(&kept), ["fresh", "month"]);
        assert!(!mixdog_fsio::exists(&Unlaned, &checkpoint).expect("exists"));
        assert!(!mixdog_fsio::exists(&Unlaned, &baseline).expect("exists"));
        assert!(mixdog_fsio::exists(&Unlaned, &keep).expect("exists"));
        assert!(!mixdog_fsio::exists(&Unlaned, dir.path().join(JOURNAL_FOLDER).join("old.json")).expect("exists"));
        assert!(!mixdog_fsio::exists(&Unlaned, dir.path().join(JOURNAL_FOLDER).join("started.json")).expect("exists"));
    }

    #[test]
    fn the_listing_without_cleanup_keeps_old_records() {
        let dir = tempfile::tempdir().expect("dir");
        write(&json!({ "id": "old", "updatedAt": "2001-01-01T00:00:00.000Z" }), dir.path());
        assert_eq!(ids(&list_at(&Unlaned, dir.path(), false, now_ms()).expect("list")), ["old"]);
        assert_eq!(ids(&list_at(&Unlaned, dir.path(), true, now_ms()).expect("list")), Vec::<String>::new());
    }
}
