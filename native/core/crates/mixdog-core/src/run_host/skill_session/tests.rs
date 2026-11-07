//! The arm and the transcript against what Node answered (`fixtures/skill-session/golden.json`,
//! recorded by `record-skill-session.mjs`): a skill load leaves the session as
//! `loadSkillToolDependencies` leaves it, and the transcript answers whether a skill body is still
//! in the conversation as `skillBodyPresentInSession` does.

use std::sync::Mutex;

use mixdog_core_ports::ports::route::Route;
use mixdog_core_ports::ports::threads::Section;
use mixdog_core_session::session::NoRouteExclusions;
use mixdog_mcp::skill_deps::DependencySource;
use mixdog_mcp::skill_state::body_present;
use serde_json::json;

use super::*;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/skill-session/golden.json")).expect("fixture")
}

fn thread() -> ThreadId {
    ThreadId::from("t1")
}

fn object(value: &Value) -> Header {
    value.as_object().expect("object").clone()
}

/// The header of thread `t1`, patched as the session actor patches it: only while the keys the
/// patch was computed from still hold.
struct Store {
    header: Mutex<Header>,
    /// A header write by another party that lands before the next patch does.
    interloper: Mutex<Option<Map<String, Value>>>,
}

impl Store {
    fn of(header: &Value) -> Arc<Self> {
        Arc::new(Self { header: Mutex::new(object(header)), interloper: Mutex::new(None) })
    }

    fn snapshot(&self) -> Header {
        self.header.lock().expect("store").clone()
    }
}

#[async_trait]
impl ThreadState for Store {
    async fn header(&self, _: &ThreadId) -> Result<Header, PortError> {
        Ok(self.snapshot())
    }
    async fn patch_header(&self, _: &ThreadId, _: Map<String, Value>, _: Vec<String>) -> Result<(), PortError> {
        unreachable!("the arm patches conditionally")
    }
    async fn patch_header_if(&self, _: &ThreadId, expect: Map<String, Value>, set: Map<String, Value>, _: Vec<String>) -> Result<Option<Map<String, Value>>, PortError> {
        let mut header = self.header.lock().expect("store");
        if let Some(write) = self.interloper.lock().expect("interloper").take() {
            header.extend(write);
        }
        let current: Map<String, Value> = expect.keys().map(|key| (key.clone(), header.get(key).cloned().unwrap_or(Value::Null))).collect();
        if current != expect {
            return Ok(Some(current));
        }
        header.extend(set);
        Ok(None)
    }
    async fn publish(&self, _: &ThreadId, _: Section) -> Result<(), PortError> {
        unreachable!("the arm publishes nothing")
    }
}

#[derive(Default)]
struct Switches {
    connector: Vec<String>,
    project: Vec<String>,
}

#[async_trait]
impl ConnectorPermissions for Switches {
    fn needs_approval(&self, _: &str, _: &str) -> bool {
        false
    }
    fn disabled(&self, _: &str, tool: &str) -> bool {
        self.connector.iter().any(|name| name == tool)
    }
    fn project_disabled(&self, _: &ThreadId, tool: &str) -> bool {
        self.project.iter().any(|name| name == tool)
    }
    async fn allow_always(&self, _: &str, _: &str) -> bool {
        false
    }
}

struct Host;

impl SurfaceHost for Host {
    fn bridge_tools(&self) -> Vec<Value> {
        Vec::new()
    }
    fn mcp_server_instructions(&self, _: Option<&str>) -> Value {
        Value::Null
    }
}

struct Now;

impl Clock for Now {
    fn now_ms(&self) -> i64 {
        0
    }
}

fn arm_of(store: &Arc<Store>, switches: Switches) -> HeaderSkillArm {
    HeaderSkillArm::new(store.clone(), Arc::new(NoRouteExclusions), Arc::new(switches), Arc::new(Host), Arc::new(Now))
}

fn dependencies(tools: &Value, issues: &Value) -> SkillToolDependencies {
    SkillToolDependencies {
        tool_dependencies: tools.as_array().expect("dependencies").clone(),
        declared: Vec::new(),
        source: DependencySource::Declaration,
        issues: issues.as_array().expect("issues").iter().map(|issue| issue.as_str().expect("issue").to_owned()).collect(),
    }
}

/// Every golden case: the session after the skill loaded (once, or again for a repeat) is the one
/// Node ended with, key for key.
#[tokio::test]
async fn a_skill_load_leaves_the_session_as_node_does() {
    let golden = golden();
    let cases = golden["arm"].as_array().expect("arm cases");
    assert_eq!(cases.len(), 27);
    for case in cases {
        let store = Store::of(&case["before"]);
        let arm = arm_of(&store, Switches::default());
        let skill = dependencies(&case["dependencies"], &case["issues"]);
        for _ in 0..case["loads"].as_u64().expect("loads") {
            arm.arm(&thread(), &skill).await;
        }
        assert_eq!(Value::Object(store.snapshot()), case["after"], "{}", case["name"]);
    }
}

