use std::path::Path;

use serde_json::Value;
use serde_json::json;

use super::*;
use crate::log::OsIo;
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

fn item(iid: &str, text: &str) -> Value {
    json!({"k":"item","iid":iid,"role":"user","form":"message","model":true,"visible":true,"refs":[],
        "body":{"inline":{"content":text,"role":"user"}}})
}

/// Two files: the session frame and two rows, then a checkpoint naming the second row as the context start and a row.
/// The first and the last row hold the secret.
fn write_log(data: &Path) {
    let dir = data.join("sessions").join(SESSION);
    std::fs::create_dir_all(&dir).unwrap();
    let mut first = Vec::new();
    frame(&mut first, 0, json!({"k":"session","v":2,"id":SESSION,"log_id":LOG_ID,"header":{"inline":{"title":"t"}}}));
    frame(&mut first, 1, item("a", &format!("{SECRET} is the code")));
    let context = frame(&mut first, 2, item("b", "sign in"));
    let mut second = Vec::new();
    frame(&mut second, 3, json!({"k":"checkpoint","state":{"inline":{"log_id":LOG_ID,"covers_ordinal":3,"history_rev":0,"rows":2,
        "visible_rows":2,"context":{"ordinal":2,"file_no":0,"offset":context},"runs":[],"approvals":[],"queue":[],"header":{"title":"t"}}}}));
    frame(&mut second, 4, item("c", &format!("yes, {SECRET} was accepted")));
    std::fs::write(dir.join(log_name(0)), first).unwrap();
    std::fs::write(dir.join(log_name(1)), second).unwrap();
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

fn files(data: &Path) -> Vec<Vec<u8>> {
    let dir = data.join("sessions").join(SESSION);
    list_logs(&dir).unwrap().into_iter().map(|n| std::fs::read(dir.join(log_name(n))).unwrap()).collect()
}

fn rewritten(data: &Path) {
    let staged = stage_with(data, SESSION, &OsIo, &BlobStore::new(data), &mut redact, &mut |_| Ok(())).unwrap().expect("a change");
    staged.commit_with(&mut |_| Ok(())).unwrap();
    std::fs::remove_dir_all(data.join(REWRITE_DIR).join(SESSION)).unwrap();
}

#[test]
fn the_rewritten_log_holds_the_marker_reads_whole_and_its_checkpoint_names_the_moved_frame() {
    let tmp = tempfile::tempdir().unwrap();
    write_log(tmp.path());
    rewritten(tmp.path());
    let dir = tmp.path().join("sessions").join(SESSION);
    for bytes in files(tmp.path()) {
        assert!(!bytes.windows(SECRET.len()).any(|w| w == SECRET.as_bytes()));
    }
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
    assert_eq!(records.iter().map(|(_, p, _)| p.ordinal).collect::<Vec<_>>(), [0, 1, 2, 3, 4]);
    let Record::Checkpoint(checkpoint) = &records[3].0 else { panic!("a checkpoint") };
    let Slot::Inline(state) = &checkpoint.state else { panic!("inline") };
    assert_eq!(state.context, Some(records[2].1), "the context start where the row is now");
    let Record::Item(row) = &records[1].0 else { panic!("a row") };
    assert_eq!(row.body, Slot::Inline(json!({"content": "[redacted] is the code", "role": "user"})));
    assert!(stage_with(tmp.path(), SESSION, &OsIo, &BlobStore::new(tmp.path()), &mut redact, &mut |_| Ok(())).unwrap().is_none(), "nothing left to take out");
}

/// A stop at any step of the rewrite, then the next start's recovery: the session holds its old log whole or its new
/// log whole, and no staging is left once the recovered rewrite is cleared.
#[test]
fn a_stop_at_any_step_leaves_the_old_log_whole_or_the_new_one() {
    let old = tempfile::tempdir().unwrap();
    write_log(old.path());
    let new = tempfile::tempdir().unwrap();
    write_log(new.path());
    rewritten(new.path());
    let (old_files, new_files) = (files(old.path()), files(new.path()));
    let steps = [Step::Stage(0), Step::Stage(1), Step::Commit, Step::Swap(0), Step::Swap(1)];
    for (at, stop) in steps.iter().copied().map(Some).chain([None]).enumerate() {
        let tmp = tempfile::tempdir().unwrap();
        write_log(tmp.path());
        let mut hook = |step: Step| if Some(step) == stop { Err(RewriteError::Stopped(step)) } else { Ok(()) };
        let staged = stage_with(tmp.path(), SESSION, &OsIo, &BlobStore::new(tmp.path()), &mut redact, &mut hook);
        let done = staged.and_then(|staged| staged.expect("a change").commit_with(&mut hook));
        assert_eq!(done.is_err(), stop.is_some(), "{stop:?}");
        let recovered = recover_with(tmp.path(), &mut |_| Ok(())).unwrap();
        let committed = at >= 3;
        assert_eq!(recovered, if committed { vec![SESSION.to_owned()] } else { Vec::new() }, "{stop:?}");
        assert_eq!(files(tmp.path()), if committed { new_files.clone() } else { old_files.clone() }, "{stop:?}");
        for session in recovered {
            remove_dir(&stage_dir(tmp.path(), &session)).unwrap();
        }
        assert_eq!(std::fs::read_dir(tmp.path().join(REWRITE_DIR)).map_or(0, Iterator::count), 0, "{stop:?}: no staging left");
    }
}
