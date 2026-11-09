//! Golden twin (DS-SCM-1/2): the scripted repository of the Node recorder, read and mutated
//! through the engine, against `fixtures/desktop/git/corpus.json`.

#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "tests build their fixture repositories and run git on the test thread"
)]

use std::path::Path;
use std::process::Command;

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::engine::Scm;
use crate::testing::TestProcesses;

pub(crate) fn git(cwd: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(cwd)
        .env("GIT_AUTHOR_NAME", "Fixture")
        .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fixture")
        .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid")
        .env("GIT_AUTHOR_DATE", "2026-01-02T03:04:05+00:00")
        .env("GIT_COMMITTER_DATE", "2026-01-02T03:04:05+00:00")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

pub(crate) fn fixture_repo() -> (tempfile::TempDir, std::path::PathBuf, String) {
    let dir = tempfile::tempdir().unwrap();
    let repo = std::fs::canonicalize(dir.path()).unwrap().join("repo");
    std::fs::create_dir_all(repo.join("src")).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    // The engine's own git commands read the repository config; the helper above only sets it
    // per call, so a machine-wide `core.autocrlf=true` would rewrite files the engine resets.
    git(&repo, &["config", "core.autocrlf", "false"]);
    std::fs::write(repo.join("a.txt"), "one\ntwo\nthree\n").unwrap();
    std::fs::write(repo.join("src/b.mjs"), "export const b = 1;\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "first"]);
    std::fs::write(repo.join("a.txt"), "one\nTWO\nthree\nfour\n").unwrap();
    git(&repo, &["commit", "-q", "-am", "second: edit a"]);
    git(&repo, &["branch", "feature"]);
    let head = git(&repo, &["rev-parse", "HEAD"]);
    std::fs::write(repo.join("a.txt"), "one\nTWO\nthree\nfour\nfive\n").unwrap();
    std::fs::write(repo.join("src/b.mjs"), "export const b = 2;\n").unwrap();
    git(&repo, &["add", "src/b.mjs"]);
    std::fs::write(repo.join("new.txt"), "untracked\n").unwrap();
    (dir, repo, head)
}

fn scm() -> std::sync::Arc<Scm> {
    Scm::new(
        TestProcesses::shared(),
        mixdog_rt::testing::tokens().maintenance_io,
        std::env::temp_dir().join(format!("mixdog-scm-test-{}", std::process::id())),
    )
}

fn corpus_case(op: &str, args: Option<Value>) -> Value {
    let corpus: Value = serde_json::from_str(include_str!("../../../fixtures/desktop/git/corpus.json")).unwrap();
    corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["op"] == op && args.as_ref().is_none_or(|a| &c["args"] == a))
        .unwrap_or_else(|| panic!("no case {op}"))
        .clone()
}

/// Drops what depends on the clock or the recorded paths.
fn comparable(mut value: Value) -> Value {
    match &mut value {
        Value::Object(map) => {
            for key in ["root", "hash", "shortHash", "when", "lastCommitRelative", "lastCommitAt", "authoredAt"] {
                map.shift_remove(key);
            }
            map.values_mut().for_each(|v| *v = comparable(v.take()));
        }
        Value::Array(items) => items.iter_mut().for_each(|v| *v = comparable(v.take())),
        Value::String(text) => {
            if text.len() == 40 && text.bytes().all(|b| b.is_ascii_hexdigit()) {
                *text = "<H40>".into();
            }
        }
        _ => {}
    }
    value
}

#[tokio::test]
async fn status_branches_log_and_diff_match_the_node_twin() {
    let (_guard, repo, head) = fixture_repo();
    let scm = scm();
    let cancel = CancellationToken::new();

    let status = scm.git_status(&repo, &cancel).await.unwrap();
    assert_eq!(comparable(status), comparable(corpus_case("gitStatus", None)["result"].clone()));

    let branches = scm.git_branches(&repo, &cancel).await.unwrap();
    assert_eq!(comparable(branches), comparable(corpus_case("gitBranches", None)["result"].clone()));

    let log = scm.git_log(&repo, &cancel, "", 0, 40).await.unwrap();
    let expected = corpus_case("gitLog", Some(serde_json::json!(["", 0, 40])))["result"].clone();
    assert_eq!(comparable(log), comparable(expected));

    let show = scm.git_show(&repo, &cancel, &head).await.unwrap();
    assert_eq!(comparable(show), comparable(corpus_case("gitShow", None)["result"].clone()));

    let diff = scm.git_diff(&repo, &cancel, "new.txt", false, false, true).await.unwrap();
    assert_eq!(diff, corpus_case("gitDiff", Some(serde_json::json!(["new.txt", false, false, true])))["result"]);

    assert_eq!(scm.git_stash_list(&repo, &cancel).await.unwrap(), serde_json::json!([]));
}

#[tokio::test]
async fn mutations_leave_the_node_twin_state() {
    let (_guard, repo, head) = fixture_repo();
    let scm = scm();
    let cancel = CancellationToken::new();
    let open = scm.open(&repo, &cancel).await.unwrap();

    open.stage(&["a.txt".into()]).await.unwrap();
    let staged = scm.git_status(&repo, &cancel).await.unwrap();
    assert_eq!(comparable(staged), comparable(corpus_case("gitStatus(after stage)", None)["result"].clone()));
    open.unstage(&["a.txt".into()]).await.unwrap();

    assert!(open.commit(" ").await.is_err());
    let made = open.create_tag("v-fixture", &head).await.unwrap();
    assert!(made.starts_with("Created tag v-fixture at "));
    let duplicate = open.create_tag("v-fixture", &head).await.unwrap_err();
    assert!(duplicate.to_string().contains("already exists"));

    open.revert_file("a.txt", false, "worktree").await.unwrap();
    let after = scm.git_status(&repo, &cancel).await.unwrap();
    assert_eq!(comparable(after), comparable(corpus_case("gitStatus(after revert)", None)["result"].clone()));
}

#[tokio::test]
async fn commit_transaction_commits_only_the_selection() {
    let (_guard, repo, _head) = fixture_repo();
    let scm = scm();
    let cancel = CancellationToken::new();
    let open = scm.open(&repo, &cancel).await.unwrap();
    let summary = open.commit_paths("only b", &["src/b.mjs".into(), "new.txt".into()]).await.unwrap();
    assert!(summary.contains("only b"), "{summary}");
    assert_eq!(git(&repo, &["show", "--name-only", "--format=", "HEAD"]).replace('\r', ""), "new.txt\nsrc/b.mjs");
    // a.txt stays an unstaged edit.
    assert_eq!(git(&repo, &["status", "--porcelain"]), "M a.txt");
}

#[tokio::test]
async fn concurrent_status_reads_share_one_inspection_and_evidence_refreshes() {
    let (_guard, repo, _head) = fixture_repo();
    let scm = scm();
    let cancel = CancellationToken::new();
    let open = scm.open(&repo, &cancel).await.unwrap();
    let reference = open.repo_ref().unwrap();
    let lane = scm.lane;
    let (a, b, c) = tokio::join!(
        scm.inspector.scan(lane, reference.clone()),
        scm.inspector.scan(lane, reference.clone()),
        scm.inspector.scan(lane, reference.clone()),
    );
    assert!(a.is_ok() && b.is_ok() && c.is_ok());
    assert_eq!(scm.inspector.flights_started(), 1);
    // Cached until evidence arrives.
    scm.inspector.scan(lane, reference.clone()).await.unwrap();
    assert_eq!(scm.inspector.flights_started(), 1);
    use mixdog_core_api::domain::repo::RepoEvidence;
    use mixdog_core_api::domain::repo::RepoInspector;
    scm.inspector.evidence(&reference, RepoEvidence::WorkTree);
    scm.inspector.scan(lane, reference).await.unwrap();
    assert_eq!(scm.inspector.flights_started(), 2);
}

#[tokio::test]
async fn a_credential_request_is_told_by_the_askpass_helper_not_by_text() {
    use std::io::Read;
    use std::io::Write;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf);
            let _ = stream.write_all(
                b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"x\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
        }
    });
    let (_guard, repo, _head) = fixture_repo();
    git(&repo, &["remote", "add", "origin", &format!("http://127.0.0.1:{port}/r.git")]);
    let scm = scm();
    let cancel = CancellationToken::new();
    let open = scm.open(&repo, &cancel).await.unwrap();
    let error = open.fetch().await.unwrap_err();
    assert_eq!(error.code(), Some(crate::git::CODE_AUTH_REQUIRED), "{error:?}");
    assert!(error.to_string().starts_with("Git authentication is required."));
}
#[tokio::test]
async fn staging_by_id_stages_only_the_selected_runs_and_refuses_a_stale_diff() {
    use crate::stage_select::StageOutcome;
    let (_guard, repo, _head) = fixture_repo();
    std::fs::write(repo.join("a.txt"), "ONE\nTWO\nthree\nfour\nFIVE\n").unwrap();
    let scm = scm();
    let cancel = CancellationToken::new();
    let open = scm.open(&repo, &cancel).await.unwrap();
    let args = vec!["--".to_owned(), "a.txt".to_owned()];
    let diff = open.stageable_diff(&scm.snapshots, &repo, &args).await.unwrap();
    let id = diff.diff_id.clone().unwrap();
    assert!(diff.changes.len() >= 2, "{:?}", diff.changes);
    let first = vec![diff.changes[0].id.clone()];
    match open.stage_changes(&scm.snapshots, &repo, &id, &first).await.unwrap() {
        StageOutcome::Staged(summary) => assert_eq!(summary["changes"], 1),
        other => panic!("{other:?}"),
    }
    let staged = git(&repo, &["diff", "--cached", "--numstat", "--", "a.txt"]);
    assert!(staged.starts_with("1\t1\ta.txt"), "{staged}");
    // The working diff moved on: the old id is expired (it was consumed).
    match open.stage_changes(&scm.snapshots, &repo, &id, &first).await.unwrap() {
        StageOutcome::NotStaged { reason, .. } => assert_eq!(reason, "expired_diff"),
        other => panic!("{other:?}"),
    }
    let again = open.stageable_diff(&scm.snapshots, &repo, &args).await.unwrap();
    std::fs::write(repo.join("a.txt"), "ONE\nTWO\nthree\nfour\nFIVE\nsix\n").unwrap();
    let ids = vec![again.changes[0].id.clone()];
    match open.stage_changes(&scm.snapshots, &repo, again.diff_id.as_deref().unwrap(), &ids).await.unwrap() {
        StageOutcome::NotStaged { reason, .. } => assert_eq!(reason, "stale_diff"),
        other => panic!("{other:?}"),
    }
}
/// A process manager whose `git status` children start late: the injected slow inspection.
struct SlowStatus {
    inner: std::sync::Arc<dyn mixdog_core_api::domain::process::ProcessManager>,
    /// The inspection's status child starts once the test adds a permit; it is held, not timed,
    /// so the check does not depend on how fast the machine runs the merge's git processes.
    gate: std::sync::Arc<tokio::sync::Semaphore>,
}

