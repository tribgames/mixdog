//! The installer against a local release server: what a toggle-on downloads, verifies, stages
//! and publishes, and what a bad digest, a missing asset or an unknown platform leave behind.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]

use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;
use crate::voice::runtime::{RuntimeManifest, SERVER_NAME, resolve_voice_runtime};

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn zip_of(name: &str, body: &[u8]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    writer.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
    writer.write_all(body).unwrap();
    writer.finish().unwrap().into_inner()
}

fn gz_of(body: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(body).unwrap();
    encoder.finish().unwrap()
}

/// A release server: path to body; anything else is a 404. Every request path is logged.
async fn serve(routes: BTreeMap<String, Vec<u8>>) -> (String, Arc<Mutex<Vec<String>>>) {
    serve_on("127.0.0.1:0", routes).await
}

async fn serve_on(address: &str, routes: BTreeMap<String, Vec<u8>>) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind(address).await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let log: Arc<Mutex<Vec<String>>> = Arc::default();
    let seen = log.clone();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let (routes, seen) = (routes.clone(), seen.clone());
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut chunk = [0u8; 1024];
                while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                    match socket.read(&mut chunk).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => head.extend_from_slice(&chunk[..n]),
                    }
                }
                let path = String::from_utf8_lossy(&head).split_whitespace().nth(1).unwrap_or("/").to_owned();
                seen.lock().unwrap().push(path.clone());
                let reply = match routes.get(&path) {
                    Some(body) => {
                        let mut reply = format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len()).into_bytes();
                        reply.extend_from_slice(body);
                        reply
                    }
                    None => b"HTTP/1.1 404 Not Found\r\ncontent-length: 9\r\nconnection: close\r\n\r\nnot found".to_vec(),
                };
                let _ = socket.write_all(&reply).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    (base, log)
}

struct World {
    base: String,
    log: Arc<Mutex<Vec<String>>>,
    manifest: Value,
}

/// A manifest for platform `test-x64` whose assets the server holds; `model_sha` overrides the
/// model's digest.
async fn world(model_sha: Option<&str>) -> World {
    let whisper = zip_of(SERVER_NAME, b"server bytes");
    let ffmpeg = gz_of(b"ffmpeg bytes");
    let model = b"model weights".to_vec();
    let routes: BTreeMap<String, Vec<u8>> =
        [("/whisper.zip".to_owned(), whisper.clone()), ("/ffmpeg.gz".to_owned(), ffmpeg.clone()), ("/model.bin".to_owned(), model.clone())].into();
    let (base, log) = serve(routes).await;
    let model_entry = json!({
        "id": "m", "filename": "m.bin", "url": format!("{base}/model.bin"),
        "sha256": model_sha.map_or_else(|| hex(&model), str::to_owned), "size": model.len(),
    });
    let manifest = json!({
        "version": "1.0.0",
        "model": model_entry,
        "models": { "standard": model_entry },
        "ffmpeg": { "version": "2.0", "platforms": { "test-x64": {
            "url": format!("{base}/ffmpeg.gz"), "sha256": hex(&ffmpeg), "size": ffmpeg.len(), "format": "gz", "executable": "ffmpeg",
        } } },
        "platforms": { "test-x64": { "variants": [{
            "id": "cpu", "requires": null, "url": format!("{base}/whisper.zip"), "sha256": hex(&whisper),
            "size": whisper.len(), "format": "zip", "executable": SERVER_NAME,
        }] } },
    });
    World { base, log, manifest }
}

fn installer(data: &Path, manifest: &Value, platform: &str) -> ManagedVoiceInstaller {
    let tokens = mixdog_rt::testing::tokens();
    ManagedVoiceInstaller::new(InstallerParts {
        data_dir: data.to_owned(),
        manifest: manifest.clone(),
        platform_keys: vec![platform.to_owned()],
        env_vars: Vec::new(),
        pid: std::process::id(),
        durability: tokens.durability_io,
        bulk: tokens.cpu_bulk,
        now: Arc::new(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64),
    })
}

const GOLDEN: &str = include_str!("../../../../../fixtures/services/voice-installer-twin.json");

fn listing(root: &Path) -> Value {
    fn walk(root: &Path, dir: &Path, out: &mut serde_json::Map<String, Value>) {
        let Ok(read) = std::fs::read_dir(dir) else { return };
        for entry in read.flatten() {
            let path = entry.path();
            let rel = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            if path.is_dir() {
                out.insert(format!("{rel}/"), Value::Null);
                walk(root, &path, out);
            } else {
                let data = std::fs::read(&path).unwrap();
                out.insert(rel, json!({ "size": data.len(), "sha256": hex(&data) }));
            }
        }
    }
    let mut out = serde_json::Map::new();
    walk(root, root, &mut out);
    Value::Object(out)
}

