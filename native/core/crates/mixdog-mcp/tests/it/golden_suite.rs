//! Goldens recorded from today's Node client (`tests/golden/generate.mjs` → `node.json`): the
//! provider-safe tool names, the result normalization and the output cap.

use base64::Engine;
use mixdog_core_api::domain::tool::ImageData;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_mcp::naming::qualified_tool_name;
use mixdog_mcp::result::OutputPolicy;
use mixdog_mcp::result::Part;
use mixdog_mcp::result::Spiller;
use mixdog_mcp::result::cap_parts;
use mixdog_mcp::result::map_call_result;
use mixdog_mcp::result::normalize_parts;
use serde_json::Value;

fn golden() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("tests/golden/node.json")).unwrap()
}

fn spiller() -> (tempfile::TempDir, Spiller) {
    let dir = tempfile::tempdir().unwrap();
    let spiller = Spiller::new(dir.path().to_path_buf(), mixdog_rt::testing::tokens().durability_io);
    (dir, spiller)
}

#[test]
fn qualified_names_equal_nodes() {
    for case in golden()["names"].as_array().unwrap() {
        let (server, tool) = (case["server"].as_str().unwrap(), case["tool"].as_str().unwrap());
        assert_eq!(qualified_tool_name(server, tool, 64), case["expected"].as_str().unwrap(), "{server:?} {tool:?}");
    }
}

#[test]
fn skill_manifest_equals_nodes() {
    use mixdog_mcp::skill_deps::DependencySource;
    use mixdog_mcp::skill_deps::SkillToolDependencies;
    use mixdog_mcp::skills::Skill;
    use mixdog_mcp::skills::SkillSource;
    use mixdog_mcp::skills::build_manifest;
    for case in golden()["manifests"].as_array().unwrap() {
        let skills: Vec<Skill> = case["skills"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| Skill {
                name: s["name"].as_str().unwrap().to_owned(),
                description: String::new(),
                when_to_use: s["whenToUse"].as_str().unwrap().to_owned(),
                file_path: std::path::PathBuf::new(),
                source: SkillSource::Global,
                plugin: None,
                requires: Vec::new(),
                tool_dependencies: SkillToolDependencies {
                    tool_dependencies: s["toolDependencies"].as_array().unwrap().clone(),
                    declared: Vec::new(),
                    source: DependencySource::Declaration,
                    issues: Vec::new(),
                },
            })
            .collect();
        let refs: Vec<&Skill> = skills.iter().collect();
        let options = &case["options"];
        let got = build_manifest(
            &refs,
            options["limit"].as_u64().map_or(80, |n| n as usize),
            options["charBudget"].as_u64().map_or(8_000, |n| n as usize),
        );
        assert_eq!(got, case["expected"].as_str().unwrap(), "{}", case["options"]);
    }
}

#[test]
fn outbound_classification_equals_nodes() {
    let cases = golden()["outbound"].as_array().unwrap().clone();
    assert!(cases.len() > 3000);
    for case in cases {
        let flag = |key: &str| case["hints"][key] == true;
        let got = mixdog_mcp::outbound::outbound_kind(
            None,
            case["server"].as_str().unwrap(),
            case["tool"].as_str().unwrap(),
            &case["args"],
            mixdog_mcp::outbound::Hints { read_only: flag("readOnlyHint"), outbound: flag("outboundHint") },
        );
        let want = case["expected"].as_str().map(|name| mixdog_mcp::config::parse_action_kind(name).unwrap());
        assert_eq!(got, want, "{case}");
    }
}

