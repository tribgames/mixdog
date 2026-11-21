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

#[test]
fn a_leads_denials_are_the_callers_then_the_feature_gates_once_then_agent_and_react() {
    let header = json!({ "disallowedTools": ["a", "web_search"] }).as_object().expect("header").clone();
    let summary = json!({ "delegatesAgents": false });
    let feature = ["web_search".to_owned(), "git".to_owned()];
    assert_eq!(lead_denials(&header, &header, &summary, true, &feature), ["a", "web_search", "git", "agent", "react"]);
}

#[test]
fn denying_tools_records_them_and_drops_them_from_the_stored_lists() {
    let mut session = json!({ "tools": [{ "name": "a" }, { "name": "b" }], "deferredToolCatalog": [{ "name": "a" }] });
    deny_tools(&mut session, &["a".to_owned()]);
    assert_eq!(session["disallowedTools"], json!(["a"]));
    assert_eq!(session["tools"], json!([{ "name": "b" }]));
    assert_eq!(session["deferredToolCatalog"], json!([]));
}

#[test]
fn pushing_names_keeps_each_once_in_arrival_order() {
    let mut names = vec!["a".to_owned()];
    push_unique(&mut names, ["b".to_owned(), "a".to_owned(), "c".to_owned()]);
    assert_eq!(names, ["a", "b", "c"]);
}

mod unloading {
    use std::sync::Mutex;

    use mixdog_core_ports::ports::route::Route;
    use mixdog_core_ports::ports::threads::Section;
    use mixdog_core_session::session::agent_registry::Row;
    use mixdog_core_session::session::thread_switches::SurfaceFailure;
    use mixdog_mcp::hub::ScopeReleased;

    use super::*;

    struct Store(Mutex<Header>);

    #[async_trait]
    impl ThreadState for Store {
        async fn header(&self, _: &ThreadId) -> Result<Header, PortError> {
            Ok(self.0.lock().expect("store").clone())
        }
        async fn patch_header(&self, _: &ThreadId, _: Map<String, Value>, _: Vec<String>) -> Result<(), PortError> {
            unreachable!("the surface patches conditionally")
        }
        async fn patch_header_if(
            &self,
            _: &ThreadId,
            _: Map<String, Value>,
            set: Map<String, Value>,
            unset: Vec<String>,
        ) -> Result<Option<Map<String, Value>>, PortError> {
            let mut header = self.0.lock().expect("store");
            header.extend(set);
            for key in unset {
                header.shift_remove(&key);
            }
            Ok(None)
        }
        async fn store_header(
            &self,
            thread: &ThreadId,
            write: mixdog_core_ports::ports::threads::HeaderWrite,
        ) -> mixdog_core_ports::ports::threads::HeaderStored {
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
            unreachable!("the surface publishes nothing")
        }
    }

    /// A store whose first header read waits: it tells `.1`'s sender it arrived, then waits for its receiver.
    struct HeldRead(Store, Mutex<Option<(tokio::sync::oneshot::Sender<()>, tokio::sync::oneshot::Receiver<()>)>>);

    #[async_trait]
    impl ThreadState for HeldRead {
        async fn header(&self, thread: &ThreadId) -> Result<Header, PortError> {
            let held = self.1.lock().expect("hold").take();
            if let Some((arrived, go)) = held {
                let _ = arrived.send(());
                let _ = go.await;
            }
            self.0.header(thread).await
        }
        async fn patch_header(&self, thread: &ThreadId, set: Map<String, Value>, unset: Vec<String>) -> Result<(), PortError> {
            self.0.patch_header(thread, set, unset).await
        }
        async fn patch_header_if(
            &self,
            thread: &ThreadId,
            expect: Map<String, Value>,
            set: Map<String, Value>,
            unset: Vec<String>,
        ) -> Result<Option<Map<String, Value>>, PortError> {
            self.0.patch_header_if(thread, expect, set, unset).await
        }
        async fn store_header(
            &self,
            thread: &ThreadId,
            write: mixdog_core_ports::ports::threads::HeaderWrite,
        ) -> mixdog_core_ports::ports::threads::HeaderStored {
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
        async fn publish(&self, thread: &ThreadId, section: Section) -> Result<(), PortError> {
            self.0.publish(thread, section).await
        }
    }

