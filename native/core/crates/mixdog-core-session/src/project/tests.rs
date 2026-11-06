//! The `project/*` methods against the Node recording (`fixtures/project-methods/golden.json`,
//! made by `benchmarks/rust-core/recorders/record-project-methods.mjs` from the real 1.4.5
//! functions over a fixture repository and data dir). Each replayed step runs through the
//! service's wire entry and must answer what Node answered, with temp paths, commit ids and times
//! masked the same way. The recorded steps that need a live session or an owned worktree row are
//! not replayed here: they need the session runtime's scripted host.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "tests drive git and the disk directly")]

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::service::DomainService;
use mixdog_core_base::support::testing;
use mixdog_mcp::permissions::PolicyIo;
use mixdog_scm::error::ScmFailure;
use mixdog_scm::worktree::maintenance::SessionActivity;
use mixdog_scm::worktree::maintenance::SessionSource;
use mixdog_scm::worktree::maintenance::ShellJob;
use serde_json::Value;
use serde_json::json;

use super::connectors::InstalledConnectors;
use super::connectors::ProjectConnectors;
use super::service::ProjectService;
use super::service::Registry;
use crate::session::worktree::worktree_tests::git;
use crate::session::worktree::worktree_tests::rig;

struct One(String);

#[async_trait]
impl Registry for One {
    async fn registered(&self, path: &str) -> Result<Option<String>, String> {
        Ok((path == self.0).then(|| self.0.clone()))
    }
}

struct Installed;

impl InstalledConnectors for Installed {
    fn ids(&self) -> Vec<String> {
        vec!["gmail".into(), "github".into(), "notion".into()]
    }
}

/// No stored, favorite, archived or running session: the listings only count rows.
struct NoSessions;

#[async_trait]
impl SessionSource for NoSessions {
    async fn stored_session_ids(&self) -> Result<HashSet<String>, ScmFailure> {
        Ok(HashSet::new())
    }

    async fn favorites(&self) -> Option<HashSet<String>> {
        None
    }

    async fn archived(&self) -> Option<HashSet<String>> {
        None
    }

    async fn activity(&self, _ids: &[String]) -> HashMap<String, SessionActivity> {
        HashMap::new()
    }

    async fn running_jobs(&self) -> Result<Vec<ShellJob>, ScmFailure> {
        Ok(Vec::new())
    }
}

fn goldens() -> Vec<Value> {
    let all: Value = serde_json::from_str(include_str!("../../../../fixtures/project-methods/golden.json")).expect("golden.json parses");
    all["steps"].as_array().expect("steps").clone()
}

/// The recorder's `mask`: paths, commit ids and times.
struct Mask {
    roots: Vec<(String, &'static str)>,
    sha: regex::Regex,
    time: regex::Regex,
}

fn slashes(path: impl AsRef<std::path::Path>) -> String {
    path.as_ref().to_string_lossy().replace('\\', "/")
}

impl Mask {
    fn text(&self, text: &str) -> String {
        let mut out = text.replace('\\', "/");
        for (root, label) in &self.roots {
            out = out.replace(root.as_str(), label);
        }
        let out = self.sha.replace_all(&out, "<sha>").into_owned();
        self.time.replace_all(&out, "<time>").into_owned()
    }

    fn value(&self, value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.text(text)),
            Value::Array(items) => Value::Array(items.iter().map(|item| self.value(item)).collect()),
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(key, item)| {
                        let timed = matches!(key.as_str(), "createdAt" | "updatedAt" | "lastActiveAt" | "committedAt" | "archivedAt" | "lastUsedAt") && item.is_number();
                        (self.text(key), if timed { json!("<ms>") } else { self.value(item) })
                    })
                    .collect(),
            ),
            other => other.clone(),
        }
    }
}

/// `{ ok }` or `{ error: { code, message, details } }`, as the recorder's `step` stored a throw.
fn answer(result: Result<Value, CoreError>) -> Value {
    match result {
        Ok(value) => json!({ "ok": value }),
        Err(CoreError::DomainError { code, message, detail, .. }) => {
            let details = match detail.map(|detail| serde_json::to_value(&*detail)) {
                Some(Ok(Value::Object(mut fields))) => {
                    fields.remove("type");
                    if fields.is_empty() { Value::Null } else { Value::Object(fields) }
                }
                _ => Value::Null,
            };
            json!({ "error": { "code": code.as_deref(), "message": message.as_deref(), "details": details } })
        }
        Err(other) => panic!("a failure Node has no counterpart for: {other:?}"),
    }
}

struct Replay {
    service: ProjectService,
    golden: Vec<Value>,
    mask: Mask,
    ops: u64,
}

