//! `skill_frontmatter` against what today's Node product wrote (`tests/golden/skillfm.mjs` →
//! `skillfm.json`): `createSkillDocument` and `updateSkillDocument` over frontmatter in many
//! styles. Where Node prints the untouched frontmatter back unchanged (`stable`) the output must
//! match byte for byte; where Node also reformats text the edit never touches, the output must
//! carry the same data and the same body, because the writer keeps those bytes as they were.

use mixdog_mcp::skill_frontmatter::Fields;
use mixdog_mcp::skill_frontmatter::create_document;
use mixdog_mcp::skill_frontmatter::update_document;
use mixdog_mcp::skills::parse_document;
use serde_json::Value;

/// Frontmatter Node prints whole again (a flow mapping): the output must match byte for byte.
const REPRINTED: &[&str] = &["flowMap", "fuzzFlow"];

fn text<'a>(case: &'a Value, key: &str) -> &'a str {
    case[key].as_str().unwrap_or_default()
}

#[test]
fn every_edit_writes_what_node_writes() {
    let golden: Value = serde_json::from_str(include_str!("golden/skillfm.json")).unwrap();
    let cases = golden["cases"].as_array().unwrap();
    let mut exact = 0;
    let mut by_data = 0;
    let mut failures = Vec::new();
    for case in cases {
        let label = text(case, "label");
        let fields = Fields {
            name: text(&case["fields"], "name"),
            description: text(&case["fields"], "description"),
            when_to_use: text(&case["fields"], "whenToUse"),
        };
        let body = text(case, "body");
        let got = match case["markdown"].as_str() {
            None => create_document(&fields, body),
            Some(markdown) => update_document(markdown, &fields, body),
        };
        if let Some(expected) = case["error"].as_str() {
            match got {
                Err(error) => {
                    let message = error.to_string();
                    // The YAML parsers word their syntax errors differently.
                    let same = message == expected
                        || (expected.starts_with("Invalid SKILL.md frontmatter:") && message.starts_with("Invalid SKILL.md frontmatter:"));
                    if !same {
                        failures.push(format!("{label}: error {message:?}, Node {expected:?}"));
                    }
                }
                Ok(output) => failures.push(format!("{label}: wrote {output:?}, Node failed with {expected:?}")),
            }
            continue;
        }
        let expected = text(case, "output");
        let output = match got {
            Ok(output) => output,
            Err(error) => {
                failures.push(format!("{label}: failed with {error}, Node wrote {expected:?}"));
                continue;
            }
        };
        if output == expected {
            exact += 1;
        } else if case["stable"] == Value::Bool(false) && !REPRINTED.iter().any(|p| label.starts_with(p)) {
            match (parse_document(&output), parse_document(expected)) {
                (Ok(a), Ok(b)) if a == b => by_data += 1,
                // The data readers here cannot parse U+2028 in a block scalar; the text decides.
                (Err(a), Err(b)) if a == b && expected.contains('\u{2028}') => by_data += 1,
                (a, b) => failures.push(format!("{label}: data differs\n  got {output:?}\n  node {expected:?}\n  {a:?}\n  {b:?}")),
            }
        } else {
            failures.push(format!("{label}:\n  got  {output:?}\n  node {expected:?}"));
        }
    }
    assert!(failures.is_empty(), "{} of {} cases differ ({exact} exact, {by_data} by data):\n{}", failures.len(), cases.len(), failures.iter().take(25).cloned().collect::<Vec<_>>().join("\n"));
}