#[async_trait::async_trait]
impl mixdog_core_api::domain::process::ProcessManager for SlowStatus {
    async fn spawn(
        &self,
        request: mixdog_core_api::domain::process::SpawnRequest,
    ) -> Result<mixdog_core_api::domain::process::SpawnedProcess, mixdog_core_api::domain::process::ProcessError> {
        if let mixdog_core_api::domain::process::CommandSpec::Argv { args, .. } = &request.command {
            // The inspector's scan only; the merge's own preflight status is not the inspection.
            if args.iter().any(|a| a == "--porcelain=v2") {
                // The permit goes back on drop: once the test opens the gate, every inspection status passes.
                drop(self.gate.acquire().await.unwrap());
            }
        }
        self.inner.spawn(request).await
    }

    fn subscribe(
        &self,
        handle: &mixdog_protocol::ProcessHandle,
        from_seq: Option<u64>,
    ) -> Result<
        Box<dyn mixdog_core_api::domain::common::EventSource<mixdog_core_api::domain::process::ProcessEvent>>,
        mixdog_core_api::domain::process::ProcessError,
    > {
        self.inner.subscribe(handle, from_seq)
    }

    async fn write_stdin(
        &self,
        handle: &mixdog_protocol::ProcessHandle,
        bytes: Vec<u8>,
    ) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
        self.inner.write_stdin(handle, bytes).await
    }

    fn close_stdin(&self, handle: &mixdog_protocol::ProcessHandle) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
        self.inner.close_stdin(handle)
    }

    fn resize_pty(
        &self,
        handle: &mixdog_protocol::ProcessHandle,
        size: mixdog_core_api::domain::process::PtySize,
    ) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
        self.inner.resize_pty(handle, size)
    }

    fn kill(&self, handle: &mixdog_protocol::ProcessHandle) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
        self.inner.kill(handle)
    }

    fn list(&self) -> Vec<mixdog_core_api::domain::process::ProcessInfo> {
        self.inner.list()
    }
}

#[tokio::test]
async fn g9_a_slow_inspection_delays_neither_a_review_page_nor_a_merge() {
    use mixdog_core_api::domain::repo::Cached;
    use mixdog_core_api::domain::repo::RepoInspector;
    use mixdog_core_api::domain::repo::ReviewRequest;
    use mixdog_core_api::domain::repo::ReviewScope;
    use crate::worktree::branches::CheckoutRequest;
    let (_guard, repo, _head) = fixture_repo();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "clean"]);
    git(&repo, &["branch", "topic"]);
    let gate = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
    let slow_pm: std::sync::Arc<dyn mixdog_core_api::domain::process::ProcessManager> =
        std::sync::Arc::new(SlowStatus { inner: TestProcesses::shared(), gate: gate.clone() });
    let scm = Scm::new(
        slow_pm,
        mixdog_rt::testing::tokens().maintenance_io,
        std::env::temp_dir().join("mixdog-scm-g9"),
    );
    let cancel = CancellationToken::new();
    let reference = scm.open(&repo, &cancel).await.unwrap().repo_ref().unwrap();
    // The review summary of an earlier key is cached; the slow status scan starts now.
    let base = mixdog_core_api::domain::repo::ObjectId(git(&repo, &["rev-parse", "HEAD"]));
    let request = ReviewRequest {
        repo: reference.clone(),
        scope: ReviewScope::Session { thread_id: mixdog_protocol::ThreadId::from("t") },
        base,
    };
    let summary = scm.inspector.review_summary(scm.lane, request).await.unwrap();
    let inspecting = {
        let scm = scm.clone();
        let reference = reference.clone();
        tokio::spawn(async move { scm.inspector.scan(scm.lane, reference).await.map(drop) })
    };
    let started = std::time::Instant::now();
    // review/diff/get: answered from the cache while the inspection runs.
    let page = scm.inspector.review_page(&summary.key, None, None).unwrap();
    assert!(matches!(page, Cached::Ready(_)));
    assert!(started.elapsed() < std::time::Duration::from_millis(500));
    // A merge takes the repository lock and does not wait for the inspection.
    let worktrees = crate::worktree::manager::Worktrees::new(scm.clone(), std::env::temp_dir().join("mixdog-g9-data"));
    let merged = worktrees
        .merge_branch_into_project(&repo, "topic", "main", true, &cancel)
        .await
        .unwrap();
    assert_eq!(merged["merged"], true);
    assert!(!inspecting.is_finished(), "the merge waited for the inspection");
    gate.add_permits(1);
    let _ = CheckoutRequest { project_path: repo.clone(), branch: None, create: false, remote: false, start_point: None, detach: None };
    inspecting.await.unwrap().unwrap();
}

#[tokio::test]
async fn a_captured_review_base_diffs_only_what_changed_since() {
    use mixdog_core_api::domain::repo::RepoInspector;
    use mixdog_core_api::domain::repo::ReviewRequest;
    use mixdog_core_api::domain::repo::ReviewScope;
    use crate::service::ReviewBases;
    let (_guard, repo, _head) = fixture_repo();
    let scm = scm();
    let cancel = CancellationToken::new();
    let open = scm.open(&repo, &cancel).await.unwrap();
    // The turn starts with the fixture's edits already in the work tree.
    let base = open.capture_review_base().await.unwrap();
    std::fs::write(repo.join("later.txt"), "after\n").unwrap();
    let bases = crate::worktree::review_bases::CapturedBases::new();
    let thread = mixdog_protocol::ThreadId::from("t1");
    bases.record(&thread, mixdog_app_protocol::v2::domain::ReviewScope::Turn, Some("cp1"), repo.clone(), base);
    let (cwd, found) = bases
        .base(&thread, mixdog_app_protocol::v2::domain::ReviewScope::Turn, Some("cp1"))
        .await
        .unwrap();
    assert_eq!(cwd, repo);
    let summary = scm
        .inspector
        .review_summary(
            scm.lane,
            ReviewRequest {
                repo: open.repo_ref().unwrap(),
                scope: ReviewScope::Session { thread_id: thread.clone() },
                base: found,
            },
        )
        .await
        .unwrap();
    let paths: Vec<_> = summary.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, ["later.txt"]);
    assert!(bases.base(&thread, mixdog_app_protocol::v2::domain::ReviewScope::Session, None).await.is_none());
}

#[tokio::test]
async fn claiming_the_setup_detaches_an_old_dependency_link_without_touching_the_main_checkout() {
    use crate::worktree::include::IncludeItem;
    use crate::worktree::manager::CreateRequest;
    use crate::worktree::manager::Worktrees;
    let (_guard, repo, _head) = fixture_repo();
    std::fs::create_dir_all(repo.join("node_modules").join("pkg")).unwrap();
    std::fs::write(repo.join("node_modules").join("pkg").join("x.txt"), "kept\n").unwrap();
    let data = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let worktrees = Worktrees::new(scm(), data.path().to_path_buf());
    let created = worktrees
        .create_full(
            CreateRequest {
                project_path: repo.clone(),
                session_id: "s1".into(),
                runtime_token: "rt".into(),
                tx_id: "t1".into(),
                name_hint: "links".into(),
                carry: Some("leave".into()),
                ..CreateRequest::default()
            },
            &cancel,
        )
        .await
        .unwrap();
    // What an earlier version recorded: node_modules linked into the main checkout.
    let link = std::path::Path::new(&created.record.path).join("node_modules");
    let source = repo.join("node_modules");
    #[cfg(windows)]
    assert!(std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(&link).arg(&source).output().unwrap().status.success());
    #[cfg(not(windows))]
    std::os::unix::fs::symlink(&source, &link).unwrap();
    let mut record = created.record.clone();
    let item = IncludeItem {
        mode: "link".into(),
        rel: "node_modules".into(),
        path: link.to_string_lossy().into_owned(),
        status: "created".into(),
        digest: None,
        source: Some(source.to_string_lossy().into_owned()),
        link_type: None,
        dependency: true,
    };
    record.extra.insert("resources".into(), serde_json::json!({ "includes": [item] }));
    worktrees.put_record(&cancel, record).await.unwrap();

    let claim = worktrees.claim_setup(&created.record.id, &cancel).await.unwrap().unwrap();
    assert!(claim.blocked.is_empty() && claim.prepared.is_some(), "{claim:?}");
    assert!(std::fs::symlink_metadata(&link).is_err(), "the link is gone");
    assert_eq!(std::fs::read_to_string(source.join("pkg").join("x.txt")).unwrap(), "kept\n");
    assert!(worktrees.claim_setup(&created.record.id, &cancel).await.unwrap().is_none());
}

struct TinyThreshold;
#[async_trait::async_trait]
impl crate::worktree::settings::SettingsSource for TinyThreshold {
    async fn worktree_settings(&self) -> crate::worktree::settings::WorktreeSettings {
        crate::worktree::settings::WorktreeSettings { size_warn_bytes: 1, ..Default::default() }
    }
}

#[tokio::test]
async fn creation_asks_before_a_large_repo_and_before_pending_changes_and_carries_them_faithfully() {
    use crate::worktree::manager::CreateRequest;
    use crate::worktree::manager::Worktrees;
    let (_guard, repo, head) = fixture_repo();
    // A local env file the repository ignores: it stays in the project folder and is copied.
    std::fs::write(repo.join(".env"), "SECRET=1\n").unwrap();
    let exclude = repo.join(".git").join("info").join("exclude");
    std::fs::create_dir_all(exclude.parent().unwrap()).unwrap();
    std::fs::write(&exclude, ".env\n").unwrap();
    let data = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let request = CreateRequest {
        project_path: repo.clone(),
        session_id: "s1".into(),
        runtime_token: "rt".into(),
        tx_id: "t1".into(),
        name_hint: "carry it".into(),
        ..CreateRequest::default()
    };

    // A repository over the size threshold waits for the user's yes.
    let large = Worktrees::new(scm(), data.path().to_path_buf()).with_settings(std::sync::Arc::new(TinyThreshold));
    let refused = large.create_full(request.clone(), &cancel).await.unwrap_err();
    assert_eq!(refused.code(), Some(crate::worktree::errors::WORKTREE_LARGE_REPO_CONFIRM));

    let worktrees = Worktrees::new(scm(), data.path().to_path_buf());
    // `ask` refuses while the project folder has changes, naming them.
    let asked = worktrees
        .create_full(CreateRequest { carry: Some("ask".into()), ..request.clone() }, &cancel)
        .await
        .unwrap_err();
    assert_eq!(asked.code(), Some("WORKTREE_DIRTY_CHOICE"));

    let before_status = git(&repo, &["status", "--porcelain"]);
    assert!(before_status.contains("a.txt") && before_status.contains("new.txt"));
    let created = worktrees
        .create_full(CreateRequest { carry: Some("carry".into()), ..request }, &cancel)
        .await
        .unwrap();
    let changes = created.changes.clone().unwrap();
    assert_eq!(changes["mode"], "carried");
    assert_eq!(changes["count"], 3);
    // The project folder is clean (its ignored/env file stays), the worktree holds the changes
    // with the staged state kept, and the env file was copied.
    assert_eq!(git(&repo, &["status", "--porcelain", "--untracked-files=all"]), "", "{changes}");
    let work = std::path::Path::new(&created.record.path);
    let status = git(work, &["status", "--porcelain", "--untracked-files=all"]);
    assert!(status.contains("M  src/b.mjs"), "{status}");
    assert!(status.contains("a.txt") && status.contains("?? new.txt"), "{status}");
    assert_eq!(std::fs::read_to_string(work.join(".env")).unwrap(), "SECRET=1\n");
    assert_eq!(created.prepared["copied"], serde_json::json!([".env"]));
    assert_eq!(created.record.state, "ready");

    // The kept recovery ref restores the project folder exactly while it is still clean.
    let reference = changes["recoveryRef"].as_str().unwrap().to_owned();
    let top = repo.clone();
    worktrees.restore_from_recovery_ref(&top, "", &reference, &cancel).await.unwrap();
    let restored = git(&repo, &["status", "--porcelain", "--untracked-files=all"]);
    assert!(restored.contains("M  src/b.mjs") && restored.contains("?? new.txt"), "{restored}");
    worktrees.drop_recovery_ref(&top, &reference, &cancel).await.unwrap();
    assert!(git(&repo, &["for-each-ref", "refs/mixdog/carry"]).is_empty());
    let _ = head;
    // The same worktree comes off with its links and lock lifted.
    git(work, &["reset", "--hard", "--quiet"]);
    git(work, &["clean", "-fdq", "-e", ".env"]);
    let removed = worktrees.remove(&created.record.id, true, Some("s1"), &cancel).await.unwrap();
    assert_eq!(removed["removed"], true);
}

