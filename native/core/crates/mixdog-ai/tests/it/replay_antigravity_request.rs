//! `fixtures/provider-antigravity-request` (PURE): `buildAntigravityRequest(messages, model, tools, opts, project)`
//! is the Antigravity codec's request (`GoogleCodec::antigravity(..).encode`), `antigravityFunctionCallingMode(env)`
//! the codec's [`antigravity_function_calling_mode`], `toGeminiRequestTools(tools, nativeTools, opts)` the Gemini API
//! codec's `tools`, `actionInputUnionFor(schema)` the core's [`mixdog_ai::providers::action_input::action_input_union_for`].
//!
//! Every recorded envelope (`result.built`, one per build call, in order) is compared whole against the bytes the
//! core encodes, with the random request and session ids Node drew scripted into the core's draws. The test's own
//! view (`result.value`) is checked against the core's answers: each object, array, string or number of it must be
//! one of the core's built envelopes or parts of them, the exclusion reports the build made (`{name, index,
//! pointer, reason, message}` objects, their lists and their messages), another entry's answer, or an argument the
//! test passed (an input it shows beside the answers); an object or
//! array that is none of these is checked part by part. A boolean is the test's own predicate over those values
//! (`sourceUnchanged`, `equal`, ...), not a product output: the values it is computed from are the ones compared.

use std::sync::Arc;
use std::sync::Mutex;

use mixdog_ai::providers::google::codec::ANTIGRAVITY_ORIGIN;
use mixdog_ai::providers::google::codec::GEMINI_ORIGIN;
use mixdog_ai::providers::google::codec::GoogleCodec;
use mixdog_ai::providers::google::codec::antigravity_function_calling_mode;
use mixdog_ai::providers::google::traits::CatalogGoogleTraits;
use mixdog_ai::registry::keys::Environment;
use mixdog_core_api::domain::provider::HostedTool;
use mixdog_core_api::domain::provider::HostedWebSearch;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderReplay;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::ToolExclusionReport;
use mixdog_core_api::domain::provider::ToolExclusionSink;
use mixdog_core_api::domain::provider::WireCodec as _;
use mixdog_protocol::ProviderId;
use mixdog_testkit::Exact;
use serde_json::Value;
use serde_json::json;

use crate::provider_case::Call;
use crate::provider_case::Case;
use crate::provider_case::CaseSet;
use crate::provider_case::first_difference;
use crate::provider_case::plain;
use crate::provider_cases;
use crate::replay_world;

/// A recorded `env` object.
struct Vars(Vec<(String, String)>);

impl Environment for Vars {
    fn var(&self, name: &str) -> Option<String> {
        self.0.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
    }
}

fn vars(node: &Exact) -> Vars {
    Vars(node.entries().iter().map(|(k, v)| (k.clone(), v.as_str().to_owned())).collect())
}

/// No process environment: the recorder ran with none of `MIXDOG_ANTIGRAVITY_FC_MODE` set.
fn no_vars() -> Arc<dyn Environment> {
    Arc::new(Vars(Vec::new()))
}

fn traits() -> Arc<CatalogGoogleTraits> {
    Arc::new(CatalogGoogleTraits(Vec::new()))
}

/// A recorded message; a Google-wire replay envelope (`{version, provider, items}`) is the parts the decoder kept.
fn message(node: &Exact) -> Message {
    let Exact::Object(entries) = node else { panic!("a message: {node:?}") };
    let replay = entries.iter().find(|(k, _)| k == "providerReplay").map(|(_, v)| v);
    let rest = Exact::Object(entries.iter().filter(|(k, _)| k != "providerReplay").cloned().collect());
    let mut message = replay_world::message(&rest);
    if let Some(replay) = replay {
        assert_eq!(replay.get("version").as_f64(), 1.0, "a version-1 envelope");
        let items = provider_cases::plain(replay.get("items"));
        let items = match replay.get("provider").as_str() {
            "gemini" | "antigravity" | "antigravity-oauth" | "vertex-ai" => {
                let mut wrapped = json!({ "parts": items });
                if let Some(context) = replay.try_get("requestContext") {
                    wrapped["model"] = provider_cases::plain(context.get("model"));
                }
                wrapped
            }
            _ => items,
        };
        message.push_replay(ProviderReplay { owner: ProviderId::from(replay.get("provider").as_str()), items });
    }
    message
}

