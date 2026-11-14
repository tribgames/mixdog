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
use std::path::Path;
use std::path::PathBuf;
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
use mixdog_scm::worktree::manager::CreateRequest;
use mixdog_scm::worktree::ownership::Owner;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use mixdog_core_agents::agents::ConnectorCatalog;
use mixdog_core_session::project::connectors::ProjectConnectors;
use mixdog_core_session::project::service::ProjectService;
use mixdog_core_session::project::service::Registry;
use mixdog_core_session::session::worktree::LiveSession;
use mixdog_core_session::session::worktree::LiveSessions;
use mixdog_core_session::session::worktree::worktree_tests::enter;
use mixdog_core_session::session::worktree::worktree_tests::git;
use mixdog_core_session::session::worktree::worktree_tests::rig;
use mixdog_core_session::session::worktree::worktree_tests::run;

/// A process id no process has (above every platform's pid range): a lease on it is proven dead.
const DEAD_PID: u32 = 2_000_000_000;

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

fn goldens() -> Vec<Value> {
    let all: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/project-methods/golden.json")).expect("golden.json parses");
    all["steps"].as_array().expect("steps").clone()
}

/// The recorder's `mask`: paths, commit ids, folder sizes and times.
struct Mask {
    roots: Vec<(String, String)>,
    parent: regex::Regex,
    sha: regex::Regex,
    time: regex::Regex,
}

fn slashes(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().replace('\\', "/")
}

impl Mask {
    fn text(&self, text: &str) -> String {
        let mut out = text.replace('\\', "/");
        for (root, label) in &self.roots {
            out = out.replace(root.as_str(), label);
        }
        let out = self.parent.replace_all(&out, "worktrees-v1/<project>/").into_owned();
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
                        let sized = key == "sizeBytes" && item.is_number();
                        let masked = if timed {
                            json!("<ms>")
                        } else if sized {
                            json!("<bytes>")
                        } else {
                            self.value(item)
                        };
                        (self.text(key), masked)
                    })
                    .collect(),
            ),
            other => other.clone(),
        }
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

struct Replay {
    service: ProjectService,
    golden: Vec<Value>,
    mask: Mask,
    ops: u64,
    consumed: HashSet<String>,
    repo: PathBuf,
    /// The managed folders made so far, by name.
    folders: Vec<(String, PathBuf)>,
    /// Compare what a step left on disk and in git (the connector steps leave neither).
    probing: bool,
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

    /// The recorder's `probe`. Its four git reads do not depend on each other, so they run side by
    /// side: a probe follows every step and the replay is otherwise one chain of real git processes.
    fn probe(&self) -> Value {
        let lines = |text: String| -> Vec<String> { if text.is_empty() { Vec::new() } else { text.split('\n').map(str::to_owned).collect() } };
        let repo = self.repo.as_path();
        let (branches, head, main_files, status) = std::thread::scope(|scope| {
            let branches = scope.spawn(|| git(repo, &["for-each-ref", "--format=%(refname:short)", "refs/heads"]));
            let head = scope.spawn(|| git(repo, &["rev-parse", "--abbrev-ref", "HEAD"]));
            let main_files = scope.spawn(|| git(repo, &["ls-tree", "-r", "--name-only", "main"]));
            let status = git(repo, &["status", "--porcelain", "--untracked-files=no"]);
            (branches.join().unwrap(), head.join().unwrap(), main_files.join().unwrap(), status)
        });
        let mut branches = lines(branches);
        branches.sort();
        let folders: Map<String, Value> = self.folders.iter().map(|(name, path)| (name.clone(), json!(path.exists()))).collect();
        json!({
            "branches": branches,
            "folders": folders,
            "head": head,
            "mainFiles": lines(main_files),
            "status": lines(status),
        })
    }

    fn check(&mut self, name: &str, raw: &Value) {
        let mut actual = self.mask.value(raw);
        actual["name"] = json!(name);
        if self.probing {
            actual["after"] = self.mask.value(&self.probe());
        }
        let want = self.golden.iter().find(|step| step["name"] == name).unwrap_or_else(|| panic!("no recorded step {name}"));
        assert_eq!(&actual, want, "step {name}");
        assert!(self.consumed.insert(name.to_owned()), "step {name} replayed twice");
    }

