//! `provider-transport-policy`, the PURE cases: the recorded policy, gate, frame and delta calls through
//! `transport_policy` / `delta` with the recorded arguments, the result compared whole in Node's shape.

use mixdog_ai::providers::google::decode::chunk_progress;
use mixdog_ai::providers::openai::transport_policy;
use mixdog_ai::providers::openai::transport_policy::Capabilities;
use mixdog_core_api::domain::provider::ProgressKind;
use mixdog_ai::providers::openai::transport_policy::Mode;
use mixdog_ai::providers::openai::transport_policy::Policy;
use mixdog_ai::providers::openai::transport_policy::Transport;
use mixdog_testkit::Exact;
use serde_json::Value;

use crate::provider_case::Case;
use crate::provider_case::CaseSet;
use crate::provider_cases::args_of;
use crate::provider_cases::assert_result;
use crate::provider_cases::object;
use crate::provider_cases::pure_ids;
use crate::provider_cases::string;
use crate::replay_openai_ws_delta::compute_recorded;
use crate::replay_openai_ws_delta::frame_recorded;

const SET: &str = "transport-policy";
const POLICY: &str = "openai-transport-policy.mjs.";

fn mode(m: Mode) -> Exact {
    string(m.as_str())
}

fn caps(c: Capabilities) -> Exact {
    object(vec![("ws", Exact::Bool(c.ws)), ("http", Exact::Bool(c.http)), ("delta", Exact::Bool(c.delta))])
}

fn policy(p: Policy) -> Exact {
    object(vec![
        ("mode", mode(p.mode)),
        ("requestedMode", mode(p.requested_mode)),
        ("transport", string(match p.transport {
            Transport::Ws => "ws",
            Transport::Http => "http",
        })),
        ("allowHttpFallback", Exact::Bool(p.allow_http_fallback)),
        (
            "delta",
            object(vec![
                ("force", Exact::Bool(p.delta.force)),
                ("refs", Exact::Bool(p.delta.refs)),
                ("optIn", Exact::Bool(p.delta.opt_in)),
            ]),
        ),
        ("capabilities", caps(p.capabilities)),
    ])
}

/// The `MIXDOG_OAI_TRANSPORT` value of a recorded env object.
fn setting(env: &Exact) -> Option<String> {
    env.try_get("MIXDOG_OAI_TRANSPORT").map(|v| v.as_str().to_owned())
}

/// A recorded capabilities argument over the full defaults (`{ ...FULL, ...capabilities }`).
fn capabilities(arg: &Exact) -> Capabilities {
    let flag = |key: &str, default: bool| arg.try_get(key).map_or(default, Exact::as_bool);
    let full = transport_policy::FULL;
    Capabilities { ws: flag("ws", full.ws), http: flag("http", full.http), delta: flag("delta", full.delta) }
}

fn mode_of(arg: &Exact) -> Mode {
    transport_policy::normalize(arg.as_str()).unwrap_or_else(|| panic!("not a mode: {arg:?}"))
}

fn openai_policy(args: &[Exact]) -> Exact {
    policy(transport_policy::resolve_openai(setting(&args[0]).as_deref()))
}

fn responses_policy(args: &[Exact]) -> Exact {
    policy(transport_policy::resolve(setting(&args[0]).as_deref(), capabilities(&args[1])))
}

fn policy_defaults_and_modes(case: &Case) -> Exact {
    let calls = args_of(case, &format!("{POLICY}resolveOpenAiTransportPolicy"));
    Exact::Array(calls.iter().map(|args| object(vec![("env", args[0].clone()), ("policy", openai_policy(args))])).collect())
}

fn response_frame_omits_transport_fields(case: &Case) -> Exact {
    let calls = args_of(case, "._buildResponseCreateFrame");
    let frame = |args: &[Exact]| Exact::plain(&Value::Object(frame_recorded(args)));
    object(vec![("full", frame(&calls[0])), ("delta", frame(&calls[1]))])
}

fn mode_token_aliases(case: &Case) -> Exact {
    let calls = args_of(case, &format!("{POLICY}_normalizeTransportMode"));
    Exact::Array(
        calls
            .iter()
            .map(|args| {
                let normalized = transport_policy::normalize(args[0].as_str()).map_or(Exact::Null, mode);
                Exact::Array(vec![args[0].clone(), normalized])
            })
            .collect(),
    )
}

fn compute_delta_case(case: &Case) -> Exact {
    let args = &args_of(case, "._computeDelta")[0];
    let env = case.input.get("env").as_str().to_owned();
    object(vec![
        ("body", args[0].get("body").clone()),
        ("entry", args[0].get("entry").clone()),
        ("delta", compute_recorded(args, Some(&env))),
    ])
}

fn responses_policy_full_caps_equal_legacy(case: &Case) -> Exact {
    let legacy = args_of(case, &format!("{POLICY}resolveOpenAiTransportPolicy"));
    let shared = args_of(case, &format!("{POLICY}resolveResponsesTransportPolicy"));
    Exact::Array(
        legacy
            .iter()
            .zip(&shared)
            .map(|(l, s)| {
                let lp = transport_policy::resolve_openai(setting(&l[0]).as_deref());
                let sp = transport_policy::resolve(setting(&s[0]).as_deref(), capabilities(&s[1]));
                let equal = sp.mode == lp.mode
                    && sp.transport == lp.transport
                    && sp.allow_http_fallback == lp.allow_http_fallback
                    && sp.delta == lp.delta;
                object(vec![("env", l[0].clone()), ("legacy", policy(lp)), ("shared", policy(sp)), ("equal", Exact::Bool(equal))])
            })
            .collect(),
    )
}