/// A recorded tool (`{name, title?, annotations?, trigger?, description, inputSchema}`) as the core's definition.
/// `title`, `annotations` and `trigger` are the tool surface's catalog fields (`trigger` feeds the deferred-tool list,
/// deferred-tools.mjs:219), which no request builder reads (`gemini-schema.mjs` `toGeminiTools` reads `name`,
/// `description` and `inputSchema`); an absent `inputSchema` is the core's null.
fn tool(node: &Exact) -> mixdog_core_api::domain::provider::ToolDefinition {
    for (key, _) in node.entries() {
        assert!(matches!(key.as_str(), "name" | "title" | "annotations" | "trigger" | "description" | "inputSchema"), "a tool key: {key}");
    }
    mixdog_core_api::domain::provider::ToolDefinition {
        name: node.get("name").as_str().to_owned(),
        description: node.get("description").as_str().to_owned(),
        input_schema: match node.get("inputSchema") {
            Exact::Undefined => Value::Null,
            schema => provider_cases::plain(schema),
        },
        defer_loading: false,
        freeform: None,
    }
}

fn tools(node: &Exact) -> Vec<mixdog_core_api::domain::provider::ToolDefinition> {
    match node {
        Exact::Undefined => Vec::new(),
        list => list.as_array().iter().map(tool).collect(),
    }
}

/// `JSON.stringify`'s view of a recorded value: an object key holding `undefined` is not written.
fn json_form(node: &Exact) -> Exact {
    match node {
        Exact::Object(entries) => Exact::Object(entries.iter().filter(|(_, v)| *v != Exact::Undefined).map(|(k, v)| (k.clone(), json_form(v))).collect()),
        Exact::Array(items) => Exact::Array(items.iter().map(json_form).collect()),
        other => other.clone(),
    }
}

/// The process environment of the case's `n`-th build: `function-calling-mode-default-env-and-tool-choice` sets
/// `MIXDOG_ANTIGRAVITY_FC_MODE=AUTO` before its second and third builds (record-antigravity-request.mjs:63-66).
fn build_env(case: &Case, n: usize) -> Arc<dyn Environment> {
    if case.id == "function-calling-mode-default-env-and-tool-choice" && n >= 1 {
        return Arc::new(Vars(vec![("MIXDOG_ANTIGRAVITY_FC_MODE".into(), "AUTO".into())]));
    }
    no_vars()
}

fn report(r: &ToolExclusionReport) -> Exact {
    Exact::Object(vec![
        ("name".into(), Exact::String(r.name.clone())),
        ("index".into(), Exact::Number(r.index as f64)),
        ("pointer".into(), Exact::String(r.pointer.clone())),
        ("reason".into(), Exact::String(r.reason.clone())),
        ("message".into(), Exact::String(r.message.clone())),
    ])
}

/// The request options of a recorded `opts`; `onToolExcluded` reports into `sink`.
fn options(opts: &Exact, sink: &Arc<Mutex<Vec<ToolExclusionReport>>>) -> RequestOptions {
    let mut options = RequestOptions::default();
    for (key, value) in opts.entries() {
        match key.as_str() {
            "onToolExcluded" => {
                let sink = sink.clone();
                options.on_tool_excluded = Some(ToolExclusionSink(Arc::new(move |r| sink.lock().unwrap().push(r))));
            }
            "nativeTools" => {
                options.hosted_tools = value
                    .as_array()
                    .iter()
                    .map(|tool| {
                        assert_eq!(tool.entries().len(), 1, "a {{type}} native tool: {tool:?}");
                        HostedTool::WebSearch(HostedWebSearch {
                            tool_type: tool.get("type").as_str().to_owned(),
                            allowed_domains: Vec::new(),
                            user_location: None,
                            max_uses: None,
                            context_size: None,
                            include_sources: false,
                        })
                    })
                    .collect();
            }
            "toolChoice" => options.tool_choice = Some(value.as_str().to_owned()),
            "effort" => options.effort = Some(value.as_str().to_owned()),
            other => panic!("an option these cases do not set: {other}"),
        }
    }
    options
}

