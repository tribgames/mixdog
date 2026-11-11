//! `fixtures/provider-gemini-history-signatures` (PURE): the history lowering and first-call signature repair of the
//! Google request builder. `toGeminiContents(history, model)` is the Gemini API codec's `contents`
//! (`GoogleCodec::gemini(..).build_inner`), `buildAntigravityRequest(history, model, [], {}, 'fixture').request.contents`
//! the Antigravity codec's for project `fixture`, and `createProviderReplay('gemini', parts)` the replay envelope the
//! Gemini decoder writes (its `parts`). The recorded result is rebuilt from those answers and compared whole.

use std::sync::Arc;

use mixdog_ai::providers::google::codec::GoogleCodec;
use mixdog_ai::providers::google::traits::CatalogGoogleTraits;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderReplay;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_protocol::ProviderId;
use mixdog_testkit::Exact;
use serde_json::json;

use crate::provider_case::Case;
use crate::provider_case::CaseSet;
use crate::provider_case::assert_exact;
use crate::provider_case::plain;
use crate::provider_cases;
use crate::replay_world;

/// A recorded history: the transcript messages, an assistant turn's `providerReplay` (`{version, provider, items}`)
/// as the replay envelope the Gemini decoder writes (`{parts}`, owned by the provider).
fn history(node: &Exact) -> Vec<mixdog_core_api::domain::provider::Message> {
    node.as_array()
        .iter()
        .map(|entry| {
            let Exact::Object(entries) = entry else { panic!("a message") };
            let replay = entries.iter().find(|(k, _)| k == "providerReplay").map(|(_, v)| v);
            let rest = Exact::Object(entries.iter().filter(|(k, _)| k != "providerReplay").cloned().collect());
            let mut message = replay_world::message(&rest);
            if let Some(replay) = replay {
                assert_eq!(replay.get("version").as_f64(), 1.0, "a version-1 envelope");
                message.push_replay(ProviderReplay {
                    owner: ProviderId::from(replay.get("provider").as_str()),
                    items: json!({ "parts": provider_cases::plain(replay.get("items")) }),
                });
            }
            message
        })
        .collect()
}

fn traits() -> Arc<CatalogGoogleTraits> {
    Arc::new(CatalogGoogleTraits(Vec::new()))
}

fn contents(codec: &GoogleCodec, args: &[Exact]) -> Exact {
    let request = ModelRequest {
        model: args[1].as_str().to_owned(),
        messages: history(&args[0]),
        tools: Vec::new(),
        options: RequestOptions::default(),
    };
    let inner = codec.build_inner(&request).unwrap_or_else(|e| panic!("{}: {}", request.model, e.message));
    plain(&inner["contents"])
}

/// One recorded call's answer.
fn answer(call: &crate::provider_case::Call) -> Exact {
    let args = &call.args;
    match call.entry.rsplit('.').next().expect("an entry") {
        "toGeminiContents" => contents(&GoogleCodec::gemini("https://generativelanguage.googleapis.com", traits()), args),
        "buildAntigravityRequest" => {
            assert!(args[2].as_array().is_empty() && args[3].entries().is_empty(), "no tools, no options");
            let codec = GoogleCodec::antigravity("https://daily-cloudcode-pa.googleapis.com", args[4].as_str(), "1.0.0", traits());
            contents(&codec, &args[..2])
        }
        // The envelope's parts are the parts handed in.
        "createProviderReplay" => {
            assert_eq!(args[0].as_str(), "gemini");
            let replay = ProviderReplay { owner: ProviderId::from("gemini"), items: json!({ "parts": provider_cases::plain(&args[1]) }) };
            plain(&replay.items["parts"])
        }
        other => panic!("entry {other}"),
    }
}

/// The model turn's parts of `contents`.
fn model_parts(contents: &Exact) -> Exact {
    contents.as_array().iter().find(|c| c.get("role").as_str() == "model").expect("a model turn").get("parts").clone()
}

fn object(entries: Vec<(&str, Exact)>) -> Exact {
    Exact::Object(entries.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

fn rebuild(case: &Case, out: &[Exact]) -> Exact {
    match case.id.as_str() {
        // The core takes the history by reference: what the call saw is what remains.
        "first-foreign-call-repaired" => object(vec![
            ("contents", object(vec![("gemini", out[0].clone()), ("antigravity", out[1].clone())])),
            ("historyAfter", case.calls[0].args[0].clone()),
        ]),
        "native-signatures-unchanged" => object(vec![
            ("replayParts", out[0].clone()),
            ("camelOut", model_parts(&out[1])),
            ("snakeParts", out[2].clone()),
            ("snakeOut", model_parts(&out[3])),
        ]),
        "earlier-turns-and-non-gemini-untouched" => {
            object(vec![("claudeModel", out[0].clone()), ("geminiNewTurn", out[1].clone()), ("antigravityNewTurn", out[2].clone())])
        }
        "any-gemini-id" => Exact::Object(
            case.calls.iter().zip(out).map(|(call, contents)| (call.args[1].as_str().to_owned(), contents.clone())).collect(),
        ),
        "sequential-steps-signed" => object(vec![("history", case.calls[0].args[0].clone()), ("contents", out[0].clone())]),
        other => panic!("case {other}"),
    }
}

#[test]
fn every_case_lowers_as_nodes() {
    let set = CaseSet::load("gemini-history-signatures");
    assert_eq!(set.cases.len(), 5, "the recorded cases");
    for case in &set.cases {
        let out: Vec<Exact> = case.calls.iter().map(answer).collect();
        assert_exact(&format!("provider-gemini-history-signatures {}: result", case.id), case.result(), &rebuild(case, &out));
    }
}
