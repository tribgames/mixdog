//! A pptxgenjs authoring script on the script interpreter: the route Node served in its own process
//! (`runPptxAuthoringScript`). Runs where `node` is on the search path and this tree holds the package (pptxgenjs installed);
//! elsewhere the cases that need the interpreter return at once and the refusal cases still run.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "the test looks for node and reads the file the script wrote")]

use std::path::{Path, PathBuf};

use mixdog_office::author::script_runtime::{ScriptRuntime, run_pptx_script_on};
use serde_json::Value;

fn package_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..")
}

/// `node` of the search path, when the package of this tree can run a script (its entry and pptxgenjs are there).
fn node() -> Option<ScriptRuntime> {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    let program = std::env::split_paths(&std::env::var_os("PATH")?).map(|dir| dir.join(name)).find(|path| path.is_file())?;
    let root = package_root();
    let ready = root.join("src/runtime/office/authoring/pptx-script-entry.mjs").is_file() && root.join("node_modules/pptxgenjs").exists();
    ready.then_some(ScriptRuntime { program, package_root: root, electron: false })
}

fn run(runtime: ScriptRuntime, script: &str, output: &Path) -> Result<Value, String> {
    let cwd = output.parent().expect("a folder").to_path_buf();
    tokio::runtime::Builder::new_current_thread().build().expect("runtime").block_on(run_pptx_script_on(runtime, script, output, &cwd))
}

#[test]
fn a_script_writes_the_deck_and_answers_as_node_did() {
    let Some(runtime) = node() else { return };
    let dir = tempfile::tempdir().expect("folder");
    let output = dir.path().join("deck.pptx");
    let script = "const PptxGenJS = require('pptxgenjs');\nconst pres = new PptxGenJS();\nconst slide = pres.addSlide();\nslide.addText('Hello', { x: 1, y: 1, w: 4, h: 1 });\nconsole.log('made', 1);\nawait pres.writeFile({ fileName: OUTPUT });\n";
    let answer = run(runtime, script, &output).expect("the script runs");
    assert_eq!(answer["ok"], Value::Bool(true), "{answer}");
    assert_eq!(answer["kit"], "script");
    assert_eq!(answer["logs"][0]["text"], "made 1");
    let bytes = std::fs::read(&output).expect("the deck is written");
    assert_eq!(answer["bytes"].as_u64(), Some(bytes.len() as u64));
    assert_eq!(&bytes[..2], b"PK");
}

#[test]
fn a_failing_script_answers_its_error_with_the_line() {
    let Some(runtime) = node() else { return };
    let dir = tempfile::tempdir().expect("folder");
    let script = "const PptxGenJS = require('pptxgenjs');\nconst pres = new PptxGenJS();\nthrow new Error('no data');\n";
    let answer = run(runtime, script, &dir.path().join("deck.pptx")).expect("the run answers");
    assert_eq!(answer["ok"], Value::Bool(false), "{answer}");
    assert_eq!(answer["error"]["message"], "no data");
    assert_eq!(answer["error"]["line"], 3);
}

#[test]
fn an_empty_script_is_refused_with_the_sentence_of_node() {
    let Some(runtime) = node() else { return };
    let dir = tempfile::tempdir().expect("folder");
    assert_eq!(run(runtime, "  ", &dir.path().join("deck.pptx")), Err("author requires a non-empty pptxgenjs script".to_owned()));
}

#[test]
fn an_interpreter_that_is_not_there_says_so_and_points_at_html() {
    let dir = tempfile::tempdir().expect("folder");
    let runtime = ScriptRuntime { program: dir.path().join("no-node-here"), package_root: package_root(), electron: false };
    let error = run(runtime, "x", &dir.path().join("deck.pptx")).expect_err("no interpreter");
    assert!(error.starts_with("A pptxgenjs script cannot run: the script interpreter "), "{error}");
    assert!(error.ends_with("Author the deck as HTML slides (a source that opens with <) instead."), "{error}");
}
