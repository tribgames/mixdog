//! Twin test `templates`: the recording of Node's office design template modules
//! (`native/core/fixtures/office-templates/golden.json`, written by `benchmarks/rust-core/recorders/record-office-templates.mjs`)
//! against `mixdog_office_design::templates`.
//!
//! The recording holds the fixture decks (base64), the inspection of each, the template index of a folder over a series of
//! changes (a file replaced, a sidecar touched, broken, removed), the roles induced from geometry, the annotation of deck
//! snapshots, the slide selections (every part of the new deck), the page choice and fill, and the operation lists
//! `use_template_page` expands to over the packaged executive deck, a drawn deck and a deck with a sidecar. Every output equals
//! the recording value for value. Every template file and sidecar gets the recording's modification time, the clock is the
//! recording's, and paths are compared with the temporary folder written `<root>` and `/` as the separator. A page's snapshot
//! is what the recording took from the Node reader (the snapshot reader is another module). Re-recording is
//! `twin_live_templates` (ignored: it runs Node).

use mixdog_rt::LaneToken;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mixdog_fsio::WriteProof;
use mixdog_js::json_stringify;
use mixdog_office_base::twin;
use mixdog_office_base::values::sha256;
use mixdog_office_design::library::{Environment, canonical_path, load_config};
use mixdog_office_design::templates::{
    annotate_pptx_snapshot_roles, create_pptx_slide_selection, expand_template_page_operations, index_office_templates, induce_pptx_sample_roles, inspect_office_template,
    office_template_coverage, select_template_page, template_page_fill,
};
use mixdog_ooxml::zipio::Package;
use mixdog_rt::{CancellationToken, DurabilityIo, InLane};
use serde_json::{Map, Value, json};

fn golden() -> Value {
    twin::load_golden("office-templates")
}

/// Runs `job` as a durability-lane job (the inline test backend runs it on this thread).
fn on_lane<R: Send + 'static>(job: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> R {
    let lanes = mixdog_rt::testing::tokens();
    tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("runtime")
        .block_on(async { lanes.durability_io.submit(&CancellationToken::new(), job).expect("submit").await.expect("job") })
}

fn bytes_of(encoded: &Value) -> Vec<u8> {
    STANDARD.decode(encoded.as_str().expect("base64 text")).expect("base64")
}

fn set_mtime<P: WriteProof>(proof: &P, path: &Path, seconds: u64) {
    let file = mixdog_fsio::File::options().write(true).open(proof, path).expect("open for the time stamp");
    file.set_modified(proof, UNIX_EPOCH + Duration::from_secs(seconds)).expect("modification time");
}

fn place<P: WriteProof>(proof: &P, path: &Path, data: &[u8], seconds: u64) {
    if let Some(parent) = path.parent() {
        mixdog_fsio::create_dir_all(proof, parent).expect("folder");
    }
    mixdog_fsio::write(proof, path, data).expect("write");
    set_mtime(proof, path, seconds);
}

/// The recording's folder of templates, written under a temporary folder.
struct World {
    dir: PathBuf,
    folder: PathBuf,
    data_dir: PathBuf,
    env: Environment,
    mtime: u64,
}

impl World {
    fn new<P: WriteProof>(proof: &P, dir: &Path, golden: &Value) -> Self {
        let clock = golden["clock"].as_f64().expect("clock");
        let env = Environment {
            library_config: String::new(),
            pack_url: String::new(),
            pack_key_id: String::new(),
            pack_public_key: String::new(),
            template_dirs: String::new(),
            windows: false,
            program_files: String::new(),
            program_files_x86: String::new(),
            app_data: String::new(),
            home: String::new(),
            cwd: dir.to_path_buf(),
            bundled_templates: PathBuf::from("<bundled>"),
            now_ms: Arc::new(move || clock),
        };
        let mtime = golden["mtime"].as_u64().expect("mtime");
        let world = Self { dir: dir.to_path_buf(), folder: dir.join("templates"), data_dir: dir.join("data"), env, mtime };
        for (name, data) in golden["files"].as_object().expect("files") {
            place(proof, &world.folder.join(name), &bytes_of(data), mtime);
        }
        for (name, data) in golden["sidecars"].as_object().expect("sidecars") {
            place(proof, &world.folder.join(name), serde_json::to_string_pretty(data).expect("sidecar").as_bytes(), mtime);
        }
        let assets = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets").join("templates");
        for name in ["mixdog-executive.pptx", "mixdog-executive.pptx.mixdog.json"] {
            let data = mixdog_fsio::read(proof, assets.join(name)).expect("packaged template");
            place(proof, &world.folder.join(name), &data, mtime);
        }
        world
    }

