//! Node's rebuild cases (`fixtures/tool-catalog-rebuild-cases`, `record-tool-catalog-rebuild-cases.mjs`,
//! the cases of `tool-catalog-rebuild.test.mjs`): each recorded open, change and apply run again through
//! [`ToolSurface::apply`] and the whole session afterwards against Node's, each union through
//! [`ToolSurface::catalog_union`] whole. The `render` and `select` steps are named in the manifest.

use super::*;

fn golden() -> Value {
    #[allow(clippy::disallowed_methods)] // the recording, read at run time
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/tool-catalog-rebuild-cases/golden.json")).expect("the recording");
    serde_json::from_str(&text).expect("json")
}

#[test]
fn every_recorded_rebuild_step_leaves_what_node_left() {
    let golden = golden();
    let host = Host(Vec::new());
    let surface = ToolSurface { host: &host, clock: &Fixed };
    let cases = golden["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 8, "every case of the Node test");
    let mut replayed = 0;
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let mut session = Value::Null;
        for (index, step) in case["steps"].as_array().expect("steps").iter().enumerate() {
            let at = format!("{name}: step {index} ({})", step["op"]);
            match step["op"].as_str().expect("op") {
                "open" => {
                    session = json!({ "provider": step["provider"], "tools": step["tools"], "messages": [] });
                    surface.apply(&mut session, "lead", &[], &ApplyOptions::default());
                }
                "set" => session.as_object_mut().expect("session").extend(step["patch"].as_object().expect("patch").clone()),
                "apply" => {
                    let disallowed = step["options"]["disallowed"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
                    let options = ApplyOptions { disallowed, ..ApplyOptions::default() };
                    surface.apply(&mut session, step["mode"].as_str().expect("mode"), step["extra"].as_array().expect("extra"), &options);
                }
                "union" => {
                    assert_eq!(Value::Array(surface.catalog_union(&session)), step["result"], "{at}");
                    replayed += 1;
                    continue;
                }
                // Named in the manifest: Node's native `load_tool` selection. Node's session after it
                // carries on, as the test's next steps read it.
                "render" | "select" => {
                    session = step["session"].clone();
                    continue;
                }
                other => panic!("{at}: unknown step {other}"),
            }
            assert_eq!(session, step["session"], "{at}: the session");
            replayed += 1;
        }
    }
    assert_eq!(replayed, 32, "every open, set, apply and union step");
}
