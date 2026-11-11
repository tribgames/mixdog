//! Node's recording `fixtures/session-route-state/recording.json` (`record-session-route-state.mjs`, test file
//! `src/session-runtime/session-lifecycle.test.mjs`), read when the test runs and decoded with [`Exact`]: each case's
//! recorded inputs reach the core the way a client sends them: lines 27, 49, 74, 149 and 229 as `route/set`
//! (`RouteSetService` over the real `RouteService`, `SessionRoutes` and the real thread store, the real config file and
//! `refresh_route_fields`; the model row is the recording's, the catalog seam, and the catalog's cached windows are its
//! roster files), compared whole: the client's reply, the stored session record and the stored config document; the
//! `inheritFrom` cases (306, 372) through the thread protocol (`thread/inheritancePreflight`, `thread/fork`) on a real
//! session directory, compared at what a client observes: the preflight verdict, the carry's answer and the heir's
//! conversation; the compactor calls Node's mocks counted are not observable. Lines 10, 104 and 255 call the route
//! functions, each declared in the case table with the reason no client call carries the recorded step.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_agent::compact::estimate::MediaMeter;
use mixdog_ai::catalog::{CatalogService, CatalogSnapshot, ModelsDevSource};
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::service::admin_route::{
    Obj, ContextState, refresh_route_fields, resolve_route_context_state, route_fast_key, save_model_settings,
    selection_fast_capable, window_meta_of,
};
use mixdog_ai::transport::http::{HttpResponse, HttpSend};
use mixdog_core_api::domain::provider::{DeliveryState, ErrorKind, ProviderError, ToolDefinition, WireRequest};
use mixdog_core_api::ids::ThreadId;
use mixdog_core_run::run_host::session_context_meta::ContextMeta;
use mixdog_core_session::session::inheritance::{InheritTarget, InheritanceFit, inheritance_fit};
use mixdog_core_base::support::OpScopes;
use mixdog_core_base::support::testing::{request, scopes, value, with_op};
use mixdog_core_config::config::Config;
use mixdog_core_domains::domains::ai_admin::agent_route_service::AgentRouteSetter;
use mixdog_core_domains::domains::ai_admin::chain::{CatalogRouteContext, RouteFacts};
use mixdog_core_domains::domains::ai_admin::model_list::ModelListService;
use mixdog_core_domains::domains::ai_admin::route_service::{LiveControls, RouteService};
use mixdog_core_domains::domains::ai_admin::route_set_service::{ROUTE_SET, RouteSetService};
use mixdog_core_ports::ports::domain_sessions::AgentRoutePublisher;
use mixdog_core_ports::ports::route::{LiveRoute, SessionRoutes};
use mixdog_core_ports::ports::route_write::RouteWriter;
use mixdog_core_session::session::route_session::SessionRouteAdapter;
use mixdog_core_session::session::thread_state::SessionThreads;
use mixdog_store::schema::record::Header;
use mixdog_tools::orch::util::PortError;
use mixdog_testkit::exact::Exact;
use serde_json::{Value, json};

use super::context_world::tests::{Fixed, Quiet, WindowFacts};
use super::inheritance_fit::tests::{TextOnly, seams};
use super::inheritance_fit::{HostInheritanceFit, MeasuredThreads, RouteWindows};

fn recording() -> Exact {
    Exact::load(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/session-route-state/recording.json"))
}

fn case<'a>(recording: &'a Exact, line: f64) -> &'a Exact {
    recording.get("cases").as_array().iter().find(|case| case.get("testLine").as_f64() == line).unwrap_or_else(|| panic!("no case at line {line}"))
}

fn plain(value: &Exact) -> Value {
    value.to_plain().unwrap_or_else(|error| panic!("recorded input: {error}"))
}

fn obj(value: &Exact) -> Obj {
    plain(value).as_object().cloned().expect("an object")
}

struct Offline;

#[async_trait]
impl HttpSend for Offline {
    async fn send(&self, _: WireRequest, _: mixdog_ai::transport::Exchange) -> Result<HttpResponse, ProviderError> {
        Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
    }
}

