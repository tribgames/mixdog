//! Owner: s4-core-events-service
//! The daemon service of the browser engine's host lane: what the desktop pushes (`host/browser/events`, `host/browser/page/facts`,
//! `host/browser/userInput`) goes to the engine's [`EngineSink`], and the end of the desktop's claim goes there as
//! [`EngineSink::host_gone`]. Only the connection that holds the host claim is believed: a notification from any other connection
//! is dropped, so a client that never claimed the host role cannot move a page's ledgers or hold it for the person.
//!
//! The claim is read from the connection table through [`ClaimantProbe`] when a notification arrives; the connection a notification
//! last came from is remembered, so its end is known even after the table has forgotten its claim. A different claimant's first
//! notification ends the earlier one's pages first (a command that began under one desktop's claim never finishes under another's).
//!
//! `test/browserEngine/run` (cargo feature `test-hooks`, refused in a release build by build.rs; registered only when the daemon
//! starts with `MIXDOGD_TEST_HOOKS=1`, read once by [`BrowserEngineService::with_test_hook`]) runs one `browser` or
//! `browser_devtools` call of a thread through the engine without a model turn. It is refused to a connection that is not on this
//! machine (Ssh, Relay) and to a window's socket.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_app_protocol::v2::browser_engine::HostBrowserEventsParams;
use mixdog_app_protocol::v2::browser_engine::HostBrowserPageFactsParams;
use mixdog_app_protocol::v2::browser_engine::HostBrowserUserInputParams;
use mixdog_browser_engine::EngineSink;
use mixdog_core_api::CoreError;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use serde_json::Value;

use crate::connection_close::ConnectionOwner;

const EVENTS: &str = "host/browser/events";
const FACTS: &str = "host/browser/page/facts";
const USER_INPUT: &str = "host/browser/userInput";
#[cfg(feature = "test-hooks")]
const TEST_RUN: &str = "test/browserEngine/run";

const NOTIFICATIONS: &[&str] = &[EVENTS, FACTS, USER_INPUT];
#[cfg(feature = "test-hooks")]
const NOTIFICATIONS_AND_HOOK: &[&str] = &[EVENTS, FACTS, USER_INPUT, TEST_RUN];

/// Whether a connection is the one that holds the host claim now (the server's claim table, `Outgoing::is_host_claimant`).
pub trait ClaimantProbe: Send + Sync {
    fn is_claimant(&self, connection: ConnectionId) -> bool;
}

/// Runs one browser tool call of a thread through the engine, outside a model turn (the engine's `run` with a turn-less caller):
/// the answer is the tool's reply, a failure of the call is `is_error`.
#[cfg(feature = "test-hooks")]
#[async_trait]
pub trait BrowserToolRunner: Send + Sync {
    async fn run(
        &self,
        thread: mixdog_protocol::ThreadId,
        tool: mixdog_app_protocol::v2::browser_engine::BrowserTestTool,
        args: Value,
        cancel: tokio_util::sync::CancellationToken,
    ) -> mixdog_app_protocol::v2::browser_engine::BrowserEngineTestRunResult;
}

pub struct BrowserEngineService {
    sink: Arc<dyn EngineSink>,
    claimants: Arc<dyn ClaimantProbe>,
    /// The connection whose notifications the sink holds now.
    current: Mutex<Option<ConnectionId>>,
    #[cfg(feature = "test-hooks")]
    hook: Option<Arc<dyn BrowserToolRunner>>,
}

impl BrowserEngineService {
    pub fn new(sink: Arc<dyn EngineSink>, claimants: Arc<dyn ClaimantProbe>) -> Self {
        Self {
            sink,
            claimants,
            current: Mutex::new(None),
            #[cfg(feature = "test-hooks")]
            hook: None,
        }
    }

    /// The service with `test/browserEngine/run` when `MIXDOGD_TEST_HOOKS` is `1` in `env`, else unchanged (the method is then
    /// unregistered, answered as unknown). The environment is read here, once, at start.
    #[cfg(feature = "test-hooks")]
    #[must_use]
    pub fn with_test_hook(mut self, env: &dyn Fn(&str) -> Option<String>, runner: Arc<dyn BrowserToolRunner>) -> Self {
        if crate::dev_computer::test_hooks_enabled(env) {
            self.hook = Some(runner);
        }
        self
    }

    fn current(&self) -> std::sync::MutexGuard<'_, Option<ConnectionId>> {
        self.current.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Records `from` as the connection the sink is fed by; the sink is told the earlier one's claim ended when another took over.
    fn adopt(&self, from: ConnectionId) {
        let superseded = self.current().replace(from).is_some_and(|held| held != from);
        if superseded {
            self.sink.host_gone();
        }
    }
}

