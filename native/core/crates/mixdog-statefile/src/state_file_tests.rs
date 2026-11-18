//! What the state-file operations answer and leave in the directory: reads and their recovery of a damaged file,
//! updates under the file's lock, and the publication of JSON and text (formatting, backups, create-only).

use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::Value;
use serde_json::json;

use crate::*;

/// The directory's files by name, a quarantine's timestamp masked: `f.json.corrupt-<n>` is `f.json.corrupt-N`.
fn listing(dir: &std::path::Path) -> BTreeMap<String, Vec<u8>> {
    let mut files = BTreeMap::new();
    for entry in mixdog_testkit::entry_names(dir) {
        let name = entry.to_string_lossy().into_owned();
        if name.ends_with(".lock") {
            continue;
        }
        let masked = match name.rfind(".corrupt-") {
            Some(at) => format!("{}N", &name[..at + ".corrupt-".len()]),
            None => name.clone(),
        };
        files.insert(masked, mixdog_testkit::read(dir.join(&entry)));
    }
    files
}

fn setup(files: &[(&str, &str)]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for (name, bytes) in files {
        mixdog_testkit::write(dir.path().join(name), bytes);
    }
    dir
}

fn bytes(files: &BTreeMap<String, Vec<u8>>, name: &str) -> String {
    String::from_utf8_lossy(&files[name]).into_owned()
}

fn read_with(dir: &tempfile::TempDir, validate: Option<fn(&Value) -> Result<(), Invalid>>, opts: Opts) -> Option<Value> {
    let file = dir.path().join("f.json");
    crate::tests::on_lane(move |lane| {
        let check = validate.as_ref().map(|f| f as Validate);
        read_json(lane, &file, check, &opts).unwrap()
    })
}

fn plain() -> Opts {
    Opts { fsync: false, ..Opts::default() }
}

fn hold_lock_elsewhere(dir: &tempfile::TempDir) {
    mixdog_testkit::write(dir.path().join("f.json.lock"), format!("{} 1 other-token\n", std::process::id()));
}

#[test]
fn an_intact_file_reads_with_a_byte_order_mark_and_lossy_utf8() {
    let dir = setup(&[("f.json", "\u{FEFF}{\"a\":1}")]);
    assert_eq!(read_with(&dir, None, plain()), Some(json!({"a": 1})));
    let dir = setup(&[]);
    mixdog_testkit::write(dir.path().join("f.json"), b"{\"a\":\"\xFF\"}".to_vec());
    assert_eq!(read_with(&dir, None, plain()), Some(json!({"a": "\u{FFFD}"})));
    assert_eq!(listing(dir.path()).len(), 1, "a readable file is never moved");
}

#[test]
fn an_absent_file_answers_the_fallback_and_creates_nothing() {
    let dir = setup(&[]);
    assert_eq!(read_with(&dir, None, plain()), None);
    assert!(listing(dir.path()).is_empty());
}

#[test]
fn a_damaged_file_without_a_backup_is_set_aside() {
    let dir = setup(&[("f.json", "{\"a\":")]);
    assert_eq!(read_with(&dir, None, plain()), None);
    let files = listing(dir.path());
    assert_eq!(files.keys().collect::<Vec<_>>(), ["f.json.corrupt-N"]);
    assert_eq!(bytes(&files, "f.json.corrupt-N"), "{\"a\":");
}

#[test]
fn a_damaged_or_nul_filled_file_is_replaced_by_its_good_backup() {
    for damaged in ["{\"a\":", "\0\0\0\0"] {
        let dir = setup(&[("f.json", damaged), ("f.json.bak", "{\"b\":2}\n")]);
        assert_eq!(read_with(&dir, None, plain()), Some(json!({"b": 2})));
        let files = listing(dir.path());
        assert_eq!(bytes(&files, "f.json"), "{\"b\":2}\n");
        assert_eq!(bytes(&files, "f.json.bak"), "{\"b\":2}\n");
        assert_eq!(files["f.json.corrupt-N"], damaged.as_bytes(), "the damaged copy is kept");
    }
}

#[test]
fn a_damaged_backup_restores_nothing() {
    let dir = setup(&[("f.json", "{\"a\":"), ("f.json.bak", "{\"b\":")]);
    assert_eq!(read_with(&dir, None, plain()), None);
    let files = listing(dir.path());
    assert_eq!(files.keys().collect::<Vec<_>>(), ["f.json.bak", "f.json.corrupt-N"]);
}