    /// Runs `method` and asserts it answers what Node recorded under `name`.
    async fn step(&mut self, name: &str, method: &'static str, params: Value, mutation: bool) -> Value {
        let raw = self.run(method, params, mutation).await;
        self.check(name, &raw);
        raw
    }

    /// A worktree for `session`, as the session's request for it makes one.
    async fn make(&mut self, rig: &mixdog_core_session::session::worktree::worktree_tests::Rig, session: &str, name: &str, tx: &str) -> String {
        let request = CreateRequest {
            project_path: rig.repo.clone(),
            session_id: session.to_owned(),
            tx_id: tx.to_owned(),
            name_hint: name.to_owned(),
            base_branch: Some("main".to_owned()),
            runtime_token: "rt".to_owned(),
            ..CreateRequest::default()
        };
        let record = rig.worktrees.create(request, &CancellationToken::new()).await.unwrap();
        self.mask.roots.insert(0, (slashes(&record.path), format!("<{name}>")));
        self.folders.push((name.to_owned(), PathBuf::from(&record.path)));
        record.id
    }

    fn path_of(&self, name: &str) -> &Path {
        &self.folders.iter().find(|(known, _)| known == name).expect("a made worktree").1
    }

    fn finish(&self) {
        let missing: Vec<&str> = self.golden.iter().filter_map(|step| step["name"].as_str()).filter(|name| !self.consumed.contains(*name)).collect();
        assert!(missing.is_empty(), "recorded steps never replayed: {missing:?}");
    }
}

/// The lease file of managed worktree `id`, wherever the managed root put it.
fn lease_file(dir: &Path, id: &str) -> Option<PathBuf> {
    let name = format!("{id}.json");
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            if let Some(found) = lease_file(&path, id) {
                return Some(found);
            }
        } else if path.file_name().and_then(|n| n.to_str()) == Some(name.as_str()) && path.parent().and_then(Path::file_name).and_then(|n| n.to_str()) == Some(".owners") {
            return Some(path);
        }
    }
    None
}

/// The owning process is gone: the lease names a proven-dead pid.
fn orphan(data: &Path, id: &str, session: &str) {
    let file = lease_file(data, id).expect("the worktree has a lease");
    let lease = json!({ "sessionId": session, "runtimeToken": "gone", "pid": DEAD_PID, "entryId": id, "claimedAt": 1 });
    std::fs::write(file, serde_json::to_vec(&lease).unwrap()).unwrap();
}

fn commit_in(dir: &Path, file: &str) {
    std::fs::write(dir.join(file), format!("{file}\n")).unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-q", "-m", &format!("work {file}")]);
}

