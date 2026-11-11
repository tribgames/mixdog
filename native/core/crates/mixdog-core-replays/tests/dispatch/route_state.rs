//! Node's recording `fixtures/session-route-state/recording.json` (`record-session-route-state.mjs`, test file
//! `src/session-runtime/session-lifecycle.test.mjs`), read when the test runs and decoded with [`Exact`]: each case's
//! recorded inputs go through the core's own route functions (the ones `refreshRouteEffort`, `setRoute` and the
//! inheritance carry call) and the whole recorded result is compared. The `inheritFrom` cases (306, 372) are played
//! through the protocol on a real session directory and compared at what a client observes: the preflight verdict, the
//! carry's answer and the heir's conversation; the compactor calls Node's mocks counted are not observable.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::compact::estimate::MediaMeter;
use mixdog_ai::catalog::{CatalogService, CatalogSnapshot, ModelsDevSource};
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::service::admin_route::{
    Obj, ContextState, model_meta_looks_resolved, resolve_route, resolve_route_context_state, resolve_route_effort_state,
    route_fast_key, save_model_settings, selection_fast_capable, window_meta_of,
};
use mixdog_ai::transport::http::{HttpResponse, HttpSend};
use mixdog_core_api::domain::provider::{DeliveryState, ErrorKind, ProviderError, ToolDefinition, WireRequest};
use mixdog_core_api::ids::ThreadId;
use mixdog_core_run::run_host::session_context_meta::ContextMeta;
use mixdog_core_session::session::inheritance::{InheritTarget, InheritanceFit, inheritance_fit};
use mixdog_store::schema::record::Header;
use mixdog_testkit::exact::Exact;
use serde_json::{Value, json};

use super::inheritance_fit::{TextOnly, seams};
use mixdog_core::run_host::inheritance_fit::{HostInheritanceFit, MeasuredThreads, RouteWindows};

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

/// Line 10: the Fast setting saved for a route (`saveModelSettings` with `selectionFastCapable`) over a placeholder, a
/// row advertising the priority tier and a row without it.
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

