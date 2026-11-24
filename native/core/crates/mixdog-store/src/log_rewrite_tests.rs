use std::path::Path;

use serde_json::Value;
use serde_json::json;

use super::*;
use crate::log::OsIo;
use crate::schema::bounded::Digest;
use crate::schema::record::Record;

const LOG_ID: &str = "4f1c2a9e0b7d3c5a6e8f9012";
const SECRET: &str = "482913";
const SESSION: &str = "sess_rewrite";

fn frame(out: &mut Vec<u8>, ordinal: u64, record: Value) -> u64 {
    let offset = out.len() as u64;
    let encoded = encode_record(serde_json::from_value(record).expect("record")).expect("encodes");
    framing::encode_into(out, ordinal, encoded.payload());
    offset
}

/// A frame whose body goes out of line; its blob is published as the writer publishes it. The blob's digest.
fn blob_frame(data: &Path, out: &mut Vec<u8>, ordinal: u64, record: Value) -> Digest {
    let encoded = encode_record(serde_json::from_value(record).expect("record")).expect("encodes");
    let blob = encoded.blobs().first().expect("an out-of-line body").clone();
    drop(BlobStore::new(data).put_unlaned(&blob.bytes, |p, b| OsIo.publish(p, b)).unwrap());
    framing::encode_into(out, ordinal, encoded.payload());
    blob.digest
}

fn item(iid: &str, text: &str) -> Value {
    json!({"k":"item","iid":iid,"role":"user","form":"message","model":true,"visible":true,"refs":[],
        "body":{"inline":{"content":text,"role":"user"}}})
}

/// Two files: the session frame and two rows, then a checkpoint naming the second row as the context start, a row
/// and a row whose body is out of line. The first and the last two rows hold the secret. The out-of-line body's digest.
fn write_log(data: &Path) -> Digest {
    let dir = data.join("sessions").join(SESSION);
    std::fs::create_dir_all(&dir).unwrap();
    let mut first = Vec::new();
    frame(&mut first, 0, json!({"k":"session","v":2,"id":SESSION,"log_id":LOG_ID,"header":{"inline":{"title":"t"}}}));
    frame(&mut first, 1, item("a", &format!("{SECRET} is the code")));
    let context = frame(&mut first, 2, item("b", "sign in"));
    let mut second = Vec::new();
    frame(
        &mut second,
        3,
        json!({"k":"checkpoint","state":{"inline":{"log_id":LOG_ID,"covers_ordinal":3,"history_rev":0,"rows":2,
        "visible_rows":2,"context":{"ordinal":2,"file_no":0,"offset":context},"runs":[],"approvals":[],"queue":[],"header":{"title":"t"}}}}),
    );
    frame(&mut second, 4, item("c", &format!("yes, {SECRET} was accepted")));
    let long = format!("{} {SECRET}", "x".repeat(mixdog_protocol::INLINE_MAX));
    let digest = blob_frame(data, &mut second, 5, item("d", &long));
    std::fs::write(dir.join(log_name(0)), first).unwrap();
    std::fs::write(dir.join(log_name(1)), second).unwrap();
    digest
}

/// The secret's rows with the marker.
fn redact(record: &Record) -> Option<Record> {
    let Record::Item(row) = record else { return None };
    let Slot::Inline(body) = &row.body else { return None };
    let text = body["content"].as_str()?;
    text.contains(SECRET).then(|| {
        let mut row = row.clone();
        row.body = Slot::Inline(json!({"content": text.replace(SECRET, "[redacted]"), "role": "user"}));
        Record::Item(row)
    })
}

/// The session's log files, `None` when its folder is not there.
fn files(data: &Path) -> Option<Vec<Vec<u8>>> {
    let dir = data.join("sessions").join(SESSION);
    dir.is_dir().then(|| list_logs(&dir).unwrap().into_iter().map(|n| std::fs::read(dir.join(log_name(n))).unwrap()).collect())
}

fn holds_secret(bytes: &[u8]) -> bool {
    bytes.windows(SECRET.len()).any(|w| w == SECRET.as_bytes())
}

/// The index step as the store runs it, less the rows.
fn index_step(_data: &Path) -> impl FnMut() -> Result<(), String> {
    || Ok(())
}

