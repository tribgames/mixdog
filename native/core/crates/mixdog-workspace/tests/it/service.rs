#![allow(clippy::disallowed_types, reason = "test setup")]
#![allow(clippy::disallowed_methods, reason = "test setup")]
//! DS-WS-2/3/4/5/6/9 against the service with mock feeds and mock processes.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::call::Reply;
use mixdog_core_api::domain::mock::MockProcessManager;
use mixdog_core_api::error::CoreError;
use mixdog_core_api::feed::AttachMode;
use mixdog_core_api::feed::subscribe;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::SubscriptionId;
use mixdog_core_api::mock::MockConnection;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::mock::MockScopedFeeds;
use mixdog_core_api::service::DomainService;
use mixdog_core_api::sink::ConnectionSink;
use mixdog_protocol::Origin;
use mixdog_workspace::lanes::Lanes;
use mixdog_workspace::pathguard::canonical;
use mixdog_workspace::recovery::Action;
use mixdog_workspace::recovery::PreparedFile;
use mixdog_workspace::recovery::RecoveryStore;
use mixdog_store::state::CoreState;
use mixdog_workspace::service::Deps;
use mixdog_workspace::zip::TrackedFiles;
use mixdog_workspace::service::WorkspaceService;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

struct Env {
    _dir: tempfile::TempDir,
    root: PathBuf,
    service: Arc<WorkspaceService>,
    state: CoreState,
    limits: MockLimits,
}

fn env() -> Env {
    env_with(None)
}

fn env_with(turn_review: Option<Arc<dyn mixdog_core_api::turn_review::TurnReviewApi>>) -> Env {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let base = canonical(dir.path()).unwrap();
    let root = base.join("project");
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    std::fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
    std::fs::write(root.join("readme.md"), "# hi\n").unwrap();
    let limits = MockLimits::default();
    let (state, _) = CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &base.join("core.sqlite")).unwrap();
    let service = WorkspaceService::new(Deps {
        lanes: Lanes {
            interactive: tokens.interactive_io,
            durability: tokens.durability_io,
            maintenance: tokens.maintenance_io,
            cpu_bulk: tokens.cpu_bulk,
        },
        feeds: Arc::new(MockScopedFeeds::new(limits)),
        processes: Arc::new(MockProcessManager::default()),
        tracked: Arc::new(GitCli),
        state: state.clone(),
        recovery_dir: base.join("recovery"),
        user_data_dir: base.join("userData"),
        sources: vec![Arc::new(FixedSource(base.join("export.bin")))],
        code_graph: Some(Arc::new(EchoGraph)),
        turn_review,
        releases: mixdog_workspace::release::FolderReleases::new(),
    })
    .unwrap();
    // Registered as a row: `project/create` also leaves `.mixdog/project.id` in the folder, which
    // the recorded folder listings of this project do not have.
    let row = mixdog_store::state::ProjectRow { path: root.to_string_lossy().into_owned(), alias: None, hidden: false, hidden_rank: None, last_used_at: None, name: None };
    futures_block(state.write(move |tx| tx.put_project(&row))).unwrap();
    Env { _dir: dir, root, service, state, limits }
}

fn request(method: &'static str, params: Value) -> CoreRequest {
    CoreRequest { method: Method(method), params, op: None, ctx: CallContext::connection(ConnectionId(1), Origin::Relay, CancellationToken::new()) }
}

async fn call(env: &Env, method: &'static str, params: Value) -> Result<Value, CoreError> {
    match env.service.call(request(method, params)).await? {
        Reply::Value(v) => Ok(v),
        Reply::Subscribe(_) => panic!("unexpected subscribe"),
    }
}

/// A call of the desktop's own window (a local connection).
async fn call_local(env: &Env, method: &'static str, params: Value) -> Result<Value, CoreError> {
    let ctx = CallContext::connection(ConnectionId(2), Origin::Local, CancellationToken::new());
    match env.service.call(CoreRequest { method: Method(method), params, op: None, ctx }).await? {
        Reply::Value(v) => Ok(v),
        Reply::Subscribe(_) => panic!("unexpected subscribe"),
    }
}

/// Node's `Error` for a folder that is no registered project: code `PROJECT_UNAVAILABLE`, text "Project is not available." (`projectScope`
/// -> `knownPath`, session-host.ts:556; recorded for the phone in apps/mobile/fixtures/phone-files/golden.json, relay scenario
/// listProjectDir/readProjectFile on an unregistered folder).
fn unavailable<T>(result: &Result<T, CoreError>) -> bool {
    matches!(result, Err(CoreError::DomainError { code, message, .. })
        if code.as_deref() == Some("PROJECT_UNAVAILABLE") && message.as_deref() == Some("Project is not available."))
}

/// Node's plain `Error` for an entry beyond its project: no code, text "Path is outside the project." (recorded in golden.json, main
/// scenario readProjectFile `../outside/granted.txt`).
fn outside_the_project<T>(result: &Result<T, CoreError>) -> bool {
    matches!(result, Err(CoreError::DomainError { code: None, message, .. }) if message.as_deref() == Some("Path is outside the project."))
}

struct NoneGone;

#[async_trait::async_trait]
impl mixdog_workspace::grants::SessionCatalog for NoneGone {
    async fn has(&self, _: &str) -> mixdog_workspace::error::WsResult<bool> {
        Ok(true)
    }
}

/// A file is answered a window of code points at a time (one connection answer is capped), `nextChar` naming where the next starts;
/// the pieces joined are the whole text.
#[tokio::test(flavor = "multi_thread")]
async fn a_text_file_is_read_in_windows_that_join_to_the_whole() {
    let env = env();
    let text = "aé😀b".repeat(5);
    std::fs::write(env.root.join("w.txt"), &text).unwrap();
    let root = env.root.to_string_lossy().into_owned();
    let mut part = call(&env, "projectFs/readText", json!({ "root": root, "rel": "w.txt", "maxChars": 7 })).await.unwrap();
    let mut joined = part["content"].as_str().unwrap().to_owned();
    while let Some(next) = part.get("nextChar").and_then(Value::as_u64) {
        let read_id = part["readId"].clone();
        part = call(&env, "projectFs/readText", json!({ "root": root, "rel": "w.txt", "readId": read_id, "fromChar": next, "maxChars": 7 })).await.unwrap();
        joined.push_str(part["content"].as_str().unwrap());
    }
    assert_eq!(joined, text);
}

/// Node read a file once, through one authorized handle (`readProjectTextFileAuthorized`), and answered that one version. The windows of one
/// read come from the one read the first window made: a file replaced between two windows changes nothing the reader joins. Node's answer
/// is the recording (apps/mobile/fixtures/phone-files/golden.json, main scenario `readProjectFile toolong.txt`: 1 MiB + 1 byte, so the
/// phone reads it in windows); the file is made from the recorded text and mtime.
#[tokio::test(flavor = "multi_thread")]
async fn the_windows_of_one_read_are_one_version_of_a_file_replaced_between_them() {
    let golden: Value = serde_json::from_str(include_str!("../../../../../../apps/mobile/fixtures/phone-files/golden.json")).unwrap();
    let steps = golden["scenarios"]["main"]["steps"].as_array().unwrap();
    let recorded = steps.iter().find(|step| step["call"] == "readProjectFile" && step["params"][1] == "toolong.txt").unwrap()["frame"]["value"].clone();
    let text = recorded["content"].as_str().unwrap().to_owned();
    let at_ms = recorded["mtimeMs"].as_u64().unwrap();
    let env = env();
    let file = env.root.join("toolong.txt");
    let pin = |ms: u64| {
        let open = std::fs::OpenOptions::new().write(true).open(&file).unwrap();
        open.set_modified(std::time::UNIX_EPOCH + Duration::from_millis(ms)).unwrap();
    };
    std::fs::write(&file, &text).unwrap();
    pin(at_ms);
    let root = env.root.to_string_lossy().into_owned();
    let window = 60_000u64;
    let mut part = call(&env, "projectFs/readText", json!({ "root": root, "rel": "toolong.txt", "authorized": true, "maxChars": window })).await.unwrap();
    let mut joined = part["content"].as_str().unwrap().to_owned();
    // The file is replaced (other text, other time) after the first window.
    std::fs::write(&file, "c".repeat(text.len())).unwrap();
    pin(at_ms + 1_000_000);
    while let Some(next) = part.get("nextChar").and_then(Value::as_u64) {
        let read_id = part["readId"].clone();
        part = call(&env, "projectFs/readText", json!({ "root": root, "rel": "toolong.txt", "authorized": true, "readId": read_id, "fromChar": next, "maxChars": window })).await.unwrap();
        joined.push_str(part["content"].as_str().unwrap());
    }
    assert!(joined == text, "the joined windows are the first version of the file ({} of {} bytes)", joined.len(), text.len());
    // The recording holds the time as the integer JSON text `1767323045000`, the core writes the same number as a float: one JSON number
    // to the phone. Every other field is compared as it is.
    assert_eq!(part["mtimeMs"].as_f64(), recorded["mtimeMs"].as_f64(), "the time of the first read");
    for field in ["binary", "tooLarge", "readOnly", "encoding"] {
        assert_eq!(part[field], recorded[field], "{field} of the first read");
    }
    assert_eq!(part.as_object().unwrap().len(), recorded.as_object().unwrap().len(), "no field more or less than the recording's");
}

