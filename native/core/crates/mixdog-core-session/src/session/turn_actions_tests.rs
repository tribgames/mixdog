//! `thread/agentControl`, `thread/stageAttachmentOriginal`, `thread/resizeImage` and
//! `approval/provideSecret` against the goldens of `fixtures/turn-ops`, recorded from the Node
//! code that answers them (`benchmarks/rust-core/recorders/record-turn-ops.mjs`).

use std::sync::Mutex;
#[cfg(node_twin)]
use std::time::Duration;

use async_trait::async_trait;
#[cfg(node_twin)]
use mixdog_app_protocol::rpc::RequestId;
use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::domain::ext::ImageProfile;
use mixdog_core_api::domain::ext::ProfiledImageResizer;
use mixdog_core_api::domain::ext::ProfiledResizeError;
use mixdog_core_api::domain::ext::ResizedImage;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_base::support::on_lane;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_core_base::support::testing::request;
use mixdog_core_base::support::testing::value;
use serde_json::Value;
use serde_json::json;
use sha2::Digest as _;
use sha2::Sha256;

use super::composer_image;
use super::secret_input::SECRET_INPUT_TIMEOUT;
use super::secret_input::SecretInputService;
use super::secret_input::SecretSlots;
#[cfg(node_twin)]
use super::secret_input::required_request_id;
use super::staged_originals::StagedOriginals;

#[cfg(node_twin)]
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap()
}

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

#[tokio::test]
async fn provide_secret_holds_the_value_and_answers_only_that_it_was_taken() {
    let slots = std::sync::Arc::new(SecretSlots::new(SECRET_INPUT_TIMEOUT));
    let service = SecretInputService::new(slots.clone());
    let id = "secret_0123456789ab";
    let params = |id: &str, secret: &str| json!({ "opId": "x", "requestId": id, "secret": secret });
    let answered = value(&service, request("approval/provideSecret", params(" secret_0123456789ab ", "482190"), Some(1))).await.unwrap();
    assert_eq!(answered, json!({}));
    assert_eq!(slots.take(id), "482190");
    for (bad, message) in [(params("nope", "v"), "secret was not accepted."), (params(id, ""), "secret was not accepted."), (params("  ", "v"), "secret request id is invalid.")] {
        let CoreError::DomainError { message: Some(got), .. } = value(&service, request("approval/provideSecret", bad, Some(2))).await.unwrap_err() else { panic!("a domain error") };
        assert_eq!(&*got, message);
        assert!(!slots.has(id));
    }
    let missing = value(&service, request("approval/provideSecret", params(id, "v"), None)).await.unwrap_err();
    assert!(matches!(missing, CoreError::OpIdRequired));
    assert!(!slots.has(id), "no value is kept without an op id");
}

#[cfg(node_twin)]
struct Resizer {
    recorded: Value,
    profile: Mutex<Option<ImageProfile>>,
}

#[cfg(node_twin)]
#[async_trait]
impl ProfiledImageResizer for Resizer {
    async fn resize_profiled(&self, _: &ThreadId, _: &[u8], _: &str, profile: ImageProfile) -> Result<Option<ResizedImage>, ProfiledResizeError> {
        *self.profile.lock().unwrap() = Some(profile);
        if let Some(error) = self.recorded.get("error") {
            return Err(ProfiledResizeError::Invalid(text(error, "message").to_owned()));
        }
        let ok = &self.recorded["ok"];
        let dims = &ok["dimensions"];
        let n = |key: &str| u32::try_from(dims[key].as_u64().unwrap()).unwrap();
        Ok(Some(ResizedImage {
            data_base64: text(ok, "data").to_owned(),
            mime: text(ok, "mimeType").to_owned(),
            original_w: n("originalWidth"),
            original_h: n("originalHeight"),
            display_w: n("displayWidth"),
            display_h: n("displayHeight"),
        }))
    }
}

#[cfg(node_twin)]
/// An input as recorded: a payload too big to keep is its character and length.
fn input_of(recorded: &Value) -> Value {
    let mut input = recorded.clone();
    if let Some(repeat) = recorded["data"].get("repeat") {
        input["data"] = json!(repeat.as_str().unwrap().repeat(recorded["data"]["count"].as_u64().unwrap() as usize));
    }
    input
}

#[tokio::test]
async fn a_resizer_that_returns_no_image_never_lets_the_picked_bytes_through() {
    // The picked file's own bytes (whatever their type: HEIC, AVIF, TIFF) are not an attachment; only what the
    // resizer wrote is.
    struct NoResizer;
    #[async_trait]
    impl ProfiledImageResizer for NoResizer {
        async fn resize_profiled(&self, _: &ThreadId, _: &[u8], _: &str, _: ImageProfile) -> Result<Option<ResizedImage>, ProfiledResizeError> {
            Ok(None)
        }
    }
    let run = |bytes: Vec<u8>, mime: &str| {
        let mime = mime.to_owned();
        async move { composer_image::image_attachment(&NoResizer, &ThreadId::from("t"), &bytes, &mime, "a.png", "").await }
    };
    for mime in ["", "image/png", "image/heic", "image/avif"] {
        assert_eq!(run(vec![1, 2, 3], mime).await.err().unwrap(), "the image resizer returned no image", "{mime}");
    }
    assert_eq!(run(Vec::new(), "image/png").await.err().unwrap(), "image is empty");
}

#[cfg(node_twin)]
fn units_of(text: &Value) -> String {
    match text {
        Value::String(s) => s.clone(),
        long => long["unit"].as_str().unwrap().repeat(usize::try_from(long["times"].as_u64().unwrap()).unwrap()) + long["suffix"].as_str().unwrap(),
    }
}