/// The last record of the session's log.
fn last_record(data: &Path) -> Record {
    let dir = data.join("sessions").join(SESSION);
    let (mut from, mut last) = (FramePos { ordinal: 0, file_no: 0, offset: 0 }, None);
    loop {
        let read = read_forward_unlaned(&dir, from, u64::MAX).unwrap();
        last = read.frames.into_iter().last().map(|(record, _, _)| record).or(last);
        match read.next {
            ForwardEnd::More(next) => from = next,
            _ => break last.expect("a record"),
        }
    }
}

fn rewritten(data: &Path) {
    let blobs = BlobStore::new(data);
    assert!(plan_with(data, SESSION, &OsIo, &blobs, &mut redact, &mut |_| Ok(())).unwrap(), "a change");
    settle_with(data, SESSION, &OsIo, &blobs, &mut index_step(data), &mut |_| Ok(())).unwrap();
}

#[test]
fn the_rewritten_log_holds_the_marker_reads_whole_and_its_checkpoint_names_the_moved_frame() {
    let tmp = tempfile::tempdir().unwrap();
    let plain = write_log(tmp.path());
    rewritten(tmp.path());
    let dir = tmp.path().join("sessions").join(SESSION);
    for bytes in files(tmp.path()).unwrap() {
        assert!(!holds_secret(&bytes));
    }
    assert!(BlobStore::new(tmp.path()).path(&plain).is_file(), "the rewrite deletes no blob");
    assert!(!tmp.path().join(REWRITE_DIR).join(SESSION).exists());
    let mut records = Vec::new();
    let mut from = FramePos { ordinal: 0, file_no: 0, offset: 0 };
    loop {
        let read = read_forward_unlaned(&dir, from, u64::MAX).unwrap();
        records.extend(read.frames);
        match read.next {
            ForwardEnd::More(next) => from = next,
            ForwardEnd::Done { torn, .. } => break assert!(!torn),
            ForwardEnd::Damaged(d) => panic!("damaged at {d:?}"),
        }
    }
    assert_eq!(records.iter().map(|(_, p, _)| p.ordinal).collect::<Vec<_>>(), [0, 1, 2, 3, 4, 5]);
    let Record::Checkpoint(checkpoint) = &records[3].0 else { panic!("a checkpoint") };
    let Slot::Inline(state) = &checkpoint.state else { panic!("inline") };
    assert_eq!(state.context, Some(records[2].1), "the context start where the row is now");
    let Record::Item(row) = &records[1].0 else { panic!("a row") };
    assert_eq!(row.body, Slot::Inline(json!({"content": "[redacted] is the code", "role": "user"})));
    let Record::Item(row) = &records[5].0 else { panic!("a row") };
    let Slot::Blob(blob) = &row.body else { panic!("still out of line") };
    let body = BlobStore::new(tmp.path()).read_unlaned(&blob.descriptor().digest).unwrap();
    assert!(!holds_secret(&body), "the new out-of-line body holds the marker");
    assert_eq!(row.refs.as_slice(), [blob.descriptor().digest.clone()], "the row names its new blob only");
    assert!(!plan_with(tmp.path(), SESSION, &OsIo, &BlobStore::new(tmp.path()), &mut redact, &mut |_| Ok(())).unwrap(), "nothing left to take out");
}