struct AuthOk;
#[async_trait::async_trait]
impl crate::gh::client::GhRunner for AuthOk {
    async fn raw(
        &self,
        _command: &crate::gh::commands::GhCommand,
        _cwd: &std::path::Path,
        _cancel: &CancellationToken,
    ) -> Result<crate::gh::client::GhOutput, crate::error::ScmFailure> {
        Ok(crate::gh::client::GhOutput {
            code: Some(0),
            stdout: "Logged in to github.com account octo (keyring)".into(),
            stderr: String::new(),
        })
    }
}

/// A `gh` stand-in that prints the device code and then runs (or, for `quick`, ends).
fn login_shim(dir: &std::path::Path, quick: bool) -> String {
    let (name, body) = if cfg!(windows) {
        (
            "gh.cmd",
            format!(
                "@echo off\r\necho First copy your one-time code: ABCD-1234\r\necho Open https://github.com/login/device\r\n{}",
                if quick { "exit /b 0\r\n" } else { "ping -n 30 127.0.0.1 >nul\r\n" }
            ),
        )
    } else {
        (
            "gh.sh",
            format!(
                "#!/bin/sh\necho 'First copy your one-time code: ABCD-1234'\necho 'Open https://github.com/login/device'\n{}",
                if quick { "exit 0\n" } else { "sleep 30\n" }
            ),
        )
    };
    let path = dir.join(name);
    std::fs::write(&path, body).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    path.to_string_lossy().into_owned()
}

/// `AuthOk` once `open` turns true. `next` hands over the latest state, not every state, so a
/// reader that is not polling when gh's output and exit come together would never see the code;
/// the verification that ends the flow waits for the test to have read it.
struct AuthOkWhenOpen(tokio::sync::watch::Receiver<bool>);
#[async_trait::async_trait]
impl crate::gh::client::GhRunner for AuthOkWhenOpen {
    async fn raw(
        &self,
        command: &crate::gh::commands::GhCommand,
        cwd: &std::path::Path,
        cancel: &CancellationToken,
    ) -> Result<crate::gh::client::GhOutput, crate::error::ScmFailure> {
        let mut open = self.0.clone();
        open.wait_for(|open| *open).await.expect("the test holds the sender");
        AuthOk.raw(command, cwd, cancel).await
    }
}

fn login_for(program: String) -> crate::gh::login::GithubLogin {
    login_with(program, std::sync::Arc::new(AuthOk))
}

fn login_with(program: String, runner: std::sync::Arc<dyn crate::gh::client::GhRunner>) -> crate::gh::login::GithubLogin {
    let scm = Scm::with_gh(
        TestProcesses::shared(),
        mixdog_rt::testing::tokens().maintenance_io,
        std::env::temp_dir().join("mixdog-scm-login"),
        runner,
        std::sync::Arc::new(move || program.clone()),
    );
    scm.github_login()
}

async fn next_state(
    session: &dyn mixdog_core_api::domain::login::LoginSession,
) -> mixdog_core_api::domain::login::LoginState {
    session.next().await.expect("a state")
}

#[tokio::test]
async fn a_login_flow_shows_its_code_to_a_reconnect_and_finishes_when_gh_exits() {
    use mixdog_core_api::domain::login::LoginFlow;
    use mixdog_core_api::domain::login::LoginState;
    let dir = tempfile::tempdir().unwrap();
    let (finish, finished) = tokio::sync::watch::channel(false);
    let flow = login_with(login_shim(dir.path(), true), std::sync::Arc::new(AuthOkWhenOpen(finished)));
    let session = flow.start().await.unwrap();
    let mut seen_code = None;
    let last = loop {
        let state = next_state(session.as_ref()).await;
        if let LoginState::DeviceCode { user_code, verification_uri, .. } = &state {
            seen_code = Some((user_code.clone(), verification_uri.clone()));
            finish.send_replace(true);
        }
        if state.is_terminal() {
            break state;
        }
    };
    assert_eq!(seen_code, Some(("ABCD-1234".into(), "https://github.com/login/device".into())));
    assert_eq!(last, LoginState::Done { account: Some("octo".into()) });
    // A reconnect reads the current state; the delivered terminal state ends the stream.
    assert_eq!(session.state(), last);
    assert!(session.next().await.is_none());
}

#[tokio::test]
async fn cancelling_a_login_flow_ends_it_and_a_second_start_supersedes_the_first() {
    use mixdog_core_api::domain::login::LoginFlow;
    use mixdog_core_api::domain::login::LoginState;
    let dir = tempfile::tempdir().unwrap();
    let flow = login_for(login_shim(dir.path(), false));
    let first = flow.start().await.unwrap();
    loop {
        if matches!(next_state(first.as_ref()).await, LoginState::DeviceCode { .. }) {
            break;
        }
    }
    first.cancel();
    assert_eq!(first.state(), LoginState::Cancelled);
    assert_eq!(next_state(first.as_ref()).await, LoginState::Cancelled);
    let second = flow.start().await.unwrap();
    loop {
        if matches!(next_state(second.as_ref()).await, LoginState::DeviceCode { .. }) {
            break;
        }
    }
    let third = flow.start().await.unwrap();
    assert_eq!(second.state(), LoginState::Cancelled, "a fresh start supersedes the earlier flow");
    third.cancel();
}

struct OpenAdmission;
#[async_trait::async_trait]
impl crate::worktree::branches::FolderAdmission for OpenAdmission {
    async fn admit(
        &self,
        _folders: &[std::path::PathBuf],
        _removing: bool,
    ) -> Result<crate::worktree::branches::Admitted, crate::error::ScmFailure> {
        Ok(crate::worktree::branches::Admitted { retained_session_ids: Vec::new(), hold: None })
    }
}

#[tokio::test]
async fn the_branch_menu_checks_out_merges_and_deletes_through_one_guarded_path() {
    use crate::worktree::branches::CheckoutRequest;
    use crate::worktree::branches::ManageRequest;
    use crate::worktree::manager::Worktrees;
    let (_guard, repo, _head) = fixture_repo();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "clean"]);
    let data = tempfile::tempdir().unwrap();
    let worktrees = Worktrees::new(scm(), data.path().to_path_buf());
    let cancel = CancellationToken::new();

    // `feature` is free; check it out, then come back to main.
    let occupancy = worktrees.branch_occupancy(&repo, None, &cancel).await.unwrap();
    assert_eq!(occupancy["occupancy"][0]["kind"], "free");
    let checkout = |branch: &str, create: bool| CheckoutRequest {
        project_path: repo.clone(),
        branch: Some(branch.into()),
        create,
        remote: false,
        start_point: None,
        detach: None,
    };
    let created = worktrees.checkout_project_branch(checkout("topic", true), &cancel).await.unwrap();
    assert_eq!(created["changed"], true);
    std::fs::write(repo.join("t.txt"), "t\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "topic work"]);
    // A dirty tracked file refuses the switch with the project-dirty reason.
    std::fs::write(repo.join("a.txt"), "dirty\n").unwrap();
    let refused = worktrees.checkout_project_branch(checkout("main", false), &cancel).await.unwrap_err();
    assert_eq!(refused.code(), Some(crate::worktree::errors::WORKTREE_DIRTY));
    git(&repo, &["checkout", "--", "a.txt"]);
    worktrees.checkout_project_branch(checkout("main", false), &cancel).await.unwrap();

    // Merge topic into main through the guarded path; a stale commit is a revision conflict.
    let state = worktrees.inspect_project_branch(&repo, "topic", &cancel).await.unwrap();
    let request = ManageRequest {
        project_path: repo.clone(),
        branch: "topic".into(),
        action: "merge".into(),
        commit: state.commit.clone(),
        target: state.target.clone(),
        target_commit: state.target_commit.clone(),
        confirmed: true,
        force: false,
    };
    let stale = ManageRequest { commit: "0".repeat(40), ..request.clone() };
    let conflict = worktrees.manage_project_branch(stale, &OpenAdmission, &cancel).await.unwrap_err();
    assert_eq!(conflict.code(), Some(crate::worktree::errors::WORKTREE_REVISION_CONFLICT));
    let merged = worktrees.manage_project_branch(request, &OpenAdmission, &cancel).await.unwrap();
    assert_eq!(merged["merged"], true);

    // The merged branch deletes; the check happens against the commits the user saw.
    let state = worktrees.inspect_project_branch(&repo, "topic", &cancel).await.unwrap();
    let delete = ManageRequest {
        project_path: repo.clone(),
        branch: "topic".into(),
        action: "delete-branch".into(),
        commit: state.commit,
        target: state.target,
        target_commit: state.target_commit,
        confirmed: true,
        force: false,
    };
    let deleted = worktrees.manage_project_branch(delete, &OpenAdmission, &cancel).await.unwrap();
    assert_eq!(deleted["deleted"], true);
    assert!(git(&repo, &["branch", "--list", "topic"]).is_empty());
}

struct NoRetention;
impl crate::worktree::manager::Retention for NoRetention {
    fn owner_live(&self, _: &crate::worktree::registry::WorktreeRecord) -> bool { false }
    fn retained(&self, _: &crate::worktree::registry::WorktreeRecord) -> bool { false }
}