/// A message keeps every original whose bytes are in the store; only one that is not there loses its original (the image
/// keeps its resized copy).
#[test]
fn a_message_keeps_every_stored_original_and_loses_only_a_missing_one() {
    use super::staged_originals::drop_missing;
    use super::staged_originals::named_originals;
    let kept = "a".repeat(64);
    let gone = "b".repeat(64);
    let image = |original: Option<&str>| match original {
        Some(r) => json!({ "id": 1, "type": "image", "mediaType": "image/jpeg", "originalRef": r, "originalMediaType": "image/png" }),
        None => json!({ "id": 2, "type": "image", "mediaType": "image/jpeg" }),
    };
    let params = json!({ "input": { "prompt": "p", "options": { "pastedImages": { "1": image(Some(&kept)), "2": image(Some(&gone)), "3": image(None) } } } });
    assert_eq!(named_originals(&params), vec![kept.clone(), gone.clone()]);
    let mut input: mixdog_app_protocol::v2::thread::TurnInput = serde_json::from_value(params["input"].clone()).unwrap();
    assert_eq!(drop_missing(&mut input, std::slice::from_ref(&gone)), 1);
    let images = serde_json::to_value(&input.options.unwrap().pasted_images).unwrap();
    assert_eq!(images["1"], image(Some(&kept)));
    assert_eq!(images["2"], json!({ "id": 1, "type": "image", "mediaType": "image/jpeg" }));
    assert_eq!(images["3"], image(None));
}

/// A file-system job on the durability lane, as the banned blocking calls must run.
async fn io<R: Send + 'static>(job: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> R {
    on_lane(mixdog_rt::testing::tokens().durability_io, &mixdog_rt::CancellationToken::new(), job).await.unwrap()
}
async fn stage_bytes(originals: &std::sync::Arc<StagedOriginals>, bytes: Vec<u8>) -> Result<String, String> {
    let originals = originals.clone();
    io(move |lane| originals.stage(lane, &bytes)).await
}

/// Staging is bounded only per file: however many originals were staged and never sent (the same 1 MiB one 103 times, 600
/// small ones), the next stage succeeds; nothing accumulates that could refuse it. The one bound is the size of a single
/// file: one just under the limit is taken, one just over it is refused (and leaves nothing behind).
#[tokio::test]
async fn staging_never_refuses_for_what_was_staged_before() {
    let dir = tempfile::tempdir().unwrap();
    let originals = std::sync::Arc::new(StagedOriginals::new(dir.path()));
    let big = vec![7u8; 1 << 20];
    for _ in 0..103 {
        stage_bytes(&originals, big.clone()).await.unwrap();
    }
    for n in 0..600u32 {
        stage_bytes(&originals, n.to_le_bytes().to_vec()).await.unwrap();
    }
    assert_eq!(stage_bytes(&originals, b"one more".to_vec()).await.unwrap(), sha(b"one more"));
    assert_eq!(stage_bytes(&originals, Vec::new()).await.unwrap_err(), "staged original is empty");
    let limit = usize::try_from(mixdog_protocol::MAX_BLOB_BYTES).unwrap();
    let under = vec![1u8; limit - 1];
    assert_eq!(stage_bytes(&originals, under.clone()).await.unwrap(), sha(&under));
    let over = vec![2u8; limit + 1];
    assert_eq!(stage_bytes(&originals, over.clone()).await.unwrap_err(), "prompt attachment exceeds the 64 MiB input limit");
    let blobs = mixdog_store::blobs::BlobStore::new(dir.path());
    assert!(!blobs.path(&mixdog_store::blobs::digest_of_reference(&sha(&over)).unwrap()).exists(), "the refused file was not stored");
}

