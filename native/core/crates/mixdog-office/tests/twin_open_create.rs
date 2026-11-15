//! Twin test `open_create`: the recording of Node's open and create part of `core/office-sessions.mjs`
//! (`native/core/fixtures/office-open-create/golden.json`, written by `benchmarks/rust-core/recorders/record-office-open-create.mjs`)
//! against `mixdog_office::session::{mode, open, create, working_copy}`.
//!
//! The recording is a script run against one folder of documents, one data directory and one session registry: `selectMode`,
//! `openSession` (reads, edits, working copies, a second open of the same path, a legacy binary file, Microsoft Office),
//! `createSession` (every format, the refusals, overwriting, Microsoft Office), `createAuthoredSession`,
//! `registerHtmlPdfSession`, `resolveSession` and `materializeWorkingCopy`. Every step's answer (a session as the fields of its
//! record, or the error message), what the Microsoft Office host was asked, what changed under the documents folder (a package
//! by its parts: the bytes of a package differ with the compressor) and the registry afterwards equal the recording. Microsoft
//! Office is a scripted host that gives the recorded answers; the converter of legacy files answers what LibreOffice's driver
//! answers when LibreOffice is not installed. Paths are compared with the temporary folder written `<root>` and `/` as the
//! separator, session ids as the name the script gave the session. Re-recording is `twin_live_open_create` (ignored: it runs
//! Node). The recording is of Windows paths.

#![cfg(windows)]

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::task::Poll;

use mixdog_fsio::ReadProof;
use mixdog_js::{JsRegex, json_stringify};
use mixdog_office::session::create::{
    CreateTools, create_authored_session, create_session, register_html_pdf_session,
    remove_failed_create,
};
use mixdog_office::session::mode::{OfficeHost, select_mode};
use mixdog_office::session::open::{
    LegacyConverter, OpenedSession, SessionCloser, SessionEnv, open_session, resolve_session,
};
use mixdog_office::session::registry::lock;
use mixdog_office::session::working_copy::materialize_working_copy;
use mixdog_office::session::{Backend, Registry, SessionHandle};
use mixdog_office_base::twin;
use mixdog_office_base::values::{sha256, truthy};
use mixdog_office_base::write_note::NoWriteNote;
use mixdog_office_design::library::{
    Context, Environment, Fetch, FetchRequest, FetchResponse, LibraryConfig, TemplateIndexer,
    iso_string, library_paths, read_json, write_json_atomic,
};
use mixdog_ooxml::package::load_package;
use mixdog_pdf::embed::FontEnv;
use mixdog_raster::svg::SvgFonts;
use mixdog_rt::{CancellationToken, DurabilityIo, InLane, LaneToken};
use serde_json::{Map, Value, json};

fn golden() -> Value {
    twin::load_golden("office-open-create")
}

/// Runs `job` as a durability-lane job (the inline test backend runs it on this thread).
fn on_lane<R: Send + 'static>(job: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> R {
    let lanes = mixdog_rt::testing::tokens();
    tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("runtime")
        .block_on(async {
            lanes
                .durability_io
                .submit(&CancellationToken::new(), job)
                .expect("submit")
                .await
                .expect("job")
        })
}

/// The answer of a future whose host answers at once.
fn ready<T>(future: impl Future<Output = T>) -> T {
    let mut future = std::pin::pin!(future);
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    match future.as_mut().poll(&mut cx) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("the scripted host answers at once"),
    }
}

// ---- no network, no templates ---------------------------------------------------------------------------------------------

struct NoNetwork;

impl Fetch for NoNetwork {
    fn get(&self, request: &FetchRequest<'_>) -> Result<FetchResponse, String> {
        Err(format!("the script has no network: {}", request.url))
    }
}

/// What `indexOfficeTemplates` writes when no template directory holds a template.
struct EmptyIndexer;