/// Node's `createSnapshotWorktree` over a real repository (`record-snapshot-checkout.mjs`): the
/// record and its ledger, the lock git lists, the owner lease.
#[tokio::test]
async fn a_snapshot_is_locked_for_its_holder_and_leased_as_nodes_is() {
    use crate::worktree::manager::Worktrees;
    let golden: Value = serde_json::from_str(include_str!("../../../fixtures/snapshot-checkout/golden.json")).unwrap();
    let node = &golden["created"];
    let (_guard, repo, _head) = fixture_repo();
    let data = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let worktrees = Worktrees::new(scm(), data.path().to_path_buf());
    let holder = crate::worktree::ownership::Owner { session_id: "holder-1".into(), runtime_token: "runtime-1".into(), pid: Some(std::process::id()) };
    let record = worktrees.snapshot_held(&repo, &holder, "HEAD", "tx-1", false, &cancel).await.unwrap();
    let resources = &record.extra["resources"];
    assert_eq!(
        serde_json::json!({
            "kind": record.extra["kind"],
            "state": record.state,
            "existingBranch": record.extra["existingBranch"],
            "disposable": record.extra["disposable"],
            "ownerSessionId": record.owner_session_id,
            "holderIsTheSession": record.extra["holderSessionId"] == "holder-1",
            "resources": { "worktree": resources["worktree"], "lock": resources["lock"], "owner": resources["owner"] },
        }),
        node["record"]
    );
    let listing = git(&repo, &["worktree", "list", "--porcelain"]);
    let lock = listing.lines().find(|line| line.starts_with("locked")).unwrap_or("").replace("holder-1", "<holder>");
    assert_eq!(lock, node["lockReason"].as_str().unwrap());
    let lease = worktrees.read_owner_lease(&record, &cancel).await.unwrap().expect("the holder's lease");
    assert_eq!(
        serde_json::json!({ "sessionIsTheHolder": lease.owner.session_id == "holder-1", "runtimeTokenIsTheHolders": lease.owner.runtime_token == "runtime-1" }),
        node["lease"]
    );
    assert_eq!(listing.lines().filter(|line| line.starts_with("worktree ")).count() as u64, node["worktrees"].as_u64().unwrap());
}

/// Node's `canonicalPath`, `inspectRepo` and `listWorktrees` over sixteen spellings of the same folders
/// (`record-canonical-paths.mjs`): relative, `..`, mixed separators, other casing, through a junction, the 8.3 short
/// name, a trailing separator and a tail that does not exist. The process runs in the sandbox, as the recording did.
#[tokio::test]
async fn paths_are_spelled_as_nodes_canonical_path_does() {
    use crate::worktree::manager::Worktrees;
    use mixdog_workspace::pathguard::canonical_path;
    use std::os::windows::process::CommandExt;
    let golden: Value = serde_json::from_str(include_str!("../../../fixtures/canonical-paths/golden.json")).unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let verbatim = std::fs::canonicalize(scratch.path()).unwrap();
    let base = std::path::PathBuf::from(verbatim.to_string_lossy().trim_start_matches(r"\\?\")).join("Long Folder Name");
    let repo = base.join("repo");
    std::fs::create_dir_all(repo.join("sub")).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "first"]);
    git(&repo, &["worktree", "add", "-q", "-b", "side", base.join("linked").to_str().unwrap()]);
    let junction = Command::new("cmd").args(["/c", "mklink", "/J"]).arg(base.join("junc")).arg(&repo).output().unwrap();
    assert!(junction.status.success(), "mklink: {}", String::from_utf8_lossy(&junction.stdout));
    let short = Command::new("cmd").arg("/c").raw_arg(format!("for %I in (\"{}\") do @echo %~sI", base.display())).output().unwrap();
    let short = String::from_utf8(short.stdout).unwrap().trim().to_owned();
    let base_text = base.to_string_lossy().into_owned();
    assert_ne!(short, base_text, "the sandbox has no 8.3 short name");
    std::env::set_current_dir(&base).unwrap();
    let spell = |text: &str| text.replace("<BASE_SHORT>", &short).replace("<BASE_UPPER>", &base_text.to_uppercase()).replace("<BASE>", &base_text);
    let mask = |text: &str| text.replace(&base_text, "<BASE>");
    let data = tempfile::tempdir().unwrap();
    let worktrees = Worktrees::new(scm(), data.path().to_path_buf());
    let cancel = CancellationToken::new();
    for case in golden["cases"].as_array().unwrap() {
        let input = case["input"].as_str().unwrap();
        let spelled = std::path::PathBuf::from(spell(input));
        assert_eq!(mask(&canonical_path(&spelled).to_string_lossy()), case["canonical"], "{input}: canonicalPath");
        let facts = &case["facts"];
        match worktrees.inspect_repo(&spelled, &cancel).await {
            Ok(got) => {
                assert_eq!(mask(&got.project_path.to_string_lossy()), facts["projectPath"], "{input}: projectPath");
                assert_eq!(mask(&got.top_level.to_string_lossy()), facts["topLevel"], "{input}: topLevel");
                assert_eq!(mask(&got.common_dir.to_string_lossy()), facts["repoCommonDir"], "{input}: repoCommonDir");
                assert_eq!(got.current_branch.as_deref(), facts["currentBranch"].as_str(), "{input}: currentBranch");
                let rows: Vec<String> = worktrees.list_git_worktrees(&mixdog_workspace::pathguard::resolve(&spelled), &cancel).await.unwrap().into_iter().map(|row| mask(&row.path)).collect();
                assert_eq!(serde_json::json!(rows), case["rows"], "{input}: worktree rows");
            }
            Err(failure) => {
                let mixdog_core_api::CoreError::DomainError { code, detail, .. } = mixdog_core_api::CoreError::from(failure) else { panic!("{input}: not a domain error") };
                assert_eq!(code.as_deref(), facts["error"].as_str(), "{input}: refusal");
                let path = serde_json::to_value(detail).unwrap()["projectPath"].as_str().map(mask);
                assert_eq!(path.as_deref(), facts["projectPath"].as_str(), "{input}: refusal projectPath");
                assert!(case["rows"].is_null());
            }
        }
    }
}

#[tokio::test]
async fn a_snapshot_whose_lease_cannot_be_written_is_rolled_back_whole() {
    use crate::worktree::manager::Worktrees;
    let golden: Value = serde_json::from_str(include_str!("../../../fixtures/snapshot-checkout/golden.json")).unwrap();
    let node = &golden["failed"];
    let (_guard, repo, _head) = fixture_repo();
    let data = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let worktrees = Worktrees::new(scm(), data.path().to_path_buf());
    let facts = worktrees.inspect_repo(&repo, &cancel).await.unwrap();
    let root = crate::worktree::names::managed_root(data.path(), &facts.common_dir);
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join(".owners"), "in the way").unwrap();
    let holder = crate::worktree::ownership::Owner { session_id: "holder-1".into(), runtime_token: "runtime-1".into(), pid: Some(std::process::id()) };
    let failed = worktrees.snapshot_held(&repo, &holder, "HEAD", "tx-1", false, &cancel).await.is_err();
    let ids: Vec<String> = worktrees.list(None, &NoRetention, &cancel).await.unwrap().iter().map(|row| row["id"].as_str().unwrap().to_owned()).collect();
    assert_eq!(
        serde_json::json!({
            "threw": failed,
            "registryIds": ids,
            "worktrees": git(&repo, &["worktree", "list", "--porcelain"]).lines().filter(|line| line.starts_with("worktree ")).count(),
        }),
        *node
    );
}

#[tokio::test]
async fn a_managed_worktree_is_created_refused_while_unmerged_then_merged_and_removed() {
    use crate::worktree::errors::WORKTREE_UNMERGED;
    use crate::worktree::manager::CreateRequest;
    use crate::worktree::manager::Worktrees;
    let (_guard, repo, _head) = fixture_repo();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "clean"]);
    let data = tempfile::tempdir().unwrap();
    let scm = scm();
    let worktrees = Worktrees::new(scm.clone(), data.path().to_path_buf());
    let cancel = CancellationToken::new();
    let request = CreateRequest {
        project_path: repo.clone(),
        session_id: "s1".into(),
        tx_id: "t1".into(),
        name_hint: "Add feature".into(),
        ..CreateRequest::default()
    };
    let made = worktrees.create(request.clone(), &cancel).await.unwrap();
    assert_eq!(made.id, "add-feature");
    assert_eq!(made.state, "ready");
    // The same transaction returns the same worktree.
    assert_eq!(worktrees.create(request, &cancel).await.unwrap().id, made.id);

    std::fs::write(std::path::Path::new(&made.path).join("w.txt"), "w\n").unwrap();
    let dirty = worktrees.remove(&made.id, false, Some("s1"), &cancel).await.unwrap_err();
    assert_eq!(dirty.code(), Some(crate::worktree::errors::WORKTREE_DIRTY));
    git(std::path::Path::new(&made.path), &["add", "-A"]);
    git(std::path::Path::new(&made.path), &["commit", "-q", "-m", "work"]);
    let unmerged = worktrees.remove(&made.id, false, Some("s1"), &cancel).await.unwrap_err();
    assert_eq!(unmerged.code(), Some(WORKTREE_UNMERGED));

    let merged = worktrees.merge(&made.id, Some("main"), true, &cancel).await.unwrap();
    assert!(merged.merged && merged.conflicts.is_none());
    assert!(worktrees.merge(&made.id, Some("main"), false, &cancel).await.is_err());
    let rows = worktrees.list(None, &NoRetention, &cancel).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["mergeTarget"], "main");
    let removed = worktrees.remove(&made.id, false, Some("s1"), &cancel).await.unwrap();
    assert_eq!(removed["removed"], true);
    assert_eq!(removed["branchDeleted"], true);
    assert!(!std::path::Path::new(&made.path).exists());
    assert!(worktrees.list(None, &NoRetention, &cancel).await.unwrap().is_empty());
}
async fn two_worktrees() -> (tempfile::TempDir, tempfile::TempDir, crate::worktree::manager::Worktrees, Vec<crate::worktree::registry::WorktreeRecord>, CancellationToken) {
    use crate::worktree::manager::CreateRequest;
    use crate::worktree::manager::Worktrees;
    let (guard, repo, _head) = fixture_repo();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "clean"]);
    let data = tempfile::tempdir().unwrap();
    let worktrees = Worktrees::new(scm(), data.path().to_path_buf());
    let cancel = CancellationToken::new();
    let mut made = Vec::new();
    for (session, name) in [("s1", "first"), ("s2", "second")] {
        let request = CreateRequest { project_path: repo.clone(), session_id: session.into(), tx_id: format!("t-{name}"), name_hint: name.into(), ..CreateRequest::default() };
        made.push(worktrees.create(request, &cancel).await.unwrap());
    }
    (guard, data, worktrees, made, cancel)
}

#[tokio::test]
async fn a_removal_is_decided_then_finished_and_keeps_work_reachable() {
    use crate::worktree::removal::RemoveRequest;
    let (_guard, _data, worktrees, made, cancel) = two_worktrees().await;
    let first = &made[0];
    let path = std::path::Path::new(&first.path);
    std::fs::write(path.join("w.txt"), "w\n").unwrap();
    git(path, &["add", "-A"]);
    git(path, &["commit", "-q", "-m", "work"]);
    let commit = git(path, &["rev-parse", "HEAD"]);
    // Forced removal drops unmerged work: the branch stays reachable by a recovery ref.
    let request = RemoveRequest { entry_id: first.id.clone(), force: true, session_id: Some("s1".into()), ..RemoveRequest::default() };
    let out = worktrees.remove_managed(request, &cancel).await.unwrap();
    assert_eq!(out["removed"], true);
    assert!(!path.exists());
    assert!(worktrees.record(&cancel, &first.id).await.unwrap().is_none());
    let reachable = git(std::path::Path::new(&made[1].project_path), &["for-each-ref", "--contains", &commit, "--format=%(refname)"]);
    assert!(!reachable.is_empty(), "the removed work stays reachable");
}

