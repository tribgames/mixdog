//! `fixtures/provider-antigravity-request` (PURE): `buildAntigravityRequest(messages, model, tools, opts, project)`
//! is the Antigravity codec's request (`GoogleCodec::antigravity(..).encode`), `antigravityFunctionCallingMode(env)`
//! the codec's [`antigravity_function_calling_mode`], `toGeminiRequestTools(tools, nativeTools, opts)` the Gemini API
//! codec's `tools`, `actionInputUnionFor(schema)` the core's [`mixdog_ai::providers::action_input::action_input_union_for`].
//!
//! Every recorded envelope (`result.built`, one per build call, in order) is compared whole against the JSON the core
//! sends (`JSON.stringify` of Node's object writes no `undefined` key), with the random request and session ids drawn
//! from the recording process's uuids as the recorder drew them ([`RecorderDraws`]). The test's own view
//! (`result.value`) is rebuilt per case from the core's answers exactly as `record-antigravity-request.mjs` builds it
//! from Node's (the request pieces, the exclusion reports, the warned lines, and the test's predicates computed over the
//! core's answers: equality of two answers, `hasUnion`, schema validity by a JSON Schema 2020-12 validator in Ajv's
//! place), and compared whole; the only inputs it shows are the values the test passed (`variants[].providerReplay`,
//! `validates[].value`).

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

use crate::provider_case::Case;
use crate::provider_case::CaseSet;
use crate::provider_case::RecorderDraws;
use crate::provider_case::assert_exact;
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

/// One build the case made: the request the core took, the JSON it sends, and the exclusion reports it made.
struct Build {
    request: ModelRequest,
    sent: Exact,
    reports: Vec<ToolExclusionReport>,
}

impl Build {
    fn request_json(&self) -> &Exact {
        self.sent.get("request")
    }

    /// `request.tools?.at(-1)?.functionDeclarations`.
    fn declarations(&self) -> Exact {
        match self.request_json().try_get("tools") {
            Some(Exact::Array(tools)) => tools.last().and_then(|t| t.try_get("functionDeclarations")).cloned().unwrap_or(Exact::Undefined),
            _ => Exact::Undefined,
        }
    }

    fn field(&self, key: &str) -> Exact {
        self.request_json().try_get(key).cloned().unwrap_or(Exact::Undefined)
    }

    fn warnings(&self) -> Exact {
        Exact::Array(self.reports.iter().map(report).collect())
    }

    /// The tools the build was handed are as the test passed them (`JSON.stringify(source) === JSON.stringify(before)`).
    fn tools_unchanged(&self, passed: &Exact) -> bool {
        let now: Vec<Value> = self.request.tools.iter().map(|t| t.input_schema.clone()).collect();
        let before: Vec<Value> = tools(passed).iter().map(|t| t.input_schema.clone()).collect();
        now == before
    }
}

/// The core's answers to a case's calls, in call order per entry.
#[derive(Default)]
struct Answers {
    builds: Vec<Build>,
    modes: Vec<Exact>,
    unions: std::collections::VecDeque<Exact>,
    gemini_tools: Vec<Exact>,
    /// `console.warn` lines (the core's console-warn channel).
    warned: Vec<Exact>,
}

fn answer(case: &Case) -> Answers {
    let mut answers = Answers::default();
    let (lines, guard) = mixdog_rt::node_log::capture();
    for call in &case.calls {
        let args = &call.args;
        let env = build_env(case, answers.builds.len());
        let sink = Arc::new(Mutex::new(Vec::new()));
        match call.entry.rsplit('.').next().expect("an entry") {
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
                let sent = plain(&serde_json::from_slice::<Value>(&wire.body).expect("a JSON body"));
                let reports = sink.lock().unwrap().clone();
                answers.builds.push(Build { request, sent, reports });
            }
            "antigravityFunctionCallingMode" => answers.modes.push(Exact::String(antigravity_function_calling_mode(&vars(&args[0])).to_owned())),
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
                answers.gemini_tools.push(inner.get("tools").map_or(Exact::Array(Vec::new()), plain));
            }
            "actionInputUnionFor" => {
                answers.unions.push_back(plain(&mixdog_ai::providers::action_input::action_input_union_for(&provider_cases::plain(&args[0]))));
            }
            other => panic!("{}: entry {other}: no core counterpart named in this replay", case.id),
        }
    }
    drop(guard);
    answers.warned = lines.lock().unwrap().iter().map(|(_, _, line)| Exact::String(line.clone())).collect();
    answers
}

