//! `thread/agentControl`, `thread/stageAttachmentOriginal`, `thread/resizeImage` and
//! `approval/provideSecret` against the goldens of `fixtures/turn-ops`, recorded from the Node
//! code that answers them (`benchmarks/rust-core/recorders/record-turn-ops.mjs`).

use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_app_protocol::rpc::RequestId;
use mixdog_core_api::CoreError;
use mixdog_core_api::domain::ext::ImageProfile;
use mixdog_core_api::domain::ext::ProfiledImageResizer;
use mixdog_core_api::domain::ext::ProfiledResizeError;
use mixdog_core_api::domain::ext::ResizedImage;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_base::support::on_lane;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_statefile::Opts;
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
use super::secret_input::required_request_id;
use super::staged_originals::STAGED_ORIGINALS_MAX_BYTES;
use super::staged_originals::STAGED_ORIGINALS_TTL_MS;
use super::staged_originals::StageLimits;
use super::staged_originals::StagedOriginals;

fn golden(name: &str) -> Value {
    let text = match name {
        "secret-slots.json" => include_str!("../../../../fixtures/turn-ops/secret-slots.json"),
        "staged-originals.json" => include_str!("../../../../fixtures/turn-ops/staged-originals.json"),
        "composer-image.json" => mixdog_testkit::fixture!("../../fixtures/turn-ops/composer-image.json"),
        other => panic!("{other}"),
    };
    serde_json::from_str(text).unwrap()
}

/// A file-system job on the durability lane, as the banned blocking calls must run.
async fn io<R: Send + 'static>(job: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> R {
    on_lane(mixdog_rt::testing::tokens().durability_io, &mixdog_rt::CancellationToken::new(), job).await.unwrap()
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap()
}

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

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

const FRESH: StageLimits = StageLimits { now_ms: 0, max_bytes: STAGED_ORIGINALS_MAX_BYTES, ttl_ms: STAGED_ORIGINALS_TTL_MS };

async fn stage_bytes(originals: &std::sync::Arc<StagedOriginals>, bytes: Vec<u8>, limits: StageLimits) -> Result<String, String> {
    let originals = originals.clone();
    let tokens = mixdog_rt::testing::tokens();
    on_lane(tokens.durability_io, &mixdog_rt::CancellationToken::new(), move |lane| originals.stage(lane, &bytes, limits)).await.unwrap()
}

fn listing(lane: &InLane<DurabilityIo>, dir: &Path, prefix: &str, out: &mut Vec<String>) {
    let Ok(names) = mixdog_statefile::list_dir(lane, dir) else { return };
    for entry in names {
        let name = format!("{prefix}{entry}");
        out.push(name.clone());
        listing(lane, &dir.join(entry), &format!("{name}/"), out);
    }
}

fn snapshot(lane: &InLane<DurabilityIo>, root: &Path) -> Value {
    let index = mixdog_statefile::read_content(&root.join("staged-originals.json")).ok().flatten().map(|b| String::from_utf8(b).unwrap());
    let mut all = Vec::new();
    listing(lane, &root.join("sha256"), "", &mut all);
    let mut blobs: Vec<String> = all.iter().filter_map(|f| f.rsplit('/').next()).filter(|f| f.len() == 64).map(str::to_owned).collect();
    blobs.sort();
    let mut named = Vec::new();
    listing(lane, &root.join("files"), "", &mut named);
    named.sort();
    json!({ "index": index, "blobs": blobs, "named": named })
}

