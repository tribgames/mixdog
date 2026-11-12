//! `SessionWorkspaceHost::apply` over a real session directory: what a workspace move leaves of a session's prompt, case
//! by case as Node's `refreshSessionWorkspaceContext` left it (`fixtures/prompt-reroot`, recorded by
//! `record-prompt-reroot.mjs`). A session with a conversation keeps its prompt byte for byte and has the move staged;
//! one without is re-rooted in place. The conversation is the committed one: a settled turn leaves nothing live.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_agent::compact::estimate::MediaMeter;
use mixdog_agent::compact::estimate::MessageMeter;
use mixdog_agent::compact::estimate::PartMeter;
use mixdog_agent::message::AgentMessage;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_prompt::prompt::blocks::SystemBlocks;
use mixdog_core_prompt::prompt::blocks::request_system_messages;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_protocol::ProviderId;
use mixdog_scm::error::ScmFailure;
use mixdog_scm::engine::Scm;
use mixdog_scm::worktree::manager::Worktrees;
use mixdog_spawn::LocalProcessManager;
use mixdog_spawn::ProcessConfig;
use mixdog_store::schema::record::Header;
use serde_json::Value;
use serde_json::json;

use mixdog_core_session::session::worktree::worktree_host::JobCwd;
use mixdog_core_session::session::worktree::worktree_host::LeadActivity;
use mixdog_core_session::session::worktree::worktree_host::LiveSession;
use mixdog_core_session::session::worktree::worktree_host::Undo;
use mixdog_core_session::session::worktree::worktree_host::WorkspaceChange;
use mixdog_core_session::session::worktree::worktree_host::WorkspaceHost;
use mixdog_core_session::session::worktree::worktree_host_impl::HostRuntime;
use mixdog_core_session::session::worktree::worktree_host_impl::SessionWorkspaceHost;
use mixdog_core_session::session::worktree::worktree_host_impl::WorkspaceContext;
use mixdog_core_session::replay_access::PromptReroot;
use mixdog_core_session::replay_access::PromptView;
use mixdog_core_session::replay_access::presented_workspace;
use mixdog_core_session::session::worktree::worktree_setup::WorktreeSetup;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::testing::Rig;
use mixdog_core_session::session::thread_state::SessionThreads;

const GOLDEN: &str = include_str!("../../../../fixtures/prompt-reroot/golden.json");

/// The runtime around the session: the prompt re-root is the production one over the same directory, the slices of the new
/// workspace are the recording's, and the cwd it reads is the header's.
struct Runtime {
    directory: Arc<SessionDirectory>,
    reroot: PromptReroot,
    context: WorkspaceContext,
    set_cwd: Mutex<Vec<String>>,
}

#[async_trait]
impl HostRuntime for Runtime {
    async fn is_lead(&self, _: &str) -> bool {
        true
    }
    async fn attended(&self, _: &str) -> bool {
        true
    }
    fn runtime_cwd(&self, id: &str) -> String {
        let header = self.directory.handle(&ThreadId::from(id)).map(|handle| handle.header_snapshot());
        header.and_then(|header| header.get("cwd").and_then(Value::as_str).map(str::to_owned)).unwrap_or_default()
    }
    async fn set_runtime_cwd(&self, id: &str, cwd: &str) -> Result<(), ScmFailure> {
        self.set_cwd.lock().unwrap().push(format!("{id} {cwd}"));
        Ok(())
    }
    async fn presented_workspace(&self, id: &str) -> Value {
        let header = self.directory.handle(&ThreadId::from(id)).map(|handle| handle.header_snapshot()).expect("loaded");
        let blocks = SystemBlocks::from_header(&header);
        presented_workspace(&PromptView { header: &header, tier3: blocks.core.as_deref(), env: blocks.env.as_deref() })
    }
    async fn workspace_context(&self, _: &str, _: &str) -> Result<WorkspaceContext, ScmFailure> {
        Ok(self.context.clone())
    }
    async fn reroot_prompt(&self, id: &str, cwd: &str, context: &WorkspaceContext) -> Result<Undo, ScmFailure> {
        self.reroot.reroot(id, cwd, context).await
    }
    async fn activity(&self, _: &str) -> LeadActivity {
        LeadActivity::default()
    }
    fn live_sessions(&self) -> Vec<LiveSession> {
        Vec::new()
    }
    async fn stored_consumers(&self) -> Result<Vec<LiveSession>, ScmFailure> {
        Ok(Vec::new())
    }
    async fn running_jobs(&self) -> Vec<JobCwd> {
        Vec::new()
    }
    async fn shell_job_count(&self, _: &[String]) -> u64 {
        0
    }
    async fn copy_project_identity(&self, _: &str, _: &str) -> Result<bool, ScmFailure> {
        Ok(false)
    }
}