#[test]
fn a_value_the_validator_refuses_is_damage() {
    fn object(v: &Value) -> Result<(), Invalid> {
        if v.is_object() { Ok(()) } else { Err(Invalid::Damaged("not an object".into())) }
    }
    let dir = setup(&[("f.json", "[1]"), ("f.json.bak", "{\"b\":2}\n")]);
    assert_eq!(read_with(&dir, Some(object), plain()), Some(json!({"b": 2})));
    assert_eq!(bytes(&listing(dir.path()), "f.json.corrupt-N"), "[1]");
}

#[test]
fn a_newer_builds_file_stays_in_place_and_is_not_restored_over() {
    fn versioned(v: &Value) -> Result<(), Invalid> {
        match v.get("version").and_then(Value::as_f64) {
            Some(version) if version > 1.0 => Err(Invalid::Unsupported("newer build".into())),
            Some(_) => Ok(()),
            None => Err(Invalid::Damaged("unreadable".into())),
        }
    }
    let dir = setup(&[("f.json", "{\"version\":2}\n"), ("f.json.bak", "{\"version\":1,\"x\":1}\n")]);
    assert_eq!(read_with(&dir, Some(versioned), plain()), None);
    let files = listing(dir.path());
    assert_eq!(files.keys().collect::<Vec<_>>(), ["f.json", "f.json.bak"]);
    assert_eq!(bytes(&files, "f.json"), "{\"version\":2}\n");
}

#[test]
fn restore_backup_off_sets_aside_and_keep_without_backup_leaves_the_file() {
    let dir = setup(&[("f.json", "{\"a\":"), ("f.json.bak", "{\"b\":2}\n")]);
    assert_eq!(read_with(&dir, None, Opts { restore_backup: false, ..plain() }), None);
    assert_eq!(listing(dir.path()).keys().collect::<Vec<_>>(), ["f.json.bak", "f.json.corrupt-N"]);

    let dir = setup(&[("f.json", "{\"a\":")]);
    assert_eq!(read_with(&dir, None, Opts { keep_without_backup: true, ..plain() }), None);
    assert_eq!(listing(dir.path()).keys().collect::<Vec<_>>(), ["f.json"]);

    let dir = setup(&[("f.json", "{\"a\":"), ("f.json.bak", "{\"b\":2}\n")]);
    assert_eq!(read_with(&dir, None, Opts { keep_without_backup: true, ..plain() }), Some(json!({"b": 2})));
}

#[test]
fn a_damaged_file_is_left_alone_while_another_holds_its_lock_but_an_intact_one_reads() {
    for wait in [Duration::ZERO, Duration::from_millis(100)] {
        let dir = setup(&[("f.json", "{\"a\":"), ("f.json.bak", "{\"b\":2}\n")]);
        hold_lock_elsewhere(&dir);
        assert_eq!(read_with(&dir, None, Opts { lock_timeout: Some(wait), ..plain() }), None);
        assert_eq!(listing(dir.path()).keys().collect::<Vec<_>>(), ["f.json", "f.json.bak"], "{wait:?}");
    }
    let dir = setup(&[("f.json", "{\"a\":1}\n")]);
    hold_lock_elsewhere(&dir);
    assert_eq!(read_with(&dir, None, Opts { lock_timeout: Some(Duration::ZERO), ..plain() }), Some(json!({"a": 1})));
}

fn update(dir: &tempfile::TempDir, opts: Opts, mutate: fn(Option<Value>) -> Result<Option<Value>, &'static str>) -> Result<Option<Value>, String> {
    let file = dir.path().join("f.json");
    crate::tests::on_lane(move |lane| {
        update_json(lane, &file, mutate, &opts).map_err(|error| match error {
            StateError::Mutator(code) => code.to_owned(),
            StateError::Lock(error) => error.code().unwrap_or("lock").to_owned(),
            StateError::Io(error) => error.to_string(),
        })
    })
}

fn wrap(current: Option<Value>) -> Result<Option<Value>, &'static str> {
    Ok(Some(json!({ "seen": current.unwrap_or(Value::Null) })))
}

