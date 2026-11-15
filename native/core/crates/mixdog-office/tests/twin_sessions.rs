//! Twin test `sessions`: the recording of Node's session part of `core/office-core.mjs`
//! (`native/core/fixtures/office-sessions/golden.json`, written by `benchmarks/rust-core/recorders/record-office-sessions.mjs`)
//! against `mixdog_office::session`.
//!
//! The recording is a script run against one data directory: the pure helpers (`emptyOfficeDesignState`,
//! `microsoftOfficeOpenFields`, `mergeOfficeDesignRequest`), `resolveOfficeDesignContext`, sessions opened, bound to a
//! design (`ensureOfficeSessionDesign`) and registered, the sessions map and the document index after each registry step,
//! and the binding files the design library wrote. Every output equals the recording value for value and as JSON text. The
//! library has no pack server and no template directory (the script writes that config), the clock is the recording's, and
//! paths are compared with the temporary folder written `<root>` and `/` as the separator. Re-recording is
//! `twin_live_sessions` (ignored: it runs Node).
//!
//! The template index writer is a later port (`nr-office-design-templates`); with no template directory it writes an
//! index of nothing, which `EmptyIndexer` writes too.

use mixdog_rt::LaneToken;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use mixdog_fsio::{ReadProof, WriteLane};
use mixdog_js::{json_parse, json_stringify};
use mixdog_office::session::registry::lock;
use mixdog_office::session::{
    Backend, DesignState, EnsureOptions, Mode, Registry, Session, SessionHandle, SessionInit, ensure_office_session_design, merge_office_design_request,
    resolve_office_design_context,
};
use mixdog_office_base::twin;
use mixdog_office_base::values::{sha256, truthy};
use mixdog_office_design::library::{
    Context, Environment, Fetch, FetchRequest, FetchResponse, LibraryConfig, TemplateIndexer, canonical_path, iso_string, library_paths, read_json,
    write_json_atomic,
};
use mixdog_rt::{CancellationToken, DurabilityIo, InLane};
use serde_json::{Value, json};

fn golden() -> Value {
    twin::load_golden("office-sessions")
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

struct World {
    folder: String,
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
        Self { folder: dir.to_string_lossy().into_owned(), data_dir: dir.join("data"), clock, env }
    }

    fn library_root(&self) -> PathBuf {
        self.data_dir.join("office").join("design-library")
    }

    /// A text with the folder as `<root>` and `/` as the separator.
    fn scrub_text(&self, text: &str) -> String {
        text.replace(&self.folder, "<root>").replace('\\', "/")
    }

    /// A key of the document index: the resolved path in lower case, so the folder is found in lower case too.
    fn scrub_key(&self, text: &str) -> String {
        self.scrub_text(&text.replace(&self.folder.to_lowercase(), &self.folder))
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
            Value::String(text) => Value::String(text.replace("<root>", &self.folder)),
            Value::Array(items) => Value::Array(items.iter().map(|item| self.unscrub(item)).collect()),
            Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), self.unscrub(item))).collect()),
            other => other.clone(),
        }
    }

    fn text(&self, value: Option<&Value>) -> String {
        value.and_then(Value::as_str).map(|text| text.replace("<root>", &self.folder)).unwrap_or_default()
    }
}

