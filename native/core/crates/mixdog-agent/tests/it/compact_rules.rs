//! Rules of the compaction helpers, each stated on a small transcript written in the test: what the meter
//! prices, which ids a compaction reports as dropped, the shape every summary must have and how a broken one
//! is repaired, which tool results a later observation replaces, and what is hidden from the summary's input.

use crate::compact_support;

use compact_support::NoBlobs;
use compact_support::NoRedaction;
use compact_support::Rows;
use compact_support::replay_owner;
use mixdog_agent::compact::dropped::dropped_summary;
use mixdog_agent::compact::estimate::MediaMeter;
use mixdog_agent::compact::estimate::MessageMeter;
use mixdog_agent::compact::estimate::PartMeter;
use mixdog_agent::compact::observation::stale_observations;
use mixdog_agent::compact::observation::supersede_observation;
use mixdog_agent::compact::redact::redact_tool_call_secrets;
use mixdog_agent::compact::summary::COMPACTION_SYSTEM_PROMPT;
use mixdog_agent::compact::summary::HandoffMeta;
use mixdog_agent::compact::summary::build_compaction_prompt;
use mixdog_agent::compact::summary::enforce_compact_summary_schema;
use mixdog_agent::compact::summary::fit_complete_compaction_prompt;
use mixdog_agent::compact::summary::fit_generated_handoff_message;
use mixdog_agent::compact::summary::forked_compaction_prompt;
use mixdog_agent::compact::summary_run::SummaryMode;
use mixdog_agent::compact::summary_schema::minimal_schema_summary;
use mixdog_agent::compact::summary_schema::summary_is_schema_valid;
use mixdog_agent::message::AgentMessage;
use mixdog_agent::message::Source;
use mixdog_agent::message::ToolKind;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::ImageSource;
use mixdog_core_api::domain::provider::ProviderReplay;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_protocol::ProviderId;
use mixdog_protocol::message_class::user_text::UserText;
use serde_json::json;

struct TextOnly;
impl MediaMeter for TextOnly {
    fn part(&self, part: &ContentPart) -> PartMeter {
        panic!("media part in a text-only transcript: {part:?}")
    }
}

fn call(id: &str, name: &str, arguments: serde_json::Value) -> ToolCall {
    ToolCall { id: id.into(), name: name.into(), arguments, native_type: None }
}

fn asks(calls: Vec<ToolCall>) -> AgentMessage {
    AgentMessage::assistant(String::new(), calls)
}

fn with_id(id: &str, mut message: AgentMessage) -> AgentMessage {
    message.message_id = Some(id.to_owned());
    message
}

// ---- the meter -------------------------------------------------------------------------------------------

#[test]
fn a_message_costs_its_text_plus_a_fixed_per_message_overhead() {
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    assert_eq!(meter.message(&AgentMessage::user("")), 4, "an empty message still costs its framing");
    let all = [AgentMessage::user("one"), AgentMessage::assistant("two words here", Vec::new())];
    assert_eq!(meter.messages(&all), meter.message(&all[0]) + meter.message(&all[1]));
}

#[test]
fn a_tool_result_a_tool_call_and_wide_text_all_cost_more_than_plain_text() {
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    // The result is priced with the id it answers.
    let plain = meter.message(&AgentMessage::user("ok"));
    let result = meter.message(&AgentMessage::tool_text("call_0123456789", "ok", ToolKind::Normal));
    assert!(result > plain, "{result} vs {plain}");
    // The assistant's calls are part of what it sent.
    let bare = meter.message(&AgentMessage::assistant("run", Vec::new()));
    let calling = meter.message(&asks(vec![call("c1", "bash", json!({ "command": "cargo test --workspace --all-features" }))]));
    assert!(calling > bare + 8, "{calling} vs {bare}");
    // Hangul and emoji cost more per character than ASCII.
    let ascii = meter.message(&AgentMessage::user("a ".repeat(50)));
    let hangul = meter.message(&AgentMessage::user("한 ".repeat(50)));
    assert!(hangul > ascii, "{hangul} vs {ascii}");
}

