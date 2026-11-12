//! Every record kind has a decision on how a value marked sensitive is stored: the projection
//! (`SensitiveMarksOf::projected`) and the log rewrite (`log_rewrite::inline`, `slot_digests`) match every kind with no
//! wildcard, and this test holds one sample per kind, so a new kind fails here until it is decided and sampled.

use std::sync::Arc;

use mixdog_core_api::ids::ThreadId;
use mixdog_store::schema::record::Record;
use serde_json::Value;
use serde_json::json;

use super::seams::SensitiveMarks;
use super::store::SensitiveMarksOf;

const CODE: &str = "482913";
const LOG_ID: &str = "4f1c2a9e0b7d3c5a6e8f9012";

/// Each kind's place in [`samples`]; the match has no wildcard.
fn kind(record: &Record) -> usize {
    match record {
        Record::Session(_) => 0,
        Record::Meta(_) => 1,
        Record::Item(_) => 2,
        Record::Amend(_) => 3,
        Record::Rewind(_) => 4,
        Record::Compacted(_) => 5,
        Record::Run(_) => 6,
        Record::Approval(_) => 7,
        Record::Queue(_) => 8,
        Record::Op(_) => 9,
        Record::Checkpoint(_) => 10,
        Record::ModelSwitch(_) => 11,
    }
}
const KINDS: usize = 12;

/// One record of each kind, every text it can carry holding the value (`None`: the kind carries no text).
fn samples() -> Vec<(Record, bool)> {
    let message = json!({ "role": "user", "content": format!("{CODE} is the code") });
    let digest = format!("sha256:{}", "0".repeat(64));
    let samples: Vec<(Value, bool)> = vec![
        (json!({"k":"session","v":2,"id":"t","log_id":LOG_ID,"header":{"inline":{"title":format!("{CODE} is the code"),
            "_repeatFailHistory":[format!("browser:{CODE}")]}}}), true),
        (json!({"k":"meta","change":{"inline":{"set":{"title":format!("{CODE} is the code"),"_repeatFailGuard":{"sig":format!("browser:{CODE}")}},"unset":[]}}}), true),
        (json!({"k":"item","iid":"a","role":"user","form":"message","model":true,"visible":true,"prompt":{"inline":format!("{CODE} is the code")},
            "refs":[],"body":{"inline":message}}), true),
        (json!({"k":"amend","iid":"a","refs":[],"body":{"inline":message}}), true),
        (json!({"k":"rewind","to_ordinal":1,"reason":"rewind"}), false),
        (json!({"k":"compacted","cid":"c","replacement":{"inline":[{"iid":"s","body":message}]}}), true),
        (json!({"k":"run","rid":"r","phase":"failed","at":1,"detail":{"inline":{"error":{"message":format!("refused {CODE}")}}}}), true),
        (json!({"k":"approval","aid":"p","rid":"r","phase":"requested","at":1,
            "body":{"inline":{"tool":"browser","arguments":{"action":"fill","input":{"text":CODE}}}}}), true),
        (json!({"k":"queue","qid":"q","action":"enqueue","entry":{"inline":{"message":message}}}), true),
        (json!({"k":"op","op":{"id":"o","method":"turn/start","digest":digest},"state":"rejected","at":1,
            "detail":{"inline":{"message":format!("refused {CODE}")}}}), true),
        (json!({"k":"checkpoint","state":{"inline":{"log_id":LOG_ID,"covers_ordinal":3,"history_rev":0,"rows":0,"visible_rows":0,
            "runs":[],"approvals":[],"queue":[],"header":{"title":format!("{CODE} is the code")}}}}), true),
        (json!({"k":"model_switch","anchor":{"iid":"a","ordinal":1},"entry":{"inline":{"provider":"p","modelId":"m","at":1}}}), false),
    ];
    samples.into_iter().map(|(value, text)| (serde_json::from_value(value).expect("a record"), text)).collect()
}