impl<P: mixdog_fsio::WriteProof> TemplateIndexer<P> for EmptyIndexer {
    fn index(
        &self,
        lane: &P,
        env: &Environment,
        data_dir: &Path,
        config: &LibraryConfig,
    ) -> Result<Value, String> {
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

// ---- the scripted host, converter and closer -----------------------------------------------------------------------------

/// Microsoft Office as the step scripts it: whether it runs here, the answer to `detect`, the answer to opening a session.
struct ScriptedHost {
    supported: bool,
    detect: Value,
    open: Value,
    seen: RefCell<Vec<Value>>,
}

impl ScriptedHost {
    fn of(step: &Value) -> Self {
        let scripted = step.get("host").cloned().unwrap_or(Value::Null);
        let unscripted = json!({ "ok": false, "error": "no answer scripted" });
        Self {
            supported: scripted.get("supported") == Some(&json!(true)),
            detect: scripted
                .get("detect")
                .cloned()
                .unwrap_or_else(|| unscripted.clone()),
            open: scripted.get("open").cloned().unwrap_or(unscripted),
            seen: RefCell::new(Vec::new()),
        }
    }
}

impl OfficeHost for ScriptedHost {
    fn supported(&self) -> bool {
        self.supported
    }

    fn detect(&self, format: &str, path: &str) -> impl Future<Output = Value> {
        self.seen
            .borrow_mut()
            .push(json!({ "call": "detect", "format": format, "path": path }));
        let answer = self.detect.clone();
        async move { answer }
    }

    fn open_session(
        &self,
        payload: &Value,
        _cancel: Option<&CancellationToken>,
    ) -> impl Future<Output = Value> {
        let mut request = payload.clone();
        request["session"] = json!("<session>");
        self.seen
            .borrow_mut()
            .push(json!({ "call": "open", "payload": request }));
        let answer = self.open.clone();
        async move { answer }
    }
}

/// LibreOffice's driver without LibreOffice: the refusal it gives (the ooxml crate's own twin covers the driver).
struct NoLibreOffice;

impl LegacyConverter for NoLibreOffice {
    fn convert(&self, path: &Path, output: &Path) -> Result<(), String> {
        Err(format!(
            "{} is a legacy binary file, not an Office package, and converting it needs LibreOffice. Install the Office feature in Mixdog settings (it installs LibreOffice), or open it in Microsoft Office and save it as {}.",
            path.display(),
            output.display()
        ))
    }
}

/// The finalize stage's close of a portable session: the session is released.
struct ReleasingCloser<'a> {
    registry: &'a Registry,
    env: &'a Environment,
}

impl SessionCloser for ReleasingCloser<'_> {
    fn close(&self, handle: &SessionHandle) -> impl Future<Output = Result<(), String>> {
        self.registry.release(self.env, handle);
        async { Ok(()) }
    }
}

// ---- the world ---------------------------------------------------------------------------------------------------------------

struct World {
    root: String,
    docs: PathBuf,
    data_dir: PathBuf,
    env: Environment,
    names: RefCell<Vec<(String, String)>>,
    anonymous: RefCell<usize>,
    /// The latest answer under each name: Node kept the object an open answered (a reused one is a copy that says `reused`), and a
    /// later materialize of that name answered the same object.
    held: RefCell<BTreeMap<String, (SessionHandle, bool)>>,
    fixtures: RefCell<Vec<(String, String)>>,
    last_files: RefCell<BTreeMap<String, Value>>,
}

