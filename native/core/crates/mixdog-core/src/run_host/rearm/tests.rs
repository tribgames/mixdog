//! The re-arm ports against Node's functions over the recorded sessions
//! (`fixtures/rearm/golden.json`, `record-rearm.mjs`): the same return value and the same session.

use serde_json::{Value, json};

use super::*;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/rearm/golden.json")).expect("fixture")
}

fn header(session: &Value) -> Header {
    session.as_object().expect("a session object").clone()
}

#[test]
fn every_recorded_session_is_rearmed_as_node_does() {
    let golden = golden();
    let now = golden["now"].as_i64().unwrap();
    let (mut differ, mut checked) = (Vec::new(), 0);
    for case in golden["cases"].as_array().unwrap() {
        let mut session = header(&case["session"]);
        let returned = match case["kind"].as_str().unwrap() {
            "tools" => rearm_late_deferred_tools(&mut session, now).map_or(Value::Null, |names| json!(names)),
            _ => json!(rearm_prompt_settings_notice(&mut session)),
        };
        if returned != case["returned"] || Value::Object(session.clone()) != case["after"] {
            differ.push(format!("{}: Rust {returned} {}, Node {} {}", case["name"], Value::Object(session), case["returned"], case["after"]));
        }
        checked += 1;
    }
    assert!(checked >= 30, "{checked}");
    assert!(differ.is_empty(), "{} differ: {}", differ.len(), differ.iter().take(5).cloned().collect::<Vec<_>>().join(" ; "));
}
