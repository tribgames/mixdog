//! Twin test `library`: the recording of Node's office design library (`native/core/fixtures/office-library/golden.json`,
//! written by `benchmarks/rust-core/recorders/record-office-library.mjs`) against `mixdog_office_design::library`.
//!
//! The recording holds the pure cases (safe ids, version order, canonical JSON, layout and sample normalisation, envelope
//! verification, configuration reading) and a script run against one data directory: a fake network serving signed packs,
//! sync, resolution, bindings, composition history, inspection and snapshots of every file the library wrote. Every
//! output equals the recording value for value and as JSON text. The signing keys, envelopes and template bytes are in
//! the recording, so nothing here is random; the clock is the recording's. Paths are compared with the temporary folder
//! written `<root>` and `/` as the separator. Re-recording is `twin_live_library` (ignored: it runs Node).
//!
//! The template index writer is a later port (`nr-office-design-templates`); the script only reaches it with no template
//! directory, where it writes an index of nothing, which `EmptyIndexer` writes too.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mixdog_fsio::{ReadProof, WriteProof};
use mixdog_js::{json_number, json_parse, json_stringify, to_number_of};
use mixdog_office_base::twin;
use mixdog_office_base::values::{sha256, truthy};
use mixdog_office_design::library::{
    CompositionRecord, Context, Environment, Fetch, FetchRequest, FetchResponse, LibraryConfig, ResolveRequest, SyncOptions, TemplateIndexer, canonical_office_design_pack,
    compare_office_design_versions, default_office_template_directories, inspect_office_design_library, library_paths, load_config, normalize_layouts,
    normalize_local_samples, persist_office_design_binding, read_json, read_office_composition_history, record_office_composition_history,
    resolve_office_design_library, safe_id, sync_office_design_library, verify_office_design_pack_envelope, write_json_atomic,
};
use mixdog_rt::{CancellationToken, DurabilityIo, InLane, LaneToken};
use serde_json::{Map, Value, json};

fn golden() -> Value {
    twin::load_golden("office-library")
}

/// Runs `job` as a durability-lane job (the inline test backend runs it on this thread).
fn on_lane<R: Send + 'static>(job: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> R {
    let lanes = mixdog_rt::testing::tokens();
    tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("runtime")
        .block_on(async { lanes.durability_io.submit(&CancellationToken::new(), job).expect("submit").await.expect("job") })
}

// ---- the world ----------------------------------------------------------------------------------------------------

/// A world's temporary folder and how texts are written against it.
#[derive(Clone)]
struct Root(String);

impl Root {
    /// A text with the folder as `<root>` and `/` as the separator.
    fn scrub_text(&self, text: &str) -> String {
        text.replace(&self.0, "<root>").replace('\\', "/")
    }

    fn scrub(&self, value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.scrub_text(text)),
            Value::Array(items) => Value::Array(items.iter().map(|item| self.scrub(item)).collect()),
            Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (self.scrub_text(key), self.scrub(item))).collect()),
            other => other.clone(),
        }
    }

    /// The inverse, for an input written with `<root>`.
    fn unscrub(&self, value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(text.replace("<root>", &self.0)),
            Value::Array(items) => Value::Array(items.iter().map(|item| self.unscrub(item)).collect()),
            Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), self.unscrub(item))).collect()),
            other => other.clone(),
        }
    }

    fn text(&self, value: Option<&Value>) -> String {
        value.and_then(Value::as_str).map(|text| text.replace("<root>", &self.0)).unwrap_or_default()
    }
}

struct World {
    root: Root,
    dir: PathBuf,
    data_dir: PathBuf,
    clock: Arc<AtomicU64>,
    env: Environment,
}

impl World {
    fn new(dir: &Path) -> Self {
        let clock = Arc::new(AtomicU64::new(0));
        let ticking = Arc::clone(&clock);
        let env = Environment {
            library_config: String::new(),
            pack_url: String::new(),
            pack_key_id: String::new(),
            pack_public_key: String::new(),
            template_dirs: String::new(),
            windows: true,
            program_files: "C:\\Program Files".to_owned(),
            program_files_x86: "C:\\Program Files (x86)".to_owned(),
            app_data: "C:\\Users\\twin\\AppData\\Roaming".to_owned(),
            home: "C:\\Users\\twin".to_owned(),
            cwd: dir.to_path_buf(),
            bundled_templates: PathBuf::from("<bundled>"),
            now_ms: Arc::new(move || ticking.load(Ordering::SeqCst) as f64),
        };
        Self { root: Root(dir.to_string_lossy().into_owned()), dir: dir.to_path_buf(), data_dir: dir.join("data"), clock, env }
    }

