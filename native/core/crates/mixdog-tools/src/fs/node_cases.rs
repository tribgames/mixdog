//! What Node answers for the file tools' helpers its own tests assert (`fixtures/tools-untested/fs-*.json`,
//! `record-tools-untested.mjs`), replayed whole and in the recorded order.

use super::common::{cap_marker, format_cap_size, window_marker};
use super::read_legacy::{cap_shell_output, text_stats};
use serde_json::Value;

fn recorded(text: &str) -> Value {
    serde_json::from_str(text).expect("recording")
}

#[test]
fn output_markers_read_as_node_writes_them() {
    let doc = recorded(mixdog_testkit::fixture!("../../fixtures/tools-untested/fs-markers.json"));
    let mut failures = Vec::new();
    for case in doc["sizes"].as_array().unwrap() {
        let got = format_cap_size(case["bytes"].as_u64().unwrap() as usize);
        if got != case["text"].as_str().unwrap() {
            failures.push(format!("size {}: Node {:?}, here {got:?}", case["bytes"], case["text"]));
        }
    }
    for case in doc["windows"].as_array().unwrap() {
        let input = &case["input"];
        let got = window_marker(
            input.get("unit").and_then(Value::as_str).unwrap_or("lines"),
            input["from"].as_u64().unwrap(),
            input["to"].as_u64().unwrap(),
            input.get("total").and_then(Value::as_u64),
            input.get("nextOffset").and_then(Value::as_u64),
            input.get("capBytes").and_then(Value::as_u64).map(|n| n as usize),
        );
        if got != case["text"].as_str().unwrap() {
            failures.push(format!("window {input}: Node {:?}, here {got:?}", case["text"]));
        }
    }
    for case in doc["caps"].as_array().unwrap() {
        let input = &case["input"];
        let limit = match &input["limit"] {
            Value::String(label) => label.clone(),
            bytes => format_cap_size(bytes.as_u64().unwrap() as usize),
        };
        let got = cap_marker(
            &limit,
            input.get("shown").and_then(Value::as_str).unwrap_or(""),
            input.get("nextOffset").and_then(Value::as_u64),
            input.get("narrow").and_then(Value::as_str).unwrap_or(""),
        );
        if got != case["text"].as_str().unwrap() {
            failures.push(format!("cap {input}: Node {:?}, here {got:?}", case["text"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// Node's `list` over a folder of 101 files: the default page of 100 with its continuation, the explicit limits and offsets.
#[tokio::test]
async fn list_pages_as_node_pages_it() {
    use mixdog_core_api::domain::common::AbsPath;
    use mixdog_core_api::domain::tool::Tool as _;
    use std::sync::Arc;
    let doc = recorded(mixdog_testkit::fixture!("../../fixtures/tools-untested/fs-list-page.json"));
    let dir = tempfile::tempdir().unwrap();
    let ws = dir.path().join("ws");
    mixdog_testkit::create_dir_all(&ws);
    for index in 0..doc["count"].as_u64().unwrap() {
        mixdog_testkit::write(ws.join(format!("entry-{index:03}.txt")), b"ok");
    }
    let root = AbsPath::new(&ws).unwrap();
    let ctx = super::tests::context_seeded(&root, Arc::new(mixdog_workspace::localfs::LocalFileService::new()), Vec::new()).await;
    let list = super::ListTool::new();
    let raw = ws.to_string_lossy().into_owned();
    let fwd = raw.replace('\\', "/");
    let mut failures = Vec::new();
    for call in doc["calls"].as_array().unwrap() {
        let args: Value = serde_json::from_str(&call["input"].to_string().replace("<ROOT>", &fwd)).unwrap();
        let (is_error, text) = super::tests::text_of(list.call(&ctx, super::tests::schema_args("list", args)).await);
        let text = text.replace(&raw, "<ROOT>").replace(&fwd, "<ROOT>");
        if text != call["text"].as_str().unwrap() || is_error != call["isError"].as_bool().unwrap() {
            failures.push(format!("{}:\n  Node ({}) {:?}\n  here ({is_error}) {text:?}", call["input"], call["isError"], call["text"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn v4a_patches_are_parsed_as_node_parses_them() {
    use super::patch_hunk::Kind;
    let doc = recorded(mixdog_testkit::fixture!("../../fixtures/tools-untested/fs-patch-parse.json"));
    let mut failures = Vec::new();
    for case in doc["patches"].as_array().unwrap() {
        let got = super::patch_parse::parse_v4a(case["patch"].as_str().unwrap()).map(|sections| {
            Value::Array(
                sections
                    .iter()
                    .map(|s| {
                        serde_json::json!({
                            "kind": match s.kind { Kind::Update => "update", Kind::Add => "add", Kind::Delete => "delete" },
                            "path": s.path,
                            "movePath": s.move_path,
                            "lines": s.lines,
                            "hunks": s.hunks.iter().map(|h| serde_json::json!({"anchors": h.anchors, "lines": h.lines, "endOfFile": h.eof})).collect::<Vec<_>>(),
                        })
                    })
                    .collect(),
            )
        });
        let ok = match (&got, case.get("error")) {
            (Ok(files), None) => *files == case["files"],
            (Err(message), Some(want)) => want == message.as_str(),
            _ => false,
        };
        if !ok {
            failures.push(format!("{:?}:\n  Node {}\n  here {got:?}", case["patch"], case.get("files").or(case.get("error")).unwrap()));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn shell_output_is_capped_and_counted_as_node_caps_and_counts_it() {
    let doc = recorded(mixdog_testkit::fixture!("../../fixtures/tools-untested/fs-shell-output.json"));
    let mut failures = Vec::new();
    for case in doc["caps"].as_array().unwrap() {
        let input = case["input"].as_str().unwrap();
        let got = cap_shell_output(input);
        if got != case["output"].as_str().unwrap() {
            failures.push(format!("a {}-byte output of {} lines: Node answers {} bytes, here {} bytes", input.len(), input.split('\n').count(), case["output"].as_str().unwrap().len(), got.len()));
        }
    }
    for case in doc["textStats"].as_array().unwrap() {
        let stats = &case["stats"];
        let want = format!("lines\t{}\twords\t{}\tbytes\t{}", stats["lines"], stats["words"], stats["bytes"]);
        let got = text_stats(case["text"].as_str().unwrap(), case["bytes"].as_u64().unwrap());
        if got != want {
            failures.push(format!("stats of {}: Node {want:?}, here {got:?}", case["text"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
