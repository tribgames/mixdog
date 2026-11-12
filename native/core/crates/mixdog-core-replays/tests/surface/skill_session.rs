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

use mixdog_core::run_host::skill_session::*;
use mixdog_mcp::skill_port::DeferredToolArm as _;
use mixdog_mcp::skill_port::TranscriptTexts as _;
use std::sync::Arc;
use async_trait::async_trait;
use mixdog_agent::env::Clock;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::memory_source::ThreadMessages;
use mixdog_core_ports::ports::route::RouteSession;
use mixdog_core_ports::ports::threads::HeaderUpdate;
use mixdog_core_ports::ports::threads::HeaderUpdates;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_mcp::skill_deps::SkillToolDependencies;
use mixdog_store::schema::record::Header;
use mixdog_tools::orch::skill::ArmNotice;
use mixdog_tools::orch::util::PortError;
use mixdog_tools::policy::ConnectorPermissions;
use serde_json::Map;
use serde_json::Value;
use mixdog_core::run_host::tool_surface::SurfaceHost;

#[path = "node_cases.rs"]
mod node_cases;

fn golden() -> Value {
    mixdog_js::fixture_tools::parse_golden(mixdog_testkit::fixture!("../../fixtures/skill-session/golden.json")).expect("fixture")
}

fn thread() -> ThreadId {
    ThreadId::from("t1")
}

fn object(value: &Value) -> Header {
    value.as_object().expect("object").clone()
}

/// The header of thread `t1` with one writer, as the session actor holds it: an update runs on the
/// header as it stands, one at a time, and its change is applied before the next.
const ROUNDS: usize = 50;

struct Store {
    header: Mutex<Header>,
    /// A header write by another party that lands before the next update does.
    interloper: Mutex<Option<Map<String, Value>>>,
    /// Reads that fail, and updates that fail.
    unreadable: bool,
    fails: bool,
    /// How many of its ROUNDS a rival writer has used: it writes after each read of the header and before each update, which is
    /// the writer's worst interleaving with the load, and a load that keeps going past its last round has stalled.
    rival: Option<std::sync::atomic::AtomicUsize>,
}

impl Store {
    fn of(header: &Value) -> Arc<Self> {
        Arc::new(Self { header: Mutex::new(object(header)), interloper: Mutex::new(None), unreadable: false, fails: false, rival: None })
    }

    fn rivaled(header: &Value) -> Arc<Self> {
        Arc::new(Self { header: Mutex::new(object(header)), interloper: Mutex::new(None), unreadable: false, fails: false, rival: Some(std::sync::atomic::AtomicUsize::new(0)) })
    }

    fn failing(header: &Value, unreadable: bool, fails: bool) -> Arc<Self> {
        Arc::new(Self { header: Mutex::new(object(header)), interloper: Mutex::new(None), unreadable, fails, rival: None })
    }

    fn snapshot(&self) -> Header {
        self.header.lock().expect("store").clone()
    }

    /// The rival's next round, failing by assertion when the load is still going after the last.
    fn rival_writes(&self) {
        let Some(done) = &self.rival else { return };
        let round = done.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        assert!(round < ROUNDS, "the load kept reading and updating the header past the writer's {ROUNDS} rounds: it stalled");
        self.write(Map::from_iter([("title".to_owned(), json!(round)), ("skillLoadedTools".to_owned(), json!(["recall"]))]));
    }

    /// Another writer's change, applied as the one writer applies it.
    fn write(&self, set: Map<String, Value>) {
        self.header.lock().expect("store").extend(set);
    }
}

#[async_trait]
impl ThreadState for Store {
    async fn header(&self, _: &ThreadId) -> Result<Header, PortError> {
        if self.unreadable {
            return Err(PortError::Failed { capability: "session".into(), message: "header unreadable".into() });
        }
        let header = self.snapshot();
        self.rival_writes();
        Ok(header)
    }
    async fn patch_header(&self, _: &ThreadId, _: Map<String, Value>, _: Vec<String>) -> Result<(), PortError> {
        unreachable!("the arm updates the header through HeaderUpdates")
    }
    async fn patch_header_if(&self, _: &ThreadId, _: Map<String, Value>, _: Map<String, Value>, _: Vec<String>) -> Result<Option<Map<String, Value>>, PortError> {
        unreachable!("the arm updates the header through HeaderUpdates")
    }
    async fn publish(&self, _: &ThreadId, _: Section) -> Result<(), PortError> {
        unreachable!("the arm publishes nothing")
    }
}