#[tokio::test]
async fn a_reconcile_removes_clean_unretained_work_keeps_the_rest_and_resumes_a_decided_deletion() {
    use crate::worktree::reconcile::ReconcileOptions;
    let (_guard, _data, worktrees, made, cancel) = two_worktrees().await;
    let (first, second) = (&made[0], &made[1]);
    // `second` has an uncommitted file; `first` is clean and merged.
    std::fs::write(std::path::Path::new(&second.path).join("dirty.txt"), "d\n").unwrap();
    // The final status check is time-bounded and a check that runs out is `busy` by design; this
    // test is about what reconcile decides, so the bound is lifted and a slow `git status` on a
    // loaded machine cannot turn the clean worktree into a `busy` one.
    let options = ReconcileOptions { remove_orphans: true, final_check_timeout: std::time::Duration::from_secs(3600), ..ReconcileOptions::default() };
    let (ids, _) = worktrees.preview_cleanup(&options, &cancel).await.unwrap();
    assert_eq!(ids.len(), 2, "the preview does not verify: both are candidates");
    let report = worktrees.reconcile(&options, &cancel).await.unwrap();
    assert_eq!(report.removed, [first.id.clone()], "{report:?}");
    assert!(report.kept.iter().any(|k| k["id"] == second.id.as_str() && k["reason"] == "dirty"), "{:?}", report.kept);
    assert!(std::path::Path::new(&second.path).exists());
    // A retained session keeps its clean worktree.
    std::fs::remove_file(std::path::Path::new(&second.path).join("dirty.txt")).unwrap();
    let mut retained = options.clone();
    retained.retained = ["s2".to_owned()].into();
    assert!(worktrees.reconcile(&retained, &cancel).await.unwrap().removed.is_empty());
    // A decided deletion that was interrupted is resumed by any pass.
    let mut record = worktrees.record(&cancel, &second.id).await.unwrap().unwrap();
    record.state = "deleting".into();
    record.extra.insert("deleting".into(), serde_json::json!({ "force": false, "remaining": [] }));
    worktrees.put_record(&cancel, record).await.unwrap();
    let resumed = worktrees.reconcile(&ReconcileOptions::default(), &cancel).await.unwrap();
    assert_eq!(resumed.removed, [second.id.clone()]);
    assert!(!std::path::Path::new(&second.path).exists());
}

struct Sessions {
    stored: std::collections::HashSet<String>,
    jobs: Vec<crate::worktree::maintenance::ShellJob>,
}

#[async_trait::async_trait]
impl crate::worktree::maintenance::SessionSource for Sessions {
    async fn stored_session_ids(&self) -> Result<std::collections::HashSet<String>, crate::error::ScmFailure> {
        Ok(self.stored.clone())
    }
    async fn favorites(&self) -> Option<std::collections::HashSet<String>> {
        Some(Default::default())
    }
    async fn archived(&self) -> Option<std::collections::HashSet<String>> {
        None
    }
    async fn activity(&self, _: &[String]) -> std::collections::HashMap<String, crate::worktree::maintenance::SessionActivity> {
        Default::default()
    }
    async fn running_jobs(&self) -> Result<Vec<crate::worktree::maintenance::ShellJob>, crate::error::ScmFailure> {
        Ok(self.jobs.clone())
    }
}

#[tokio::test]
async fn the_cleanup_pass_removes_unretained_work_but_not_what_a_job_or_a_stored_session_keeps() {
    use crate::worktree::maintenance::CleanupOptions;
    use crate::worktree::maintenance::SessionSource;
    use crate::worktree::maintenance::ShellJob;
    use crate::worktree::settings::WorktreeSettings;
    let (_guard, _data, worktrees, made, cancel) = two_worktrees().await;
    let (first, second) = (&made[0], &made[1]);
    let off = CleanupOptions { settings: Some(WorktreeSettings { auto_cleanup: false, ..WorktreeSettings::default() }), ..CleanupOptions::default() };
    // The final status check is bounded and a check that runs out is `busy`; the bound is lifted
    // so a slow `git status` on a loaded machine cannot turn the removal below into a `busy` keep.
    let on = CleanupOptions {
        settings: Some(WorktreeSettings::default()),
        final_check_timeout: Some(std::time::Duration::from_secs(3600)),
        ..CleanupOptions::default()
    };
    let sessions: std::sync::Arc<dyn SessionSource> = std::sync::Arc::new(Sessions {
        stored: ["s1".to_owned()].into(),
        jobs: vec![ShellJob { cwd: Some(format!("{}/sub", second.path)), owner_session_id: None }],
    });
    // Off: the bookkeeping pass only, nothing selected or removed.
    let report = worktrees.run_worktree_cleanup(&sessions, &off, &cancel).await.unwrap();
    assert_eq!(report["removed"], serde_json::json!([]));
    assert_eq!(report["selected"], serde_json::json!([]));
    // The creating process holds an owner lease; these sessions' runtime has ended.
    for record in &made {
        worktrees.remove_owner_lease(record, &cancel).await.unwrap();
    }
    // A job running in a folder makes its owner live, so the preview skips that worktree; with
    // the job gone it names the unretained one (nothing is verified).
    let (ids, _) = worktrees.preview_worktree_cleanup(&sessions, &on, &cancel).await.unwrap();
    assert!(ids.is_empty(), "{ids:?}");
    let idle: std::sync::Arc<dyn SessionSource> = std::sync::Arc::new(Sessions { stored: ["s1".to_owned()].into(), jobs: Vec::new() });
    let (ids, _) = worktrees.preview_worktree_cleanup(&idle, &on, &cancel).await.unwrap();
    assert_eq!(ids, [second.id.clone()]);
    // On: `first` belongs to a stored session and stays; `second` has a job running in it.
    let report = worktrees.run_worktree_cleanup(&sessions, &on, &cancel).await.unwrap();
    assert_eq!(report["removed"], serde_json::json!([]), "{report}");
    assert!(std::path::Path::new(&second.path).exists() && std::path::Path::new(&first.path).exists());
    assert_eq!(report["limits"], "applied");
    // Once the job ends the unretained worktree goes.
    let report = worktrees.run_worktree_cleanup(&idle, &on, &cancel).await.unwrap();
    assert_eq!(report["removed"], serde_json::json!([second.id]), "{report}");
    assert!(!std::path::Path::new(&second.path).exists());
}

#[tokio::test]
async fn a_registered_recovery_store_keeps_its_worktree_through_a_restart_until_the_host_discards_it() {
    use crate::worktree::housekeeping::RecoveryAction;
    use crate::worktree::maintenance::CleanupOptions;
    use crate::worktree::maintenance::SessionSource;
    use sha2::Digest;
    let (_guard, data, worktrees, made, cancel) = two_worktrees().await;
    let entry = &made[0];
    worktrees.remove_owner_lease(entry, &cancel).await.unwrap();
    let checkout = std::path::Path::new(&entry.path);
    let digest: String = sha2::Sha256::digest(checkout.to_string_lossy().as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    let directory = data.path().join("host").join("editor-recovery").join(digest);
    let retain = || async {
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("retained-record"), "do not delete").unwrap();
        Ok(())
    };
    worktrees.with_recovery_store(checkout, &directory, RecoveryAction::Inspect, retain, &cancel).await.unwrap();
    // A descriptor outside the scope rules is refused, not recorded.
    let stray = worktrees.with_recovery_store(checkout, data.path(), RecoveryAction::Inspect, || async { Ok(()) }, &cancel).await.unwrap_err();
    assert_eq!(stray.code(), Some(crate::worktree::errors::WORKTREE_FILE_RECOVERY));
    // The restart pass finds no stored session for it, but the retained record stops the removal.
    let sessions: std::sync::Arc<dyn SessionSource> = std::sync::Arc::new(Sessions { stored: Default::default(), jobs: Vec::new() });
    let options = CleanupOptions { settings: Some(crate::worktree::settings::WorktreeSettings::default()), ..CleanupOptions::default() };
    let report = worktrees.reconcile_at_startup(&sessions, &options, &cancel).await.unwrap();
    assert!(report["errors"].as_array().unwrap().iter().any(|e| e["id"] == entry.id.as_str() && e["error"].as_str().unwrap().contains("Retained file recovery")), "{report}");
    assert!(checkout.exists());
    let forced = worktrees.remove(&entry.id, true, Some("s1"), &cancel).await.unwrap_err();
    assert_eq!(forced.code(), Some(crate::worktree::errors::WORKTREE_FILE_RECOVERY));
    // Once the host discarded its record the worktree is removable; the store itself stays.
    worktrees.with_recovery_store(checkout, &directory, RecoveryAction::Discard, || async { Ok(std::fs::remove_file(directory.join("retained-record")).unwrap()) }, &cancel).await.unwrap();
    assert_eq!(worktrees.remove(&entry.id, true, Some("s1"), &cancel).await.unwrap()["removed"], true);
    assert!(directory.exists());
    // A checkout that is gone leaves its reserved namespace unusable for ordinary projects.
    let gone = worktrees.with_recovery_store(checkout, &directory, RecoveryAction::Write, || async { Ok(()) }, &cancel).await.unwrap_err();
    assert_eq!(gone.code(), Some(crate::worktree::errors::WORKTREE_MISSING));
    // An ordinary project outside the store just runs.
    worktrees.with_recovery_store(data.path(), &directory, RecoveryAction::Write, || async { Ok(()) }, &cancel).await.unwrap();
}

fn link_dir(target: &std::path::Path, link: &std::path::Path) {
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_dir(target, link).is_ok()
        || std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(link).arg(target).output().is_ok_and(|o| o.status.success());
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(target, link).is_ok();
    assert!(made, "cannot link {link:?}");
}

#[tokio::test]
async fn a_recorded_link_in_a_snapshot_or_disposable_worktree_is_unlinked_and_its_target_survives() {
    let (_guard, data, worktrees, made, cancel) = two_worktrees().await;
    let shared = data.path().join("main-node_modules");
    std::fs::create_dir_all(&shared).unwrap();
    std::fs::write(shared.join("pkg.txt"), "kept\n").unwrap();
    // A disposable worktree with a linked shared folder Mixdog listed on its record.
    let disposable = &made[0];
    worktrees.mark_disposable(&disposable.id, true, &cancel).await.unwrap();
    link_dir(&shared, &std::path::Path::new(&disposable.path).join("node_modules"));
    worktrees.record_link(&disposable.id, "node_modules", &shared, "created", &cancel).await.unwrap();
    // A snapshot likewise.
    let snapshot = worktrees.create_worker_snapshot("worker-9", std::path::Path::new(&made[1].project_path), "HEAD", "tx-9", false, &cancel).await.unwrap();
    let snapshot_path = std::path::PathBuf::from(snapshot["path"].as_str().unwrap());
    link_dir(&shared, &snapshot_path.join("node_modules"));
    worktrees.record_link(snapshot["id"].as_str().unwrap(), "node_modules", &shared, "created", &cancel).await.unwrap();
    // A link outside the checkout cannot be recorded.
    assert_eq!(
        worktrees.record_link(&disposable.id, "../escape", &shared, "created", &cancel).await.unwrap_err().code(),
        Some(crate::worktree::errors::WORKTREE_PATH_UNSAFE)
    );

    let removed = worktrees.remove(&disposable.id, true, Some("s1"), &cancel).await.unwrap();
    assert_eq!(removed["removed"], true, "{removed}");
    assert!(!std::path::Path::new(&disposable.path).exists());
    let removed = worktrees.remove_snapshot(snapshot["id"].as_str().unwrap(), true, &cancel).await.unwrap();
    assert_eq!(removed["removed"], true, "{removed}");
    assert!(!snapshot_path.exists());
    assert_eq!(std::fs::read_to_string(shared.join("pkg.txt")).unwrap(), "kept\n", "the target is never touched");
}