/// The uuid bytes of `-<uuid>` / `agent-<uuid>`.
fn uuid_bytes(text: &str) -> Option<Vec<u8>> {
    let uuid = text.strip_prefix("agent-").or_else(|| text.strip_prefix('-'))?;
    if uuid.len() != 36 || uuid.matches('-').count() != 4 {
        return None;
    }
    let hex: String = uuid.chars().filter(|c| *c != '-').collect();
    Some((0..32).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex")).collect())
}

/// The draws Node made for the case's builds: a session uuid when the first user turn had no text, then the
/// request uuid, per build in order.
fn draws(case: &Case) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    for built in case.result().get("built").as_array() {
        if let Some(bytes) = uuid_bytes(built.get("request").get("sessionId").as_str()) {
            out.push(bytes);
        }
        out.push(uuid_bytes(built.get("requestId").as_str()).expect("a request uuid"));
    }
    out
}

/// What the core answers one recorded call with, and the exclusion reports it made.
fn answer(call: &Call, env: Arc<dyn Environment>) -> (Exact, Vec<ToolExclusionReport>) {
    let args = &call.args;
    let sink = Arc::new(Mutex::new(Vec::new()));
    let out = match call.entry.rsplit('.').next().expect("an entry") {
        "buildAntigravityRequest" => {
            let request = ModelRequest {
                model: args[1].as_str().to_owned(),
                messages: args[0].as_array().iter().map(message).collect(),
                tools: tools(&args[2]),
                options: options(&args[3], &sink),
            };
            // No project argument: the account has none (the codec's empty project).
            let project = args.get(4).map_or("", Exact::as_str);
            let codec = GoogleCodec::antigravity(ANTIGRAVITY_ORIGIN, project, "1.0.0", traits()).with_env(env);
            let wire = codec.encode(&request).unwrap_or_else(|e| panic!("{}: {}", request.model, e.message));
            plain(&serde_json::from_slice::<Value>(&wire.body).expect("a JSON body"))
        }
        "antigravityFunctionCallingMode" => Exact::String(antigravity_function_calling_mode(&vars(&args[0])).to_owned()),
        "toGeminiRequestTools" => {
            let opts = args.get(2).cloned().unwrap_or(Exact::Object(Vec::new()));
            let mut options = options(&opts, &sink);
            if let Some(native) = args.get(1).filter(|n| **n != Exact::Undefined) {
                options.hosted_tools = self::options(&Exact::Object(vec![("nativeTools".into(), native.clone())]), &sink).hosted_tools;
            }
            let request = ModelRequest {
                model: "gemini-3-pro".into(),
                messages: vec![Message::new(mixdog_core_api::domain::provider::Role::User, mixdog_core_api::domain::provider::Content::Text("x".into()))],
                tools: tools(&args[0]),
                options,
            };
            let inner = GoogleCodec::gemini(GEMINI_ORIGIN, traits()).build_inner(&request).expect("the Gemini request");
            inner.get("tools").map_or(Exact::Array(Vec::new()), plain)
        }
        "actionInputUnionFor" => {
            plain(&mixdog_ai::providers::action_input::action_input_union_for(&provider_cases::plain(&args[0])))
        }
        other => panic!("entry {other}: no core counterpart named in this replay"),
    };
    let reports = sink.lock().unwrap().clone();
    (out, reports)
}

/// Every subtree of `node`.
fn subtrees<'a>(node: &'a Exact, out: &mut Vec<&'a Exact>) {
    out.push(node);
    match node {
        Exact::Object(entries) => entries.iter().for_each(|(_, v)| subtrees(v, out)),
        Exact::Array(items) => items.iter().for_each(|v| subtrees(v, out)),
        _ => {}
    }
}

