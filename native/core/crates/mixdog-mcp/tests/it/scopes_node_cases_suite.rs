//! Node's extension scope cases (`fixtures/extension-scopes-cases`, `record-extension-scopes-cases.mjs`): each recorded
//! input through `ExtensionScopes` (`from_config`, `projects`, `skill_allowed_for_cwd`, `set` and `to_config`, the
//! core's `withExtensionScope`) and `within_projects`, every answer against Node's. Named cases are left out.
#![allow(clippy::disallowed_methods, reason = "test fixture loading")]

use std::path::Path;

use mixdog_mcp::McpHub;
use mixdog_mcp::McpIo;
use mixdog_mcp::McpServerConfig;
use mixdog_mcp::result::OutputPolicy;
use mixdog_mcp::scopes::ExtensionScopes;
use mixdog_mcp::server::ServerState;
use mixdog_mcp::scopes::ScopeKind;
use mixdog_mcp::scopes::plan_extension_scope;
use mixdog_mcp::scopes::within_projects;
use mixdog_mcp::skill_deps::SkillToolDependencies;
use mixdog_mcp::skills::Skill;
use mixdog_mcp::skills::SkillSource;
use serde_json::Value;
use serde_json::json;

fn fixture(name: &str) -> Value {
    let text = match name {
        "golden.json" => mixdog_testkit::fixture!("../../fixtures/extension-scopes-cases/golden.json"),
        _ => mixdog_testkit::fixture!("../../fixtures/extension-scopes-cases/MANIFEST.json"),
    };
    serde_json::from_str(&text).unwrap()
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

/// A live hub of `scope` serving `servers` (`{name, tools, cfg}`: the mock server listing exactly `tools`, declared by
/// `cfg`'s plugin), every server ready.
async fn live_hub(dir: &Path, scope: &str, servers: &[(String, Vec<String>, Value)]) -> std::sync::Arc<McpHub> {
    let tokens = mixdog_rt::testing::tokens();
    let hub = McpHub::new(McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io }, dir.join("artifacts"), OutputPolicy::default());
    let env = std::env::vars().collect();
    let configs = servers
        .iter()
        .map(|(name, tools, cfg)| {
            let mut entry = json!({ "command": env!("CARGO_BIN_EXE_mixdog-mcp-mock-server"), "env": { "MOCK_TOOLS": serde_json::to_string(tools).unwrap() } });
            if let Some(cfg) = cfg.as_object() {
                entry.as_object_mut().unwrap().extend(cfg.clone());
            }
            McpServerConfig::from_entry(name, &entry, &env).unwrap()
        })
        .collect();
    hub.apply_in(scope, configs);
    for (name, _, _) in servers {
        let mut states = hub.server_in(scope, name).unwrap().subscribe();
        let ready = tokio::time::timeout(std::time::Duration::from_secs(20), states.wait_for(|state| matches!(&**state, ServerState::Ready(_)))).await;
        assert!(matches!(ready, Ok(Ok(_))), "waited 20 s for server {name} to become ready");
    }
    hub
}

/// The names of the hub's tools of `scope` the extension scopes let through at `cwd`, in the hub's order.
fn names_for_cwd(hub: &McpHub, scope: &str, scopes: &ExtensionScopes, cwd: &str) -> Vec<String> {
    hub.tools_for_cwd(scope, scopes, Path::new(cwd)).iter().map(|tool| tool.spec().name.clone()).collect()
}

fn servers_of(value: &Value) -> Vec<(String, Vec<String>, Value)> {
    value.as_array().unwrap().iter().map(|s| (s["name"].as_str().unwrap().to_owned(), strings(&s["tools"]), s["cfg"].clone())).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn every_recorded_extension_scope_answer_is_nodes() {
    let golden = fixture("golden.json");
    let excluded = fixture("MANIFEST.json")["excluded"].as_object().unwrap().clone();
    let cases = golden["cases"].as_array().unwrap();
    let mut failures = Vec::new();
    let mut replayed = 0;
    for case in cases.iter().filter(|c| !excluded.contains_key(c["case"].as_str().unwrap())) {
        let recorded = &case["recorded"];
        let got = match case["kind"].as_str().unwrap() {
            "mcpTools" => {
                let scopes = ExtensionScopes::from_config(&case["config"]);
                let checks: Vec<Value> = recorded["checks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|c| {
                        let allowed = scopes.mcp_server_allowed_for_cwd(c["server"].as_str().unwrap(), c["pluginId"].as_str(), Path::new(c["cwd"].as_str().unwrap()));
                        json!({ "server": c["server"], "cwd": c["cwd"], "pluginId": c["pluginId"], "allowed": allowed })
                    })
                    .collect();
                // Each MCP tool of the test's list served by its server; `mcpPluginId` is the declaring plugin.
                let mut servers: Vec<(String, Vec<String>, Value)> = Vec::new();
                for tool in case["tools"].as_array().unwrap() {
                    let Some((server, name)) = tool["name"].as_str().unwrap().strip_prefix("mcp__").and_then(|rest| rest.split_once("__")) else { continue };
                    let cfg = tool["mcpPluginId"].as_str().map_or(Value::Null, |id| json!({ "_mixdogPlugin": { "id": id, "key": "editor" } }));
                    servers.push((server.to_owned(), vec![name.to_owned()], cfg));
                }
                let dir = tempfile::tempdir().unwrap();
                let hub = live_hub(dir.path(), "scope-test", &servers).await;
                let filters: Vec<Value> = recorded["filters"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|f| {
                        let cwd = f["cwd"].as_str().unwrap();
                        json!({ "cwd": cwd, "names": names_for_cwd(&hub, "scope-test", &scopes, cwd) })
                    })
                    .collect();
                hub.close_all().await;
                // Declared in the manifest (`declared`): Node's filter passes the test's non-MCP `read` through untouched
                // (`filterMcpToolsForCwd`, extension-scopes.mjs:36-43); only its MCP names are the hub's.
                let want_filters: Vec<Value> = recorded["filters"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|f| json!({ "cwd": f["cwd"], "names": f["names"].as_array().unwrap().iter().filter(|n| n.as_str().unwrap().starts_with("mcp__")).collect::<Vec<_>>() }))
                    .collect();
                replayed += 1;
                let got = json!({ "checks": checks, "filters": filters });
                let want = json!({ "checks": recorded["checks"], "filters": want_filters });
                if got != want {
                    failures.push(format!("{}:\n  want {want}\n  got  {got}", case["case"]));
                }
                continue;
            }
            "live" => {
                let dir = tempfile::tempdir().unwrap();
                let hub = live_hub(dir.path(), "scope-test", &servers_of(&case["servers"])).await;
                let scoped = ExtensionScopes::from_config(&case["config"]["extensionScopes"]);
                let filters: Vec<Value> = recorded["filters"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|f| {
                        let scopes = if f["scoped"] == true { scoped.clone() } else { ExtensionScopes::default() };
                        let mut names = names_for_cwd(&hub, "scope-test", &scopes, f["cwd"].as_str().unwrap());
                        names.retain(|name| !name.contains("__mixdog_"));
                        names.sort();
                        json!({ "cwd": f["cwd"], "scoped": f["scoped"], "names": names })
                    })
                    .collect();
                hub.close_all().await;
                json!({ "filters": filters })
            }
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
    assert_eq!(replayed + excluded.len(), cases.len(), "every case is replayed or named");
}
