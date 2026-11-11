//! Node's rebuild cases (`fixtures/tool-catalog-rebuild-cases`, `record-tool-catalog-rebuild-cases.mjs`,
//! the cases of `tool-catalog-rebuild.test.mjs`): each recorded open, change and apply run again through
//! [`ToolSurface::apply`] and the whole session afterwards against Node's, each union through
//! [`ToolSurface::catalog_union`] whole. Each `render` (Node's `renderToolSearch`, the native `load_tool`)
//! runs through the core's `load_tool` (`bridge::load` over the real [`SessionCatalog`], one header update
//! on a store holding the session) and each `select` through the core's `selectDeferredTools`; the whole
//! answer and the whole session afterwards are Node's.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::threads::HeaderUpdate;
use mixdog_core_ports::ports::threads::HeaderUpdates;
use mixdog_core_ports::ports::threads::Section;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_session::session::NoRouteExclusions;
use mixdog_store::schema::record::Header;
use mixdog_tools::orch::util::PortError;

use crate::run_host::deferred_select;
use crate::run_host::session_catalog::RunningHeaders;
use crate::run_host::session_catalog::SessionCatalog;
use super::*;

fn golden() -> Value {
    #[allow(clippy::disallowed_methods)] // the recording, read at run time
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/tool-catalog-rebuild-cases/golden.json")).expect("the recording");
    serde_json::from_str(&text).expect("json")
}

/// The one running thread's header: read as the running session's, updated as the actor's.
struct Store(Mutex<Header>);

impl RunningHeaders for Store {
    fn header(&self, _: &ThreadId) -> Option<Arc<Header>> {
        Some(Arc::new(self.0.lock().expect("store").clone()))
    }
}

#[async_trait]
impl ThreadState for Store {
    async fn header(&self, _: &ThreadId) -> Result<Header, PortError> {
        Ok(self.0.lock().expect("store").clone())
    }
    async fn patch_header(&self, _: &ThreadId, _: Map<String, Value>, _: Vec<String>) -> Result<(), PortError> {
        unreachable!("a load updates the header in one update")
    }
    async fn patch_header_if(&self, _: &ThreadId, _: Map<String, Value>, _: Map<String, Value>, _: Vec<String>) -> Result<Option<Map<String, Value>>, PortError> {
        unreachable!("a load updates the header in one update")
    }
    async fn publish(&self, _: &ThreadId, _: Section) -> Result<(), PortError> {
        unreachable!("a load publishes nothing")
    }
}

#[async_trait]
impl HeaderUpdates for Store {
    async fn update_header(&self, _: &ThreadId, update: HeaderUpdate) -> Result<(), PortError> {
        let mut header = self.0.lock().expect("store");
        let change = update(&header);
        header.extend(change.set);
        for key in change.unset {
            header.remove(&key);
        }
        Ok(())
    }
}

/// `load_tool {names}` as the core runs it for the session `session`: the answer and the session after.
fn load_tool(session: &Value, names: &Value) -> (String, Value) {
    let store = Arc::new(Store(Mutex::new(session.as_object().expect("session").clone())));
    let catalog = SessionCatalog::new(store.clone(), store.clone(), store.clone(), Arc::new(NoRouteExclusions), Arc::new(Host(Vec::new())), Arc::new(Fixed));
    let runtime = tokio::runtime::Builder::new_current_thread().build().expect("runtime");
    let text = runtime.block_on(mixdog_tools::orch::bridge::load(&catalog, &ThreadId::from("t1"), &json!({ "names": names }))).expect("an answer");
    let after = Value::Object(store.0.lock().expect("store").clone());
    (text, after)
}

#[test]
fn every_recorded_rebuild_step_leaves_what_node_left() {
    let golden = golden();
    let host = Host(Vec::new());
    let surface = ToolSurface { host: &host, clock: &Fixed };
    let cases = golden["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 8, "every case of the Node test");
    let mut replayed = 0;
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let mut session = Value::Null;
        for (index, step) in case["steps"].as_array().expect("steps").iter().enumerate() {
            let at = format!("{name}: step {index} ({})", step["op"]);
            match step["op"].as_str().expect("op") {
                "open" => {
                    session = json!({ "provider": step["provider"], "tools": step["tools"], "messages": [] });
                    surface.apply(&mut session, "lead", &[], &ApplyOptions::default());
                }
                "set" => session.as_object_mut().expect("session").extend(step["patch"].as_object().expect("patch").clone()),
                "apply" => {
                    let disallowed = step["options"]["disallowed"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
                    let options = ApplyOptions { disallowed, ..ApplyOptions::default() };
                    surface.apply(&mut session, step["mode"].as_str().expect("mode"), step["extra"].as_array().expect("extra"), &options);
                }
                "union" => {
                    assert_eq!(Value::Array(surface.catalog_union(&session)), step["result"], "{at}");
                    replayed += 1;
                    continue;
                }
                "render" => {
                    assert_eq!(scope_mode_of(&session), step["mode"], "{at}: the mode the handler loads in");
                    let (text, after) = load_tool(&session, &step["names"]);
                    assert_eq!(text, step["result"].as_str().expect("text"), "{at}: the answer");
                    session = after;
                }
                "select" => {
                    let names: Vec<String> = step["names"].as_array().expect("names").iter().map(|n| n.as_str().expect("name").to_owned()).collect();
                    let selection = deferred_select::select(&surface, &mut session, &[], &names, step["mode"] == "readonly", false);
                    assert_eq!(selection.to_value(), step["result"], "{at}: the selection");
                }
                other => panic!("{at}: unknown step {other}"),
            }
            assert_eq!(session, step["session"], "{at}: the session");
            replayed += 1;
        }
    }
    assert_eq!(replayed, 41, "every step");
}

/// The mode `load_tool`'s handler selects in (`scopeMode`), for a thread whose own mode is `full`.
fn scope_mode_of(session: &Value) -> Value {
    json!(deferred_select::scope_mode(session, "full"))
}
