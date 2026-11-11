//! Node's extension scope cases (`fixtures/extension-scopes-cases`, `record-extension-scopes-cases.mjs`): each recorded
//! input through `ExtensionScopes` (`from_config`, `projects`, `skill_allowed_for_cwd`, `set` and `to_config`, the
//! core's `withExtensionScope`) and `within_projects`, every answer against Node's. Named cases are left out.
#![allow(clippy::disallowed_methods, reason = "test fixture loading")]

use std::path::Path;

use mixdog_mcp::scopes::ExtensionScopes;
use mixdog_mcp::scopes::ScopeKind;
use mixdog_mcp::scopes::plan_extension_scope;
use mixdog_mcp::scopes::within_projects;
use mixdog_mcp::skill_deps::SkillToolDependencies;
use mixdog_mcp::skills::Skill;
use mixdog_mcp::skills::SkillSource;
use serde_json::Value;
use serde_json::json;

fn fixture(name: &str) -> Value {
    let path = format!("{}/../../fixtures/extension-scopes-cases/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn kind(text: &str) -> ScopeKind {
    match text {
        "skills" => ScopeKind::Skills,
        "mcp" => ScopeKind::Mcp,
        "plugins" => ScopeKind::Plugins,
        other => panic!("kind {other}"),
    }
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect()
}

#[test]
fn every_recorded_extension_scope_answer_is_nodes() {
    let golden = fixture("golden.json");
    let excluded = fixture("MANIFEST.json")["excluded"].as_object().unwrap().clone();
    let cases = golden["cases"].as_array().unwrap();
    let mut failures = Vec::new();
    let mut replayed = 0;
    for case in cases.iter().filter(|c| !excluded.contains_key(c["case"].as_str().unwrap())) {
        let recorded = &case["recorded"];
        let got = match case["kind"].as_str().unwrap() {
            "normalize" => {
                let scopes = ExtensionScopes::from_config(&case["input"]);
                let lookups: Vec<Value> = recorded["lookups"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|l| {
                        let (k, n) = (l["kind"].as_str().unwrap(), l["name"].as_str().unwrap());
                        json!({ "kind": k, "name": n, "projects": scopes.projects(kind(k), n) })
                    })
                    .collect();
                json!({ "scopes": scopes.to_config(), "lookups": lookups })
            }
            "within" => {
                let checks: Vec<Value> = recorded["checks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|c| json!({ "cwd": c["cwd"], "roots": c["roots"], "within": within_projects(Path::new(c["cwd"].as_str().unwrap()), &strings(&c["roots"])) }))
                    .collect();
                json!({ "checks": checks })
            }
            "skills" => {
                let scopes = ExtensionScopes::from_config(&case["config"]);
                let checks: Vec<Value> = recorded["checks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|c| {
                        let skill = Skill {
                            name: c["skill"]["name"].as_str().unwrap().to_owned(),
                            description: String::new(),
                            when_to_use: String::new(),
                            file_path: Default::default(),
                            source: if c["plugin"].is_null() { SkillSource::Global } else { SkillSource::Plugin },
                            plugin: c["plugin"].as_str().map(str::to_owned),
                            requires: Vec::new(),
                            tool_dependencies: SkillToolDependencies::none(),
                        };
                        let allowed = scopes.skill_allowed_for_cwd(&skill, Path::new(c["cwd"].as_str().unwrap()));
                        json!({ "skill": c["skill"], "plugin": c["plugin"], "cwd": c["cwd"], "allowed": allowed })
                    })
                    .collect();
                json!({ "checks": checks })
            }
            "set" => {
                let mut configs = std::collections::HashMap::from([("config", case["config"].clone())]);
                let steps: Vec<Value> = recorded["steps"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|s| {
                        let from = configs[s["from"].as_str().unwrap()].clone();
                        // A skill scope is set through the setup's own planner; the planner refuses MCP kinds (they are
                        // switched off per project), so clearing the MCP entry goes through the scope map it writes.
                        let next = if s["kind"] == "mcp" {
                            let mut scopes = ExtensionScopes::from_config(from.get("extensionScopes").unwrap_or(&Value::Null));
                            assert!(strings(&s["projects"]).is_empty());
                            scopes.set(ScopeKind::Mcp, s["name"].as_str().unwrap(), Vec::new());
                            let mut next = from.as_object().unwrap().clone();
                            next.insert("extensionScopes".into(), scopes.to_config());
                            Value::Object(next)
                        } else {
                            plan_extension_scope(&from, &s["kind"], &s["name"], &s["projects"], &[]).unwrap().config
                        };
                        configs.insert("scoped", next.clone());
                        json!({ "from": s["from"], "kind": s["kind"], "name": s["name"], "projects": s["projects"], "result": next })
                    })
                    .collect();
                json!({ "steps": steps })
            }
            "unknownKind" => {
                let error = plan_extension_scope(&json!({}), &json!("agents"), &json!("x"), &json!([]), &[]).unwrap_err();
                json!({ "error": error.to_string() })
            }
            other => panic!("{}: kind {other} has no replay and no exclusion", case["case"]),
        };
        replayed += 1;
        if &got != recorded {
            failures.push(format!("{}:\n  want {recorded}\n  got  {got}", case["case"]));
        }
    }
    assert!(failures.is_empty(), "{} case(s) differ:\n{}", failures.len(), failures.join("\n"));
    assert_eq!(replayed + excluded.len(), cases.len() + 2, "the two GAP cases are named without a recording");
}
