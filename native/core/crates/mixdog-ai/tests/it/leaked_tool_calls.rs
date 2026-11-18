//! A model that writes a tool call as markup in its text instead of a structured call: the guard hides the markup from the
//! visible text and, when the call names a tool the request offered, recovers it; every other text is kept as it is.

use std::collections::HashSet;

use mixdog_ai::providers::leak::LeakGuard;
use mixdog_ai::providers::leak::Recovered;
use mixdog_ai::providers::leak::anthropic_call;
use mixdog_ai::providers::leak::dedupe_list;
use mixdog_ai::providers::leak::gemini_call;
use mixdog_ai::providers::leak::openai_call;
use mixdog_core_api::domain::provider::ToolCall;
use serde_json::Value;
use serde_json::json;

fn guard(harmony: bool) -> LeakGuard {
    LeakGuard::new(["read".to_owned(), "write".to_owned()].into_iter().collect(), harmony)
}

type Seen = (String, Vec<(String, Value)>);

/// The visible text and the calls of a whole stream pushed chunk by chunk, then flushed.
fn stream(guard: &mut LeakGuard, chunks: &[&str]) -> Seen {
    let (mut text, mut calls) = (String::new(), Vec::new());
    let mut take = |(shown, found): (String, Vec<Recovered>)| {
        text.push_str(&shown);
        calls.extend(found.into_iter().map(|c| (c.name, Value::Object(c.arguments))));
    };
    for chunk in chunks {
        take(guard.push(chunk, false));
    }
    take(guard.flush());
    (text, calls)
}

fn whole(text: &str) -> Seen {
    stream(&mut guard(false), &[text])
}