#[tokio::test]
async fn an_unrecorded_link_still_refuses_the_removal_and_nothing_is_deleted() {
    let (_guard, data, worktrees, made, cancel) = two_worktrees().await;
    let shared = data.path().join("elsewhere");
    std::fs::create_dir_all(&shared).unwrap();
    std::fs::write(shared.join("pkg.txt"), "kept\n").unwrap();
    let entry = &made[0];
    link_dir(&shared, &std::path::Path::new(&entry.path).join("deps"));
    let refused = worktrees.remove(&entry.id, true, Some("s1"), &cancel).await;
    let remaining = match refused {
        Ok(result) => result["remaining"].to_string(),
        Err(failure) => failure.to_string(),
    };
    assert!(remaining.contains("linked folders it did not create") || remaining.contains("unrecorded-links") || remaining.contains("deps"), "{remaining}");
    assert!(std::path::Path::new(&entry.path).join("deps").exists());
    assert_eq!(std::fs::read_to_string(shared.join("pkg.txt")).unwrap(), "kept\n");
}

#[tokio::test]
async fn a_deleted_session_loses_its_snapshots_even_with_no_owned_worktree_and_neighbours_keep_theirs() {
    let (_guard, _data, worktrees, made, cancel) = two_worktrees().await;
    let project = std::path::Path::new(&made[0].project_path);
    let mine = worktrees.create_worker_snapshot("gone", project, "HEAD", "tx-a", false, &cancel).await.unwrap();
    let theirs = worktrees.create_worker_snapshot("neighbour", project, "HEAD", "tx-b", false, &cancel).await.unwrap();
    let (mine, theirs) = (std::path::PathBuf::from(mine["path"].as_str().unwrap()), std::path::PathBuf::from(theirs["path"].as_str().unwrap()));
    // No owned worktree: nothing to report, but the snapshot goes.
    assert!(worktrees.cleanup_deleted_session_worktree("gone", &cancel).await.unwrap().is_none());
    assert!(!mine.exists());
    assert!(theirs.exists());
}

#[tokio::test]
async fn snapshots_go_before_the_owned_worktree_is_judged_and_a_kept_one_does_not_hold_them() {
    let (_guard, _data, worktrees, made, cancel) = two_worktrees().await;
    let project = std::path::Path::new(&made[1].project_path);
    let snapshot = worktrees.create_worker_snapshot("s2", project, "HEAD", "tx-c", false, &cancel).await.unwrap();
    let snapshot = std::path::PathBuf::from(snapshot["path"].as_str().unwrap());
    std::fs::write(std::path::Path::new(&made[1].path).join("dirty.txt"), "d\n").unwrap();
    let kept = worktrees.cleanup_deleted_session_worktree("s2", &cancel).await.unwrap().unwrap();
    assert_ne!(kept["removed"], true, "{kept}");
    assert!(std::path::Path::new(&made[1].path).exists(), "dirty work is kept");
    assert!(!snapshot.exists(), "its snapshot is removed whatever the owned worktree does");
}

#[tokio::test]
async fn a_deleted_sessions_shared_references_are_forgotten_and_the_owners_are_not() {
    use crate::worktree::ownership::Owner;
    let (_guard, _data, worktrees, made, cancel) = two_worktrees().await;
    let id = &made[0].id;
    let guest = Owner { session_id: "guest".into(), runtime_token: "rt".into(), pid: None };
    worktrees.claim_owner(id, guest, &cancel).await.unwrap();
    let before = worktrees.all_records(&cancel).await.unwrap().into_iter().find(|r| r.id == *id).unwrap();
    assert_eq!(before.shared_session_ids, ["guest"]);
    assert!(before.extra["sharedLeases"].get("guest").is_some());
    // The guest owns no worktree of its own.
    assert!(worktrees.cleanup_deleted_session_worktree("guest", &cancel).await.unwrap().is_none());
    let after = worktrees.all_records(&cancel).await.unwrap().into_iter().find(|r| r.id == *id).unwrap();
    assert!(after.shared_session_ids.is_empty());
    assert!(after.extra["sharedLeases"].get("guest").is_none());
    assert_eq!(after.owner_session_id.as_deref(), Some("s1"));
    assert!(std::path::Path::new(&made[0].path).exists());
}

#[tokio::test]
async fn a_deleted_sessions_worktree_is_removed_when_clean_and_kept_when_not() {
    let (_guard, _data, worktrees, made, cancel) = two_worktrees().await;
    std::fs::write(std::path::Path::new(&made[1].path).join("dirty.txt"), "d\n").unwrap();
    let kept = worktrees.cleanup_deleted_session_worktree("s2", &cancel).await.unwrap().unwrap();
    assert_ne!(kept["removed"], true, "{kept}");
    assert!(std::path::Path::new(&made[1].path).exists());
    let gone = worktrees.cleanup_deleted_session_worktree("s1", &cancel).await.unwrap().unwrap();
    assert_eq!(gone["removed"], true, "{gone}");
    assert!(!std::path::Path::new(&made[0].path).exists());
    assert!(worktrees.cleanup_deleted_session_worktree("nobody", &cancel).await.unwrap().is_none());
}

#[tokio::test]
async fn the_list_carries_sizes_until_the_worktree_is_removed_and_measured_again_when_recreated() {
    let (_guard, _data, worktrees, made, cancel) = two_worktrees().await;
    let rows = worktrees.list_with_sizes(None, &NoRetention, &cancel).await.unwrap();
    assert!(rows.iter().all(|row| row["sizeBytes"].as_u64().is_some_and(|n| n > 0) && row["sizeComplete"] == true), "{rows:?}");
    worktrees.remove(&made[0].id, false, Some("s1"), &cancel).await.unwrap();
    let rows = worktrees.list_with_sizes(None, &NoRetention, &cancel).await.unwrap();
    assert_eq!(rows.len(), 1);
}

#[tokio::test]
async fn an_automatic_removal_that_finds_the_checkout_changed_keeps_it() {
    use crate::worktree::removal::Auto;
    use crate::worktree::removal::AutoOptions;
    let (_guard, _data, worktrees, made, cancel) = two_worktrees().await;
    let mut record = worktrees.record(&cancel, &made[0].id).await.unwrap().unwrap();
    std::fs::write(std::path::Path::new(&record.path).join("late.txt"), "x\n").unwrap();
    match worktrees.remove_automatically(&mut record, &AutoOptions::default(), &cancel).await.unwrap() {
        Auto::Kept(verdict) => assert_eq!(verdict["reason"], "dirty"),
        Auto::Removed(_) => panic!("dirty work was removed"),
    }
    assert!(std::path::Path::new(&record.path).exists());
}

#[tokio::test]
async fn an_automatic_removal_whose_final_check_runs_out_of_time_is_kept_busy() {
    use crate::worktree::removal::Auto;
    use crate::worktree::removal::AutoOptions;
    let (_guard, _data, worktrees, made, cancel) = two_worktrees().await;
    let mut record = worktrees.record(&cancel, &made[0].id).await.unwrap().unwrap();
    // A zero bound is spent before `git status` can answer: never read as clean.
    let options = AutoOptions { final_check_timeout: std::time::Duration::ZERO, ..AutoOptions::default() };
    match worktrees.remove_automatically(&mut record, &options, &cancel).await.unwrap() {
        Auto::Kept(verdict) => assert_eq!(verdict["reason"], "busy"),
        Auto::Removed(_) => panic!("a check that timed out was read as clean"),
    }
    assert!(std::path::Path::new(&record.path).exists());
}

/// The sweep keeps and removes exactly what Node's `sweepScratchIndexes` did over the same
/// entries (`fixtures/commit-scratch/golden.json`, recorded from a real `gitCommitPaths`): a
/// dead owner's entry goes whatever its age, a live owner's stays whatever its age, a name
/// without an owner goes only after an hour, and nothing else in the folder is touched.
#[test]
fn the_sweep_removes_what_nodes_removed_and_nothing_else() {
    let golden: Value = serde_json::from_str(include_str!("../../../fixtures/commit-scratch/golden.json")).unwrap();
    let fill = |name: &str| name.replace("<dead>", &golden["dead"].to_string()).replace("<self>", &std::process::id().to_string());
    let root = tempfile::tempdir().unwrap();
    let now = std::time::SystemTime::now();
    let entries = golden["entries"].as_array().unwrap();
    for entry in entries {
        let path = root.path().join(fill(entry["name"].as_str().unwrap()));
        if entry["kind"] == "dir" {
            std::fs::create_dir(&path).unwrap();
            std::fs::write(path.join("commit.index"), b"x").unwrap();
        } else {
            std::fs::write(&path, b"x").unwrap();
            // Only files are aged: a folder's time cannot be set portably.
            let age = std::time::Duration::from_millis(entry["ageMs"].as_u64().unwrap());
            std::fs::File::options().write(true).open(&path).unwrap().set_modified(now - age).unwrap();
        }
    }
    let removed = entries.iter().filter(|entry| entry["kept"] == false).count();
    assert_eq!(crate::engine::sweep_dead_commit_scratch(root.path(), now), removed);
    for entry in entries {
        let name = fill(entry["name"].as_str().unwrap());
        assert_eq!(root.path().join(&name).exists(), entry["kept"] == true, "{name}");
    }
}

/// An aged-out directory without an owner is removed too (Node ages the entry whatever its kind);
/// a directory is not aged by this test, so the cutoff is moved instead.
#[test]
fn an_ownerless_directory_ages_out_after_an_hour() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("mixdog-commit-nobody-1");
    std::fs::create_dir(&path).unwrap();
    let now = std::time::SystemTime::now();
    assert_eq!(crate::engine::sweep_dead_commit_scratch(root.path(), now), 0);
    assert_eq!(crate::engine::sweep_dead_commit_scratch(root.path(), now + std::time::Duration::from_secs(2 * 60 * 60)), 1);
    assert!(!path.exists());
}

/// A commit sweeps before it builds its own scratch, in the OS temp folder.
#[tokio::test]
async fn a_commit_sweeps_the_temp_folder_it_builds_in() {
    let scm = Scm::new(TestProcesses::shared(), mixdog_rt::testing::tokens().maintenance_io, std::env::temp_dir().join(format!("mixdog-scm-review-{}", std::process::id())));
    assert_eq!(scm.commit_scratch_root(), std::env::temp_dir());
    let orphan = scm.commit_scratch_root().join(format!("mixdog-commit-2147483646-{}", std::process::id()));
    std::fs::create_dir(&orphan).unwrap();
    assert!(scm.sweep_commit_scratch(&CancellationToken::new()).await.unwrap() >= 1);
    assert!(!orphan.exists());
}
struct Recording {
    seen: std::sync::Mutex<Vec<crate::gh::commands::GhCommand>>,
}