#[async_trait]
impl DomainService for BrowserEngineService {
    fn methods(&self) -> &'static [&'static str] {
        #[cfg(feature = "test-hooks")]
        if self.hook.is_some() {
            return NOTIFICATIONS_AND_HOOK;
        }
        NOTIFICATIONS
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        #[cfg(feature = "test-hooks")]
        if req.method.as_str() == TEST_RUN {
            return self.run_test(req).await;
        }
        Err(CoreError::InvalidParams { path: "method".into(), expected: format!("one of this service's methods, not {}", req.method.as_str()).into() })
    }

    fn notify(&self, method: Method, params: Value, from: ConnectionId) -> Admit {
        if !self.claimants.is_claimant(from) {
            return Admit::Accepted;
        }
        match method.as_str() {
            EVENTS => {
                if let Ok(events) = serde_json::from_value::<HostBrowserEventsParams>(params) {
                    self.adopt(from);
                    self.sink.events(events);
                }
            }
            FACTS => {
                if let Ok(facts) = serde_json::from_value::<HostBrowserPageFactsParams>(params) {
                    self.adopt(from);
                    self.sink.facts(facts);
                }
            }
            USER_INPUT => {
                if let Ok(input) = serde_json::from_value::<HostBrowserUserInputParams>(params) {
                    self.adopt(from);
                    self.sink.user_input(input);
                }
            }
            _ => {}
        }
        Admit::Accepted
    }
}

#[cfg(feature = "test-hooks")]
impl BrowserEngineService {
    async fn run_test(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        use mixdog_app_protocol::v2::browser_engine::BrowserEngineTestRunParams;
        use mixdog_core_base::support::decode;

        if req.ctx.origin != mixdog_protocol::Origin::Local || req.ctx.window.is_some() {
            return Err(CoreError::PermissionDenied { method: TEST_RUN.into(), origin: req.ctx.origin });
        }
        let Some(runner) = self.hook.clone() else {
            return Err(CoreError::InvalidParams { path: "method".into(), expected: "a method this service serves".into() });
        };
        let params: BrowserEngineTestRunParams = decode(&req)?;
        let result = runner.run(params.thread_id, params.tool, params.args, req.ctx.cancel.child_token()).await;
        let value = serde_json::to_value(result).map_err(|error| CoreError::InvalidParams { path: "result".into(), expected: error.to_string().into() })?;
        Ok(Reply::Value(value))
    }
}