    fn library_root(&self) -> PathBuf {
        self.data_dir.join("office").join("design-library")
    }
}

/// `{ value }` / `{ error }` of an attempt, written against the folder.
fn attempt(root: &Root, result: Result<Value, String>) -> Value {
    match result {
        Ok(value) => json!({ "value": root.scrub(&value) }),
        Err(error) => json!({ "error": root.scrub_text(&error) }),
    }
}

/// The recorded `{ value }` or `{ error }` of an entry (`{}` when it recorded neither).
fn recorded(entry: &Value) -> Value {
    if let Some(error) = entry.get("error") {
        json!({ "error": error })
    } else if let Some(value) = entry.get("value") {
        json!({ "value": value })
    } else {
        json!({})
    }
}

/// The output equals the recording value for value, and as JSON text.
fn check(what: &str, expected: &Value, actual: &Value) {
    let found = twin::differences(expected, actual);
    assert!(found.is_empty(), "{what}: {}", found.iter().take(8).cloned().collect::<Vec<_>>().join("; "));
    let (want, got) = (json_stringify(expected), json_stringify(actual));
    let at = want.bytes().zip(got.bytes()).position(|(a, b)| a != b);
    assert!(want == got, "{what}: the JSON text differs at byte {at:?} (recorded {} bytes, produced {})", want.len(), got.len());
}

// ---- the fake network and the index writer ---------------------------------------------------------------------------

/// Serves the recorded routes: `{ status, bodyBase64, contentLength?, etag?, conditional? }` by URL; a URL that is not
/// served fails as `fetch` does with a network error.
#[derive(Default)]
struct FakeFetch {
    routes: RefCell<Map<String, Value>>,
    requests: RefCell<Vec<Value>>,
}

impl Fetch for FakeFetch {
    fn get(&self, request: &FetchRequest<'_>) -> Result<FetchResponse, String> {
        self.requests.borrow_mut().push(json!({ "url": request.url, "ifNoneMatch": request.if_none_match }));
        let routes = self.routes.borrow();
        let Some(served) = routes.get(request.url) else { return Err("fetch failed".to_owned()) };
        let etag = served.get("etag").and_then(Value::as_str).map(str::to_owned);
        let conditional = served.get("conditional") == Some(&Value::Bool(true));
        let not_modified = conditional && request.if_none_match.is_some() && request.if_none_match == etag.as_deref();
        let status = if not_modified { 304 } else { served["status"].as_u64().expect("status") as u16 };
        let body = STANDARD.decode(served.get("bodyBase64").and_then(Value::as_str).unwrap_or_default()).expect("body");
        Ok(FetchResponse { status, content_length: served.get("contentLength").and_then(Value::as_f64).unwrap_or(0.0), etag, body })
    }
}

/// What `indexOfficeTemplates` writes when no template directory holds a template.
struct EmptyIndexer;

impl<L: mixdog_fsio::WriteLane> TemplateIndexer<L> for EmptyIndexer {
    fn index(&self, lane: &InLane<L>, env: &Environment, data_dir: &Path, config: &LibraryConfig) -> Result<Value, String> {
        let paths = library_paths(env, data_dir);
        mixdog_fsio::create_dir_all(lane, &paths.templates).map_err(|error| error.to_string())?;
        let previous = read_json(lane, &paths.template_index, json!({ "templates": [] }));
        let revision = sha256("[]");
        let changed = previous.get("revision") != Some(&Value::String(revision.clone()));
        let index = json!({
            "schemaVersion": 1,
            "indexedAt": mixdog_office_design::library::iso_string(env.now()),
            "revision": revision,
            "directories": config.template_directories,
            "templates": [],
        });
        if changed || !previous.get("revision").is_some_and(truthy) {
            write_json_atomic(lane, &paths.template_index, &index)?;
        }
        let mut answer = index;
        answer["changed"] = Value::Bool(changed);
        answer["count"] = Value::from(0);
        Ok(answer)
    }
}

// ---- the pure cases --------------------------------------------------------------------------------------------------