#[tokio::test]
async fn staged_originals_follow_the_recorded_scenarios() {
    for scenario in golden("staged-originals.json")["scenarios"].as_array().unwrap() {
        let name = text(scenario, "name");
        let dir = tempfile::tempdir().unwrap();
        let originals = std::sync::Arc::new(StagedOriginals::new(dir.path()));
        let root = dir.path().join("prompt-attachments");
        for recorded in scenario["steps"].as_array().unwrap() {
            let step = &recorded["step"];
            let blob = |text: &str| root.join("sha256").join(&sha(text.as_bytes())[..2]).join(sha(text.as_bytes()));
            match text(step, "op") {
                "stage" => {
                    let bytes = if step["empty"] == json!(true) { Vec::new() } else { text(step, "text").as_bytes().to_vec() };
                    let limits = StageLimits {
                        now_ms: step["now"].as_f64().unwrap() as i64,
                        max_bytes: step["maxBytes"].as_u64().unwrap_or(STAGED_ORIGINALS_MAX_BYTES),
                        ttl_ms: step["ttlMs"].as_i64().unwrap_or(STAGED_ORIGINALS_TTL_MS),
                    };
                    let got = stage_bytes(&originals, bytes, limits).await;
                    match (&got, recorded["result"].get("ok"), recorded["result"].get("error")) {
                        (Ok(reference), Some(ok), _) => assert_eq!(&json!(reference), ok, "{name}"),
                        (Err(message), _, Some(error)) => assert_eq!(message, text(error, "message"), "{name}"),
                        other => panic!("{name}: {other:?}"),
                    }
                }
                "claim" => {
                    let refs: Vec<String> = recorded["refs"].as_array().unwrap().iter().map(|r| r.as_str().unwrap().to_owned()).collect();
                    let originals = originals.clone();
                    let mut claimed: Vec<String> = io(move |lane| originals.claim(lane, &refs)).await.into_iter().collect();
                    claimed.sort();
                    assert_eq!(json!(claimed), recorded["result"]["ok"], "{name}");
                }
                "prune" => {
                    let originals = originals.clone();
                    let (now, ttl) = (step["now"].as_i64().unwrap(), step["ttlMs"].as_i64().unwrap());
                    let kept = io(move |lane| originals.prune(lane, now, ttl)).await.unwrap();
                    let kept: Vec<Value> = kept.iter().map(|e| e["ref"].clone()).collect();
                    assert_eq!(json!(kept), recorded["result"]["ok"], "{name}");
                }
                "plantIndex" => planted(root.join("staged-originals.json"), text(step, "text")).await,
                "plantBlob" => planted(blob(text(step, "text")), text(step, "text")).await,
                "plantNamed" => planted(root.join("files").join(sha(text(step, "text").as_bytes())).join("picked.png"), "x").await,
                "dropBlob" => {
                    let path = blob(text(step, "text"));
                    io(move |lane| mixdog_statefile::remove_file(lane, &path)).await.unwrap();
                }
                other => panic!("{other}"),
            }
            let at = root.clone();
            assert_eq!(io(move |lane| snapshot(lane, &at)).await, recorded["after"], "{name}: after {step}");
        }
    }
}

/// A file written under its parent folders, created as the stage does.
async fn planted(path: std::path::PathBuf, text: &str) {
    let bytes = text.as_bytes().to_vec();
    io(move |lane| {
        mixdog_statefile::create_private_dir_all(lane, path.parent().unwrap()).unwrap();
        mixdog_statefile::write_file(lane, &path, &bytes, &Opts::default()).unwrap();
    })
    .await;
}

struct Resizer {
    recorded: Value,
    profile: Mutex<Option<ImageProfile>>,
}

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

/// An input as recorded: a payload too big to keep is its character and length.
fn input_of(recorded: &Value) -> Value {
    let mut input = recorded.clone();
    if let Some(repeat) = recorded["data"].get("repeat") {
        input["data"] = json!(repeat.as_str().unwrap().repeat(recorded["data"]["count"].as_u64().unwrap() as usize));
    }
    input
}

#[test]
fn the_provider_picks_the_image_profile() {
    for case in golden("composer-image.json")["profiles"].as_array().unwrap() {
        let provider = case["provider"].as_str().unwrap_or_default();
        let expected = if text(case, "profile") == "openai" { ImageProfile::OpenAi } else { ImageProfile::Anthropic };
        assert_eq!(composer_image::image_profile_for_provider(provider), expected, "{case}");
    }
}

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