#[test]
fn an_update_creates_an_absent_file_and_keeps_the_replaced_version_when_asked() {
    let dir = setup(&[]);
    assert_eq!(update(&dir, plain(), wrap), Ok(Some(json!({"seen": null}))));
    assert_eq!(listing(dir.path()).keys().collect::<Vec<_>>(), ["f.json"]);

    let dir = setup(&[("f.json", "{\"a\":1}\n")]);
    assert_eq!(update(&dir, Opts { backup: true, ..plain() }, wrap), Ok(Some(json!({"seen": {"a": 1}}))));
    let files = listing(dir.path());
    assert_eq!(bytes(&files, "f.json.bak"), "{\"a\":1}\n");
    assert_eq!(bytes(&files, "f.json"), "{\n  \"seen\": {\n    \"a\": 1\n  }\n}\n");
}

#[test]
fn an_update_that_changes_nothing_writes_nothing_and_answers_what_it_read() {
    let dir = setup(&[("f.json", "{\"a\":1}\n")]);
    assert_eq!(update(&dir, plain(), |_| Ok(None)), Ok(Some(json!({"a": 1}))));
    assert_eq!(bytes(&listing(dir.path()), "f.json"), "{\"a\":1}\n");
}

#[test]
fn an_update_of_a_damaged_file_feeds_the_mutator_the_backup_or_nothing() {
    let dir = setup(&[("f.json", "{\"a\":"), ("f.json.bak", "{\"b\":2}\n")]);
    assert_eq!(update(&dir, plain(), wrap), Ok(Some(json!({"seen": {"b": 2}}))));
    assert_eq!(bytes(&listing(dir.path()), "f.json.corrupt-N"), "{\"a\":");

    let dir = setup(&[("f.json", "{\"a\":")]);
    assert_eq!(update(&dir, plain(), wrap), Ok(Some(json!({"seen": null}))));
    assert_eq!(listing(dir.path()).keys().collect::<Vec<_>>(), ["f.json", "f.json.corrupt-N"]);

    let dir = setup(&[("f.json", "\0\0\0\0")]);
    assert_eq!(update(&dir, Opts { backup: true, ..plain() }, wrap), Ok(Some(json!({"seen": null}))));
    assert_eq!(listing(dir.path()).keys().collect::<Vec<_>>(), ["f.json", "f.json.corrupt-N"], "a NUL-filled file is no backup");

    let dir = setup(&[("f.json", "{\"a\":"), ("f.json.bak", "{\"b\":2}\n")]);
    assert_eq!(update(&dir, Opts { restore_backup: false, ..plain() }, wrap), Ok(Some(json!({"seen": null}))));

    let dir = setup(&[("f.json", "{\"a\":")]);
    assert_eq!(update(&dir, Opts { keep_without_backup: true, ..plain() }, wrap), Ok(Some(json!({"seen": null}))));
    assert_eq!(listing(dir.path()).keys().collect::<Vec<_>>(), ["f.json"]);
}

#[test]
fn a_refusing_mutator_writes_nothing_and_its_code_comes_back() {
    let dir = setup(&[("f.json", "{\"a\":1}\n")]);
    assert_eq!(update(&dir, Opts { backup: true, ..plain() }, |_| Err("EMUTATOR")), Err("EMUTATOR".to_owned()));
    assert_eq!(listing(dir.path()).keys().collect::<Vec<_>>(), ["f.json"]);
}

#[test]
fn an_update_behind_a_held_lock_fails_with_the_contention_or_timeout_code() {
    let dir = setup(&[("f.json", "{\"a\":1}\n")]);
    hold_lock_elsewhere(&dir);
    let busy = update(&dir, Opts { lock_timeout: Some(Duration::ZERO), ..plain() }, wrap);
    assert_eq!(busy, Err("ELOCKCONTENDED".to_owned()));
    let timed_out = update(&dir, Opts { lock_timeout: Some(Duration::from_millis(100)), ..plain() }, wrap);
    assert_eq!(timed_out, Err("ELOCKTIMEOUT".to_owned()));
    assert_eq!(bytes(&listing(dir.path()), "f.json"), "{\"a\":1}\n");
}

fn write_value(dir: &tempfile::TempDir, value: Value, opts: Opts) -> bool {
    let file = dir.path().join("f.json");
    crate::tests::on_lane(move |lane| write_json(lane, &file, &value, &opts).unwrap()) == Published::Written
}

