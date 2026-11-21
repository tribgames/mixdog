//! The `project/*` methods against the Node recording (`fixtures/project-methods/golden.json`,
//! made by `benchmarks/rust-core/recorders/record-project-methods.mjs` from the real 1.4.5
//! functions over a fixture repository and data dir). Every recorded step is replayed through the
//! service's wire entry over real git and managed-worktree state (orphaned, dirty, unmerged,
//! retained, shared and live-owned worktrees; a session's own worktree), and must answer what Node
//! answered, with temp paths, commit ids, folder sizes and times masked the same way. Each
//! worktree/branch step also compares what it left behind: the managed folders that exist, the
//! local branches, the project folder's branch and tracked changes, and the files of `main`. The
//! test fails when a recorded step is never replayed.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "tests drive git and the disk directly")]

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::WindowRole;
use mixdog_core_api::call::WindowScope;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::service::DomainService;
use mixdog_core_base::support::testing;
use mixdog_mcp::permissions::PolicyIo;
use mixdog_protocol::Origin;
use mixdog_rt::CancellationToken;
use mixdog_scm::error::ScmFailure;
use mixdog_scm::worktree::maintenance::SessionActivity;
use mixdog_scm::worktree::maintenance::SessionSource;
use mixdog_scm::worktree::maintenance::ShellJob;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use mixdog_core_agents::agents::ConnectorCatalog;
use mixdog_core_session::project::connectors::ProjectConnectors;
use mixdog_core_session::project::service::ProjectService;
use mixdog_core_session::project::service::Registry;
use mixdog_core_session::session::worktree::LiveSessions;
use mixdog_core_session::session::worktree::worktree_tests::rig;

struct One(String);

#[async_trait]
impl Registry for One {
    async fn registered(&self, path: &str) -> Result<Option<String>, String> {
        Ok((path == self.0).then(|| self.0.clone()))
    }
}

struct Installed;

#[async_trait]
impl ConnectorCatalog for Installed {
    async fn installed(&self) -> Result<Vec<String>, String> {
        Ok(vec!["gmail".into(), "github".into(), "notion".into()])
    }
    async fn tool_names(&self, _: &str) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn connector_of(&self, _: &str) -> Option<String> {
        None
    }
}

/// The sessions the store keeps (each retains its worktree); none is a favorite, archived or runs
/// a background job.
#[derive(Default)]
struct Sessions {
    stored: Mutex<HashSet<String>>,
}