    /// A text with the folder as `<root>` and `/` as the separator.
    fn scrub_text(&self, text: &str) -> String {
        text.replace(&self.dir.to_string_lossy().into_owned(), "<root>").replace('\\', "/")
    }

    fn scrub(&self, value: &Value, ids: &HashMap<String, String>) -> Value {
        match value {
            Value::String(text) => Value::String(ids.get(text).cloned().unwrap_or_else(|| self.scrub_text(text))),
            Value::Array(items) => Value::Array(items.iter().map(|item| self.scrub(item, ids)).collect()),
            Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (self.scrub_text(key), self.scrub(item, ids))).collect()),
            other => other.clone(),
        }
    }

    /// The inverse, for an input written with `<root>`.
    fn unscrub(&self, value: &Value) -> Value {
        let folder = self.dir.to_string_lossy().into_owned();
        match value {
            Value::String(text) => Value::String(text.replace("<root>", &folder)),
            Value::Array(items) => Value::Array(items.iter().map(|item| self.unscrub(item)).collect()),
            Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), self.unscrub(item))).collect()),
            other => other.clone(),
        }
    }

    /// The id the index gives a template with no sidecar id, written as the recording writes it.
    fn local_ids(&self, files: &[(&str, &str)]) -> HashMap<String, String> {
        files
            .iter()
            .map(|(path, name)| (format!("local-{}", &sha256(canonical_path(&self.env, &self.dir.join(path).to_string_lossy()))[..16]), format!("<local {name}>")))
            .collect()
    }
}

/// `{ value }` / `{ error }` of an attempt, written against the folder.
fn attempt(world: &World, ids: &HashMap<String, String>, result: Result<Value, String>) -> Value {
    match result {
        Ok(value) => json!({ "value": world.scrub(&value, ids) }),
        Err(error) => json!({ "error": world.scrub_text(&error) }),
    }
}

fn recorded(entry: &Value) -> Value {
    match (entry.get("error"), entry.get("value")) {
        (Some(error), _) => json!({ "error": error }),
        (None, Some(value)) => json!({ "value": value }),
        (None, None) => json!({}),
    }
}

fn check(what: &str, expected: &Value, actual: &Value) {
    twin::assert_matches(what, &path_free(expected), &path_free(actual));
}

/// `local-<16 hex>` at the start of a text is the hash of a template's path, and the folder of a run is its own: the recording
/// holds the hash of the recorder's folder wherever the id is part of a longer one (`local-<hash>-slide-1`; an id on its own is
/// already written `<local name>`). The hash is written `<path>` on both sides, and the index revision, which hashes the ids
/// and the paths, `<revision>`.
fn path_free(value: &Value) -> Value {
    fn local(text: &str) -> Option<String> {
        let rest = text.strip_prefix("local-")?;
        let hash = rest.get(..16)?;
        (hash.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) && rest[16..].starts_with('-')).then(|| format!("local-<path>{}", &rest[16..]))
    }
    fn walk(value: &Value, found: &mut bool) -> Value {
        match value {
            Value::String(text) => match local(text) {
                Some(masked) => {
                    *found = true;
                    Value::String(masked)
                }
                None => value.clone(),
            },
            Value::Array(items) => Value::Array(items.iter().map(|item| walk(item, found)).collect()),
            Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), walk(item, found))).collect()),
            other => other.clone(),
        }
    }
    fn revisions(value: &mut Value) {
        match value {
            Value::Array(items) => items.iter_mut().for_each(revisions),
            Value::Object(map) => {
                for (key, item) in map.iter_mut() {
                    if key == "revision" && item.is_string() {
                        *item = Value::String("<revision>".to_owned());
                    } else {
                        revisions(item);
                    }
                }
            }
            _ => {}
        }
    }
    let mut found = false;
    let mut out = walk(value, &mut found);
    // The revision hashes each template's id and path: the folder of the run is in it whether or not an id is.
    revisions(&mut out);
    out
}

/// [`check`], and the JSON text is the one Node writes, key order included (the index and what an inspection answers are files
/// and tool answers).
fn check_text(what: &str, expected: &Value, actual: &Value) {
    check(what, expected, actual);
    assert!(json_stringify(&twin::normalise(&path_free(expected))) == json_stringify(&twin::normalise(&path_free(actual))), "{what}: the JSON text differs from the recording (key order or number text)");
}

fn roles_object(roles: &HashMap<u64, String>) -> Value {
    Value::Object(roles.iter().map(|(bits, role)| (mixdog_js::number_to_string(f64::from_bits(*bits)), Value::String(role.clone()))).collect::<Map<String, Value>>())
}