/// A record is encoded ahead of its barrier; a value marked between the two is not appended: the log re-projects what
/// was encoded before the mark.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_record_encoded_before_a_mark_is_appended_without_the_value() {
    use mixdog_core_api::domain::mock::MockOwnership;
    use super::seams::CommitRecord;
    use super::seams::EncodedRecord;
    use super::seams::ThreadStore;
    let data = tempfile::tempdir().expect("data dir");
    let tokens = mixdog_rt::testing::tokens();
    let root = data.path().to_path_buf();
    let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
        mixdog_store::sqlite::SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
    })
    .expect("lane")
    .await
    .expect("job ran")
    .expect("index");
    let threads = Arc::new(super::StoreThreads::over_data_dir(data.path(), index, Arc::new(MockOwnership::default()), tokens.maintenance_io).await.expect("the thread store"));
    let store = Arc::new(mixdog_services::memory::sensitive::SensitiveStore::default());
    assert!(threads.redact_with(Arc::new(SensitiveMarksOf::new(store.clone()))).is_ok());
    let commit = |value: Value| {
        let record: Record = serde_json::from_value(value).expect("a record");
        let encoded = EncodedRecord(mixdog_store::encode::encode_record(record.clone()).expect("encodes"));
        CommitRecord { record: Arc::new(record), encoded }
    };
    let session = commit(json!({"k":"session","v":2,"id":"t","log_id":LOG_ID,"header":{"inline":{"title":"t"}}}));
    // Encoded now, with no value marked.
    let row = commit(json!({"k":"item","iid":"a","role":"user","form":"message","model":true,"visible":true,"refs":[],
        "body":{"inline":{"role":"user","content":format!("{CODE} is the code")}}}));
    let fill = json!({ "name": "browser", "arguments": { "action": "fill", "input": { "sensitive": true, "text": CODE } } });
    assert!(store.remember("t", &[fill]));
    let thread = ThreadId::from("t".to_owned());
    mixdog_rt::LaneToken::submit(tokens.durability_io, &mixdog_rt::CancellationToken::new(), move |lane| {
        let (mut log, _) = threads.create_log(lane, &thread, &session).expect("created");
        log.commit(lane, &[row]).expect("appended");
    })
    .expect("lane")
    .await
    .expect("job ran");
    let bytes = std::fs::read(data.path().join("sessions").join("t").join("log.000000")).expect("the log");
    assert!(!bytes.windows(CODE.len()).any(|w| w == CODE.as_bytes()), "{}", String::from_utf8_lossy(&bytes));
    assert!(bytes.windows(10).any(|w| w == b"[redacted]"));
}

#[test]
fn every_record_kind_is_stored_and_rewritten_without_a_marked_value() {
    let samples = samples();
    let mut kinds: Vec<usize> = samples.iter().map(|(record, _)| kind(record)).collect();
    kinds.sort_unstable();
    assert_eq!(kinds, (0..KINDS).collect::<Vec<_>>(), "one sample per kind");
    let store = Arc::new(mixdog_services::memory::sensitive::SensitiveStore::default());
    let fill = json!({ "name": "browser", "arguments": { "action": "fill", "input": { "sensitive": true, "text": CODE } } });
    assert!(store.remember("t", &[fill]));
    let marks = SensitiveMarksOf::new(store);
    let thread = ThreadId::from("t".to_owned());
    for (record, text) in &samples {
        let stored = marks.stored(&thread, record);
        let mut rewrite = marks.rewriter(&thread);
        let rewritten = rewrite(record);
        for (how, out) in [("stored", stored), ("rewritten", rewritten)] {
            assert_eq!(out.is_some(), *text, "{how} {record:?}");
            let json = serde_json::to_string(&out.unwrap_or_else(|| record.clone())).expect("encodes");
            assert!(!json.contains(CODE), "{how}: {json}");
        }
    }
}
