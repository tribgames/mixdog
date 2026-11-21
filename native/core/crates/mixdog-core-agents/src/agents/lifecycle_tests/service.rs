//! The `agent/*` methods as the desktop calls them: how the parameters are read before anything
//! is opened, listed or deleted, and what each method answers.

use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::Method;

use super::*;

/// A pool with no workers.
struct Empty;

#[async_trait]
impl PoolStore for Empty {
    async fn agent_index(&self) -> Option<Value> {
        None
    }
    async fn lead_index(&self) -> Option<Value> {
        None
    }
    async fn headers(&self, ids: &[String]) -> Vec<Option<serde_json::Map<String, Value>>> {
        ids.iter().map(|_| None).collect()
    }
    async fn settle_identities(&self, fixes: &[SettleFix]) -> Vec<Value> {
        fixes.iter().map(|fix| fix.candidate.clone()).collect()
    }
}

impl PoolLive for Empty {
    fn now(&self) -> f64 {
        0.0
    }
    fn running(&self) -> std::collections::HashSet<String> {
        Default::default()
    }
    fn awaiting_shell(&self) -> std::collections::HashSet<String> {
        Default::default()
    }
    fn live_session(&self, _: &str) -> Option<Arc<serde_json::Map<String, Value>>> {
        None
    }
    fn runtime_entry(&self, _: &str) -> Option<RuntimeEntry> {
        None
    }
    fn ledger_tokens(&self, _: &[(String, Vec<String>)]) -> HashMap<String, String> {
        HashMap::new()
    }
    fn stall_warn_ms(&self, _: Option<&str>) -> f64 {
        90_000.0
    }
}

/// A memory runtime that confirms every delete and answers every list with one empty page.
struct Memory(Mutex<Vec<Value>>);

#[async_trait]
impl MemoryRuntime for Memory {
    async fn memory_control(&self, args: Value) -> Result<String, String> {
        self.0.lock().unwrap().push(args.clone());
        Ok(if args["op"] == "delete" { format!("core deleted {}", args["id"]) } else { json!({ "entries": [] }).to_string() })
    }
}

fn service_over(setup: impl FnOnce(&mut World)) -> (AgentHomeService, Arc<Memory>) {
    let (_, homes) = world_of(setup);
    let memory = Arc::new(Memory(Mutex::default()));
    let empty = Arc::new(Empty);
    let pool = Arc::new(AgentPool::new(empty.clone(), empty));
    (AgentHomeService::new(homes, AgentMemoryHost::new(memory.clone()), pool), memory)
}

async fn call(service: &AgentHomeService, method: &'static str, params: Value) -> Result<Value, CoreError> {
    let request = CoreRequest { method: Method(method), params, op: None, ctx: CallContext::internal("test") };
    match service.call(request).await? {
        Reply::Value(value) => Ok(value),
        _ => panic!("{method} answered no value"),
    }
}

#[tokio::test]
async fn the_service_claims_its_five_methods() {
    let (service, _) = service_over(|_| {});
    assert_eq!(service.methods(), ["agent/home/open", "agent/home/reset", "agent/memory/list", "agent/memory/delete", "agent/pool/list"]);
    let unknown = call(&service, "agent/home/elsewhere", json!({ "agentId": "ada" })).await.unwrap_err();
    assert!(matches!(unknown, CoreError::InvalidParams { .. }), "{unknown:?}");
}

#[tokio::test]
async fn the_agent_id_is_a_trimmed_string_of_at_most_200_characters() {
    let (service, memory) = service_over(|world| world.agents = vec![contact("ada")]);
    for params in [json!({}), json!({ "agentId": 3 }), json!({ "agentId": null }), json!({ "agentId": ["ada"] })] {
        let error = call(&service, "agent/memory/list", params.clone()).await.unwrap_err();
        assert_eq!(message(&error), "agentId must be a string.", "{params}");
    }
    let long = "a".repeat(201);
    for id in ["", "   ", long.as_str()] {
        let error = call(&service, "agent/memory/list", json!({ "agentId": id })).await.unwrap_err();
        assert_eq!(message(&error), "agentId is invalid.");
    }
    assert!(memory.0.lock().unwrap().is_empty(), "nothing is asked of the runtime for a bad id");
    // A well-formed string that names no home id is refused by the memory methods.
    let bad = call(&service, "agent/memory/list", json!({ "agentId": "Bad Id" })).await.unwrap_err();
    assert_eq!(message(&bad), "agent id is invalid.");
    // The id is trimmed.
    assert_eq!(call(&service, "agent/memory/list", json!({ "agentId": "  ada " })).await.unwrap(), json!([]));
    assert_eq!(memory.0.lock().unwrap()[0]["agent_id"], "ada");
}

#[tokio::test]
async fn opening_and_resetting_through_the_service_answer_the_session_ids() {
    let (service, _) = service_over(|world| world.agents = vec![contact("ada")]);
    assert_eq!(call(&service, "agent/home/open", json!({ "agentId": " ada" })).await.unwrap(), json!({ "sessionId": "sess_home_ada" }));
    // Nothing was said in the thread: a reset has no conversation to archive.
    assert_eq!(
        call(&service, "agent/home/reset", json!({ "agentId": "ada" })).await.unwrap(),
        json!({ "sessionId": "sess_home_ada", "archivedSessionId": null })
    );
    let missing = call(&service, "agent/home/open", json!({ "agentId": "nobody" })).await.unwrap_err();
    assert_eq!(message(&missing), "Agent \"nobody\" is not available.");
}

#[tokio::test]
async fn a_memory_delete_carries_the_entry_as_text_and_the_list_version() {
    let (service, memory) = service_over(|_| {});
    let delete = |entry: Value, revision: Value| json!({ "agentId": "ada", "entryId": entry, "indexRevision": revision });
    assert_eq!(call(&service, "agent/memory/delete", delete(json!("7"), json!("r1"))).await.unwrap(), Value::Null);
    assert_eq!(memory.0.lock().unwrap()[0], json!({ "op": "delete", "agent_id": "ada", "id": 7, "index_revision": "r1" }));

    // An entry id that is not text is the wrong type; text that is no positive whole number is no entry.
    let typed = call(&service, "agent/memory/delete", delete(json!(7), json!("r1"))).await.unwrap_err();
    assert!(matches!(typed, CoreError::InvalidParams { .. }), "{typed:?}");
    for entry in ["abc", "0", "-3", "1.5", ""] {
        let error = call(&service, "agent/memory/delete", delete(json!(entry), json!("r1"))).await.unwrap_err();
        assert_eq!(message(&error), "memory id is invalid.", "{entry:?}");
    }
    for revision in [Value::Null, json!(""), json!(5)] {
        let error = call(&service, "agent/memory/delete", delete(json!("7"), revision.clone())).await.unwrap_err();
        assert_eq!(message(&error), "memory indexRevision is invalid.", "{revision}");
    }
    assert_eq!(memory.0.lock().unwrap().len(), 1, "only the valid delete reached the runtime");
}

#[tokio::test]
async fn the_pool_lists_nothing_when_no_agent_has_run() {
    let (service, _) = service_over(|_| {});
    assert_eq!(call(&service, "agent/pool/list", json!({})).await.unwrap(), json!([]));
}