fn replay_pure<L: mixdog_fsio::WriteLane>(lane: &InLane<L>, world: &World, pure: &Value) {
    for case in pure["safeId"].as_array().expect("safeId") {
        let actual = attempt(&world.root, safe_id(Some(&case["input"]), "pack id").map(Value::String));
        check(&format!("safeId {}", case["input"]), &recorded(case), &actual);
    }
    for case in pure["versions"].as_array().expect("versions") {
        let (left, right) = (case["left"].as_str().expect("left"), case["right"].as_str().expect("right"));
        let actual = attempt(&world.root, compare_office_design_versions(left, right).map(|order| Value::from(order)));
        check(&format!("versions {left} {right}"), &recorded(case), &actual);
    }
    for case in pure["canonical"].as_array().expect("canonical") {
        let actual = json!({ "value": canonical_office_design_pack(&case["input"]) });
        check("canonical", &recorded(case), &actual);
    }
    for case in pure["layouts"].as_array().expect("layouts") {
        let input = &case["input"];
        let template_path = input.get("templatePath").and_then(Value::as_str).unwrap_or_default();
        let actual = attempt(&world.root, normalize_layouts(input.get("value"), template_path));
        check(&format!("layouts {input}"), &recorded(case), &actual);
    }
    for case in pure["samples"].as_array().expect("samples") {
        let actual = attempt(&world.root, normalize_local_samples(Some(&case["input"])));
        check(&format!("samples {}", case["input"]), &recorded(case), &actual);
    }
    for case in pure["verify"].as_array().expect("verify") {
        let input = &case["input"];
        let trusted = input["trustedKeys"].as_object().cloned().unwrap_or_default();
        let result = verify_office_design_pack_envelope(&input["envelope"], &trusted)
            .map(|verified| json!({ "keyId": verified.key_id, "pack": verified.pack, "envelope": verified.envelope }));
        check(&format!("verify {}", input["name"]), &recorded(case), &attempt(&world.root, result));
    }
    for case in pure["config"].as_array().expect("config") {
        replay_config(lane, world, case);
    }
    for case in pure["defaultDirectories"].as_array().expect("defaultDirectories") {
        let mut env = world.env.clone();
        let input = &case["input"];
        env.windows = input["windows"] == Value::Bool(true);
        if input.get("partial") == Some(&Value::Bool(true)) {
            env.program_files = "D:\\PF\\..\\Apps".to_owned();
            env.program_files_x86 = String::new();
            env.app_data = String::new();
            env.home = String::new();
        }
        if !env.windows {
            env.home = "/home/x".to_owned();
        }
        let directories: Vec<Value> = default_office_template_directories(&env).into_iter().skip(1).map(Value::String).collect();
        check("defaultDirectories", &json!({ "value": case["value"] }), &json!({ "value": world.root.scrub(&Value::Array(directories)) }));
    }
}

fn config_value(config: &LibraryConfig) -> Value {
    let mut out = Map::new();
    out.insert("manifestUrl".to_owned(), Value::String(config.manifest_url.clone()));
    out.insert("trustedKeys".to_owned(), Value::Object(config.trusted_keys.clone()));
    out.insert("packId".to_owned(), Value::String(config.pack_id.clone()));
    out.insert("channel".to_owned(), Value::String(config.channel.clone()));
    out.insert("checkIntervalMs".to_owned(), json_number(config.check_interval_ms));
    out.insert("templateDirectories".to_owned(), Value::Array(config.template_directories.iter().cloned().map(Value::String).collect()));
    out.insert("discoverInstalledTemplates".to_owned(), Value::Bool(config.discover_installed_templates));
    out.insert("defaultTemplates".to_owned(), Value::Object(config.default_templates.clone()));
    Value::Object(out)
}

fn remove_tree<P: WriteProof>(proof: &P, path: &Path) {
    let _ = mixdog_fsio::remove_dir_all(proof, path);
}

fn replay_config<L: mixdog_fsio::WriteLane>(lane: &InLane<L>, world: &World, case: &Value) {
    let input = &case["input"];
    let root = &world.root;
    for relative in ["cfg", "cfg2"] {
        remove_tree(lane, &world.dir.join(relative));
    }
    remove_tree(lane, &world.library_root());
    let mut env = world.env.clone();
    if let Some(Value::Object(variables)) = input.get("env") {
        for (name, value) in variables {
            let value = root.text(Some(value));
            match name.as_str() {
                "MIXDOG_OFFICE_DESIGN_LIBRARY_CONFIG" => env.library_config = value,
                "MIXDOG_OFFICE_DESIGN_PACK_URL" => env.pack_url = value,
                "MIXDOG_OFFICE_DESIGN_PACK_KEY_ID" => env.pack_key_id = value,
                "MIXDOG_OFFICE_DESIGN_PACK_PUBLIC_KEY" => env.pack_public_key = value,
                "MIXDOG_OFFICE_TEMPLATE_DIRS" => env.template_dirs = value,
                other => panic!("unknown variable {other}"),
            }
        }
    }
    let at = match input.get("fileAt") {
        Some(given) => PathBuf::from(root.text(Some(given))),
        None => library_paths(&env, &world.data_dir).config,
    };
    let file_text = match (input.get("fileText"), input.get("file")) {
        (Some(text), _) => text.as_str().map(str::to_owned),
        (None, Some(file)) => Some(json_stringify(file)),
        _ => None,
    };
    if let Some(text) = file_text {
        if let Some(parent) = at.parent() {
            mixdog_fsio::create_dir_all(lane, parent).expect("config folder");
        }
        mixdog_fsio::write(lane, &at, text).expect("config file");
    }
    let override_source = input.get("override").filter(|given| !given.is_null()).map(|given| root.unscrub(given));
    let result = load_config(lane, &env, &world.data_dir, override_source.as_ref()).map(|config| config_value(&config));
    check(&format!("config {}", input["name"]), &recorded(case), &attempt(root, result));
    for relative in ["cfg", "cfg2"] {
        remove_tree(lane, &world.dir.join(relative));
    }
    remove_tree(lane, &world.library_root());
}