struct TextOnly;
impl MediaMeter for TextOnly {
    fn part(&self, part: &ContentPart) -> PartMeter {
        match part {
            ContentPart::Text(text, _) => PartMeter { text: text.clone(), tokens: 0 },
            other => panic!("media part in a text-only golden: {other:?}"),
        }
    }
}

/// The prompt blocks a move rewrites (the `tier3` and `env` system messages), priced as the context gauge prices them.
fn prompt_tokens(header: &Header) -> u64 {
    let blocks: Vec<AgentMessage> = request_system_messages(header)
        .into_iter()
        .filter(|wire| wire.cache_tier.is_some())
        .map(|wire| {
            let mut message = AgentMessage::user_content(Content::Text(String::new()));
            message.message = wire;
            message
        })
        .collect();
    MessageMeter { media: &TextOnly, replay_owner: &ProviderId::from("") }.messages(&blocks)
}

/// Node's prompt state as the header holds it: the `tier3` message under its block key (`bp3CoreContext` itself in the
/// split layout, `promptTier3` in the combined one) and the `env` message as `promptEnv`.
fn stored(state: &Value) -> Header {
    let mut header = state["header"].as_object().expect("header").clone();
    let split = header.get("bp3EnvSplit") == Some(&Value::Bool(true));
    if let Some(tier3) = state["tier3"].as_str() {
        if split {
            assert_eq!(header.get("bp3CoreContext").and_then(Value::as_str), Some(tier3), "the split tier3 message is bp3CoreContext");
        } else {
            header.insert("promptTier3".to_owned(), Value::String(tier3.to_owned()));
        }
    }
    if let Some(env) = state["env"].as_str() {
        header.insert("promptEnv".to_owned(), Value::String(env.to_owned()));
    }
    header
}

/// `refreshWorkspacePrompt`'s context: an absent slice is `undefined` (kept).
fn context_of(context: &Value) -> WorkspaceContext {
    let slice = |key: &str| context.get(key).and_then(Value::as_str).map(str::to_owned);
    WorkspaceContext {
        environment_context: slice("environmentContext"),
        core_memory_context: slice("coreMemoryContext"),
        instruction_files_context: slice("instructionFilesContext"),
    }
}

/// The header keys the prompt and the move live in.
const KEYS: [&str; 10] = [
    "owner",
    "model",
    "cwd",
    "bp3CoreContext",
    "bp3EnvironmentContext",
    "bp3EnvSplit",
    "sessionStartMetaInjected",
    "workspaceReroot",
    "promptTier3",
    "promptEnv",
];

struct Rigged {
    rig: Rig,
    _dir: tempfile::TempDir,
    directory: Arc<SessionDirectory>,
    host: SessionWorkspaceHost,
    runtime: Arc<Runtime>,
}

fn rigged(context: WorkspaceContext) -> Rigged {
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let threads: Arc<SessionThreads> = Arc::new(SessionThreads::new(directory.clone()));
    let dir = tempfile::tempdir().expect("a folder");
    let tokens = mixdog_rt::testing::tokens();
    let processes = Arc::new(LocalProcessManager::new(tokens.spawn_io, ProcessConfig::default()));
    let data = dir.path().join("data");
    let scm = Scm::new(processes.clone(), tokens.maintenance_io, data.join("scratch"));
    let setup = Arc::new(WorktreeSetup::new(Arc::new(Worktrees::new(scm, data)), processes));
    let runtime = Arc::new(Runtime { directory: directory.clone(), reroot: PromptReroot::new(directory.clone(), threads.clone()), context, set_cwd: Mutex::new(Vec::new()) });
    let host = SessionWorkspaceHost::new(directory.clone(), threads as Arc<dyn ThreadState>, runtime.clone(), setup);
    Rigged { rig, _dir: dir, directory, host, runtime }
}