#[tokio::test(flavor = "multi_thread")]
async fn every_recorded_step_equals_nodes_over_real_state() {
    let rig = rig();
    let repo = rig.repo.to_string_lossy().into_owned();
    std::fs::write(rig.repo.join(".gitignore"), ".mixdog/\n").unwrap();
    git(&rig.repo, &["add", "."]);
    git(&rig.repo, &["commit", "-q", "-m", "ignore"]);
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
    let sessions = Arc::new(Sessions::default());
    let live: Arc<Mutex<HashSet<String>>> = Arc::default();
    let live_ids: LiveSessions = {
        let live = live.clone();
        Arc::new(move || live.lock().unwrap().clone())
    };
    let service = ProjectService::new(registry, rig.worktrees.clone(), rig.ws.clone(), sessions.clone(), live_ids, connectors, ops);
    let base = rig.repo.parent().unwrap().to_path_buf();
    let mask = Mask {
        roots: vec![
            (slashes(&rig.repo), "<repo>".to_owned()),
            (slashes(&rig.data), "<data>".to_owned()),
            (slashes(&connector_data), "<connector-data>".to_owned()),
            (slashes(&base), "<base>".to_owned()),
        ],
        parent: regex::Regex::new(r"worktrees-v1/[0-9a-f]{16}/").unwrap(),
        sha: regex::Regex::new(r"\b[0-9a-f]{40}\b").unwrap(),
        time: regex::Regex::new(r"\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d)").unwrap(),
    };
    let mut r = Replay { service, golden: goldens(), mask, ops: 0, consumed: HashSet::new(), repo: rig.repo.clone(), folders: Vec::new(), probing: true };
    let nowhere = slashes(base.join("nowhere"));
    let other_repo = base.join("other").join(".git").to_string_lossy().into_owned();
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
    // The recorder calls workspace-transitions directly, which names the path in its refusal. Every Node caller reaches it through
    // the host's `projectScopedArgs` (session-host-lifecycle.ts:1232-1243 at b6f10295a), which refuses an unregistered path first,
    // with no details; that refusal is the one a client sees (apps/mobile/fixtures/phone-worktree).
    let unregistered = r.golden.iter_mut().find(|step| step["name"] == "menu: unregistered project").unwrap();
    unregistered["error"]["details"] = Value::Null;
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
    let manage_method = "project/manageProjectBranch";
    let manage = |view: &Value, commit: &str, confirmed: bool, action: &str| {
        json!({ "input": { "projectPath": repo, "branch": view["branch"], "commit": commit, "target": view["target"], "targetCommit": view["targetCommit"], "confirmed": confirmed, "action": action } })
    };
    let act = |view: &Value, action: &str, extra: Value| {
        let mut input = json!({
            "projectPath": repo, "branch": view["branch"], "commit": view["commit"], "target": view["target"],
            "targetCommit": view["targetCommit"], "confirmed": true, "action": action,
        });
        for (key, value) in extra.as_object().unwrap() {
            input[key] = value.clone();
        }
        json!({ "input": input })
    };
    let commit = view["commit"].as_str().unwrap().to_owned();
    r.step("manage: unconfirmed", manage_method, manage(&view, &commit, false, "delete-branch"), true).await;
    r.step("manage: unknown action", manage_method, manage(&view, &commit, true, "explode"), true).await;
    r.step("manage: stale commit", manage_method, manage(&view, &"0".repeat(40), true, "delete-branch"), true).await;
    r.step("manage: delete branch", manage_method, manage(&view, &commit, true, "delete-branch"), true).await;
    r.step("manage: delete branch again", manage_method, manage(&view, &commit, true, "delete-branch"), true).await;

    // ---- worktrees
    let (list, preview, prune, archived, delete) =
        ("project/listWorktrees", "project/previewWorktreeCleanup", "project/pruneWorktrees", "project/setArchivedSessionWorktrees", "project/deleteWorktree");
    r.step("list: none", list, json!({}), false).await;
    r.step("preview: none", preview, json!({ "input": { "repoCommonDir": null } }), false).await;
    r.step("prune: nothing", prune, json!({ "input": { "repoCommonDir": null } }), true).await;

    // Seven session worktrees, each one a different case for the removals below.
    let mut ids: HashMap<&str, String> = HashMap::new();
    for (session, name, tx) in [
        ("sA", "wt-clean", "p1"),
        ("sB", "wt-unmerged", "p2"),
        ("sC", "wt-dirty", "p3"),
        ("sD", "wt-retained", "p4"),
        ("sE", "wt-live", "p5"),
        ("sF", "wt-shared", "p6"),
        ("sH", "wt-merge", "p7"),
    ] {
        let id = r.make(&rig, session, name, tx).await;
        ids.insert(name, id);
    }
    commit_in(r.path_of("wt-unmerged"), "u.txt");
    commit_in(r.path_of("wt-merge"), "m.txt");
    std::fs::write(r.path_of("wt-dirty").join("f.txt"), "changed\n").unwrap();
    std::fs::write(r.path_of("wt-dirty").join("scratch.txt"), "untracked\n").unwrap();
    // A second session shares wt-shared (a lease of its own, held by no live process).
    let sharer = Owner { session_id: "sG".into(), runtime_token: "rt-g".into(), pid: Some(DEAD_PID) };
    rig.worktrees.claim_owner(&ids["wt-shared"], sharer, &CancellationToken::new()).await.unwrap();
    r.step("list: lease holders alive", list, json!({}), false).await;
    r.step("delete: lease holder alive", delete, json!({ "input": { "entryId": ids["wt-unmerged"] } }), true).await;

    // Every owning process is gone; sD's session is still in the store, sE's still runs.
    for (session, name) in [("sA", "wt-clean"), ("sB", "wt-unmerged"), ("sC", "wt-dirty"), ("sD", "wt-retained"), ("sE", "wt-live"), ("sF", "wt-shared"), ("sH", "wt-merge")] {
        orphan(&rig.data, &ids[name], session);
    }
    sessions.stored.lock().unwrap().insert("sD".to_owned());
    live.lock().unwrap().insert("sE".to_owned());
    rig.state.lock().unwrap().live = ["sD", "sE"].map(|id| LiveSession { id: id.into(), ..LiveSession::default() }).to_vec();
    r.step("list: owners gone", list, json!({}), false).await;
    r.step("preview: orphans", preview, json!({ "input": { "repoCommonDir": null } }), false).await;
    r.step("preview: other repository", preview, json!({ "input": { "repoCommonDir": other_repo } }), false).await;
    r.step("archived: mark", archived, json!({ "input": { "sessionIds": ["sC", 7, ""], "archived": true } }), true).await;
    r.step("archived: restore", archived, json!({ "input": { "sessionIds": ["sC"], "archived": false } }), true).await;
    r.step("archived: none", archived, json!({ "input": { "sessionIds": [], "archived": true } }), true).await;

    // ---- branch actions over those worktrees
    let mut seen: HashMap<&str, Value> = HashMap::new();
    for name in ["wt-clean", "wt-unmerged", "wt-dirty", "wt-retained", "wt-live", "wt-shared", "wt-merge"] {
        seen.insert(name, r.run(get_inspect, inspect(name), false).await["ok"].clone());
    }
    r.step("inspect: managed worktree branch", get_inspect, inspect("wt-dirty"), false).await;
    r.step("manage: merge a dirty worktree", manage_method, act(&seen["wt-dirty"], "merge", json!({})), true).await;
    r.step("manage: remove a dirty worktree", manage_method, act(&seen["wt-dirty"], "remove-worktree", json!({})), true).await;
    r.step("manage: remove an unmerged worktree", manage_method, act(&seen["wt-unmerged"], "remove-worktree", json!({})), true).await;
    r.step("manage: remove a retained worktree", manage_method, act(&seen["wt-retained"], "remove-worktree", json!({})), true).await;
    r.step("manage: remove a live session worktree", manage_method, act(&seen["wt-live"], "remove-worktree", json!({})), true).await;
    r.step("manage: remove a shared worktree", manage_method, act(&seen["wt-shared"], "remove-worktree", json!({})), true).await;
    r.step("manage: delete a branch a worktree holds", manage_method, act(&seen["wt-clean"], "delete-branch", json!({})), true).await;
    git(&rig.repo, &["checkout", "-q", "-b", "side"]);
    std::fs::write(rig.repo.join("s.txt"), "s\n").unwrap();
    git(&rig.repo, &["add", "."]);
    git(&rig.repo, &["commit", "-q", "-m", "side work"]);
    git(&rig.repo, &["checkout", "-q", "main"]);
    git(&rig.repo, &["branch", "fresh2"]);
    let side = r.run(get_inspect, inspect("side"), false).await["ok"].clone();
    r.step("manage: delete an unmerged branch", manage_method, act(&side, "delete-branch", json!({})), true).await;
    let mut stale = r.run(get_inspect, inspect("fresh2"), false).await["ok"].clone();
    stale["targetCommit"] = json!("0".repeat(40));
    r.step("manage: stale target commit", manage_method, act(&stale, "delete-branch", json!({})), true).await;
    r.step("manage: delete an unmerged branch, forced", manage_method, act(&side, "delete-branch", json!({ "force": true })), true).await;
    git(&rig.repo, &["checkout", "-q", "-b", "topic2"]);
    std::fs::write(rig.repo.join("t2.txt"), "t2\n").unwrap();
    git(&rig.repo, &["add", "."]);
    git(&rig.repo, &["commit", "-q", "-m", "topic2 work"]);
    git(&rig.repo, &["checkout", "-q", "main"]);
    std::fs::write(rig.repo.join("f.txt"), "dirty target\n").unwrap();
    r.step("merge: dirty project folder", set_merge, merge("topic2", "main"), true).await;
    git(&rig.repo, &["checkout", "--", "f.txt"]);
    r.step("manage: merge a worktree branch", manage_method, act(&seen["wt-merge"], "merge", json!({})), true).await;
    let merged = r.run(get_inspect, inspect("wt-merge"), false).await["ok"].clone();
    r.step("manage: remove a merged worktree", manage_method, act(&merged, "remove-worktree", json!({})), true).await;

    // ---- the manual prune, the list and the deletions
    r.step("prune: other repository", prune, json!({ "input": { "repoCommonDir": other_repo } }), true).await;
    r.step("prune: removes only the clean orphan", prune, json!({ "input": { "repoCommonDir": null } }), true).await;
    r.step("list: after prune", list, json!({}), false).await;
    r.step("delete: unknown entry", delete, json!({ "input": { "entryId": "nope" } }), true).await;
    r.step("delete: live owner", delete, json!({ "input": { "entryId": ids["wt-live"] } }), true).await;
    r.step("delete: shared worktree", delete, json!({ "input": { "entryId": ids["wt-shared"] } }), true).await;
    r.step("delete: dirty without force", delete, json!({ "input": { "entryId": ids["wt-dirty"] } }), true).await;
    r.step("delete: unmerged without force", delete, json!({ "input": { "entryId": ids["wt-unmerged"] } }), true).await;
    r.step("delete: dirty with force", delete, json!({ "input": { "entryId": ids["wt-dirty"], "force": true } }), true).await;
    r.step("delete: unmerged with force", delete, json!({ "input": { "entryId": ids["wt-unmerged"], "force": true } }), true).await;
    r.step("delete: retained session worktree", delete, json!({ "input": { "entryId": ids["wt-retained"] } }), true).await;
    r.step("list: what remains", list, json!({}), false).await;

    // ---- a session's own worktree
    let entered = run(&rig, enter("solo-wt", "c1")).await.unwrap();
    let solo = PathBuf::from(entered["workspace"]["cwd"].as_str().unwrap());
    r.mask.roots.insert(0, (slashes(&solo), "<solo-wt>".to_owned()));
    r.folders.push(("solo-wt".to_owned(), solo.clone()));
    std::fs::write(solo.join("wip.txt"), "wip\n").unwrap();
    let remove = "project/removeWorktree";
    rig.state.lock().unwrap().turn_running = true;
    r.step("remove: session runs a turn", remove, json!({ "threadId": "lead", "input": { "force": true } }), true).await;
    rig.state.lock().unwrap().turn_running = false;
    r.step("remove: stale revision", remove, json!({ "threadId": "lead", "input": { "expectedRevision": 99 } }), true).await;
    r.step("remove: dirty without force", remove, json!({ "threadId": "lead", "input": {} }), true).await;
    r.step("remove: session works there", remove, json!({ "threadId": "lead", "input": { "force": true } }), true).await;

    // ---- connectors
    r.probing = false;
    let get = "project/getProjectConnectors";
    let set = "project/setProjectConnectorEnabled";
    let switch = |path: &str, id: &str, enabled: Value, remote: bool| {
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
    r.step("connectors: switch notion off", set, switch(&repo, "notion", json!(false), false), true).await;
    r.step("connectors: switch gmail off, remote", set, switch(&repo, "gmail", json!(false), true), true).await;
    r.check("connectors: policy file", &json!({ "ok": file() }));
    r.step("connectors: remote cannot widen", set, switch(&repo, "gmail", json!(true), true), true).await;
    r.step("connectors: enabled must be boolean", set, switch(&repo, "gmail", json!("yes"), false), true).await;
    r.step("connectors: blank connector id", set, switch(&repo, " ", json!(true), false), true).await;
    r.step("connectors: unregistered project set", set, switch(&nowhere, "gmail", json!(false), false), true).await;
    r.step("connectors: switch gmail on", set, switch(&repo, "gmail", json!(true), false), true).await;
    r.step("connectors: switch notion on", set, switch(&repo, "notion", json!(true), false), true).await;
    r.check("connectors: policy file emptied", &json!({ "ok": file() }));
    std::fs::write(connector_data.join("project-connectors.json"), "{ not json").unwrap();
    r.step("connectors: unreadable file reads deny-all", get, json!({ "projectPath": repo }), false).await;
    r.step("connectors: unreadable file is never overwritten", set, switch(&repo, "gmail", json!(false), false), true).await;

    r.finish();
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
    let tokens = mixdog_rt::testing::tokens();
    let io = PolicyIo { maintenance: tokens.maintenance_io, interactive: tokens.interactive_io, durability: tokens.durability_io };
    let registry = Arc::new(One(repo.clone()));
    let connector_data = dir.path().join("connector-data");
    std::fs::create_dir_all(&connector_data).unwrap();
    let connectors = ProjectConnectors::new(registry.clone(), Arc::new(Installed), &connector_data, io);
    let ops = testing::scopes(dir.path(), "project").await;
    let live: LiveSessions = Arc::new(HashSet::new);
    let service = ProjectService::new(registry, rig.worktrees.clone(), rig.ws.clone(), Arc::new(Sessions::default()), live, connectors, ops);
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