    struct Now;
    impl Clock for Now {
        fn now_ms(&self) -> i64 {
            1
        }
    }

    struct NoMcp;
    impl SessionMcp for NoMcp {
        fn tools(&self, _: Option<&str>, _: &std::path::Path) -> Vec<Arc<dyn Tool>> {
            Vec::new()
        }
    }

    struct NoSkills;
    #[async_trait]
    impl SkillsListed for NoSkills {
        async fn any_for(&self, _: &std::path::Path) -> Result<bool, String> {
            Ok(false)
        }
    }

    struct Scopes;
    #[async_trait]
    impl McpScopes for Scopes {
        async fn open(&self, _: &str, _: &str, _: &std::path::Path) -> Result<(), ScopeReleased> {
            Ok(())
        }
        fn start(&self, _: &str, _: &str, _: &std::path::Path) -> Result<(), ScopeReleased> {
            Ok(())
        }
        fn release(&self, _: &str) {}
        async fn open_runtime(&self, _: &std::path::Path) -> Result<String, ScopeReleased> {
            Ok(String::new())
        }
    }

    struct Routes;
    impl LiveRoute for Routes {
        fn route(&self, _: &ThreadId) -> Route {
            Route::new()
        }
        fn adopt_held(&self, _: &ThreadId, _: &Route) {}
    }

    struct NoGates;
    #[async_trait]
    impl FeatureDenied for NoGates {
        async fn denied(&self, _: Option<&Header>) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
    }

    struct NoConnectors;
    #[async_trait]
    impl ConnectorPermissions for NoConnectors {
        fn needs_approval(&self, _: &str, _: &str) -> bool {
            false
        }
        fn disabled(&self, _: &str, _: &str) -> bool {
            false
        }
        fn project_disabled(&self, _: &ThreadId, _: &str) -> bool {
            false
        }
        async fn allow_always(&self, _: &str, _: &str) -> bool {
            false
        }
    }

    struct NoPrompt;
    #[async_trait]
    impl PromptRebuild for NoPrompt {
        async fn rebuild(&self, _: RebuildRequest) -> Result<SessionPrompt, String> {
            unreachable!("the thread has no prompt identity")
        }
    }

    struct NoHost;
    impl ToolSurfaceHost for NoHost {
        fn bridge_tools(&self) -> Vec<Value> {
            Vec::new()
        }
        fn mcp_server_instructions(&self, _: Option<&str>) -> Value {
            json!({})
        }
        fn defined(&self, _: &str) -> bool {
            true
        }
    }

    struct NoMessages;
    #[async_trait]
    impl ThreadMessages for NoMessages {
        async fn messages(&self, _: &ThreadId) -> Result<Vec<Value>, PortError> {
            Ok(Vec::new())
        }
    }

    struct NoneLive;
    impl LiveSessions for NoneLive {
        fn while_idle(&self, _session: &str, at: &mut dyn FnMut() -> bool) -> bool {
            at()
        }

        fn loaded(&self) -> Vec<String> {
            Vec::new()
        }
        fn header(&self, _: &str) -> Option<Row> {
            None
        }
        fn running(&self, _: &str) -> bool {
            false
        }
        fn has_live_work(&self, _: &str) -> bool {
            false
        }
        fn runtime_stage(&self, _: &str) -> Option<String> {
            None
        }
    }

    struct NoWorkflow;
    #[async_trait]
    impl WorkflowSurface for NoWorkflow {
        async fn target(&self, _: &Header, _: &str, _: Option<&str>) -> Result<WorkflowTarget, SurfaceFailure> {
            unreachable!("a conversation without an identity reads no workflow")
        }
        async fn live_denied_tools(&self, _: &Header, _: &Value) -> Result<Vec<String>, SurfaceFailure> {
            unreachable!("a conversation without an identity reads no workflow")
        }
        async fn internal_tools(&self, _: &Header) -> Result<Vec<Value>, SurfaceFailure> {
            unreachable!("a conversation without an identity reads no workflow")
        }
        async fn orchestration_instructions(&self, _: &str) -> Result<String, SurfaceFailure> {
            unreachable!("a conversation without an identity reads no workflow")
        }
    }

    fn host(header: Header) -> Arc<LeadSurfaceHost> {
        host_on(Arc::new(Store(Mutex::new(header))))
    }