#[tokio::test]
async fn normalization_equals_nodes() {
    let (_dir, spiller) = spiller();
    for case in golden()["normalize"].as_array().unwrap() {
        let (input, expected) = (&case["input"], &case["expected"]);
        if input["isError"] == true {
            let mapped = map_call_result(input, OutputPolicy::default(), &spiller).await;
            if let Some(want) = expected.as_str() {
                // Node's `Error: …` string: the call's reported error.
                assert_eq!(mapped.unwrap_err().text, want, "{input}");
                continue;
            }
            // Node's structured result (an `isError` with media): the parts, in order, as a result.
            let output = mapped.unwrap_or_else(|e| panic!("{input}: a structured result, not the error {}", e.text));
            let want = expected["content"].as_array().unwrap();
            assert_eq!(output.parts.len(), want.len(), "{input}");
            for (part, want) in output.parts.iter().zip(want) {
                match part {
                    ToolPart::Text(text) => assert_eq!((want["type"].as_str(), text.as_str()), (Some("text"), want["text"].as_str().unwrap()), "{input}"),
                    ToolPart::Image { mime, data: ImageData::Bytes(bytes) } => {
                        assert_eq!((want["type"].as_str(), mime.as_str()), (Some("image"), want["mimeType"].as_str().unwrap()), "{input}");
                        assert_eq!(*bytes, base64::engine::general_purpose::STANDARD.decode(want["data"].as_str().unwrap()).unwrap(), "{input}");
                    }
                    other => panic!("{input}: {other:?}"),
                }
            }
            continue;
        }
        let parts = normalize_parts(input, &spiller).await;
        match expected {
            Value::Null => assert_eq!(parts, vec![Part::Text(String::new())], "{input}"),
            Value::String(text) => assert_eq!(parts, vec![Part::Text(text.clone())], "{input}"),
            other => {
                let want = other["content"].as_array().unwrap();
                assert_eq!(parts.len(), want.len(), "{input}");
                for (part, want) in parts.iter().zip(want) {
                    match part {
                        Part::Text(text) => assert_eq!(text, want["text"].as_str().unwrap(), "{input}"),
                        Part::Image { mime, bytes } => {
                            assert_eq!(mime, want["mimeType"].as_str().unwrap());
                            let data = base64::engine::general_purpose::STANDARD.decode(want["data"].as_str().unwrap()).unwrap();
                            assert_eq!(*bytes, data);
                        }
                        Part::File(_) => panic!("{input}"),
                    }
                }
            }
        }
    }
}

fn rows(count: usize, width: usize) -> String {
    (1..=count).map(|i| format!("line {i}{}", "x".repeat(width))).collect::<Vec<_>>().join("\n")
}

fn blank_spill(text: &str) -> String {
    match text.find("spilled to ") {
        Some(start) => {
            let from = start + "spilled to ".len();
            let to = from + text[from..].find(']').unwrap();
            format!("{}<SPILL>{}", &text[..from], &text[to..])
        }
        None => text.to_owned(),
    }
}

#[tokio::test]
async fn output_cap_equals_nodes() {
    let (dir, spiller) = spiller();
    for case in golden()["caps"].as_array().unwrap() {
        let parts: Vec<Part> = case["spec"]["parts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                if p["image"] == true {
                    Part::Image { mime: "image/png".to_owned(), bytes: b"hi".to_vec() }
                } else if let Some(n) = p["bigLine"].as_u64() {
                    Part::Text("x".repeat(n as usize))
                } else {
                    Part::Text(rows(p["rows"].as_u64().unwrap() as usize, p["width"].as_u64().unwrap_or(0) as usize))
                }
            })
            .collect();
        let (capped, _) = cap_parts(parts, OutputPolicy::default(), &spiller).await;
        let want = case["expected"].as_array().unwrap();
        assert_eq!(capped.len(), want.len(), "{}", case["spec"]);
        for (part, want) in capped.iter().zip(want) {
            match part {
                Part::Text(text) => assert_eq!(blank_spill(text), want["text"].as_str().unwrap(), "{}", case["spec"]),
                Part::Image { .. } => assert_eq!(want["type"], "image"),
                Part::File(_) => panic!(),
            }
        }
    }
    drop(dir);
}
