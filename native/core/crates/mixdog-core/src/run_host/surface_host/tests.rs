use super::*;
use mixdog_core_session::session::thread_switches::WorkflowTarget;

/// `configuredOrchestrationMode(config)`, the reader the flip hands `SurfaceSources`: the stored
/// mode, `balanced` for none or an unknown one.
#[test]
fn the_configured_orchestration_mode_is_readable_from_the_host_crate() {
    use mixdog_core_config::workflow::ids::configured_orchestration_mode;
    let doc = |value: Value| value.as_object().expect("doc").clone();
    assert_eq!(configured_orchestration_mode(&doc(json!({}))), "balanced");
    assert_eq!(configured_orchestration_mode(&doc(json!({ "orchestrationMode": "swarm" }))), "swarm");
    assert_eq!(configured_orchestration_mode(&doc(json!({ "orchestrationMode": "bogus" }))), "balanced");
}

/// `leadRosterRevision` over the slices Node's recorder gave it (`create_goldens/lead.json`).
#[test]
fn the_roster_revision_is_nodes() {
    let golden: Value = serde_json::from_str(include_str!("../../../../mixdog-core-session/src/session/create_goldens/lead.json")).expect("golden");
    let text = |key: &str| golden["parts"][key].as_str().expect("slice").to_owned();
    let target = WorkflowTarget {
        summary: Value::Null,
        orchestration_mode: String::new(),
        pack_context: String::new(),
        orchestration_context: String::new(),
        agent_catalog_context: text("agentCatalogContext"),
        contact_catalog_context: text("contactCatalogContext"),
    };
    assert_eq!(golden["record"]["agentRosterRevision"], json!(roster_revision(&target)));
}