#[async_trait::async_trait]
impl crate::gh::client::GhRunner for Recording {
    async fn raw(
        &self,
        command: &crate::gh::commands::GhCommand,
        _cwd: &std::path::Path,
        _cancel: &CancellationToken,
    ) -> Result<crate::gh::client::GhOutput, crate::error::ScmFailure> {
        self.seen.lock().unwrap().push(command.clone());
        let stdout = if command.args.first().map(String::as_str) == Some("repo") {
            r#"{"nameWithOwner":"owner/name"}"#.to_owned()
        } else if command.list {
            r#"[{"number":1,"state":"open","title":"fixture"}]"#.to_owned()
        } else {
            r#"{"number":1,"title":"fixture"}"#.to_owned()
        };
        Ok(crate::gh::client::GhOutput { code: Some(0), stdout, stderr: String::new() })
    }
}

#[tokio::test]
async fn github_requests_spawn_the_commands_of_the_node_twin() {
    let corpus: Value = serde_json::from_str(include_str!("../../../fixtures/desktop/github/corpus.json")).unwrap();
    let sha = "a".repeat(40);
    let mut compared = 0;
    for entry in corpus["entries"].as_array().unwrap() {
        if entry["op"] != "createGithubService(gate=on)" || entry["result"].is_null() {
            continue;
        }
        let text = entry["args"][0].to_string();
        if text.contains("repo.clone") {
            continue; // needs a real destination folder
        }
        let input: Value = serde_json::from_str(&text.replace("<HEX>", &sha)).unwrap();
        let runner = std::sync::Arc::new(Recording { seen: Default::default() });
        let scm = Scm::with_gh(
            TestProcesses::shared(),
            mixdog_rt::testing::tokens().maintenance_io,
            std::env::temp_dir().join("mixdog-scm-gh"),
            runner.clone(),
            std::sync::Arc::new(|| "gh".to_owned()),
        );
        let response = scm
            .github
            .execute(&input, &std::env::current_dir().unwrap(), &CancellationToken::new())
            .await
            .unwrap();
        let expected = entry["result"]["response"].clone();
        assert_eq!(response, expected, "{input}");
        let want: Vec<Value> = entry["result"]["spawned"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| serde_json::from_str::<Value>(&s["command"].to_string().replace("<HEX>", &sha)).unwrap())
            .collect();
        let got: Vec<Value> = runner
            .seen
            .lock()
            .unwrap()
            .iter()
            .map(|c| {
                let mut v = serde_json::json!({"args": c.args, "input": c.input, "json": c.json, "list": c.list, "mutation": c.mutation});
                if let Some(h) = &c.hostname {
                    v["hostname"] = serde_json::json!(h);
                }
                v
            })
            .collect();
        assert_eq!(got, want, "{input}");
        compared += 1;
    }
    assert!(compared >= 6, "{compared}");
}

#[tokio::test]
async fn a_status_read_does_not_wait_on_the_repository_write_lock() {
    let (_guard, repo, _head) = fixture_repo();
    let scm = scm();
    let cancel = CancellationToken::new();
    let open = scm.open(&repo, &cancel).await.unwrap();
    let held = open.lock_repository().await.unwrap();
    let read = tokio::time::timeout(std::time::Duration::from_secs(20), scm.git_status(&repo, &cancel)).await;
    assert!(read.expect("the read waited on the lock").is_ok());
    drop(held);
}

#[tokio::test]
async fn review_pages_come_from_the_cache_and_follow_the_work_tree() {
    use mixdog_core_api::domain::repo::Cached;
    use mixdog_core_api::domain::repo::RepoInspector;
    use mixdog_core_api::domain::repo::ReviewRequest;
    use mixdog_core_api::domain::repo::ReviewScope;
    let (_guard, repo, _head) = fixture_repo();
    let base = mixdog_core_api::domain::repo::ObjectId(git(&repo, &["rev-parse", "HEAD"]));
    let scm = scm();
    let cancel = CancellationToken::new();
    let reference = scm.open(&repo, &cancel).await.unwrap().repo_ref().unwrap();
    let request = ReviewRequest {
        repo: reference.clone(),
        scope: ReviewScope::Session { thread_id: mixdog_protocol::ThreadId::from("t") },
        base,
    };
    let summary = scm.inspector.review_summary(scm.lane, request.clone()).await.unwrap();
    let paths: Vec<_> = summary.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, ["a.txt", "new.txt", "src/b.mjs"]);
    match scm.inspector.review_page(&summary.key, Some("a.txt"), None).unwrap() {
        Cached::Ready(page) => assert!(page.patch.contains("+five"), "{}", page.patch),
        other => panic!("{other:?}"),
    }
    // A second summary of the same key is the cached one.
    let before = scm.inspector.flights_started();
    scm.inspector.review_summary(scm.lane, request).await.unwrap();
    assert_eq!(scm.inspector.flights_started(), before);
    // A key nobody computed is pending, never a wait.
    let mut other = summary.key.clone();
    other.worktree_token.push('x');
    assert!(matches!(scm.inspector.review_page(&other, None, None).unwrap(), Cached::Pending { .. }));
}
/// G10 / DS-SCM-4: a replayed day of turns, edits and window focus changes. The client model
/// reads a review page only when a published review key differs from the last one it saw, so
/// the reads it makes can never exceed the updates it received; the server side must not
/// inspect the repository for anything that changed nothing (focus, idle, a turn ending, a
/// publish after an unchanged tree).
#[tokio::test]
async fn g10_a_replayed_day_has_no_periodic_review_reads_and_inspects_only_on_change() {
    use mixdog_core_api::domain::repo::Cached;
    use mixdog_core_api::domain::repo::RepoEvidence;
    use mixdog_core_api::domain::repo::RepoInspector;
    use mixdog_core_api::domain::repo::ReviewRequest;
    use mixdog_core_api::domain::repo::ReviewScope;
    #[derive(Clone, Copy)]
    enum Event {
        Edit(usize),
        Focus,
        TurnEnd,
        Idle,
    }
    let (_guard, repo, _head) = fixture_repo();
    let base = mixdog_core_api::domain::repo::ObjectId(git(&repo, &["rev-parse", "HEAD"]));
    let scm = scm();
    let cancel = CancellationToken::new();
    let reference = scm.open(&repo, &cancel).await.unwrap().repo_ref().unwrap();
    let request = ReviewRequest { repo: reference.clone(), scope: ReviewScope::Session { thread_id: mixdog_protocol::ThreadId::from("day") }, base };

    // A deterministic day: 24 edits, each followed by many events that change nothing.
    let mut trace = Vec::new();
    for edit in 0..24 {
        trace.push(Event::Edit(edit));
        for step in 0..40 {
            trace.push(match step % 4 { 0 => Event::Focus, 1 => Event::Idle, 2 => Event::TurnEnd, _ => Event::Focus });
        }
    }
    let edits = trace.iter().filter(|e| matches!(e, Event::Edit(_))).count() as u64;

    let (mut updates, mut reads) = (0u64, 0u64);
    let mut flights_before_noop;
    let first = scm.inspector.review_summary(scm.lane, request.clone()).await.unwrap();
    let mut last_key = Some(first.key.clone());
    for event in &trace {
        flights_before_noop = scm.inspector.flights_started();
        match event {
            Event::Edit(n) => {
                std::fs::write(repo.join("a.txt"), format!("edit {n}\n")).unwrap();
                scm.inspector.evidence(&reference, RepoEvidence::WorkTree);
            }
            // Nothing changed: the publish after the event is served from the cache.
            Event::Focus | Event::Idle | Event::TurnEnd => {}
        }
        let summary = scm.inspector.review_summary(scm.lane, request.clone()).await.unwrap();
        if !matches!(event, Event::Edit(_)) {
            assert_eq!(scm.inspector.flights_started(), flights_before_noop, "an event that changed nothing inspected the repository");
        }
        if last_key.as_ref() != Some(&summary.key) {
            updates += 1;
            last_key = Some(summary.key.clone());
            // The client's one read for this update is a cache hit.
            match scm.inspector.review_page(&summary.key, Some("a.txt"), None).unwrap() {
                Cached::Ready(_) => reads += 1,
                other => panic!("{other:?}"),
            }
        }
    }
    assert_eq!(updates, edits, "every edit published exactly one new review key");
    assert!(reads <= updates, "reads {reads} exceed updates {updates}");
    assert!(scm.inspector.flights_started() <= edits + 1, "{} inspections for {edits} edits", scm.inspector.flights_started());
}

#[tokio::test]
async fn a_worker_snapshot_is_held_by_a_lease_and_removed_when_its_turn_settles() {
    use crate::worktree::manager::Worktrees;
    let (_guard, repo, _head) = fixture_repo();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "clean"]);
    let data = tempfile::tempdir().unwrap();
    let worktrees = Worktrees::new(scm(), data.path().to_path_buf());
    let cancel = CancellationToken::new();
    let entry = worktrees.create_worker_snapshot("worker-1", &repo, "HEAD", "tx-1", false, &cancel).await.unwrap();
    let path = std::path::PathBuf::from(entry["path"].as_str().unwrap());
    assert!(path.join("a.txt").exists());
    let ledger = worktrees.ledger();
    assert_eq!(ledger.containing(&path.join("src")).unwrap().0, entry["id"]);
    let lease = ledger.admit(&path).unwrap();
    let kept = worktrees.release_worker_snapshots("worker-1", Some(1), &cancel).await.unwrap();
    assert_eq!(kept["removed"], serde_json::json!([]));
    assert_eq!(kept["kept"][0]["reason"], "in-use");
    drop(lease);
    assert!(path.exists());
    // The turn was consumed by the release; the prune takes what is left.
    let rows = worktrees.list(None, &NoRetention, &cancel).await.unwrap();
    assert_eq!(rows.len(), 1);
    worktrees.remove_snapshot(entry["id"].as_str().unwrap(), true, &cancel).await.unwrap();
    assert!(!path.exists());
}

/// A probe that never ran is an error; it is not the answer "not a repository".
#[tokio::test(flavor = "current_thread")]
async fn is_repository_reports_a_probe_that_never_ran() {
    let folder = std::env::temp_dir().join(format!("mixdog-scm-no-repo-{}", std::process::id()));
    std::fs::create_dir_all(&folder).unwrap();
    let (scm, cancel) = (scm(), CancellationToken::new());
    assert!(!scm.is_repository(&folder, &cancel).await.unwrap());
    let _refused = mixdog_rt::testing::refuse_jobs_on_this_thread();
    assert!(scm.is_repository(&folder, &cancel).await.is_err());
}