// ---- the packaged templates -----------------------------------------------------------------------------------------------

#[test]
fn the_packaged_templates_are_the_recorded_files_byte_for_byte() {
    let golden = golden();
    on_lane(move |lane| {
        let assets = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets").join("templates");
        let sha = |name: &str| sha256(mixdog_fsio::read(lane, assets.join(name)).expect("packaged file"));
        assert_eq!(sha("mixdog-executive.pptx"), golden["packaged"]["sha256"].as_str().expect("sha"));
        assert_eq!(sha("mixdog-executive.pptx.mixdog.json"), golden["packaged"]["sidecarSha256"].as_str().expect("sha"));
        assert_eq!(sha("mixdog-executive.mixdog-edit.pptx"), golden["packaged"]["editSha256"].as_str().expect("sha"));
    });
}

// ---- inspection and coverage ------------------------------------------------------------------------------------------------

#[test]
fn inspection_equals_the_recording() {
    let golden = golden();
    on_lane(move |lane| {
        let dir = tempfile::tempdir().expect("temporary folder");
        let world = World::new(lane, dir.path(), &golden);
        let ids = HashMap::new();
        for entry in golden["inspections"].as_array().expect("inspections") {
            let name = entry["name"].as_str().expect("name");
            let format = entry["format"].as_str().expect("format");
            let actual = attempt(&world, &ids, inspect_office_template(lane, &world.folder.join(name).to_string_lossy(), format));
            check_text(&format!("inspection of {name}"), &recorded(entry), &actual);
        }
        let samples = &golden["coverage"];
        let filled = [
            json!({ "kind": "cover", "density": "light", "purposes": ["decide"], "expressionModes": ["divergent"], "capabilities": ["image", "chart"] }),
            json!({ "kind": "content", "density": "dense", "purposes": [], "capabilities": ["table", "diagram"] }),
            json!({ "kind": "", "density": "balanced" }),
        ];
        check("coverage", &recorded(&samples["filled"]), &json!({ "value": office_template_coverage(&filled) }));
        check("coverage of nothing", &recorded(&samples["empty"]), &json!({ "value": office_template_coverage(&[]) }));
    });
}

// ---- the index --------------------------------------------------------------------------------------------------------------

/// What a run keeps where the recording does not keep the whole answer.
fn summary(value: &Value) -> Value {
    let mut out: Map<String, Value> = value.as_object().expect("an index").iter().filter(|(key, _)| key.as_str() != "templates").map(|(key, item)| (key.clone(), item.clone())).collect();
    let templates: Vec<Value> = value["templates"]
        .as_array()
        .expect("templates")
        .iter()
        .map(|entry| Value::Object(["id", "path", "sha256", "version", "mtimeMs", "sidecarMtimeMs", "inspectionWarning"].iter().map(|key| ((*key).to_owned(), entry[*key].clone())).collect()))
        .collect();
    out.insert("templates".to_owned(), Value::Array(templates));
    Value::Object(out)
}

fn apply_step<P: WriteProof>(proof: &P, world: &World, step: &Value) {
    let target = world.folder.join(step["file"].as_str().expect("file"));
    match step["kind"].as_str().expect("kind") {
        "write" => {
            let data = step.get("base64").map_or_else(|| step["text"].as_str().expect("text").as_bytes().to_vec(), bytes_of);
            place(proof, &target, &data, step["mtime"].as_u64().expect("mtime"));
        }
        "utimes" => set_mtime(proof, &target, step["mtime"].as_u64().expect("mtime")),
        _ => mixdog_fsio::remove_file(proof, &target).expect("remove"),
    }
}

#[test]
fn the_index_equals_the_recording_over_every_change() {
    let golden = golden();
    on_lane(move |lane| {
        let dir = tempfile::tempdir().expect("temporary folder");
        let world = World::new(lane, dir.path(), &golden);
        let ids = world.local_ids(&[("templates/tokens.potx", "tokens.potx")]);
        let override_config = json!({ "templateDirectories": [world.folder.to_string_lossy()], "discoverInstalledTemplates": false });
        for run in golden["indexRuns"].as_array().expect("runs") {
            let label = run["label"].as_str().expect("label");
            for step in run["steps"].as_array().expect("steps") {
                apply_step(lane, &world, step);
            }
            let config = load_config(lane, &world.env, &world.data_dir, Some(&override_config)).expect("configuration");
            let mut outcome = index_office_templates(lane, &world.env, &world.data_dir, &config);
            if run["full"] != Value::Bool(true) {
                outcome = outcome.map(|value| summary(&value));
            }
            let actual = attempt(&world, &ids, outcome);
            if run["full"] == Value::Bool(true) { check_text(&format!("index run {label}"), &recorded(run), &actual) } else { check(&format!("index run {label}"), &recorded(run), &actual) }
        }
        let path = world.data_dir.join("office").join("design-library").join("template-index.json");
        let written = mixdog_js::json_parse(&String::from_utf8_lossy(&mixdog_fsio::read(lane, path).expect("the index file"))).expect("index JSON");
        check_text("the index file", &json!({ "value": golden["indexFile"] }), &json!({ "value": world.scrub(&written, &ids) }));
    });
}

