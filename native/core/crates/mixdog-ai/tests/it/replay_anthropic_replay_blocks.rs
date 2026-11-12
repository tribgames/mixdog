//! `fixtures/provider-anthropic-replay-blocks` (PURE): `sanitizeAnthropicReplayBlocks` / `…Entries` / `…ThinkingRun`
//! against `mixdog_ai::providers::anthropic::replay_blocks`, the reduction the decoder applies to a turn's blocks.

use mixdog_ai::providers::anthropic::replay_blocks;
use mixdog_testkit::Exact;
use serde_json::Value;

use crate::provider_case::CaseSet;
use crate::provider_case::plain;
use crate::provider_cases;

fn blocks(value: &[Value]) -> Exact {
    plain(&Value::Array(value.to_vec()))
}

/// A recorded block index: a JS number, whose plain form is a float; Node's indices are whole.
fn index(value: &Value) -> u64 {
    let n = value.as_f64().expect("an index");
    assert!(n >= 0.0 && n.fract() == 0.0, "index {n}");
    n as u64
}

/// One recorded call: the reduced blocks and the drops its `onDrop` saw (`None` when the call passed none).
fn run(entry: &str, args: &[Exact]) -> (Exact, Option<Exact>) {
    let mut drops = Vec::new();
    let mut note = |dropped: replay_blocks::Dropped, _: &Value| drops.push(Exact::String(dropped.kind().into()));
    let input = provider_cases::plain(&args[0]);
    let list = input.as_array().expect("a list");
    let out = match entry {
        "sanitizeAnthropicReplayBlocks" => replay_blocks::sanitize(list, &mut note),
        "sanitizeAnthropicThinkingRun" => replay_blocks::thinking_run(list, &mut note),
        "sanitizeAnthropicReplayEntries" => {
            let entries: Vec<(u64, Value)> =
                list.iter().map(|pair| (index(&pair[0]), pair[1].clone())).collect();
            replay_blocks::sanitize_entries(&entries, &mut note)
        }
        other => panic!("entry {other}"),
    };
    let observed = args.get(1).map(|_| Exact::Array(drops));
    (blocks(&out), observed)
}

pub const REPLAYS: &[crate::provider_case::Replay] = &[crate::provider_case::Replay { set: "anthropic-replay-blocks", run: every_case_reduces_as_nodes }];

#[test]
fn every_case_reduces_as_nodes() {
    let set = CaseSet::load("anthropic-replay-blocks");
    for case in &set.cases {
        let calls: Vec<(Exact, Option<Exact>)> =
            case.calls.iter().map(|call| run(call.entry.rsplit('.').next().expect("entry"), &call.args)).collect();
        let result = if case.id == "idempotent" {
            provider_cases::object(vec![("once", calls[0].0.clone()), ("twice", calls[1].0.clone())])
        } else {
            assert_eq!(calls.len(), 1, "{}: one call", case.id);
            let (out, drops) = calls[0].clone();
            let mut entries = vec![("blocks", out)];
            if let Some(drops) = drops {
                entries.push(("drops", drops));
            }
            provider_cases::object(entries)
        };
        provider_cases::assert_result(&set, case, &result);
    }
}
