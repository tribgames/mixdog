//! The entry reads every command line of the recorded corpus (`goldens/argv.json`, written by `recorders/record-argv.mjs` from
//! Node's `classifyCliInvocation`: every option alone, with values, with dash values, with `exec` at each position, `--`
//! placements, duplicates, unknown options, unicode messages, the empty line) as Node's CLI did: the same kind, refusal text,
//! host-prelude skip, message and options.

#[path = "../src/argv.rs"]
mod argv;

use argv::Invocation;
use argv::Kind;
use argv::Worktree;
use mixdog_cli::exec::ToolMode;
use serde_json::Value;
use serde_json::json;

/// The recorder's `record` shape of a classification.
fn recorded(argv: &[String], invocation: &Invocation) -> Value {
    let (kind, error, message) = match &invocation.kind {
        Kind::Error(text) => ("error", Some(text.as_str()), None),
        Kind::Help => ("help", None, None),
        Kind::Plain => ("plain", None, None),
        Kind::React => ("react", None, None),
        Kind::Exec { message } => ("exec", None, Some(message.as_str())),
        Kind::General => ("general", None, None),
    };
    let options = invocation.options.as_ref().map(|options| {
        let worktree = options.worktree.as_ref().map(|worktree| match worktree {
            Worktree::New(name) => json!({ "mode": "worktree", "name": name }),
            Worktree::Branch => json!({ "mode": "branch", "name": null }),
        });
        json!({
            "worktree": worktree,
            "provider": options.provider,
            "model": options.model,
            "effort": options.effort,
            "fast": options.fast,
            "webSearch": options.web_search,
            "json": options.json,
            "toolMode": if options.tool_mode == ToolMode::Readonly { "readonly" } else { "full" },
            "remote": options.remote,
            "forceOnboarding": options.force_onboarding,
        })
    });
    json!({ "argv": argv, "kind": kind, "error": error, "skipHostPrelude": invocation.skip_host_prelude, "message": message, "options": options })
}

#[test]
fn every_recorded_command_line_is_read_as_nodes_cli_read_it() {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("tests/goldens/argv.json")).unwrap();
    let cases = golden["cases"].as_array().unwrap();
    assert!(cases.len() > 3000, "the corpus is {} lines", cases.len());
    let mut differences = Vec::new();
    for case in cases {
        let words: Vec<String> = case["argv"].as_array().unwrap().iter().map(|word| word.as_str().unwrap().to_owned()).collect();
        let got = recorded(&words, &argv::classify(&words));
        if &got != case {
            differences.push(format!("{}\n  Node: {case}\n  core: {got}", case["argv"]));
        }
    }
    assert!(differences.is_empty(), "{} of {} line(s) differ from Node's CLI; the first:\n{}", differences.len(), cases.len(), differences.iter().take(5).cloned().collect::<Vec<_>>().join("\n"));
}

/// The exec lines of the read-only recording (`fixtures/exec-readonly/cli.json`, Node's `classifyCliInvocation` on the read-only
/// runtime's command lines): the core's `--tool-mode` spelling and `--readonly` are refused on an exec as Node refused them.
#[test]
fn the_read_only_recordings_exec_lines_are_read_as_nodes_cli_read_them() {
    let recorded_lines: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/exec-readonly/cli.json")).unwrap();
    for case in recorded_lines.as_array().unwrap() {
        let words: Vec<String> = case["argv"].as_array().unwrap().iter().map(|word| word.as_str().unwrap().to_owned()).collect();
        let got = recorded(&words, &argv::classify(&words));
        let node = &case["result"];
        assert_eq!(got["kind"], node["kind"], "{words:?}");
        assert_eq!(got["skipHostPrelude"], node["skipHostPrelude"], "{words:?}");
        assert_eq!(got["error"], node.get("error").cloned().unwrap_or(Value::Null), "{words:?}");
        assert_eq!(got["message"], node["exec"].get("message").cloned().unwrap_or(Value::Null), "{words:?}");
        if let Some(options) = node.get("options").and_then(Value::as_object) {
            for (name, value) in options {
                assert_eq!(&got["options"][name], value, "{words:?}: {name}");
            }
        }
    }
}