#[test]
fn a_template_with_no_sidecar_id_is_named_for_its_path() {
    let golden = golden();
    on_lane(move |lane| {
        let dir = tempfile::tempdir().expect("temporary folder");
        let world = World::new(lane, dir.path(), &golden);
        let single = world.dir.join("single");
        place(lane, &single.join("only.pptx"), &bytes_of(&golden["single"]["file"]), world.mtime);
        let ids = world.local_ids(&[("single/only.pptx", "only.pptx")]);
        let config = load_config(lane, &world.env, &world.dir.join("data2"), Some(&json!({ "templateDirectories": [single.to_string_lossy()], "discoverInstalledTemplates": false }))).expect("configuration");
        let outcome = index_office_templates(lane, &world.env, &world.dir.join("data2"), &config);
        check("a folder of one template", &recorded(&golden["single"]["run"]), &attempt(&world, &ids, outcome));
    });
}

// ---- induced roles and annotation -------------------------------------------------------------------------------------------

#[test]
fn induced_roles_equal_the_recording() {
    let golden = golden();
    for case in golden["induced"].as_array().expect("cases") {
        let canvas = case.get("canvas").filter(|canvas| !canvas.is_null()).map(|canvas| (canvas["width"].as_f64().expect("width"), canvas["height"].as_f64().expect("height")));
        let roles = induce_pptx_sample_roles(&json!({ "shapes": case["shapes"] }), canvas);
        check(&format!("roles of {}", case["name"]), &json!({ "value": case["roles"] }), &json!({ "value": roles_object(&roles) }));
    }
}

#[test]
fn annotated_snapshots_equal_the_recording() {
    let golden = golden();
    let annotate = |document: &Value| {
        let mut copy = document.clone();
        annotate_pptx_snapshot_roles(&mut copy);
        copy
    };
    for (name, raw) in golden["annotated"]["raw"].as_object().expect("documents") {
        check(&format!("annotation of {name}"), &json!({ "value": golden["annotated"]["annotated"][name] }), &json!({ "value": annotate(raw) }));
    }
    for (name, pair) in golden["realSnapshots"].as_object().expect("snapshots") {
        check(&format!("annotation of the snapshot of {name}"), &json!({ "value": pair["annotated"] }), &json!({ "value": annotate(&pair["raw"]) }));
    }
}

// ---- slide selection --------------------------------------------------------------------------------------------------------

#[test]
fn slide_selections_equal_the_recording() {
    let golden = golden();
    on_lane(move |lane| {
        let dir = tempfile::tempdir().expect("temporary folder");
        let world = World::new(lane, dir.path(), &golden);
        let sources: HashMap<&str, &str> =
            HashMap::from([("drawn", "drawn.pptx"), ("executive", "mixdog-executive.pptx"), ("nopres", "no-presentation.pptm"), ("gone", "gone.pptx"), ("damaged", "damaged.pptx")]);
        for (number, case) in golden["selections"].as_array().expect("selections").iter().enumerate() {
            let source = world.folder.join(sources[case["source"].as_str().expect("source")]);
            let output = world.dir.join("selected").join(format!("case-{number}.pptx"));
            let outcome = create_pptx_slide_selection(lane, &source.to_string_lossy(), &case["slides"], &output.to_string_lossy());
            let what = format!("selection {number} of {} {}", case["source"], case["slides"]);
            check(&what, &recorded(case), &attempt(&world, &HashMap::new(), outcome.clone()));
            if outcome.is_err() {
                assert!(case["package"].is_null(), "{what}: a refused selection left no package");
                continue;
            }
            let package = Package::load(&mixdog_fsio::read(lane, &output).expect("the new deck")).expect("a valid package");
            let names = package.names();
            let mut parts = Map::new();
            let mut texts = Map::new();
            for name in &names {
                let entry = package.entry(name).expect("entry");
                parts.insert(name.clone(), Value::String(if entry.dir { "dir".to_owned() } else { sha256(&entry.data) }));
                if case["package"]["texts"].get(name).is_some() {
                    texts.insert(name.clone(), Value::String(package.text(name)));
                }
            }
            let actual = json!({ "names": names, "parts": parts, "texts": texts });
            check(&format!("{what}: the parts"), &case["package"], &actual);
        }
        // A package that cannot be written leaves what was there.
        let blocked = world.dir.join("selected").join("blocked.pptx");
        mixdog_fsio::create_dir_all(lane, &blocked).expect("a directory where the deck would go");
        let outcome = create_pptx_slide_selection(lane, &world.folder.join("drawn.pptx").to_string_lossy(), &json!([1]), &blocked.to_string_lossy());
        assert!(outcome.is_err() && golden["blocked"].get("error").is_some(), "writing over a directory fails");
        assert!(mixdog_fsio::is_dir(lane, &blocked), "the directory is still there");
    });
}