impl World {
    fn new(root: &Path) -> Self {
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
            cwd: root.to_path_buf(),
            bundled_templates: PathBuf::from("<bundled>"),
            now_ms: Arc::new(|| 1_700_000_000_000.0),
        };
        Self {
            root: root.to_string_lossy().into_owned(),
            docs: root.join("docs"),
            data_dir: root.join("data"),
            env,
            names: RefCell::new(Vec::new()),
            anonymous: RefCell::new(0),
            held: RefCell::new(BTreeMap::new()),
            fixtures: RefCell::new(Vec::new()),
            last_files: RefCell::new(BTreeMap::new()),
        }
    }

    /// `nameOf(session, as)`: the name the script gave a session, given on first sight.
    fn name_of(&self, id: &str, given: Option<&str>) -> String {
        if let Some((_, name)) = self.names.borrow().iter().find(|(known, _)| known == id) {
            return name.clone();
        }
        let name = given.map_or_else(
            || {
                *self.anonymous.borrow_mut() += 1;
                format!("unnamed {}", self.anonymous.borrow())
            },
            str::to_owned,
        );
        self.names.borrow_mut().push((id.to_owned(), name.clone()));
        name
    }

    fn id_named(&self, name: &str) -> Option<String> {
        self.names
            .borrow()
            .iter()
            .find(|(_, held)| held == name)
            .map(|(id, _)| id.clone())
    }

    /// `scrubText`: session ids as their names, the folder as `<root>`, `/` as the separator.
    fn scrub_text(&self, text: &str) -> String {
        let mut out = text.to_owned();
        for (id, name) in self.names.borrow().iter() {
            out = out.replace(id.as_str(), &format!("<session:{name}>"));
        }
        let ids = JsRegex::new_static(r"office_[0-9a-f]{16}", "g");
        out = ids.replace_all_with(&out, |_| "<session>".to_owned());
        out.replace(&self.root, "<root>").replace('\\', "/")
    }

    /// A key of the document index: the resolved path in lower case, so the folder is found in lower case too.
    fn scrub_key(&self, text: &str) -> String {
        self.scrub_text(&text.replace(&self.root.to_lowercase(), &self.root))
    }

    fn scrub(&self, value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.scrub_text(text)),
            Value::Array(items) => {
                Value::Array(items.iter().map(|item| self.scrub(item)).collect())
            }
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(key, item)| (key.clone(), self.scrub(item)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    /// `unscrub`: `<session:name>` as the id, `<root>` as the folder, with the host's separator once a path has the folder in it.
    fn unscrub_text(&self, text: &str) -> String {
        let named = JsRegex::new_static(r"<session:([^>]+)>", "g");
        let mut out = named.replace_all_with(text, |found| {
            self.id_named(found.get(1).unwrap_or_default())
                .unwrap_or_else(|| "<unknown session>".to_owned())
        });
        out = out.replace("<root>", &self.root);
        let rooted = format!("{}/", self.root);
        if out.contains(&rooted) {
            out = out
                .replace(&rooted, &format!("{}\\", self.root))
                .replace('/', "\\");
        }
        out
    }

    fn unscrub(&self, value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.unscrub_text(text)),
            Value::Array(items) => {
                Value::Array(items.iter().map(|item| self.unscrub(item)).collect())
            }
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(key, item)| (key.clone(), self.unscrub(item)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }
}

/// The value with every object's keys in order.
fn sorted(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
        Value::Object(map) => {
            let ordered: BTreeMap<&String, &Value> = map.iter().collect();
            Value::Object(
                ordered
                    .into_iter()
                    .map(|(key, item)| (key.clone(), sorted(item)))
                    .collect(),
            )
        }
        other => other.clone(),
    }
}

fn canonical(value: &Value) -> String {
    json_stringify(&sorted(value))
}

/// `project(session, as)`: a session as the fields of its record that the recording keeps.
fn project(world: &World, opened: &OpenedSession, given: Option<&str>) -> Value {
    let session = lock(&opened.handle);
    let mut out = Map::new();
    out.insert(
        "session".to_owned(),
        json!(world.name_of(&session.id, given)),
    );
    world.held.borrow_mut().insert(
        world.name_of(&session.id, given),
        (Arc::clone(&opened.handle), opened.reused),
    );
    out.insert("source".to_owned(), json!(session.source));
    out.insert("target".to_owned(), json!(session.target));
    out.insert("fileKind".to_owned(), json!(session.file_kind));
    out.insert("format".to_owned(), json!(session.format));
    out.insert("mode".to_owned(), json!(session.mode.as_str()));
    out.insert("backend".to_owned(), json!(session.backend.as_str()));
    out.insert("created".to_owned(), json!(session.created));
    if let Some(new_file) = session.created_new_file {
        out.insert("createdNewFile".to_owned(), json!(new_file));
    }
    out.insert(
        "snapshotVersion".to_owned(),
        json!(session.snapshot_version),
    );
    if let Some(request) = &session.design_request {
        out.insert("designRequest".to_owned(), request.clone());
    }
    out.insert("designState".to_owned(), session.design_state.to_value());
    if let Some(ownership) = &session.com.ownership {
        out.insert("ownership".to_owned(), json!(ownership));
    }
    if let Some(visible) = session.com.visible {
        out.insert("visible".to_owned(), json!(visible));
    }
    for (name, value) in [
        ("appPid", &session.com.app_pid),
        ("windowHwnd", &session.com.window_hwnd),
        ("documentId", &session.com.document_id),
    ] {
        if let Some(value) = value {
            out.insert(name.to_owned(), value.clone());
        }
    }
    if session.backend == Backend::MicrosoftOfficeCom {
        out.insert(
            "foregroundActivated".to_owned(),
            json!(session.com.foreground_activated),
        );
        out.insert(
            "backgroundIsolation".to_owned(),
            session
                .com
                .background_isolation
                .clone()
                .unwrap_or(Value::Null),
        );
    }
    if session.reads_source {
        out.insert("readsSource".to_owned(), json!(true));
    }
    if !session.converted_from.is_empty() {
        out.insert("convertedFrom".to_owned(), json!(session.converted_from));
    }
    if let Some(receipt) = &session.create_receipt {
        out.insert("createReceipt".to_owned(), receipt.clone());
    }
    if session.authored.authored {
        out.insert("authored".to_owned(), json!(true));
    }
    if opened.reused {
        out.insert("reused".to_owned(), json!(true));
    }
    world.scrub(&Value::Object(out))
}