impl ConnectionOwner for BrowserEngineService {
    /// The desktop that pushed the pages' state is gone: every page it held is gone with its claim.
    fn connection_closed(&self, connection: ConnectionId) {
        let ended = {
            let mut current = self.current();
            if *current == Some(connection) {
                *current = None;
                true
            } else {
                false
            }
        };
        if ended {
            self.sink.host_gone();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashSet;

    #[derive(Default)]
    struct Recorded(Mutex<Vec<String>>);

    impl Recorded {
        fn take(&self) -> Vec<String> {
            std::mem::take(&mut *self.0.lock().unwrap())
        }
    }

    impl EngineSink for Recorded {
        fn events(&self, params: HostBrowserEventsParams) {
            self.0.lock().unwrap().push(format!("events {} {}", params.page_id, params.seq));
        }
        fn facts(&self, params: HostBrowserPageFactsParams) {
            self.0.lock().unwrap().push(format!("facts {} {}", params.page_id, params.seq));
        }
        fn user_input(&self, params: HostBrowserUserInputParams) {
            self.0.lock().unwrap().push(format!("input {} {}", params.page_id, params.held));
        }
        fn host_gone(&self) {
            self.0.lock().unwrap().push("gone".into());
        }
    }

    struct Claimants(Mutex<HashSet<u64>>);

    impl ClaimantProbe for Claimants {
        fn is_claimant(&self, connection: ConnectionId) -> bool {
            self.0.lock().unwrap().contains(&connection.0)
        }
    }

    fn service(claimants: &[u64]) -> (BrowserEngineService, Arc<Recorded>, Arc<Claimants>) {
        let sink = Arc::new(Recorded::default());
        let probe = Arc::new(Claimants(Mutex::new(claimants.iter().copied().collect())));
        (BrowserEngineService::new(sink.clone(), probe.clone()), sink, probe)
    }

    fn events(page: &str, seq: u64) -> Value {
        json!({"pageId": page, "seq": seq, "events": []})
    }

    fn input(page: &str) -> Value {
        json!({"pageId": page, "seq": 1, "held": true, "reason": "pointer"})
    }

    fn send(service: &BrowserEngineService, method: &'static str, params: Value, from: u64) {
        let admit = service.notify(Method(method), params, ConnectionId(from));
        assert!(matches!(admit, Admit::Accepted));
    }

    #[test]
    fn notifications_from_a_connection_that_is_not_the_claimant_are_dropped() {
        let (service, sink, _) = service(&[1]);
        send(&service, EVENTS, events("p1", 1), 2);
        send(&service, USER_INPUT, input("p1"), 2);
        assert!(sink.take().is_empty());
        send(&service, EVENTS, events("p1", 1), 1);
        send(&service, USER_INPUT, input("p1"), 1);
        assert_eq!(sink.take(), ["events p1 1", "input p1 true"]);
    }

    #[test]
    fn a_non_claimant_never_becomes_the_connection_the_sink_is_fed_by() {
        let (service, sink, _) = service(&[1]);
        send(&service, EVENTS, events("p1", 1), 2);
        service.connection_closed(ConnectionId(2));
        assert!(sink.take().is_empty());
    }

    #[test]
    fn a_malformed_notification_of_the_claimant_reaches_nothing() {
        let (service, sink, _) = service(&[1]);
        send(&service, EVENTS, json!({"pageId": 3}), 1);
        send(&service, FACTS, json!({"pageId": "p1", "seq": 2}), 1);
        send(&service, USER_INPUT, Value::Null, 1);
        assert!(sink.take().is_empty());
        service.connection_closed(ConnectionId(1));
        assert!(sink.take().is_empty());
    }

    #[test]
    fn the_end_of_the_claimants_connection_tells_the_sink_once() {
        let (service, sink, probe) = service(&[1]);
        send(&service, EVENTS, events("p1", 1), 1);
        // The claim table forgets the claim before the connection's owners are told.
        probe.0.lock().unwrap().clear();
        service.connection_closed(ConnectionId(1));
        service.connection_closed(ConnectionId(1));
        assert_eq!(sink.take(), ["events p1 1", "gone"]);
    }

    #[test]
    fn the_end_of_another_connection_leaves_the_claim_alone() {
        let (service, sink, _) = service(&[1]);
        send(&service, EVENTS, events("p1", 1), 1);
        service.connection_closed(ConnectionId(2));
        assert_eq!(sink.take(), ["events p1 1"]);
    }

    #[test]
    fn a_newer_claimant_ends_the_earlier_ones_pages_before_its_first_word() {
        let (service, sink, probe) = service(&[1]);
        send(&service, EVENTS, events("p1", 1), 1);
        probe.0.lock().unwrap().insert(2);
        send(&service, EVENTS, events("p2", 1), 2);
        assert_eq!(sink.take(), ["events p1 1", "gone", "events p2 1"]);
        service.connection_closed(ConnectionId(1));
        assert!(sink.take().is_empty());
    }

    #[test]
    fn the_service_lists_its_three_notifications_and_no_hook_by_default() {
        let (service, _, _) = service(&[]);
        assert_eq!(service.methods(), [EVENTS, FACTS, USER_INPUT]);
    }

    #[cfg(feature = "test-hooks")]
    mod hook {
        use super::*;
        use mixdog_app_protocol::v2::browser_engine::BrowserEngineTestRunResult;
        use mixdog_app_protocol::v2::browser_engine::BrowserTestTool;
        use mixdog_core_api::call::CallContext;
        use mixdog_core_api::call::WindowRole;
        use mixdog_core_api::call::WindowScope;
        use mixdog_protocol::Origin;
        use mixdog_protocol::ThreadId;
        use tokio_util::sync::CancellationToken;

        struct Echo;

        #[async_trait]
        impl BrowserToolRunner for Echo {
            async fn run(&self, thread: ThreadId, tool: BrowserTestTool, args: Value, _cancel: CancellationToken) -> BrowserEngineTestRunResult {
                BrowserEngineTestRunResult { text: format!("{thread:?} {tool:?} {args}"), image: None, is_error: false, outcome: None }
            }
        }

        fn env(value: Option<&'static str>) -> impl Fn(&str) -> Option<String> {
            move |name| if name == "MIXDOGD_TEST_HOOKS" { value.map(str::to_owned) } else { None }
        }

        fn request(origin: Origin, window: bool) -> CoreRequest {
            let mut ctx = CallContext::connection(ConnectionId(9), origin, CancellationToken::new());
            if window {
                ctx = ctx.with_window(Some(WindowScope { id: "w1".into(), role: WindowRole::Main }));
            }
            CoreRequest { method: Method(TEST_RUN), params: json!({"threadId": "t1", "tool": "browser", "args": {"action": "tabs"}}), op: None, ctx }
        }

        #[test]
        fn the_hook_is_absent_unless_the_environment_turns_it_on_at_start() {
            for value in [None, Some("0"), Some("true"), Some("")] {
                let (service, _, _) = service(&[]);
                let service = service.with_test_hook(&env(value), Arc::new(Echo));
                assert!(!service.methods().contains(&TEST_RUN), "{value:?}");
            }
            let (service, _, _) = service(&[]);
            let service = service.with_test_hook(&env(Some("1")), Arc::new(Echo));
            assert_eq!(service.methods(), [EVENTS, FACTS, USER_INPUT, TEST_RUN]);
        }

        #[tokio::test]
        async fn the_hook_runs_the_tool_for_a_local_connection_and_refuses_the_rest() {
            let (service, _, _) = service(&[]);
            let service = service.with_test_hook(&env(Some("1")), Arc::new(Echo));
            let Reply::Value(answer) = service.call(request(Origin::Local, false)).await.expect("a local call runs") else {
                panic!("a value reply");
            };
            assert_eq!(answer["isError"], json!(false));
            assert!(answer["text"].as_str().unwrap().contains("Browser"));
            for (origin, window) in [(Origin::Ssh, false), (Origin::Relay, false), (Origin::Local, true)] {
                let refused = service.call(request(origin, window)).await;
                assert!(matches!(refused, Err(CoreError::PermissionDenied { .. })), "{origin:?} window={window}");
            }
        }
    }
}
