//! Twin test `journal`: the recording of Node's `core/journal.mjs` (`native/core/fixtures/office-journal/golden.json`,
//! written by `benchmarks/rust-core/recorders/record-office-journal.mjs`) against this crate: the data directory the
//! environment names, the journal files Node wrote read by Rust and the files Rust writes byte for byte, the listing
//! order, and the 30-day cleanup with its checkpoints and baseline PDFs. Re-recording, and Node reading what Rust
//! wrote, is `twin_live_journal` (ignored: it runs Node).

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_fsio::{OpenOptions, Unlaned};
use mixdog_office_base::data_dir::{JOURNAL_FOLDER, office_data_dir_from};
use mixdog_office_base::journal::{list_office_journals, read_office_journal, write_office_journal};
use mixdog_office_base::twin;
use mixdog_rt::{CancellationToken, DurabilityIo, InLane, LaneToken};
use serde_json::{Value, json};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

fn golden() -> Value {
    twin::load_golden("office-journal")
}

fn array<'a>(value: &'a Value, what: &str) -> &'a [Value] {
    value.as_array().unwrap_or_else(|| panic!("{what} is not an array"))
}

/// Runs `job` as a durability-lane job (the inline test backend runs it on this thread).
fn on_lane<R: Send + 'static>(job: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> R {
    let lanes = mixdog_rt::testing::tokens();
    tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("runtime")
        .block_on(async { lanes.durability_io.submit(&CancellationToken::new(), job).expect("submit").await.expect("job") })
}

fn write_record(record: &Value, dir: &Path) -> PathBuf {
    let (record, dir) = (record.clone(), dir.to_owned());
    on_lane(move |lane| write_office_journal(lane, &record, &dir).expect("write the journal"))
}

fn put(path: &Path, bytes: &[u8]) {
    if let Some(parent) = path.parent() {
        mixdog_fsio::create_dir_all(&Unlaned, parent).expect("folder");
    }
    mixdog_fsio::write(&Unlaned, path, bytes).expect("write");
}