/// The catalog whose `fastCapableFor` the route functions ask; the recorded cases name no catalog row.
async fn catalog(dir: &std::path::Path) -> CatalogService {
    let tokens = mixdog_rt::testing::tokens();
    let metadata = ModelsDevSource::new(Arc::new(Offline), dir.to_path_buf(), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    CatalogService::cold_start(CatalogSnapshot::default(), Vec::new(), metadata).await
}

/// `resolveRouteContextState`'s object: the three fields always (undefined when the window is unknown), `contextTokens`
/// only for an exact token selection.
fn context_state(state: ContextState) -> Exact {
    let field = |value: Option<f64>| value.map_or(Exact::Undefined, Exact::from);
    let mut fields = vec![
        ("contextPercent".to_owned(), field(state.context_percent)),
        ("contextDefaultPercent".to_owned(), field(state.context_default_percent)),
        ("selectedContextWindow".to_owned(), field(state.selected_context_window)),
    ];
    if let Some(tokens) = state.context_tokens {
        fields.push(("contextTokens".to_owned(), Exact::from(tokens)));
    }
    Exact::Object(fields)
}

/// The catalog seam of `route/set` (the port the daemon backs with the provider catalog): the model row is the
/// recording's own; the Fast capability is the real catalog's; every provider is known unless the case names the one that
/// is (`makeResolveRoute`'s predicate).
struct Facts {
    meta: Value,
    catalog: Arc<CatalogService>,
    known: Option<String>,
}

#[async_trait]
impl RouteFacts for Facts {
    fn is_known(&self, provider: &str, _: &Obj) -> bool {
        self.known.as_deref().is_none_or(|known| known == provider)
    }

    async fn ensure_ready(&self, _: &Obj, _: &str) -> Result<(), String> {
        Ok(())
    }

    fn model_meta(&self, _: &str, _: &str) -> Value {
        self.meta.clone()
    }

    fn window_meta(&self, provider: &str, model: &str, meta: &Value) -> Option<Value> {
        let cached = self.catalog.cached_windows(provider, model).and_then(|windows| serde_json::to_value(windows).ok());
        window_meta_of(Some(meta), cached.as_ref()).cloned()
    }

    fn catalog_knows(&self, _: &str, _: &str) -> bool {
        true
    }

    fn fast_capable(&self, provider: &str, meta: &Value, effort: Option<&str>, params: &Value) -> bool {
        self.catalog.fast_capable(provider, meta, effort, params)
    }

    fn ultrafast_capable(&self, provider: &str, meta: &Value) -> bool {
        self.catalog.ultrafast_capable(provider, meta)
    }
}

/// The thread's live route cell with `LiveRouteWriter`'s refresh (`refresh_route_fields` over the config and the row), minus
/// the provider preparation the replay has no provider for.
struct Cell {
    route: Mutex<Obj>,
    config: Config,
    catalog: Arc<CatalogService>,
}

#[async_trait]
impl RouteWriter for Cell {
    fn route(&self, _: &ThreadId) -> Obj {
        self.route.lock().unwrap().clone()
    }

    fn set_route_state(&self, _: &ThreadId, route: Obj) {
        *self.route.lock().unwrap() = route;
    }

    fn generation(&self, _: &ThreadId) -> u64 {
        0
    }

    async fn refresh_route_effort(&self, thread: &ThreadId, meta: Option<Value>, _: bool, _: Option<u64>) -> Result<Option<Obj>, PortError> {
        let target = RouteWriter::route(self, thread);
        let config = self.config.agent();
        let text = |key: &str| target.get(key).and_then(Value::as_str).unwrap_or("").trim().to_owned();
        let (provider, model) = (text("provider"), text("model"));
        let meta = meta.unwrap_or_else(|| self.catalog.model_meta_in(&provider, &model, None));
        let fast = |provider: &str, meta: &Value, effort: Option<&str>, params: &Value| self.catalog.fast_capable(provider, meta, effort, params);
        let route = refresh_route_fields(
            &config,
            &target,
            Some(&meta),
            &provider,
            &fast,
            &|provider, model| self.catalog.cached_windows(provider, model).and_then(|w| serde_json::to_value(w).ok()),
        );
        self.set_route_state(thread, route.clone());
        Ok(Some(route))
    }

    fn refresh_statusline_usage(&self, _: &ThreadId, _: &Obj) {}
}

impl LiveRoute for Cell {
    fn route(&self, thread: &ThreadId) -> Obj {
        RouteWriter::route(self, thread)
    }

    fn adopt_held(&self, _: &ThreadId, _: &Obj) {
        unreachable!("route/set adopts no pick held by an earlier process")
    }
}

struct NoControls;

impl LiveControls for NoControls {
    fn sync_live(&self, _: &mut dyn FnMut(&ThreadId)) {}
}

struct NoPublish;

#[async_trait]
impl AgentRoutePublisher for NoPublish {
    async fn publish(&self, _: &str, _: &Value) {}
}

/// What a case sets up: the config file's `agent` document, the model row the catalog holds and the one known
/// provider, when the case names it.
struct Setup {
    config: Value,
    meta: Value,
    known: Option<String>,
    /// The provider catalog's cached roster rows, `provider/model` -> windows (`provider-catalog-cache`'s roster files).
    windows: Value,
    /// The session record the client's session holds before the call (Node's `store.loadSession`), its id the thread's.
    session: Value,
}

/// One client of `route/set` over the real route service, the real config file and the real thread store.
struct Client {
    service: RouteSetService,
    thread: ThreadId,
    directory: Arc<mixdog_core_session::session::SessionDirectory>,
    config_file: std::path::PathBuf,
    _dirs: (tempfile::TempDir, tempfile::TempDir),
    _rig: mixdog_core_session::session::testing::Rig,
}

/// The op store every `route/set` of a test records its op in; each call carries its own op id.
struct Ops {
    scopes: OpScopes,
    _state: tempfile::TempDir,
}

async fn ops() -> Ops {
    let state = tempfile::tempdir().unwrap();
    Ops { scopes: scopes(state.path(), "route").await, _state: state }
}

impl Client {
    async fn new(setup: Setup, ops: &Ops) -> Client {
        let dir = tempfile::tempdir().unwrap();
        let agents = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let lanes = mixdog_core_config::config::ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let path = dir.path().join("mixdog-config.json");
        std::fs::write(&path, serde_json::to_vec(&json!({ "agent": setup.config })).unwrap()).unwrap();
        let (config, _) = Config::open(&path, Arc::new(mixdog_core_api::mock::MockStatePublisher::default()), lanes).await.unwrap();
        let mut rosters: std::collections::BTreeMap<String, Vec<Value>> = Default::default();
        for (key, windows) in setup.windows.as_object().into_iter().flatten() {
            let (provider, model) = key.split_once('/').expect("provider/model");
            let mut row = windows.as_object().cloned().expect("windows");
            row.insert("id".into(), json!(model));
            rosters.entry(format!("{provider}-models.json")).or_default().push(Value::Object(row));
        }
        for (file, rows) in rosters {
            std::fs::write(dir.path().join(file), serde_json::to_vec(&json!({ "models": rows })).unwrap()).unwrap();
        }
        let catalog = Arc::new(catalog(dir.path()).await.with_rosters(dir.path().to_path_buf()));
        let facts = Arc::new(Facts { meta: setup.meta, catalog: catalog.clone(), known: setup.known });
        let cell = Arc::new(Cell { route: Mutex::default(), config: config.clone(), catalog: catalog.clone() });
        let models = Arc::new(ModelListService {
            catalog,
            config: config.clone(),
            primary_provider: Arc::new(String::new),
            unsupported: Arc::new(mixdog_ai::service::effort_configuration::UnsupportedEfforts::default()),
            host: None,
        });
        let rig = mixdog_core_session::session::testing::Rig::new();
        let directory = Arc::new(mixdog_core_session::session::SessionDirectory::new(Arc::new(rig.deps_parts(rig.store.clone()))));
        let threads = Arc::new(SessionThreads::new(directory.clone()));
        let change = Arc::new(crate::run_host::route_change::RunHostRouteChange::new(Arc::new(WindowFacts), Arc::new(Fixed)));
        let adapter = Arc::new(SessionRouteAdapter::new(directory.clone(), threads.clone(), change, Arc::new(Quiet), Arc::new(Quiet), Arc::new(Quiet), rig.clock.clone()));
        let follow = Arc::new(SessionRoutes::new(threads.clone(), threads, adapter, cell.clone()));
        let record = setup.session.as_object().cloned().expect("the session record");
        let thread = ThreadId::from(record["id"].as_str().expect("the session id").to_owned());
        directory.create_with_id(thread.clone(), record, json!({})).await.expect("the session record is created");
        let routes = RouteService { config: config.clone(), facts: facts.clone(), writer: cell, session: follow, models, controls: Arc::new(NoControls) };
        let agent_routes = AgentRouteSetter {
            routes: mixdog_core_config::config::AgentRoutes::new(config.clone(), agents.path()),
            config: config.clone(),
            context: Arc::new(CatalogRouteContext { config: config.clone(), facts: facts.clone() }),
            publisher: Arc::new(NoPublish),
            hidden: mixdog_core_config::config::hidden_agents::hidden_agents(),
        };
        let service = RouteSetService { routes: Arc::new(routes), agents: Arc::new(agent_routes), ops: ops.scopes.clone() };
        Client { service, thread, directory, config_file: path, _dirs: (dir, agents), _rig: rig }
    }

    /// `route/set` of the client's thread with `route`, op `n`: the live route it answers.
    async fn set(&self, route: &Value, n: u64) -> Value {
        let params = with_op(json!({ "threadId": self.thread.as_str(), "route": route }), n);
        value(&self.service, request(ROUTE_SET, params, Some(n))).await.expect("route/set")
    }

    /// The session record the store holds, as a client reads it.
    async fn stored_session(&self) -> Value {
        Value::Object(self.directory.stored_header(&self.thread).await.expect("the session record"))
    }

    /// The config document the file holds (its `agent` section).
    fn stored_config(&self) -> Value {
        let file: Value = serde_json::from_slice(&std::fs::read(&self.config_file).unwrap()).unwrap();
        file["agent"].clone()
    }
}

/// Line 10: the Fast setting saved for a route (`saveModelSettings` with `selectionFastCapable`) over a placeholder, a
/// row advertising the priority tier and a row without it. Direct: a client's `route/set` hands `saveModelSettings` the
/// route `resolveRoute` built (`modelParameters: {}` always present, saved as `{}`: `model-capabilities.mjs:171`), never the
/// bare `{provider, model, effort, fast}` recorded here (see the case table).
#[tokio::test]
async fn a_placeholder_row_keeps_the_saved_fast_setting() {
    let recording = recording();
    let case = case(&recording, 10.0);
    let input = case.get("input");
    let dir = tempfile::tempdir().unwrap();
    let catalog = catalog(dir.path()).await;
    let route = obj(input.get("route"));
    let provider = route["provider"].as_str().unwrap().to_owned();
    let key = route_fast_key(route.get("provider"), route.get("model"));
    let got: Vec<Exact> = input
        .get("metas")
        .as_array()
        .iter()
        .map(|meta| {
            let meta = plain(meta);
            let fast_capable = selection_fast_capable(Some(&meta), || catalog.fast_capable(&provider, &meta, route["effort"].as_str(), &json!({})));
            let mut config = obj(input.get("baseConfig"));
            save_model_settings(&mut config, &route, fast_capable);
            Exact::Object(vec![("fastCapable".into(), Exact::Bool(fast_capable)), ("saved".into(), Exact::plain(&config["modelSettings"][&key]))])
        })
        .collect();
    assert_eq!(Exact::Array(got), *case.get("result"));
}

/// An object with its top-level fields in key order: Node's loader assembles a stored session (`store.loadSession`: the
/// header's fields, the messages, then `tools`) and Node's route object keeps the position of a key first set to
/// `undefined` (`contextPercent`), where the core writes fields in the order it sets them. Every value, nested order and the
/// set of fields are compared whole (the manifest's `exclusions`).
fn by_key(record: Exact) -> Exact {
    match record {
        Exact::Object(mut entries) => {
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            Exact::Object(entries)
        }
        other => other,
    }
}

/// Every `route/set` the recording made for the case at `line` (`routeSets`: Node's `setRoute` as the client's write calls
/// it, over the real route resolution, session store and config save), played through `route/set` on a thread created from the
/// recorded session record: the client's whole reply, the whole session record and the whole config document left stored.
/// `restrict_to_default`: the one provider the case names as known (`makeResolveRoute`'s default provider).
async fn route_sets(line: f64, restrict_to_default: bool) {
    let recording = recording();
    let case = case(&recording, line);
    for (n, set) in case.get("routeSets").as_array().iter().enumerate() {
        let (input, outcome) = (set.get("input"), set.get("outcome"));
        let known = restrict_to_default.then(|| input.get("defaultProvider").as_str().to_owned());
        let setup = Setup { config: plain(input.get("config")), meta: plain(input.get("meta")), known, windows: plain(input.get("windows")), session: plain(input.get("session")) };
        let client = Client::new(setup, &ops().await).await;
        let reply = client.set(&plain(input.get("route")), 1).await;
        assert_eq!(by_key(Exact::plain(&reply)), by_key(outcome.get("reply").clone()), "line {line} #{n}: the reply");
        assert_eq!(by_key(Exact::plain(&client.stored_session().await)), by_key(outcome.get("session").clone()), "line {line} #{n}: the stored session");
        assert_eq!(Exact::plain(&client.stored_config()), *outcome.get("file"), "line {line} #{n}: the stored config");
    }
}

/// Line 27: a cold placeholder row keeps the route's effort and Fast setting.
#[tokio::test]
async fn cold_metadata_preserves_effort_and_fast() {
    route_sets(27.0, false).await;
}

/// Line 49: a resolved row's metadata decides the effort and Fast capability.
#[tokio::test]
async fn resolved_metadata_is_authoritative() {
    route_sets(49.0, false).await;
}

/// Line 74: Cursor's parameter variants validate Fast.
#[tokio::test]
async fn cursor_parameter_variants_validate_fast() {
    route_sets(74.0, false).await;
}

/// Line 104: the model's default share and the ten-point steps of `resolveRouteContextState`.
#[test]
fn the_context_share_has_a_model_default_and_ten_point_steps() {
    let recording = recording();
    let case = case(&recording, 104.0);
    let meta = plain(case.get("input").get("meta"));
    let got: Vec<Exact> = case
        .get("input")
        .get("routes")
        .as_array()
        .iter()
        .map(|route| context_state(resolve_route_context_state(&obj(route), window_meta_of(Some(&meta), None))))
        .collect();
    assert_eq!(Exact::Array(got), *case.get("result"));
}

/// Line 149: a placeholder row (no windows of its own) takes the catalog's cached windows: the recorded table is the
/// catalog's roster files, and each selection's reply and stored state are Node's.
#[tokio::test]
async fn a_placeholder_row_takes_the_catalogs_windows() {
    route_sets(149.0, false).await;
}

/// Line 229: a cleared saved percent is the model's default (`route/set` answers no `contextPercent`).
#[tokio::test]
async fn a_cleared_saved_share_is_the_model_default() {
    route_sets(229.0, true).await;
}

/// One recorded `inheritFrom` scenario of lines 306 and 372, played through the protocol a client uses on a real
/// session directory: a source holding `CONVERSATION` on openai-oauth/gpt-6-astra, a heir opened on Node's heir route
/// (the target the recording shows before the carry), the real heir-route policy ([`HostInheritanceFit`] over the
/// empty catalog), and the compactor answering what Node's scripted compactor answered.
struct Carry {
    directory: mixdog_core_session::session::SessionDirectory,
    _rig: mixdog_core_session::session::testing::Rig,
}

/// What Node's scripted compactor did: rows to answer, nothing, or a throw.
enum Compactor {
    Rows(Vec<Value>),
    Throws,
    Unused,
}

impl Carry {
    async fn open(conversation: &[Value], heir: &Header, window: u64, compactor: Compactor, dir: &std::path::Path) -> Self {
        use mixdog_core_session::session::testing::{Rig, lock};
        let rig = Rig::new();
        rig.clock.0.store(1_700_000_000_000, std::sync::atomic::Ordering::SeqCst);
        match compactor {
            Compactor::Rows(rows) => *lock(&rig.compaction.heir_rows) = Some(rows),
            Compactor::Throws => rig.compaction.heir_fails.store(true, std::sync::atomic::Ordering::SeqCst),
            Compactor::Unused => {}
        }
        let mut header = heir.clone();
        // Node's route carries the picked window (`getRoute().selectedContextWindow`); the core keeps it on the header.
        header.insert("selectedContextWindow".into(), json!(window));
        let (_config_dir, config) = seams().await;
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.inherit = Arc::new(HostInheritanceFit::new(Arc::new(catalog(dir).await), config, Arc::new(Heir(header.clone()))));
        let directory = mixdog_core_session::session::SessionDirectory::new(Arc::new(deps));
        let source: Header = json!({ "provider": "openai-oauth", "model": "gpt-6-astra" }).as_object().cloned().unwrap();
        directory.create_with_id(ThreadId::from("source"), source, json!({})).await.expect("the source");
        directory.create_with_id(ThreadId::from("heir"), header, json!({})).await.expect("the heir");
        Self::call(&directory, "thread/inheritedRows/append", json!({ "threadId": "source", "messages": conversation })).await.expect("the conversation");
        Self { directory, _rig: rig }
    }

    async fn call(directory: &mixdog_core_session::session::SessionDirectory, method: &'static str, params: Value) -> Result<Value, mixdog_core_api::CoreError> {
        use mixdog_core_api::ThreadDirectory;
        use mixdog_core_api::call::{CallContext, CoreRequest};
        use mixdog_core_api::ids::Method;
        let ctx = CallContext::internal("replay");
        let op = params.get("opId").and_then(Value::as_str).map(|op| mixdog_core_api::ids::OpId::from(op));
        let request = CoreRequest { method: Method(method), params: params.clone(), op, ctx: ctx.clone() };
        let reply = match params.get("threadId").and_then(Value::as_str).filter(|_| !method.starts_with("thread/inheritancePreflight") && method != "thread/fork") {
            Some(id) => {
                use mixdog_core_api::ThreadHandle;
                directory.open_handle(&ThreadId::from(id.to_owned()), &ctx).await?.request(request).await?
            }
            None => directory.request(request).await?,
        };
        match reply {
            mixdog_core_api::Reply::Value(value) => Ok(value),
            mixdog_core_api::Reply::Subscribe(_) => panic!("a value reply"),
        }
    }

    async fn preflight(&self) -> Value {
        Self::call(&self.directory, "thread/inheritancePreflight", json!({ "threadId": "heir", "sourceThreadId": "source" })).await.expect("preflight")
    }

    /// `inheritFrom(source, { compact })` as Node answers it: `{ ok: { sessionId, sourceSessionId, messages, provider,
    /// model } }` or `{ error }` with the refusal's text.
    async fn inherit(&self, compact: Option<bool>) -> Value {
        let mut params = json!({ "threadId": "source", "opId": "op-inherit", "intoThreadId": "heir" });
        if let Some(compact) = compact {
            params["compact"] = json!(compact);
        }
        match Self::call(&self.directory, "thread/fork", params).await {
            Ok(done) => {
                let header = Self::call(&self.directory, "thread/header/read", json!({ "threadId": "heir" })).await.expect("header");
                json!({ "ok": {
                    "sessionId": done["thread"]["id"],
                    "sourceSessionId": header["header"]["inheritedFromSessionId"],
                    "messages": done["messages"],
                    "provider": done["provider"],
                    "model": done["model"],
                } })
            }
            Err(mixdog_core_api::CoreError::DomainError { message: Some(message), .. }) => json!({ "error": message }),
            Err(error) => panic!("an inheritance refusal, not {error:?}"),
        }
    }

    /// The heir's conversation as a client reads it.
    async fn messages(&self) -> Value {
        Self::call(&self.directory, "thread/messages/read", json!({ "threadId": "heir" })).await.expect("messages")["messages"].clone()
    }
}

/// A recorded `inheritFrom` answer as a client sees it: the `ok` object, or the refusal's text.
fn answer(recorded: &Exact) -> Value {
    match (recorded.try_get("ok"), recorded.try_get("error")) {
        (Some(ok), None) => json!({ "ok": plain(ok) }),
        (None, Some(Exact::Error { message, .. })) => json!({ "error": message }),
        _ => panic!("an ok or an error answer, not {recorded:?}"),
    }
}

/// Line 306: the verdict `thread/inheritancePreflight` gives and the answer of the carry it predicts (compacted, refused
/// after an empty compaction — twice, accepted whole), and the heir's conversation after it.
#[tokio::test(start_paused = true)]
async fn inheritance_preflight_is_the_verdict_the_carry_reaches() {
    inheritance_carry("306").await;
}

/// Line 372: with `compact` asked the carry is summarized, refused when the compactor throws or answers nothing, whole
/// when `compact` is absent or false; the preflight verdict and the heir's conversation after each.
#[tokio::test(start_paused = true)]
async fn compact_true_compacts_a_conversation_that_fits() {
    inheritance_carry("372").await;
}

/// The scenarios of the recorded line `line` (both lines share the conversation and the heir routes).
async fn inheritance_carry(line: &str) {
    let recording = recording();
    let dir = tempfile::tempdir().unwrap();
    let (pre, asked) = (case(&recording, 306.0).get("result"), case(&recording, 372.0).get("result"));
    let conversation: Vec<Value> = case(&recording, 306.0).get("input").get("conversation").as_array().iter().map(plain).collect();
    let untouched = |target: &Exact| -> Header {
        let mut header = obj(target);
        header.remove("id");
        header.remove("messages");
        header
    };
    let heir_small = untouched(pre.get("emptyCompaction").get("target"));
    let heir_roomy = untouched(pre.get("accepted").get("target"));
    // The scripted compactor's answers, recorded as the cases' inputs.
    let compacted = |line: f64, scenario: &str| {
        let answer = case(&recording, line).get("input").get("compactorAnswers").get(scenario);
        Compactor::Rows(answer.get("messages").as_array().iter().map(plain).collect())
    };
    let preflight = plain(asked.get("preflight"));
    let mut scenarios = vec![
        ("306 compacting", &heir_small, 20_000, compacted(306.0, "compacting"), vec![None], plain(pre.get("compacting").get("fit")), vec![answer(pre.get("compacting").get("inherit"))], pre.get("compacting").get("target")),
        ("306 emptyCompaction", &heir_small, 20_000, compacted(306.0, "emptyCompaction"), vec![None, None], plain(pre.get("emptyCompaction").get("fit")), vec![answer(pre.get("emptyCompaction").get("first")), answer(pre.get("emptyCompaction").get("second"))], pre.get("emptyCompaction").get("target")),
        ("306 accepted", &heir_roomy, 500_000, Compactor::Unused, vec![None], plain(pre.get("accepted").get("fit")), vec![answer(pre.get("accepted").get("inherit"))], pre.get("accepted").get("target")),
        ("372 compact", &heir_roomy, 500_000, compacted(372.0, "compact"), vec![Some(true)], preflight.clone(), vec![answer(asked.get("compact").get("inherit"))], asked.get("compact").get("target")),
        ("372 failing", &heir_roomy, 500_000, Compactor::Throws, vec![Some(true)], preflight.clone(), vec![answer(asked.get("failing").get("inherit"))], asked.get("failing").get("target")),
        ("372 empty", &heir_roomy, 500_000, compacted(372.0, "empty"), vec![Some(true)], preflight.clone(), vec![answer(asked.get("empty").get("inherit"))], asked.get("empty").get("target")),
    ];
    for default in asked.get("default").as_array() {
        let args = default.get("args").as_array();
        let compact = args.first().map(|options| options.get("compact").as_bool());
        scenarios.push(("372 default", &heir_roomy, 500_000, Compactor::Unused, vec![compact], preflight.clone(), vec![answer(default.get("inherit"))], default.get("target")));
    }
    for (label, heir, window, compactor, calls, fit, answers, target) in scenarios {
        if !label.starts_with(line) {
            continue;
        }
        let carry = Carry::open(&conversation, heir, window, compactor, dir.path()).await;
        assert_eq!(Exact::plain(&carry.preflight().await), Exact::plain(&fit), "{label}: the preflight");
        for (compact, want) in calls.into_iter().zip(answers) {
            assert_eq!(Exact::plain(&carry.inherit(compact).await), Exact::plain(&want), "{label}: the answer");
        }
        assert_eq!(Exact::plain(&carry.messages().await), *target.get("messages"), "{label}: the heir's conversation");
    }
}

/// The recorded heir sessions (`inheritanceFit(CONVERSATION, heir)`): the heir is the session measured, it sends no
/// tools, and its conversation is text only.
struct Heir(Header);

#[async_trait]
impl MeasuredThreads for Heir {
    async fn header(&self, _: &ThreadId) -> Option<Header> {
        Some(self.0.clone())
    }
    async fn tools(&self, _: &ThreadId) -> Vec<ToolDefinition> {
        Vec::new()
    }
    async fn media(&self, _: &ThreadId, _: &[Value]) -> Option<Arc<dyn MediaMeter>> {
        Some(Arc::new(TextOnly))
    }
}

/// A heir session is measured on its own windows, never the catalog's.
struct NoCatalogWindows;

impl RouteWindows for NoCatalogWindows {
    fn window(&self, _: &str, _: &str, _: &Value) -> Option<ContextMeta> {
        None
    }
}

/// Line 255: the same conversation judged on each heir session (a roomy one, an Anthropic one, a tight one and one with
/// no windows). Node measures the heir session record itself (`inheritFrom`'s `target`, `inheritance.mjs:87,180`): the
/// heir-session policy ([`HostInheritanceFit`]) is asked as the carry asks it. Direct: `thread/inheritancePreflight` measures
/// the route the heir would open with (`inheritance.mjs:131`, the catalog's windows: tried through it, the roomy variant
/// answers limit 272000 / 14 % where the recording has 500000 / 8 %), and `thread/fork` into a heir answers only ok or the
/// refusal sentence; no client call reports the used/limit/percent of an arbitrary session record (see the case table).
#[tokio::test]
async fn the_inheritance_fit_is_judged_on_the_heirs_route() {
    let recording = recording();
    let case = case(&recording, 255.0);
    let input = case.get("input");
    let conversation: Vec<Value> = input.get("conversation").as_array().iter().map(plain).collect();
    let carried = mixdog_core_session::session::inheritance::inheritable(conversation);
    let (_dir, config) = seams().await;
    let mut got = Vec::new();
    for variant in input.get("variants").as_array() {
        let [label, heir] = variant.as_array() else { panic!("a [label, heir] pair") };
        let header: Header = obj(heir);
        let fit = HostInheritanceFit::new(Arc::new(NoCatalogWindows), config.clone(), Arc::new(Heir(header.clone())));
        let (provider, model) = (header["provider"].as_str().unwrap().to_owned(), header["model"].as_str().unwrap().to_owned());
        let target = InheritTarget {
            provider: provider.clone(),
            model: model.clone(),
            selected_context_window: None,
            session: Some(ThreadId::from("heir")),
            tools_of: Some(ThreadId::from("heir")),
            source: Some(ThreadId::from("source")),
        };
        let basis = fit.basis(&target, &carried).await;
        let verdict = inheritance_fit(&provider, &model, carried.len(), basis.as_ref());
        got.push(Exact::Object(vec![("label".into(), label.clone()), ("fit".into(), Exact::plain(&Value::Object(verdict)))]));
    }
    assert_eq!(Exact::Array(got), *case.get("result"));
}