/// The paired device's side of the spec's `transfer/*` (SPEC.md R44): a path outside every project is described
/// with a one-file grant (`transfer/grant/mint`), which `transfer/beginRead` redeems for exactly that file; the
/// request is a relay connection (origin Relay), paired as "phone-1".
#[tokio::test(flavor = "multi_thread")]
async fn a_paired_device_reads_one_granted_file_outside_its_projects_and_nothing_else() {
    let env = env();
    env.service.set_phone_grants(
        Arc::new(mixdog_workspace::grants::GrantStore::new(Arc::new(mixdog_workspace::transfer::SystemClock), Arc::new(NoneGone))),
        Arc::new(|connection: ConnectionId| (connection.0 == 1).then(|| "phone-1".to_owned())),
    );
    let outside = env.root.parent().unwrap().join("granted-outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("note.txt"), "hi\n").unwrap();
    std::fs::write(outside.join("other.txt"), "secret\n").unwrap();

    // Outside every project: the row Node's `resolveLocalPaths` answers, with a grant.
    let minted = call(&env, "transfer/grant/mint", json!({ "path": outside.join("note.txt").to_string_lossy() })).await.unwrap();
    assert_eq!(minted["relPath"], "note.txt");
    assert_eq!(minted["projectPath"], outside.to_string_lossy().as_ref());
    assert_eq!((minted["name"].clone(), minted["size"].clone(), minted["dir"].clone()), (json!("note.txt"), json!(3), json!(false)));
    let token = minted["accessToken"].as_str().unwrap().to_owned();
    // Inside a registered project: the project and path, no grant.
    let inside = call(&env, "transfer/grant/mint", json!({ "path": env.root.join("a.txt").to_string_lossy() })).await.unwrap();
    assert_eq!((inside["projectPath"].clone(), inside["relPath"].clone()), (json!(env.root.to_string_lossy()), json!("a.txt")));
    assert!(inside.get("accessToken").is_none());
    // A conversation's attachment is always granted.
    let attachment = call(&env, "transfer/grant/mint", json!({ "path": env.root.join("a.txt").to_string_lossy(), "sessionId": "s1" })).await.unwrap();
    assert!(attachment["accessToken"].is_string());

    let source = |rel: &str, token: &str| json!({ "source": { "kind": "granted", "accessToken": token, "projectPath": outside.to_string_lossy(), "relPath": rel } });
    let began = call(&env, "transfer/beginRead", source("note.txt", &token)).await.unwrap();
    assert_eq!(began["size"], 3);
    let range = call(&env, "transfer/readRange", json!({ "transferId": began["transferId"], "offset": 0, "length": 3 })).await.unwrap();
    assert_eq!(range["data"], "aGkK");
    // The editor calls over the same grant answer as they do for a project file (Node's `readProjectTextFileAuthorized` and
    // `statProjectFileIn` over `remoteFileTarget`): the phone sends `(projectPath, relPath, accessToken)` as `root`, `rel`, `accessToken`.
    let text = call(&env, "projectFs/readText", json!({ "root": outside.to_string_lossy(), "rel": "note.txt", "accessToken": token })).await.unwrap();
    let project_file = call(&env, "projectFs/readText", json!({ "root": env.root.to_string_lossy(), "rel": "a.txt" })).await.unwrap();
    let keys = |value: &Value| value.as_object().unwrap().keys().cloned().collect::<std::collections::BTreeSet<_>>();
    assert_eq!(keys(&text), keys(&project_file), "the same reply shape as a project file's");
    assert_eq!((text["content"].clone(), text["binary"].clone(), text["tooLarge"].clone()), (json!("hi\n"), json!(false), json!(false)));
    let stat = call(&env, "projectFs/stat", json!({ "root": outside.to_string_lossy(), "rel": "note.txt", "accessToken": token })).await.unwrap();
    assert_eq!((stat["size"].clone(), stat["directory"].clone()), (json!(3), json!(false)));
    let wrong = call(&env, "projectFs/readText", json!({ "root": outside.to_string_lossy(), "rel": "other.txt", "accessToken": token })).await;
    assert!(format!("{wrong:?}").contains("The selected-file permission does not match this path."), "{wrong:?}");
    let missing = call(&env, "projectFs/stat", json!({ "root": outside.to_string_lossy(), "rel": "note.txt", "accessToken": "not-a-token" })).await;
    assert!(format!("{missing:?}").contains("SELECTED_FILE_GRANT_UNAVAILABLE"), "{missing:?}");
    // The grant names one exact file, and a token that was never issued opens nothing.
    let other = call(&env, "transfer/beginRead", source("other.txt", &token)).await;
    assert!(format!("{other:?}").contains("The selected-file permission does not match this path."), "{other:?}");
    let unknown = call(&env, "transfer/beginRead", source("note.txt", "not-a-token")).await;
    assert!(format!("{unknown:?}").contains("SELECTED_FILE_GRANT_UNAVAILABLE"), "{unknown:?}");
    // Without a grant a relay connection reads no absolute path.
    let plain = call(&env, "transfer/beginRead", json!({ "source": { "kind": "localFile", "path": outside.join("other.txt").to_string_lossy() } })).await;
    assert!(matches!(plain, Err(CoreError::PermissionDenied { .. })), "{plain:?}");
}

/// The phone's other file calls over a one-file permission (Node's `remoteFileTarget`): the write, the entry path, the preview with its media
/// lease, and the preview range all name the granted file alone.
#[tokio::test(flavor = "multi_thread")]
async fn a_one_file_permission_writes_names_previews_and_leases_that_file_alone() {
    let env = env();
    env.service.set_phone_grants(
        Arc::new(mixdog_workspace::grants::GrantStore::new(Arc::new(mixdog_workspace::transfer::SystemClock), Arc::new(NoneGone))),
        Arc::new(|connection: ConnectionId| (connection.0 == 1).then(|| "phone-1".to_owned())),
    );
    let outside = env.root.parent().unwrap().join("granted-calls");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("note.txt"), "hi\n").unwrap();
    std::fs::write(outside.join("pic.png"), [0x89, b'P', b'N', b'G', 1, 2, 3, 4]).unwrap();
    std::fs::write(outside.join("other.txt"), "secret\n").unwrap();
    let grant = |name: &str| call(&env, "transfer/grant/mint", json!({ "path": outside.join(name).to_string_lossy() }));
    let note = grant("note.txt").await.unwrap()["accessToken"].as_str().unwrap().to_owned();
    let pic = grant("pic.png").await.unwrap()["accessToken"].as_str().unwrap().to_owned();
    let target = |rel: &str, token: &str| json!({ "root": outside.to_string_lossy(), "rel": rel, "accessToken": token });

    let mut write = target("note.txt", &note);
    write["content"] = json!("changed\n");
    write["expectedContent"] = json!("hi\n");
    call(&env, "projectFs/writeText", write).await.unwrap();
    assert_eq!(std::fs::read_to_string(outside.join("note.txt")).unwrap(), "changed\n");
    let mut aside = target("other.txt", &note);
    aside["content"] = json!("x");
    aside["expectedContent"] = json!("secret\n");
    let refused = call(&env, "projectFs/writeText", aside).await;
    assert!(format!("{refused:?}").contains("The selected-file permission does not match this path."), "{refused:?}");
    assert_eq!(std::fs::read_to_string(outside.join("other.txt")).unwrap(), "secret\n");

    let named = call(&env, "projectFs/entryPath", target("note.txt", &note)).await.unwrap();
    assert_eq!(named["path"], outside.join("note.txt").to_string_lossy().as_ref());

    let previewed = call(&env, "projectFs/previewFile", target("pic.png", &pic)).await.unwrap();
    assert_eq!((previewed["kind"].clone(), previewed["size"].clone()), (json!("image"), json!(8)));
    let leased = env.service.file_leases().open(previewed["mediaAssetId"].as_str().unwrap()).expect("the preview leased the file");
    assert_eq!(leased.size, 8);
    let mut range = target("pic.png", &pic);
    range["offset"] = json!(4);
    range["length"] = json!(2);
    let part = call(&env, "projectFs/previewRange", range).await.unwrap();
    assert_eq!((part["data"].clone(), part["offset"].clone(), part["size"].clone()), (json!("AQI="), json!(4), json!(8)));
}

/// `FIXED_NOW_MS` of `lib/phone-files-script.mjs`: the clock the Node recording ran on, given to the backups' clock.
const PHONE_FILES_NOW_MS: &str = "1780819750000";

/// The phone's editor backups and document previews over a relay connection, replayed from the phone-files recording's relay
/// scenario (apps/mobile/fixtures/phone-files/golden.json): every backup call is sent as a phone that skips the adapter's
/// `projectFs/entryPath` step would send it, naming the file by its absolute path (the granted file's path for a call with a
/// token), and answers Node's frame whole; every document preview's file target goes through the same admission
/// (`relay_file`), refused as Node refused it before any page was rendered. The recording's folders are mapped onto this
/// world's: its project on the registered project, its outside folder on a folder beside it.
#[tokio::test(flavor = "multi_thread")]
async fn a_relay_editor_backup_or_preview_names_a_project_file_or_a_granted_one_only() {
    // SAFETY: nextest runs each test in its own process, and nothing else in this one reads the environment concurrently yet.
    unsafe { std::env::set_var("MIXDOG_FIXED_NOW_MS", PHONE_FILES_NOW_MS) };
    let golden: Value = serde_json::from_str(include_str!("../../../../../../apps/mobile/fixtures/phone-files/golden.json")).unwrap();
    let recorded_root = golden["root"].as_str().unwrap();
    let env = env();
    env.service.set_phone_grants(
        Arc::new(mixdog_workspace::grants::GrantStore::new(Arc::new(mixdog_workspace::transfer::SystemClock), Arc::new(NoneGone))),
        Arc::new(|connection: ConnectionId| (connection.0 == 1).then(|| "phone-1".to_owned())),
    );
    let outside = env.root.parent().unwrap().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("granted.txt"), "granted edit\n").unwrap();
    std::fs::write(outside.join("other.txt"), "other\n").unwrap();
    std::fs::write(env.root.join("src/a.ts"), "export const a = 1;\n").unwrap();
    let place = |path: &str| -> String {
        let (project, out) = (format!("{recorded_root}\\proj"), format!("{recorded_root}\\outside"));
        if let Some(rest) = path.strip_prefix(&project) {
            format!("{}{rest}", env.root.to_string_lossy())
        } else if let Some(rest) = path.strip_prefix(&out) {
            format!("{}{rest}", outside.to_string_lossy())
        } else {
            panic!("{path} is outside the recording's world")
        }
    };
    let mut granted = None;
    let (mut backups, mut previews) = (0, 0);
    for step in golden["scenarios"]["relay"]["steps"].as_array().unwrap() {
        // A `grant` step: the phone holds a one-file permission for this path from here on.
        if step.get("grant").is_some() {
            let path = place(step["path"].as_str().unwrap());
            call(&env, "transfer/grant/mint", json!({ "path": path })).await.unwrap();
            granted = Some(path);
            continue;
        }
        let (Some(name), params, frame) = (step["call"].as_str(), &step["params"], &step["frame"]) else { continue };
        let tokened = params[2].is_object();
        let file = || -> String {
            // The project and the entry as the phone named them, joined as given (`..` kept).
            if tokened { granted.clone().unwrap() } else { PathBuf::from(place(params[0].as_str().unwrap())).join(params[1].as_str().unwrap()).to_string_lossy().into_owned() }
        };
        let answer = match name {
            "readEditorBackup" => call(&env, "projectFs/backup/read", json!({ "sourcePath": file() })).await,
            "deleteEditorBackup" => call(&env, "projectFs/backup/delete", json!({ "sourcePath": file() })).await.map(|_| Value::Null),
            "writeEditorBackup" => call(&env, "projectFs/backup/write", json!({ "sourcePath": file(), "content": params[2], "expectedContent": params[3] })).await,
            "previewDocumentPages" => {
                let (root, rel) = if tokened {
                    let path = PathBuf::from(granted.clone().unwrap());
                    (path.parent().unwrap().to_string_lossy().into_owned(), path.file_name().unwrap().to_string_lossy().into_owned())
                } else {
                    (place(params[0].as_str().unwrap()), params[1].as_str().unwrap().to_owned())
                };
                previews += 1;
                let admitted = env.service.relay_file(&request("document/previewPages", json!({})), &root, &rel).await;
                // Node's refusals of the target; a target it took went on to the conversion (whose answer is the worker's).
                if frame["errorCode"] == "PROJECT_UNAVAILABLE" || frame["error"] == "Path is outside the project." {
                    admitted.map(|_| Value::Null)
                } else {
                    assert!(admitted.is_ok(), "{name} {params}: {admitted:?}");
                    continue;
                }
            }
            _ => continue,
        };
        if name != "previewDocumentPages" {
            backups += 1;
        }
        let got = match answer {
            Ok(value) => json!({ "ok": true, "value": value }),
            Err(CoreError::DomainError { code, message, .. }) => {
                let mut node = json!({ "ok": false, "error": message.as_deref() });
                if let Some(code) = code.as_deref() {
                    node["errorCode"] = json!(code);
                }
                node
            }
            Err(other) => panic!("{name} {params}: {other:?}"),
        };
        assert_eq!(&got, frame, "{name} {params}");
    }
    assert_eq!((backups, previews), (14, 3));
    // Nothing was planted for a refused file.
    let names: Vec<_> = std::fs::read_dir(env.root.parent().unwrap().join("userData").join("editor-backups")).map(|dir| dir.count()).into_iter().collect();
    assert!(names.iter().all(|count| *count == 0), "{names:?}");
}

/// A folder whose name only trims to a registered project's is not that project (Node trims the phone's `projectPath` and then
/// acts on the registry's own root). A relay backup named in such a folder is kept under the project's file, which is what the
/// admission checked, and never reaches the backup the desktop keeps for the other folder's file.
#[tokio::test(flavor = "multi_thread")]
async fn a_relay_backup_is_kept_under_the_file_that_was_admitted() {
    let env = env();
    let twin = PathBuf::from(format!("{}\u{a0}", env.root.to_string_lossy()));
    std::fs::create_dir_all(&twin).unwrap();
    let source = twin.join("secret.txt").to_string_lossy().into_owned();
    call_local(&env, "projectFs/backup/write", json!({ "sourcePath": source, "content": "private", "expectedContent": "" })).await.unwrap();
    let kept = call_local(&env, "projectFs/backup/read", json!({ "sourcePath": source })).await.unwrap();
    assert_ne!(kept, Value::Null, "the desktop's backup of the other folder's file");

    assert_eq!(call(&env, "projectFs/backup/read", json!({ "sourcePath": source })).await.unwrap(), Value::Null, "the phone reads the project's file's backup: none");
    call(&env, "projectFs/backup/delete", json!({ "sourcePath": source })).await.unwrap();
    assert_eq!(call_local(&env, "projectFs/backup/read", json!({ "sourcePath": source })).await.unwrap(), kept, "the phone's delete did not reach it");
}