fn slash(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Every file under `root`, relative and sorted.
fn files_under(root: &Path) -> Vec<String> {
    fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
        for entry in mixdog_fsio::read_dir(&Unlaned, dir).expect("list") {
            let path = entry.expect("entry").path();
            if mixdog_fsio::is_dir(&Unlaned, &path) {
                walk(&path, root, out);
            } else {
                out.push(slash(path.strip_prefix(root).expect("under root")));
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort();
    out
}

/// `new Date(ms).toISOString()`.
fn iso_time(ms: i64) -> String {
    let (days, rest) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
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

fn now_ms() -> i64 {
    i64::try_from(SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_millis()).expect("ms")
}

fn touch(path: &Path, age_days: i64) {
    let modified = SystemTime::now() - Duration::from_millis(u64::try_from(age_days * DAY_MS).expect("age"));
    let file = OpenOptions::new().write(true).open(&Unlaned, path).expect("open");
    file.set_modified(&Unlaned, modified).expect("set the modification time");
}

fn decode(value: &Value) -> Option<Vec<u8>> {
    value.as_str().map(|text| STANDARD.decode(text).expect("base64"))
}

#[test]
fn the_data_directory_follows_the_environment_as_node_does() {
    let golden = golden();
    let root = tempfile::tempdir().expect("root");
    let base = slash(root.path());
    let cwd = root.path().join("cwd");
    let home = root.path().join("home");
    let cases = array(&golden["dataDir"]["cases"], "cases");
    assert!(!cases.is_empty());
    for case in cases {
        let env: Vec<(String, String)> = case["env"]
            .as_object()
            .expect("env")
            .iter()
            .map(|(name, value)| (name.clone(), value.as_str().expect("text").replace("<root>", &base)))
            .collect();
        let dir = office_data_dir_from(
            &|name| env.iter().find(|(key, _)| key == name).map(|(_, value)| value.clone()),
            &|| Some(home.clone()),
            &cwd,
        )
        .expect("data directory");
        let shown = slash(&dir).replace(&base, "<root>");
        assert_eq!(shown, case["dir"].as_str().expect("dir"), "{}", case["env"]);
    }
    assert_eq!(golden["dataDir"]["home"], "<root>/home");
}

#[test]
fn journal_files_written_by_node_are_written_by_rust_byte_for_byte_and_read_back() {
    let golden = golden();
    for entry in array(&golden["journal"]["written"], "written") {
        let dir = tempfile::tempdir().expect("dir");
        let path = write_record(&entry["record"], dir.path());
        let text = String::from_utf8(mixdog_fsio::read(&Unlaned, &path).expect("file")).expect("utf8");
        assert_eq!(text, entry["text"].as_str().expect("text"), "{}", entry["record"]["id"]);
        let id = entry["record"]["id"].as_str().expect("id");
        assert_eq!(slash(&path), slash(&dir.path().join(JOURNAL_FOLDER).join(format!("{id}.json"))));
        assert_eq!(read_office_journal(&Unlaned, id, dir.path()).expect("read"), Some(entry["record"].clone()));
    }
}

#[test]
fn a_journal_file_reads_as_node_reads_it() {
    let golden = golden();
    for case in array(&golden["journal"]["reads"], "reads") {
        let dir = tempfile::tempdir().expect("dir");
        let name = case["name"].as_str().expect("name");
        if let Some(bytes) = decode(&case["bytes"]) {
            put(&dir.path().join(JOURNAL_FOLDER).join(format!("{name}.json")), &bytes);
        }
        let read = read_office_journal(&Unlaned, name, dir.path()).expect("read").unwrap_or(Value::Null);
        assert_eq!(read, case["value"], "{name}");
    }
}

#[test]
fn the_listing_order_and_what_it_skips_equal_nodes() {
    let golden = golden();
    let listing = &golden["journal"]["listing"];
    let dir = tempfile::tempdir().expect("dir");
    for file in array(&listing["files"], "files") {
        let path = dir.path().join(JOURNAL_FOLDER).join(file["name"].as_str().expect("name"));
        match decode(&file["bytes"]) {
            Some(bytes) => put(&path, &bytes),
            None => mixdog_fsio::create_dir_all(&Unlaned, &path).expect("folder"),
        }
    }
    let records = list_office_journals(&Unlaned, dir.path(), false).expect("list");
    assert_eq!(Value::Array(records), listing["records"]);
    let remaining: Vec<String> = array(&listing["remaining"], "remaining").iter().map(|name| name.as_str().expect("name").to_owned()).collect();
    assert_eq!(files_under(dir.path()), remaining);
}

fn retention_run(spec: &Value, cleanup: bool) -> (Vec<String>, Vec<String>) {
    let root = tempfile::tempdir().expect("root");
    let data = root.path().join("data");
    let side = root.path().join("side");
    mixdog_fsio::create_dir_all(&Unlaned, &side).expect("side");
    let now = now_ms();
    for record in array(&spec["records"], "records") {
        let id = record["id"].as_str().expect("id");
        let mut body = json!({ "version": 1, "id": id, "session": { "id": format!("office_{id}") }, "transaction": { "id": id } });
        if let Some(field) = record["field"].as_str() {
            body[field] = Value::from(iso_time(now - record["ageDays"].as_i64().expect("age") * DAY_MS));
        }
        for (key, ending, content) in [("checkpoint", "checkpoint", &b"checkpoint"[..]), ("baselinePdf", "pdf", &b"%PDF"[..])] {
            if record[key] == Value::Bool(true) {
                let file = side.join(format!("{id}.{ending}"));
                put(&file, content);
                body[key] = Value::from(file.display().to_string());
            }
        }
        let target = write_record(&body, &data);
        if let Some(age) = record["mtimeAgeDays"].as_i64() {
            touch(&target, age);
        }
    }
    for file in array(&spec["raw"], "raw") {
        let path = data.join(JOURNAL_FOLDER).join(file["name"].as_str().expect("name"));
        let bytes = match (file["nul"].as_u64(), file["text"].as_str()) {
            (Some(count), _) => vec![0; usize::try_from(count).expect("count")],
            (None, text) => text.expect("text").as_bytes().to_vec(),
        };
        put(&path, &bytes);
        touch(&path, file["mtimeAgeDays"].as_i64().expect("age"));
    }
    let kept = list_office_journals(&Unlaned, &data, cleanup).expect("list");
    let kept = kept.iter().map(|record| record["id"].as_str().unwrap_or("?").to_owned()).collect();
    (kept, files_under(root.path()))
}

#[test]
fn the_thirty_day_cleanup_removes_what_node_removes() {
    let golden = golden();
    let retention = &golden["journal"]["retention"];
    for (key, cleanup) in [("withCleanup", true), ("withoutCleanup", false)] {
        let (kept, remaining) = retention_run(&retention["spec"], cleanup);
        let strings = |value: &Value| -> Vec<String> { array(value, key).iter().map(|item| item.as_str().expect("text").to_owned()).collect() };
        assert_eq!(kept, strings(&retention[key]["kept"]), "{key}: the records kept");
        assert_eq!(remaining, strings(&retention[key]["remaining"]), "{key}: the files left");
    }
}

/// Records again with Node and replays; then Node reads the files Rust wrote:
/// `cargo test -p mixdog-office-base --test twin_journal -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/core/journal.mjs)"]
fn twin_live_journal() {
    let tree = twin::node_source_root();
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-journal.mjs", &tree);
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    the_data_directory_follows_the_environment_as_node_does();
    journal_files_written_by_node_are_written_by_rust_byte_for_byte_and_read_back();
    a_journal_file_reads_as_node_reads_it();
    the_listing_order_and_what_it_skips_equal_nodes();
    the_thirty_day_cleanup_removes_what_node_removes();

    // The other direction: Node lists and reads a data directory Rust wrote.
    let dir = tempfile::tempdir().expect("dir");
    let records = [
        json!({ "version": 1, "id": "office_tx_00000000000000aa", "updatedAt": "2026-03-01T10:20:30.456Z", "session": { "id": "s1", "path": "C:\\work\\a b.docx" }, "transaction": { "id": "t1" } }),
        json!({ "version": 1, "id": "office_tx_00000000000000bb", "updatedAt": "2026-03-05T00:00:00.000Z", "session": { "id": "s2", "title": "한글 \u{e9} \u{1f600} \"q\"" }, "transaction": { "ops": [1, 2.5, null, true, {}] } }),
        json!({ "id": "office_tx_00000000000000cc" }),
    ];
    for record in &records {
        write_record(record, dir.path());
    }
    let script = mixdog_office_base::twin::repo_root().join("benchmarks/rust-core/recorders/record-office-journal.mjs");
    let args: [&OsStr; 5] = [script.as_os_str(), OsStr::new("--tree"), tree.as_os_str(), OsStr::new("--read-dir"), dir.path().as_os_str()];
    let printed = mixdog_testkit::output("node", &args);
    let seen: Value = serde_json::from_str(printed.lines().last().expect("an answer")).expect("JSON");
    assert_eq!(seen["records"], json!([records[1], records[0], records[2]]));
    for record in &records {
        assert_eq!(seen["reads"][record["id"].as_str().expect("id")], *record);
    }
}