#[test]
fn only_the_replay_of_the_sessions_own_provider_is_priced() {
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    let items = json!([{ "type": "message", "content": "x ".repeat(300) }]);
    let bare = AgentMessage::assistant("answer", Vec::new());
    let mut foreign = bare.clone();
    foreign.message.push_replay(ProviderReplay { owner: ProviderId::from("another-provider"), items: items.clone() });
    let mut own = bare.clone();
    own.message.push_replay(ProviderReplay { owner: owner.clone(), items });
    assert_eq!(meter.message(&foreign), meter.message(&bare), "another provider's envelope is never replayed");
    assert!(meter.message(&own) > meter.message(&bare) + 100);
}

// ---- what a compaction reports as dropped -----------------------------------------------------------------

fn transcript_for_dropping() -> Vec<AgentMessage> {
    vec![
        with_id("u1", AgentMessage::user("first request")),
        with_id("a1", AgentMessage::assistant("checking", vec![call("c1", "read", json!({ "path": "a" })), call("c2", "read", json!({ "path": "b" }))])),
        with_id("t1", AgentMessage::tool_text("c1", "contents a", ToolKind::Normal)),
        with_id("t2", AgentMessage::tool_text("c2", "contents b", ToolKind::Normal)),
        with_id("u2", AgentMessage::user("next request")),
    ]
}

#[test]
fn dropped_ids_are_the_messages_that_left_and_the_calls_that_left_in_transcript_order() {
    let before = transcript_for_dropping();
    // The first request and the results are gone; the assistant stays with its text and only its second call.
    let kept_assistant = with_id("a1", AgentMessage::assistant("checking", vec![before[1].tool_calls()[1].clone()]));
    let after = vec![kept_assistant, before[4].clone()];
    let blobs = NoBlobs;
    let (count, dropped) = dropped_summary(&before, &after, &Rows, &NoRedaction, &mut UserText::new(&blobs));
    let dropped = dropped.expect("the transcript shows what left");
    assert_eq!(count, 3, "u1, t1 and t2 left; a1 only lost a call");
    assert_eq!(dropped.message_ids, ["u1", "t1", "t2"], "a1 kept its text, so its row stays");
    assert_eq!(dropped.call_ids, ["c1", "c2"], "c1 left with its assistant part and result, c2 with its result");
}

#[test]
fn nothing_dropped_reports_no_ids() {
    let before = transcript_for_dropping();
    let blobs = NoBlobs;
    let (count, dropped) = dropped_summary(&before, &before, &Rows, &NoRedaction, &mut UserText::new(&blobs));
    assert_eq!(count, 0);
    assert!(dropped.is_none());
}

#[test]
fn a_message_without_a_stable_id_is_never_reported_dropped() {
    let before = vec![AgentMessage::user("no id"), with_id("u2", AgentMessage::user("kept"))];
    let after = vec![before[1].clone()];
    let blobs = NoBlobs;
    let (count, dropped) = dropped_summary(&before, &after, &Rows, &NoRedaction, &mut UserText::new(&blobs));
    assert_eq!((count, dropped.is_none()), (0, true));
}

// ---- the summary's structure -------------------------------------------------------------------------------

const SECTIONS: [&str; 7] =
    ["## Goal", "## Constraints & Preferences", "## Progress", "## Key Decisions", "## Next Steps", "## Critical Context", "## Relevant Files"];

fn heading_positions(text: &str) -> Vec<usize> {
    SECTIONS.iter().map(|h| text.find(h).unwrap_or_else(|| panic!("{h} missing in:\n{text}"))).collect()
}

fn in_order(positions: &[usize]) -> bool {
    positions.windows(2).all(|w| w[0] < w[1])
}

#[test]
fn the_summary_instructions_ask_for_every_section_in_order_and_forbid_talking_about_the_summary() {
    let forked = forked_compaction_prompt();
    assert!(in_order(&heading_positions(&forked)));
    assert!(forked.contains("No tools are available"), "a forked summary must not call tools");
    assert!(forked.starts_with("<compaction-request>") && forked.ends_with("</compaction-request>"));
    let prompt = build_compaction_prompt(&[AgentMessage::user("hello")], None);
    assert!(in_order(&heading_positions(&prompt)), "the isolated prompt carries the same structure");
    for text in [COMPACTION_SYSTEM_PROMPT, &forked] {
        assert!(text.contains("Do not mention that you are summarizing"), "{text}");
        assert!(text.contains("same language as the conversation"), "{text}");
    }
    assert!(COMPACTION_SYSTEM_PROMPT.contains("<previous-summary>"), "the system prompt explains the previous-summary block");
    assert!(prompt.contains("Attribute every decision"), "decisions must be credited to their source");
    assert!(prompt.contains("announced, not started"), "an announced but unstarted step is not recorded as done");
}

