//! The manual compaction pass: the rows it archives and the header change it commits.

use super::*;
/// A manual pass archives each message as its stored row (Node's `serializeExecutionArchive` over `session.messages`),
/// never as `null`.
#[test]
fn a_manual_pass_archives_each_message_as_its_stored_row() {
    use mixdog_agent::compact::execution_tail::MessageRows;
    let rows = vec![
        json!({ "role": "user", "content": "hi" }),
        json!({ "role": "assistant", "content": "", "toolCalls": [{ "id": "c1", "name": "read", "arguments": {} }] }),
        json!({ "role": "tool", "content": "body", "toolCallId": "c1" }),
    ];
    let messages: Vec<AgentMessage> = rows.iter().map(|row| message_of(row).unwrap()).collect();
    let stored = registered(&messages, &rows);
    for (message, row) in messages.iter().zip(&rows) {
        assert_eq!(&stored.row(message), row);
    }
}

#[test]
fn a_header_change_names_what_was_set_and_what_went() {
    let before = json!({ "a": 1, "b": 2, "c": 3 }).as_object().cloned().unwrap();
    let after = json!({ "a": 1, "b": 5, "d": 4 }).as_object().cloned().unwrap();
    let change = header_change(&before, &after);
    assert_eq!(Value::Object(change.set), json!({ "b": 5, "d": 4 }));
    assert_eq!(change.unset, ["c"]);
}

/// A session whose agent holds the conversation is summarized whatever its stored rows measure; any other keeps its own threshold.
#[test]
fn a_manual_pass_on_an_agents_session_summarizes_whatever_the_stored_rows_measure() {
    let held =
        json!({ "acpSession": { "sessionId": "s-1" }, "compaction": { "timeoutMs": 9, "conversationThresholdTokens": 20000 } }).as_object().cloned().unwrap();
    let header = pass_header(&held);
    assert_eq!(header["compaction"], json!({ "timeoutMs": 9, "conversationThresholdTokens": 1 }));
    let own = json!({ "compaction": { "conversationThresholdTokens": 20000 } }).as_object().cloned().unwrap();
    assert_eq!(pass_header(&own), own);
}