impl Replay {
    async fn run(&mut self, method: &'static str, mut params: Value, mutation: bool) -> Value {
        if mutation {
            self.ops += 1;
            params = testing::with_op(params, self.ops);
        }
        let result = match self.service.call(testing::request(method, params, mutation.then_some(self.ops))).await {
            Ok(Reply::Value(value)) => Ok(value),
            Ok(_) => panic!("never subscribes"),
            Err(error) => Err(error),
        };
        answer(result)
    }

    fn check(&self, name: &str, raw: &Value) {
        let mut actual = self.mask.value(raw);
        actual["name"] = json!(name);
        let want = self.golden.iter().find(|step| step["name"] == name).unwrap_or_else(|| panic!("no recorded step {name}"));
        assert_eq!(&actual, want, "step {name}");
    }

    /// Runs `method` and asserts it answers what Node recorded under `name`.
    async fn step(&mut self, name: &str, method: &'static str, params: Value, mutation: bool) -> Value {
        let raw = self.run(method, params, mutation).await;
        self.check(name, &raw);
        raw
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn branch_worktree_and_connector_steps_equal_nodes() {
    let rig = rig();
    let repo = rig.repo.to_string_lossy().into_owned();
    git(&rig.repo, &["branch", "dev"]);
    git(&rig.repo, &["checkout", "-q", "-b", "topic"]);
    std::fs::write(rig.repo.join("t.txt"), "t\n").unwrap();
    git(&rig.repo, &["add", "."]);
    git(&rig.repo, &["commit", "-q", "-m", "topic work"]);
    git(&rig.repo, &["checkout", "-q", "main"]);

    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let io = PolicyIo { maintenance: tokens.maintenance_io, interactive: tokens.interactive_io, durability: tokens.durability_io };
    let registry = Arc::new(One(repo.clone()));
    let connector_data = dir.path().join("connector-data");
    std::fs::create_dir_all(&connector_data).unwrap();
    let connectors = ProjectConnectors::new(registry.clone(), Arc::new(Installed), &connector_data, io);
    let ops = testing::scopes(dir.path(), "project").await;
    let service = ProjectService::new(registry, rig.worktrees.clone(), rig.ws.clone(), Arc::new(NoSessions), Arc::new(HashSet::new), connectors, ops);
    let base = rig.repo.parent().unwrap().to_path_buf();
    let mask = Mask {
        roots: vec![(slashes(&rig.repo), "<repo>"), (slashes(&rig.data), "<data>"), (slashes(&connector_data), "<connector-data>"), (slashes(&base), "<base>")],
        sha: regex::Regex::new(r"\b[0-9a-f]{40}\b").unwrap(),
        time: regex::Regex::new(r"\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d)").unwrap(),
    };
    let mut r = Replay { service, golden: goldens(), mask, ops: 0 };
    let nowhere = slashes(base.join("nowhere"));
    let head = git(&rig.repo, &["rev-parse", "main"]);

    let menu = |path: &str| json!({ "input": { "projectPath": path } });
    let inspect = |branch: &str| json!({ "input": { "projectPath": repo, "branch": branch } });
    let select = |branch: &str, rest: Value| {
        let mut input = json!({ "projectPath": repo, "branch": branch });
        for (key, value) in rest.as_object().unwrap() {
            input[key] = value.clone();
        }
        json!({ "input": input })
    };
    let merge = |branch: &str, target: &str| json!({ "input": { "projectPath": repo, "branch": branch, "target": target } });
    let (get_menu, get_inspect, set_branch, set_merge) =
        ("project/getProjectBranchMenu", "project/inspectProjectBranch", "project/selectProjectBranch", "project/mergeProjectBranch");

    r.step("menu: project folder", get_menu, menu(&repo), false).await;
    r.step("menu: unregistered project", get_menu, menu(&nowhere), false).await;
    r.step("menu: blank project path", get_menu, menu("  "), false).await;
    r.step("inspect: unmerged topic", get_inspect, inspect("topic"), false).await;
    r.step("inspect: merged dev", get_inspect, inspect("dev"), false).await;
    r.step("inspect: unknown branch", get_inspect, inspect("nope"), false).await;
    r.step("inspect: blank branch", get_inspect, inspect(""), false).await;
    r.step("select: unknown branch", set_branch, select("nope", json!({})), true).await;
    r.step("select: already current", set_branch, select("main", json!({})), true).await;
    r.step("select: create from start point", set_branch, select("fresh", json!({ "create": true, "startPoint": head })), true).await;
    r.step("select: topic", set_branch, select("topic", json!({})), true).await;
    r.step("menu: on topic", get_menu, menu(&repo), false).await;
    r.step("select: create and remote", set_branch, select("x", json!({ "create": true, "remote": true })), true).await;
    r.step("select: start point needs create", set_branch, select("dev", json!({ "startPoint": head })), true).await;
    r.step("select: detach excludes branch", set_branch, select("dev", json!({ "detach": "main" })), true).await;
    r.step("select: detach", set_branch, json!({ "input": { "projectPath": repo, "detach": head } }), true).await;
    r.step("menu: detached", get_menu, menu(&repo), false).await;
    r.step("select: back to main", set_branch, select("main", json!({})), true).await;
    r.step("merge: wrong target", set_merge, merge("topic", "dev"), true).await;
    r.step("merge: blank target", set_merge, merge("topic", ""), true).await;
    r.step("merge: topic into main", set_merge, merge("topic", "main"), true).await;
    r.step("inspect: topic now merged", get_inspect, inspect("topic"), false).await;

    git(&rig.repo, &["branch", "spare"]);
    let view = r.run(get_inspect, inspect("spare"), false).await["ok"].clone();
    let manage = |view: &Value, commit: &str, confirmed: bool, action: &str| {
        json!({ "input": { "projectPath": repo, "branch": view["branch"], "commit": commit, "target": view["target"], "targetCommit": view["targetCommit"], "confirmed": confirmed, "action": action } })
    };
    let commit = view["commit"].as_str().unwrap().to_owned();
    let manage_method = "project/manageProjectBranch";
    r.step("manage: unconfirmed", manage_method, manage(&view, &commit, false, "delete-branch"), true).await;
    r.step("manage: unknown action", manage_method, manage(&view, &commit, true, "explode"), true).await;
    r.step("manage: stale commit", manage_method, manage(&view, &"0".repeat(40), true, "delete-branch"), true).await;
    r.step("manage: delete branch", manage_method, manage(&view, &commit, true, "delete-branch"), true).await;
    r.step("manage: delete branch again", manage_method, manage(&view, &commit, true, "delete-branch"), true).await;

    r.step("list: none", "project/listWorktrees", json!({}), false).await;
    r.step("preview: none", "project/previewWorktreeCleanup", json!({ "input": { "repoCommonDir": null } }), false).await;
    r.step("prune: nothing", "project/pruneWorktrees", json!({ "input": { "repoCommonDir": null } }), true).await;
    r.step("archived: none", "project/setArchivedSessionWorktrees", json!({ "input": { "sessionIds": [], "archived": true } }), true).await;
    r.step("delete: unknown entry", "project/deleteWorktree", json!({ "input": { "entryId": "nope" } }), true).await;

    let get = "project/getProjectConnectors";
    let set = "project/setProjectConnectorEnabled";
    let switch = |path: &str, id: &str, enabled: bool, remote: bool| {
        let mut params = json!({ "projectPath": path, "connectorId": id, "enabled": enabled });
        if remote {
            params["options"] = json!({ "noWiden": true });
        }
        params
    };
    let file = || serde_json::from_slice::<Value>(&std::fs::read(connector_data.join("project-connectors.json")).unwrap()).unwrap();
    r.step("connectors: all on", get, json!({ "projectPath": repo }), false).await;
    r.step("connectors: unregistered project", get, json!({ "projectPath": nowhere }), false).await;
    r.step("connectors: blank project", get, json!({ "projectPath": " " }), false).await;
    r.step("connectors: switch notion off", set, switch(&repo, "notion", false, false), true).await;
    r.step("connectors: switch gmail off, remote", set, switch(&repo, "gmail", false, true), true).await;
    r.check("connectors: policy file", &json!({ "ok": file() }));
    r.step("connectors: remote cannot widen", set, switch(&repo, "gmail", true, true), true).await;
    r.step("connectors: blank connector id", set, switch(&repo, " ", true, false), true).await;
    r.step("connectors: unregistered project set", set, switch(&nowhere, "gmail", false, false), true).await;
    r.step("connectors: switch gmail on", set, switch(&repo, "gmail", true, false), true).await;
    r.step("connectors: switch notion on", set, switch(&repo, "notion", true, false), true).await;
    r.check("connectors: policy file emptied", &json!({ "ok": file() }));
    std::fs::write(connector_data.join("project-connectors.json"), "{ not json").unwrap();
    r.step("connectors: unreadable file reads deny-all", get, json!({ "projectPath": repo }), false).await;
    r.step("connectors: unreadable file is never overwritten", set, switch(&repo, "gmail", false, false), true).await;
}