/// With no desktop window to render or trash, the calls that need one answer the missing capability (the adapter words it as Node's
/// "The desktop app is unavailable on this connection.").
#[tokio::test(flavor = "multi_thread")]
async fn host_only_file_calls_answer_the_missing_desktop_capability_without_a_window() {
    let env = env();
    for (method, extra) in [("projectFs/captureSnapshot", json!({})), ("projectFs/localPageUrl", json!({})), ("projectFs/trash", json!({ "viaHost": true }))] {
        let mut params = json!({ "root": env.root.to_string_lossy(), "rel": "a.txt" });
        params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        let answered = call(&env, method, params).await;
        assert!(matches!(&answered, Err(CoreError::CapabilityUnavailable { capability, .. }) if &**capability == "desktopHost"), "{method}: {answered:?}");
    }
    assert!(env.root.join("a.txt").exists(), "nothing was trashed");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_local_connection_reads_any_absolute_folder_while_a_relay_is_held_to_the_projects() {
    let env = env();
    let outside = env.root.parent().unwrap().join("unregistered");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("note.txt"), "hello\n").unwrap();
    let params = json!({ "root": outside.to_string_lossy(), "rel": "note.txt" });
    // The `…In` operations of Node take any root the window resolved; the relay is the strict origin.
    assert!(unavailable(&call(&env, "projectFs/readText", params.clone()).await));
    let mut local = request("projectFs/readText", params.clone());
    local.ctx = CallContext::connection(ConnectionId(1), Origin::Local, CancellationToken::new());
    let Reply::Value(read) = env.service.call(local).await.unwrap() else { panic!("readText answers with a value") };
    assert_eq!(read["content"], "hello\n");
    let mut stat = request("projectFs/stat", params);
    stat.ctx = CallContext::connection(ConnectionId(1), Origin::Local, CancellationToken::new());
    let Reply::Value(stat) = env.service.call(stat).await.unwrap() else { panic!("stat answers with a value") };
    assert_eq!(stat["directory"], false);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_staged_upload_is_named_uniquely_and_a_path_range_needs_no_transfer() {
    let env = env();
    let mut published = Vec::new();
    for _ in 0..2 {
        let began = call(&env, "transfer/beginWrite", json!({ "name": "dir\\b.txt", "size": 2, "scope": "draft1" })).await.unwrap();
        assert_eq!(began["uploadId"], began["transferId"]);
        assert_eq!(began["chunkBytes"], 2 * 1024 * 1024);
        let id = began["transferId"].as_str().unwrap().to_owned();
        call(&env, "transfer/writeChunk", json!({ "transferId": id, "offset": 0, "bytesB64": "aGk=" })).await.unwrap();
        let done = call(&env, "transfer/commit", json!({ "transferId": id })).await.unwrap();
        assert_eq!(std::fs::read(done["absolutePath"].as_str().unwrap()).unwrap(), b"hi");
        published.push(done["name"].as_str().unwrap().to_owned());
    }
    assert_eq!(published, ["b.txt", "b (2).txt"]);
    let bad = call(&env, "transfer/beginWrite", json!({ "name": "x", "size": 2, "scope": "../up" })).await;
    assert!(matches!(bad, Err(CoreError::InvalidParams { .. })));

    let root = env.root.to_string_lossy().into_owned();
    let range = call(&env, "transfer/readRange", json!({ "root": root, "rel": "a.txt", "offset": 0, "length": 3 })).await.unwrap();
    assert_eq!(range["data"], "b25l");
    assert_eq!(range["offset"], 0);
    assert!(range["size"].as_u64().unwrap() >= 3 && range["mtimeMs"].is_number());
}

#[tokio::test(flavor = "multi_thread")]
async fn stat_local_reports_a_failure_per_path() {
    let env = env();
    let present = env.root.join("a.txt");
    let missing = env.root.join("missing.txt");
    let listed = call(&env, "projectFs/statLocal", json!({ "paths": [present.to_string_lossy(), missing.to_string_lossy()] }))
        .await
        .unwrap();
    assert_eq!(listed[0]["name"], "a.txt");
    assert!(listed[1]["error"].is_string(), "a path that cannot be read carries its own error: {listed}");
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_writes_with_one_expected_content_have_one_winner() {
    let env = env();
    let root = env.root.to_string_lossy().into_owned();
    let write = |content: &'static str| {
        let params = json!({ "root": root, "rel": "a.txt", "content": content, "expectedContent": "one\n" });
        call(&env, "projectFs/writeText", params)
    };
    let (a, b) = tokio::join!(write("from a\n"), write("from b\n"));
    let results = [a, b];
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    let failed = results.iter().find_map(|r| r.as_ref().err()).unwrap();
    assert!(matches!(failed, CoreError::PreconditionFailed { .. }), "{failed:?}");
}

fn with_op(method: &'static str, params: Value, op: &str) -> CoreRequest {
    CoreRequest { op: Some(mixdog_core_api::ids::OpId::from(op)), ..request(method, params) }
}

#[tokio::test(flavor = "multi_thread")]
async fn every_mutation_records_its_op_and_a_repeat_answers_from_the_record() {
    let env = env();
    let root = env.root.to_string_lossy().into_owned();
    let params = json!({ "root": root, "rel": "a.txt", "content": "two\n", "expectedContent": "one\n" });
    let op = "0190a000-0000-7000-8000-000000000001";
    let first = env.service.call(with_op("projectFs/writeText", params.clone(), op)).await.unwrap();
    let Reply::Value(first) = first else { panic!() };
    let row = env.state.op("projectFs", op).await.unwrap().expect("op row");
    assert_eq!(row.state, mixdog_store::state::OpRowState::Applied);
    assert_eq!(row.method, "projectFs/writeText");
    // The same op id and payload again: answered from the record, nothing re-executed.
    std::fs::write(env.root.join("a.txt"), "changed elsewhere\n").unwrap();
    let again = env.service.call(with_op("projectFs/writeText", params.clone(), op)).await.unwrap();
    let Reply::Value(again) = again else { panic!() };
    assert_eq!(again, first);
    assert_eq!(std::fs::read_to_string(env.root.join("a.txt")).unwrap(), "changed elsewhere\n");
    // The same id with another payload conflicts.
    let other = json!({ "root": root, "rel": "a.txt", "content": "x", "expectedContent": "changed elsewhere\n" });
    let err = env.service.call(with_op("projectFs/writeText", other, op)).await.unwrap_err();
    assert!(matches!(err, CoreError::OpIdConflict { .. }), "{err:?}");
    // A refused mutation is recorded rejected.
    let refused = json!({ "root": root, "rel": "a.txt", "content": "x", "expectedContent": "stale" });
    let op2 = "0190a000-0000-7000-8000-000000000002";
    assert!(env.service.call(with_op("projectFs/writeText", refused, op2)).await.is_err());
    assert_eq!(env.state.op("projectFs", op2).await.unwrap().unwrap().state, mixdog_store::state::OpRowState::Rejected);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_registry_change_and_its_op_row_commit_in_one_transaction() {
    let env = env();
    let other = env.root.parent().unwrap().join("second");
    std::fs::create_dir_all(&other).unwrap();
    let op = "0190a000-0000-7000-8000-000000000003";
    env.service.call(with_op("project/create", json!({ "path": other.to_string_lossy() }), op)).await.unwrap();
    assert_eq!(env.state.op("project", op).await.unwrap().unwrap().state, mixdog_store::state::OpRowState::Applied);
    assert_eq!(env.state.projects().await.unwrap().len(), 2);
}

/// Node's `addProject` / `touchProjectSelected` leave `<project>/.mixdog/project.id` (memory
/// classification reads only that); the `markers` of the recorded registry cases, replayed through
/// `project/create` and, for a project registered without one, `project/touch`.
#[tokio::test(flavor = "multi_thread")]
async fn project_create_and_touch_leave_the_project_id_marker_node_leaves() {
    let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/store/registry/projects-registry.json")).unwrap();
    let env = env();
    let base = env.root.parent().unwrap().join("markers");
    let mut checked = 0;
    for case in golden["cases"].as_array().unwrap() {
        let expected = case["markers"].as_object().unwrap();
        if expected.is_empty() {
            continue;
        }
        let name = case["name"].as_str().unwrap();
        for phase in ["create", "touch"] {
            let root = base.join(phase).join(name);
            for sub in case["dirs"].as_array().unwrap() {
                std::fs::create_dir_all(root.join(sub.as_str().unwrap())).unwrap();
            }
            let root_text = root.to_string_lossy().into_owned();
            for op in case["ops"].as_array().unwrap().iter().filter(|op| op["op"] == "add") {
                let raw = op["path"].as_str().unwrap().replace("<ABS>", &root_text);
                if raw.is_empty() {
                    continue;
                }
                let path = if std::path::Path::new(&raw).is_absolute() { raw } else { root.join(raw).to_string_lossy().into_owned() };
                if phase == "create" {
                    call(&env, "project/create", json!({ "path": path })).await.unwrap();
                } else {
                    let real = canonical(std::path::Path::new(&path)).unwrap().to_string_lossy().into_owned();
                    env.state
                        .write(move |tx| {
                            tx.put_project(&mixdog_store::state::ProjectRow {
                                path: real,
                                alias: None,
                                hidden: false,
                                hidden_rank: None,
                                last_used_at: None,
                                name: None,
                            })
                        })
                        .await
                        .unwrap();
                    call(&env, "project/touch", json!({ "path": path })).await.unwrap();
                }
            }
            for (sub, text) in expected {
                let marker = std::fs::read_to_string(root.join(sub).join(".mixdog").join("project.id")).unwrap_or_default();
                assert_eq!(marker, text.as_str().unwrap(), "{name} ({phase}): marker of {sub}");
                checked += 1;
            }
        }
    }
    assert_eq!(checked, 6, "three recorded markers, each through create and touch");
}

#[tokio::test(flavor = "multi_thread")]
async fn paths_outside_the_registry_or_project_are_refused_with_permission_denied() {
    let env = env();
    let outside = env.root.parent().unwrap().join("other");
    std::fs::create_dir_all(&outside).unwrap();
    assert!(unavailable(&call(&env, "projectFs/listDir", json!({ "root": outside.to_string_lossy(), "rel": "." })).await));
    let root = env.root.to_string_lossy().into_owned();
    // The phone asks for Node's answer; a local or SSH caller keeps the permission refusal for the same path.
    assert!(outside_the_project(&call(&env, "projectFs/readText", json!({ "root": root, "rel": "../other/x", "nodeErrors": true })).await));
    let local = call(&env, "projectFs/readText", json!({ "root": root, "rel": "../other/x" })).await;
    assert!(matches!(local, Err(CoreError::PermissionDenied { .. })), "{local:?}");
    let ok = call(&env, "projectFs/listDir", json!({ "root": root, "rel": "." })).await.unwrap();
    assert_eq!(ok[0]["name"], "src");
}

#[tokio::test(flavor = "multi_thread")]
async fn interrupted_batch_is_listed_inspected_and_restored_to_the_pre_image() {
    let env = env();
    let base = env.root.parent().unwrap().join("crash-store");
    let store = RecoveryStore::new(base.clone());
    let file = env.root.join("a.txt");
    let journal = store
        .begin(
            &env.root,
            vec![PreparedFile {
                rel_path: "a.txt".into(),
                destination: canonical(&file).unwrap(),
                parent: mixdog_workspace::recovery::identity_of(&env.root).unwrap(),
                mode: 0,
                before: b"one\n".to_vec(),
                after: b"two\n".to_vec(),
            }],
        )
        .unwrap();
    std::fs::write(&file, "two\n").unwrap(); // the write that was in flight when the core died
    store.release(&journal.directory).unwrap();
    drop(store);

    let restarted = RecoveryStore::new(base);
    let listed = restarted.list(&env.root).unwrap();
    assert_eq!(serde_json::to_value(&listed[0]).unwrap()["phase"], "interrupted");
    let detail = restarted.execute(&env.root, Action::Inspect { id: listed[0].id.clone() }).unwrap().detail.unwrap();
    assert_eq!(serde_json::to_value(&detail.files[0]).unwrap()["status"], "written");
    restarted.execute(&env.root, Action::Restore { id: listed[0].id.clone(), revision: detail.revision }).unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "one\n");
}

/// An unwatch whose request was cancelled before it ran still ends the OS watch: its record never goes without it.
#[tokio::test(flavor = "multi_thread")]
async fn a_cancelled_unwatch_still_ends_the_os_watch() {
    let env = env();
    env.service
        .call(request("fs/watch", json!({ "watchId": "w", "path": env.root.to_string_lossy(), "recursive": false })))
        .await
        .unwrap();
    assert_eq!(env.service.open_os_watches(), 1);
    let unwatch = request("fs/unwatch", json!({ "watchId": "w" }));
    unwatch.ctx.cancel.cancel();
    let _ = env.service.call(unwatch).await;
    assert_eq!(env.service.open_os_watches(), 0, "the record went and the OS watch with it");
}

/// Node's `folderWatch` took any absolute path (`absoluteLocalPath`, then `fs.watch`): a folder outside every project is watched, and a
/// missing one fails with the text `fs.watch` gives.
#[tokio::test(flavor = "multi_thread")]
async fn watch_takes_any_absolute_folder_and_a_missing_one_fails_like_fs_watch() {
    let env = env();
    let outside = std::env::temp_dir().join(format!("mixdog-watch-outside-{}", std::process::id()));
    std::fs::create_dir_all(&outside).unwrap();
    let reply = env
        .service
        .call(request("fs/watch", json!({ "watchId": "out", "path": outside.to_string_lossy(), "recursive": false })))
        .await
        .unwrap();
    assert!(matches!(reply, Reply::Subscribe(_)), "a folder outside the project is watched");
    std::fs::remove_dir_all(&outside).unwrap();

    let missing = std::env::temp_dir().join(format!("mixdog-watch-missing-{}", std::process::id()));
    let error = env
        .service
        .call(request("fs/watch", json!({ "watchId": "gone", "path": missing.to_string_lossy(), "recursive": false })))
        .await
        .err()
        .expect("a missing folder cannot be watched");
    let CoreError::DomainError { message: Some(message), .. } = &error else { panic!("a domain error, got {error:?}") };
    assert_eq!(&**message, format!("ENOENT: no such file or directory, watch '{}'", missing.display()));
}

/// Node's `folderWatch` runs `absoluteLocalPath` first and a relative path never reaches `fs.watch` (recorded:
/// apps/mobile/fixtures/phone-terminal/golden.json, `folderWatch` of `relative/dir` -> `path must be absolute.`). A relative path that
/// exists from the core's directory must be refused the same, not resolved and watched.
#[tokio::test(flavor = "multi_thread")]
async fn watch_refuses_a_relative_path_even_when_it_exists_from_the_working_directory() {
    let env = env();
    for relative in [".", "..", "src", "./src"] {
        let error = env
            .service
            .call(request("fs/watch", json!({ "watchId": "rel", "path": relative, "recursive": false })))
            .await
            .err()
            .unwrap_or_else(|| panic!("{relative:?} is relative and must not be watched"));
        assert!(format!("{error:?}").contains("path must be absolute."), "{relative:?}: {error:?}");
    }
    assert_eq!(env.service.open_os_watches(), 0);
}

/// Every input Node's `absoluteLocalPath` refused (apps/mobile/fixtures/absolute-local-path/golden.json, the recording with the working
/// directory on this process's drive) is refused by `fs/watch` with Node's message, and nothing is watched; a non-string `path` included.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn watch_refuses_every_input_node_refuses_with_nodes_message() {
    let golden: Value = serde_json::from_str(include_str!("../../../../../../apps/mobile/fixtures/absolute-local-path/golden.json")).unwrap();
    let drive = std::env::current_dir().unwrap().to_string_lossy().chars().next().unwrap().to_ascii_uppercase().to_string();
    let recorded = golden["drives"].get(&drive).unwrap_or_else(|| panic!("absolute-local-path has no recording with the working directory on drive {drive}"));
    let env = env();
    let mut refused = 0;
    for (input, answer) in golden["inputs"].as_array().unwrap().iter().zip(recorded.as_array().unwrap()) {
        let Some(message) = answer["error"]["message"].as_str() else { continue };
        let mut params = json!({ "watchId": "refused", "recursive": false });
        if input.get("absent").is_none() {
            params["path"] = input["value"].clone();
        }
        let error = env.service.call(request("fs/watch", params)).await.err().unwrap_or_else(|| panic!("{}: Node refused it and it was watched", input["name"]));
        assert!(format!("{error:?}").contains(message), "{}: Node says {message:?}, got {error:?}", input["name"]);
        refused += 1;
    }
    assert!(refused > 0);
    assert_eq!(env.service.open_os_watches(), 0);
}