#[test]
fn the_prompt_lists_the_history_in_order_and_carries_the_previous_summary_only_when_there_is_one() {
    let head = vec![AgentMessage::user("fix the parser"), AgentMessage::assistant("on it", Vec::new())];
    let fresh = build_compaction_prompt(&head, None);
    assert!(fresh.starts_with("Create a new anchored summary"));
    assert!(!fresh.contains("<previous-summary>"));
    let at = |needle: &str| fresh.find(needle).unwrap_or_else(|| panic!("{needle} missing"));
    assert!(at("1. user:\nfix the parser") < at("2. assistant:\non it"));
    assert!(at("<conversation-history>") < at("1. user:") && at("2. assistant:") < at("</conversation-history>"));

    let updated = build_compaction_prompt(&head, Some("## Goal\n- old goal"));
    assert!(updated.starts_with("Update the anchored summary below"));
    assert!(updated.contains("<previous-summary>\n## Goal\n- old goal\n</previous-summary>"));

    let empty = build_compaction_prompt(&[], Some("## Goal\n- x"));
    assert!(empty.contains("[No additional older messages before the preserved recent tail.]"));
}

#[test]
fn a_prompt_is_offered_only_when_it_and_the_system_prompt_fit_the_target() {
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    let head = vec![AgentMessage::user("fix the parser")];
    let prompt = build_compaction_prompt(&head, None);
    let mut system = AgentMessage::user(COMPACTION_SYSTEM_PROMPT);
    system.message.role = mixdog_core_api::domain::provider::Role::System;
    let needed = meter.messages(&[system, AgentMessage::user(prompt.clone())]);
    assert_eq!(fit_complete_compaction_prompt(&meter, &head, None, needed), Some(prompt));
    assert_eq!(fit_complete_compaction_prompt(&meter, &head, None, needed - 1), None);
}