/// A checkpoint keeps a large header value out of line (`CheckpointState::header_blobs`), its place in the header null.
/// The rewrite hands the redactor the value, not the null, and the rewritten checkpoint names a blob holding the marker.
/// Given the null, nothing was found to redact: the checkpoint went on naming the blob with the secret, and the next open
/// restored the header from it.
#[test]
fn a_header_value_a_checkpoint_keeps_out_of_line_is_redacted_and_written_out_of_line_again() {
    const KEY: &str = "_repeatFailHistory";
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("sessions").join(SESSION);
    std::fs::create_dir_all(&dir).unwrap();
    let blobs = BlobStore::new(tmp.path());
    let mut log = Vec::new();
    frame(&mut log, 0, json!({"k":"session","v":2,"id":SESSION,"log_id":LOG_ID,"header":{"inline":{"title":"t"}}}));
    frame(&mut log, 1, item("a", "sign in"));
    let history = format!("{} {SECRET}", "x".repeat(crate::schema::checkpoint::HEADER_BLOB_MIN));
    let checkpoint = json!({"k":"checkpoint","state":{"inline":{"log_id":LOG_ID,"covers_ordinal":2,"history_rev":0,"rows":1,
        "visible_rows":1,"runs":[],"approvals":[],"queue":[],"header":{"title":"t",KEY:history}}}});
    let encoded = encode_record(serde_json::from_value(checkpoint).expect("record")).expect("encodes");
    for blob in encoded.blobs() {
        drop(blobs.put_unlaned(&blob.bytes, |p, b| OsIo.publish(p, b)).unwrap());
    }
    framing::encode_into(&mut log, 2, encoded.payload());
    std::fs::write(dir.join(log_name(0)), log).unwrap();
    let held = |record: &Record| {
        let Record::Checkpoint(checkpoint) = record else { panic!("a checkpoint: {record:?}") };
        let Slot::Inline(state) = &checkpoint.state else { panic!("inline") };
        assert!(state.header[KEY].is_null(), "the value's place in the header");
        let blob = state.header_blobs.get(KEY).expect("the value is out of line");
        blobs.read_unlaned(&blob.descriptor().digest).unwrap()
    };
    assert!(holds_secret(&held(&last_record(tmp.path()))), "the log as written keeps the secret in the checkpoint's blob");

    let mut redact = |record: &Record| {
        let Record::Checkpoint(checkpoint) = record else { return None };
        let Slot::Inline(state) = &checkpoint.state else { return None };
        let text = state.header.get(KEY)?.as_str()?;
        text.contains(SECRET).then(|| {
            let mut state = state.clone();
            state.header.insert(KEY.into(), json!(text.replace(SECRET, "[redacted]")));
            Record::Checkpoint(CheckpointRecord { state: Slot::Inline(state) })
        })
    };
    assert!(plan_with(tmp.path(), SESSION, &OsIo, &blobs, &mut redact, &mut |_| Ok(())).unwrap(), "the redactor is given the value");
    settle_with(tmp.path(), SESSION, &OsIo, &blobs, &mut index_step(tmp.path()), &mut |_| Ok(())).unwrap();
    let value = held(&last_record(tmp.path()));
    assert!(!holds_secret(&value) && String::from_utf8(value).unwrap().ends_with("[redacted]\""), "the checkpoint names the redacted value");
    for bytes in files(tmp.path()).unwrap() {
        assert!(!holds_secret(&bytes));
    }
    assert!(!plan_with(tmp.path(), SESSION, &OsIo, &blobs, &mut redact, &mut |_| Ok(())).unwrap(), "nothing left to take out");
}

const STEPS: [Step; 10] = [
    Step::Intent,
    Step::Build(0),
    Step::Build(1),
    Step::Built,
    Step::MoveOld,
    Step::MoveNew,
    Step::Index,
    Step::DropIntent,
    Step::DropFolder,
    // Not a step: the run that is not stopped.
    Step::DropFolder,
];

#[test]
fn a_kill_at_any_step_leaves_one_whole_log_and_the_next_start_finishes_the_rewrite() {
    let old = tempfile::tempdir().unwrap();
    write_log(old.path());
    let new = tempfile::tempdir().unwrap();
    write_log(new.path());
    rewritten(new.path());
    let (old_files, new_files) = (files(old.path()).unwrap(), files(new.path()).unwrap());
    assert_ne!(old_files, new_files);
    for (at, step) in STEPS.iter().copied().enumerate() {
        let stop = (at < STEPS.len() - 1).then_some(step);
        let tmp = tempfile::tempdir().unwrap();
        let plain = write_log(tmp.path());
        let blobs = BlobStore::new(tmp.path());
        let mut hook = |step: Step| if Some(step) == stop { Err(RewriteError::Stopped(step)) } else { Ok(()) };
        let done = plan_with(tmp.path(), SESSION, &OsIo, &blobs, &mut redact, &mut hook)
            .and_then(|_| settle_with(tmp.path(), SESSION, &OsIo, &blobs, &mut index_step(tmp.path()), &mut hook));
        assert_eq!(done.is_err(), stop.is_some(), "{stop:?}");
        let killed = files(tmp.path());
        let moved_out = matches!(stop, Some(Step::MoveNew));
        assert!(
            killed.as_ref() == Some(&old_files) || killed.as_ref() == Some(&new_files) || (moved_out && killed.is_none()),
            "{stop:?}: the session folder after the kill"
        );
        // The next start: a fresh store.
        let blobs = BlobStore::new(tmp.path());
        for session in recover_with(tmp.path(), &OsIo, &blobs, &mut |_| Ok(())).unwrap() {
            finish_with(tmp.path(), &session, &mut index_step(tmp.path()), &mut |_| Ok(())).unwrap();
        }
        let decided = stop != Some(Step::Intent);
        assert_eq!(files(tmp.path()).unwrap(), if decided { new_files.clone() } else { old_files.clone() }, "{stop:?}");
        assert!(blobs.path(&plain).is_file(), "{stop:?}: the plain out-of-line body is kept (the rewrite deletes nothing)");
        if decided {
            let Record::Item(row) = last_record(tmp.path()) else { panic!("a row") };
            let Slot::Blob(blob) = &row.body else { panic!("out of line") };
            assert!(blobs.read_unlaned(&blob.descriptor().digest).is_ok(), "{stop:?}: the new body is stored");
        }
        assert_eq!(std::fs::read_dir(tmp.path().join(REWRITE_DIR)).map_or(0, Iterator::count), 0, "{stop:?}: no rewrite part left");
    }
}

