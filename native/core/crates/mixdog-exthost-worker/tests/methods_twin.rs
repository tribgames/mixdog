//! The document methods the real worker serves, driven through the pool over `ext_worker_dev` and replayed against what Node's
//! worker answered: `media.officeText` over `fixtures/tools/media-text/office.json`, `ooxml.text` in both forms over
//! `fixtures/ooxml-text/golden.json` (with the refusals), the image `probe`, `jpeg` and `validate` envelopes over
//! `fixtures/image-codec`, and the case of `src/ext-host/ooxml.e2e.test.mjs`.

use std::path::Path;
use std::path::PathBuf;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::ext::ExtCall;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::ExtFrame;
use mixdog_core_api::domain::ext::ExtPool;
use mixdog_exthost::ExtHostConfig;
use mixdog_exthost::ExtHostPool;
use mixdog_exthost::RenderBrowserConfig;
use mixdog_fsio::Unlaned;
use mixdog_ooxml_text::ExtractOptions;
use mixdog_ooxml_text::Limits;
use mixdog_ooxml_text::extract_ooxml_text;
use mixdog_ooxml_text::try_extract_ooxml_text_from_buffer;
use mixdog_protocol::ThreadId;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

fn fixture_json(relative: &str) -> Vec<Value> {
    serde_json::from_str(&mixdog_testkit::read_string(fixtures().join(relative))).expect("the fixture parses")
}

fn pool() -> ExtHostPool {
    ExtHostPool::new(ExtHostConfig {
        program: PathBuf::from(env!("CARGO_BIN_EXE_ext_worker_dev")),
        args: Vec::new(),
        electron: false,
        workers: 2,
        pending_cap: 64,
        spawn_io: mixdog_rt::testing::tokens().spawn_io,
        render_browser: RenderBrowserConfig {
            command: None,
            profile_root: std::env::temp_dir().join("mixdog-exthost-worker-methods-tests"),
            no_sandbox: false,
        },
    })
    .expect("the pool starts")
}

async fn ask(pool: &ExtHostPool, method: &str, params: Value, approved: &[&Path]) -> Result<Value, ExtError> {
    let mut stream = pool
        .call(ExtCall {
            thread: ThreadId::from("methods-twin"),
            method: method.to_owned(),
            params,
            paths: approved.iter().map(|path| AbsPath::new(path.to_path_buf()).expect("an absolute path")).collect(),
        })
        .expect("the call is accepted");
    loop {
        match stream.next().await.expect("the stream ends with Done") {
            ExtFrame::Chunk(_) => {}
            ExtFrame::Done(outcome) => return outcome,
        }
    }
}

fn refused(outcome: Result<Value, ExtError>) -> (String, String) {
    match outcome {
        Err(ExtError::Failed { code, message }) => (code, message),
        other => panic!("expected a refusal, got {other:?}"),
    }
}

