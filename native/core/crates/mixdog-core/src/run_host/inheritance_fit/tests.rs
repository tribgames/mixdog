use std::sync::Mutex;

use mixdog_agent::compact::estimate::PartMeter;
use mixdog_core_agents::agents::{AgentDefinitions, AgentEvidence};
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_config::config::{AgentRoutes, Config, ConfigLanes};

use super::*;

struct NoEvidence;

#[async_trait]
impl AgentEvidence for NoEvidence {
    async fn home_greeted(&self, _: &str) -> bool {
        false
    }
    async fn home_chatted(&self, _: &str) -> bool {
        false
    }
    async fn mixy_owns_routines(&self) -> Result<bool, String> {
        Ok(false)
    }
}

/// The process seams over an empty saved configuration and an empty environment (the recorder ran
/// with neither).
async fn seams() -> (tempfile::TempDir, Arc<ConfigRunSeams>) {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(dir.path().join("mixdog-config.json"), Arc::new(mixdog_core_api::mock::MockStatePublisher::default()), lanes).await.unwrap();
    let agents = AgentDefinitions::new(
        dir.path(),
        dir.path(),
        tokens.interactive_io,
        AgentRoutes::new(config.clone(), dir.path()),
        Arc::new(NoEvidence),
        Arc::new(|| Value::Null),
        dir.path().join("workspace"),
    );
    let seams = ConfigRunSeams::new(config, Arc::new(agents), dir.path().to_path_buf(), dir.path().to_path_buf(), Arc::new(|_| None));
    (dir, Arc::new(seams))
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

/// The recorded targets' windows, as the catalog would answer for them.
struct Windows(Value);
impl RouteWindows for Windows {
    fn window(&self, _: &str, _: &str, _: &Value) -> Option<ContextMeta> {
        let field = |key: &str| self.0[key].clone();
        Some(ContextMeta {
            context_window: field("contextWindow"),
            raw_context_window: field("rawContextWindow"),
            effective_context_window_percent: field("effectiveContextWindowPercent"),
            auto_compact_token_limit: field("autoCompactTokenLimit"),
            compact_boundary_tokens: field("compactBoundaryTokens"),
        })
    }
}

struct Threads {
    tools: Vec<ToolDefinition>,
    asked: Mutex<Vec<String>>,
    /// The heir session's header, when the target is a session that exists.
    heir: Option<Header>,
}

#[async_trait]
impl MeasuredThreads for Threads {
    async fn header(&self, _: &ThreadId) -> Option<Header> {
        self.heir.clone()
    }
    async fn tools(&self, thread: &ThreadId) -> Vec<ToolDefinition> {
        self.asked.lock().unwrap().push(format!("tools {}", thread.as_str()));
        self.tools.clone()
    }
    async fn media(&self, thread: &ThreadId, _: &[Value]) -> Option<Arc<dyn MediaMeter>> {
        self.asked.lock().unwrap().push(format!("media {}", thread.as_str()));
        Some(Arc::new(TextOnly))
    }
}

fn tools_of(target: &Value) -> Vec<ToolDefinition> {
    // The golden keeps the key order Node built the schemas in, which the estimate prices.
    target["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| ToolDefinition {
            name: tool["name"].as_str().unwrap().to_owned(),
            description: tool["description"].as_str().unwrap().to_owned(),
            input_schema: tool["inputSchema"].clone(),
            defer_loading: tool["deferLoading"] == Value::Bool(true),
            freeform: None,
        })
        .collect()
}

fn golden() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/inheritance-fit/golden.json")).expect("fixture")
}

fn inherit_target(target: &Value) -> InheritTarget {
    InheritTarget {
        provider: target["provider"].as_str().unwrap().to_owned(),
        model: target["model"].as_str().unwrap().to_owned(),
        selected_context_window: None,
        session: None,
        tools_of: Some(ThreadId::from("current".to_owned())),
        source: Some(ThreadId::from("source".to_owned())),
    }
}

/// The header a session holds of Node's session object: its route, window fields and installed `compaction`.
fn heir_header(target: &Value) -> Header {
    ["provider", "model", "contextWindow", "rawContextWindow", "effectiveContextWindowPercent", "autoCompactTokenLimit", "compactBoundaryTokens", "compaction"]
        .into_iter()
        .map(|key| (key.to_owned(), target[key].clone()))
        .collect()
}