fn registry_state(world: &World, registry: &Registry) -> Value {
    let sessions: Vec<Value> = registry
        .ids()
        .iter()
        .map(|id| json!(world.name_of(id, None)))
        .collect();
    let documents: Vec<Value> = registry
        .documents()
        .iter()
        .map(|(key, id)| {
            json!([
                world.scrub_key(key),
                world
                    .names
                    .borrow()
                    .iter()
                    .find(|(known, _)| known == id)
                    .map_or("<unknown>", |(_, name)| name.as_str())
            ])
        })
        .collect();
    json!({ "sessions": sessions, "documents": documents })
}

/// What a file under the documents folder is, as the recording describes it.
fn describe_file<P: ReadProof>(proof: &P, world: &World, path: &Path) -> Value {
    let bytes = mixdog_fsio::read(proof, path).expect("read a document");
    let mut value = if bytes.starts_with(b"PK") {
        let package = load_package(proof, path).expect("a package");
        let mut parts: Vec<String> = package
            .entries()
            .into_iter()
            .filter(|entry| !entry.dir)
            .map(|entry| entry.name.clone())
            .collect();
        parts.sort();
        json!({ "kind": "zip", "parts": parts })
    } else if bytes.starts_with(b"%PDF-") {
        json!({ "kind": "pdf" })
    } else {
        json!({ "kind": "bytes", "length": bytes.len(), "sha256": sha256(&bytes) })
    };
    let digest = sha256(&bytes);
    if let Some((name, _)) = world
        .fixtures
        .borrow()
        .iter()
        .find(|(_, known)| *known == digest)
    {
        value["sameAs"] = json!(name);
    }
    value
}

fn describe_files<P: ReadProof>(proof: &P, world: &World) -> BTreeMap<String, Value> {
    fn walk<P: ReadProof>(proof: &P, world: &World, dir: &Path, out: &mut BTreeMap<String, Value>) {
        let Ok(entries) = mixdog_fsio::read_dir(proof, dir) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            let full = entry.path();
            if entry.file_type(proof).is_ok_and(|kind| kind.is_dir()) {
                walk(proof, world, &full, out);
                continue;
            }
            let relative = full
                .strip_prefix(&world.docs)
                .expect("under the documents folder")
                .to_string_lossy()
                .into_owned();
            out.insert(
                relative.replace('\\', "/"),
                describe_file(proof, world, &full),
            );
        }
    }
    let mut out = BTreeMap::new();
    walk(proof, world, &world.docs, &mut out);
    out
}

/// What changed since the step before: a file that is new or differs, `null` for one that is gone.
fn files_changed(world: &World, now: BTreeMap<String, Value>) -> Value {
    let mut last = world.last_files.borrow_mut();
    let mut changed = Map::new();
    for (name, value) in &now {
        if last.get(name).map(canonical) != Some(canonical(value)) {
            changed.insert(name.clone(), value.clone());
        }
    }
    for name in last.keys() {
        if !now.contains_key(name) {
            changed.insert(name.clone(), Value::Null);
        }
    }
    *last = now;
    Value::Object(changed)
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .map(|at| u8::from_str_radix(&text[at * 2..at * 2 + 2], 16).expect("hex byte"))
        .collect()
}

// ---- the replay ------------------------------------------------------------------------------------------------------------