/// Every class of project path answered as Node answers it (apps/mobile/fixtures/project-path-classes/golden.json, recorded by
/// record-project-path-classes.mjs from the real registry, the real store and `addProject`): the registry's lookup (`project/read`, and
/// `transfer/trash/info`, which Node hands `projectDirectory`), the folder `project/ensureDirectory` makes and the path `project/create`
/// registers. The working directory is the project's parent, as in the recording; the test needs a process of its own (nextest runs one).
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn project_paths_are_read_as_nodes_registry_reads_them() {
    let golden: Value = serde_json::from_str(include_str!("../../../../../../apps/mobile/fixtures/project-path-classes/golden.json")).unwrap();
    let env = env();
    let tmp = env.root.parent().unwrap().to_path_buf();
    let proj = tmp.join("proj");
    std::fs::create_dir(&proj).unwrap();
    let row = mixdog_store::state::ProjectRow { path: proj.to_string_lossy().into_owned(), alias: None, hidden: false, hidden_rank: None, last_used_at: None, name: None };
    env.state.write(move |tx| tx.put_project(&row)).await.unwrap();
    std::env::set_current_dir(&tmp).unwrap();

    let text = |path: &std::path::Path| path.to_string_lossy().into_owned();
    let (proj_text, tmp_text) = (text(&proj), text(&tmp));
    let rooted = tmp_text[2..].to_owned();
    let fill: Vec<(&str, String)> = vec![
        ("{proj}", proj_text.clone()),
        ("{tmp}", tmp_text.clone()),
        ("{PROJ}", proj_text.to_uppercase()),
        ("{TMP}", tmp_text.to_uppercase()),
        ("{projSlash}", proj_text.replace('\\', "/")),
        ("{projUpper}", proj_text.to_uppercase()),
        ("{tmpName}", tmp.file_name().unwrap().to_string_lossy().into_owned()),
        ("{drive}", tmp_text[..2].to_owned()),
        ("{tmpRooted}", rooted.clone()),
        ("{tmpRootedSlash}", rooted.replace('\\', "/")),
    ];
    let expand = |template: &str| fill.iter().fold(template.to_owned(), |text, (token, value)| text.replace(token, value));

    let inputs = golden["inputs"].as_array().unwrap();
    let mut replayed = 0;
    // In the recording's order: `inspect` before `ensure`, which makes the folders later inputs name. `known` is the registry's lookup behind
    // `project/directory` (the registered folder is its own real path here).
    for (operation, method) in [("known", "project/directory"), ("inspect", "project/read"), ("trash", "transfer/trash/info"), ("ensure", "project/ensureDirectory"), ("add", "project/create")] {
        // Node's lookup answers the trash call too: its `projectDirectory` is the registry's lookup, then a folder.
        let recorded = golden["answers"][if operation == "trash" { "known" } else { operation }].as_array().unwrap();
        for (input, answer) in inputs.iter().zip(recorded) {
            let given = expand(input["template"].as_str().unwrap());
            let got = call(&env, method, json!({ "path": given })).await;
            let name = format!("{operation} {}: {given:?}", input["name"]);
            match answer.get("result") {
                Some(want) => {
                    let got = got.unwrap_or_else(|error| panic!("{name}: Node answered {want}, got {error:?}"));
                    if operation == "trash" {
                        assert!(got.get("available").is_some(), "{name}: {got}");
                    } else if operation == "inspect" {
                        let mut want: Value = serde_json::from_str(want.as_str().unwrap()).unwrap();
                        want["path"] = json!(expand(want["path"].as_str().unwrap()));
                        assert_eq!(got, want, "{name}");
                    } else {
                        let path = if operation == "add" { &got["project"]["path"] } else { &got["path"] };
                        assert_eq!(path.as_str().unwrap(), expand(want.as_str().unwrap()), "{name}");
                    }
                }
                None => {
                    let message = answer["error"]["message"].as_str().unwrap();
                    let error = got.err().unwrap_or_else(|| panic!("{name}: Node refused it with {message:?}"));
                    // Node's own wording where the answer is Node's (the registry and the catalog); an operating-system error of a path Node
                    // never reached (`ENOENT ... realpath`, a NUL) is a refusal here as well.
                    if answer["error"].get("code").and_then(Value::as_str) == Some("PROJECT_UNAVAILABLE") {
                        assert!(unavailable::<Value>(&Err(error)), "{name}");
                    } else if !message.starts_with("ENOENT") && !message.starts_with("The argument 'path'") {
                        assert!(format!("{error:?}").contains(message), "{name}: Node says {message:?}, got {error:?}");
                    }
                }
            }
            replayed += 1;
        }
    }
    assert_eq!(replayed, inputs.len() * 5);
}

#[tokio::test(flavor = "multi_thread")]
async fn watch_pushes_batched_changes_and_connection_close_drops_the_os_watch() {
    let env = env();
    // No event can reach the watcher before the watch exists, so every flush is at least a window after this instant.
    let began = std::time::Instant::now();
    let reply = env
        .service
        .call(request("fs/watch", json!({ "watchId": "w1", "path": env.root.to_string_lossy(), "recursive": true })))
        .await
        .unwrap();
    let Reply::Subscribe(sub) = reply else { panic!("fs/watch must subscribe") };
    let conn = MockConnection::new(ConnectionId(1), env.limits);
    let attached = subscribe(&sub.feed, SubscriptionId::from("s1"), sub.window, None, &conn).unwrap();
    assert_eq!(attached.decision.mode, AttachMode::Snapshot);
    conn.send_control_release(bytes::Bytes::from_static(b"ok"), attached.release).unwrap();
    assert_eq!(env.service.open_os_watches(), 1);
    for i in 0..300 {
        std::fs::write(env.root.join(format!("t{i}.txt")), "x").unwrap();
    }
    // Until every path has been announced; the batches are counted below.
    let covered = |texts: &[String]| {
        let all = texts.iter().filter(|f| f.contains("fs/changed")).cloned().collect::<Vec<_>>().join("");
        (0..300).all(|i| all.contains(&format!("t{i}.txt")))
    };
    let frames: Vec<String> = conn.drain_text_until(covered).await.into_iter().filter(|f| f.contains("fs/changed")).collect();
    // A batch is flushed one window after the first event it holds and the next batch starts after that flush, so n
    // notifications need n windows. The count is bounded by how long the burst took, whatever the disk's speed; a watcher that
    // announced each event on its own would send hundreds in the same time.
    let windows = began.elapsed().as_millis() / u128::from(mixdog_workspace::watch::BATCH_WINDOW_MS);
    assert!(!frames.is_empty() && frames.len() as u128 <= windows, "{} notifications in {windows} windows", frames.len());
    let all = frames.join("");
    assert!((0..300).all(|i| all.contains(&format!("t{i}.txt"))), "every path is covered");
    env.service.connection_closed(&ConnectionId(1));
    assert_eq!(env.service.open_os_watches(), 0);
}

/// A folder of the recording's shape (apps/mobile/fixtures/folder-watch/golden.json): `actual`, a junction `alias` to it, a folder Everyone
/// is denied listing, a file. The deny is undone and the folder removed when it goes, whatever the test did.
#[cfg(windows)]
struct WatchFolder(PathBuf);

#[cfg(windows)]
impl WatchFolder {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("mixdog-folder-watch-{}", std::process::id()));
        std::fs::create_dir_all(root.join("actual")).unwrap();
        std::fs::create_dir(root.join("locked")).unwrap();
        std::fs::write(root.join("afile.txt"), "a").unwrap();
        let folder = Self(root);
        folder.run("cmd", &["/c", "mklink", "/J", &folder.at("alias"), &folder.at("actual")]);
        folder.run("icacls", &[&folder.at("locked"), "/deny", "*S-1-1-0:(RD)"]);
        folder
    }

    fn at(&self, name: &str) -> String {
        self.0.join(name).to_string_lossy().into_owned()
    }

    fn fill(&self, template: &str) -> String {
        template.replace("{root}", &self.0.to_string_lossy())
    }

    fn run(&self, program: &str, args: &[&str]) {
        let status = std::process::Command::new(program).args(args).stdout(std::process::Stdio::null()).status().unwrap();
        assert!(status.success(), "{program} {args:?}: {status}");
    }
}

#[cfg(windows)]
impl Drop for WatchFolder {
    fn drop(&mut self) {
        let _ = std::process::Command::new("icacls").args([&self.at("locked"), "/remove:d", "*S-1-1-0"]).stdout(std::process::Stdio::null()).status();
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Node keys a folder watch by the path as resolved (lower-cased on Windows) and watches that path, so a folder and a junction to it are
/// two watches, each reporting under its own name; a path `fs.watch` refuses fails with `fs.watch`'s own code and text, and a file is
/// watched (apps/mobile/fixtures/folder-watch/golden.json, recorded with the real registry and `fs.watch`). The core's watches are the
/// same: one OS watch per name, every changed path under the name the watch was asked for, and the recorded failures.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn watches_are_keyed_and_reported_by_the_resolved_name_and_fail_as_fs_watch() {
    let golden: Value = serde_json::from_str(include_str!("../../../../../../apps/mobile/fixtures/folder-watch/golden.json")).unwrap();
    let env = env();
    let folder = WatchFolder::new();
    let conn = MockConnection::new(ConnectionId(1), env.limits);
    let watch = |id: &'static str, path: String, recursive: bool| {
        let service = Arc::clone(&env.service);
        let conn = &conn;
        async move {
            let reply = service.call(request("fs/watch", json!({ "watchId": id, "path": path, "recursive": recursive }))).await?;
            let Reply::Subscribe(sub) = reply else { panic!("fs/watch must subscribe") };
            let attached = subscribe(&sub.feed, SubscriptionId::from(id), sub.window, None, conn).unwrap();
            conn.send_control_release(bytes::Bytes::from_static(b"ok"), attached.release).unwrap();
            Ok::<(), CoreError>(())
        }
    };
    let changed = |frames: &[String], id: &str| -> Vec<String> {
        frames
            .iter()
            .filter_map(|frame| serde_json::from_str::<Value>(frame.split_once(':').map_or("", |(_, text)| text)).ok())
            .filter(|frame| frame["method"] == "fs/changed" && frame["params"]["watchId"] == id)
            .flat_map(|frame| frame["params"]["changedPaths"].as_array().unwrap().iter().map(|p| p.as_str().unwrap().to_owned()).collect::<Vec<_>>())
            .collect()
    };

    // Two names of one folder: Node gave fs.watch each name, and reported each change under each name.
    let two = &golden["twoNames"];
    let paths: Vec<String> = two["fsWatchPaths"].as_array().unwrap().iter().map(|p| folder.fill(p.as_str().unwrap())).collect();
    let ids = ["name-1", "name-2"];
    for (id, path) in ids.iter().zip(&paths) {
        watch(id, path.clone(), true).await.unwrap();
    }
    assert_eq!(env.service.open_os_watches(), paths.len(), "one OS watch per name, as Node's {} fs.watch calls", paths.len());
    std::fs::write(folder.0.join("actual").join("changed.txt"), "1").unwrap();
    let frames = tokio::time::timeout(Duration::from_secs(60), conn.drain_text_until(|texts| ids.iter().all(|id| !changed(texts, id).is_empty()))).await.expect("a change under each name within 60 s");
    for (id, reported) in ids.iter().zip(two["reportedUnder"].as_array().unwrap()) {
        let dir = folder.fill(reported["dir"].as_str().unwrap());
        let paths = changed(&frames, id);
        assert!(paths.iter().all(|path| path.starts_with(&format!("{dir}\\"))), "{id}: every change is reported under {dir}: {paths:?}");
    }
    env.service.connection_closed(&ConnectionId(1));
    assert_eq!(env.service.open_os_watches(), 0);