// ---- the script ------------------------------------------------------------------------------------------------------------

/// Every file under the library folder: parsed JSON, else its size and digest; binding files are named by the document
/// they bind. The top level is sorted by name (the folder's own order depends on the hash of the temporary path).
fn snapshot<P: ReadProof>(proof: &P, world: &World) -> Value {
    fn walk<P: ReadProof>(proof: &P, world: &World, dir: &Path, out: &mut Vec<(String, Value)>) {
        let Ok(entries) = mixdog_fsio::read_dir(proof, dir) else { return };
        let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
        entries.sort_by_key(mixdog_fsio::DirEntry::file_name);
        for entry in entries {
            let full = entry.path();
            if entry.file_type(proof).is_ok_and(|kind| kind.is_dir()) {
                walk(proof, world, &full, out);
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let relative = full.strip_prefix(world.library_root()).expect("inside the library").to_string_lossy().replace('\\', "/");
            let bytes = mixdog_fsio::read(proof, &full).expect("read");
            let digest = || json!({ "bytes": bytes.len(), "sha256": sha256(&bytes) });
            let mut value = if name.ends_with(".json") || name.ends_with(".bak") {
                json_parse(&String::from_utf8_lossy(&bytes)).unwrap_or_else(|_| digest())
            } else {
                digest()
            };
            let mut key = relative.clone();
            if relative.starts_with("bindings/") {
                if let Some(document) = value.get("documentPath").and_then(Value::as_str).map(str::to_owned) {
                    let suffix = if name.ends_with(".bak") { ".bak" } else { "" };
                    let canonical = mixdog_office_design::library::canonical_path(&world.env, &document);
                    let expected = format!("{}.json{suffix}", sha256(canonical));
                    key = format!("bindings/{}{suffix}", world.root.scrub_text(&document));
                    if name != expected {
                        value = json!({ "misnamed": name });
                    }
                }
            }
            out.push((key, world.root.scrub(&value)));
        }
    }
    let mut collected = Vec::new();
    walk(proof, world, &world.library_root(), &mut collected);
    collected.sort_by(|a, b| a.0.cmp(&b.0));
    Value::Object(collected.into_iter().collect())
}

fn flag(step: &Value, name: &str) -> bool {
    step.get(name) == Some(&Value::Bool(true))
}

fn config_of(world: &World, step: &Value) -> Option<Value> {
    step.get("config").map(|config| world.root.unscrub(config))
}

fn replay_script<L: mixdog_fsio::WriteLane>(lane: &InLane<L>, world: &World, script: &[Value]) {
    let fetch = FakeFetch::default();
    let cx = Context { lane, env: &world.env, fetch: &fetch, indexer: &EmptyIndexer };
    let root = &world.root;
    for (position, step) in script.iter().enumerate() {
        let op = step["op"].as_str().expect("op");
        let name = step.get("name").and_then(Value::as_str).unwrap_or_default();
        let what = format!("step {position} {op} {name}");
        fetch.requests.borrow_mut().clear();
        let text_of = |key: &str| root.text(step.get(key));
        let result: Option<Result<Value, String>> = match op {
            "reset" => {
                remove_tree(lane, &world.library_root());
                None
            }
            "setClock" => {
                world.clock.store(step["ms"].as_u64().expect("ms"), Ordering::SeqCst);
                None
            }
            "setRoutes" => {
                *fetch.routes.borrow_mut() = step["routes"].as_object().cloned().expect("routes");
                None
            }
            "sync" => {
                let config = config_of(world, step);
                let options = SyncOptions {
                    data_dir: &world.data_dir,
                    config: config.as_ref(),
                    force: flag(step, "force"),
                    allow_remote: step.get("allowRemote").is_none_or(|allowed| *allowed != Value::Bool(false)),
                    index_templates: step.get("indexTemplates").is_none_or(|indexed| *indexed != Value::Bool(false)),
                };
                Some(sync_office_design_library(&cx, &options).map(|result| result.to_value()))
            }
            "snapshot" => Some(Ok(snapshot(lane, world))),
            "resolve" => {
                let config = config_of(world, step);
                let request = step.get("request").cloned().unwrap_or(Value::Null);
                let (document_path, source_path) = (text_of("documentPath"), text_of("sourcePath"));
                let input = ResolveRequest {
                    data_dir: &world.data_dir,
                    document_path: &document_path,
                    source_path: &source_path,
                    format: step["format"].as_str().expect("format"),
                    created: flag(step, "created"),
                    request: &request,
                    config: config.as_ref(),
                };
                Some(resolve_office_design_library(&cx, &input))
            }
            "persistBinding" => {
                let binding = step.get("binding").cloned().unwrap_or(Value::Null);
                Some(persist_office_design_binding(lane, &world.env, &world.data_dir, &text_of("documentPath"), &binding).map(|record| record.unwrap_or(Value::Null)))
            }
            "recordHistory" => {
                let document_path = text_of("documentPath");
                let ids = step.get("compositionIds").cloned().unwrap_or(Value::Null);
                let field = |key: &str| step.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
                let (format, profile, purpose, mode, fingerprint) = (field("format"), field("profile"), field("purpose"), field("expressionMode"), field("fingerprint"));
                let record = CompositionRecord {
                    document_path: &document_path,
                    format: &format,
                    profile: &profile,
                    purpose: &purpose,
                    expression_mode: &mode,
                    fingerprint: &fingerprint,
                    composition_ids: &ids,
                };
                Some(record_office_composition_history(lane, &world.env, &world.data_dir, &record))
            }
            "readHistory" => {
                let limit = to_number_of(step.get("limit"));
                let format = step.get("format").and_then(Value::as_str).unwrap_or_default();
                let records = read_office_composition_history(lane, &world.env, &world.data_dir, format, limit, &text_of("excludeDocumentPath"));
                Some(Ok(Value::Array(records)))
            }
            "inspect" => {
                let config = config_of(world, step);
                Some(inspect_office_design_library(lane, &world.env, &world.data_dir, config.as_ref()))
            }
            "remove" => {
                let target = world.library_root().join(step["relative"].as_str().expect("relative"));
                remove_tree(lane, &target);
                let _ = mixdog_fsio::remove_file(lane, &target);
                None
            }
            "historyLength" => {
                let history = read_json(lane, &library_paths(&world.env, &world.data_dir).composition_history, Value::Null);
                Some(Ok(Value::from(history["records"].as_array().map_or(0, Vec::len))))
            }
            "writeDamaged" => {
                mixdog_fsio::write(lane, library_paths(&world.env, &world.data_dir).composition_history, "{\"records\": 5}").expect("damage");
                None
            }
            other => panic!("unknown op {other}"),
        };
        if let Some(result) = result {
            let mut actual = attempt(root, result);
            let mut expected = recorded(step);
            if op == "snapshot" {
                // The folder's own order is not the recording's; the entries are compared sorted.
                expected = json!({ "value": sorted(&expected["value"]) });
                actual = json!({ "value": sorted(&actual["value"]) });
            }
            check(&what, &expected, &actual);
        }
        let seen = Value::Array(fetch.requests.borrow().clone());
        check(&format!("{what} requests"), step.get("requests").unwrap_or(&json!([])), &seen);
    }
}

/// An object with its keys sorted by name.
fn sorted(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            Value::Object(entries.into_iter().map(|(key, item)| (key.clone(), item.clone())).collect())
        }
        other => other.clone(),
    }
}

#[test]
fn every_output_equals_the_recording() {
    let golden = golden();
    on_lane(move |lane| {
        let dir = tempfile::tempdir().expect("temporary folder");
        #[cfg(not(windows))]
        let path = mixdog_fsio::canonicalize(lane, dir.path()).expect("real path");
        #[cfg(windows)]
        let path = dir.path().to_path_buf();
        let world = World::new(&path);
        replay_pure(lane, &world, &golden["pure"]);
        replay_script(lane, &world, golden["script"].as_array().expect("script"));
    });
}

/// Records again with Node and compares: `cargo test -p mixdog-office-design --test twin_library -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/design/library)"]
fn twin_live_library() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-library.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_output_equals_the_recording();
}
