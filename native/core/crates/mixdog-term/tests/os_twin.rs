//! The clipboard, paste and OS helpers against what the Node TUI does (tests/goldens/os.json, recorded by
//! tests/recorders/record-os.mjs): the OSC 52 sequences and the skip rule, the native clipboard writer of each platform and
//! environment, the Linux install hints, the paste policy and reference formats and parsers, the prompt content with
//! images, the path candidates of a paste, the path cleaning and image types, the browser opener rules and launchers, and
//! the macOS folder script.

use std::collections::BTreeMap;
use std::io;
use std::sync::Arc;

use mixdog_term::clipboard::{ClipboardError, copy_to_clipboard_with, native_clipboard_command, no_clipboard_reader_error, osc52_clipboard_sequence, should_skip_osc52};
use mixdog_term::os::{
    HelperCommand, Outcome, Platform, Runner, browser_candidates, can_open_browser, macos_choose_script,
};
use mixdog_term::paste::{
    PastedImage, PromptContent, PromptPart, build_prompt_content_with_images, clean_path_text, format_image_ref,
    format_pasted_text_ref, image_reference_ids, mime_for_path, pasted_text_line_count, pasted_text_reference_ids,
    should_fold_pasted_text, split_pasted_image_path_candidates,
};
use serde_json::Value;

const GOLDEN: &str = include_str!("goldens/os.json");

fn golden() -> Value {
    serde_json::from_str(GOLDEN).expect("the golden parses")
}

fn text(value: &Value) -> &str {
    value.as_str().expect("a string")
}

fn platform(value: &Value) -> Platform {
    match text(value) {
        "win32" => Platform::Windows,
        "darwin" => Platform::Macos,
        "linux" => Platform::Linux,
        other => panic!("platform {other}"),
    }
}