/// The reviewer's sequence: session B stages bytes session A's message already holds, A's last reference is redacted,
/// then B sends: nothing deleted the bytes, and B's message keeps its original, whose bytes hash to their name.
#[tokio::test(start_paused = true)]
async fn b_stages_bytes_a_holds_a_redacts_and_b_still_sends_its_original() {
    use mixdog_store::blobs::BlobStore;
    use mixdog_store::encode::Encoded;
    use mixdog_store::encode::PendingBlob;
    use mixdog_store::encode::encode_record;
    use mixdog_store::log::LogWriter;
    use mixdog_store::log::OsIo;
    use mixdog_store::log::WriterDeps;
    use mixdog_store::schema::record::Record;

    /// The index a log writer asks for lineage: this session has no base.
    struct NoLineage;
    impl mixdog_store::fold::LineageIndex for NoLineage {
        fn live_rows(&self, _: &str, _: u64, _: u64) -> Result<(u64, u64), mixdog_store::fold::LookupError> {
            Ok((0, 0))
        }
        fn live_compaction_before(&self, _: &str, _: u64) -> Result<Option<mixdog_store::schema::checkpoint::FramePos>, mixdog_store::fold::LookupError> {
            Ok(None)
        }
    }
    const PICKED: &[u8] = b"the picked photo";
    let (rig, seen) = options_rig();
    let deps = rig.deps();
    let data = rig._data.path().to_path_buf();
    let digest = mixdog_store::blobs::digest_of(PICKED);
    let named_in_log = |data: &std::path::Path| -> bool {
        std::fs::read_dir(data.join("sessions").join("sess_a"))
            .unwrap()
            .any(|file| String::from_utf8_lossy(&std::fs::read(file.unwrap().path()).unwrap()).contains(digest.as_str()))
    };

    // Session A commits a message that references the bytes.
    let session = encode_record(serde_json::from_value(json!({ "k": "session", "v": 2, "id": "sess_a", "log_id": "4f1c2a9e0b7d3c5a6e8f9012", "header": { "inline": { "title": "a" } } })).unwrap()).unwrap();
    let message = Encoded::new(
        serde_json::from_value(json!({ "k": "item", "iid": "a1", "role": "user", "form": "message", "model": true, "visible": true,
            "refs": [digest.as_str()], "body": { "inline": { "content": "the photo", "role": "user" } } }))
        .unwrap(),
        vec![PendingBlob { digest: digest.clone(), bytes: PICKED.to_vec() }],
    )
    .unwrap();
    let writer_deps = WriterDeps { io: std::sync::Arc::new(OsIo), blobs: BlobStore::new(&data), ownership: std::sync::Arc::new(mixdog_core_api::domain::mock::MockOwnership::default()), index: std::sync::Arc::new(NoLineage) };
    let dir_a = data.join("sessions").join("sess_a");
    io(move |lane| {
        let (mut writer, _) = LogWriter::create(lane, &dir_a, session, writer_deps).unwrap();
        writer.append_barrier(lane, vec![message]).unwrap();
    })
    .await;
    assert!(named_in_log(&data), "A's log names the bytes");

    // B stages the same bytes.
    let original = stage_bytes(&deps.staged_originals, PICKED.to_vec()).await.unwrap();
    assert_eq!(original, sha(PICKED));

    // A's reference is redacted by the real rewrite: the message no longer names the bytes.
    let (rewrite_data, blobs) = (data.clone(), BlobStore::new(&data));
    io(move |lane| {
        let redacted: Record = serde_json::from_value(json!({ "k": "item", "iid": "a1", "role": "user", "form": "message", "model": true, "visible": true,
            "refs": [], "body": { "inline": { "content": "[redacted]", "role": "user" } } }))
        .unwrap();
        assert!(mixdog_store::log_rewrite::plan(lane, &rewrite_data, "sess_a", &OsIo, &blobs, &mut |record: &Record| matches!(record, Record::Item(_)).then(|| redacted.clone())).unwrap(), "the message changed");
        mixdog_store::log_rewrite::settle(lane, &rewrite_data, "sess_a", &OsIo, &blobs, &mut || Ok(())).unwrap();
    })
    .await;
    assert!(!named_in_log(&data), "no record of A names the bytes any more");

    let path = BlobStore::new(&data).path(&digest);
    assert_eq!(sha(&std::fs::read(&path).unwrap()), original, "the bytes are still there and hash to their name");

    // B submits its turn: the request carries the original.
    let directory = super::SessionDirectory::new(deps.clone());
    let handle = super::tests::start_thread(&directory).await;
    let image = json!({ "id": 1, "type": "image", "mediaType": "image/jpeg", "originalRef": original, "originalMediaType": "image/png" });
    let params = json!({ "threadId": handle.id, "opId": "op-b", "input": { "prompt": "look", "options": { "pastedImages": { "1": image } } } });
    use mixdog_core_api::ThreadHandle as _;
    handle.request(request("turn/start", params, Some(1))).await.unwrap();
    let options = crate::eventually_on!(&[&handle.cell.stepped], || seen.lock().unwrap().first().cloned()).await;
    assert_eq!(options["pastedImages"]["1"]["originalRef"], json!(original));
    assert_eq!(options["pastedImages"]["1"]["originalMediaType"], json!("image/png"));
}

/// A rig whose turns report the options they ran with.
fn options_rig() -> (super::testing::Rig, std::sync::Arc<Mutex<Vec<Value>>>) {
    let rig = super::testing::Rig::new();
    let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    rig.set_script(std::sync::Arc::new(move |run| {
        let sink = sink.clone();
        Box::pin(async move {
            sink.lock().unwrap().push(serde_json::to_value(&run.input.options).unwrap());
            super::seams::RunOutcome::Completed(Default::default())
        })
    }));
    (rig, seen)
}

/// A turn keeps each original whose bytes are stored, however often the same chip is sent (a retry, another window), and
/// loses only one that was never stored.
#[tokio::test(start_paused = true)]
async fn a_turn_keeps_every_stored_original_on_every_send() {
    let (rig, seen) = options_rig();
    let deps = stored_rows_deps(&rig);
    let directory = super::SessionDirectory::new(deps.clone());
    let handle = super::tests::start_thread(&directory).await;
    let (stored, never) = (stage_bytes(&deps.staged_originals, b"picked".to_vec()).await.unwrap(), sha(b"never staged"));
    let image = |id: i64, original: &str| json!({ "id": id, "type": "image", "mediaType": "image/jpeg", "originalRef": original, "originalMediaType": "image/png" });
    use mixdog_core_api::ThreadHandle as _;
    for (n, op) in ["op-first", "op-retry", "op-other-window"].into_iter().enumerate() {
        let params = json!({
            "threadId": handle.id, "opId": op,
            "input": { "prompt": "look", "options": { "pastedImages": { "1": image(1, &stored), "2": image(2, &never) } } },
        });
        handle.request(request("turn/start", params, Some(n as u64 + 1))).await.unwrap();
        let options = crate::eventually_on!(&[&handle.cell.stepped], || seen.lock().unwrap().get(n).cloned()).await;
        assert_eq!(options["pastedImages"]["1"]["originalRef"], json!(stored), "{op}");
        assert!(options["pastedImages"]["2"].get("originalRef").is_none() && options["pastedImages"]["2"].get("originalMediaType").is_none(), "{op}");
    }
    // A replay of a send already answered (same op id, same `clientSubmissionId`, which is what the session joins a retried
    // send by, `drain-enqueue.mjs:37`; an op id alone is the RPC layer's and a session starts a new turn for it): the same
    // answer, no second run, and the stored original is still the one the message was sent with.
    let message = |op: &str| json!({
        "threadId": handle.id, "opId": op,
        "input": { "prompt": "look", "options": { "clientSubmissionId": "sub-replayed", "pastedImages": { "1": image(1, &stored), "2": image(2, &never) } } },
    });
    let Reply::Value(first) = handle.request(request("turn/start", message("op-replayed"), Some(10))).await.unwrap() else { panic!("a value") };
    crate::eventually_on!(&[&handle.cell.stepped], || (seen.lock().unwrap().len() == 4 && missing_marks(&handle).len() == 4).then_some(())).await;
    let Reply::Value(replayed) = handle.request(request("turn/start", message("op-replayed"), Some(11))).await.unwrap() else { panic!("a value") };
    super::tests::caught_up(&handle).await;
    assert_eq!(replayed, first, "the replay answers what the first send answered");
    assert_eq!(seen.lock().unwrap().len(), 4, "the replay ran no second turn");
    assert_eq!(seen.lock().unwrap()[3]["pastedImages"]["1"]["originalRef"], json!(stored));
    assert_eq!(missing_marks(&handle), [1, 1, 1, 1], "one note per accepted message (the three before, and the replayed one once); its replay added none");
}