// ---- page choice and fill ---------------------------------------------------------------------------------------------------

#[test]
fn the_page_choice_equals_the_recording() {
    let golden = golden();
    for entry in golden["selects"].as_array().expect("selects") {
        let document = &golden["lowDocuments"][entry["document"].as_str().expect("document")];
        let outcome = select_template_page(document, &entry["request"]).map(|page| page.get("index").cloned().unwrap_or(Value::Null));
        let actual = match outcome {
            Ok(value) => json!({ "value": value }),
            Err(error) => json!({ "error": error }),
        };
        check(&format!("choice {} {}", entry["document"], entry["request"]), &recorded(entry), &actual);
    }
}

#[test]
fn the_fill_equals_the_recording() {
    let golden = golden();
    for entry in golden["fills"].as_array().expect("fills") {
        let document = &golden["lowDocuments"][entry["document"].as_str().expect("document")];
        let page = document["slides"].as_array().expect("pages").iter().find(|page| page.get("index") == entry.get("page").filter(|index| !index.is_null())).expect("the recorded page");
        let actual = match template_page_fill(page, &entry["content"]) {
            Ok(fill) => json!({ "value": {
                "sets": fill.sets.iter().map(|(shape, text)| json!({ "shape": mixdog_js::json_number(*shape), "text": text })).collect::<Vec<_>>(),
                "deletes": fill.deletes.iter().map(|shape| mixdog_js::json_number(*shape)).collect::<Vec<_>>(),
                "group": fill.group.map_or(Value::Null, |group| json!({ "family": group.family, "size": mixdog_js::json_number(group.size), "lead": group.lead, "follow": group.follow })),
            } }),
            Err(error) => json!({ "error": error }),
        };
        check(&format!("fill {} page {} of {}", entry["content"], entry["page"], entry["document"]), &recorded(entry), &actual);
    }
}

// ---- use_template_page ------------------------------------------------------------------------------------------------------

#[test]
fn use_template_page_expands_as_recorded() {
    let golden = golden();
    on_lane(move |lane| {
        let dir = tempfile::tempdir().expect("temporary folder");
        let world = World::new(lane, dir.path(), &golden);
        let snapshots = golden["realSnapshots"].clone();
        let gone = golden["goneSnapshot"]["error"].as_str().map(|text| world.unscrub(&Value::String(text.to_owned())));
        for entry in golden["expansions"].as_array().expect("expansions") {
            let operations: Vec<Value> = world.unscrub(&entry["operations"]).as_array().expect("operations").clone();
            let mut carriers: Vec<Value> = Vec::new();
            let mut snapshot = |path: &str| -> Result<Value, String> {
                let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
                match snapshots.get(name) {
                    Some(pair) => Ok(pair["raw"].clone()),
                    None => Err(gone.as_ref().and_then(Value::as_str).expect("the recorded error").to_owned()),
                }
            };
            let outcome = expand_template_page_operations(lane, entry["format"].as_str().expect("format"), &operations, &mut carriers, &mut snapshot).map(Value::Array);
            let label = entry["label"].as_str().expect("label");
            check(label, &recorded(entry), &attempt(&world, &HashMap::new(), outcome));
            if entry.get("error").is_none() {
                check(&format!("{label}: carriers"), &entry["carriers"], &world.scrub(&Value::Array(carriers), &HashMap::new()));
            }
        }
    });
}

/// Records again with Node and compares: `cargo test -p mixdog-office-design --test twin_templates -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/design/library)"]
fn twin_live_templates() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-templates.mjs", &twin::node_source_root());
    assert!(printed.contains("golden written"), "the recorder did not finish: {printed}");
    let golden = golden();
    assert!(golden["indexRuns"].as_array().is_some_and(|runs| !runs.is_empty()), "the recording holds the index runs");
}