    fn host_on(threads: Arc<dyn ThreadState>) -> Arc<LeadSurfaceHost> {
        let sources = SurfaceSources {
            mode: String::new(),
            pool: Vec::new(),
            agent_tools: HashSet::new(),
            mcp: Arc::new(NoMcp),
            scopes: Arc::new(Scopes),
            cwd: PathBuf::new(),
            routes: Arc::new(Routes),
            feature_denied: Arc::new(NoGates),
            connectors: Arc::new(NoConnectors),
            orchestration_mode: Arc::new(String::new),
            hidden_agent: Arc::new(|_| false),
            prompt: Arc::new(NoPrompt),
            skills: Arc::new(NoSkills),
            tool_host: Arc::new(NoHost),
            clock: Arc::new(Now),
            threads,
            messages: Arc::new(NoMessages),
            live: Arc::new(NoneLive),
            workflow: Arc::new(NoWorkflow),
            config_revision: Arc::new(|| 1),
            surface_generation: SurfaceGeneration::default(),
        };
        Arc::new(LeadSurfaceHost::new(sources).expect("an empty pool is accepted"))
    }

    fn held(host: &LeadSurfaceHost, thread: &ThreadId) -> (bool, bool) {
        let applied = host.applied.lock().expect("applied").contains_key(thread.as_str());
        let mcp = host.mcp_state.lock().expect("mcp_state").contains_key(thread.as_str());
        (applied, mcp)
    }

    #[tokio::test]
    async fn an_unloaded_thread_leaves_nothing_in_the_host_and_its_next_reconcile_runs_again() {
        let header = json!({ "tools": [] }).as_object().expect("header").clone();
        let host = host(header);
        let (gone, kept) = (ThreadId::from("gone"), ThreadId::from("kept"));
        for thread in [&gone, &kept] {
            host.reconcile(thread, true).await.expect("reconcile");
            assert_eq!(held(&host, thread), (true, true), "a reconcile leaves its keys");
        }

        host.unloaded(&gone);

        assert_eq!(held(&host, &gone), (false, false), "the unloaded thread keeps nothing");
        assert_eq!(held(&host, &kept), (true, true), "another thread keeps its keys");
        host.reconcile(&gone, true).await.expect("reconcile again");
        assert_eq!(held(&host, &gone), (true, true), "the next reconcile is not skipped as unchanged");
    }

    #[tokio::test]
    async fn a_reconcile_that_outlives_its_threads_unload_remembers_nothing_of_it() {
        let header = json!({ "tools": [] }).as_object().expect("header").clone();
        let (arrived_tx, arrived) = tokio::sync::oneshot::channel();
        let (go, go_rx) = tokio::sync::oneshot::channel();
        let host = host_on(Arc::new(HeldRead(Store(Mutex::new(header)), Mutex::new(Some((arrived_tx, go_rx))))));
        let thread = ThreadId::from("gone");
        let reconciling = {
            let (host, thread) = (host.clone(), thread.clone());
            tokio::spawn(async move { host.reconcile(&thread, true).await })
        };
        arrived.await.expect("the reconcile reads the header");

        host.unloaded(&thread);
        go.send(()).expect("the reconcile is waiting");
        reconciling.await.expect("the task").expect("reconcile");

        assert_eq!(held(&host, &thread), (false, false), "the reconcile of the load that is gone left nothing");
        assert!(host.working.lock().expect("working").is_empty(), "no work is counted once it ended");
        host.reconcile(&thread, true).await.expect("the next load reconciles");
        assert_eq!(held(&host, &thread), (true, true), "the next load's reconcile is remembered");
    }

    #[tokio::test]
    async fn a_seeded_thread_that_is_abandoned_leaves_nothing_in_the_host() {
        let header = json!({ "tools": [] }).as_object().expect("header").clone();
        let host = host(header);
        let (abandoned, kept) = (ThreadId::from("abandoned"), ThreadId::from("kept"));
        for thread in [&abandoned, &kept] {
            host.reconcile(thread, true).await.expect("reconcile");
        }

        host.abandon(&abandoned);

        assert_eq!(held(&host, &abandoned), (false, false), "the thread that was never created keeps nothing");
        assert_eq!(held(&host, &kept), (true, true), "another thread keeps its keys");
    }
}