fn valid_summary() -> String {
    SECTIONS
        .iter()
        .map(|h| {
            if *h == "## Progress" {
                format!("{h}\n### Done\n- parsed\n\n### In Progress\n- (none)\n\n### Blocked\n- (none)")
            } else {
                format!("{h}\n- body of {h}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[test]
fn a_complete_summary_is_accepted_as_written_and_an_empty_one_is_left_empty() {
    assert!(summary_is_schema_valid(&valid_summary()));
    let padded = format!("\n  {}\n\n", valid_summary());
    let kept = enforce_compact_summary_schema(&padded, &[], &[]);
    assert_eq!((kept.summary.as_str(), kept.repaired), (valid_summary().as_str(), false), "only trimmed");
    let empty = enforce_compact_summary_schema("  \n", &[], &[]);
    assert_eq!((empty.summary.as_str(), empty.repaired), ("", false), "an empty answer is rejected by the caller, not repaired");
}

#[test]
fn a_heading_only_counts_when_it_names_a_section_and_a_foreign_heading_makes_the_summary_invalid() {
    assert!(!summary_is_schema_valid(&valid_summary().replace("## Goal", "## Goalkeeper")), "a longer word is not the section");
    assert!(!summary_is_schema_valid(&format!("{}\n\n## Random Notes\n- x", valid_summary())), "a heading outside the layout");
    let fenced = valid_summary().replace("- body of ## Next Steps", "```\n## Not A Heading\n```");
    assert!(summary_is_schema_valid(&fenced), "a heading inside a code fence is text");
    assert!(summary_is_schema_valid(&minimal_schema_summary()));
}

#[test]
fn a_broken_summary_is_repaired_by_keeping_what_the_model_wrote_and_scaffolding_the_rest() {
    let head = vec![AgentMessage::user("Please fix src/lib.rs and then Cargo.toml"), AgentMessage::assistant("Looking at src/lib.rs again", Vec::new())];
    let tail = vec![AgentMessage::user("now run the tests")];
    let broken = "Stray preamble line\n## Goal\n- ship it\n## Progress\n### Done\n- parsed\n## Next Steps\n- release\n## Random Notes\n- stray";
    let fixed = enforce_compact_summary_schema(broken, &head, &tail);
    assert!(fixed.repaired);
    let text = &fixed.summary;
    assert!(summary_is_schema_valid(text), "{text}");
    assert!(in_order(&heading_positions(text)), "{text}");
    // What the model wrote stays where it was written.
    assert!(text.contains("## Goal\n- ship it"));
    assert!(text.contains("### Done\n- parsed"));
    assert!(text.contains("## Next Steps\n- release"));
    // What it left out is scaffolded; text outside any section is kept under Critical Context.
    assert!(text.contains("## Constraints & Preferences\n- (none)"));
    assert!(text.contains("## Key Decisions\n- (none)"));
    let critical = &text[text.find("## Critical Context").unwrap()..text.find("## Relevant Files").unwrap()];
    for kept in ["- Stray preamble line", "- ## Random Notes", "- stray"] {
        assert!(critical.contains(kept), "{kept} not in {critical}");
    }
    // Relevant files come from the history, each once, in order of appearance.
    assert!(text.ends_with("## Relevant Files\n- src/lib.rs\n- Cargo.toml"), "{text}");
}

#[test]
fn a_missing_goal_is_taken_from_the_latest_request_and_a_summary_with_no_files_says_none() {
    let head = vec![AgentMessage::user("older request")];
    let tail = vec![AgentMessage::user("latest request")];
    let fixed = enforce_compact_summary_schema("## Next Steps\n- x", &head, &tail);
    assert!(fixed.summary.contains("## Goal\n- latest request"), "{}", fixed.summary);
    assert!(fixed.summary.ends_with("## Relevant Files\n- (none)"));
    let from_head = enforce_compact_summary_schema("## Next Steps\n- x", &head, &[]);
    assert!(from_head.summary.contains("## Goal\n- older request"), "the history is the fallback");
}

fn points(section: usize) -> String {
    (0..60).map(|n| format!("- point {n} of section {section}")).collect::<Vec<_>>().join("\n")
}

fn long_summary() -> String {
    SECTIONS
        .iter()
        .enumerate()
        .map(|(s, h)| {
            if *h == "## Progress" {
                format!("{h}\n### Done\n{}\n\n### In Progress\n- (none)\n\n### Blocked\n- (none)", points(s))
            } else {
                format!("{h}\n{}", points(s))
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[test]
fn the_summary_message_names_what_it_replaced_and_shrinks_into_the_room_it_has_without_losing_a_section() {
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    let history = vec![AgentMessage::user("q"), AgentMessage::assistant("a", Vec::new())];
    let meta = HandoffMeta { provider: Some("anthropic"), model: "opus" };
    let summary = long_summary();
    let whole = fit_generated_handoff_message(&meter, &Rows, &history, &summary, 1_000_000, &meta).expect("room enough");
    let text = whole.text();
    assert_eq!(whole.source, Some(Source::CompactSummary));
    assert!(text.contains("messages=2 ") && text.contains("roles=user:1, assistant:1"), "{text}");
    assert!(text.contains("generated_handoff=true provider=anthropic model=opus"));
    for s in 0..SECTIONS.len() {
        for n in [0, 59] {
            assert!(
                text.contains(&format!("- point {n} of section {s}\n")) || text.ends_with(&format!("- point {n} of section {s}")),
                "a summary that fits is kept whole: section {s} point {n}"
            );
        }
    }

    let room = meter.message(&whole) / 3;
    let tight = fit_generated_handoff_message(&meter, &Rows, &history, &summary, room, &meta).expect("the headings still fit");
    assert!(meter.message(&tight) <= room, "{} > {room}", meter.message(&tight));
    let body = &tight.text()[tight.text().find("## Goal").unwrap()..];
    assert!(summary_is_schema_valid(body) && in_order(&heading_positions(body)), "no section is dropped to fit:\n{body}");
    assert!(body.len() < summary.len());

    let unknown = fit_generated_handoff_message(&meter, &Rows, &history, &summary, 10, &HandoffMeta { provider: None, model: "" });
    assert!(unknown.is_none(), "not even the headings fit");
    let anonymous = fit_generated_handoff_message(&meter, &Rows, &history, &summary, 1_000_000, &HandoffMeta { provider: None, model: "" }).unwrap();
    assert!(anonymous.text().contains("provider=unknown model=unknown"));
}

#[test]
fn the_summary_mode_reads_the_saved_choice_and_the_retired_boolean() {
    assert_eq!(SummaryMode::normalize(Some("smart"), Some(false)), SummaryMode::Smart);
    assert_eq!(SummaryMode::normalize(Some("maintainer"), None), SummaryMode::Maintainer);
    assert_eq!(SummaryMode::normalize(Some("self"), Some(true)), SummaryMode::Session);
    assert_eq!(SummaryMode::normalize(None, Some(false)), SummaryMode::Session, "the old switch off means the conversation's own model");
    assert_eq!(SummaryMode::normalize(None, Some(true)), SummaryMode::Smart);
    assert_eq!(SummaryMode::normalize(None, None), SummaryMode::Smart);
    assert_eq!(SummaryMode::normalize(Some("unknown"), Some(false)), SummaryMode::Session);
}

// ---- observations a later one replaces --------------------------------------------------------------------

fn stale_indices(messages: &[AgentMessage]) -> Vec<usize> {
    let mut indices: Vec<usize> = stale_observations(messages).keys().copied().collect();
    indices.sort_unstable();
    indices
}

fn browser_read(id: &str, snapshot: &str, body: &str) -> [AgentMessage; 2] {
    [asks(vec![call(id, "browser", json!({}))]), AgentMessage::tool_text(id, format!("{body}\n\nSnapshot: {snapshot}\n- button"), ToolKind::Normal)]
}

fn plain_read(id: &str) -> [AgentMessage; 2] {
    [asks(vec![call(id, "read", json!({ "path": "notes.txt" }))]), AgentMessage::tool_text(id, "text", ToolKind::Normal)]
}

#[test]
fn an_older_snapshot_of_a_page_is_replaced_by_a_newer_one_and_keeps_what_preceded_it() {
    let mut messages = vec![AgentMessage::user("browse")];
    messages.extend(browser_read("b1", "p1-s1", "page intro"));
    messages.extend(browser_read("b2", "p1-s2", "page intro"));
    messages.extend(plain_read("r1"));
    let stale = stale_observations(&messages);
    assert_eq!(stale_indices(&messages), [2], "only the older snapshot of page p1");
    let replaced = supersede_observation(&messages[2], &stale[&2], "ORIGIN");
    assert_eq!(replaced.text(), "page intro\n\n[Snapshot p1-s1 superseded: a newer snapshot of this page follows. ORIGIN]");
    assert_eq!(replaced.tool_call_id(), Some("b1"), "the result still answers its call");
}

#[test]
fn the_latest_tool_group_other_pages_and_failed_results_are_never_replaced() {
    // The newer snapshot is in the latest group: the older is replaced, the newest stays verbatim.
    let mut latest = vec![AgentMessage::user("browse")];
    latest.extend(browser_read("b1", "p1-s1", "intro"));
    latest.extend(browser_read("b2", "p1-s2", "intro"));
    assert_eq!(stale_indices(&latest), [2]);
    // Only one group: nothing newer exists, and it is the group in use.
    assert!(stale_indices(&latest[..3]).is_empty());
    // A different page is a different observation.
    let mut pages = vec![AgentMessage::user("browse")];
    pages.extend(browser_read("b1", "p1-s1", "intro"));
    pages.extend(browser_read("b2", "p2-s1", "intro"));
    pages.extend(plain_read("r1"));
    assert!(stale_indices(&pages).is_empty());
    // A failed read observed nothing.
    let mut failed = vec![AgentMessage::user("browse")];
    failed.extend(browser_read("b1", "p1-s1", "intro"));
    failed[2].tool_kind = Some(ToolKind::Error);
    failed.extend(browser_read("b2", "p1-s2", "intro"));
    failed.extend(plain_read("r1"));
    assert!(stale_indices(&failed).is_empty());
    // A group with a call still unanswered stays whole.
    let mut open = vec![AgentMessage::user("browse")];
    open.extend(browser_read("b1", "p1-s1", "intro"));
    open[1] = asks(vec![call("b1", "browser", json!({})), call("b9", "browser", json!({}))]);
    open.extend(browser_read("b2", "p1-s2", "intro"));
    open.extend(plain_read("r1"));
    assert!(stale_indices(&open).is_empty(), "the group of an unanswered call is in use");
}

fn image_result(id: &str) -> AgentMessage {
    let image = ContentPart::Image(ImageSource::Base64 { data: "AAAA".into(), mime_type: "image/png".into(), width: None, height: None });
    AgentMessage::tool_result(id, Content::Parts(vec![ContentPart::Text("shot".into(), None), image]), ToolKind::Normal)
}

fn image_read(id: &str) -> [AgentMessage; 2] {
    [asks(vec![call(id, "read", json!({ "path": "shots/a.png" }))]), image_result(id)]
}

#[test]
fn an_image_file_read_is_kept_for_the_whole_request_and_replaced_once_a_newer_request_reads_it_again() {
    let mut same_request = vec![AgentMessage::user("look")];
    same_request.extend(image_read("r1"));
    same_request.extend(image_read("r2"));
    same_request.extend(plain_read("r3"));
    assert!(stale_indices(&same_request).is_empty(), "both reads belong to the request in progress");

    let mut later = vec![AgentMessage::user("look")];
    later.extend(image_read("r1"));
    later.push(AgentMessage::user("again"));
    later.extend(image_read("r2"));
    later.extend(plain_read("r3"));
    let stale = stale_observations(&later);
    assert_eq!(stale_indices(&later), [2]);
    let replaced = supersede_observation(&later[2], &stale[&2], "ORIGIN");
    let Content::Parts(parts) = &replaced.message.content else { panic!("parts stay parts") };
    assert_eq!(
        parts,
        &[ContentPart::Text("[Image read of shots/a.png superseded: a newer read of this file follows. Read the file again to view it. ORIGIN]".into(), None)],
        "the pixels are gone, a one-line note says why"
    );
}

fn terminal_read(id: &str, lines: &[&str]) -> [AgentMessage; 2] {
    [
        asks(vec![call(id, "terminal", json!({}))]),
        AgentMessage::tool_text(id, format!("Terminal: session-terminal:t1\n\n{}", lines.join("\n")), ToolKind::Normal),
    ]
}

#[test]
fn a_terminal_read_is_replaced_only_when_a_newer_read_of_the_tab_contains_its_lines() {
    let mut grown = vec![AgentMessage::user("watch")];
    grown.extend(terminal_read("t1", &["line a", "line b"]));
    grown.extend(terminal_read("t2", &["line a", "line b", "line c"]));
    grown.extend(plain_read("r1"));
    let stale = stale_observations(&grown);
    assert_eq!(stale_indices(&grown), [2]);
    let replaced = supersede_observation(&grown[2], &stale[&2], "ORIGIN");
    assert_eq!(replaced.text(), "[Terminal session-terminal:t1 read superseded: a newer read of this tab follows. ORIGIN]");

    let mut cleared = vec![AgentMessage::user("watch")];
    cleared.extend(terminal_read("t1", &["line a", "line b"]));
    cleared.extend(terminal_read("t2", &["other output"]));
    cleared.extend(plain_read("r1"));
    assert!(stale_indices(&cleared).is_empty(), "output the newer read no longer shows is the only copy");
}

// ---- what a kept tool call may still carry ---------------------------------------------------------------

#[test]
fn secrets_in_kept_tool_calls_are_redacted_by_key_and_by_shape_and_nothing_else_changes() {
    let args = json!({
        "command": "curl https://example.test",
        "api_key": "abc123",
        "headers": { "Authorization": "Bearer abc", "Accept": "text/plain" },
        "list": [{ "refresh_token": "r" }],
    });
    let original = asks(vec![call("c1", "bash", args)]);
    let [redacted] = <[AgentMessage; 1]>::try_from(redact_tool_call_secrets(std::slice::from_ref(&original))).unwrap();
    assert_eq!(
        redacted.tool_calls()[0].arguments,
        json!({
            "command": "curl https://example.test",
            "api_key": "[redacted]",
            "headers": { "Authorization": "[redacted]", "Accept": "text/plain" },
            "list": [{ "refresh_token": "[redacted]" }],
        })
    );
    assert_eq!(redacted.tool_calls()[0].id, "c1");

    let harmless = asks(vec![call("c2", "read", json!({ "path": "src/lib.rs", "tokens": 5 }))]);
    let [same] = <[AgentMessage; 1]>::try_from(redact_tool_call_secrets(std::slice::from_ref(&harmless))).unwrap();
    assert_eq!(same, harmless, "a call without secrets is returned untouched");

    let as_text = asks(vec![call("c3", "bash", json!("{\"password\":\"hunter2\",\"cwd\":\"/tmp\"}"))]);
    let [text] = <[AgentMessage; 1]>::try_from(redact_tool_call_secrets(std::slice::from_ref(&as_text))).unwrap();
    assert_eq!(text.tool_calls()[0].arguments, json!("{\"password\":\"[redacted]\",\"cwd\":\"/tmp\"}"), "arguments sent as JSON text keep their shape");
}

// ---- which user turns are the person's own instruction ---------------------------------------------------

#[test]
fn only_the_persons_own_text_is_an_instruction_not_summaries_reminders_or_runtime_turns() {
    use mixdog_agent::project::is_actual_user_instruction as instruction;
    assert!(instruction(&AgentMessage::user("please fix the bug")));
    assert!(!instruction(&AgentMessage::user("   ")));
    assert!(!instruction(&AgentMessage::user("<system-reminder>state</system-reminder>")), "a reminder envelope is context");
    assert!(instruction(&AgentMessage::user("<system-reminder>state</system-reminder>\nplease fix the bug")), "text after the envelope is the request");
    for source in [
        Source::TaskNotification,
        Source::CompactSummary,
        Source::Skill,
        Source::GoalContinuation,
        Source::ScheduleResult,
        Source::CompactContext,
        Source::ActiveTurnContinuation,
        Source::StreamCutRecovery,
    ] {
        assert!(!instruction(&AgentMessage::sourced(source, "text a model needs")), "{source:?}");
    }
    assert!(!instruction(&AgentMessage::assistant("I will", Vec::new())));
}

fn visualize_read(id: &str, input: serde_json::Value) -> [AgentMessage; 2] {
    [asks(vec![call(id, "visualize", json!({ "action": "inspect", "input": input }))]), AgentMessage::tool_text(id, "layout of the page", ToolKind::Normal)]
}

#[test]
fn a_visualize_readout_is_replaced_by_a_newer_one_of_the_same_tab_and_viewport_once_a_newer_request_begins() {
    let mut messages = vec![AgentMessage::user("design")];
    messages.extend(visualize_read("v1", json!({ "tab": "t1", "viewport": "mobile" })));
    messages.push(AgentMessage::user("again"));
    messages.extend(visualize_read("v2", json!({ "tab": "t1", "viewport": "mobile" })));
    messages.extend(plain_read("r1"));
    let stale = stale_observations(&messages);
    assert_eq!(stale_indices(&messages), [2]);
    let replaced = supersede_observation(&messages[2], &stale[&2], "ORIGIN");
    assert_eq!(
        replaced.text(),
        "[Visualize inspect of tab t1 superseded: a newer inspect of this tab follows. Run visualize inspect on the tab again to get it. ORIGIN]"
    );

    // Within one request both stay; another viewport or tab is another observation.
    let mut same_request = vec![AgentMessage::user("design")];
    same_request.extend(visualize_read("v1", json!({ "tab": "t1", "viewport": "mobile" })));
    same_request.extend(visualize_read("v2", json!({ "tab": "t1", "viewport": "mobile" })));
    same_request.extend(plain_read("r1"));
    assert!(stale_indices(&same_request).is_empty());
    for other in [json!({ "tab": "t1", "viewport": "desktop" }), json!({ "tab": "t2", "viewport": "mobile" })] {
        let mut messages = vec![AgentMessage::user("design")];
        messages.extend(visualize_read("v1", json!({ "tab": "t1", "viewport": "mobile" })));
        messages.push(AgentMessage::user("again"));
        messages.extend(visualize_read("v2", other));
        messages.extend(plain_read("r1"));
        assert!(stale_indices(&messages).is_empty());
    }
}

fn frame_read(id: &str, window: &str, body: serde_json::Value) -> [AgentMessage; 2] {
    let mut frame = json!({ "ok": true, "action": "click", "window_id": window, "elements": [{ "name": "OK" }] });
    if let (Some(extra), Some(map)) = (body.as_object(), frame.as_object_mut()) {
        map.extend(extra.clone());
    }
    [asks(vec![call(id, "computer", json!({}))]), AgentMessage::tool_text(id, frame.to_string(), ToolKind::Normal)]
}

#[test]
fn an_older_frame_of_a_window_keeps_its_outcome_and_loses_its_elements_to_a_newer_frame() {
    let mut messages = vec![AgentMessage::user("click")];
    messages.extend(frame_read("f1", "w1", json!({})));
    messages.extend(frame_read("f2", "w1", json!({})));
    messages.extend(plain_read("r1"));
    let stale = stale_observations(&messages);
    assert_eq!(stale_indices(&messages), [2]);
    let replaced = supersede_observation(&messages[2], &stale[&2], "ORIGIN");
    assert_eq!(replaced.text(), r#"{"ok":true,"action":"click","window_id":"w1","superseded":"a newer observation of this window follows. ORIGIN"}"#);

    let mut other = vec![AgentMessage::user("click")];
    other.extend(frame_read("f1", "w1", json!({})));
    other.extend(frame_read("f2", "w2", json!({})));
    other.extend(plain_read("r1"));
    assert!(stale_indices(&other).is_empty(), "another window is another observation");
}

#[test]
fn a_frame_nested_under_an_observation_is_reduced_in_place() {
    let nested = |id: &str| {
        let text = json!({ "ok": true, "observation": { "window_id": "w1", "elements": [{ "name": "OK" }], "ocr": "text" } }).to_string();
        [asks(vec![call(id, "computer", json!({}))]), AgentMessage::tool_text(id, text, ToolKind::Normal)]
    };
    let mut messages = vec![AgentMessage::user("look")];
    messages.extend(nested("f1"));
    messages.extend(nested("f2"));
    messages.extend(plain_read("r1"));
    let stale = stale_observations(&messages);
    assert_eq!(stale_indices(&messages), [2]);
    let replaced = supersede_observation(&messages[2], &stale[&2], "ORIGIN");
    assert_eq!(replaced.text(), r#"{"ok":true,"observation":{"window_id":"w1","superseded":"a newer observation of this window follows. ORIGIN"}}"#);
}

// ---- the saved summary mode ---------------------------------------------------------------------------------

#[test]
fn the_saved_summary_mode_is_kept_when_it_names_one_else_the_retired_switch_decides() {
    use mixdog_agent::compact::settings::normalize_compaction;
    let modes = [
        Some(json!("smart")),
        Some(json!("maintainer")),
        Some(json!("self")),
        None,
        Some(json!("unknown")),
        Some(json!("Smart")),
        Some(json!(5)),
        Some(json!(null)),
    ];
    let switches = [None, Some(json!(true)), Some(json!(false)), Some(json!("false")), Some(json!(null))];
    for mode in &modes {
        for switch in &switches {
            let mut saved = serde_json::Map::new();
            if let Some(mode) = mode {
                saved.insert("summaryMode".into(), mode.clone());
            }
            if let Some(switch) = switch {
                saved.insert("useMaintainer".into(), switch.clone());
            }
            let named = mode.as_ref().and_then(|m| m.as_str()).filter(|m| ["smart", "maintainer", "self"].contains(m));
            // A valid mode is itself; anything else follows the retired boolean, where only `false` means the conversation's own model.
            let want = match named {
                Some(named) => named,
                None if switch == &Some(json!(false)) => "self",
                None => "smart",
            };
            let got = normalize_compaction(Some(&serde_json::Value::Object(saved.clone())));
            assert_eq!(got["summaryMode"], want, "{saved:?}");
            assert!(!got.contains_key("useMaintainer"), "the retired switch is not kept: {saved:?}");
            // The loop reads the same mode from the same saved values.
            let loop_mode = SummaryMode::normalize(saved.get("summaryMode").and_then(|m| m.as_str()), saved.get("useMaintainer").and_then(|s| s.as_bool()));
            assert_eq!(
                match loop_mode {
                    SummaryMode::Smart => "smart",
                    SummaryMode::Maintainer => "maintainer",
                    SummaryMode::Session => "self",
                },
                want,
                "{saved:?}"
            );
        }
    }
    assert_eq!(normalize_compaction(None)["summaryMode"], "smart", "nothing saved");
}