fn replay<P: mixdog_fsio::WriteProof>(lane: &P, world: &World, script: &[Value]) {
    let indexer = EmptyIndexer;
    let cx = Context {
        lane,
        env: &world.env,
        fetch: &NoNetwork,
        indexer: &indexer,
    };
    let registry = Registry::new();
    let closer = ReleasingCloser {
        registry: &registry,
        env: &world.env,
    };
    let fonts = FontEnv::default();
    let svg_fonts = SvgFonts::none();
    let tools = CreateTools {
        closer: &closer,
        fonts: &fonts,
        svg_fonts: &svg_fonts,
    };
    let cwd = world.docs.to_string_lossy().into_owned();
    for (number, step) in script.iter().enumerate() {
        let op = step["op"].as_str().expect("op");
        let at = format!("step {number} ({op})");
        let host = ScriptedHost::of(step);
        let env = SessionEnv {
            design: &cx,
            note: &NoWriteNote,
            registry: &registry,
            host: &host,
            legacy: &NoLibreOffice,
            data_dir: &world.data_dir,
            cwd: &cwd,
            cancel: None,
        };
        let args = world.unscrub(step.get("args").unwrap_or(&Value::Null));
        let given = step.get("as").and_then(Value::as_str);
        let read_only = step.get("readOnly") == Some(&json!(true));
        let outcome: Result<Value, String> = match op {
            "file" => {
                let name = step["name"].as_str().expect("name");
                let bytes = unhex(step["result"]["hex"].as_str().expect("hex"));
                let path = world.docs.join(name);
                mixdog_fsio::create_dir_all(lane, path.parent().expect("a folder")).expect("folder");
                mixdog_fsio::write(lane, &path, &bytes).expect("write a fixture");
                let mut fixtures = world.fixtures.borrow_mut();
                match fixtures.iter_mut().find(|(known, _)| known == name) {
                    Some(entry) => entry.1 = sha256(&bytes),
                    None => fixtures.push((name.to_owned(), sha256(&bytes))),
                }
                Ok(step["result"].clone())
            }
            "select" => ready(select_mode(&host, step.get("requested"), step["format"].as_str().expect("format"), step["source"].as_str().map(|source| world.unscrub_text(source)).as_deref().unwrap_or_default()))
                .map(|selected| json!({ "backend": selected.backend.as_str(), "mode": selected.mode.as_str() })),
            "open" => ready(open_session(&env, &args, read_only)).map(|opened| project(world, &opened, given)),
            "create" => ready(create_session(&env, &tools, &args)).map(|created| project(world, &created.session, given)),
            "author" => {
                let target = world.unscrub_text(step["target"].as_str().expect("target"));
                ready(create_authored_session(&env, &args, &target)).map(|handle| project(world, &OpenedSession { handle, reused: false }, given))
            }
            "htmlPdf" => {
                let target = world.unscrub_text(step["target"].as_str().expect("target"));
                register_html_pdf_session(&env, &args, &target, step["targetExisted"] == json!(true), step["receipt"].clone())
                    .map(|handle| project(world, &OpenedSession { handle, reused: false }, given))
            }
            "resolve" => ready(resolve_session(&env, &args, read_only)).map(|resolved| {
                let mut shown = project(world, &resolved.opened, given);
                shown["implicit"] = json!(resolved.implicit);
                shown
            }),
            "materialize" => {
                let (handle, reused) = world.held.borrow().get(step["session"].as_str().expect("session")).cloned().expect("a held session");
                materialize_working_copy(lane, &NoWriteNote, &world.env, &registry, &handle).map(|target| {
                    let name = world.name_of(&lock(&handle).id, None);
                    json!({ "target": world.scrub_text(&target), "session": project(world, &OpenedSession { handle: Arc::clone(&handle), reused }, Some(&name)) })
                })
            }
            other => panic!("unknown op {other}"),
        };
        match (outcome, step.get("error").and_then(Value::as_str)) {
            (Ok(produced), None) => {
                let expected = &step["result"];
                // A fixture's bytes were what the recording wrote; the answer of a `select` or a session is compared as JSON.
                assert_eq!(
                    canonical(&produced),
                    canonical(expected),
                    "{at}: the answer"
                );
            }
            (Ok(produced), Some(error)) => panic!(
                "{at}: Node failed with {error}, this answered {}",
                canonical(&produced)
            ),
            (Err(message), None) => panic!(
                "{at}: Node answered {}, this failed with {}",
                canonical(&step["result"]),
                world.scrub_text(&message)
            ),
            (Err(message), Some(error)) => {
                assert_eq!(world.scrub_text(&message), error, "{at}: the error")
            }
        }
        let seen: Vec<Value> = host
            .seen
            .borrow()
            .iter()
            .map(|request| sorted(&world.scrub(request)))
            .collect();
        assert_eq!(
            canonical(&Value::Array(seen)),
            canonical(&step["seen"]),
            "{at}: what the Microsoft Office host was asked"
        );
        let files = files_changed(world, describe_files(lane, world));
        assert_eq!(
            canonical(&files),
            canonical(&step["files"]),
            "{at}: the files that changed"
        );
        assert_eq!(
            canonical(&registry_state(world, &registry)),
            canonical(&step["registry"]),
            "{at}: the registry"
        );
    }
}