#[async_trait]
impl HeaderUpdates for Store {
    async fn update_header(&self, _: &ThreadId, update: HeaderUpdate) -> Result<(), PortError> {
        if self.fails {
            return Err(PortError::Failed { capability: "session".into(), message: "header unwritable".into() });
        }
        self.rival_writes();
        let mut header = self.header.lock().expect("store");
        if let Some(write) = self.interloper.lock().expect("interloper").take() {
            header.extend(write);
        }
        let change = update(&header);
        header.extend(change.set);
        for key in change.unset {
            header.shift_remove(&key);
        }
        Ok(())
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
    HeaderSkillArm::new(store.clone(), store.clone(), Arc::new(NoRouteExclusions), Arc::new(switches), Arc::new(Host), Arc::new(Now))
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
/// Node ended with, key for key, and the notice is the text Node appended to the stub (or the
/// native payload that replaced the result), whole.
#[tokio::test]
async fn a_skill_load_leaves_the_session_and_tells_the_model_as_node_does() {
    let golden = golden();
    let cases = golden["arm"].as_array().expect("arm cases");
    assert_eq!(cases.len(), 31);
    for case in cases {
        let name = &case["name"];
        let store = Store::of(&case["before"]);
        let arm = arm_of(&store, Switches::default());
        let skill = dependencies(&case["dependencies"], &case["issues"]);
        let mut notice = ArmNotice::default();
        for _ in 0..case["loads"].as_u64().expect("loads") {
            notice = arm.arm(&thread(), &skill).await.expect("armed");
        }
        assert_eq!(Value::Object(store.snapshot()), case["after"], "{name}");
        let lines: Vec<&str> = notice.lines.iter().map(String::as_str).collect();
        let recorded: Vec<&str> = case["notice"]["lines"].as_array().expect("lines").iter().map(|line| line.as_str().expect("line")).collect();
        assert_eq!(lines, recorded, "{name}: lines");
        assert_eq!(notice.native.clone().unwrap_or(Value::Null), case["notice"]["native"], "{name}: native");
        assert_eq!(notice.result(case["head"].as_str().expect("head")), case["result"].as_str().expect("result"), "{name}: result");
    }
}

/// `preDispatchDenyForSession` reads the agent's connector policy and the project's switches per
/// tool (`agentMcpToolPermission`, `projectMcpToolDisabled`): a tool either turns off is not armed,
/// is reported unavailable with the refusal's text, and the others are armed.
#[tokio::test]
async fn a_tool_the_connector_or_project_switched_off_is_not_armed() {
    let golden = golden();
    let case = &golden["arm"][0];
    assert_eq!(case["name"], "native openai: an eager and a deferred dependency");
    let skill = dependencies(&json!([{"type": "tool", "value": "read"}, {"type": "tool", "value": "office"}]), &json!([]));
    let switched = [
        (Switches { connector: vec!["office".into()], ..Switches::default() }, "office (Error: tool \"office\" is not available to this agent.)"),
        (Switches { project: vec!["office".into()], ..Switches::default() }, "office (Error: tool \"office\" is switched off in this project.)"),
    ];
    for (switches, reason) in switched {
        let store = Store::of(&case["before"]);
        let notice = arm_of(&store, switches).arm(&thread(), &skill).await.expect("armed");
        let header = store.snapshot();
        assert_eq!(header["skillLoadedTools"], json!(["read"]));
        assert!(!header["deferredCallableTools"].as_array().expect("callable").contains(&json!("office")));
        assert!(notice.lines.contains(&format!("Required tools unavailable: {reason}")), "{:?}", notice.lines);
    }
}

/// A header that cannot be read or updated fails the load with the port's error: nothing is
/// reported armed.
#[tokio::test]
async fn a_header_that_cannot_be_read_or_updated_fails_the_load() {
    let golden = golden();
    let case = &golden["arm"][0];
    let skill = dependencies(&case["dependencies"], &json!([]));
    for (unreadable, fails) in [(true, false), (false, true)] {
        let store = Store::failing(&case["before"], unreadable, fails);
        let failed = arm_of(&store, Switches::default()).arm(&thread(), &skill).await;
        assert!(matches!(failed, Err(PortError::Failed { ref capability, .. }) if capability == "session"), "{failed:?}");
        assert_eq!(Value::Object(store.snapshot()), case["before"]);
    }
}

/// The update is pure: what it asks of the world was looked up before it ran. A tool the catalog
/// gained in between was not looked up, so the load fails (typed) and writes nothing, rather than
/// guessing its switches.
#[tokio::test]
async fn a_tool_the_catalog_gained_after_the_lookups_fails_the_load() {
    let golden = golden();
    let case = &golden["arm"][0];
    let store = Store::of(&case["before"]);
    let gained = json!({"name": "mcp__docs__lookup", "description": "d", "inputSchema": {"type": "object", "properties": {}}, "mcpServerName": "docs"});
    let mut catalog = store.snapshot()["deferredToolCatalog"].as_array().cloned().unwrap_or_default();
    catalog.push(gained);
    *store.interloper.lock().expect("interloper") = Some(Map::from_iter([("deferredToolCatalog".to_owned(), Value::Array(catalog))]));
    let skill = dependencies(&json!([{"type": "mcp", "value": "docs"}]), &json!([]));
    let failed = arm_of(&store, Switches::default()).arm(&thread(), &skill).await;
    assert!(matches!(failed, Err(PortError::Failed { ref message, .. }) if message.contains("mcp__docs__lookup")), "{failed:?}");
    assert!(!store.snapshot().contains_key("skillLoadedTools"));
}

/// A write that lands before the update is part of the header the load reads: both are kept.
#[tokio::test]
async fn a_write_that_lands_first_is_read_by_the_load_and_kept() {
    let golden = golden();
    let case = &golden["arm"][0];
    let store = Store::of(&case["before"]);
    *store.interloper.lock().expect("interloper") = Some(Map::from_iter([("skillLoadedTools".to_owned(), json!(["recall"])), ("title".to_owned(), json!("held"))]));
    let skill = dependencies(&case["dependencies"], &json!([]));
    arm_of(&store, Switches::default()).arm(&thread(), &skill).await.expect("armed");
    let header = store.snapshot();
    assert_eq!(header["skillLoadedTools"], json!(["recall", "office", "read"]));
    assert_eq!(header["title"], json!("held"));
}

/// A writer that keeps changing the header (an armed key among them) neither stalls the load nor
/// loses its own keys: the load completes in one update and the writer's last write stands.
#[tokio::test]
async fn a_writer_that_keeps_writing_neither_stalls_the_load_nor_loses_its_keys() {
    let golden = golden();
    let case = &golden["arm"][0];
    let store = Store::rivaled(&case["before"]);
    let skill = dependencies(&case["dependencies"], &json!([]));
    let arm = arm_of(&store, Switches::default());
    let armed = arm.arm(&thread(), &skill).await;
    // The rest of the writer's rounds, after the load has ended.
    while store.rival.as_ref().expect("rival").load(std::sync::atomic::Ordering::SeqCst) < ROUNDS {
        store.rival_writes();
    }
    armed.expect("armed");
    let header = store.snapshot();
    assert_eq!(header["title"], json!(49));
    assert!(header["deferredCallableTools"].as_array().expect("callable").contains(&json!("office")));
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
        let texts = transcript.user_texts(&thread()).await.expect("texts");
        let present = body_present(texts, case["body"].as_str().expect("body"));
        assert_eq!(present, case["present"].as_bool().expect("present"), "{}", case["name"]);
    }
}

/// A transcript that cannot be read is the port's error, not an empty transcript.
#[tokio::test]
async fn an_unreadable_transcript_is_an_error() {
    let transcript = transcript(Rows { messages: vec![json!({"role": "user", "content": "hi"})], live: Vec::new(), unreadable: true });
    assert_eq!(transcript.user_texts(&thread()).await, Err(PortError::Denied("no such thread".into())));
}