/// The environment a recorded case ran under.
fn env_of(value: &Value) -> impl Fn(&str) -> Option<String> + use<> {
    let map = value.clone();
    move |name| map.get(name).and_then(Value::as_str).map(str::to_owned)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn the_osc52_sequence_and_its_skip_rule() {
    let golden = golden();
    assert_eq!(golden["osc52Max"].as_u64(), Some(mixdog_term::clipboard::OSC52_MAX_BYTES as u64));
    for case in golden["osc52"].as_array().unwrap() {
        let tmux = case["tmux"].as_bool().unwrap();
        assert_eq!(osc52_clipboard_sequence(text(&case["text"]), tmux), text(&case["sequence"]), "{case}");
    }
    for case in golden["skip"].as_array().unwrap() {
        let env = env_of(&case["env"]);
        assert_eq!(should_skip_osc52(platform(&case["platform"]), &env), case["skip"].as_bool().unwrap(), "{case}");
    }
}

#[test]
fn the_native_clipboard_writer() {
    for case in golden()["native"].as_array().unwrap() {
        let env = env_of(&case["env"]);
        let command = native_clipboard_command(platform(&case["platform"]), &env, text(&case["text"]));
        assert_eq!(command.program, text(&case["cmd"]), "{case}");
        let args: Vec<&str> = case["args"].as_array().unwrap().iter().map(text).collect();
        assert_eq!(command.args, args, "{case}");
        assert_eq!(hex(&command.stdin.expect("input")), text(&case["inputHex"]), "{case}");
    }
}

struct Missing;

impl Runner for Missing {
    fn run(&self, _command: &HelperCommand) -> Outcome {
        Outcome::NotFound
    }

    fn spawn_detached(&self, _program: &str, _args: &[String]) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn the_linux_install_hints() {
    let golden = golden();
    let big = "x".repeat(mixdog_term::clipboard::OSC52_MAX_BYTES + 1);
    for (program, env) in [("xclip", serde_json::json!({})), ("wl-copy", serde_json::json!({ "WAYLAND_DISPLAY": "wayland-0" }))] {
        let result = copy_to_clipboard_with(&mut Vec::new(), &big, false, Platform::Linux, &env_of(&env), Arc::new(Missing));
        assert_eq!(result, Err(ClipboardError(text(&golden["hints"]["linux"][program]).to_owned())));
    }
    assert_eq!(no_clipboard_reader_error().0, text(&golden["hints"]["noReader"]));
}

fn policy_text(spec: &Value) -> String {
    if let Some(literal) = spec.as_str() {
        literal.to_owned()
    } else if let Some(lines) = spec.get("lines").and_then(Value::as_u64) {
        (0..lines).map(|i| format!("l{i}")).collect::<Vec<_>>().join("\n")
    } else {
        text(&spec["unit"]).repeat(spec["count"].as_u64().unwrap() as usize)
    }
}

#[test]
fn the_paste_policy_and_the_reference_formats() {
    let golden = golden();
    for case in golden["policy"].as_array().unwrap() {
        let paste = policy_text(&case["spec"]);
        assert_eq!(pasted_text_line_count(&paste) as u64, case["lines"].as_u64().unwrap(), "{case}");
        assert_eq!(should_fold_pasted_text(&paste), case["fold"].as_bool().unwrap(), "{case}");
        assert_eq!(format_pasted_text_ref(7, &paste), text(&case["ref"]), "{case}");
    }
    for case in golden["formatImageRef"].as_array().unwrap() {
        assert_eq!(format_image_ref(case["id"].as_u64().unwrap()), text(&case["ref"]));
    }
    let ids = |value: &Value| -> Vec<u64> { value.as_array().unwrap().iter().map(|id| id.as_u64().unwrap()).collect() };
    for case in golden["imageRefs"].as_array().unwrap() {
        let mut expected = ids(&case["ids"]);
        expected.sort_unstable();
        assert_eq!(image_reference_ids(text(&case["input"])).into_iter().collect::<Vec<_>>(), expected, "{case}");
    }
    for case in golden["textRefs"].as_array().unwrap() {
        let mut expected = ids(&case["ids"]);
        expected.sort_unstable();
        assert_eq!(pasted_text_reference_ids(text(&case["input"])).into_iter().collect::<Vec<_>>(), expected, "{case}");
    }
}

fn content_json(content: &PromptContent) -> Value {
    match content {
        PromptContent::Text(text) => Value::String(text.clone()),
        PromptContent::Parts(parts) => Value::Array(
            parts
                .iter()
                .map(|part| match part {
                    PromptPart::Text(text) => serde_json::json!({ "type": "text", "text": text }),
                    PromptPart::Image { data, mime_type, paste_id } => {
                        serde_json::json!({ "type": "image", "data": data, "mimeType": mime_type, "pasteId": paste_id })
                    }
                })
                .collect(),
        ),
    }
}

#[test]
fn the_prompt_content_with_images() {
    for case in golden()["prompt"].as_array().unwrap() {
        let images: BTreeMap<u64, PastedImage> = case["images"]
            .as_array()
            .unwrap()
            .iter()
            .map(|image| {
                let id = image["id"].as_u64().unwrap();
                let field = |name: &str| image.get(name).and_then(Value::as_str).map(str::to_owned);
                (
                    id,
                    PastedImage {
                        id,
                        content: text(&image["content"]).to_owned(),
                        media_type: field("mediaType"),
                        metadata_text: field("metadataText"),
                    },
                )
            })
            .collect();
        let content = build_prompt_content_with_images(text(&case["text"]), &images);
        assert_eq!(content_json(&content), case["content"], "{case}");
    }
}

#[test]
fn the_path_candidates_of_a_paste() {
    for case in golden()["candidates"].as_array().unwrap() {
        let parts = split_pasted_image_path_candidates(text(&case["text"]), platform(&case["platform"]));
        let actual: Vec<Value> = parts.iter().map(|part| serde_json::json!({ "text": part.text, "imagePath": part.image_path })).collect();
        assert_eq!(Value::Array(actual), case["parts"], "{case}");
    }
}

#[test]
fn the_path_cleaning_and_the_image_type() {
    let golden = golden();
    for case in golden["cleanPath"].as_array().unwrap() {
        assert_eq!(clean_path_text(text(&case["value"]), platform(&case["platform"])), text(&case["cleaned"]), "{case}");
    }
    for case in golden["mime"].as_array().unwrap() {
        assert_eq!(mime_for_path(text(&case["path"])), case["mime"].as_str(), "{case}");
    }
}

#[test]
fn the_browser_opener() {
    let golden = golden();
    for case in golden["canOpen"].as_array().unwrap() {
        let env = env_of(&case["env"]);
        assert_eq!(can_open_browser(&env, platform(&case["platform"]), case["wsl"].as_bool().unwrap()), case["result"].as_bool().unwrap(), "{case}");
    }
    for case in golden["launchers"].as_array().unwrap() {
        let env = env_of(&case["env"]);
        let candidates = browser_candidates(platform(&case["platform"]), &env, case["wsl"].as_bool().unwrap(), text(&case["url"]));
        let actual: Vec<Value> = candidates.iter().map(|(program, args)| serde_json::json!([program, args])).collect();
        assert_eq!(Value::Array(actual), case["candidates"], "{case}");
    }
}

#[test]
fn the_macos_folder_script() {
    for case in golden()["macScript"].as_array().unwrap() {
        assert_eq!(macos_choose_script(text(&case["title"])), text(&case["script"]), "{case}");
    }
}

/// Opens the real Windows folder dialog. Run by hand: `cargo test --offline -p mixdog-term -- --ignored folder_dialog_manual`
/// (choose a folder, then once more and cancel); it prints what it was answered.
#[cfg(windows)]
#[test]
#[ignore = "opens the Windows folder dialog: run by hand"]
fn folder_dialog_manual() {
    let options = mixdog_term::os::FolderPickOptions { title: Some("mixdog folder picker check".to_owned()), initial_path: String::new() };
    let pick = mixdog_term::os::pick_folder(&options);
    println!("available: {}, path: {:?}", pick.available, pick.path);
    assert!(pick.available, "the dialog could not be shown");
}