    // The failures: fs.watch's own code and text, and a file that is watched.
    let conn = MockConnection::new(ConnectionId(1), env.limits);
    let watch = |id: &'static str, path: String| {
        let service = Arc::clone(&env.service);
        let conn = &conn;
        async move {
            let reply = service.call(request("fs/watch", json!({ "watchId": id, "path": path, "recursive": false }))).await?;
            let Reply::Subscribe(sub) = reply else { panic!("fs/watch must subscribe") };
            let attached = subscribe(&sub.feed, SubscriptionId::from(id), sub.window, None, conn).unwrap();
            conn.send_control_release(bytes::Bytes::from_static(b"ok"), attached.release).unwrap();
            Ok::<(), CoreError>(())
        }
    };
    let failures = golden["failures"].as_array().unwrap();
    let ids = ["fail-1", "fail-2", "fail-3"];
    for (id, case) in ids.iter().zip(failures) {
        let path = folder.fill(case["path"].as_str().unwrap());
        let got = watch(id, path.clone()).await;
        match case["answer"].get("error") {
            Some(error) => {
                let Err(CoreError::DomainError { code, message, .. }) = got else { panic!("{}: Node failed with {error}, got {got:?}", case["name"]) };
                assert_eq!(message.as_deref(), Some(folder.fill(error["message"].as_str().unwrap()).as_str()), "{}", case["name"]);
                assert_eq!(code.as_deref(), error["code"].as_str(), "{}", case["name"]);
            }
            None => {
                got.unwrap_or_else(|error| panic!("{}: Node watched it, got {error:?}", case["name"]));
                std::fs::write(&path, "b").unwrap();
                let frames = tokio::time::timeout(Duration::from_secs(60), conn.drain_text_until(|texts| !changed(texts, id).is_empty())).await.expect("the watched file's change within 60 s");
                let under = folder.fill(case["reportedUnder"].as_str().unwrap());
                assert!(changed(&frames, id).iter().all(|p| *p == under), "{}: reported under {under}: {:?}", case["name"], changed(&frames, id));
            }
        }
    }
    env.service.connection_closed(&ConnectionId(1));
}