/// A send replayed after a real restart (a new directory and actors over the same store, none of the first process's
/// memory) is answered from the stored receipt: no second run, and the thread still shows the message's one note.
#[tokio::test(start_paused = true)]
async fn a_send_replayed_after_a_restart_adds_no_run_and_no_second_note() {
    let (rig, seen) = options_rig();
    let deps = stored_rows_deps(&rig);
    let never = sha(b"never staged");
    let message = |thread: &ThreadId| json!({
        "threadId": thread, "opId": "op-replayed",
        "input": { "prompt": "look", "options": { "clientSubmissionId": "sub-replayed",
            "pastedImages": { "1": { "id": 1, "type": "image", "mediaType": "image/jpeg", "originalRef": never, "originalMediaType": "image/png" } } } },
    });
    use mixdog_core_api::ThreadHandle as _;
    let (id, first) = {
        let directory = super::SessionDirectory::new(deps.clone());
        let handle = super::tests::start_thread(&directory).await;
        let Reply::Value(first) = handle.request(request("turn/start", message(&handle.id), Some(1))).await.unwrap() else { panic!("a value") };
        crate::eventually_on!(&[&handle.cell.stepped], || (seen.lock().unwrap().len() == 1).then_some(())).await;
        super::tests::caught_up(&handle).await;
        assert_eq!(missing_marks(&handle), [1]);
        (handle.id.clone(), first)
    };
    let restarted = super::SessionDirectory::new(deps.clone());
    let reopened = restarted.open_handle(&id, &mixdog_core_api::call::CallContext::internal("test")).await.expect("reopened");
    assert_eq!(missing_marks(&reopened), [1], "the stored message carries its note across the restart");
    let Reply::Value(replayed) = reopened.request(request("turn/start", message(&id), Some(2))).await.unwrap() else { panic!("a value") };
    super::tests::caught_up(&reopened).await;
    assert_eq!(replayed, first, "the replay answers what the first send answered");
    assert_eq!(seen.lock().unwrap().len(), 1, "the replay ran no second turn");
    assert_eq!(missing_marks(&reopened), [1], "the replay added no note");
}

/// A delivered message is taken back (`thread/rewind`) and sent again edited, its original still named by the composer
/// and still missing: the rewound message goes with its note, and the one that replaces it shows exactly one.
#[tokio::test(start_paused = true)]
async fn a_delivered_message_edited_and_sent_again_shows_one_note() {
    let (rig, seen) = options_rig();
    let deps = stored_rows_deps(&rig);
    let directory = super::SessionDirectory::new(deps.clone());
    let handle = super::tests::start_thread(&directory).await;
    let never = sha(b"never staged");
    let images = json!({ "1": { "id": 1, "type": "image", "mediaType": "image/jpeg", "originalRef": never, "originalMediaType": "image/png" } });
    use mixdog_core_api::ThreadHandle as _;
    let send = |op: &'static str, id: u64, prompt: &str, submission: &str| {
        let params = json!({ "threadId": handle.id, "opId": op, "input": { "prompt": prompt, "options": { "clientSubmissionId": submission, "pastedImages": images.clone() } } });
        handle.request(request("turn/start", params, Some(id)))
    };
    send("op-look", 1, "look", "sub-look").await.unwrap();
    crate::eventually_on!(&[&handle.cell.stepped], || (seen.lock().unwrap().len() == 1).then_some(())).await;
    super::tests::caught_up(&handle).await;
    assert_eq!(missing_marks(&handle), [1]);
    let rewind = json!({ "threadId": handle.id, "opId": "op-rewind", "itemId": "sub-look" });
    handle.request(request("thread/rewind", rewind, Some(2))).await.expect("the delivered message is taken back");
    send("op-look-again", 3, "look again", "sub-look-again").await.unwrap();
    crate::eventually_on!(&[&handle.cell.stepped], || (seen.lock().unwrap().len() == 2).then_some(())).await;
    super::tests::caught_up(&handle).await;
    assert_eq!(missing_marks(&handle), [1], "the rewound message's note went with it; the edited message shows one");
}