fn wrapped(params: &[(&str, &str)]) -> String {
    let inner: String = params.iter().map(|(name, value)| format!(r#"<parameter name="{name}">{value}</parameter>"#)).collect();
    format!(r#"<function_calls><invoke name="read">{inner}</invoke></function_calls>"#)
}

fn read_a() -> (String, Value) {
    ("read".to_owned(), json!({ "path": "a.txt" }))
}

#[test]
fn a_call_written_as_markup_is_removed_from_the_text_and_recovered_when_its_tool_was_offered() {
    let call = wrapped(&[("path", "a.txt")]);
    assert_eq!(whole(&format!("before {call} after")), ("before  after".to_owned(), vec![read_a()]));
    // The same call in the spellings models use: a bare invoke, a function element, another case, a namespace prefix.
    let ns = "antml:";
    let spellings = [
        r#"<invoke name="read"><parameter name="path">a.txt</parameter></invoke>"#.to_owned(),
        r#"<function name="read"><parameter name="path">a.txt</parameter></function>"#.to_owned(),
        r#"<INVOKE NAME='read'><PARAMETER NAME=path>a.txt</PARAMETER></INVOKE>"#.to_owned(),
        format!(r#"<{ns}function_calls><{ns}invoke name="read"><{ns}parameter name="path">a.txt</{ns}parameter></{ns}invoke></{ns}function_calls>"#),
    ];
    for spelling in spellings {
        assert_eq!(whole(&format!("x{spelling}y")), ("xy".to_owned(), vec![read_a()]), "{spelling}");
    }
}

#[test]
fn a_parameters_text_is_read_as_json_when_it_looks_like_json_and_is_otherwise_kept_as_written() {
    let (_, calls) = whole(&wrapped(&[
        ("n", "3"),
        ("neg", "-5"),
        ("flag", "true"),
        ("nothing", "null"),
        ("obj", r#"{"a":1}"#),
        ("list", "[1,2]"),
        ("quoted", r#""q""#),
        ("padded", " 7 "),
        ("plain", " hello "),
        ("broken", "{oops"),
        ("empty", ""),
    ]));
    assert_eq!(
        calls[0].1,
        json!({ "n": 3, "neg": -5, "flag": true, "nothing": null, "obj": { "a": 1 }, "list": [1, 2], "quoted": "q", "padded": 7, "plain": " hello ", "broken": "{oops", "empty": "" })
    );
}

#[test]
fn markup_that_names_a_tool_the_request_did_not_offer_stays_visible_and_nothing_is_scanned_without_tools() {
    let unknown = r#"<invoke name="rm"><parameter name="path">/</parameter></invoke>"#;
    assert_eq!(whole(&format!("a {unknown} b")), (format!("a {unknown} b"), vec![]));
    let call = wrapped(&[("path", "a.txt")]);
    let mut none = LeakGuard::new(HashSet::new(), false);
    assert!(!none.enabled());
    assert_eq!(stream(&mut none, &[&call]), (call, vec![]));
}

#[test]
fn a_call_inside_a_code_fence_or_inline_code_is_documentation_and_stays_visible() {
    let call = wrapped(&[("path", "a.txt")]);
    for text in [format!("Example:\n```xml\n{call}\n```\nDone."), format!("Use `{call}` to read."), format!("~~~\n{call}\n~~~")] {
        assert_eq!(whole(&text), (text.clone(), vec![]), "{text}");
    }
    // After the fence closes a real call is recovered again.
    let (text, calls) = whole(&format!("```\nx\n```\n{call}"));
    assert_eq!((text.as_str(), calls.len()), ("```\nx\n```\n", 1));
}

#[test]
fn the_result_does_not_depend_on_where_the_stream_is_cut() {
    let call = wrapped(&[("path", "a.txt")]);
    let text = format!("héllo 😀 <b>x</b> {call} tail <func");
    let expected = whole(&text);
    assert_eq!(expected.1, vec![read_a()]);
    assert_eq!(expected.0, "héllo 😀 <b>x</b>  tail <func");
    for at in text.char_indices().map(|(i, _)| i).chain([text.len()]) {
        assert_eq!(stream(&mut guard(false), &[&text[..at], &text[at..]]), expected, "cut at {at}");
    }
}

#[test]
fn the_start_of_a_possible_opener_is_held_back_until_the_next_chunk_decides_it() {
    let mut pending = guard(false);
    assert_eq!(pending.push("see <func", false), ("see ".to_owned(), vec![]));
    assert_eq!(pending.push("tional> ok", false).0, "<functional> ok", "it was not an opener after all");
    let mut unfinished = guard(false);
    assert_eq!(unfinished.push(r#"x <invoke name="read"> never closed"#, false), ("x ".to_owned(), vec![]));
    let (rest, calls) = unfinished.flush();
    assert_eq!((rest.as_str(), calls.len()), (r#"<invoke name="read"> never closed"#, 0), "a block that never finished is text");
    let mut held = guard(false);
    held.push("end <inv", false);
    assert_eq!(held.flush().0, "<inv");
    assert_eq!(whole("a < b, <div>x</div> and <functional>"), ("a < b, <div>x</div> and <functional>".to_owned(), vec![]));
}

#[test]
fn a_harmony_call_is_recovered_only_for_a_harmony_model_and_only_for_an_offered_tool() {
    let call = r#"<|channel|>commentary to=functions.read <|message|>{"path":"a.txt"}<|call|>"#;
    assert_eq!(stream(&mut guard(true), &[&format!("a{call}b")]), ("ab".to_owned(), vec![read_a()]));
    assert_eq!(stream(&mut guard(false), &[call]), (call.to_owned(), vec![]), "any other model's text is kept");
    let unknown = r#"<|channel|>commentary to=functions.nope <|message|>{}<|call|>"#;
    assert_eq!(stream(&mut guard(true), &[unknown]), (unknown.to_owned(), vec![]));
    let thinking = "<|channel|>analysis<|message|>hmm<|end|>";
    assert_eq!(stream(&mut guard(true), &[thinking]).1, vec![], "a block that calls no function recovers nothing");
}

#[test]
fn a_finished_text_is_scrubbed_in_one_pass_with_an_unfinished_block_left_in_place() {
    let call = wrapped(&[("path", "a.txt")]);
    let (text, calls) = guard(false).scrub(&format!("hi {call} bye"));
    assert_eq!((text.as_str(), calls.len()), ("hi  bye", 1));
    let unfinished = r#"hi <invoke name="read"> and then"#;
    assert_eq!(guard(false).scrub(unfinished), (unfinished.to_owned(), vec![]));
    assert_eq!(guard(false).scrub(""), (String::new(), vec![]));
}

#[test]
fn a_recovered_call_gets_an_id_that_says_it_was_recovered() {
    let recovered = || Recovered { name: "read".into(), arguments: json!({ "path": "a.txt" }).as_object().unwrap().clone() };
    let (openai, anthropic) = (openai_call(recovered()), anthropic_call(recovered()));
    assert!(openai.id.starts_with("call_leaked_") && openai.id.len() == "call_leaked_".len() + 16, "{}", openai.id);
    assert!(anthropic.id.starts_with("toolu_leaked_") && anthropic.id.len() == "toolu_leaked_".len() + 16, "{}", anthropic.id);
    assert_ne!(openai_call(recovered()).id, openai.id, "a minted id is drawn each time");
    assert_eq!((openai.name.as_str(), &openai.arguments), ("read", &json!({ "path": "a.txt" })));
    // Gemini's is a function of the call itself.
    let (first, again) = (gemini_call(recovered()), gemini_call(recovered()));
    assert_eq!(first.id, again.id);
    assert!(first.id.starts_with("gemini_leaked_"));
    let other = Recovered { name: "read".into(), arguments: json!({ "path": "b.txt" }).as_object().unwrap().clone() };
    assert_ne!(gemini_call(other).id, first.id);
}

#[test]
fn a_list_of_calls_drops_a_repeated_id_a_leak_the_native_path_carries_and_an_exact_repeat_and_keeps_the_order() {
    let call = |id: &str, name: &str, path: &str| ToolCall { id: id.into(), name: name.into(), arguments: json!({ "path": path }), native_type: None };
    let kept = dedupe_list(vec![
        call("call_1", "read", "a"),
        call("call_1", "read", "a"),
        call("call_leaked_aa", "read", "a"),
        call("call_leaked_bb", "write", "b"),
        call("call_leaked_cc", "write", "b"),
        call("", "write", "c"),
        call("", "write", "c"),
        call("call_2", "write", "b"),
    ]);
    let ids: Vec<&str> = kept.iter().map(|c| c.id.as_str()).collect();
    // The leaks of `read a` and `write b` are the native calls' own; the id-less `write c` is kept once.
    assert_eq!(ids, ["call_1", "", "call_2"]);
}