/// Node's installer (`record-voice-installer.mjs`: the real `voice-runtime-fetcher.mjs` against a
/// local release server on a scratch folder): every error text the user can see, the requests
/// made and the tree left behind must equal Node's. The recording holds `{root}` (the scratch
/// folder), `{base}` (the server's address) and `staging-{tag}` where Node's run had its own;
/// the replay lays its own scratch folder and server down, fills the placeholders in what it
/// feeds the installer, and masks its own text the same way. The corrupt archive's text is
/// PowerShell's own stderr, so only its lead-in is compared.
#[cfg(windows)]
#[tokio::test]
async fn installs_match_nodes_recording() {
    use base64::Engine as _;
    static STAGING: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"staging-[0-9]+-[0-9]+").unwrap());
    fn fill(value: &Value, root: &str, base: &str) -> Value {
        match value {
            Value::String(text) => Value::String(text.replace("{root}", root).replace("{base}", base)),
            Value::Array(items) => Value::Array(items.iter().map(|item| fill(item, root, base)).collect()),
            Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), fill(item, root, base))).collect()),
            other => other.clone(),
        }
    }
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path().to_string_lossy().into_owned();
    let mask = |text: &str, base: &str| {
        let text = text.replace(&root.replace('\\', "/"), "{root}").replace(&root, "{root}").replace(base, "{base}");
        STAGING.replace_all(&text, "staging-{tag}").into_owned()
    };
    let routes: BTreeMap<String, Vec<u8>> = golden["assets"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(path, body)| (path.clone(), base64::engine::general_purpose::STANDARD.decode(body.as_str().unwrap()).unwrap()))
        .collect();
    let (base, log) = serve(routes).await;
    let tokens = mixdog_rt::testing::tokens();
    for recorded in golden["scenarios"].as_array().unwrap() {
        let scenario = &fill(recorded, &root, &base);
        let name = scenario["name"].as_str().unwrap();
        let data = scratch.path().join("data").join(name);
        std::fs::create_dir_all(&data).unwrap();
        for (rel, text) in scenario["seed"].as_object().unwrap() {
            let path = data.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text.as_str().unwrap()).unwrap();
        }
        for file in scenario["files"].as_array().unwrap() {
            let path = std::path::PathBuf::from(file.as_str().unwrap());
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "x").unwrap();
        }
        let env_vars: Vec<(String, String)> = scenario["env"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect();
        let installer = ManagedVoiceInstaller::new(InstallerParts {
            data_dir: data.clone(),
            manifest: scenario["manifest"].clone(),
            platform_keys: vec![golden["hostKey"].as_str().unwrap().to_owned()],
            env_vars,
            pid: std::process::id(),
            durability: tokens.durability_io,
            bulk: tokens.cpu_bulk,
            now: Arc::new(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64),
        });
        let op = scenario["op"].as_str().unwrap();
        let missing = Missing { whisper: op == "whisper", model: op == "model", ffmpeg: op == "ffmpeg" };
        log.lock().unwrap().clear();
        let outcome = installer.install(missing, None).await;
        match (outcome, scenario.get("error").and_then(Value::as_str)) {
            (Ok(()), None) => {}
            (Err(got), Some(want)) if name == "whisper-corrupt-zip" => {
                let lead = "[voice-runtime] zip extract failed via Expand-Archive: ";
                assert!(got.starts_with(lead) && want.starts_with(lead), "{name}: {got}");
            }
            (Err(got), Some(want)) => assert_eq!(mask(&got, &base), recorded["error"].as_str().unwrap(), "{name}: {want}"),
            (got, want) => panic!("{name}: {got:?} vs recorded {want:?}"),
        }
        assert_eq!(json!(log.lock().unwrap().clone()), scenario["requests"], "{name}: requests");
        assert_eq!(listing(&data), scenario["tree"], "{name}: tree");
    }
}

const ALL: Missing = Missing { whisper: true, model: true, ffmpeg: true };

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir).map(|r| r.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    names.sort();
    names
}