#[test]
fn json_is_written_indented_or_compact_with_a_trailing_newline() {
    let dir = setup(&[]);
    assert!(write_value(&dir, json!({"a": [1, 2], "b": "x"}), plain()));
    assert_eq!(bytes(&listing(dir.path()), "f.json"), "{\n  \"a\": [\n    1,\n    2\n  ],\n  \"b\": \"x\"\n}\n");
    let dir = setup(&[]);
    assert!(write_value(&dir, json!({"a": [1, 2], "b": "x"}), Opts { compact: true, ..plain() }));
    assert_eq!(bytes(&listing(dir.path()), "f.json"), "{\"a\":[1,2],\"b\":\"x\"}\n");
    // Options that only change durability or locking leave the same file and no extra files.
    for opts in [Opts { fsync: false, ..Opts::default() }, Opts { fsync_dir: true, ..plain() }, Opts { lock: true, ..plain() }] {
        let dir = setup(&[]);
        assert!(write_value(&dir, json!({"a": 1}), opts));
        assert_eq!(listing(dir.path()).keys().collect::<Vec<_>>(), ["f.json"]);
    }
}

#[test]
fn a_json_backup_takes_the_replaced_version_only_when_it_holds_data() {
    let dir = setup(&[("f.json", "{\"a\":1}\n")]);
    write_value(&dir, json!({"c": 3}), Opts { backup: true, ..plain() });
    let files = listing(dir.path());
    assert_eq!(bytes(&files, "f.json.bak"), "{\"a\":1}\n");
    assert_eq!(bytes(&files, "f.json"), "{\n  \"c\": 3\n}\n");

    let dir = setup(&[("f.json", "{\"a\":1}\n"), ("f.json.bak", "{\"b\":2}\n")]);
    write_value(&dir, json!({"c": 3}), Opts { backup: true, ..plain() });
    assert_eq!(bytes(&listing(dir.path()), "f.json.bak"), "{\"a\":1}\n", "an older backup is replaced");

    for damaged in ["{\"a\":", "\0\0\0\0"] {
        let dir = setup(&[("f.json", damaged)]);
        write_value(&dir, json!({"c": 3}), Opts { backup: true, ..plain() });
        assert_eq!(listing(dir.path()).keys().collect::<Vec<_>>(), ["f.json"], "a damaged JSON file is no backup");
    }
}

fn write_text(dir: &tempfile::TempDir, text: &str, opts: Opts) -> Published {
    let file = dir.path().join("f.json");
    let text = text.to_owned();
    crate::tests::on_lane(move |lane| write_file(lane, &file, text.as_bytes(), &opts).unwrap())
}

#[test]
fn create_only_writes_an_absent_file_and_leaves_an_existing_one() {
    let dir = setup(&[]);
    assert_eq!(write_text(&dir, "hello", Opts { create_only: true, ..plain() }), Published::Written);
    assert_eq!(bytes(&listing(dir.path()), "f.json"), "hello");
    let dir = setup(&[("f.json", "old")]);
    assert_eq!(write_text(&dir, "hello", Opts { create_only: true, ..plain() }), Published::Exists);
    assert_eq!(listing(dir.path()).len(), 1);
    assert_eq!(bytes(&listing(dir.path()), "f.json"), "old");
}

#[test]
fn a_text_backup_keeps_any_text_but_not_a_nul_filled_file() {
    for kept in ["{\"a\":1}\n", "{\"a\":"] {
        let dir = setup(&[("f.json", kept)]);
        write_text(&dir, "new text", Opts { backup: true, ..plain() });
        let files = listing(dir.path());
        assert_eq!(files["f.json.bak"], kept.as_bytes());
        assert_eq!(bytes(&files, "f.json"), "new text");
    }
    let dir = setup(&[("f.json", "\0\0\0\0")]);
    write_text(&dir, "new text", Opts { backup: true, ..plain() });
    assert_eq!(listing(dir.path()).keys().collect::<Vec<_>>(), ["f.json"]);
    let dir = setup(&[("f.json", "old")]);
    write_text(&dir, "new text", plain());
    assert_eq!(listing(dir.path()).keys().collect::<Vec<_>>(), ["f.json"], "no backup unless asked for");
}