/// `preDispatchDenyForSession` reads the agent's connector policy and the project's switches per
/// tool (`agentMcpToolPermission`, `projectMcpToolDisabled`): a tool either turns off is not armed,
/// the others are.
#[tokio::test]
async fn a_tool_the_connector_or_project_switched_off_is_not_armed() {
    let golden = golden();
    let case = &golden["arm"][0];
    assert_eq!(case["name"], "native openai: an eager and a deferred dependency");
    let skill = dependencies(&json!([{"type": "tool", "value": "read"}, {"type": "tool", "value": "office"}]), &json!([]));
    for switches in [Switches { connector: vec!["office".into()], ..Switches::default() }, Switches { project: vec!["office".into()], ..Switches::default() }] {
        let store = Store::of(&case["before"]);
        arm_of(&store, switches).arm(&thread(), &skill).await;
        let header = store.snapshot();
        assert_eq!(header["skillLoadedTools"], json!(["read"]));
        assert!(!header["deferredCallableTools"].as_array().expect("callable").contains(&json!("office")));
    }
}

/// A header another write moved between the read and the patch is read again, and the load is
/// computed from what it holds then.
#[tokio::test]
async fn a_header_that_moved_is_read_again() {
    let golden = golden();
    let case = &golden["arm"][0];
    let store = Store::of(&case["before"]);
    *store.interloper.lock().expect("interloper") = Some(Map::from_iter([("skillLoadedTools".to_owned(), json!(["recall"]))]));
    let skill = dependencies(&case["dependencies"], &json!([]));
    arm_of(&store, Switches::default()).arm(&thread(), &skill).await;
    assert_eq!(store.snapshot()["skillLoadedTools"], json!(["recall", "office", "read"]));
}

/// The saved messages and the running turn's, as the session holds them.
struct Rows {
    messages: Vec<Value>,
    live: Vec<Value>,
    unreadable: bool,
}

#[async_trait]
impl ThreadMessages for Rows {
    async fn messages(&self, _: &ThreadId) -> Result<Vec<Value>, PortError> {
        if self.unreadable { Err(PortError::Denied("no such thread".into())) } else { Ok(self.messages.clone()) }
    }
}

#[async_trait]
impl RouteSession for Rows {
    fn generation(&self, _: &ThreadId) -> u64 {
        0
    }
    async fn live_turn_messages(&self, _: &ThreadId) -> Result<Vec<Value>, PortError> {
        Ok(self.live.clone())
    }
    fn has_user_conversation(&self, _: &[Value]) -> bool {
        unreachable!("the transcript asks for messages only")
    }
    async fn update_route(&self, _: &ThreadId, _: Route, _: bool) -> Result<bool, PortError> {
        unreachable!("the transcript asks for messages only")
    }
    async fn record_boundary(&self, _: &ThreadId, _: &str, _: Value) -> Result<bool, PortError> {
        unreachable!("the transcript asks for messages only")
    }
    async fn rebuild_tool_surface(&self, _: &ThreadId, _: &str) -> Result<(), PortError> {
        unreachable!("the transcript asks for messages only")
    }
    async fn owner_fallbacks(&self, _: &ThreadId, _: &Header, _: &str, _: &str) -> Result<Option<Vec<Value>>, PortError> {
        unreachable!("the transcript asks for messages only")
    }
    fn write_statusline(&self, _: &ThreadId, _: &Route) {}
    fn invalidate_context_status(&self, _: &ThreadId) {}
}

fn transcript(rows: Rows) -> ThreadTranscript {
    let rows = Arc::new(rows);
    ThreadTranscript::new(rows.clone(), rows)
}

/// Every golden case: a body is present in the transcript exactly when Node found it so.
#[tokio::test]
async fn a_skill_body_is_present_in_the_transcript_as_node_finds_it() {
    let golden = golden();
    let cases = golden["transcript"].as_array().expect("transcript cases");
    assert_eq!(cases.len(), 16);
    for case in cases {
        let rows = |key: &str| case[key].as_array().cloned().unwrap_or_default();
        let transcript = transcript(Rows { messages: rows("messages"), live: rows("live"), unreadable: false });
        let texts = transcript.user_texts(&thread()).await;
        let present = body_present(texts, case["body"].as_str().expect("body"));
        assert_eq!(present, case["present"].as_bool().expect("present"), "{}", case["name"]);
    }
}

/// A transcript that cannot be read holds no body: the skill is delivered again.
#[tokio::test]
async fn an_unreadable_transcript_has_no_user_texts() {
    let transcript = transcript(Rows { messages: vec![json!({"role": "user", "content": "hi"})], live: Vec::new(), unreadable: true });
    assert!(transcript.user_texts(&thread()).await.is_empty());
}