/// Every recorded target and conversation: the same `known`, `used` and `limit` as Node's
/// `inheritanceFit`, and a compaction plan (with its budget) exactly where Node's `inheritanceCompactionPlan` has one. A route
/// is measured on the catalog's windows with `{ auto: true }` (a preflight); a session on its own header, installed
/// compaction included (`inheritFrom` into an existing heir).
#[tokio::test]
async fn every_recorded_fit_equals_nodes() {
    let golden = golden();
    let (_dir, config) = seams().await;
    let (mut differ, mut checked, mut sessions) = (Vec::new(), 0, 0);
    for case in golden["cases"].as_array().unwrap() {
        let (name, conversation) = (case["target"].as_str().unwrap(), case["conversation"].as_str().unwrap());
        let session = case["kind"] == "session";
        let target = if session { &golden["sessions"][name] } else { &golden["targets"][name] };
        let rows: Vec<Value> = golden["conversations"][conversation].as_array().unwrap().iter().filter(|row| row["role"] != "system").cloned().collect();
        let heir = session.then(|| heir_header(target));
        let threads = Arc::new(Threads { tools: tools_of(target), asked: Mutex::new(Vec::new()), heir });
        let fit = HostInheritanceFit::new(Arc::new(Windows(target.clone())), config.clone(), threads);
        let heir_target = InheritTarget { session: session.then(|| ThreadId::from("heir".to_owned())), ..inherit_target(target) };
        let basis = fit.basis(&heir_target, &rows).await;
        let want = &case["fit"];
        let got = match &basis {
            Some(basis) => json!({ "known": true, "fits": basis.used < basis.limit, "used": basis.used, "limit": basis.limit }),
            None => json!({ "known": false, "fits": true, "used": 0, "limit": 0 }),
        };
        let want = json!({ "known": want["known"], "fits": want["fits"], "used": want["used"], "limit": want["limit"] });
        let compactable = basis.as_ref().is_some_and(|basis| basis.compactable);
        let budget = fit.compaction_budget(&heir_target).await;
        if got != want || compactable != (case["compactable"] == Value::Bool(true)) || budget != case["budgetTokens"].as_u64() {
            differ.push(format!("{name} / {conversation}: Rust {got} (plan {compactable}, budget {budget:?}), Node {want} (plan {}, budget {})", case["compactable"], case["budgetTokens"]));
        }
        checked += 1;
        sessions += usize::from(session);
    }
    assert!(checked >= 110 && sessions >= 30, "{checked} checked, {sessions} of a session");
    assert!(differ.is_empty(), "{} differ: {}", differ.len(), differ.iter().take(10).cloned().collect::<Vec<_>>().join(" ; "));
}

/// The tools are the opening session's, the media meter is the source's, and a conversation with
/// no rows reads neither the source nor its media.
#[tokio::test]
async fn the_opening_sessions_tools_and_the_sources_media_are_read() {
    let golden = golden();
    let (_dir, config) = seams().await;
    let target = &golden["targets"]["anthropic_mid"];
    let threads = Arc::new(Threads { tools: tools_of(target), asked: Mutex::new(Vec::new()), heir: None });
    let fit = HostInheritanceFit::new(Arc::new(Windows(target.clone())), config.clone(), threads.clone());
    let rows = vec![json!({ "role": "user", "content": "hello" })];
    assert!(fit.basis(&inherit_target(target), &rows).await.is_some());
    assert_eq!(*threads.asked.lock().unwrap(), ["tools current", "media source"]);
    threads.asked.lock().unwrap().clear();
    let empty = fit.basis(&inherit_target(target), &[]).await.unwrap();
    assert_eq!(*threads.asked.lock().unwrap(), ["tools current"]);
    let bare = HostInheritanceFit::new(Arc::new(Windows(target.clone())), config, threads)
        .basis(&InheritTarget { tools_of: None, ..inherit_target(target) }, &[])
        .await
        .unwrap();
    assert!(bare.used < empty.used, "no opening session, no tool schemas to reserve: {} vs {}", bare.used, empty.used);
}