fn obj(entries: Vec<(&str, Exact)>) -> Exact {
    Exact::Object(entries.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

/// `JSON.stringify(a) === JSON.stringify(b)`.
fn json_equal(a: &Exact, b: &Exact) -> bool {
    json_form(a) == json_form(b)
}

/// The recorder's `hasUnion`: an `anyOf` or `oneOf` key anywhere.
fn has_union(value: &Exact) -> bool {
    match value {
        Exact::Array(items) => items.iter().any(has_union),
        Exact::Object(entries) => entries.iter().any(|(k, v)| k == "anyOf" || k == "oneOf" || has_union(v)),
        _ => false,
    }
}

/// `['anyOf', 'oneOf', 'allOf', 'not'].filter((key) => schema[key] !== undefined)`.
fn root_combinators(schema: &Exact) -> Exact {
    Exact::Array(["anyOf", "oneOf", "allOf", "not"].iter().filter(|k| schema.try_get(k).is_some_and(|v| *v != Exact::Undefined)).map(|k| Exact::String((*k).into())).collect())
}

/// Ajv2020's `validateSchema(schema) === true`: the schema is a valid 2020-12 schema.
fn valid_schema(schema: &Exact) -> Exact {
    Exact::Bool(jsonschema::meta::is_valid(&provider_cases::plain(schema)))
}

/// `validates: values.map((value) => ({ value, valid: validate(value) }))` with the schema compiled by a 2020-12 validator.
fn validates(schema: &Exact, recorded: &Exact) -> Exact {
    let validator = jsonschema::draft202012::new(&provider_cases::plain(schema)).expect("the core's schema compiles");
    Exact::Array(
        recorded
            .as_array()
            .iter()
            .map(|row| {
                // The value the test validates is its own input; the verdict is the validator's over the core's schema.
                let value = row.get("value").clone();
                let valid = validator.is_valid(&provider_cases::plain(&value));
                obj(vec![("value", value), ("valid", Exact::Bool(valid))])
            })
            .collect(),
    )
}

fn schema_of(declaration: &Exact) -> Exact {
    declaration.try_get("parametersJsonSchema").cloned().unwrap_or(Exact::Undefined)
}

fn first_schema(build: &Build) -> Exact {
    match build.declarations() {
        Exact::Array(list) if !list.is_empty() => schema_of(&list[0]),
        _ => Exact::Undefined,
    }
}

/// The arguments of the case's `i`-th build.
fn build_args(case: &Case, i: usize) -> &[Exact] {
    &case.calls.iter().filter(|c| c.entry.ends_with("buildAntigravityRequest")).nth(i).expect("a build").args
}

/// The case's `value`, built from the core's answers as the recorder builds it from Node's (`record-antigravity-request.mjs`).
fn value(case: &Case, a: &mut Answers) -> Exact {
    let recorded = case.result().get("value");
    let b = &a.builds;
    let contents = |i: usize| b[i].field("contents");
    let args = |i: usize| build_args(case, i);
    let excluded = |i: usize| obj(vec![("declarations", b[i].declarations()), ("warnings", b[i].warnings())]);
    let schema_case = |extra: Vec<(&str, Exact)>| {
        let mut out = vec![("schema", first_schema(&b[0]))];
        out.extend(extra);
        out.push(("sourceUnchanged", Exact::Bool(b.iter().all(|build| build.tools_unchanged(&args(0)[2])))));
        obj(out)
    };
    match case.id.as_str() {
        "hosted-google-search-ahead-of-declarations" => obj(vec![
            ("searchOnly", b[0].request_json().clone()),
            ("both", b[1].request_json().clone()),
            ("noNative", b[2].field("tools")),
        ]),
        "function-calling-mode-default-env-and-tool-choice" => {
            let fc: Vec<&crate::provider_case::Call> = case.calls.iter().filter(|c| c.entry.ends_with("antigravityFunctionCallingMode")).collect();
            let modes = fc
                .iter()
                .zip(&a.modes)
                .map(|(call, mode)| (serde_json::to_string(&provider_cases::plain(&call.args[0])).expect("JSON"), mode.clone()))
                .collect();
            obj(vec![
                ("modes", Exact::Object(modes)),
                ("defaultConfig", b[0].field("toolConfig")),
                ("autoConfig", b[1].field("toolConfig")),
                ("noneConfig", b[2].field("toolConfig")),
            ])
        }
        "full-builtin-bridge-surface-sent-as-authored" => {
            let surface = &args(0)[2];
            let rows = b[0]
                .declarations()
                .as_array()
                .iter()
                .map(|declaration| {
                    let schema = schema_of(declaration);
                    let authored = a.unions.pop_front().expect("actionInputUnionFor (authoredSchemaUnion)");
                    let again = a.unions.pop_front().expect("actionInputUnionFor (equalsActionInputUnion)");
                    obj(vec![
                        ("declaration", declaration.clone()),
                        ("authoredSchemaUnion", authored),
                        ("hasParameters", Exact::Bool(declaration.try_get("parameters").is_some_and(|p| *p != Exact::Undefined))),
                        ("equalsActionInputUnion", Exact::Bool(json_equal(&schema, &again))),
                        ("valid2020", valid_schema(&schema)),
                        ("rootType", schema.try_get("type").cloned().unwrap_or(Exact::Undefined)),
                        ("rootCombinators", root_combinators(&schema)),
                    ])
                })
                .collect();
            let inputs: Vec<Exact> = surface.as_array().iter().map(|t| t.try_get("inputSchema").cloned().unwrap_or(Exact::Undefined)).collect();
            obj(vec![
                ("surfaceHasUnion", Exact::Bool(has_union(&Exact::Array(inputs)))),
                ("sonnetWarnings", b[0].warnings()),
                ("sonnetEqualsOpus", Exact::Bool(json_equal(&b[0].declarations(), &b[1].declarations()))),
                ("opusDeclarations", b[1].declarations()),
                ("opusWarnings", b[1].warnings()),
                ("rows", Exact::Array(rows)),
                ("surfaceUnchanged", Exact::Bool(b.iter().all(|build| build.tools_unchanged(surface)))),
            ])
        }
        "standard-2020-12-forms-sent-as-written"
        | "boolean-schemas-recursive-defs-keyword-like-names"
        | "draft-07-standard-keyword-mapping"
        | "draft-07-definitions-follow-own-id-scope"
        | "draft-07-definitions-reachable-from-ref-node" => schema_case(Vec::new()),
        "draft-07-keywords-beside-ref-ignored" => schema_case(vec![("validates", validates(&first_schema(&b[1]), recorded.get("validates")))]),
        "invalid-tool-left-out-with-warning-request-proceeds-in-order" => obj(vec![
            ("declarations", b[0].declarations()),
            ("firstTool", match b[0].field("tools") {
                Exact::Array(tools) => tools.first().cloned().unwrap_or(Exact::Undefined),
                _ => Exact::Undefined,
            }),
            ("toolConfig", b[0].field("toolConfig")),
            ("warnings", b[0].warnings()),
        ]),
        // One exclusion per named schema, in the recorder's order (the names are its own keys).
        "provider-forbidden-roots-exclude-the-tool" | "schemas-invalid-under-their-dialect-excluded" => {
            Exact::Object(recorded.entries().iter().enumerate().map(|(i, (name, _))| (name.clone(), excluded(i))).collect())
        }
        "every-tool-invalid-request-carries-no-tools" => obj(vec![("warnings", b[0].warnings()), ("tools", b[0].field("tools")), ("toolConfig", b[0].field("toolConfig"))]),
        "default-warning-channel-console-warn-once-per-problem" => obj(vec![("warned", Exact::Array(a.warned.clone()))]),
        "missing-schema-excludes-tool-order-kept" => obj(vec![("declarations", b[0].declarations())]),
        "gemini-declarations-unchanged-by-claude-normalization" => {
            let expected = match &a.gemini_tools[0] {
                Exact::Array(tools) => tools.last().and_then(|t| t.try_get("functionDeclarations")).cloned().unwrap_or(Exact::Undefined),
                _ => Exact::Undefined,
            };
            let actual = b[0].declarations();
            obj(vec![
                ("equal", Exact::Bool(json_equal(&actual, &expected))),
                ("hasUnion", Exact::Bool(has_union(&actual))),
                ("declarations", actual),
                ("geminiProjection", expected),
            ])
        }
        "computer-per-action-alternatives-claude-flat-for-gemini" => {
            let claude = b[0].declarations().as_array()[0].clone();
            let schema = schema_of(&claude);
            let actions = args(0)[2].as_array()[0].get("inputSchema").get("properties").get("action").get("enum").clone();
            let sorted = |list: Vec<Exact>| {
                let mut texts: Vec<String> = list.iter().map(|t| t.as_str().to_owned()).collect();
                texts.sort();
                texts
            };
            let titles = schema.get("properties").get("input").get("anyOf").as_array().iter().map(|alt| alt.get("title").clone()).collect();
            let flat = schema_of(&b[1].declarations().as_array()[0]).get("properties").get("input").clone();
            let present = |v: Option<&Exact>| v.is_some_and(|v| *v != Exact::Undefined && *v != Exact::Null);
            let properties = flat.get("properties");
            obj(vec![
                (
                    "claude",
                    obj(vec![
                        ("declaration", claude.clone()),
                        ("valid2020", valid_schema(&schema)),
                        ("rootCombinators", root_combinators(&schema)),
                        ("alternativeTitlesEqualActions", Exact::Bool(sorted(titles) == sorted(actions.as_array().to_vec()))),
                        ("validates", validates(&schema, recorded.get("claude").get("validates"))),
                    ]),
                ),
                (
                    "gemini",
                    obj(vec![
                        ("flatHasAnyOf", Exact::Bool(present(flat.try_get("anyOf")))),
                        (
                            "flatHasKindActionsOperation",
                            Exact::Bool(present(properties.try_get("kind")) && present(properties.try_get("actions")) && present(properties.try_get("operation"))),
                        ),
                    ]),
                ),
            ])
        }
        // `both(history)`: the contents per model, keyed by the model.
        "plain-history-without-provider-replay-drops-thinking-for-claude" => {
            Exact::Object((0..b.len()).map(|i| (args(i)[1].as_str().to_owned(), contents(i))).collect())
        }
        "replay-from-another-family-or-provider-drops-thinking-and-signatures" => {
            obj(vec![(
                "variants",
                Exact::Array(
                    (0..b.len())
                        .map(|i| {
                            // The replay envelope the test handed the build (its assistant turn's), as it passed it.
                            let replay = args(i)[0].as_array().iter().find_map(|m| m.try_get("providerReplay")).expect("the turn's replay").clone();
                            obj(vec![("providerReplay", replay), ("claude", contents(i))])
                        })
                        .collect(),
                ),
            )])
        }
        "open-loop-without-thinking-closed-with-fresh-turn-wire-only" => Exact::Object(
            recorded
                .entries()
                .iter()
                .enumerate()
                .map(|(i, (name, _))| {
                    let unchanged = b[i].request.messages == args(i)[0].as_array().iter().map(message).collect::<Vec<_>>();
                    (name.clone(), obj(vec![("contents", contents(i)), ("historyUnchanged", Exact::Bool(unchanged))]))
                })
                .collect(),
        ),
        // Every other case shows the contents of its builds under the recorder's names, one per build in order.
        _ => {
            assert_eq!(recorded.entries().len(), b.len(), "{}: one recorded view per build", case.id);
            Exact::Object(recorded.entries().iter().enumerate().map(|(i, (name, _))| (name.clone(), contents(i))).collect())
        }
    }
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
    // Each build drew its request (and session) uuid from the recording process's `crypto.randomUUID()`, in order over the
    // whole recording: the core's draws are those uuids, computed as the recorder's world drew them.
    let mut draws = RecorderDraws::default();
    mixdog_ai::random::script((0..512).map(|_| draws.uuid_bytes()));
    let mut failures = Vec::new();
    for case in &set.cases {
        let checked = std::panic::catch_unwind(|| {
            let mut answers = answer(case);
            let built = Exact::Array(answers.builds.iter().map(|b| b.sent.clone()).collect());
            let got = obj(vec![("value", value(case, &mut answers)), ("built", built)]);
            assert!(answers.unions.is_empty(), "every actionInputUnionFor answer is shown");
            assert_exact(&format!("{}: result", case.id), &json_form(case.result()), &json_form(&got));
        });
        if let Err(panic) = checked {
            failures.push(format!("{}: {}", case.id, panic_text(&panic)));
        }
    }
    mixdog_ai::random::script(Vec::new());
    assert!(failures.is_empty(), "cases that differ from Node:\n{}", failures.join("\n"));
}

fn panic_text(panic: &Box<dyn std::any::Any + Send>) -> String {
    panic.downcast_ref::<String>().cloned().or_else(|| panic.downcast_ref::<&str>().map(|s| (*s).to_owned())).unwrap_or_default()
}