#[tokio::test]
async fn a_toggle_on_installs_every_missing_piece_and_cleans_up_after_itself() {
    let world = world(None).await;
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path();
    // A garbage lock, a superseded runtime, an undeclared weight and a partial download, as a crashed install leaves.
    std::fs::create_dir_all(data.join("voice-runtime/whisper-0.9.0-cpu")).unwrap();
    std::fs::write(data.join("voice-runtime/.install.lock"), "garbage").unwrap();
    std::fs::create_dir_all(data.join("voice/models")).unwrap();
    std::fs::write(data.join("voice/models/old.bin"), "old").unwrap();
    std::fs::write(data.join("voice/models/.staging-1-2-m.bin"), "partial").unwrap();

    installer(data, &world.manifest, "test-x64").install(ALL, None).await.unwrap();

    let manifest = RuntimeManifest::from_json(&world.manifest, "test-x64", "standard").unwrap();
    let runtime = resolve_voice_runtime(data, &manifest);
    assert!(runtime.installed && !runtime.stale, "{runtime:?}");
    assert_eq!(std::fs::read_to_string(data.join("voice-runtime/active-version")).unwrap(), "whisper-1.0.0-cpu");
    assert_eq!(std::fs::read_to_string(data.join("ffmpeg-runtime/active-version")).unwrap(), "ffmpeg-2.0");
    assert_eq!(std::fs::read(data.join("ffmpeg-runtime/ffmpeg-2.0/ffmpeg")).unwrap(), b"ffmpeg bytes");
    assert_eq!(names(&data.join("voice-runtime")), ["active-version", "whisper-1.0.0-cpu"]);
    assert_eq!(names(&data.join("ffmpeg-runtime")), ["active-version", "ffmpeg-2.0"]);
    assert_eq!(names(&data.join("voice/models")), ["m.bin"]);

    // Nothing missing: nothing is fetched again.
    let before = world.log.lock().unwrap().len();
    installer(data, &world.manifest, "test-x64").install(ALL, None).await.unwrap();
    assert_eq!(world.log.lock().unwrap().len(), before, "an installed component is never re-fetched ({})", world.base);
}

#[tokio::test]
async fn a_digest_that_does_not_match_fails_the_install_and_removes_the_partial_file() {
    let world = world(Some(&"0".repeat(64))).await;
    let dir = tempfile::tempdir().unwrap();
    let error = installer(dir.path(), &world.manifest, "test-x64").install(Missing { whisper: false, model: true, ffmpeg: false }, None).await.unwrap_err();
    assert!(error.starts_with("[voice-runtime] sha256 mismatch for "), "{error}");
    assert!(error.contains(&format!("expected {}", "0".repeat(64))), "{error}");
    assert!(names(&dir.path().join("voice/models")).is_empty(), "no staging file and no lock stay behind");
}

#[tokio::test]
async fn a_missing_asset_fails_with_the_http_status_and_leaves_no_staging_directory() {
    let mut world = world(None).await;
    world.manifest["platforms"]["test-x64"]["variants"][0]["url"] = json!(format!("{}/gone.zip", world.base));
    let dir = tempfile::tempdir().unwrap();
    let error = installer(dir.path(), &world.manifest, "test-x64").install(Missing { whisper: true, model: false, ffmpeg: false }, None).await.unwrap_err();
    assert!(error.contains("404"), "{error}");
    assert!(names(&dir.path().join("voice-runtime")).is_empty(), "{:?}", names(&dir.path().join("voice-runtime")));
}

#[tokio::test]
async fn a_platform_the_manifest_does_not_list_is_named() {
    let world = world(None).await;
    let dir = tempfile::tempdir().unwrap();
    let error = installer(dir.path(), &world.manifest, "nope-x1").install(ALL, None).await.unwrap_err();
    assert_eq!(error, "voice runtime not supported on nope-x1 — voice transcription is unavailable on this platform");
}

#[tokio::test]
async fn a_lock_is_listed_while_held_and_unlinked_when_its_install_is_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let installer = installer(dir.path(), &json!({}), "x");
    let (root, path) = (dir.path().join("r"), dir.path().join("r/.install.lock"));
    let lock = installer.acquire(&root, "install").await.unwrap();
    assert!(path.exists() && held().contains(&path));
    drop(lock);
    assert!(!path.exists() && !held().contains(&path), "a cancelled install leaves no lock behind");
    let lock = installer.acquire(&root, "install").await.unwrap();
    installer.release(lock).await;
    assert!(!path.exists() && !held().contains(&path));
}

#[test]
fn variants_are_picked_by_cuda_then_driver_then_the_catch_all_never_by_order() {
    let variants = vec![
        json!({ "id": "base", "requires": null }),
        json!({ "id": "driver", "requires": { "nvidiaDriver": true } }),
        json!({ "id": "cuda11", "requires": { "cudaMajor": 11 } }),
        json!({ "id": "cuda12", "requires": { "cudaMajor": 12 } }),
    ];
    let pick = |env: &VariantEnv| pick_variant(&variants, env).map(|v| v["id"].as_str().unwrap().to_owned());
    let env = |majors: &[u64], driver| VariantEnv { cuda_majors: majors.iter().copied().collect(), nvidia_driver: driver };
    assert_eq!(pick(&env(&[11, 12], true)).as_deref(), Some("cuda12"));
    assert_eq!(pick(&env(&[11], false)).as_deref(), Some("cuda11"));
    assert_eq!(pick(&env(&[], true)).as_deref(), Some("driver"));
    assert_eq!(pick(&env(&[], false)).as_deref(), Some("base"));
    assert_eq!(pick_variant(&variants[1..], &env(&[], false)).map(|v| v["id"].clone()), None);
}