#[test]
fn every_answer_equals_the_recording() {
    let golden = golden();
    on_lane(move |lane| {
        let dir = tempfile::tempdir().expect("temporary folder");
        let world = World::new(dir.path());
        mixdog_fsio::create_dir_all(lane, &world.docs).expect("documents folder");
        let library = world.data_dir.join("office").join("design-library");
        mixdog_fsio::create_dir_all(lane, &library).expect("library folder");
        mixdog_fsio::write(
            lane,
            library.join("config.json"),
            r#"{"templateDirectories":[],"discoverInstalledTemplates":false}"#,
        )
        .expect("config file");
        replay(lane, &world, golden["script"].as_array().expect("script"));
    });
}

fn there(lane: &impl ReadProof, path: &Path) -> bool {
    mixdog_fsio::exists(lane, path).expect("a file check")
}

/// A create whose own operations failed must not leave the empty file it just wrote; a file that was there stays.
#[test]
fn a_failed_create_removes_only_the_file_it_wrote() {
    on_lane(|lane| {
        let dir = tempfile::tempdir().expect("temporary folder");
        let world = World::new(dir.path());
        mixdog_fsio::create_dir_all(lane, &world.docs).expect("documents folder");
        let indexer = EmptyIndexer;
        let cx = Context {
            lane,
            env: &world.env,
            fetch: &NoNetwork,
            indexer: &indexer,
        };
        let registry = Registry::new();
        let closer = ReleasingCloser {
            registry: &registry,
            env: &world.env,
        };
        let (fonts, svg_fonts) = (FontEnv::default(), SvgFonts::none());
        let tools = CreateTools {
            closer: &closer,
            fonts: &fonts,
            svg_fonts: &svg_fonts,
        };
        let host = ScriptedHost::of(&Value::Null);
        let cwd = world.docs.to_string_lossy().into_owned();
        let env = SessionEnv {
            design: &cx,
            note: &NoWriteNote,
            registry: &registry,
            host: &host,
            legacy: &NoLibreOffice,
            data_dir: &world.data_dir,
            cwd: &cwd,
            cancel: None,
        };
        let fresh = world.docs.join("fresh.csv");
        let created = ready(create_session(
            &env,
            &tools,
            &json!({ "path": "fresh.csv" }),
        ))
        .expect("a created file")
        .session;
        assert!(there(lane, &fresh));
        remove_failed_create(lane, &created, true);
        assert!(
            there(lane, &fresh),
            "a create whose edit settled keeps its file"
        );
        remove_failed_create(lane, &created, false);
        assert!(
            !there(lane, &fresh),
            "a failed create removes the file it wrote"
        );
        let kept = world.docs.join("kept.csv");
        mixdog_fsio::write(lane, &kept, b"a,b\r\n").expect("an existing file");
        let overwritten = ready(create_session(
            &env,
            &tools,
            &json!({ "path": "kept.csv", "overwrite": true }),
        ))
        .expect("an overwrite")
        .session;
        remove_failed_create(lane, &overwritten, false);
        assert!(
            there(lane, &kept),
            "a file that was there before is not the create's to remove"
        );
    });
}

/// Records again with Node and compares: `cargo test -p mixdog-office --test twin_open_create -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/core/office-sessions.mjs)"]
fn twin_live_open_create() {
    let printed = twin::run_recorder(
        "benchmarks/rust-core/recorders/record-office-open-create.mjs",
        &twin::node_source_root(),
    );
    assert!(
        printed.contains("golden.json"),
        "the recorder did not finish: {printed}"
    );
    every_answer_equals_the_recording();
}