/// A message whose original cannot be found goes out with the smaller image, and the sender is told so in plain words, once
/// per send; a message with nothing missing raises no notice.
#[tokio::test(start_paused = true)]
async fn a_message_sent_without_a_missing_original_tells_the_sender() {
    let (rig, seen) = options_rig();
    let deps = stored_rows_deps(&rig);
    let directory = super::SessionDirectory::new(deps.clone());
    let handle = super::tests::start_thread(&directory).await;
    let (stored, never) = (stage_bytes(&deps.staged_originals, b"picked".to_vec()).await.unwrap(), sha(b"never staged"));
    let image = |id: i64, original: &str| json!({ "id": id, "type": "image", "mediaType": "image/jpeg", "originalRef": original, "originalMediaType": "image/png" });
    use mixdog_core_api::ThreadHandle as _;
    let send = |op: &'static str, id: u64, images: Value| {
        let params = json!({ "threadId": handle.id, "opId": op, "input": { "prompt": "look", "options": { "pastedImages": images } } });
        handle.request(request("turn/start", params, Some(id)))
    };
    send("op-all-there", 1, json!({ "1": image(1, &stored) })).await.unwrap();
    crate::eventually_on!(&[&handle.cell.stepped], || seen.lock().unwrap().first().cloned()).await;
    super::tests::caught_up(&handle).await;
    assert!(missing_marks(&handle).is_empty(), "nothing was missing: {:?}", missing_marks(&handle));
    send("op-one-missing", 2, json!({ "1": image(1, &stored), "2": image(2, &never) })).await.unwrap();
    let sent = crate::eventually_on!(&[&handle.cell.stepped], || seen.lock().unwrap().get(1).cloned()).await;
    assert!(sent["pastedImages"]["2"].get("originalRef").is_none(), "the smaller image is what goes");
    let told = crate::eventually_on!(&[&handle.cell.stepped], || Some(missing_marks(&handle)).filter(|marks| !marks.is_empty())).await;
    assert_eq!(told, [1], "the message that lost an original records it, and the one that lost none records nothing");
    // A client cannot claim the count: a send naming it is refused, and nothing is recorded; nor can it name the missing
    // originals for the core: what it puts under that key is replaced by what the core found (nothing here).
    let claimed = json!({ "threadId": handle.id, "opId": "op-claimed", "input": { "prompt": "look", "options": { "originalImagesMissing": 9, "pastedImages": { "1": image(1, &stored) } } } });
    assert!(handle.request(request("turn/start", claimed, Some(3))).await.is_err(), "a claimed count is no submit option");
    let named = json!({ "threadId": handle.id, "opId": "op-named", "missingOriginals": [stored], "input": { "prompt": "look", "options": { "pastedImages": { "1": image(1, &stored) } } } });
    handle.request(request("turn/start", named, Some(4))).await.unwrap();
    let sent = crate::eventually_on!(&[&handle.cell.stepped], || seen.lock().unwrap().get(2).cloned()).await;
    assert_eq!(sent["pastedImages"]["1"]["originalRef"], json!(stored), "the stored original goes with the message");
    super::tests::caught_up(&handle).await;
    assert_eq!(missing_marks(&handle), [1]);
}

/// A first message in `thread/start`'s `initialInput` is told the core's own count like any other send: one original missing
/// records one, none missing records none, and a count the client claims is refused.
#[tokio::test(start_paused = true)]
async fn a_first_message_is_told_the_cores_count_of_missing_originals() {
    let (rig, seen) = options_rig();
    let deps = stored_rows_deps(&rig);
    let directory = super::SessionDirectory::new(deps.clone());
    let (stored, never) = (stage_bytes(&deps.staged_originals, b"picked".to_vec()).await.unwrap(), sha(b"never staged"));
    let image = |id: i64, original: &str| json!({ "id": id, "type": "image", "mediaType": "image/jpeg", "originalRef": original, "originalMediaType": "image/png" });
    let start = |op: &str, images: Value| {
        let params = json!({
            "opId": op, "kind": "project", "projectPath": "/ws",
            "initialInput": { "prompt": "look", "options": { "pastedImages": images } },
        });
        directory.request(request("thread/start", params, Some(1)))
    };
    use mixdog_core_api::ThreadDirectory as _;
    let claimed = json!({
        "opId": "op-claimed", "kind": "project", "projectPath": "/ws",
        "initialInput": { "prompt": "look", "options": { "originalImagesMissing": 9, "pastedImages": { "1": image(1, &stored) } } },
    });
    assert!(directory.request(request("thread/start", claimed, Some(1))).await.is_err(), "a claimed count is no submit option");
    for (n, (op, images, marks)) in [
        ("op-lost-one", json!({ "1": image(1, &stored), "2": image(2, &never) }), vec![1]),
        ("op-lost-none", json!({ "1": image(1, &stored) }), vec![]),
    ]
    .into_iter()
    .enumerate()
    {
        let Reply::Subscribe(started) = start(op, images).await.unwrap() else { panic!("thread/start subscribes") };
        let handle = directory.handle(&ThreadId::from(started.result["thread"]["id"].as_str().unwrap())).expect("loaded");
        crate::eventually_on!(&[&handle.cell.stepped], || seen.lock().unwrap().get(n).cloned()).await;
        super::tests::caught_up(&handle).await;
        assert_eq!(missing_marks(&handle), marks, "{op}");
    }
}

/// A rig whose `first` run waits for the returned gate and whose every other run ends at once, reporting the options each
/// ran with; its rows are the stored records' own.
fn queue_rig() -> (super::testing::Rig, std::sync::Arc<super::SessionDeps>, std::sync::Arc<tokio::sync::Notify>, std::sync::Arc<Mutex<Vec<Value>>>) {
    let rig = super::testing::Rig::new();
    let (gate, seen) = (std::sync::Arc::new(tokio::sync::Notify::new()), std::sync::Arc::new(Mutex::new(Vec::new())));
    let (open, sink) = (gate.clone(), seen.clone());
    rig.set_script(std::sync::Arc::new(move |run| {
        let (open, sink) = (open.clone(), sink.clone());
        Box::pin(async move {
            if run.input.prompt == mixdog_protocol::PromptContent::Text("first".into()) {
                open.notified().await;
            }
            sink.lock().unwrap().push(serde_json::to_value(&run.input.options).unwrap());
            super::seams::RunOutcome::Completed(Default::default())
        })
    }));
    let deps = stored_rows_deps(&rig);
    (rig, deps, gate, seen)
}