fn responses_policy_capabilities_table(_case: &Case) -> Exact {
    let table = transport_policy::CAPABILITIES.iter().map(|(name, c)| ((*name).to_owned(), caps(*c))).collect();
    object(vec![("capabilities", Exact::Object(table)), ("full", caps(transport_policy::FULL))])
}

fn responses_policy_openai_direct_ws_delta(case: &Case) -> Exact {
    let args = &args_of(case, &format!("{POLICY}resolveResponsesTransportPolicy"))[0];
    object(vec![("direct", responses_policy(args))])
}

fn responses_policy_xai(case: &Case) -> Exact {
    let calls = args_of(case, &format!("{POLICY}resolveResponsesTransportPolicy"));
    let names = ["auto", "explicitAuto", "wsDelta", "wsFull", "httpSse"];
    assert_eq!(calls.len(), names.len());
    object(names.iter().zip(&calls).map(|(name, args)| (*name, responses_policy(args))).collect())
}

fn gate_transport_mode_down_shifts(case: &Case) -> Exact {
    let calls = args_of(case, &format!("{POLICY}_gateTransportMode"));
    // The recorder gates the four modes under each capability set in turn: its three named sets, then the full one.
    let names = ["noDelta", "httpOnly", "wsOnly", "full"];
    assert_eq!(calls.len(), names.len() * 4);
    let gated = names
        .iter()
        .zip(calls.chunks(4))
        .map(|(name, group)| {
            let rows = group
                .iter()
                .map(|args| Exact::Array(vec![args[0].clone(), mode(transport_policy::gate(mode_of(&args[0]), capabilities(&args[1])))]))
                .collect();
            ((*name).to_owned(), Exact::Array(rows))
        })
        .collect();
    let named = names[..3].iter().zip(calls.chunks(4)).map(|(name, group)| ((*name).to_owned(), group[0][1].clone())).collect();
    object(vec![("caps", Exact::Object(named)), ("gated", Exact::Object(gated))])
}

/// A recorded progress kind: the name `onStreamDelta(kind)` carries, `transport` for a chunk that reports none.
fn progress_kind(arg: &Exact) -> Option<ProgressKind> {
    match arg {
        Exact::Undefined => None,
        other => match other.as_str() {
            "transport" => None,
            "semantic" => Some(ProgressKind::Semantic),
            "text" => Some(ProgressKind::Text),
            "reasoning" => Some(ProgressKind::Reasoning),
            "tool" => Some(ProgressKind::Tool),
            name => panic!("not a progress kind: {name}"),
        },
    }
}

fn stream_progress_visible_ttft(case: &Case) -> Exact {
    let visible = args_of(case, "stream-progress.mjs.isVisibleStreamProgress");
    let shown = |args: &Vec<Exact>| Exact::Bool(progress_kind(&args[0]).is_some_and(ProgressKind::is_visible));
    let named = visible[..5].iter().map(|args| (args[0].as_str().to_owned(), shown(args))).collect();
    let gemini = args_of(case, "gemini-stream.mjs.geminiChunkProgressKind")
        .iter()
        .map(|args| {
            let kind = chunk_progress(&crate::provider_cases::plain(&args[0])).map_or("transport", ProgressKind::name);
            object(vec![("chunk", args[0].clone()), ("kind", string(kind))])
        })
        .collect();
    object(vec![("visible", Exact::Object(named)), ("undefinedKind", shown(&visible[5])), ("gemini", Exact::Array(gemini))])
}

#[test]
fn every_pure_case_replays_as_node_recorded_it() {
    let replays: [(&str, fn(&Case) -> Exact); 11] = [
        ("stream-progress-visible-ttft", stream_progress_visible_ttft),
        ("policy-defaults-and-modes", policy_defaults_and_modes),
        ("response-frame-omits-transport-fields", response_frame_omits_transport_fields),
        ("mode-token-aliases", mode_token_aliases),
        ("ws-delta-drives-computeDelta-delta-frame", compute_delta_case),
        ("ws-full-forces-computeDelta-full", compute_delta_case),
        ("responses-policy-full-caps-equal-legacy", responses_policy_full_caps_equal_legacy),
        ("responses-policy-capabilities-table", responses_policy_capabilities_table),
        ("responses-policy-openai-direct-ws-delta", responses_policy_openai_direct_ws_delta),
        ("responses-policy-xai", responses_policy_xai),
        ("gate-transport-mode-down-shifts", gate_transport_mode_down_shifts),
    ];
    let set = CaseSet::load(SET);
    let pure = pure_ids(&set);
    for (id, replay) in replays {
        assert!(pure.contains(&id.to_owned()), "{id} is a PURE case of {SET}");
        let case = set.case(id);
        assert_result(&set, case, &replay(case));
    }
}