/// `{ value }` / `{ error }` of an attempt, written against the folder.
fn attempt(world: &World, result: Result<Value, String>) -> Value {
    match result {
        Ok(value) => json!({ "value": world.scrub(&value) }),
        Err(error) => json!({ "error": world.scrub_text(&error) }),
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

// ---- no network, no templates -------------------------------------------------------------------------------------------

/// The script configures no pack server, so nothing is asked of the network.
struct NoNetwork;

impl Fetch for NoNetwork {
    fn get(&self, request: &FetchRequest<'_>) -> Result<FetchResponse, String> {
        Err(format!("the script has no network: {}", request.url))
    }
}

/// What `indexOfficeTemplates` writes when no template directory holds a template.
struct EmptyIndexer;

impl<L: WriteLane> TemplateIndexer<L> for EmptyIndexer {
    fn index(&self, lane: &InLane<L>, env: &Environment, data_dir: &Path, config: &LibraryConfig) -> Result<Value, String> {
        let paths = library_paths(env, data_dir);
        mixdog_fsio::create_dir_all(lane, &paths.templates).map_err(|error| error.to_string())?;
        let previous = read_json(lane, &paths.template_index, json!({ "templates": [] }));
        let revision = sha256("[]");
        let changed = previous.get("revision") != Some(&Value::String(revision.clone()));
        let index = json!({
            "schemaVersion": 1,
            "indexedAt": iso_string(env.now()),
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

// ---- the script ----------------------------------------------------------------------------------------------------------

/// Every file under the library folder: parsed JSON, else its size and digest; binding files are named by the document they
/// bind.
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
                    let expected = format!("{}.json{suffix}", sha256(canonical_path(&world.env, &document)));
                    key = format!("bindings/{}{suffix}", world.scrub_text(&document));
                    if name != expected {
                        value = json!({ "misnamed": name });
                    }
                }
            }
            out.push((key, world.scrub(&value)));
        }
    }
    let mut collected = Vec::new();
    walk(proof, world, &world.library_root(), &mut collected);
    collected.sort_by(|a, b| a.0.cmp(&b.0));
    Value::Object(collected.into_iter().collect())
}

/// What a session shows of its design binding.
fn bound(session: &Session) -> Value {
    json!({
        "designRequest": session.design_request.clone().unwrap_or(Value::Null),
        "designLibrary": session.design_library.clone().unwrap_or(Value::Null),
        "design": session.design.clone().unwrap_or(Value::Null),
        "designState": session.design_state.to_value(),
    })
}

fn registry_state(world: &World, registry: &Registry) -> Value {
    let documents: Vec<Value> = registry.documents().into_iter().map(|(key, id)| json!([world.scrub_key(&key), id])).collect();
    json!({ "sessions": registry.ids(), "documents": documents })
}

fn flag(step: &Value, name: &str) -> bool {
    step.get(name) == Some(&Value::Bool(true))
}

fn replay_script<L: WriteLane>(lane: &InLane<L>, world: &World, script: &[Value]) {
    let indexer = EmptyIndexer;
    let cx = Context { lane, env: &world.env, fetch: &NoNetwork, indexer: &indexer };
    let registry = Registry::new();
    let mut named: HashMap<String, SessionHandle> = HashMap::new();
    for (position, step) in script.iter().enumerate() {
        let op = step["op"].as_str().expect("op");
        let name = step.get("name").and_then(Value::as_str).unwrap_or_default();
        let what = format!("step {position} {op} {name}");
        let session = |named: &HashMap<String, SessionHandle>| Arc::clone(named.get(name).unwrap_or_else(|| panic!("{what}: no session named {name}")));
        let result: Result<Value, String> = match op {
            "writeConfig" => {
                let root = world.library_root();
                mixdog_fsio::create_dir_all(lane, &root).expect("library folder");
                mixdog_fsio::write(lane, root.join("config.json"), json_stringify(&step["config"])).expect("config file");
                Ok(Value::Null)
            }
            "setClock" => {
                world.clock.store(step["ms"].as_u64().expect("ms"), Ordering::SeqCst);
                Ok(Value::Null)
            }
            "emptyState" => {
                let include = step.get("includeSlidePlans") != Some(&Value::Bool(false));
                Ok(DesignState::empty(flag(step, "requiresVisualReview"), include).to_value())
            }
            "comFields" => Ok(mixdog_office::session::microsoft_office_open_fields(&step["opened"])),
            "merge" => Ok(merge_office_design_request(step.get("current"), step.get("next"))),
            "context" => {
                let args = world.unscrub(&step["args"]);
                let (target, source) = (world.text(step.get("target")), world.text(step.get("source")));
                let format = step["format"].as_str().expect("format");
                resolve_office_design_context(&cx, &world.data_dir, &args, &target, &source, format, flag(step, "created")).map(|context| context.to_value())
            }
            "open" => {
                let text = |key: &str| world.text(step.get(key));
                let opened = Session::new(SessionInit {
                    id: text("id"),
                    source: text("source"),
                    target: text("target"),
                    file_kind: text("fileKind"),
                    format: text("format"),
                    mode: Mode::parse(&text("mode")).expect("mode"),
                    backend: Backend::parse(&text("backend")).expect("backend"),
                    opened_at: iso_string(world.env.now()),
                    data_dir: world.data_dir.clone(),
                    created: flag(step, "created"),
                    created_new_file: step.get("createdNewFile").and_then(Value::as_bool),
                    design_state: DesignState::default(),
                });
                let answer = json!({ "openedAt": opened.opened_at });
                named.insert(name.to_owned(), Arc::new(std::sync::Mutex::new(opened)));
                Ok(answer)
            }
            "ensure" => {
                let handle = session(&named);
                let options = EnsureOptions {
                    created: step["options"].get("created").and_then(Value::as_bool),
                    allow_library_upgrade: flag(&step["options"], "allowLibraryUpgrade"),
                    preserve_native_design: flag(&step["options"], "preserveNativeDesign"),
                };
                let args = world.unscrub(&step["args"]);
                let mut held = lock(&handle);
                let outcome = ensure_office_session_design(&cx, &world.data_dir, &mut held, &args, options);
                outcome.map(|()| bound(&held))
            }
            "register" => {
                let handle = session(&named);
                registry.register_handle(&cx, &handle);
                Ok(bound(&lock(&handle)))
            }
            "index" => {
                registry.index(&world.env, &session(&named));
                Ok(registry_state(world, &registry))
            }
            "release" => {
                registry.release(&world.env, &session(&named));
                Ok(registry_state(world, &registry))
            }
            "forDocument" => {
                let found = registry.for_document(&world.env, &world.text(step.get("target")));
                Ok(found.map_or(Value::Null, |handle| Value::String(lock(&handle).id.clone())))
            }
            "registry" => Ok(registry_state(world, &registry)),
            "snapshot" => Ok(snapshot(lane, world)),
            other => panic!("unknown op {other}"),
        };
        check(&what, &recorded(step), &attempt(world, result));
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
        let script = golden["script"].as_array().expect("script");
        replay_script(lane, &world, script);
    });
}

/// Records again with Node and compares: `cargo test -p mixdog-office --test twin_sessions -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/core/office-core.mjs)"]
fn twin_live_sessions() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-sessions.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_output_equals_the_recording();
}