/// A message that lost two of its originals (one kept, two missing under one digest) waits behind a running turn, is taken
/// back to its composer, and is sent again from there: the composer gets the message as it was sent, the originals
/// included, so the core finds them missing again, and the message that runs shows exactly one note, of two. The entry
/// taken back showed none of its own.
#[tokio::test(start_paused = true)]
async fn a_queued_message_taken_back_and_sent_again_is_told_its_missing_originals_once() {
    let (_rig, deps, gate, seen) = queue_rig();
    let directory = super::SessionDirectory::new(deps.clone());
    let handle = super::tests::start_thread(&directory).await;
    let (stored, never) = (stage_bytes(&deps.staged_originals, b"picked".to_vec()).await.unwrap(), sha(b"never staged"));
    let image = |id: i64, original: &str| json!({ "id": id, "type": "image", "mediaType": "image/jpeg", "originalRef": original, "originalMediaType": "image/png" });
    use mixdog_core_api::ThreadHandle as _;
    assert_eq!(super::tests::turn(&handle, "first", "op-first").await["kind"], "started");
    let images = json!({ "1": image(1, &stored), "2": image(2, &never), "3": image(3, &never) });
    let params = json!({ "threadId": handle.id, "opId": "op-look", "input": { "prompt": "look", "options": { "pastedImages": images } } });
    let Reply::Value(queued) = handle.request(request("turn/start", params, Some(2))).await.unwrap() else { panic!("a value") };
    assert_eq!(queued["kind"], "queued");
    let take_back = json!({ "threadId": handle.id, "opId": "op-take-back", "queuedId": queued["queuedId"], "restore": true });
    let Reply::Value(restored) = handle.request(request("thread/queue/delete", take_back, Some(3))).await.unwrap() else { panic!("a value") };
    assert_eq!(restored["count"], 1);
    for (id, original) in [("1", &stored), ("2", &never), ("3", &never)] {
        assert_eq!(restored["pastedImages"][id]["originalRef"], json!(original), "image {id} comes back as it was sent");
    }
    let again = json!({
        "threadId": handle.id, "opId": "op-again",
        "input": { "prompt": restored["text"], "options": { "pastedImages": restored["pastedImages"] } },
    });
    let Reply::Value(sent) = handle.request(request("turn/start", again, Some(4))).await.unwrap() else { panic!("a value") };
    assert_eq!(sent["kind"], "queued", "the first turn still runs");
    gate.notify_one();
    let ran = crate::eventually_on!(&[&handle.cell.stepped], || seen.lock().unwrap().get(1).cloned()).await;
    assert_eq!(ran["pastedImages"]["1"]["originalRef"], json!(stored));
    assert!(ran["pastedImages"]["2"].get("originalRef").is_none() && ran["pastedImages"]["3"].get("originalRef").is_none(), "the smaller images go");
    super::tests::caught_up(&handle).await;
    assert_eq!(missing_marks(&handle), [2], "one note, on the message that ran, of both images that lost theirs");
}

/// A message that lost an original fails on exhausted quota and is retried: the retry runs the visible message again with
/// no row of its own, so it neither adds a note nor takes the message's away.
#[tokio::test(start_paused = true)]
async fn a_hidden_retry_of_a_message_that_lost_an_original_neither_adds_nor_removes_its_note() {
    let rig = super::testing::Rig::new();
    let seen = std::sync::Arc::new(Mutex::new(Vec::<Option<mixdog_protocol::thread::SubmitOptions>>::new()));
    let sink = seen.clone();
    rig.set_script(std::sync::Arc::new(move |run| {
        let sink = sink.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let first = {
                let mut seen = sink.lock().unwrap();
                seen.push(run.input.options.clone());
                seen.len() == 1
            };
            if first { super::seams::RunOutcome::Failed(super::testing::quota_error(5000)) } else { super::seams::RunOutcome::Completed(Default::default()) }
        })
    }));
    let deps = stored_rows_deps(&rig);
    let directory = super::SessionDirectory::new(deps.clone());
    let handle = super::tests::start_routed_thread(&directory).await;
    let never = sha(b"never staged");
    let image = json!({ "id": 1, "type": "image", "mediaType": "image/jpeg", "originalRef": never, "originalMediaType": "image/png" });
    use mixdog_core_api::ThreadHandle as _;
    let params = json!({ "threadId": handle.id, "opId": "op-look", "input": { "prompt": "look", "options": { "pastedImages": { "1": image } } } });
    handle.request(request("turn/start", params, Some(1))).await.unwrap();
    let id = handle.id.as_str().to_owned();
    let entry = crate::eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || rig.quota.entry(&id)).await;
    crate::eventually_on!(&[&handle.cell.stepped], || super::tests::idle(&handle).then_some(())).await;
    assert_eq!(missing_marks(&handle), [1]);
    let rows = handle.view_items().iter().filter(|item| matches!(&***item, mixdog_protocol::ThreadItem::UserMessage { .. })).count();
    let retry = json!({ "threadId": handle.id, "opId": "op-retry", "turnKey": entry.turn_key });
    let Reply::Value(taken) = handle.request(request("turn/retryFailed", retry, Some(2))).await.unwrap() else { panic!("a value") };
    assert_eq!(taken, json!(true));
    crate::eventually_on!(&[&handle.cell.stepped], || (seen.lock().unwrap().len() == 2).then_some(())).await;
    crate::eventually_on!(&[&handle.cell.stepped], || super::tests::idle(&handle).then_some(())).await;
    let options = seen.lock().unwrap()[1].clone().expect("the retry's options");
    assert!(options.retry_turn_id.is_some(), "the visible message itself is run again");
    super::tests::caught_up(&handle).await;
    let after = handle.view_items().iter().filter(|item| matches!(&***item, mixdog_protocol::ThreadItem::UserMessage { .. })).count();
    assert_eq!(after, rows, "the retry shows no row of its own");
    assert_eq!(missing_marks(&handle), [1], "the message keeps its one note, and the retry adds none");
}