/// A session at `C:/repo` holding `header`'s prompt and `conversation` as committed messages.
async fn session(rigged: &Rigged, id: &str, mut header: Header, conversation: &[Value]) {
    header.insert("cwd".into(), json!("C:/repo"));
    rigged.directory.create_with_id(ThreadId::from(id), header, json!({})).await.expect("create");
    if !conversation.is_empty() {
        let handle = rigged.directory.open_handle(&ThreadId::from(id), &CallContext::internal("test")).await.expect("open");
        let append = CoreRequest { method: Method("thread/inheritedRows/append"), params: json!({ "messages": conversation }), op: None, ctx: CallContext::internal("test") };
        handle.request(append).await.expect("append");
    }
}

fn header_of(rigged: &Rigged, id: &str) -> Header {
    rigged.directory.handle(&ThreadId::from(id)).expect("loaded").header_snapshot().as_ref().clone()
}

/// Every recorded move: a session with a conversation keeps its prompt (the blocks, their tokens) and has the move staged
/// as Node staged it; one without is re-rooted in place to the recorded prompt, with the recorded token count.
#[tokio::test(start_paused = true)]
async fn a_move_stages_or_rebuilds_a_prompt_exactly_as_node_left_it() {
    let golden: Value = serde_json::from_str(GOLDEN).expect("golden");
    let (mut staged, mut rebuilt) = (0, 0);
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let rigged = rigged(context_of(&case["context"]));
        let conversation = case["before"]["conversation"].as_array().expect("conversation").clone();
        session(&rigged, "sess_moved", stored(&case["before"]), &conversation).await;
        let cwd = case["context"]["cwd"].as_str().expect("cwd");
        let change = WorkspaceChange { cwd: cwd.to_owned(), workspace: Value::Null, moved: None, desktop_session: None };
        let _undo = rigged.host.apply("sess_moved", change).await.unwrap_or_else(|error| panic!("{name}: {error:?}"));
        assert_eq!(*rigged.runtime.set_cwd.lock().unwrap(), [format!("sess_moved {cwd}")], "{name}");
        let (got, want) = (header_of(&rigged, "sess_moved"), stored(&case["after"]));
        for key in KEYS {
            assert_eq!(got.get(key), want.get(key), "{name}: {key}");
        }
        assert_eq!(prompt_tokens(&got), case["after"]["promptTokens"], "{name}: the prompt's tokens");
        if conversation.is_empty() {
            rebuilt += 1;
        } else {
            staged += 1;
            assert_eq!(case["after"]["promptTokens"], case["before"]["promptTokens"], "{name}: Node left the prompt as it was");
            assert!(got.get("workspaceReroot").is_some_and(|staged| staged["version"] == 1), "{name}: staged");
        }
    }
    assert_eq!((staged, rebuilt), (4, 11));
}

/// A move whose conversation cannot be read fails with the read's failure and puts the runtime's cwd back
/// (`applyResolvedCwd` is undone when the prompt step throws).
#[tokio::test(start_paused = true)]
async fn a_move_whose_conversation_read_fails_puts_the_runtime_cwd_back() {
    let rigged = rigged(WorkspaceContext::default());
    session(&rigged, "sess_moved", json!({ "owner": "lead", "model": "gpt-5.4" }).as_object().cloned().expect("header"), &[]).await;
    rigged.rig.store.fail_context.store(true, std::sync::atomic::Ordering::SeqCst);
    let change = WorkspaceChange { cwd: "C:/wt".to_owned(), workspace: Value::Null, moved: None, desktop_session: None };
    assert!(rigged.host.apply("sess_moved", change).await.is_err());
    assert_eq!(*rigged.runtime.set_cwd.lock().unwrap(), ["sess_moved C:/wt", "sess_moved C:/repo"], "the move was undone");
    assert_eq!(header_of(&rigged, "sess_moved").get("cwd"), Some(&json!("C:/repo")), "nothing was stored");
}
