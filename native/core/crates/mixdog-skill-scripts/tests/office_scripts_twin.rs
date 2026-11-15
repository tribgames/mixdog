//! Twin of the pptx skill scripts: the Rust functions run on the inputs of
//! `fixtures/skill-scripts-office/golden.json` (recorded by
//! `benchmarks/rust-core/recorders/record-skill-scripts-office.mjs` from Node running the shipped scripts) with the
//! stubs it records, and what they print, the report files they write and the calls they make to the office engine and
//! to the model turn are compared byte for byte. The temporary root is written `<root>` (separators as slashes) and the
//! random part of a work folder `review-input-<id>` on both sides.
//!
//! The office engine and the model turn are stubs on both sides: the engine's own output is the office tracks' twin;
//! this one pins what the scripts do with it.

use std::path::Path;
use std::sync::LazyLock;
use std::sync::Mutex;

use base64::Engine;
use mixdog_fsio::Unlaned;
use mixdog_skill_scripts::Outcome;
use mixdog_skill_scripts::mixdogd_exec::ExecOptions;
use mixdog_skill_scripts::mixdogd_exec::ExecResult;
use mixdog_skill_scripts::mixdogd_exec::ExecRunner;
use mixdog_skill_scripts::qc_pages::run_qc_pages;
use mixdog_skill_scripts::review_deck::run_review_deck;
use mixdog_skill_scripts::source_extract::Measured;
use mixdog_skill_scripts::source_extract::OfficeEngine;
use mixdog_skill_scripts::source_extract::OfficeHost;
use mixdog_skill_scripts::source_extract::run_source_extract;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/skill-scripts-office/golden.json");

static RECORDING: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(&GOLDEN).expect("golden.json is JSON"));

fn cases(kind: &str) -> &'static Vec<Value> {
    RECORDING["cases"][kind].as_array().unwrap_or_else(|| panic!("golden.json has no {kind} cases"))
}

/// The normalisation of the recorder: the root as `<root>`, separators as slashes, a work folder's random part removed.
struct Norm {
    forms: [String; 3],
}

impl Norm {
    fn new(root: &Path) -> Self {
        let native = root.display().to_string();
        Self { forms: [native.replace('\\', "\\\\"), native.clone(), native.replace('\\', "/")] }
    }

    fn str(&self, text: &str) -> String {
        let mut out = text.to_owned();
        for form in &self.forms {
            out = out.replace(form.as_str(), "<root>");
        }
        let out = out.replace("\\\\", "/").replace('\\', "/");
        let mut result = String::new();
        let mut rest = out.as_str();
        while let Some(at) = rest.find("review-input-") {
            let (head, tail) = rest.split_at(at + "review-input-".len());
            let id: String = tail.chars().take(6).collect();
            if id.chars().count() == 6 && id.chars().all(|c| c.is_ascii_alphanumeric()) {
                result.push_str(head);
                result.push_str("<id>");
                rest = &tail[id.len()..];
            } else {
                result.push_str(head);
                rest = tail;
            }
        }
        result.push_str(rest);
        result
    }

    fn value(&self, value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.str(text)),
            Value::Array(items) => Value::Array(items.iter().map(|item| self.value(item)).collect()),
            Value::Object(map) => Value::Object(map.iter().map(|(key, child)| (key.clone(), self.value(child))).collect()),
            other => other.clone(),
        }
    }
}

fn write_input(root: &Path, input: &Value) {
    mixdog_testkit::create_dir_all(root);
    for (rel, spec) in input["files"].as_object().into_iter().flatten() {
        let bytes: Vec<u8> = match spec {
            Value::String(text) => text.clone().into_bytes(),
            _ => base64::engine::general_purpose::STANDARD.decode(spec["base64"].as_str().expect("base64")).expect("base64 decodes"),
        };
        let path = root.join(rel);
        mixdog_testkit::create_dir_all(path.parent().expect("a parent"));
        mixdog_testkit::write(&path, bytes);
    }
}

/// The recorder's stubs: an office engine and a model turn answering from the case's recorded spec.
struct Stub<'a> {
    spec: &'a Value,
    root: String,
    norm: &'a Norm,
    review: bool,
    opened: Mutex<String>,
    office_calls: Mutex<Vec<Value>>,
    exec_calls: Mutex<Vec<Value>>,
}

fn base_name(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_owned()
}