/// A session that goes on writing after a rewrite stopped before its swap (in this process: the rename was refused)
/// is rebuilt from its log as it is then, the later frames kept.
#[test]
fn a_rewrite_built_again_keeps_the_frames_written_after_its_plan() {
    let tmp = tempfile::tempdir().unwrap();
    write_log(tmp.path());
    let blobs = BlobStore::new(tmp.path());
    let mut stop = |step: Step| if step == Step::MoveOld { Err(RewriteError::Stopped(step)) } else { Ok(()) };
    plan_with(tmp.path(), SESSION, &OsIo, &blobs, &mut redact, &mut |_| Ok(())).unwrap();
    assert!(settle_with(tmp.path(), SESSION, &OsIo, &blobs, &mut index_step(tmp.path()), &mut stop).is_err());
    let dir = tmp.path().join("sessions").join(SESSION);
    let mut later = std::fs::read(dir.join(log_name(1))).unwrap();
    frame(&mut later, 6, item("e", "written after the plan"));
    std::fs::write(dir.join(log_name(1)), &later).unwrap();
    settle_with(tmp.path(), SESSION, &OsIo, &blobs, &mut index_step(tmp.path()), &mut |_| Ok(())).unwrap();
    let last = files(tmp.path()).unwrap().pop().unwrap();
    assert!(!holds_secret(&last));
    assert!(last.windows(22).any(|w| w == b"written after the plan"));
}

/// A group file's head names its members' length and SHA-256: a member rewritten re-seals the head, so the file still
/// reads whole with the redacted member.
#[test]
fn a_rewritten_member_of_a_group_file_keeps_the_file_readable() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("sessions").join(SESSION);
    std::fs::create_dir_all(&dir).unwrap();
    let mut first = Vec::new();
    frame(&mut first, 0, json!({"k":"session","v":2,"id":SESSION,"log_id":LOG_ID,"header":{"inline":{"title":"t"}}}));
    frame(&mut first, 1, item("x", "sign in"));
    std::fs::write(dir.join(log_name(0)), first).unwrap();
    let mut members = Vec::new();
    frame(&mut members, 3, item("a", &format!("{SECRET} is the code")));
    frame(&mut members, 4, item("b", "fine"));
    let checkpoint = encode_record(
        serde_json::from_value(json!({"k":"checkpoint","state":{"inline":{"log_id":LOG_ID,"covers_ordinal":2,"history_rev":0,"rows":2,
            "visible_rows":2,"runs":[],"approvals":[],"queue":[],"header":{"title":"t"}}}}))
        .expect("record"),
    )
    .expect("encodes");
    let mut group = Vec::new();
    framing::encode_into(&mut group, 2, &group_file_head(2, &members, checkpoint.payload()));
    group.extend_from_slice(&members);
    std::fs::write(dir.join(log_name(2)), group).unwrap();

    rewritten(tmp.path());

    for bytes in files(tmp.path()).unwrap() {
        assert!(!holds_secret(&bytes));
    }
    let mut rows = Vec::new();
    let mut from = FramePos { ordinal: 0, file_no: 0, offset: 0 };
    loop {
        let read = read_forward_unlaned(&dir, from, u64::MAX).unwrap();
        rows.extend(read.frames);
        match read.next {
            ForwardEnd::More(next) => from = next,
            ForwardEnd::Done { torn, .. } => break assert!(!torn),
            ForwardEnd::Damaged(d) => panic!("damaged at {d:?}"),
        }
    }
    assert_eq!(rows.iter().map(|(_, p, _)| p.ordinal).collect::<Vec<_>>(), [0, 1, 2, 3, 4]);
    let Record::Item(row) = &rows[3].0 else { panic!("a row") };
    assert_eq!(row.body, Slot::Inline(json!({"content": "[redacted] is the code", "role": "user"})));
}