/// Lines 27, 49, 74: `resolveRouteEffortState` over a cold placeholder, a resolved row and Cursor's parameter variants.
#[tokio::test]
async fn the_effort_state_follows_the_rows_metadata() {
    let recording = recording();
    let dir = tempfile::tempdir().unwrap();
    let catalog = catalog(dir.path()).await;
    let fast = |provider: &str, meta: &Value, effort: Option<&str>, params: &Value| catalog.fast_capable(provider, meta, effort, params);
    for line in [27.0, 49.0, 74.0] {
        let case = case(&recording, line);
        let (route, meta) = (obj(case.get("input").get("route")), plain(case.get("input").get("meta")));
        let (effective, fast_capable) = resolve_route_effort_state(&route, Some(&meta), &fast);
        let got = Exact::Object(vec![
            ("effectiveEffort".into(), Exact::plain(&effective)),
            ("fastCapable".into(), Exact::Bool(fast_capable)),
            ("metadataResolved".into(), Exact::Bool(model_meta_looks_resolved(Some(&meta)))),
        ]);
        assert_eq!(got, *case.get("result"), "line {line}");
    }
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

/// Line 149: a placeholder row (no windows of its own) takes the catalog's cached windows, asked once per resolve as
/// the route chain asks (`chain.rs` `window_meta`: `catalog.cached_windows` then `window_meta_of`); the recorded table
/// is the catalog.
#[test]
fn a_placeholder_row_takes_the_catalogs_windows() {
    let recording = recording();
    let case = case(&recording, 149.0);
    let table = plain(case.get("input").get("table"));
    let got: Vec<Exact> = case
        .get("result")
        .as_array()
        .iter()
        .map(|row| {
            let (route, meta) = (obj(row.get("route")), plain(row.get("meta")));
            let (provider, model) = (route["provider"].as_str().unwrap(), route["model"].as_str().unwrap());
            let cached = table.get(format!("{provider}/{model}")).cloned();
            let state = context_state(resolve_route_context_state(&route, window_meta_of(Some(&meta), cached.as_ref())));
            Exact::Object(vec![
                ("route".into(), Exact::plain(&Value::Object(route.clone()))),
                ("meta".into(), Exact::plain(&meta)),
                ("state".into(), state),
                ("lookups".into(), Exact::plain(&json!([[provider, model]]))),
            ])
        })
        .collect();
    assert_eq!(Exact::Array(got), *case.get("result"));
}

/// Line 229: `resolveRoute` reads a cleared saved percent as the model's default (no `contextPercent`).
#[test]
fn a_cleared_saved_share_is_the_model_default() {
    let recording = recording();
    let case = case(&recording, 229.0);
    let input = case.get("input");
    let default = input.get("defaultProvider").as_str().to_owned();
    let route = resolve_route(&obj(input.get("config")), &obj(input.get("route")), &|provider, _| provider == default).expect("resolves");
    assert_eq!(route.get("contextPercent").map_or(Exact::Undefined, Exact::plain), *case.get("result"));
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
    Nothing,
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
            Compactor::Nothing => *lock(&rig.compaction.heir_rows) = Some(Vec::new()),
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

/// Lines 306 and 372: the verdict `thread/inheritancePreflight` gives, the answer of the carry it predicts (compacted,
/// refused after an empty compaction — twice, accepted whole; with `compact` asked: summarized, refused when the
/// compactor throws or answers nothing, whole when `compact` is absent or false), and the heir's conversation after it.
#[tokio::test(start_paused = true)]
async fn the_inheritance_carry_answers_what_node_recorded() {
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
    // The heir as it was before any carry: a failed carry leaves it so, which is what Node's `372 failing` target shows (the target of an
    // accepted carry already names its source).
    let heir_roomy = untouched(asked.get("failing").get("target"));
    let compacted = |target: &Exact| Compactor::Rows(vec![json!({ "role": "user", "content": target.get("messages").as_array()[0].get("content").as_str() })]);
    let preflight = plain(asked.get("preflight"));
    let mut scenarios = vec![
        ("306 compacting", &heir_small, 20_000, compacted(pre.get("compacting").get("target")), vec![None], plain(pre.get("compacting").get("fit")), vec![answer(pre.get("compacting").get("inherit"))], pre.get("compacting").get("target"), pre.get("compacting").try_get("calls"), pre.get("compacting").try_get("saves")),
        ("306 emptyCompaction", &heir_small, 20_000, Compactor::Nothing, vec![None, None], plain(pre.get("emptyCompaction").get("fit")), vec![answer(pre.get("emptyCompaction").get("first")), answer(pre.get("emptyCompaction").get("second"))], pre.get("emptyCompaction").get("target"), pre.get("emptyCompaction").try_get("calls"), pre.get("emptyCompaction").try_get("saves")),
        ("306 accepted", &heir_roomy, 500_000, Compactor::Unused, vec![None], plain(pre.get("accepted").get("fit")), vec![answer(pre.get("accepted").get("inherit"))], pre.get("accepted").get("target"), None, pre.get("accepted").try_get("saves")),
        ("372 compact", &heir_roomy, 500_000, compacted(asked.get("compact").get("target")), vec![Some(true)], preflight.clone(), vec![answer(asked.get("compact").get("inherit"))], asked.get("compact").get("target"), asked.get("compact").try_get("calls"), asked.get("compact").try_get("saves")),
        ("372 failing", &heir_roomy, 500_000, Compactor::Throws, vec![Some(true)], preflight.clone(), vec![answer(asked.get("failing").get("inherit"))], asked.get("failing").get("target"), None, asked.get("failing").try_get("saves")),
        ("372 empty", &heir_roomy, 500_000, Compactor::Nothing, vec![Some(true)], preflight.clone(), vec![answer(asked.get("empty").get("inherit"))], asked.get("empty").get("target"), None, asked.get("empty").try_get("saves")),
    ];
    for default in asked.get("default").as_array() {
        let args = default.get("args").as_array();
        let compact = args.first().map(|options| options.get("compact").as_bool());
        scenarios.push(("372 default", &heir_roomy, 500_000, Compactor::Unused, vec![compact], preflight.clone(), vec![answer(default.get("inherit"))], default.get("target"), None, default.try_get("saves")));
    }
    for (label, heir, window, compactor, calls, fit, answers, target, recorded_calls, recorded_saves) in scenarios {
        let carry = Carry::open(&conversation, heir, window, compactor, dir.path()).await;
        assert_eq!(Exact::plain(&carry.preflight().await), Exact::plain(&fit), "{label}: the preflight");
        for (compact, want) in calls.into_iter().zip(answers) {
            assert_eq!(Exact::plain(&carry.inherit(compact).await), Exact::plain(&want), "{label}: the answer");
        }
        assert_eq!(Exact::plain(&carry.messages().await), *target.get("messages"), "{label}: the heir's conversation");
        // What the heir holds on disk: the recorded target's header fields whole (`selectedContextWindow` is the core's name of the
        // picked window Node's route carried, seeded above), and the saves Node made — each one the target, written at once
        // (`{ immediate: true }`) — are the store batches that landed during the carry. The core's header also holds its own `id`
        // (Node's target has it beside the header) and, once a carry was tried (the set stays after a refusal: a superset is safe),
        // the source's offload bookkeeping (`offloadSources`: the sessions whose offloaded tool results the heir may read, rules
        // version 2), which Node's session does not have.
        let heir_id = ThreadId::from("heir");
        let mut want_header = obj(target);
        want_header.remove("messages");
        want_header.insert("selectedContextWindow".into(), json!(window));
        want_header.insert("offloadSources".into(), json!(["source"]));
        want_header.insert("offloadSourcesRules".into(), json!(2));
        let stored = carry._rig.store.stored_header(&heir_id).expect("the heir's stored header");
        // A header is a map: its keys are compared by name, not by the order the core stored them in.
        let by_name = |header: serde_json::Map<String, Value>| Exact::plain(&Value::Object(header.into_iter().collect::<std::collections::BTreeMap<_, _>>().into_iter().collect()));
        assert_eq!(by_name(stored), by_name(want_header), "{label}: the heir's header");
        if let Some(saves) = recorded_saves {
            for save in saves.as_array() {
                assert_eq!(save.as_array()[0], *target, "{label}: Node saved the target");
                assert_eq!(Exact::plain(&plain(&save.as_array()[1])), Exact::plain(&json!({ "immediate": true })), "{label}: Node saved at once");
            }
            // The core's own header writes around the carry (the reference-set mark taken before it and lifted when it fails, `inheritance.rs`
            // `carry_into`) have no Node counterpart; the save of the rows is the one that holds them, so the saves are the batches that landed
            // holding the carried rows — the rows are written once, all of them, or not at all.
            use mixdog_store::schema::record::Record;
            let rows = carry._rig.store.records(&heir_id).iter().filter(|(_, record)| matches!(record, Record::Item(_))).count();
            assert_eq!(rows, target.get("messages").as_array().len(), "{label}: the rows the heir's log holds are the saved target's");
            assert_eq!(saves.as_array().len(), usize::from(rows > 0), "{label}: how many times the heir was saved");
        }
        // The compactor's calls: Node's mock counted them, and the ones that carry a budget carry the one it was asked for
        // (`calls[n].budgetTokens`; an empty answer is asked again, as the recording's two calls show).
        if let Some(calls) = recorded_calls {
            let asked: Vec<u64> = mixdog_core_session::session::testing::lock(&carry._rig.compaction.heir_asked).iter().map(|(budget, _)| *budget).collect();
            let budgets: Vec<Option<u64>> = calls.as_array().iter().map(|call| call.try_get("budgetTokens").map(|budget| budget.as_f64() as u64)).collect();
            assert_eq!(asked.len(), budgets.len(), "{label}: how many times the compactor was asked");
            for (n, (got, want)) in asked.iter().zip(&budgets).enumerate() {
                if let Some(want) = want {
                    assert_eq!(got, want, "{label}: the budget of call {n}");
                }
            }
        }
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

/// Line 255: the same conversation judged on each heir route (a roomy one, an Anthropic one, a tight one and one with
/// no windows).
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
