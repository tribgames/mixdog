//! Node's skill tool-dependency cases (`fixtures/skill-tool-loading-cases`,
//! `record-skill-tool-loading-cases.mjs`, the cases of `skill-tool-loading.test.mjs`): each recorded step
//! run again here in order — the surface built and rebuilt by [`ToolSurface`], a skill's dependencies armed
//! by [`HeaderSkillArm`] over the session as its header, a bundled SKILL.md read by
//! [`mixdog_mcp::skills::parse_document`] — and the whole session after each step (and an arm's whole Skill
//! result, a parse's whole document) against Node's.

use mixdog_core_session::session::NoRouteExclusions;

use mixdog_core::run_host::tool_surface::{ApplyOptions, ToolSurface};
use super::*;

fn golden() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/skill-tool-loading-cases/golden.json")).expect("json")
}

/// The bridge's own definitions (`TOOL_BRIDGE_TOOLS`) and no connected server.
struct Bridge(Vec<Value>);

impl SurfaceHost for Bridge {
    fn bridge_tools(&self) -> Vec<Value> {
        self.0.clone()
    }
    fn mcp_server_instructions(&self, _: Option<&str>) -> Value {
        Value::Null
    }
}

fn strings_of(value: &Value) -> Vec<String> {
    value.as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
}

#[tokio::test]
async fn every_recorded_skill_tool_loading_step_leaves_what_node_left() {
    let golden = golden();
    let bridge = Arc::new(Bridge(golden["bridgeTools"].as_array().expect("bridge tools").clone()));
    let surface = ToolSurface { host: bridge.as_ref(), clock: &Now };
    let cases = golden["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 7, "every case of the Node test");
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let mut session = Value::Null;
        for (index, step) in case["steps"].as_array().expect("steps").iter().enumerate() {
            let at = format!("{name}: step {index} ({})", step["op"]);
            match step["op"].as_str().expect("op") {
                "open" => {
                    let mode = step["mode"].as_str().expect("mode");
                    session = json!({ "provider": step["provider"], "tools": step["tools"], "messages": [], "toolSpec": mode });
                    surface.apply(&mut session, mode, &[], &ApplyOptions::default());
                }
                "set" => session.as_object_mut().expect("session").extend(step["patch"].as_object().expect("patch").clone()),
                "apply" => {
                    let options = ApplyOptions { disallowed: strings_of(&step["options"]["disallowed"]), ..ApplyOptions::default() };
                    surface.apply(&mut session, step["mode"].as_str().expect("mode"), step["extra"].as_array().expect("extra"), &options);
                }
                "rebuild" => surface.rebuild_for_provider(&mut session, step["provider"].as_str().expect("provider")),
                "arm" => {
                    let store = Store::of(&session);
                    let arm = HeaderSkillArm::new(store.clone(), store.clone(), Arc::new(NoRouteExclusions), Arc::new(Switches::default()), bridge.clone(), Arc::new(Now));
                    let notice = arm.arm(&thread(), &dependencies(&step["dependencies"], &json!([]))).await.expect("armed");
                    assert_eq!(notice.result(step["head"].as_str().expect("head")), step["result"].as_str().expect("result"), "{at}: the Skill result");
                    session = Value::Object(store.snapshot());
                }
                "parse" => {
                    let document = mixdog_mcp::skills::parse_document(step["text"].as_str().expect("text")).expect("a skill document");
                    let parsed = json!({ "name": document.name, "description": document.description, "whenToUse": document.when_to_use, "body": document.body, "frontmatter": document.frontmatter });
                    assert_eq!(parsed, step["parsed"], "{at}");
                    continue;
                }
                other => panic!("{at}: unknown step {other}"),
            }
            assert_eq!(session, step["session"], "{at}: the session");
        }
    }
}