/// What a recording holds for one answer: the text, `null`, or (for a text too large to keep) its size, hash and end.
fn matches_recording(what: &str, actual: &Value, want: &Value) {
    match want {
        Value::Null => assert_eq!(actual, &Value::Null, "{what}"),
        Value::String(text) => assert_eq!(actual.as_str(), Some(text.as_str()), "{what}"),
        Value::Object(digest) => {
            let actual = actual.as_str().unwrap_or_else(|| panic!("{what}: no text, the recording has one"));
            assert_eq!(actual.len() as u64, digest["bytes"].as_u64().unwrap(), "{what}: byte count");
            let hash: String = Sha256::digest(actual.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect();
            assert_eq!(hash, digest["sha256"].as_str().unwrap(), "{what}: sha256");
            let tail: Vec<char> = actual.chars().rev().take(80).collect();
            let tail: String = tail.into_iter().rev().collect();
            assert_eq!(tail, digest["tail"].as_str().unwrap(), "{what}: last 80 characters");
        }
        other => panic!("{what}: unexpected recording {other}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn attached_office_files_answer_the_media_text_set() {
    let pool = pool();
    let cases = fixture_json("tools/media-text/office.json");
    assert!(cases.len() >= 9);
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let answer = ask(&pool, "media.officeText", json!({"data": case["dataBase64"], "filename": case["filename"]}), &[])
            .await
            .unwrap_or_else(|error| panic!("{name}: {error:?}"));
        let want = match case.get("text") {
            Some(text) => text.clone(),
            None => json!({"bytes": case["textBytes"], "sha256": case["textSha256"], "tail": case["textTail"]}),
        };
        matches_recording(name, &answer["text"], &want);
    }
    let (code, message) = refused(ask(&pool, "media.officeText", json!({"data": 7, "filename": "a.docx"}), &[]).await);
    assert_eq!((code.as_str(), message.as_str()), ("invalid_params", "data must be a base64 string"));
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ooxml_text_answers_the_golden_in_both_forms() {
    let pool = pool();
    let cases = fixture_json("ooxml-text/golden.json");
    let scratch = tempfile::tempdir().expect("scratch folder");
    let mut files = 0;
    for case in &cases {
        let Some(want_file) = case.get("file") else { continue };
        let name = case["name"].as_str().unwrap();
        let filename = case["filename"].as_str().unwrap();
        let path = scratch.path().join(filename);
        mixdog_testkit::write(&path, STANDARD.decode(case["dataBase64"].as_str().unwrap()).unwrap());
        let options = &case["options"];
        let path_text = path.to_string_lossy().into_owned();

        // The read tool's form: the text, or the `Error: ...` line it shows.
        let got = ask(&pool, "ooxml.text", json!({"path": path_text, "maxOutputBytes": options["maxOutputBytes"]}), &[scratch.path()])
            .await
            .unwrap_or_else(|error| panic!("{name}: {error:?}"));
        matches_recording(&format!("{name}: file"), &got["text"], want_file);

        // Provider lowering's form: the text, or null for a package that cannot be read.
        let got = ask(
            &pool,
            "ooxml.text",
            json!({
                "path": path_text,
                "filename": filename,
                "maxOutputBytes": options["maxOutputBytes"],
                "maxPartBytes": options["maxPartBytes"],
                "maxContainerBytes": options["maxContainerBytes"],
            }),
            &[scratch.path()],
        )
        .await
        .unwrap_or_else(|error| panic!("{name}: {error:?}"));
        matches_recording(&format!("{name}: try"), &got["text"], &case["try"]);
        mixdog_testkit::remove_file(&path);
        files += 1;
    }
    assert!(files >= 120, "{files} cases with a file");

    let elsewhere = tempfile::tempdir().expect("another folder");
    let outside = elsewhere.path().join("x.docx");
    mixdog_testkit::write(&outside, b"x");
    let (code, message) = refused(ask(&pool, "ooxml.text", json!({"path": outside.to_string_lossy()}), &[scratch.path()]).await);
    assert_eq!(code, "path_not_approved");
    assert!(message.starts_with("path is not approved for this call: "), "{message}");
    let (code, message) = refused(ask(&pool, "ooxml.text", json!({"path": "rel/x.docx"}), &[scratch.path()]).await);
    assert_eq!((code.as_str(), message.as_str()), ("path_not_approved", "path must be absolute: rel/x.docx"));
    pool.close().await;
}

/// The case of `ooxml.e2e.test.mjs`: the method equals the extraction entries in both forms, a file that is not a zip and a
/// missing file included.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ooxml_text_equals_the_extraction_entries() {
    let pool = pool();
    let root = tempfile::tempdir().expect("scratch folder");
    let office = fixture_json("tools/media-text/office.json");
    let docx = office.iter().find(|case| case["filename"].as_str().is_some_and(|name| name.ends_with(".docx"))).expect("a docx case");
    let good = root.path().join("a.docx");
    let bad = root.path().join("b.docx");
    mixdog_testkit::write(&good, STANDARD.decode(docx["dataBase64"].as_str().unwrap()).unwrap());
    mixdog_testkit::write(&bad, b"not a zip");

    for file in [&good, &bad] {
        let got = ask(&pool, "ooxml.text", json!({"path": file.to_string_lossy(), "maxOutputBytes": 1024}), &[root.path()]).await.unwrap();
        let want = extract_ooxml_text(&Unlaned, file, &ExtractOptions { max_output_bytes: 1024 });
        assert_eq!(got["text"].as_str(), Some(want.as_str()), "{}", file.display());
    }
    assert!(!ask(&pool, "ooxml.text", json!({"path": good.to_string_lossy()}), &[root.path()]).await.unwrap()["text"].as_str().unwrap().is_empty());

    // A JSON number's notation must not turn a four-byte output cap into the default.
    let expected = extract_ooxml_text(&Unlaned, &good, &ExtractOptions { max_output_bytes: 4 });
    assert!(expected.contains("truncated at 4 bytes"));
    for cap in [json!(4), json!(4.0)] {
        let got = ask(&pool, "ooxml.text", json!({"path": good.to_string_lossy(), "maxOutputBytes": cap}), &[root.path()]).await.unwrap();
        assert_eq!(got["text"], expected);
    }

    let limits = Limits { max_output_bytes: 1024, max_part_bytes: 8 * 1024 * 1024, max_container_bytes: 32 * 1024 * 1024 };
    for file in [&good, &bad] {
        let want = try_extract_ooxml_text_from_buffer(&mixdog_testkit::read(file), &file.to_string_lossy(), &limits);
        let params = json!({"path": file.to_string_lossy(), "maxOutputBytes": 1024, "maxPartBytes": limits.max_part_bytes, "maxContainerBytes": limits.max_container_bytes});
        let got = ask(&pool, "ooxml.text", params, &[root.path()]).await.unwrap();
        assert_eq!(got["text"].as_str(), want.as_deref(), "{}", file.display());
    }
    let limited = |file: &Path| {
        json!({"path": file.to_string_lossy(), "maxOutputBytes": 1024, "maxPartBytes": limits.max_part_bytes, "maxContainerBytes": limits.max_container_bytes})
    };
    assert_eq!(ask(&pool, "ooxml.text", limited(&bad), &[root.path()]).await.unwrap()["text"], Value::Null);
    let missing = root.path().join("missing.docx");
    assert_eq!(ask(&pool, "ooxml.text", limited(&missing), &[root.path()]).await.unwrap()["text"], Value::Null);
    pool.close().await;
}

fn corpus_input(case: &Value) -> Vec<u8> {
    mixdog_testkit::read(fixtures().join("image-codec/inputs").join(format!("{}.bin", case["input"].as_str().unwrap())))
}

fn corpus_cases(op: &str) -> Vec<Value> {
    let corpus: Value = serde_json::from_str(&mixdog_testkit::read_string(fixtures().join("image-codec/corpus.json"))).expect("the corpus parses");
    let cases: Vec<Value> = corpus["cases"].as_array().unwrap().iter().filter(|case| case["op"] == op).cloned().collect();
    assert!(!cases.is_empty(), "no {op} cases");
    cases
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn image_probe_answers_the_corpus_envelopes() {
    let pool = pool();
    for case in corpus_cases("probe") {
        let name = case["name"].as_str().unwrap();
        let answer = ask(&pool, "image.probe", json!({"data": STANDARD.encode(corpus_input(&case))}), &[]).await.unwrap();
        match case["expect"]["class"].as_str().unwrap() {
            "ok" => assert_eq!(answer, json!({"ok": {"width": case["expect"]["width"], "height": case["expect"]["height"]}}), "{name}"),
            class => assert_eq!(answer, json!({"error": class}), "{name}"),
        }
    }
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn image_jpeg_answers_the_corpus_envelopes() {
    let pool = pool();
    for case in corpus_cases("jpeg") {
        let name = case["name"].as_str().unwrap();
        let mut params = case["jpeg"].clone();
        params["data"] = json!(STANDARD.encode(corpus_input(&case)));
        let answer = ask(&pool, "image.jpeg", params, &[]).await.unwrap();
        match case["expect"]["class"].as_str().unwrap() {
            "ok" => {
                let ok = &answer["ok"];
                assert_eq!((&ok["width"], &ok["height"]), (&case["expect"]["width"], &case["expect"]["height"]), "{name}");
                let data = STANDARD.decode(ok["data"].as_str().unwrap_or_else(|| panic!("{name}: {answer}"))).unwrap();
                assert_eq!(&data[..2], &[0xff, 0xd8], "{name}: a JPEG");
            }
            class => assert_eq!(answer, json!({"error": class}), "{name}"),
        }
    }
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn image_validate_answers_the_corpus_envelopes() {
    let pool = pool();
    for case in corpus_cases("validate") {
        let name = case["name"].as_str().unwrap();
        let params = json!({"data": STANDARD.encode(corpus_input(&case)), "format": case["format"]});
        let answer = ask(&pool, "image.validate", params, &[]).await.unwrap();
        match case["expect"]["class"].as_str().unwrap() {
            "ok" => assert_eq!(answer, json!({"ok": true}), "{name}"),
            class => assert_eq!(answer, json!({"error": class}), "{name}"),
        }
    }
    // An empty buffer has no resizer answer: an environment failure.
    assert_eq!(ask(&pool, "image.validate", json!({"data": "", "format": "png"}), &[]).await.unwrap(), json!({"error": "environment"}));
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn image_calls_refuse_a_malformed_call_with_the_messages_of_the_node_handler() {
    let pool = pool();
    let data = STANDARD.encode(corpus_input(&corpus_cases("probe")[0]));
    let jpeg = |patch: Value| {
        let mut params = json!({"data": data, "width": 10, "height": 10, "allowEnlargement": false, "quality": 80});
        for (key, value) in patch.as_object().unwrap() {
            params[key] = value.clone();
        }
        params
    };
    for (patch, message) in [
        (json!({"width": "10"}), "width must be an integer"),
        (json!({"height": 1.5}), "height must be an integer"),
        (json!({"quality": null}), "quality must be an integer"),
        (json!({"allowEnlargement": 1}), "allowEnlargement must be a boolean"),
        (json!({"data": 5}), "data must be a base64 string"),
    ] {
        let (code, got) = refused(ask(&pool, "image.jpeg", jpeg(patch), &[]).await);
        assert_eq!((code.as_str(), got.as_str()), ("invalid_params", message));
    }
    for method in ["image.probe", "image.validate"] {
        let (code, got) = refused(ask(&pool, method, json!({"data": null}), &[]).await);
        assert_eq!((code.as_str(), got.as_str()), ("invalid_params", "data must be a base64 string"));
    }
    // A whole number written with a fraction is an integer, as in JavaScript.
    let answer = ask(&pool, "image.jpeg", jpeg(json!({"width": 10.0})), &[]).await.unwrap();
    assert!(answer.get("ok").is_some(), "{answer}");
    // An integer too large for a side is an integer to JavaScript: sharp, not the parameter check, rejects it.
    let answer = ask(&pool, "image.jpeg", jpeg(json!({"width": 1.0e16})), &[]).await.unwrap();
    assert_eq!(answer, json!({"error": "invalid"}));
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn svg_buffers_are_accepted_by_all_three_native_image_envelopes() {
    let pool = pool();
    let rows: Vec<Value> = serde_json::from_str(include_str!("../../mixdog-imaging/tests/svg-reference.json")).unwrap();
    for row in rows {
        let data = STANDARD.encode(row["svg"].as_str().unwrap());
        let probe = ask(&pool, "image.probe", json!({"data": data}), &[]).await.unwrap();
        assert_eq!(probe, json!({"ok": {"width": row["width"], "height": row["height"]}}));
        let valid = ask(&pool, "image.validate", json!({"data": data, "format": "png"}), &[]).await.unwrap();
        assert_eq!(valid, json!({"ok": true}));
        let jpeg = ask(&pool, "image.jpeg", json!({
            "data": data, "width": row["width"], "height": row["height"],
            "quality": 85, "allowEnlargement": false,
        }), &[]).await.unwrap();
        assert_eq!(jpeg["ok"]["width"], row["width"]);
        assert_eq!(jpeg["ok"]["height"], row["height"]);
        let bytes = STANDARD.decode(jpeg["ok"]["data"].as_str().unwrap()).unwrap();
        assert!(bytes.starts_with(&[0xff, 0xd8]));
    }
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn avif_and_heic_buffers_are_answered_as_sharp_answers_them() {
    let pool = pool();
    let reference: Value = serde_json::from_str(include_str!("../../mixdog-imaging/tests/avif-reference.json")).unwrap();
    for row in reference["rows"].as_array().unwrap() {
        let name = row["name"].as_str().unwrap();
        let data = row["input"].as_str().unwrap();
        let probe = ask(&pool, "image.probe", json!({"data": data}), &[]).await.unwrap();
        match row["raw"].get("ok") {
            Some(raw) => assert_eq!(probe, json!({"ok": {"width": raw["width"], "height": raw["height"]}}), "{name}"),
            None => assert_eq!(probe, json!({"error": "invalid"}), "{name}"),
        }
        let resized = ask(&pool, "image.resize", json!({"data": data, "ext": "avif"}), &[]).await.unwrap();
        match row["resize"].get("ok") {
            Some(ok) => {
                assert_eq!(resized["ok"]["mimeType"], ok["mime"], "{name}");
                assert_eq!(resized["ok"]["dimensions"], ok["dimensions"], "{name}");
                let bytes = STANDARD.decode(resized["ok"]["data"].as_str().unwrap()).unwrap();
                assert_eq!(&bytes[4..12], b"ftypavif", "{name}: the output is an AVIF file, as sharp writes one");
            }
            None => {
                assert_eq!(resized["error"], "invalid", "{name}");
                assert!(resized["message"].as_str().unwrap().starts_with("invalid or corrupt image data: "), "{name}");
            }
        }
    }
    pool.close().await;
}