impl OfficeEngine for Stub<'_> {
    fn call(&self, args: &Value, _cwd: &Path) -> Result<Value, String> {
        self.office_calls.lock().expect("calls").push(self.norm.value(args));
        match args["action"].as_str() {
            Some("open") => {
                if let Some(message) = self.spec.get("openError").and_then(Value::as_str) {
                    return Err(message.to_owned());
                }
                *self.opened.lock().expect("opened") = base_name(args["path"].as_str().expect("a path"));
                Ok(json!({ "session": "s1" }))
            }
            Some("snapshot") => {
                let opened = self.opened.lock().expect("opened").clone();
                Ok(self.spec["documents"].get(&opened).map_or_else(|| json!({}), |document| json!({ "document": document })))
            }
            Some("render") => {
                let render = self.spec.get("render");
                if let Some(message) = render.and_then(|render| render.get("error")).and_then(Value::as_str) {
                    return Err(message.to_owned());
                }
                let page = args["pages"][0].to_string();
                match render.and_then(|render| render["images"].get(&page)).and_then(Value::as_str) {
                    Some(path) => Ok(json!({ "images": [{ "page": args["pages"][0], "path": path.replace("<root>", &self.root) }] })),
                    None => Ok(json!({ "images": [] })),
                }
            }
            _ => Ok(json!({})),
        }
    }

    fn measure(&self, deck: &Path) -> Result<Measured, String> {
        let name = deck.file_name().expect("a file name").to_string_lossy().into_owned();
        let found = self.spec["measures"].get(&name).ok_or_else(|| format!("cannot measure {name}"))?;
        Ok(Measured { issues: found["issues"].as_array().cloned().unwrap_or_default(), document: found["document"].clone() })
    }
}

impl ExecRunner for Stub<'_> {
    fn run(&self, options: &ExecOptions) -> ExecResult {
        self.exec_calls.lock().expect("calls").push(self.norm.value(&json!({
            "message": options.message,
            "provider": options.provider,
            "model": options.model,
            "effort": options.effort,
            "cwd": options.cwd.as_ref().map(|cwd| cwd.to_string_lossy().into_owned()),
            "usageLogPath": options.usage_log_path,
            "webSearch": options.web_search,
        })));
        let page = options.message.lines().find_map(|line| {
            let rest = line.strip_prefix("Slide ")?;
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            (!digits.is_empty() && rest[digits.len()..].starts_with(" of")).then_some(digits)
        });
        let fallback = json!({ "code": 0, "out": "OK" });
        let answer = if self.review {
            self.spec
        } else {
            page.and_then(|page| self.spec["pages"].get(&page)).or_else(|| self.spec.get("default")).unwrap_or(&fallback)
        };
        if let Some(edit) = answer.get("edit").and_then(Value::as_str) {
            let marker = "output:\"";
            let from = options.message.find(marker).expect("an output") + marker.len();
            let copy = options.message[from..].split('"').next().expect("a path");
            mixdog_testkit::write(copy, edit);
        }
        ExecResult {
            code: answer.get("code").and_then(Value::as_i64).map_or(0, |code| i32::try_from(code).expect("an exit code")),
            stdout: answer.get("out").and_then(Value::as_str).unwrap_or_default().to_owned(),
            stderr: answer.get("err").and_then(Value::as_str).unwrap_or_default().to_owned(),
        }
    }
}

struct NoExec;

impl ExecRunner for NoExec {
    fn run(&self, _options: &ExecOptions) -> ExecResult {
        panic!("a case the recorder ran without a stub starts no model turn");
    }
}

fn captured(root: &Path, rels: &Value, norm: &Norm) -> Value {
    let mut files = Map::new();
    for rel in rels.as_array().into_iter().flatten() {
        let rel = rel.as_str().expect("a path");
        let path = root.join(rel);
        let value = if mixdog_testkit::exists(&path) {
            let text = String::from_utf8_lossy(&mixdog_testkit::read(&path)).into_owned();
            match serde_json::from_str::<Value>(&text) {
                Ok(document) => norm.value(&document),
                Err(_) => Value::String(norm.str(&text)),
            }
        } else {
            Value::Null
        };
        files.insert(rel.to_owned(), value);
    }
    Value::Object(files)
}

fn work_folders(root: &Path, dir: &str, norm: &Norm) -> Value {
    let base = root.join(dir);
    if !mixdog_testkit::exists(&base) {
        return json!([]);
    }
    let mut folders = Vec::new();
    for name in mixdog_testkit::entry_names(&base) {
        let name = name.to_string_lossy().into_owned();
        if !name.starts_with("review-input-") {
            continue;
        }
        let mut files: Vec<String> = mixdog_testkit::entry_names(base.join(&name)).iter().map(|file| file.to_string_lossy().into_owned()).collect();
        files.sort();
        let listed: Vec<Value> =
            files.iter().map(|file| json!([file, mixdog_testkit::read(base.join(&name).join(file)).len()])).collect();
        folders.push(json!({ "folder": norm.str(&name), "files": listed }));
    }
    Value::Array(folders)
}

fn clip(text: &str) -> String {
    text.chars().take(300).collect()
}