#[tokio::test]
async fn a_failed_creation_is_rolled_back_whole_and_its_own_failure_is_the_one_surfaced() {
    use crate::worktree::manager::CreateRequest;
    use crate::worktree::manager::Worktrees;
    let (_guard, repo, _head) = fixture_repo();
    let data = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let worktrees = Worktrees::new(scm(), data.path().to_path_buf());
    // The owner-lease directory is a file: the creation fails after the checkout, its lock and
    // (no carry) before anything else, so the rollback has a checkout, a lock and a branch to undo.
    let facts = worktrees.inspect_repo(&repo, &cancel).await.unwrap();
    let root = crate::worktree::names::managed_root(data.path(), &facts.common_dir);
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join(".owners"), "in the way").unwrap();
    let request = CreateRequest { project_path: repo.clone(), session_id: "s1".into(), runtime_token: "rt".into(), tx_id: "t1".into(), name_hint: "doomed".into(), ..CreateRequest::default() };
    let failure = worktrees.create_full(request, &cancel).await.unwrap_err();
    assert!(!failure.to_string().is_empty());
    assert_eq!(git(&repo, &["branch", "--list", "mixdog/*"]), "", "the branch the creation made went with it");
    assert_eq!(git(&repo, &["worktree", "list", "--porcelain"]).matches("worktree ").count(), 1, "only the main checkout is left");
    assert!(!root.join("doomed").exists());
    assert!(worktrees.list(None, &NoRetention, &cancel).await.unwrap().is_empty(), "the record is gone");
}


/// Another process taking the worktree folder after the name was reserved and before git's checkout
/// add (the first `n` adds find it taken), over the real process manager.
struct TakesTheFolder {
    inner: std::sync::Arc<dyn mixdog_core_api::domain::process::ProcessManager>,
    left: std::sync::atomic::AtomicUsize,
}

#[async_trait::async_trait]
impl mixdog_core_api::domain::process::ProcessManager for TakesTheFolder {
    async fn spawn(&self, request: mixdog_core_api::domain::process::SpawnRequest) -> Result<mixdog_core_api::domain::process::SpawnedProcess, mixdog_core_api::domain::process::ProcessError> {
        use std::sync::atomic::Ordering::SeqCst;
        if let mixdog_core_api::domain::process::CommandSpec::Argv { args, .. } = &request.command
            && let Some(add) = args.windows(2).position(|pair| pair[0] == "worktree" && pair[1] == "add")
            && self.left.try_update(SeqCst, SeqCst, |n| n.checked_sub(1)).is_ok()
        {
            let rest = &args[add + 2..];
            let target = if rest.first().map(String::as_str) == Some("-b") { &rest[2] } else { &rest[0] };
            std::fs::create_dir_all(target).unwrap();
            std::fs::write(Path::new(target).join("taken-by-another-process.txt"), "x").unwrap();
        }
        self.inner.spawn(request).await
    }
    fn subscribe(
        &self,
        handle: &mixdog_protocol::ProcessHandle,
        from_seq: Option<u64>,
    ) -> Result<Box<dyn mixdog_core_api::domain::common::EventSource<mixdog_core_api::domain::process::ProcessEvent>>, mixdog_core_api::domain::process::ProcessError> {
        self.inner.subscribe(handle, from_seq)
    }
    async fn write_stdin(&self, handle: &mixdog_protocol::ProcessHandle, bytes: Vec<u8>) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
        self.inner.write_stdin(handle, bytes).await
    }
    fn close_stdin(&self, handle: &mixdog_protocol::ProcessHandle) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
        self.inner.close_stdin(handle)
    }
    fn resize_pty(&self, handle: &mixdog_protocol::ProcessHandle, size: mixdog_core_api::domain::process::PtySize) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
        self.inner.resize_pty(handle, size)
    }
    fn kill(&self, handle: &mixdog_protocol::ProcessHandle) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
        self.inner.kill(handle)
    }
    fn list(&self) -> Vec<mixdog_core_api::domain::process::ProcessInfo> {
        self.inner.list()
    }
}

struct MixdogPrefix;
#[async_trait::async_trait]
impl crate::worktree::settings::SettingsSource for MixdogPrefix {
    async fn worktree_settings(&self) -> crate::worktree::settings::WorktreeSettings {
        crate::worktree::settings::WorktreeSettings { branch_prefix: "mixdog/".into(), ..Default::default() }
    }
}

/// What Node's `createManagedWorktree` leaves behind when the folder was taken after the name was
/// reserved (`record-worktree-add-retry.mjs`: the real manager over a real repository).
async fn taken_folder_outcome(clashes: usize, branch: Option<&str>) -> Value {
    use crate::worktree::manager::CreateRequest;
    use crate::worktree::manager::Worktrees;
    let (_guard, repo, _head) = fixture_repo();
    // Node's recorder repository has only `main`; this fixture also carries a `feature` branch, which
    // makes `feature/login` an impossible ref (a branch is a file where a directory is needed), so git
    // would refuse before making it and the golden's leftover branch could never appear.
    git(&repo, &["branch", "-D", "feature"]);
    let data = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let processes = std::sync::Arc::new(TakesTheFolder { inner: TestProcesses::shared(), left: clashes.into() });
    let scm = Scm::new(processes, mixdog_rt::testing::tokens().maintenance_io, std::env::temp_dir().join(format!("mixdog-scm-test-{}", std::process::id())));
    let worktrees = Worktrees::new(scm, data.path().to_path_buf()).with_settings(std::sync::Arc::new(MixdogPrefix));
    let request = CreateRequest {
        project_path: repo.clone(),
        session_id: "s1".into(),
        runtime_token: "rt".into(),
        tx_id: "t1".into(),
        name_hint: "Fix the login page".into(),
        branch: branch.map(str::to_owned),
        ..CreateRequest::default()
    };
    let outcome = match worktrees.create_full(request, &cancel).await {
        Ok(created) => serde_json::json!({ "created": true, "id": created.record.id, "branch": created.record.branch, "state": created.record.state }),
        Err(failure) => {
            let text = failure.to_string().to_lowercase();
            serde_json::json!({ "created": false, "alreadyExists": text.contains("already exists") || text.contains("exists; cannot create") })
        }
    };
    let heads = |prefix: &str| git(&repo, &["for-each-ref", "--format=%(refname:short)", prefix]).lines().filter(|l| !l.is_empty()).map(str::to_owned).collect::<Vec<_>>();
    let mut branches = heads("refs/heads/mixdog/");
    branches.extend(heads("refs/heads/feature/"));
    branches.sort();
    let mut ids: Vec<String> = worktrees.list(None, &NoRetention, &cancel).await.unwrap().iter().map(|row| row["id"].as_str().unwrap().to_owned()).collect();
    ids.sort();
    serde_json::json!({
        "outcome": outcome,
        "branches": branches,
        "registryIds": ids,
        "worktrees": git(&repo, &["worktree", "list", "--porcelain"]).lines().filter(|line| line.starts_with("worktree ")).count(),
    })
}

fn add_retry_golden() -> Value {
    serde_json::from_str(include_str!("../../../fixtures/worktree-add-retry/golden.json")).unwrap()
}

#[tokio::test]
async fn a_taken_folder_reserves_the_next_free_name_once_as_nodes_creation_does() {
    assert_eq!(taken_folder_outcome(1, None).await, add_retry_golden()["retry"]);
}

#[tokio::test]
async fn a_second_taken_folder_fails_the_creation_and_rolls_the_second_name_back() {
    assert_eq!(taken_folder_outcome(2, None).await, add_retry_golden()["twice"]);
}

#[tokio::test]
async fn a_branch_asked_for_by_name_is_not_retried() {
    assert_eq!(taken_folder_outcome(1, Some("feature/login")).await, add_retry_golden()["exactBranch"]);
}

/// Node's `inspectRepo` refusal (`record-worktree-inspect-repo.mjs`) as the window gets it: code, text and details, the
/// folder's path written `<folder>`.
async fn inspect_refusal(folder: &Path) -> Value {
    use crate::worktree::manager::Worktrees;
    let data = tempfile::tempdir().unwrap();
    let worktrees = Worktrees::new(scm(), data.path().to_path_buf());
    let failure = worktrees.inspect_repo(folder, &CancellationToken::new()).await.unwrap_err();
    let mixdog_core_api::CoreError::DomainError { code, message, detail, .. } = mixdog_core_api::CoreError::from(failure) else { panic!("not a domain error") };
    let mut details = serde_json::to_value(detail).unwrap();
    if let Some(fields) = details.as_object_mut() {
        fields.shift_remove("type");
        fields.retain(|_, value| !value.is_null());
        if fields.get("projectPath").and_then(Value::as_str) == Some(folder.to_string_lossy().as_ref()) {
            fields.insert("projectPath".into(), "<folder>".into());
        }
    }
    serde_json::json!({ "code": code, "message": message, "details": details })
}

#[tokio::test]
async fn inspect_repo_refuses_with_the_code_text_and_details_node_does() {
    let golden: Value = serde_json::from_str(include_str!("../../../fixtures/worktree-inspect-repo/golden.json")).unwrap();
    let root = tempfile::tempdir().unwrap();
    let plain = root.path().join("plain");
    let bare = root.path().join("bare");
    let empty = root.path().join("empty");
    for folder in [&plain, &bare, &empty] {
        std::fs::create_dir_all(folder).unwrap();
    }
    git(&bare, &["init", "-q", "--bare"]);
    git(&empty, &["init", "-q", "-b", "main"]);
    assert_eq!(inspect_refusal(&root.path().join("gone")).await, golden["missing"]);
    assert_eq!(inspect_refusal(&plain).await, golden["plain"]);
    assert_eq!(inspect_refusal(&bare).await, golden["bare"]);
    assert_eq!(inspect_refusal(&empty).await, golden["noCommit"]);
}

#[tokio::test]
async fn a_repository_review_names_the_default_branch_it_diffs_against() {
    let (_guard, repo, _head) = fixture_repo();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "clean"]);
    let scm = scm();
    let (name, point) = crate::inspect::review::repo_base(&scm.git, &CancellationToken::new(), &repo, "branch").await.unwrap();
    assert_eq!(name, "main");
    assert_eq!(point.0, git(&repo, &["rev-parse", "HEAD"]));
    let (uncommitted, _) = crate::inspect::review::repo_base(&scm.git, &CancellationToken::new(), &repo, "uncommitted").await.unwrap();
    assert_eq!(uncommitted, "HEAD");
}
#[tokio::test]
async fn a_status_that_skips_line_stats_has_no_counts_and_leaves_the_counted_scan_alone() {
    let (_guard, repo, _head) = fixture_repo();
    let scm = scm();
    let cancel = CancellationToken::new();
    let skipped = scm.git_status_counting(&repo, &cancel, false, false).await.unwrap();
    let files = skipped["files"].as_array().unwrap();
    assert!(!files.is_empty());
    assert!(files.iter().all(|file| file["additions"] == 0 && file["deletions"] == 0));
    let counted = scm.git_status_counting(&repo, &cancel, true, false).await.unwrap();
    assert!(counted["files"].as_array().unwrap().iter().any(|file| file["additions"].as_u64().unwrap_or(0) > 0));
}
#[test]
fn a_review_revision_names_the_file_identity_or_deleted() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.txt"), "abc").unwrap();
    let revision = crate::inspect::status::worktree_revision(dir.path(), "a.txt");
    assert!(revision.starts_with("3:"), "size first: {revision}");
    assert_eq!(revision.split(':').count(), 4);
    assert_eq!(crate::inspect::status::worktree_revision(dir.path(), "gone.txt"), "deleted");
}