#[async_trait]
impl SessionSource for Sessions {
    async fn stored_session_ids(&self) -> Result<HashSet<String>, ScmFailure> {
        Ok(self.stored.lock().unwrap().clone())
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

/// `{ ok }` or `{ error: { code, message, details } }`, as the recorder's `step` stored a throw.
/// Node's `details` are the refusal's own fields: the typed detail without its `type` tag.
fn answer(result: Result<Value, CoreError>) -> Value {
    match result {
        Ok(value) => json!({ "ok": value }),
        Err(CoreError::DomainError { code, message, detail, .. }) => {
            let details = match detail.map(|detail| serde_json::to_value(&*detail)) {
                Some(Ok(Value::Object(fields))) => {
                    let own: Map<String, Value> = fields.into_iter().filter(|(key, _)| key != "type").collect();
                    if own.is_empty() { Value::Null } else { Value::Object(own) }
                }
                _ => Value::Null,
            };
            json!({ "error": { "code": code.as_deref(), "message": message.as_deref(), "details": details } })
        }
        Err(other) => panic!("a failure Node has no counterpart for: {other:?}"),
    }
}

async fn service_over(rig: &mixdog_core_session::session::worktree::worktree_tests::Rig, repo: &str, dir: &std::path::Path) -> ProjectService {
    let tokens = mixdog_rt::testing::tokens();
    let io = PolicyIo { maintenance: tokens.maintenance_io, interactive: tokens.interactive_io, durability: tokens.durability_io };
    let registry = Arc::new(One(repo.to_owned()));
    let connector_data = dir.join("connector-data");
    std::fs::create_dir_all(&connector_data).unwrap();
    let connectors = ProjectConnectors::new(registry.clone(), Arc::new(Installed), &connector_data, io);
    let ops = testing::scopes(dir, "project").await;
    let live: LiveSessions = Arc::new(HashSet::new);
    ProjectService::new(registry, rig.worktrees.clone(), rig.ws.clone(), Arc::new(Sessions::default()), live, connectors, ops)
}

async fn select_branch(service: &ProjectService, ops: &mut u64, input: Value) -> Value {
    *ops += 1;
    let params = testing::with_op(json!({ "input": input }), *ops);
    let mut request = testing::request("project/selectProjectBranch", params, Some(*ops));
    request.ctx = CallContext::connection(ConnectionId(1), Origin::Local, CancellationToken::new());
    switched(service, request).await
}

/// `project/selectProjectBranch` refuses the input combinations that exclude each other with the guard's own text, creates a
/// branch in the Project folder, and answers `changed: false` when the branch asked for is already checked out.
#[tokio::test(flavor = "multi_thread")]
async fn selecting_a_project_branch_guards_its_input_and_creates_the_branch() {
    let rig = rig();
    let repo = rig.repo.to_string_lossy().into_owned();
    let dir = tempfile::tempdir().unwrap();
    let service = service_over(&rig, &repo, dir.path()).await;
    let mut n = 0;
    for (input, message) in [
        (json!({ "projectPath": repo, "detach": "abc1234", "branch": "topic" }), "detach excludes branch, create, remote and startPoint."),
        (json!({ "projectPath": repo, "branch": "topic", "create": true, "remote": true }), "create and remote are exclusive."),
        (json!({ "projectPath": repo, "branch": "topic", "startPoint": "main" }), "startPoint needs create."),
    ] {
        let refused = select_branch(&service, &mut n, input).await;
        assert_eq!(refused["error"]["message"], message, "{refused}");
    }
    let created = select_branch(&service, &mut n, json!({ "projectPath": repo, "branch": "topic", "create": true })).await;
    assert!(created.get("ok").is_some(), "{created}");
    let again = select_branch(&service, &mut n, json!({ "projectPath": repo, "branch": "topic" })).await;
    assert_eq!(again, json!({ "ok": { "branch": "topic", "changed": false } }));
}

/// A connector switch as `origin` (and, for a window, its scope) sends it: the same call `testing::request` builds, with the context of that connection.
fn switch_as(ops: &mut u64, origin: Origin, window: Option<WindowScope>, repo: &str, connector: &str, enabled: bool) -> CoreRequest {
    *ops += 1;
    let params = testing::with_op(json!({ "projectPath": repo, "connectorId": connector, "enabled": enabled }), *ops);
    let mut request = testing::request("project/setProjectConnectorEnabled", params, Some(*ops));
    request.ctx = CallContext::connection(ConnectionId(1), origin, CancellationToken::new()).with_window(window);
    request
}

async fn switched(service: &ProjectService, request: CoreRequest) -> Value {
    answer(match service.call(request).await {
        Ok(Reply::Value(value)) => Ok(value),
        Ok(_) => panic!("never subscribes"),
        Err(error) => Err(error),
    })
}

/// Widening what the bot may do (switching a connector on that is off) answers a desktop window as it answers a connection with no
/// window: Node's main process made the call without `noWiden`, and the window took its place. Only a relay origin is refused.
#[tokio::test(flavor = "multi_thread")]
async fn a_window_widens_a_project_connector_as_main_does() {
    let rig = rig();
    let repo = rig.repo.to_string_lossy().into_owned();
    let dir = tempfile::tempdir().unwrap();
    let service = service_over(&rig, &repo, dir.path()).await;
    let window = || Some(WindowScope { id: Arc::from("w-1"), role: WindowRole::Main });
    let mut n = 0;

    // Each connection kind widens from the same state: the connector off, then switched on.
    let mut answers = Vec::new();
    for (origin, scope) in [(Origin::Local, None), (Origin::Local, window())] {
        let off = switched(&service, switch_as(&mut n, Origin::Local, None, &repo, "gmail", false)).await;
        assert!(off.get("ok").is_some(), "switching off: {off}");
        let on = switched(&service, switch_as(&mut n, origin, scope, &repo, "gmail", true)).await;
        assert!(on.get("ok").is_some(), "a local connection widens: {on}");
        answers.push(on);
    }
    assert_eq!(answers[1], answers[0], "the window's answer is the answer of a connection with no window");

    let off = switched(&service, switch_as(&mut n, Origin::Local, None, &repo, "gmail", false)).await;
    assert!(off.get("ok").is_some(), "{off}");
    let relayed = switched(&service, switch_as(&mut n, Origin::Relay, None, &repo, "gmail", true)).await;
    assert!(relayed.get("error").is_some(), "a relay origin cannot widen: {relayed}");
}
