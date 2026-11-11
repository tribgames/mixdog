//! Replay of `native/core/fixtures/channels-call-ids` (Node `channel-restart.test.mjs` cases 95 and 110, and further
//! shapes): the `channel/call` request a client makes, through `ChannelService` (`DomainService::call`) and the real
//! `CallDispatch`, one test per recorded case.
//!
//! Mapping, as the manifest declares: Node's `/client/register` is the Rust connection (a client is its connection; the
//! register answer has no Rust counterpart), and `leadPid` is the connection's owner, so the clients one lead process
//! registers are one connection. Node's `callId` is the request's op id; a call without one is a request without op.
//! Compared per `/call` step: the answer, `{result}` ↔ `Reply::Value(result)` and `{error, code}` ↔ the `channel`
//! domain error's message and code. Compared per session: the calls the scripted handler received, in order, with
//! name, args and caller (`clientToken`/`leadPid` ↔ the connection's `connection:<id>` token; `cwd` is null in every
//! recorded caller and the Rust client carries none).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use chrono_tz::Tz;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::{ConnectionId, Method, OpId};
use mixdog_core_api::{CoreError, CoreRequest, DomainService, Reply};
use mixdog_protocol::Origin;
use mixdog_rt::testing::tokens;
use mixdog_store::state::CoreState;
use mixdog_testkit::Exact;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::admin::{AdminDeps, ChannelAdmin};
use super::call::{CallDispatch, ChannelCallHandler, ChannelClient};
use super::ports::{
    AgentRuntime, AutomationServices, ChannelSettings, ProbeError, ProbeResponse, PublicBase, WebhookPatch, WebhookProbe,
    WebhookSettings,
};
use super::running::RunningWork;
use super::runtime::ChannelRuntime;
use super::service::ChannelService;
use crate::bots::tests::FakeHost;
use crate::bots::{HomeScheduleRunner, RoutineRuntime, StoreRoutineRecords};
use crate::memory::replays::{assert_case_count, case, golden, same};
use crate::scheduler::{Scheduler, StateScheduleStore, SystemClock};
use crate::webhooks::{StateWebhookStore, WebhookConfig};

const SET: &str = "channels-call-ids";
const DEADLINE: Duration = Duration::from_secs(15);

/// The daemon behind `handleCall`, scripted as the recorder's: the n-th call answers `{call: n}`.
#[derive(Default)]
struct Handler {
    calls: Mutex<Vec<(String, Value, String)>>,
}

#[async_trait]
impl ChannelCallHandler for Handler {
    async fn call(&self, name: &str, args: &Value, client: &ChannelClient) -> Result<Value, String> {
        assert_eq!(client.lead_pid, None, "a core client carries no lead pid");
        let mut calls = self.calls.lock().unwrap();
        calls.push((name.to_owned(), args.clone(), client.token.clone()));
        Ok(json!({ "call": calls.len() }))
    }
}

// The admin surface `ChannelService` also serves; a `channel/call` reaches none of it.
struct Unused;

#[async_trait]
impl ChannelSettings for Unused {
    async fn webhook(&self) -> Result<WebhookSettings, String> {
        unreachable!("channel/call reads no webhook settings")
    }
    async fn update_webhook(&self, _patch: &WebhookPatch) -> Result<WebhookSettings, String> {
        unreachable!("channel/call writes no webhook settings")
    }
    async fn webhook_config(&self) -> Result<WebhookConfig, String> {
        unreachable!("channel/call reads no webhook config")
    }
}

#[async_trait]
impl PublicBase for Unused {
    async fn hook_public_base(&self) -> Result<Option<String>, String> {
        unreachable!("channel/call reads no public base")
    }
}

#[async_trait]
impl WebhookProbe for Unused {
    async fn post(&self, _url: &str, _headers: &[(String, String)], _body: String, _timeout: Duration) -> Result<ProbeResponse, ProbeError> {
        unreachable!("channel/call probes no webhook")
    }
}

#[async_trait]
impl AutomationServices for Unused {
    async fn sync(&self, _reload: bool) -> Result<(), String> {
        unreachable!("channel/call syncs no webhook runtime")
    }
    async fn stop(&self) {}
}

#[async_trait]
impl AgentRuntime for Unused {
    async fn init_providers(&self) -> Result<(), String> {
        unreachable!("channel/call starts no providers")
    }
}

struct Rig {
    service: ChannelService,
    handler: Arc<Handler>,
    _dir: tempfile::TempDir,
}

fn rig() -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let (state, _) = CoreState::open(tokens().sqlite_writer_thread, tokens().interactive_io, &dir.path().join("core.sqlite")).unwrap();
    let schedules = Arc::new(StateScheduleStore::new(state.clone(), Arc::new(SystemClock)));
    let webhooks = Arc::new(StateWebhookStore::new(state, Arc::new(SystemClock)));
    let records = Arc::new(StoreRoutineRecords::new(schedules.clone(), webhooks.clone()));
    let routines = RoutineRuntime::new(Arc::new(FakeHost::default()), records, Arc::new(SystemClock), Tz::UTC);
    let work = RunningWork::new();
    let scheduler =
        Scheduler::new(schedules.clone(), Arc::new(HomeScheduleRunner::new(routines.clone())), Arc::new(SystemClock), work.clone(), Tz::UTC, Vec::new());
    let runtime = ChannelRuntime::new(scheduler, schedules.clone(), Arc::new(Unused), Arc::new(Unused));
    let admin = ChannelAdmin::new(AdminDeps {
        schedules,
        webhooks,
        routines,
        runtime,
        settings: Arc::new(Unused),
        base: Arc::new(Unused),
        probe: Arc::new(Unused),
        clock: Arc::new(SystemClock),
        local_tz: Tz::UTC,
        channel_start_disabled: true,
        close_requested: CancellationToken::new(),
    });
    let handler = Arc::new(Handler::default());
    let calls = CallDispatch::new(handler.clone(), work);
    Rig { service: ChannelService::new(admin, calls), handler, _dir: dir }
}