/// The deps of a rig that shows the stored rows (the rig's own transcript shows a bare text), so what a message records
/// with it is what its item carries.
fn stored_rows_deps(rig: &super::testing::Rig) -> std::sync::Arc<super::SessionDeps> {
    let mut parts = rig.deps_parts(rig.store.clone());
    parts.transcript = std::sync::Arc::new(super::testing::RecordTranscript::new());
    std::sync::Arc::new(parts)
}

/// What each user message of the thread records, in `meta.transcript.originalImagesMissing`, of images that went with only
/// their smaller copy: the counts of the messages that record one, in order, as the item every surface builds its note from.
fn missing_marks(handle: &super::SessionHandle) -> Vec<u64> {
    handle
        .view_items()
        .iter()
        .filter_map(|item| match &**item {
            mixdog_protocol::ThreadItem::UserMessage { meta, .. } => meta.ext.get("originalImagesMissing").and_then(Value::as_u64),
            _ => None,
        })
        .collect()
}

/// A message the attachment intake refuses (`preparePromptSubmissionForProvider` throws in `submitAdmitted`) is the
/// submit's error with the intake's text, and no turn runs.
#[tokio::test(start_paused = true)]
async fn a_message_the_intake_refuses_answers_its_text() {
    use super::testing::Rig;
    struct Refuse;
    #[async_trait::async_trait]
    impl super::PromptIntake for Refuse {
        async fn admit(&self, _: &mixdog_core_api::ids::ThreadId, _: &str, params: &Value) -> Result<(), String> {
            assert_eq!(params["opId"], "op-refused");
            Err("PDF exceeds the 20 MiB input limit".into())
        }
    }
    let rig = Rig::new();
    let ran = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = ran.clone();
    rig.set_script(std::sync::Arc::new(move |_| {
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
        Box::pin(async { super::seams::RunOutcome::Completed(Default::default()) })
    }));
    let mut parts = rig.deps_parts(rig.store.clone());
    parts.prompt_intake = std::sync::Arc::new(Refuse);
    parts.transcript = std::sync::Arc::new(super::testing::RecordTranscript::new());
    let deps = std::sync::Arc::new(parts);
    let directory = super::SessionDirectory::new(deps.clone());
    let handle = super::tests::start_thread(&directory).await;
    let staged = stage_bytes(&deps.staged_originals, b"original".to_vec()).await.unwrap();
    let image = json!({ "id": 1, "type": "image", "mediaType": "image/jpeg", "originalRef": staged, "originalMediaType": "image/png" });
    let missing = json!({ "id": 2, "type": "image", "mediaType": "image/jpeg", "originalRef": sha(b"never staged"), "originalMediaType": "image/png" });
    let params = json!({ "threadId": handle.id, "opId": "op-refused", "input": { "prompt": "look", "options": { "pastedImages": { "1": image, "2": missing } } } });
    use mixdog_core_api::ThreadHandle as _;
    let refused = handle.request(request("turn/start", params, Some(1))).await.expect_err("refused");
    let CoreError::DomainError { message, code, .. } = refused else { panic!("a domain error: {refused:?}") };
    assert_eq!((message.as_deref(), code), (Some("PDF exceeds the 20 MiB input limit"), None));
    assert!(!ran.load(std::sync::atomic::Ordering::SeqCst), "no turn ran");
    super::tests::caught_up(&handle).await;
    assert!(missing_marks(&handle).is_empty(), "a refused send did not go, so it records nothing of its image going smaller");
}