#[tokio::test(flavor = "multi_thread")]
async fn search_session_ends_with_the_last_query_and_stop_frees_the_index() {
    let env = env();
    let reply = env
        .service
        .call(request("search/start", json!({ "sessionId": "q1", "roots": [env.root.to_string_lossy()] })))
        .await
        .unwrap();
    let Reply::Subscribe(sub) = reply else { panic!("search/start must subscribe") };
    let conn = MockConnection::new(ConnectionId(1), env.limits);
    let attached = subscribe(&sub.feed, SubscriptionId::from("s1"), sub.window, None, &conn).unwrap();
    conn.send_control_release(bytes::Bytes::from_static(b"ok"), attached.release).unwrap();
    for i in 0..29 {
        call(&env, "search/update", json!({ "sessionId": "q1", "query": format!("zz{i}") })).await.unwrap();
    }
    call(&env, "search/update", json!({ "sessionId": "q1", "query": "main" })).await.unwrap();
    // Until the result of the last query has been pushed.
    let answered = |texts: &[String]| texts.iter().any(|f| f.contains("search/updated") && f.contains("\"query\":\"main\"") && f.contains("src/main.rs"));
    let updates: Vec<String> = conn.drain_text_until(answered).await.into_iter().filter(|f| f.contains("search/updated")).collect();
    let last = updates.last().expect("a result frame");
    assert!(last.contains("\"query\":\"main\"") && last.contains("src/main.rs"), "{last}");
    assert!(updates.iter().all(|u| u.contains("\"query\":\"main\"") || !u.contains("main.rs")));
    call(&env, "search/stop", json!({ "sessionId": "q1" })).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn workspace_text_search_and_replace_round_trip_through_the_service() {
    let env = env();
    let root = env.root.to_string_lossy().into_owned();
    let found = call(&env, "projectFs/searchText", json!({ "root": root, "options": { "query": "one" } })).await.unwrap();
    assert_eq!(found["matchCount"], 1);
    let replaced =
        call(&env, "projectFs/replaceText", json!({ "root": root, "options": { "query": "one", "matchCase": true }, "replacement": "1" }))
            .await
            .unwrap();
    assert_eq!(replaced["filesChanged"], 1);
    assert_eq!(std::fs::read_to_string(env.root.join("a.txt")).unwrap(), "1\n");
}

/// `git ls-files` through the git CLI: the test stand-in for WP-SCM's gix implementation.
pub struct GitCli;

fn git_lines(root: &std::path::Path, args: &[&str]) -> Option<Vec<String>> {
    let out = std::process::Command::new("git").args(args).current_dir(root).output().ok()?;
    out.status.success().then(|| out.stdout.split(|b| *b == 0).filter(|r| !r.is_empty()).map(|r| String::from_utf8_lossy(r).into_owned()).collect())
}

#[async_trait::async_trait]
impl TrackedFiles for GitCli {
    async fn files(&self, root: &std::path::Path, _: &CancellationToken) -> Option<Vec<String>> {
        git_lines(root, &["ls-files", "-z", "-c", "-o", "--exclude-standard"])
    }
    async fn ignored(&self, root: &std::path::Path, _: &CancellationToken) -> Option<u64> {
        git_lines(root, &["ls-files", "-z", "-o", "-i", "--exclude-standard"]).map(|l| l.len() as u64)
    }
}

/// A source domain's `TransferSource`: serves one staged file as kind `export`.
struct FixedSource(PathBuf);

#[async_trait::async_trait]
impl mixdog_workspace::transfer::TransferSource for FixedSource {
    fn kind(&self) -> &'static str {
        "export"
    }
    async fn open(&self, _: &Value, _: &CancellationToken) -> Result<mixdog_workspace::transfer::SourceFile, mixdog_workspace::error::WsError> {
        std::fs::write(&self.0, b"exported").unwrap();
        Ok(mixdog_workspace::transfer::SourceFile { file: std::fs::File::open(&self.0).unwrap(), name: "session.md".into(), mime_type: "text/markdown".into(), cleanup: None })
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_source_domains_file_is_read_through_the_transfer_methods() {
    let env = env();
    let began = call(&env, "transfer/beginRead", json!({ "source": { "kind": "export", "id": "s1" } })).await.unwrap();
    assert_eq!((began["size"].clone(), began["entry"]["name"].clone(), began["mimeType"].clone()), (json!(8), json!("session.md"), json!("text/markdown")));
    let range = call(&env, "transfer/readRange", json!({ "transferId": began["transferId"], "offset": 0, "length": 8 })).await.unwrap();
    assert_eq!(range["eof"], true);
    // A kind nobody serves stays unsupported.
    let missing = call(&env, "transfer/beginRead", json!({ "source": { "kind": "mediaAsset", "id": "m" } })).await;
    assert!(matches!(missing, Err(CoreError::DomainError { .. })), "{missing:?}");
}

/// A turn review that only records the `note_change` boundaries it is told of.
#[derive(Default)]
struct NoteLog(std::sync::Mutex<Vec<Option<Vec<String>>>>);

#[async_trait::async_trait]
impl mixdog_core_api::turn_review::TurnReviewApi for NoteLog {
    fn note_change(&self, paths: Option<&[String]>) {
        self.0.lock().unwrap().push(paths.map(<[String]>::to_vec));
    }
    async fn record_call(&self, _: &str, _: &str, _: &str, _: Vec<mixdog_core_api::turn_review::CallChange>) {
        unimplemented!()
    }
    async fn record_tool_changes(&self, _: &str, _: &str, _: Vec<mixdog_core_api::turn_review::CallChange>) {
        unimplemented!()
    }
    fn take_call_diff(&self, _: &str) -> Option<String> {
        unimplemented!()
    }
    async fn begin_turn(&self, _: &str, _: &str, _: mixdog_core_api::turn_review::TurnOpen) -> Option<mixdog_core_api::turn_review::TurnToken> {
        unimplemented!()
    }
    async fn complete_turn(&self, _: &str, _: Option<&mixdog_core_api::turn_review::TurnToken>) -> bool {
        unimplemented!()
    }
    fn begin_agent_review(&self, _: &str, _: &str, _: &str, _: &str) -> Option<Box<dyn mixdog_core_api::turn_review::AgentReview>> {
        unimplemented!()
    }
    fn forget_session(&self, _: &str) {
        unimplemented!()
    }
    async fn turn_review_diff(&self, _: &str, _: &str, _: mixdog_core_api::turn_review::ReviewRead) -> mixdog_core_api::turn_review::Reply {
        unimplemented!()
    }
    async fn session_review_diff(&self, _: &str, _: &str) -> mixdog_core_api::turn_review::Reply {
        unimplemented!()
    }
    async fn session_review_file_patch(&self, _: &str, _: &str, _: &str, _: &str) -> mixdog_core_api::turn_review::Reply {
        unimplemented!()
    }
    async fn turn_review_file_patch(&self, _: &str, _: &str, _: &str) -> mixdog_core_api::turn_review::Reply {
        unimplemented!()
    }
    async fn revert_turn_review(&self, _: &str, _: &str, _: &str) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        unimplemented!()
    }
    async fn revert_turn_review_file(&self, _: &str, _: &str, _: &str, _: &str) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        unimplemented!()
    }
    async fn turn_changes(&self, _: &str, _: mixdog_core_api::turn_review::ChangesRead) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        unimplemented!()
    }
    async fn revert_turn_changes(&self, _: &str, _: &str, _: Option<&str>, _: f64) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        unimplemented!()
    }
    async fn reapply_turn_changes(&self, _: &str, _: &str, _: Option<&str>, _: f64) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        unimplemented!()
    }
    async fn clear_change_history(&self, _: &str) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        unimplemented!()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_service_tells_the_turn_review_which_files_it_changed_and_only_after_it_did() {
    let log = Arc::new(NoteLog::default());
    let env = env_with(Some(log.clone()));
    let root = env.root.to_string_lossy().into_owned();
    let abs = |rel: &str| env.root.join(rel);
    let noted = || -> Vec<Option<Vec<PathBuf>>> {
        log.0.lock().unwrap().iter().map(|n| n.as_ref().map(|p| p.iter().map(PathBuf::from).collect())).collect()
    };

    call(&env, "projectFs/writeText", json!({ "root": root, "rel": "a.txt", "content": "two\n", "expectedContent": "one\n" })).await.unwrap();
    assert_eq!(noted(), [Some(vec![abs("a.txt")])]);

    // A refused write changed nothing and tells no one.
    let refused = call(&env, "projectFs/writeText", json!({ "root": root, "rel": "a.txt", "content": "x", "expectedContent": "stale" })).await;
    assert!(refused.is_err());
    assert_eq!(noted().len(), 1);

    call(&env, "projectFs/writeTextBatch", json!({ "root": root, "files": [
        { "relPath": "a.txt", "content": "three\n", "expectedContent": "two\n" },
        { "relPath": "readme.md", "content": "# yo\n", "expectedContent": "# hi\n" },
    ] })).await.unwrap();
    call(&env, "projectFs/create", json!({ "root": root, "relDir": "src", "name": "new.txt" })).await.unwrap();
    call(&env, "projectFs/rename", json!({ "root": root, "rel": "src/new.txt", "newName": "old.txt" })).await.unwrap();
    call(&env, "projectFs/move", json!({ "root": root, "rel": "src/old.txt", "targetDirRel": "." })).await.unwrap();
    call(&env, "projectFs/copy", json!({ "root": root, "rel": "old.txt", "targetDirRel": "src" })).await.unwrap();
    assert_eq!(
        noted()[1..],
        [
            Some(vec![abs("a.txt"), abs("readme.md")]),
            Some(vec![abs("src/new.txt")]),
            Some(vec![abs("src/new.txt"), abs("src/old.txt")]),
            Some(vec![abs("src/old.txt"), abs("old.txt")]),
            Some(vec![abs("src/old.txt")]),
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_trash_entry_names_its_path_and_an_upload_commit_names_none() {
    let log = Arc::new(NoteLog::default());
    let env = env_with(Some(log.clone()));
    let root = env.root.to_string_lossy().into_owned();
    let noted = || log.0.lock().unwrap().clone();

    // A permanent delete through the server trash path.
    call(&env, "transfer/trash/entry", json!({ "path": root, "rel": "readme.md", "permanent": true })).await.unwrap();
    assert!(!env.root.join("readme.md").exists());
    assert_eq!(noted().len(), 1);
    assert_eq!(noted()[0].as_ref().unwrap().iter().map(PathBuf::from).collect::<Vec<_>>(), [env.root.join("readme.md")]);

    // A refused entry (missing) tells no one.
    assert!(call(&env, "transfer/trash/entry", json!({ "path": root, "rel": "readme.md", "permanent": true })).await.is_err());
    assert_eq!(noted().len(), 1);

    // An upload names no file at commit: anything may have changed.
    let begun = call(&env, "transfer/beginWrite", json!({ "root": root, "rel": "up.bin", "size": 3 })).await.unwrap();
    assert_eq!(noted().len(), 1, "beginning an upload changes nothing");
    let id = begun["transferId"].clone();
    call(&env, "transfer/writeChunk", json!({ "transferId": id, "offset": 0, "bytesB64": "YWJj" })).await.unwrap();
    assert_eq!(noted().len(), 1, "a chunk is only staged");
    call(&env, "transfer/commit", json!({ "transferId": id })).await.unwrap();
    assert_eq!(noted()[1..], [None]);
    assert_eq!(std::fs::read(env.root.join("up.bin")).unwrap(), b"abc");
}

// `projectFs/trash` moves to the OS recycle bin, which a headless Unix host may not have.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn a_trashed_project_entry_is_noted_by_its_absolute_path() {
    let log = Arc::new(NoteLog::default());
    let env = env_with(Some(log.clone()));
    let root = env.root.to_string_lossy().into_owned();
    std::fs::write(env.root.join("to-trash.txt"), "x").unwrap();
    call(&env, "projectFs/trash", json!({ "root": root, "rel": "to-trash.txt" })).await.unwrap();
    assert!(!env.root.join("to-trash.txt").exists());
    // The item sits in the user's real recycle bin: take it out again, found by its original path
    // (the project folder is this test's own temp directory, so nothing else can match).
    let ours: Vec<_> = trash::os_limited::list()
        .unwrap()
        .into_iter()
        .filter(|item| item.original_path() == env.root.join("to-trash.txt"))
        .collect();
    assert_eq!(ours.len(), 1, "the trashed file is in the recycle bin");
    trash::os_limited::purge_all(ours).unwrap();
    let noted = log.0.lock().unwrap().clone();
    assert_eq!(noted.len(), 1);
    assert_eq!(noted[0].as_ref().unwrap().iter().map(PathBuf::from).collect::<Vec<_>>(), [env.root.join("to-trash.txt")]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_recovery_restore_names_no_file_and_listing_or_inspecting_tells_no_one() {
    let log = Arc::new(NoteLog::default());
    let env = env_with(Some(log.clone()));
    let root = env.root.to_string_lossy().into_owned();
    // The service's journal folder (`Deps.recovery_dir`): an interrupted batch left a record.
    let store = RecoveryStore::new(env.root.parent().unwrap().join("recovery"));
    let file = env.root.join("a.txt");
    let journal = store
        .begin(
            &env.root,
            vec![PreparedFile {
                rel_path: "a.txt".into(),
                destination: canonical(&file).unwrap(),
                parent: mixdog_workspace::recovery::identity_of(&env.root).unwrap(),
                mode: 0,
                before: b"one\n".to_vec(),
                after: b"two\n".to_vec(),
            }],
        )
        .unwrap();
    std::fs::write(&file, "two\n").unwrap();
    store.release(&journal.directory).unwrap();

    let listed = call(&env, "projectFs/recovery", json!({ "root": root, "action": "list" })).await.unwrap();
    let id = listed["records"][0]["id"].as_str().unwrap_or_else(|| panic!("{listed}")).to_owned();
    let inspected = call(&env, "projectFs/recovery", json!({ "root": root, "action": "inspect", "id": id })).await.unwrap();
    let revision = inspected["detail"]["revision"].as_str().unwrap_or_else(|| panic!("{inspected}")).to_owned();
    assert!(log.0.lock().unwrap().is_empty(), "reading a record changes nothing");

    call(&env, "projectFs/recovery", json!({ "root": root, "action": "restore", "id": id, "revision": revision })).await.unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "one\n");
    assert_eq!(log.0.lock().unwrap().clone(), [None]);
}

#[test]
fn offered_names_and_mime_types_match_nodes_recorded_answers() {
    let golden: Value = serde_json::from_slice(
        &std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/desktop/transfer/names.json")).unwrap(),
    )
    .unwrap();
    for row in golden["sanitize"].as_array().unwrap() {
        let input = row["input"].as_str().unwrap();
        assert_eq!(mixdog_workspace::transfer::sanitized_file_name(input), row["name"].as_str().unwrap(), "{input:?}");
    }
    for row in golden["mime"].as_array().unwrap() {
        let input = row["input"].as_str().unwrap();
        assert_eq!(mixdog_workspace::fsops::mime_type(std::path::Path::new(input)), row["mime"].as_str().unwrap(), "{input:?}");
    }
}

/// Stands for the adapter over `CodeGraphTool`: answers with the cwd and the args it was given.
struct EchoGraph;

#[async_trait::async_trait]
impl mixdog_workspace::service::CodeGraph for EchoGraph {
    async fn query(&self, cwd: &std::path::Path, args: Value, _: &CancellationToken) -> Result<String, mixdog_workspace::error::WsError> {
        Ok(format!("{}|{args}", cwd.display()))
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn code_graph_queries_pass_the_tools_arguments_and_return_its_text() {
    let env = env();
    let root = env.root.to_string_lossy().into_owned();
    let found = call(&env, "project/codeGraph", json!({ "path": root, "mode": "find_symbol", "query": "  main " })).await.unwrap();
    assert_eq!(found, json!(format!("{root}|{}", json!({ "mode": "find_symbol", "symbols": "main", "limit": 20 }))));
    let outline = call(&env, "project/codeGraph", json!({ "path": root, "mode": "symbols", "query": "src/main.rs" })).await.unwrap();
    assert_eq!(outline, json!(format!("{root}|{}", json!({ "mode": "symbols", "files": "src/main.rs", "limit": 200 }))));
    let long = "x".repeat(257);
    let too_long = call(&env, "project/codeGraph", json!({ "path": root, "mode": "references", "query": long })).await;
    assert!(matches!(&too_long, Err(CoreError::InvalidParams { expected, .. }) if &**expected == "Symbol is invalid."), "{too_long:?}");
    let denied = call(&env, "project/codeGraph", json!({ "path": env.root.parent().unwrap().to_string_lossy(), "mode": "symbols", "query": "a" })).await;
    // `host.codeGraphQuery` resolves the folder through `projectDirectory` (session-host.ts:776-781).
    assert!(unavailable(&denied), "{denied:?}");
}

fn futures_block<F: std::future::Future>(f: F) -> F::Output {
    tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(f))
}
// ---- DS-WS-1: the recorded Node fixtures, replayed through the service -----------------------------

fn corpus(domain: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../fixtures/desktop/{domain}/corpus.json"));
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn strip_mtime(mut value: Value) -> Value {
    match &mut value {
        Value::Object(map) => {
            map.remove("mtimeMs");
            for v in map.values_mut() {
                *v = strip_mtime(v.take());
            }
        }
        Value::Array(items) => {
            for v in items.iter_mut() {
                *v = strip_mtime(v.take());
            }
        }
        _ => {}
    }
    value
}

/// The recorded Node error text, as the reason the Rust core must answer with.
fn expect_error(message: &str, got: &CoreError, ctx: &str, root: &str) {
    let ok = match got {
        CoreError::PreconditionFailed { .. } => message.starts_with("File changed on disk"),
        CoreError::InvalidParams { expected, .. } => {
            // Search-pattern text is shown to the user: byte-equal. Others map by reason.
            if message.starts_with("Invalid search pattern") { &**expected == message } else { message == "Entry name is invalid." }
        }
        // A local caller's refusal of a path beyond the project (Node's service threw its plain `Error`; the phone's answer is the test above).
        CoreError::PermissionDenied { .. } => message == "Path is outside the project." || message == "Path resolves outside the project.",
        CoreError::DomainError { code, message: got, .. } => match code.as_deref() {
            // A system error: Node's whole text, the recorded `<ROOT>` standing for this world's folder.
            Some("ENOENT") => got.as_deref().map(|text| text.replace(root, "<ROOT>")).as_deref() == Some(message),
            // Node's plain `Error`: the text, no code.
            None => got.as_deref() == Some(message),
            _ => false,
        },
        _ => false,
    };
    assert!(ok, "{ctx}: recorded {message:?}, got {got:?}");
}

fn tree(root: &std::path::Path, files: &[(&str, &[u8])]) {
    for (rel, data) in files {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, data).unwrap();
    }
}

async fn replay(env: &Env, cases: &Value, root: &str, ctx: &str) {
    for case in cases["cases"].as_array().or_else(|| cases["entries"].as_array()).unwrap() {
        let op = case["op"].as_str().unwrap();
        let args = &case["args"];
        let (method, params): (&'static str, Value) = match op {
            "listProjectDirIn" | "listProjectDirIn(after)" => ("projectFs/listDir", json!({ "root": root, "rel": args[0] })),
            "readProjectTextFileIn" | "readProjectTextFileIn(after write)" => ("projectFs/readText", json!({ "root": root, "rel": args[0] })),
            "statProjectFileIn" => ("projectFs/stat", json!({ "root": root, "rel": args[0] })),
            "writeProjectTextFileIn(expected mismatch)" => {
                ("projectFs/writeText", json!({ "root": root, "rel": args[0], "content": "new", "expectedContent": "WRONG" }))
            }
            "writeProjectTextFileIn" => (
                "projectFs/writeText",
                json!({ "root": root, "rel": args[0], "content": "rewritten\n", "expectedContent": "héllo\nworld\n" }),
            ),
            "createProjectEntryIn" | "createProjectEntryIn(invalid)" => {
                ("projectFs/create", json!({ "root": root, "relDir": args[0], "name": args[1], "directory": args[2] }))
            }
            "renameProjectEntryIn" => ("projectFs/rename", json!({ "root": root, "rel": args[0], "newName": args[1] })),
            "moveProjectEntryIn" => ("projectFs/move", json!({ "root": root, "rel": args[0], "targetDirRel": args[1] })),
            "copyProjectEntryIn" => ("projectFs/copy", json!({ "root": root, "rel": args[0], "targetDirRel": args[1] })),
            "searchWorkspaceTextIn" => ("projectFs/searchText", json!({ "root": root, "options": args })),
            "replaceWorkspaceTextIn" => {
                let mut params = json!({ "root": root, "options": args[0], "replacement": args[1] });
                if let Some(paths) = args.get(2).filter(|p| !p.is_null()) {
                    params["relPaths"] = paths.clone();
                }
                ("projectFs/replaceText", params)
            }
            other => panic!("{ctx}: unmapped recorded op {other}"),
        };
        let got = call(env, method, params).await;
        let label = format!("{ctx} {op} {args}");
        match (case.get("error"), got) {
            (Some(error), Err(e)) => expect_error(error.as_str().unwrap(), &e, &label, root),
            (None, Ok(value)) => {
                if let Some(expected) = case.get("result") {
                    assert_eq!(&strip_mtime(value), expected, "{label}");
                }
            }
            (error, got) => panic!("{label}: recorded error {error:?}, got {got:?}"),
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn recorded_project_file_operations_replay_identically() {
    let env = env();
    let pf = env.root.parent().unwrap().join("pf");
    std::fs::create_dir_all(&pf).unwrap();
    tree(
        &pf,
        &[
            ("utf8.txt", "héllo\nworld\n".as_bytes()),
            ("crlf.txt", b"a\r\nb\r\n"),
            ("bom8.txt", b"\xef\xbb\xbfbom\n"),
            ("utf16le.txt", b"\xff\xfeh\x00i\x00\n\x00"),
            ("bin.dat", &[0, 255, 0, 255, 1, 2, 3]),
            ("dir/inner.txt", b"inner\n"),
        ],
    );
    // A row, not `project/create`: the recorded listing of this folder has no `.mixdog/project.id`.
    let row = mixdog_store::state::ProjectRow { path: pf.to_string_lossy().into_owned(), alias: None, hidden: false, hidden_rank: None, last_used_at: None, name: None };
    env.state.write(move |tx| tx.put_project(&row)).await.unwrap();
    replay(&env, &corpus("files"), &pf.to_string_lossy(), "files").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn recorded_workspace_searches_and_replace_replay_identically() {
    let env = env();
    let ws = env.root.parent().unwrap().join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    tree(
        &ws,
        &[
            ("a.txt", b"Hello World\nhello world\nHELLO\n"),
            ("src/x.mjs", b"const hello = \"Hello\";\nfunction helloWorld() {}\n"),
            ("node_modules/skip.js", b"hello skipped\n"),
            ("data.bin", &[0, 1, 2, 104, 101, 108, 108, 111]),
        ],
    );
    env.service.catalog().add(&ws.to_string_lossy(), &CancellationToken::new(), None).await.unwrap();
    replay(&env, &corpus("search"), &ws.to_string_lossy(), "search").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn recorded_transfer_reads_replay_through_the_transfer_methods() {
    let env = env();
    let root = env.root.to_string_lossy().into_owned();
    let payload: Vec<u8> = b"0123456789abcdef".repeat(8);
    std::fs::write(env.root.join("report.bin"), &payload).unwrap();
    let fixture = corpus("transfer");
    let entry = |op: &str| fixture["entries"].as_array().unwrap().iter().find(|e| e["op"] == op).unwrap().clone();
    // begin: the size and name the Node service recorded.
    let began = call(&env, "transfer/beginRead", json!({ "source": { "kind": "file", "root": root, "rel": "report.bin" } })).await.unwrap();
    assert_eq!(began["size"], entry("begin")["result"]["size"]);
    assert_eq!(began["entry"]["name"], entry("begin")["result"]["name"]);
    assert_eq!(began["entry"]["rangeMaxBytes"], entry("begin")["result"]["rangeMaxBytes"]);
    assert_eq!(began["mimeType"], entry("authorize")["result"]["mime"]);
    // authorize(outside): a path out of the project is refused.
    let outside = call(&env, "transfer/beginRead", json!({ "source": { "kind": "file", "root": root, "rel": "../x" } })).await;
    // Node's `FileDownloadError('outside-project')` (recorded: name FileDownloadError): a refusal the core types as a permission denial, as
    // `expired` is typed for the "no longer available" one; the download group's adapter gives it Node's text, which
    // `transfer::tests::a_project_path_beyond_the_project_is_nodes_outside_project_refusal` holds to the recording.
    assert_eq!(entry("authorize(outside)")["error"]["name"], "FileDownloadError");
    assert!(matches!(&outside, Err(CoreError::PermissionDenied { .. })), "{outside:?}");
    let id = began["transferId"].as_str().unwrap().to_owned();
    // readRange: the recorded bytes.
    let range = call(&env, "transfer/readRange", json!({ "transferId": id, "offset": 0, "length": 64 })).await.unwrap();
    assert_eq!(range["data"], entry("readRange")["result"]["data"]);
    assert_eq!((&range["length"], &range["eof"]), (&entry("readRange")["result"]["length"], &entry("readRange")["result"]["eof"]));
    // past end: recorded as a TypeError (invalid params).
    let past = call(&env, "transfer/readRange", json!({ "transferId": id, "offset": 1000, "length": 8 })).await;
    assert!(matches!(past, Err(CoreError::InvalidParams { .. })), "{past:?}");
    // finish, then the id is gone; abort of an unknown id is false.
    assert_eq!(call(&env, "transfer/endRead", json!({ "transferId": id })).await.unwrap()["ended"], true);
    assert!(call(&env, "transfer/readRange", json!({ "transferId": id, "offset": 0, "length": 8 })).await.is_err());
    assert_eq!(call(&env, "transfer/abort", json!({ "transferId": "nope" })).await.unwrap()["aborted"], entry("abort(unknown)")["result"]);
}

fn fill(value: &Value, work: &str) -> Value {
    match value {
        Value::String(s) => Value::String(s.replace("<WORK>", work)),
        Value::Array(items) => Value::Array(items.iter().map(|v| fill(v, work)).collect()),
        // `{"$repeat": [unit, count]}` stands for a string too long to keep in the corpus.
        Value::Object(map) if map.contains_key("$repeat") => {
            Value::String(map["$repeat"][0].as_str().unwrap().repeat(map["$repeat"][1].as_u64().unwrap() as usize))
        }
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), fill(v, work))).collect()),
        other => other.clone(),
    }
}

/// The corpus's scrubbing: the temp root becomes `<WORK>`, millisecond clocks 0, huge bodies their length.
fn scrub(value: &Value, work: &str) -> Value {
    match value {
        Value::String(s) if s.encode_utf16().count() > 100_000 => Value::String(format!("<LEN:{}>", s.encode_utf16().count())),
        Value::String(s) => Value::String(s.replace(work, "<WORK>")),
        Value::Number(n) if n.as_u64().is_some_and(|n| (1_600_000_000_000..1_800_000_000_000).contains(&n)) => json!(0),
        Value::Array(items) => Value::Array(items.iter().map(|v| scrub(v, work)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), scrub(v, work))).collect()),
        other => other.clone(),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn recorded_editor_files_replay_identically() {
    let fixture = corpus("editor-config");
    let host = if cfg!(windows) { "win32" } else if cfg!(target_os = "macos") { "darwin" } else { "linux" };
    if fixture["platform"] != host {
        eprintln!("editor-config corpus was recorded on {}; its backup names follow that platform's case rule", fixture["platform"]);
        return;
    }
    let env = env();
    let work = env.root.parent().unwrap().to_path_buf();
    let work_s = work.to_string_lossy().into_owned();
    let backups = mixdog_workspace::editorcfg::Backups::new(&work.join("userData"));
    let backup_files = || -> Vec<String> {
        std::fs::read_dir(work.join("userData/editor-backups")).map(|d| d.map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default()
    };
    for (index, entry) in fixture["entries"].as_array().unwrap().iter().enumerate() {
        let label = format!("#{index} {} {}", entry["method"], entry["input"]);
        if entry["input"].get("note").is_some() {
            // The file-count cap: 105 sources, newest last, mtimes one second apart.
            let _ = std::fs::remove_dir_all(work.join("userData/editor-backups"));
            let now = std::time::SystemTime::now();
            for i in 0..105u64 {
                let source = work.join(format!("cap/f{i}.txt")).to_string_lossy().into_owned();
                call_local(&env, "projectFs/backup/write", json!({ "sourcePath": source, "content": format!("c{i}"), "expectedContent": "e" })).await.unwrap();
                let file = std::fs::OpenOptions::new().write(true).open(backups.path_of(&source).unwrap()).unwrap();
                file.set_modified(now - Duration::from_secs(105 - i)).unwrap();
            }
            assert_eq!(backup_files().len() as u64, entry["result"]["filesAfter"].as_u64().unwrap(), "{label}");
            continue;
        }
        for step in entry["setup"].as_array().into_iter().flatten() {
            if let Some(rel) = step["file"].as_str() {
                tree(&work, &[(rel, step["text"].as_str().unwrap().as_bytes())]);
            } else {
                let source = work.join(step["backup"].as_str().unwrap()).to_string_lossy().into_owned();
                let text = match step["raw"].as_str() {
                    Some(raw) => raw.to_owned(),
                    None => {
                        let updated = mixdog_workspace::editorcfg::now_ms() - step["ageMs"].as_i64().unwrap();
                        json!({ "content": step["content"], "expectedContent": step["expectedContent"], "updatedAt": updated }).to_string()
                    }
                };
                std::fs::write(backups.path_of(&source).unwrap(), text).unwrap();
            }
        }
        let input = fill(&entry["input"], &work_s);
        let (method, params): (&'static str, Value) = match entry["method"].as_str().unwrap() {
            "projectFs/workspaceFile/read" => ("projectFs/workspaceFile/read", json!({ "workspaceFile": input["workspaceFile"] })),
            "projectFs/workspaceFile/write" => {
                ("projectFs/workspaceFile/write", json!({ "workspaceFile": input["workspaceFile"], "folders": input["folders"] }))
            }
            "projectFs/readEditorSettings" => {
                let root = input["root"].as_str().unwrap();
                if !std::path::Path::new(root).exists() {
                    // A folder that is not there cannot be a registered project: the boundary refuses it.
                    let denied = call(&env, "projectFs/readEditorSettings", json!({ "root": root, "rel": input["rel"] })).await;
                    // `readEditorSettings` resolves the folder through `host.projectDirectory` (remote-methods.ts:740).
                    assert!(unavailable(&denied), "{label}: {denied:?}");
                    continue;
                }
                env.service.catalog().add(root, &CancellationToken::new(), None).await.unwrap();
                ("projectFs/readEditorSettings", json!({ "root": root, "rel": input["rel"], "workspaceFile": input["workspaceFile"] }))
            }
            "projectFs/backup/read" => ("projectFs/backup/read", json!({ "sourcePath": input["sourcePath"] })),
            "projectFs/backup/write" => (
                "projectFs/backup/write",
                json!({ "sourcePath": input["sourcePath"], "content": input["content"], "expectedContent": input["expectedContent"] }),
            ),
            "projectFs/backup/delete" => ("projectFs/backup/delete", json!({ "sourcePath": input["sourcePath"] })),
            "project/taskWorkspace" => ("project/taskWorkspace", json!({})),
            other => panic!("{label}: unmapped recorded method {other}"),
        };
        // The corpus is the desktop editor's own backups (any file it edits, `project-files.ts`): a local connection's calls. A paired
        // phone's backups are held to a project or granted file (`a_relay_editor_backup_or_preview_...`).
        let answer = if method.starts_with("projectFs/backup/") { call_local(&env, method, params).await } else { call(&env, method, params).await };
        match (entry.get("error"), answer) {
            (Some(error), Err(got)) => {
                // Node's TypeErrors are this core's invalid params, with the text; its system errors only need to fail.
                if error["name"] == "TypeError" {
                    let CoreError::InvalidParams { expected, .. } = &got else { panic!("{label}: {got:?}") };
                    assert_eq!(&**expected, error["message"].as_str().unwrap(), "{label}");
                }
            }
            (None, Ok(value)) => {
                if let Some(expected) = entry.get("result") {
                    assert_eq!(&scrub(&value, &work_s), expected, "{label}");
                }
            }
            (error, got) => panic!("{label}: recorded error {error:?}, got {got:?}"),
        }
        if let Some(expected) = entry.get("fileAfter") {
            let mut file = input["workspaceFile"].as_str().unwrap().to_owned();
            if !file.to_lowercase().ends_with(".code-workspace") {
                file.push_str(".code-workspace");
            }
            // The file's text is JSON: a Windows path in it has doubled backslashes.
            let text = std::fs::read_to_string(&file)
                .map(|t| Value::String(t.replace(&work_s.replace('\\', "\\\\"), "<WORK>").replace(&work_s, "<WORK>")))
                .unwrap_or(Value::Null);
            assert_eq!(&text, expected, "{label}: file after");
        }
        if let Some(expected) = entry.get("files") {
            assert_eq!(backup_files().len() as u64, expected.as_u64().unwrap(), "{label}: backup files");
            let strays: Vec<String> = backup_files().into_iter().filter(|n| n.len() != 69 || !n.ends_with(".json")).collect();
            assert_eq!(json!(strays), entry["fileNames"], "{label}: stray names");
        }
        if let Some(gone) = entry.get("fileGone") {
            assert_eq!(!backups.path_of(input["sourcePath"].as_str().unwrap()).unwrap().exists(), gone.as_bool().unwrap(), "{label}");
        }
    }
}

/// The user's Markdown default view is a config key here (`desktop.editor.markdownDefaultView`; Node keeps it in the user settings
/// file as `mixdog.markdown.defaultView`). Editor settings put it in the user scope: the recorded Node answers of the scoped
/// settings (where the user file states `rich`) are the same when the file lacks the key and the config states it.
#[tokio::test(flavor = "multi_thread")]
async fn the_users_markdown_view_in_the_config_is_the_user_scope_of_editor_settings() {
    const STATED: &str = "\"mixdog.markdown.defaultView\": \"rich\",";
    let fixture = corpus("editor-config");
    let entries = fixture["entries"].as_array().unwrap();
    let start = entries
        .iter()
        .position(|entry| entry["setup"].as_array().is_some_and(|setup| setup.iter().any(|step| step["text"].as_str().is_some_and(|text| text.contains(STATED)))))
        .expect("the corpus records a user scope that states the view");
    let env = env();
    env.service.set_user_markdown_view(Arc::new(|| Some("rich".to_owned())));
    let work = env.root.parent().unwrap().to_path_buf();
    let work_s = work.to_string_lossy().into_owned();
    for step in entries[start]["setup"].as_array().unwrap() {
        let text = step["text"].as_str().unwrap().replace(STATED, "");
        tree(&work, &[(step["file"].as_str().unwrap(), text.as_bytes())]);
    }
    let mut replayed = 0;
    for (index, entry) in entries.iter().enumerate().skip(start) {
        if index > start && entry.get("setup").is_some() {
            break;
        }
        if entry["method"] != "projectFs/readEditorSettings" {
            continue;
        }
        let input = fill(&entry["input"], &work_s);
        if !std::path::Path::new(input["root"].as_str().unwrap()).exists() {
            continue;
        }
        env.service.catalog().add(input["root"].as_str().unwrap(), &CancellationToken::new(), None).await.unwrap();
        let got = call(&env, "projectFs/readEditorSettings", json!({ "root": input["root"], "rel": input["rel"], "workspaceFile": input["workspaceFile"] })).await.unwrap();
        assert_eq!(&scrub(&got, &work_s), &entry["result"], "#{index} {}", entry["input"]);
        replayed += 1;
    }
    assert!(replayed > 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn lsp_feed_carries_node_keyed_sections_with_a_snapshot_for_late_subscribers() {
    let env = env();
    let root = env.root.to_string_lossy().into_owned();
    let reply = env.service.call(request("lsp/subscribe", json!({ "root": root }))).await.unwrap();
    let Reply::Subscribe(sub) = reply else { panic!("lsp/subscribe must subscribe") };
    let conn = MockConnection::new(ConnectionId(1), env.limits);
    let attached = subscribe(&sub.feed, SubscriptionId::from("s1"), sub.window, None, &conn).unwrap();
    conn.send_control_release(bytes::Bytes::from_static(b"ok"), attached.release).unwrap();
    // The mock process manager starts no real server: opening a TypeScript file publishes statuses.
    call(&env, "lsp/document", json!({ "projectPath": root, "root": root, "document": { "kind": "open", "languageId": "typescript", "relPath": "a.ts", "content": "x", "version": 1 } })).await.unwrap();
    let raw = conn.drain_text_until(|texts| texts.iter().any(|f| f.contains("lsp/status/updated"))).await;
    let frames: Vec<Value> = raw.iter().filter_map(|f| serde_json::from_str(f.split_once(':')?.1).ok()).collect();
    assert!(!raw.is_empty(), "no frames at all");
    let status = frames.iter().find(|f| f["method"] == "lsp/status/updated").unwrap_or_else(|| panic!("a status frame in {raw:?}"));
    let key = status["params"]["key"].as_str().unwrap();
    // Node's `statusKey`: the language, or the language, `\0` and the path.
    assert!(key == "typescript" || key == "typescript\0a.ts", "{key:?}");
    assert_eq!(status["params"]["section"], "lspStatus");
    assert_eq!(status["params"]["value"]["projectPath"], root.as_str());
    assert_eq!(status["params"]["revision"], 1);
    assert_eq!(status["params"]["value"]["status"], "starting");
    // A subscriber that joins later sees the current rows in its snapshot.
    let late = env.service.call(request("lsp/subscribe", json!({ "root": root }))).await.unwrap();
    let Reply::Subscribe(late) = late else { panic!() };
    let conn2 = MockConnection::new(ConnectionId(2), env.limits);
    let attached = subscribe(&late.feed, SubscriptionId::from("s2"), late.window, None, &conn2).unwrap();
    conn2.send_control_release(bytes::Bytes::from_static(b"ok"), attached.release).unwrap();
    let snapshot = conn2.drain_text_until(|texts| texts.iter().any(|f| f.contains("feed/snapshot"))).await.into_iter().find(|f| f.contains("feed/snapshot")).expect("a snapshot");
    assert!(snapshot.contains("lspStatus") && snapshot.contains(key.replace('\0', "\\u0000").as_str()), "{snapshot}");
}

#[tokio::test(flavor = "multi_thread")]
async fn recorded_lsp_registry_and_unsupported_answers_replay() {
    let env = env();
    let fixture = corpus("lsp");
    let find = |op: &str| fixture["entries"].as_array().unwrap().iter().find(|e| e["op"] == op).unwrap().clone();
    let root = env.root.to_string_lossy().into_owned();
    let doc = call(&env, "lsp/document", json!({ "projectPath": root, "root": root, "document": { "kind": "open", "languageId": "plaintext", "relPath": "a.xyz", "content": "x", "version": 1 } })).await.unwrap();
    assert_eq!(doc, find("lspDocument")["result"]);
    let request = call(
        &env,
        "lsp/request",
        json!({ "projectPath": root, "root": root, "request": { "relPath": "a.xyz", "languageId": "plaintext", "method": "textDocument/hover", "params": { "position": { "line": 0, "character": 0 } } } }),
    )
    .await
    .unwrap();
    assert_eq!(request, find("lspRequest")["result"]);
    assert_eq!(mixdog_workspace::lsp::document_language_id("a.tsx", "typescript"), "typescriptreact");
    assert_eq!(mixdog_workspace::lsp::document_language_id("Dockerfile", "plaintext"), "plaintext");
    let table = &find("SERVER_BY_LANGUAGE")["result"];
    for language in mixdog_workspace::lsp::DEFAULT_LANGUAGES {
        let spec = mixdog_workspace::lsp::default_spec(language).unwrap();
        assert_eq!(table[language]["command"], spec.command.as_str(), "{language}");
        assert_eq!(table[language]["id"], spec.id.as_str(), "{language}");
        assert_eq!(table[language]["args"], json!(spec.args), "{language}");
    }
}

// ---- the phone's start calls: what Node's `canonicalDirectory`, `knownProject` and `enter` answered (fixtures/phone-chat/host.json) --------

/// The fixture's managed worktrees: `(worktree folder, owner Project, ready)`. A stand-in for the worktree manager's registry behind the daemon's
/// `SessionProjectWorkspaces::managed`, the one resolver the service takes (`set_managed_projects`).
struct Worktrees(CoreState, Vec<(String, String, bool)>);

#[async_trait::async_trait]
impl mixdog_workspace::service::ManagedProjects for Worktrees {
    async fn owner(&self, path: &str) -> Option<(String, String)> {
        let real = canonical(std::path::Path::new(path)).ok()?.to_string_lossy().into_owned();
        let below = |folder: &str| real == folder || real.starts_with(&format!("{folder}{}", std::path::MAIN_SEPARATOR));
        let (_, owner, _) = self.1.iter().find(|(folder, _, ready)| *ready && below(folder))?;
        self.0.project(owner).await.ok().flatten()?;
        Some((owner.clone(), real))
    }
}

fn domain(error: &CoreError) -> (Option<String>, Option<String>) {
    match error {
        CoreError::DomainError { code, message, .. } => (code.as_ref().map(|c| c.to_string()), message.as_ref().map(|m| m.to_string())),
        other => panic!("not a domain error: {other:?}"),
    }
}

/// The adapter's sequence for `startProject` / `startProjectTask` (remote-chat-host.ts): the folder the blank snapshot names, and the
/// folders `project/create` registered (Node's `addProject` calls) on the way.
async fn start_through_core(env: &Env, call: &str, path: &str) -> (Result<String, CoreError>, Vec<String>) {
    let mut added = Vec::new();
    let folder = if call == "startProject" {
        match self::call(env, "project/create", json!({ "path": path })).await {
            Ok(created) => {
                let folder = created["project"]["path"].as_str().unwrap().to_owned();
                added.push(folder.clone());
                let _ = self::call(env, "project/touch", json!({ "path": folder })).await;
                Ok(folder)
            }
            Err(error) => Err(error),
        }
    } else {
        match self::call(env, "project/directory", json!({ "path": path, "owner": true })).await {
            Ok(answer) => {
                let _ = self::call(env, "project/touch", json!({ "path": path })).await;
                Ok(answer["path"].as_str().unwrap().to_owned())
            }
            Err(error) => Err(error),
        }
    };
    (folder, added)
}

#[tokio::test(flavor = "multi_thread")]
async fn recorded_start_calls_resolve_the_folder_node_did() {
    let fixture: Value = serde_json::from_str(include_str!("../../../../fixtures/phone-chat/host.json")).unwrap();
    let mut replayed = 0;
    for case in fixture["cases"].as_array().unwrap().iter().filter(|case| case["group"] == "start" && case["call"] != "startTask") {
        let name = case["name"].as_str().unwrap();
        let env = env();
        let base = env.root.parent().unwrap().to_path_buf();
        let root = base.to_string_lossy().into_owned();
        let at = |text: &str| text.replace("<ROOT>/", &format!("{root}/")).replace('/', std::path::MAIN_SEPARATOR_STR);
        let setup = &case["setup"];
        for dir in setup["dirs"].as_array().unwrap() {
            std::fs::create_dir_all(base.join(dir.as_str().unwrap())).unwrap();
        }
        for file in setup["files"].as_array().unwrap() {
            std::fs::write(base.join(file.as_str().unwrap()), "x").unwrap();
        }
        let hidden: Vec<String> = setup["hidden"].as_array().unwrap().iter().map(|h| at(h.as_str().unwrap())).collect();
        let registered: Vec<String> = setup["projects"].as_array().unwrap().iter().map(|p| at(p["path"].as_str().unwrap())).collect();
        for (rank, path) in registered.iter().chain(hidden.iter().filter(|h| !registered.contains(h))).enumerate() {
            let tombstone = hidden.contains(path);
            let row = mixdog_store::state::ProjectRow { path: path.clone(), alias: None, hidden: tombstone, hidden_rank: tombstone.then_some(rank as i64), last_used_at: None, name: None };
            env.state.write(move |tx| tx.put_project(&row)).await.unwrap();
        }
        if setup["worktrees"] == true {
            let ready = name != "startProjectTask:worktree-not-ready";
            let folder = canonical(&base.join("wt")).unwrap().to_string_lossy().into_owned();
            env.service.set_managed_projects(Arc::new(Worktrees(env.state.clone(), vec![(folder, at("<ROOT>/proj"), ready)])));
        }
        // `requiredString` (the phone method layer) trims before a call reaches the host; a blank or non-string path never does.
        let Some(given) = case["args"][0].as_str().map(str::trim).filter(|g| !g.is_empty()) else { continue };
        let (outcome, added) = start_through_core(&env, case["call"].as_str().unwrap(), &at(given)).await;
        let node = &case["node"];
        match (&outcome, node.get("error")) {
            (Ok(folder), None) => {
                // What the core decides is the folder; Node's snapshot names it three times (the rest of the snapshot is the chat adapter's, replayed
                // over this same fixture by remote-chat-host.test.mjs).
                let result = &node["result"];
                for field in [&result["cwd"], &result["currentProject"], &result["desktopSession"]["projectPath"]] {
                    assert_eq!(*folder, at(field.as_str().unwrap()), "{name}: the folder of the blank snapshot");
                }
            }
            (Err(error), Some(node_error)) => {
                let (code, message) = domain(error);
                let node_message = node_error["message"].as_str().unwrap();
                let mut keys: Vec<&str> = node_error.as_object().unwrap().keys().map(String::as_str).collect();
                keys.sort();
                match code.as_deref() {
                    // The message is the path the OS error names; the client builds Node's whole text from it.
                    Some("pathMissing") => {
                        assert_eq!(node_error["name"], "Error", "{name}");
                        assert_eq!(keys, ["code", "message", "name"], "{name}");
                        assert_eq!(node_error["code"], "ENOENT", "{name}");
                        let named = message.unwrap().replace('\\', "/").replace(&root.replace('\\', "/"), "<ROOT>");
                        assert_eq!(node_message, format!("ENOENT: no such file or directory, realpath '{named}'"), "{name}");
                    }
                    Some("notADirectory") => {
                        assert_eq!(node_error["name"], "TypeError", "{name}");
                        assert_eq!(keys, ["message", "name"], "{name}");
                        assert_eq!(message.as_deref(), Some(node_message), "{name}");
                    }
                    // Node's registry (`known`, desktop-project-registry.ts) throws a plain `Error` with no code when its store has no
                    // `listProjectsStrict` (the stand-in store this fixture was recorded with: no `code` in `node_error`), and the coded
                    // `PROJECT_UNAVAILABLE` when it has one - as the real store (src/runtime/shared/projects.mjs) does, and as the core's
                    // registry is: it tells a removal from an unreadable table. The real store's whole error is in the files recording.
                    Some("PROJECT_UNAVAILABLE") => {
                        assert_eq!(node_error["name"], "Error", "{name}");
                        assert!(node_error.get("code").is_none(), "{name}: the stand-in store's error carries no code");
                        let files: Value = serde_json::from_str(include_str!("../../../../../../apps/mobile/fixtures/phone-files/golden.json")).unwrap();
                        let strict = files["scenarios"]["relay"]["steps"].as_array().unwrap().iter().map(|step| &step["frame"]).find(|frame| frame["errorCode"] == "PROJECT_UNAVAILABLE").unwrap();
                        assert_eq!(strict["error"], node_message, "{name}: one text in both recordings");
                        assert_eq!((code.as_deref(), message.as_deref()), (strict["errorCode"].as_str(), strict["error"].as_str()), "{name}: the whole error");
                    }
                    other => panic!("{name}: unexpected code {other:?}"),
                }
            }
            (outcome, node) => panic!("{name}: core {outcome:?} against Node {node:?}"),
        }
        // The registry afterwards: the touch went to the Project Node touched, and the entered Project lost its tombstone.
        let rows = env.state.projects().await.unwrap();
        // Node's store calls, whole: an `addProject` for each Project `project/create` registered, then a `touchProjectSelected` for each Project the
        // touch reached (the core's `lastUsedAt`).
        let core_calls: Vec<Value> = added.iter().map(|path| json!(["addProject", path])).chain(rows.iter().filter(|row| row.last_used_at.is_some()).map(|row| json!(["touchProjectSelected", row.path]))).collect();
        let node_calls: Vec<Value> = node["storeCalls"].as_array().unwrap().iter().map(|call| Value::Array(call.as_array().unwrap().iter().map(|part| json!(at(part.as_str().unwrap()))).collect())).collect();
        assert_eq!(core_calls, node_calls, "{name}: the store calls");
        let mut left: Vec<String> = rows.iter().filter(|row| row.hidden).map(|row| row.path.clone()).collect();
        left.sort();
        let node_left: Vec<String> = node["hiddenAfter"].as_array().map(|h| h.iter().map(|p| at(p.as_str().unwrap())).collect()).unwrap_or_else(|| hidden.clone());
        assert_eq!(left, node_left, "{name}: tombstones left");
        assert!(rows.iter().all(|row| row.hidden || row.hidden_rank.is_none()), "{name}: a rank outlived its tombstone");
        replayed += 1;
    }
    assert_eq!(replayed, 18, "recorded start cases replayed");
}