/// The files a review packet lists are copied by `Promise.all`, and Node lists them in the order the copies finished:
/// the recording lists the pages of one packet as 1, 2 in one case and 2, 1 in another. The list is the packet's set of
/// files, so both sides are compared in the order of their names.
fn sort_review_inputs(observed: &mut Value) {
    let Some(files) = observed.get_mut("files").and_then(Value::as_object_mut) else {
        return;
    };
    for written in files.values_mut() {
        if let Some(inputs) = written.get_mut("inputs").and_then(Value::as_array_mut) {
            inputs.sort_by(|a, b| a["file"].as_str().cmp(&b["file"].as_str()));
        }
    }
}

fn run_kind(kind: &str) -> (usize, Vec<String>) {
    let mut ran = 0;
    let mut differences = Vec::new();
    for case in cases(kind) {
        let name = case["case"].as_str().expect("a case name");
        let root = tempfile::tempdir().expect("temp dir");
        write_input(root.path(), &case["input"]);
        let norm = Norm::new(root.path());
        let fixed = root.path().display().to_string().replace('\\', "/");
        let args: Vec<String> =
            case["argv"].as_array().expect("argv").iter().map(|arg| arg.as_str().expect("a string").replace("<root>", &fixed)).collect();
        let cli = case.get("cli").and_then(Value::as_bool).unwrap_or(false);
        let empty = json!({});
        let spec = if cli { &empty } else { case.get("stub").unwrap_or(&empty) };
        let stub = Stub {
            spec,
            root: fixed.clone(),
            norm: &norm,
            review: kind == "review",
            opened: Mutex::new(String::new()),
            office_calls: Mutex::new(Vec::new()),
            exec_calls: Mutex::new(Vec::new()),
        };
        let outcome: Outcome = if cli {
            let host = OfficeHost { engine: None, exec: &NoExec, cwd: root.path() };
            match kind {
                "extract" => run_source_extract(&Unlaned, &args, &host),
                "qc" => run_qc_pages(&Unlaned, &args, &host),
                _ => run_review_deck(&Unlaned, &args, &host),
            }
        } else {
            let host = OfficeHost { engine: Some(&stub), exec: &stub, cwd: root.path() };
            match kind {
                "extract" => run_source_extract(&Unlaned, &args, &host),
                "qc" => run_qc_pages(&Unlaned, &args, &host),
                _ => run_review_deck(&Unlaned, &args, &host),
            }
        };
        let mut got = Map::new();
        got.insert("stdout".to_owned(), json!(norm.str(&outcome.stdout)));
        got.insert("stderr".to_owned(), json!(norm.str(&outcome.stderr)));
        got.insert("status".to_owned(), json!(outcome.code));
        got.insert("files".to_owned(), captured(root.path(), case.get("capture").unwrap_or(&json!([])), &norm));
        if !cli && kind != "review" {
            got.insert("office".to_owned(), Value::Array(stub.office_calls.lock().expect("calls").clone()));
        }
        if !cli && kind != "extract" {
            got.insert("exec".to_owned(), Value::Array(stub.exec_calls.lock().expect("calls").clone()));
        }
        if let Some(dir) = case.get("workFolders").and_then(Value::as_str) {
            got.insert("workFolders".to_owned(), work_folders(root.path(), dir, &norm));
        }
        let (mut got, mut want) = (Value::Object(got), case["observed"].clone());
        sort_review_inputs(&mut got);
        sort_review_inputs(&mut want);
        let want = &want;
        if got != *want || got.to_string() != want.to_string() {
            let field = ["stdout", "stderr", "status", "files", "office", "exec", "workFolders"]
                .into_iter()
                .find(|field| got.get(*field) != want.get(*field) || got.get(*field).map(Value::to_string) != want.get(*field).map(Value::to_string))
                .unwrap_or("key order");
            differences.push(format!(
                "{kind}: {name}: {field} differs\n  node: {}\n  rust: {}",
                clip(&want.get(field).map_or_else(String::new, Value::to_string)),
                clip(&got.get(field).map_or_else(String::new, Value::to_string))
            ));
        }
        ran += 1;
    }
    (ran, differences)
}

fn assert_twin(kind: &str) {
    let (ran, differences) = run_kind(kind);
    assert!(ran > 0, "no {kind} case ran");
    assert!(
        differences.is_empty(),
        "{} difference(s) of {ran} {kind} case(s):\n{}",
        differences.len(),
        differences.iter().take(8).cloned().collect::<Vec<_>>().join("\n")
    );
}

#[test]
fn source_extract_prints_what_node_prints() {
    assert_twin("extract");
}

#[test]
fn qc_pages_decides_writes_and_asks_what_node_does() {
    assert_twin("qc");
}

#[test]
fn review_deck_validates_writes_and_asks_what_node_does() {
    assert_twin("review");
}