#[cfg(node_twin)]
fn golden(name: &str) -> Value {
    let text = match name {
        "secret-slots.json" => include_str!("../../../../fixtures/turn-ops/secret-slots.json"),
        "composer-image.json" => mixdog_testkit::fixture!("../../fixtures/turn-ops/composer-image.json"),
        other => panic!("{other}"),
    };
    serde_json::from_str(text).unwrap()
}
#[cfg(node_twin)]
#[tokio::test(start_paused = true)]
async fn secret_slots_follow_the_recorded_cases() {
    let doc = golden("secret-slots.json");
    for case in doc["cases"].as_array().unwrap() {
        let name = text(case, "name");
        if let Some(id) = case.get("requestId").and_then(Value::as_str) {
            let slots = SecretSlots::new(SECRET_INPUT_TIMEOUT);
            let accepted = slots.provide(id, text(case, "value"));
            assert_eq!(json!(accepted), case["accepted"], "{name}");
            assert_eq!(json!(slots.has(id)), case["held"], "{name}");
            assert_eq!(json!(slots.take(id)), case["taken"], "{name}");
            assert_eq!(json!(slots.take(id)), case["takenAgain"], "{name}");
        } else if let Some(before) = case.get("before") {
            let id = "secret_0123456789ab";
            let username = doc["suffixes"]["username"].as_str().unwrap();
            let save = doc["suffixes"]["save"].as_str().unwrap();
            let slots = SecretSlots::new(SECRET_INPUT_TIMEOUT);
            let ids = [id.to_owned(), format!("{id}{username}"), format!("{id}{save}")];
            assert!(slots.provide(id, "a"));
            assert!(slots.provide(&ids[1], "user"));
            assert!(slots.provide(&ids[2], "1"));
            let held = |slots: &SecretSlots| json!(ids.iter().map(|id| slots.has(id)).collect::<Vec<_>>());
            assert_eq!(&held(&slots), before, "{name}");
            slots.discard(id);
            assert_eq!(held(&slots), case["after"], "{name}");
        } else if let Some(ms) = case.get("timeoutMs").and_then(Value::as_u64) {
            let slots = SecretSlots::new(Duration::from_millis(ms));
            assert!(slots.provide("secret_0123456789ab", "gone"));
            mixdog_rt::time::sleep(Duration::from_millis(ms * 4)).await;
            assert_eq!(json!(slots.has("secret_0123456789ab")), case["held"], "{name}");
        } else {
            let slots = SecretSlots::new(SECRET_INPUT_TIMEOUT);
            assert!(slots.provide("secret_0123456789ab", "first"));
            assert!(slots.provide("secret_0123456789ab", "second"));
            assert_eq!(json!(slots.take("secret_0123456789ab")), case["taken"], "{name}");
        }
    }
}
#[cfg(node_twin)]
#[test]
fn the_request_id_is_checked_as_the_card_handler_checks_it() {
    for case in golden("secret-slots.json")["requiredIds"].as_array().unwrap() {
        let id = match &case["value"] {
            Value::String(s) => RequestId::String(s.clone()),
            Value::Number(n) => RequestId::Integer(n.as_i64().unwrap()),
            _ => continue,
        };
        match required_request_id(&id) {
            Ok(trimmed) => assert_eq!(json!(trimmed), case["text"], "{case}"),
            Err(message) => assert_eq!(message, text(&case["error"], "message"), "{case}"),
        }
    }
}
#[cfg(node_twin)]
#[test]
fn the_provider_picks_the_image_profile() {
    for case in golden("composer-image.json")["profiles"].as_array().unwrap() {
        let provider = case["provider"].as_str().unwrap_or_default();
        let expected = if text(case, "profile") == "openai" { ImageProfile::OpenAi } else { ImageProfile::Anthropic };
        assert_eq!(composer_image::image_profile_for_provider(provider), expected, "{case}");
    }
}
#[cfg(node_twin)]
#[test]
fn image_metadata_reads_as_node_wrote_it() {
    for case in golden("composer-image.json")["metadata"].as_array().unwrap() {
        let dims = &case["dims"];
        let got = if dims.is_null() {
            let source = text(case, "source");
            (!source.is_empty()).then(|| format!("[Image source: {source}]"))
        } else {
            let n = |key: &str| dims[key].as_u64().unwrap() as u32;
            composer_image::image_metadata_text((n("originalWidth"), n("originalHeight")), (n("displayWidth"), n("displayHeight")), text(case, "source"))
        };
        assert_eq!(got.map(Value::String).unwrap_or(Value::Null), case["text"], "{case}");
    }
}
#[cfg(node_twin)]
#[tokio::test]
async fn resize_image_answers_as_the_composer_action_does() {
    for case in golden("composer-image.json")["resize"].as_array().unwrap() {
        let name = text(case, "name");
        let dir = tempfile::tempdir().unwrap();
        let originals = std::sync::Arc::new(StagedOriginals::new(dir.path()));
        let resizer = Resizer { recorded: case["resizer"].clone(), profile: Mutex::new(None) };
        let stage = |bytes: Vec<u8>| {
            let originals = originals.clone();
            async move { stage_bytes(&originals, bytes).await }
        };
        let got = composer_image::resize_image(&resizer, &ThreadId::from("t"), &input_of(&case["input"]), text(case, "provider"), stage).await;
        match (&got, case["answer"].get("ok"), case["answer"].get("error")) {
            (Ok(answer), Some(ok), _) => assert_eq!(answer, ok, "{name}"),
            (Err(message), _, Some(error)) => assert_eq!(message, text(error, "message"), "{name}"),
            other => panic!("{name}: {other:?}"),
        }
        if let Some(profile) = *resizer.profile.lock().unwrap() {
            let expected = composer_image::image_profile_for_provider(text(case, "provider"));
            assert_eq!(profile, expected, "{name}");
        }
    }
}
#[cfg(node_twin)]
#[tokio::test]
async fn stage_attachment_original_answers_as_the_action_does() {
    for case in golden("composer-image.json")["stage"].as_array().unwrap() {
        let name = text(case, "name");
        let dir = tempfile::tempdir().unwrap();
        let originals = std::sync::Arc::new(StagedOriginals::new(dir.path()));
        let stage = |bytes: Vec<u8>| {
            let originals = originals.clone();
            async move { stage_bytes(&originals, bytes).await }
        };
        let got = composer_image::stage_original_payload(&input_of(&case["input"]), stage).await;
        match (&got, case["answer"].get("ok"), case["answer"].get("error")) {
            (Ok(answer), Some(ok), _) => assert_eq!(answer, ok, "{name}"),
            (Err(message), _, Some(error)) => assert_eq!(message, text(error, "message"), "{name}"),
            other => panic!("{name}: {other:?}"),
        }
    }
}
#[cfg(node_twin)]
#[test]
fn base64_decodes_as_node_does_over_utf16_code_units() {
    let doc = golden("composer-image.json");
    assert!(doc["base64"].as_array().unwrap().len() > 400);
    for case in doc["base64"].as_array().unwrap() {
        let bytes = composer_image::node_base64_decode(&units_of(&case["text"]));
        assert_eq!(json!(bytes.len()), case["length"], "{case}");
        assert_eq!(json!(sha(&bytes)), case["sha256"], "{case}");
    }
    // Node's probe: each `Ł` (U+0141) reads by its low byte, as `A`.
    assert_eq!(composer_image::node_base64_decode("ŁŁŁŁ"), vec![0, 0, 0]);
}