/// The parts of `value` that are none of the core's answers (see the module header).
fn unanswered(value: &Exact, answers: &[&Exact], path: &str, out: &mut Vec<String>) {
    if answers.contains(&value) {
        return;
    }
    match value {
        Exact::Object(entries) => entries.iter().for_each(|(k, v)| {
            // `validates[i].value`: the data the test's Ajv validator checked against the built schema, the test's own
            // input; its verdict (`valid`) is the test's predicate.
            if !(k == "value" && path.contains(".validates[")) {
                unanswered(v, answers, &format!("{path}.{k}"), out);
            }
        }),
        Exact::Array(items) => items.iter().enumerate().for_each(|(i, v)| unanswered(v, answers, &format!("{path}[{i}]"), out)),
        // A predicate of the test, or a field the built request does not hold (compared whole above).
        Exact::Bool(_) | Exact::Undefined => {}
        other => out.push(format!("{path} = {other:?}")),
    }
}


fn panic_text(panic: &Box<dyn std::any::Any + Send>) -> String {
    panic.downcast_ref::<String>().cloned().or_else(|| panic.downcast_ref::<&str>().map(|s| (*s).to_owned())).unwrap_or_default()
}

/// How many builds the case made before `call`.
fn builds_before(case: &Case, call: &Call) -> usize {
    case.calls.iter().take_while(|c| !std::ptr::eq(*c, call)).filter(|c| c.entry.ends_with("buildAntigravityRequest")).count()
}

/// The differences of one case from Node's recording.
fn check(case: &Case) -> Vec<String> {
    let mut failures = Vec::new();
    // Node's default warning channel (`console.warn`) is the core's console-warn line.
    let (lines, guard) = mixdog_rt::node_log::capture();
    mixdog_ai::random::script(draws(case));
    let answers: Vec<(String, Exact, Vec<ToolExclusionReport>)> = case
        .calls
        .iter()
        .map(|call| {
            let (out, reports) = answer(call, build_env(case, builds_before(case, call)));
            (call.entry.rsplit('.').next().unwrap().to_owned(), out, reports)
        })
        .collect();
    mixdog_ai::random::script(Vec::new());
    drop(guard);
    let warned: Vec<Exact> = lines.lock().unwrap().iter().map(|(_, _, line)| Exact::String(line.clone())).collect();
    let built: Vec<Exact> = answers.iter().filter(|(e, _, _)| e == "buildAntigravityRequest").map(|(_, out, _)| out.clone()).collect();
    if let Some(difference) = first_difference(&json_form(case.result().get("built")), &Exact::Array(built), "built") {
        failures.push(format!("{}: {difference}", case.id));
    }
    let mut extra = vec![Exact::Array(warned)];
    for (_, _, reports) in &answers {
        let list: Vec<Exact> = reports.iter().map(report).collect();
        extra.extend(reports.iter().map(|r| Exact::String(r.message.clone())));
        extra.push(Exact::Array(list));
    }
    let mut pool = Vec::new();
    for (_, out, _) in &answers {
        subtrees(out, &mut pool);
    }
    for e in &extra {
        subtrees(e, &mut pool);
    }
    // The test's own inputs it shows beside the answers (`variants[i].providerReplay`): the calls' arguments.
    for call in &case.calls {
        for arg in &call.args {
            subtrees(arg, &mut pool);
        }
    }
    let mut missing = Vec::new();
    unanswered(case.result().get("value"), &pool, "value", &mut missing);
    if !missing.is_empty() {
        failures.push(format!("{}: {missing:#?}", case.id));
    }
    failures
}

#[test]
fn every_case_builds_as_nodes() {
    let set = CaseSet::load("antigravity-request");
    assert_eq!(set.cases.len(), 30, "the recorded cases");
    // The recorder ran the cases in this order in one fresh process (its warn-once set starts empty).
    mixdog_ai::reset_process_state();
    // Node's process had loaded the computer tool, whose constructor registers its per-action union
    // (`advertiseActionInputUnion`); the core's computer tool registers the same union file.
    let union = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../mixdog-tools/src/desktop/defs/computer.union.json")).expect("the computer union");
    mixdog_ai::providers::action_input::advertise_action_input_union(&serde_json::from_str(&union).expect("a JSON union"));
    let mut failures = Vec::new();
    for case in &set.cases {
        match std::panic::catch_unwind(|| check(case)) {
            Ok(found) => failures.extend(found),
            Err(panic) => failures.push(format!("{}: {}", case.id, panic_text(&panic))),
        }
    }
    assert!(failures.is_empty(), "cases that differ from Node:\n{}", failures.join("\n"));
}
