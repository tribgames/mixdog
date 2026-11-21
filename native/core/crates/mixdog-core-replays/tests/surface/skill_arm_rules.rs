//! A skill's tool dependencies armed into its thread's session (`HeaderSkillArm`): a tool the session already has is reported
//! loaded and remembered in `skillLoadedTools`, a tool the session lacks, refuses or has switched off is reported unavailable
//! and changes nothing, an unsupported dependency kind is named, and a header that cannot be read or written fails the load.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_agent::env::Clock;
use mixdog_core::run_host::skill_session::HeaderSkillArm;
use mixdog_core::run_host::tool_surface::SurfaceHost;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::threads::HeaderUpdate;
use mixdog_core_ports::ports::threads::HeaderUpdates;
use mixdog_core_ports::ports::threads::Section;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_session::session::NoRouteExclusions;
use mixdog_mcp::skill_deps::DependencySource;
use mixdog_mcp::skill_deps::SkillToolDependencies;
use mixdog_mcp::skill_port::DeferredToolArm;
use mixdog_store::schema::record::Header;
use mixdog_tools::orch::util::PortError;
use mixdog_tools::policy::ConnectorPermissions;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

struct Store {
    header: Mutex<Header>,
    unreadable: bool,
    unwritable: bool,
}

impl Store {
    fn new(header: Value) -> Arc<Self> {
        Arc::new(Self { header: Mutex::new(header.as_object().expect("a header").clone()), unreadable: false, unwritable: false })
    }

    fn snapshot(&self) -> Header {
        self.header.lock().expect("store").clone()
    }
}

#[async_trait]
impl ThreadState for Store {
    async fn header(&self, _: &ThreadId) -> Result<Header, PortError> {
        if self.unreadable {
            return Err(PortError::Failed { capability: "session".into(), message: "header unreadable".into() });
        }
        Ok(self.snapshot())
    }
    async fn patch_header(&self, _: &ThreadId, _: Map<String, Value>, _: Vec<String>) -> Result<(), PortError> {
        unreachable!("the arm updates the header through HeaderUpdates")
    }
    async fn patch_header_if(
        &self,
        _: &ThreadId,
        _: Map<String, Value>,
        _: Map<String, Value>,
        _: Vec<String>,
    ) -> Result<Option<Map<String, Value>>, PortError> {
        unreachable!("the arm updates the header through HeaderUpdates")
    }
    async fn store_header(&self, thread: &ThreadId, write: mixdog_core_ports::ports::threads::HeaderWrite) -> mixdog_core_ports::ports::threads::HeaderStored {
        mixdog_core_ports::ports::threads::HeaderStored::of_patch(self.patch_header(thread, write.set, write.unset).await)
    }
    fn log_identity(&self, _: &ThreadId) -> Option<String> {
        None
    }
    /// This fake holds nothing but the header it answers.
    async fn held_fields(
        &self,
        thread: &ThreadId,
        keys: &'static [&'static str],
    ) -> Result<serde_json::Map<String, serde_json::Value>, mixdog_tools::orch::util::PortError> {
        Ok(mixdog_core_ports::ports::threads::held_of(&self.header(thread).await?, keys))
    }
    async fn publish(&self, _: &ThreadId, _: Section) -> Result<(), PortError> {
        unreachable!("the arm publishes nothing")
    }
}

#[async_trait]
impl HeaderUpdates for Store {
    async fn update_header(&self, _: &ThreadId, update: HeaderUpdate) -> Result<(), PortError> {
        if self.unwritable {
            return Err(PortError::Failed { capability: "session".into(), message: "header unwritable".into() });
        }
        let mut header = self.header.lock().expect("store");
        let change = update(&header);
        header.extend(change.set);
        for key in change.unset {
            header.shift_remove(&key);
        }
        Ok(())
    }
}

/// Connector switches: the named tools are switched off.
#[derive(Default)]
struct Switches(Vec<String>);

#[async_trait]
impl ConnectorPermissions for Switches {
    fn needs_approval(&self, _: &str, _: &str) -> bool {
        false
    }
    fn disabled(&self, _: &str, tool: &str) -> bool {
        self.0.iter().any(|name| name == tool)
    }
    fn project_disabled(&self, _: &ThreadId, _: &str) -> bool {
        false
    }
    async fn allow_always(&self, _: &str, _: &str) -> bool {
        false
    }
}

struct Host;