fn body(message: &Exact, what: &str) -> Value {
    let text = message.get("body").as_str();
    serde_json::from_str(text).unwrap_or_else(|e| panic!("{what}: the recorded body is not JSON: {e}"))
}

/// Drives one recorded session: its registers make connections, its calls go to the service.
async fn replay(session: &Exact) {
    let label = session.get("label").as_str();
    let rig = rig();
    let mut owners: HashMap<u64, ConnectionId> = HashMap::new();
    let mut tokens_to: HashMap<String, ConnectionId> = HashMap::new();
    for step in session.get("wire").as_array() {
        let name = format!("{label}: {}", step.get("step").as_str());
        let request = step.get("request");
        let head = request.get("head").as_array()[0].as_str();
        let sent = body(request, &name);
        let answer = body(step.get("response"), &name);
        assert_eq!(step.get("response").get("head").as_array()[0].as_str(), "HTTP/1.1 200 OK", "{name}: Node's status");
        match head {
            "POST /client/register HTTP/1.1" => {
                let pid = sent["leadPid"].as_u64().unwrap_or_else(|| panic!("{name}: a lead pid"));
                let next = ConnectionId(owners.len() as u64 + 1);
                let connection = *owners.entry(pid).or_insert(next);
                let token = answer["token"].as_str().unwrap_or_else(|| panic!("{name}: a client token")).to_owned();
                tokens_to.insert(token, connection);
            }
            "POST /call HTTP/1.1" => {
                let token = sent["token"].as_str().unwrap_or_else(|| panic!("{name}: a client token"));
                let connection = *tokens_to.get(token).unwrap_or_else(|| panic!("{name}: {token} was registered"));
                let mut params = serde_json::Map::new();
                params.insert("name".into(), sent["name"].clone());
                params.insert("args".into(), sent["args"].clone());
                let req = CoreRequest {
                    method: Method("channel/call"),
                    params: Value::Object(params),
                    op: sent.get("callId").map(|id| OpId::from(id.as_str().unwrap_or_else(|| panic!("{name}: a string callId")))),
                    ctx: CallContext::connection(connection, Origin::Local, CancellationToken::new()),
                };
                let reply = tokio::time::timeout(DEADLINE, rig.service.call(req))
                    .await
                    .unwrap_or_else(|_| panic!("{name}: no answer within {DEADLINE:?}"));
                let actual = match reply {
                    Ok(Reply::Value(value)) => json!({ "result": value }),
                    Ok(Reply::Subscribe(_)) => panic!("{name}: channel/call never subscribes"),
                    Err(CoreError::DomainError { domain, code, message, detail }) => {
                        assert_eq!(&*domain, "channel","{name}: the error's domain");
                        assert!(detail.is_none(), "{name}: the error carries no detail");
                        json!({ "error": message.map(|m| m.to_string()), "code": code.map(|c| c.to_string()) })
                    }
                    Err(other) => panic!("{name}: an error Node never answers: {other:?}"),
                };
                same(&format!("{name}: the answer"), &Exact::plain(&answer), &Exact::plain(&actual));
            }
            other => panic!("{name}: an unrecorded request {other}"),
        }
    }
    let expected = session.get("handleCalls").as_array();
    let received = rig.handler.calls.lock().unwrap().clone();
    assert_eq!(received.len(), expected.len(), "{label}: the calls the handler received: {received:?}");
    for (index, (call, (name, args, token))) in expected.iter().zip(received).enumerate() {
        let caller = call.get("caller");
        assert!(matches!(caller.get("cwd"), Exact::Null), "{label}: call {index}: a recorded cwd");
        let by_token = tokens_to[caller.get("clientToken").as_str()];
        let by_pid = owners[&(caller.get("leadPid").as_f64() as u64)];
        assert_eq!(by_token, by_pid, "{label}: call {index}: the recorded client belongs to its lead pid");
        same(&format!("{label}: call {index}: name"), call.get("name"), &Exact::String(name));
        same(&format!("{label}: call {index}: args"), call.get("args"), &Exact::plain(&args));
        assert_eq!(token, format!("connection:{by_token}"), "{label}: call {index}: the caller");
    }
}

#[tokio::test]
async fn channel_retries_reuse_results_only_for_the_same_payload_test_line_95() {
    let g = golden(SET);
    assert_case_count(&g, 3);
    replay(case(&g, 0, "channel retries reuse results only for the same payload (test line 95)").get("session")).await;
}

#[tokio::test]
async fn channel_call_ids_belong_to_the_calling_process_not_the_addressed_session_test_line_110() {
    let g = golden(SET);
    replay(case(&g, 1, "channel call ids belong to the calling process, not the addressed session (test line 110)").get("session")).await;
}

#[tokio::test]
async fn further_shapes_beyond_the_test_file() {
    let g = golden(SET);
    let sessions = case(&g, 2, "further shapes (beyond the test file)").get("sessions").as_array();
    assert_eq!(sessions.len(), 2, "recorded sessions");
    for session in sessions {
        replay(session).await;
    }
}
