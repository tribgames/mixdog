//! `arg-schema-coerce.test.mjs` "internal registry tools resolve their schema when absent from the session
//! catalog", replayed through the call executor against Node's `coerceToolArgsForSession`
//! (`fixtures/compact-node-cases/golden.json`, `benchmarks/rust-core/recorders/record-compact-node-cases.mjs`):
//! a surface offering no tool calls the registry's `office`, which receives the arguments Node coerced; a name
//! no registry knows reaches no tool, so its arguments stay as given.

use std::sync::Mutex;

use mixdog_core_api::domain::mock::MockApprovalGate;
use mixdog_core_api::domain::mock::MockFileService;
use mixdog_core_api::domain::mock::MockProcessManager;
use mixdog_core_api::domain::mock::MockProgress;
use serde_json::Value;

use super::*;

struct Epoch;
impl Clock for Epoch {
    fn now_ms(&self) -> i64 {
        0
    }
}

/// A Lead call environment that lets every call through, over `tools`.
fn env(tools: ToolSet) -> CallEnv {
    let tokens = mixdog_rt::testing::tokens();
    let cancel = CancellationToken::new();
    CallEnv {
        tools,
        gate: Arc::new(crate::env::AllowAll),
        hooks: None,
        observer: Arc::new(crate::env::NullObserver),
        guards: Arc::new(crate::env::NoGuards),
        mcp: None,
        prepared: false,
        clock: Arc::new(Epoch),
        tool_env: ToolEnv {
            thread_id: ThreadId::from("t"),
            turn_id: TurnId::from("r"),
            cwd: AbsPath::new(std::env::temp_dir()).unwrap(),
            surface: SurfaceKind::Lead,
            io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
            approvals: Arc::new(MockApprovalGate::default()),
            files: Arc::new(MockFileService::default()),
            processes: Arc::new(MockProcessManager::default()),
            progress: Arc::new(MockProgress::default()),
            deadline_of: None,
            notify: None,
            review: None,
        },
        signal: crate::cancel::Cancel::from_token(&cancel),
        cancel,
    }
}

struct Office {
    spec: ToolSpec,
    received: Mutex<Vec<Value>>,
}

#[async_trait::async_trait]
impl Tool for Office {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }
    async fn call(&self, _: &ToolContext, args: Value) -> ToolOutcome {
        self.received.lock().unwrap().push(args);
        Ok(ToolOutput::default())
    }
}

struct InternalRegistry(Arc<Office>);

impl mixdog_tools::policy::ToolResolver for InternalRegistry {
    fn resolve(&self, _scope: Option<&str>, name: &str) -> Option<Arc<dyn Tool>> {
        (name == self.0.spec.name).then(|| self.0.clone() as Arc<dyn Tool>)
    }
}

#[tokio::test]
async fn a_registry_tool_absent_from_the_session_is_coerced_to_its_registry_schema_as_in_node() {
    let golden: Value = serde_json::from_str(include_str!("../../../fixtures/compact-node-cases/golden.json")).unwrap();
    let cases: Vec<&Value> = golden["coerce"].as_array().unwrap().iter().filter(|c| c["name"].as_str().unwrap().starts_with("session tool ")).collect();
    assert_eq!(cases.len(), 2);
    let office_schema = cases.iter().find(|c| c["name"] == "session tool office").unwrap()["schema"].clone();
    let office = Arc::new(Office {
        spec: ToolSpec {
            name: "office".into(),
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: "office".into(),
            input_schema: office_schema,
            annotations: Default::default(),
            parallel_safe: true,
            exclusive_with: Vec::new(),
        },
        received: Mutex::new(Vec::new()),
    });
    for case in cases {
        let tool = case["name"].as_str().unwrap().trim_start_matches("session tool ");
        // `session.tools: []`: the surface offers nothing; the registry holds the internal tool.
        let env = env(ToolSet::new(Vec::new()).with_registry(Arc::new(InternalRegistry(office.clone())), None));
        let before = office.received.lock().unwrap().len();
        let call = ToolCall { id: "c1".into(), name: tool.into(), arguments: case["args"].clone(), native_type: None };
        let executed = execute_call(call, Arc::new(env)).await;
        let received: Vec<Value> = office.received.lock().unwrap()[before..].to_vec();
        if case["schema"].is_null() {
            // Node passes the arguments through untouched; here nothing receives them and the call is unknown.
            assert_eq!(case["coerced"], case["args"]);
            assert!(received.is_empty(), "{tool}");
            assert_eq!(executed.message.text(), crate::text::unknown_tool_message(tool, &[]), "{tool}");
        } else {
            assert_eq!(received, vec![case["coerced"].clone()], "{tool}");
        }
    }
}