impl SurfaceHost for Host {
    fn defined(&self, _: &str) -> bool {
        true
    }
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

fn arm(store: &Arc<Store>, switched_off: &[&str]) -> HeaderSkillArm {
    let switches = Switches(switched_off.iter().map(|name| (*name).to_owned()).collect());
    HeaderSkillArm::new(store.clone(), store.clone(), Arc::new(NoRouteExclusions), Arc::new(switches), Arc::new(Host), Arc::new(Now))
}

fn dependencies(list: Value, issues: &[&str]) -> SkillToolDependencies {
    SkillToolDependencies {
        tool_dependencies: list.as_array().expect("dependencies").clone(),
        declared: Vec::new(),
        source: DependencySource::Declaration,
        issues: issues.iter().map(|issue| (*issue).to_owned()).collect(),
    }
}

fn session() -> Value {
    json!({
        "provider": "openai",
        "model": "gpt",
        "tools": [{ "name": "read", "description": "Read" }],
        "deferredToolCatalog": [{ "name": "office", "description": "Office" }],
    })
}

fn thread() -> ThreadId {
    ThreadId::from("t1")
}

fn said(notice: &mixdog_tools::orch::skill::ArmNotice) -> String {
    notice.lines.join("\n")
}

#[tokio::test]
async fn a_dependency_the_session_already_has_is_reported_loaded_and_remembered() {
    // With nothing deferred the session's own tools are what a dependency resolves against; once a deferred catalog exists only
    // it is (`resolvable`, `deferred_select.rs:80`).
    let mut held = session();
    held.as_object_mut().expect("a header").remove("deferredToolCatalog");
    let store = Store::new(held);
    let notice = arm(&store, &[]).arm(&thread(), &dependencies(json!([{ "type": "tool", "value": "read" }]), &[])).await.expect("armed");
    assert!(said(&notice).contains("Required tools loaded") && said(&notice).contains("read"), "{}", said(&notice));
    assert_eq!(store.snapshot()["skillLoadedTools"], json!(["read"]));
}

#[tokio::test]
async fn a_discovered_dependency_still_has_a_schema_if_its_result_left_the_input() {
    let mut header = session();
    header["toolSpec"] = json!("full");
    header["deferredProviderMode"] = json!("native");
    let store = Store::new(header);
    let arm = arm(&store, &[]);
    let skill = dependencies(json!([{ "type": "tool", "value": "office" }]), &[]);
    let first = arm.arm(&thread(), &skill).await.expect("first load");
    assert_eq!(first.native.unwrap()["toolReferences"], json!(["office"]));
    let second = arm.arm(&thread(), &skill).await.expect("repeat load");
    assert!(said(&second).contains("office"));
    assert_eq!(second.native.unwrap()["toolReferences"], json!(["office"]));
}

#[tokio::test]
async fn a_dependency_the_session_does_not_have_is_unavailable_and_changes_nothing() {
    let store = Store::new(session());
    let before = store.snapshot();
    let notice = arm(&store, &[]).arm(&thread(), &dependencies(json!([{ "type": "tool", "value": "missing_tool" }]), &[])).await.expect("answered");
    assert!(
        said(&notice).contains("Required tools unavailable") && said(&notice).contains("missing_tool (not available in this session)"),
        "{}",
        said(&notice)
    );
    assert_eq!(store.snapshot(), before);
}

#[tokio::test]
async fn a_tool_the_connector_switched_off_is_not_armed_and_the_skills_own_issues_come_first() {
    let store = Store::new(session());
    let notice = arm(&store, &["read"]).arm(&thread(), &dependencies(json!([{ "type": "tool", "value": "read" }]), &["issue one"])).await.expect("answered");
    let text = said(&notice);
    assert!(text.find("issue one").expect("the issue") < text.find("read").expect("the tool"), "{text}");
    assert!(store.snapshot().get("skillLoadedTools").is_none(), "{text}");
}

#[tokio::test]
async fn an_unsupported_dependency_kind_and_a_server_with_no_tools_are_named() {
    let store = Store::new(session());
    let list = json!([{ "type": "plugin", "value": "p" }, { "type": "mcp", "value": "ghost" }]);
    let notice = arm(&store, &[]).arm(&thread(), &dependencies(list, &[])).await.expect("answered");
    let text = said(&notice);
    assert!(text.contains("plugin:p (unsupported dependency type)"), "{text}");
    assert!(text.contains("mcp:ghost (no available connected tools)"), "{text}");
}

#[tokio::test]
async fn a_header_that_cannot_be_read_or_written_fails_the_load() {
    let deps = dependencies(json!([{ "type": "tool", "value": "read" }]), &[]);
    let unreadable = Arc::new(Store { header: Mutex::new(session().as_object().unwrap().clone()), unreadable: true, unwritable: false });
    assert!(arm(&unreadable, &[]).arm(&thread(), &deps).await.is_err());
    let unwritable = Arc::new(Store { header: Mutex::new(session().as_object().unwrap().clone()), unreadable: false, unwritable: true });
    assert!(arm(&unwritable, &[]).arm(&thread(), &deps).await.is_err());
    assert!(unwritable.snapshot().get("skillLoadedTools").is_none());
}