#[tokio::test]
async fn resize_image_answers_as_the_composer_action_does() {
    for case in golden("composer-image.json")["resize"].as_array().unwrap() {
        let name = text(case, "name");
        let dir = tempfile::tempdir().unwrap();
        let originals = std::sync::Arc::new(StagedOriginals::new(dir.path()));
        let resizer = Resizer { recorded: case["resizer"].clone(), profile: Mutex::new(None) };
        let stage = |bytes: Vec<u8>| {
            let originals = originals.clone();
            async move { stage_bytes(&originals, bytes, StageLimits { now_ms: 1, ..FRESH }).await }
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

#[tokio::test]
async fn stage_attachment_original_answers_as_the_action_does() {
    for case in golden("composer-image.json")["stage"].as_array().unwrap() {
        let name = text(case, "name");
        let dir = tempfile::tempdir().unwrap();
        let originals = std::sync::Arc::new(StagedOriginals::new(dir.path()));
        let stage = |bytes: Vec<u8>| {
            let originals = originals.clone();
            async move { stage_bytes(&originals, bytes, StageLimits { now_ms: 1, ..FRESH }).await }
        };
        let got = composer_image::stage_original_payload(&input_of(&case["input"]), stage).await;
        match (&got, case["answer"].get("ok"), case["answer"].get("error")) {
            (Ok(answer), Some(ok), _) => assert_eq!(answer, ok, "{name}"),
            (Err(message), _, Some(error)) => assert_eq!(message, text(error, "message"), "{name}"),
            other => panic!("{name}: {other:?}"),
        }
    }
}

#[tokio::test]
async fn a_payload_with_no_image_resizer_follows_the_inline_limits() {
    // Without sharp `resizeImageBuffer` answers null: the bytes pass through inline, up to the
    // limits `imageAttachmentFromBuffer` states.
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
    let small = run(vec![1, 2, 3], "").await.unwrap();
    assert_eq!((small.content.as_str(), small.media_type.as_str(), small.metadata_text), ("AQID", "image/png", None));
    assert_eq!(run(Vec::new(), "image/png").await.err().unwrap(), "image is empty");
    let big = run(vec![0; 4 * 1024 * 1024], "image/png").await.err().unwrap();
    assert_eq!(big, "image is 4.0MB; install optional sharp support or resize it first");
}

fn units_of(text: &Value) -> String {
    match text {
        Value::String(s) => s.clone(),
        long => long["unit"].as_str().unwrap().repeat(usize::try_from(long["times"].as_u64().unwrap()).unwrap()) + long["suffix"].as_str().unwrap(),
    }
}

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

struct StepClock(std::sync::atomic::AtomicI64);

impl super::Clock for StepClock {
    fn now_ms(&self) -> i64 {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[tokio::test(start_paused = true)]
async fn staged_originals_expire_on_their_own_deadline() {
    let doc = golden("staged-originals.json");
    assert_eq!(doc["ttlMs"], json!(STAGED_ORIGINALS_TTL_MS));
    let dir = tempfile::tempdir().unwrap();
    let originals = std::sync::Arc::new(StagedOriginals::new(dir.path()));
    let clock = std::sync::Arc::new(StepClock(0.into()));
    let tokens = mixdog_rt::testing::tokens();
    let root = dir.path().join("prompt-attachments");
    let mut passes = originals.passes();
    for recorded in doc["deadline"].as_array().unwrap() {
        let step = &recorded["step"];
        let name = format!("{step}");
        match text(step, "op") {
            "stage" => {
                let limits = StageLimits { now_ms: step["now"].as_i64().unwrap(), ..FRESH };
                stage_bytes(&originals, text(step, "text").as_bytes().to_vec(), limits).await.unwrap();
            }
            "start" => {
                let before = *passes.borrow();
                originals.start_prune(tokens.durability_io, clock.clone(), mixdog_rt::CancellationToken::new());
                // The task has read the index and armed its first deadline.
                crate::session::testing::awaiting(|| "the prune task's first pass".to_owned(), passes.wait_for(|n| *n > before)).await.unwrap();
            }
            "claim" => {
                let refs: Vec<String> = step["refs"].as_array().unwrap().iter().map(|t| sha(t.as_str().unwrap().as_bytes())).collect();
                let originals = originals.clone();
                assert_eq!(io(move |lane| originals.claim(lane, &refs)).await.len(), 1, "{name}");
            }
            "tick" => {
                let ms = step["ms"].as_u64().unwrap();
                // Whether this tick reaches the armed deadline is decided before the clock moves: the
                // prune task clears the deadline once its timer fires. The deadline passing runs one
                // prune pass; a deadline not yet reached runs none.
                let target = clock.0.load(std::sync::atomic::Ordering::SeqCst) + i64::try_from(ms).unwrap();
                let due = originals.earliest_at().is_some_and(|at| at + STAGED_ORIGINALS_TTL_MS as f64 + 1.0 <= target as f64);
                let before = *passes.borrow();
                clock.0.store(target, std::sync::atomic::Ordering::SeqCst);
                tokio::time::advance(Duration::from_millis(ms)).await;
                if due {
                    crate::session::testing::awaiting(|| "the prune pass the tick reaches".to_owned(), passes.wait_for(|n| *n > before)).await.unwrap();
                }
                if let Some(at) = recorded.get("stagedAt") {
                    let limits = StageLimits { now_ms: at.as_i64().unwrap(), ..FRESH };
                    stage_bytes(&originals, b"later".to_vec(), limits).await.unwrap();
                }
            }
            other => panic!("{other}"),
        }
        let at = root.clone();
        let index = io(move |lane| snapshot(lane, &at)).await["index"].as_str().map(|text| serde_json::from_str::<Vec<Value>>(text).unwrap());
        let refs = index.map(|entries| json!(entries.iter().map(|e| e["ref"].clone()).collect::<Vec<_>>()));
        assert_eq!(refs.unwrap_or(Value::Null), recorded["index"], "{name}");
    }
}

#[test]
fn a_message_names_its_originals_and_loses_the_ones_not_claimed() {
    use super::staged_originals::drop_lost_originals;
    use super::staged_originals::named_originals;
    let kept = "a".repeat(64);
    let gone = "b".repeat(64);
    let image = |original: Option<&str>| match original {
        Some(r) => json!({ "id": 1, "type": "image", "mediaType": "image/jpeg", "originalRef": r, "originalMediaType": "image/png" }),
        None => json!({ "id": 2, "type": "image", "mediaType": "image/jpeg" }),
    };
    let mut params = json!({ "input": { "prompt": "p", "options": { "pastedImages": { "1": image(Some(&kept)), "2": image(Some(&gone)), "3": image(None) } } } });
    assert_eq!(named_originals(&params), vec![kept.clone(), gone.clone()]);
    drop_lost_originals(&mut params, &[kept.clone()].into_iter().collect());
    let images = &params["input"]["options"]["pastedImages"];
    assert_eq!(images["1"]["originalRef"], json!(kept));
    assert_eq!(images["1"]["originalMediaType"], json!("image/png"));
    assert_eq!(images["2"], json!({ "id": 1, "type": "image", "mediaType": "image/jpeg" }));
    assert_eq!(images["3"], image(None));
}

#[tokio::test(start_paused = true)]
async fn a_turn_claims_the_originals_it_names_before_it_is_submitted() {
    use super::testing::Rig;
    let rig = Rig::new();
    let seen = std::sync::Arc::new(Mutex::new(None));
    let sink = seen.clone();
    rig.set_script(std::sync::Arc::new(move |run| {
        let sink = sink.clone();
        Box::pin(async move {
            *sink.lock().unwrap() = Some(serde_json::to_value(&run.input.options).unwrap());
            super::seams::RunOutcome::Completed(Default::default())
        })
    }));
    let deps = rig.deps();
    let directory = super::SessionDirectory::new(deps.clone());
    let handle = super::tests::start_thread(&directory).await;
    let originals = deps.staged_originals.clone();
    let stage = |text: &'static str| stage_bytes(&originals, text.as_bytes().to_vec(), StageLimits { now_ms: 5, ..FRESH });
    let (claimed, bystander, evicted) = (stage("claimed").await.unwrap(), stage("bystander").await.unwrap(), sha(b"never staged"));
    let image = |id: i64, original: &str| json!({ "id": id, "type": "image", "mediaType": "image/jpeg", "originalRef": original, "originalMediaType": "image/png" });
    let params = json!({
        "threadId": handle.id, "opId": "op-claim",
        "input": { "prompt": "look", "options": { "pastedImages": { "1": image(1, &claimed), "2": image(2, &evicted) } } },
    });
    use mixdog_core_api::ThreadHandle as _;
    handle.request(request("turn/start", params, Some(1))).await.unwrap();
    let options = crate::eventually_on!(&[&handle.cell.stepped], || seen.lock().unwrap().clone()).await;
    assert_eq!(options["pastedImages"]["1"]["originalRef"], json!(claimed));
    assert!(options["pastedImages"]["2"].get("originalRef").is_none() && options["pastedImages"]["2"].get("originalMediaType").is_none());
    let at = dir_of(&deps).join("prompt-attachments");
    let kept: Vec<String> = io(move |lane| snapshot(lane, &at)).await["index"].as_str().map(|t| serde_json::from_str::<Vec<Value>>(t).unwrap()).unwrap().iter().map(|e| e["ref"].as_str().unwrap().to_owned()).collect();
    assert_eq!(kept, vec![bystander], "the claimed original left the staged set, the other stayed");
}

/// A message the attachment intake refuses (`preparePromptSubmissionForProvider` throws in `submitAdmitted`) is the
/// submit's error with the intake's text: no turn runs, and the originals it names stay staged (the claim comes after).
#[tokio::test(start_paused = true)]
async fn a_message_the_intake_refuses_answers_its_text_and_claims_nothing() {
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
    let deps = std::sync::Arc::new(parts);
    let directory = super::SessionDirectory::new(deps.clone());
    let handle = super::tests::start_thread(&directory).await;
    let staged = stage_bytes(&deps.staged_originals, b"original".to_vec(), StageLimits { now_ms: 5, ..FRESH }).await.unwrap();
    let image = json!({ "id": 1, "type": "image", "mediaType": "image/jpeg", "originalRef": staged, "originalMediaType": "image/png" });
    let params = json!({ "threadId": handle.id, "opId": "op-refused", "input": { "prompt": "look", "options": { "pastedImages": { "1": image } } } });
    use mixdog_core_api::ThreadHandle as _;
    let refused = handle.request(request("turn/start", params, Some(1))).await.expect_err("refused");
    let CoreError::DomainError { message, code, .. } = refused else { panic!("a domain error: {refused:?}") };
    assert_eq!((message.as_deref(), code), (Some("PDF exceeds the 20 MiB input limit"), None));
    assert!(!ran.load(std::sync::atomic::Ordering::SeqCst), "no turn ran");
    let at = dir_of(&deps).join("prompt-attachments");
    let kept: Vec<String> = io(move |lane| snapshot(lane, &at)).await["index"].as_str().map(|t| serde_json::from_str::<Vec<Value>>(t).unwrap()).unwrap().iter().map(|e| e["ref"].as_str().unwrap().to_owned()).collect();
    assert_eq!(kept, vec![staged], "the original stays staged");
}

fn dir_of(deps: &super::SessionDeps) -> std::path::PathBuf {
    deps.attachments.0.clone()
}
