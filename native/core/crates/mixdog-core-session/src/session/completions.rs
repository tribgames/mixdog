//! Background-job completions in the thread's queue, as today's pending-message entries
//! (`pending-message-entry.mjs`): a completion is queued like any input, a running turn takes
//! it at its next model-call boundary, and what no turn took starts its own turn.

use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// `PENDING_MODE_TASK_NOTIFICATION`.
pub const MODE: &str = "task-notification";
/// `COMPLETION_NOTIFICATION_KIND`.
pub(crate) const KIND: &str = "completion_notification";

/// `pendingEntryMode(entry) === PENDING_MODE_TASK_NOTIFICATION`.
pub fn is_notification(entry: &Value) -> bool {
    entry.get("mode").and_then(Value::as_str) == Some(MODE) || entry.get("notificationKind").and_then(Value::as_str) == Some(KIND)
}

/// A queued completion: its id and the persisted entry without it (`markCompletionEntry`
/// through `normalizePersistedEntryBase`, with `meta: {execution_surface, execution_id,
/// status}`). The id is addressed by the execution, so the same completion queued twice is
/// one entry. `None` for blank text, which Node never queues.
pub fn entry(surface: &str, task_id: &str, status: &str, text: &str, now: i64, hop: u32) -> Option<(String, Value)> {
    let message = mixdog_js::js_trim(text);
    if message.is_empty() {
        return None;
    }
    let execution_id = mixdog_js::js_trim(task_id);
    let id = mixdog_store::completion_receipts::queue_id(execution_id, text);
    let mut execution = Map::new();
    let surface = mixdog_js::js_trim(surface);
    if !surface.is_empty() {
        execution.insert("surface".into(), Value::String(surface.to_owned()));
    }
    if !execution_id.is_empty() {
        execution.insert("id".into(), Value::String(execution_id.to_owned()));
    }
    let status = mixdog_js::js_trim(status);
    if !status.is_empty() {
        execution.insert("status".into(), Value::String(status.to_owned()));
    }
    let mut entry = json!({ "message": message, "notificationKind": KIND, "mode": MODE });
    if !execution_id.is_empty() {
        entry["executionId"] = Value::String(execution_id.to_owned());
    }
    if !execution.is_empty() {
        entry["execution"] = Value::Object(execution);
    }
    entry["enqueuedAt"] = json!(now);
    // The turn that started the job: its completion returns at that bot-chain hop (`transcriptMeta.hop`, as a bot's send carries it).
    if hop > 0 {
        entry["transcriptMeta"] = json!({ "hop": hop });
    }
    Some((id, entry))
}

/// `PROMPT_ORIGIN_CHANNEL` (`shared/prompt-origin.mjs:8`).
pub const ORIGIN_CHANNEL: &str = "channel";

/// `PROMPT_ORIGIN_AGENT_REPORT` (`shared/prompt-origin.mjs`).
pub const ORIGIN_AGENT_REPORT: &str = "agent-report";

/// `promptOriginOf(entry.origin)` (`prompt-origin.mjs:16-21`): a known origin, else none.
pub fn prompt_origin(entry: &Value) -> Option<&'static str> {
    match entry.get("origin").and_then(Value::as_str) {
        Some(ORIGIN_CHANNEL) => Some(ORIGIN_CHANNEL),
        Some(ORIGIN_AGENT_REPORT) => Some(ORIGIN_AGENT_REPORT),
        _ => None,
    }
}

/// Whether the entry is an inbound channel message, which `submitSession` starts a turn for whatever
/// `autoWakeCompletions` says (that flag gates only `wakeQueuedCompletion`, `infrastructure.mjs:154`).
pub fn is_channel(entry: &Value) -> bool {
    prompt_origin(entry) == Some(ORIGIN_CHANNEL)
}

/// A channel notification queued as a task notification that is not a completion
/// (`channel-session-router.mjs:23-28`; the entry `explicitModeField` keeps,
/// `pending-message-entry.mjs:176-183`): `mode` and `origin`, no execution. `None` for blank text.
pub fn channel_entry(text: &str, now: i64) -> Option<Value> {
    let message = mixdog_js::js_trim(text);
    if message.is_empty() {
        return None;
    }
    Some(json!({ "message": message, "mode": MODE, "origin": ORIGIN_CHANNEL, "priority": "later", "enqueuedAt": now }))
}

/// The text a queued completion delivers.
pub fn text(entry: &Value) -> String {
    entry.get("message").and_then(Value::as_str).unwrap_or_default().to_owned()
}

/// The entry's execution provenance (`group.execution`).
pub fn execution(entry: &Value) -> Option<Value> {
    entry.get("execution").filter(|e| e.is_object()).cloned()
}

/// The input row of the turn a completion starts: stored as a task notification with its
/// execution, never as the user speaking (`ask-queue.mjs` `tailTurnFor`/`queuedTurnInput`).
pub fn input_row(entry: &Value) -> Value {
    let mut meta = json!({ "source": MODE });
    if let Some(execution) = execution(entry) {
        meta["execution"] = execution;
    }
    // The turn's prompt origin rides its input row's meta beside `source` (`turnPromptSourceFor`,
    // `ask-turn-execute.mjs:27-34`, spread into `userTurnMeta` at `ask-turn-prepare.mjs:223-225`): the
    // warmer's `cacheWarmTurnKind` reads it back (`cache-warm.mjs:541-545,563-571`; `warmer/plan.rs`).
    if let Some(origin) = prompt_origin(entry) {
        meta["origin"] = Value::String(origin.to_owned());
    }
    json!({ "role": "user", "content": text(entry), "meta": meta })
}

fn consumed_execution_ids(entries: &[Value]) -> Vec<Value> {
    entries
        .iter()
        .map(|entry| {
            execution(entry)
                .and_then(|execution| execution.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()).map(|id| json!(id)))
                .unwrap_or(Value::Null)
        })
        .collect()
}

/// Where each non-blank entry sits in the batch's joined text, in UTF-16 offsets (the unit a JavaScript client slices by), so a
/// client shows one card per completion without cutting the text: a result may quote an envelope.
fn completion_spans(entries: &[Value]) -> Vec<Value> {
    let mut at = 0usize;
    let mut delivered: Vec<Value> = Vec::new();
    for entry in entries {
        let own = text(entry);
        if mixdog_js::js_trim(&own).is_empty() {
            continue;
        }
        let end = at + mixdog_js::utf16_len(&own);
        let execution = execution(entry);
        let field = |key: &str| execution.as_ref().and_then(|e| e.get(key)).and_then(Value::as_str).filter(|v| !v.is_empty()).map(|v| json!(v));
        let mut one = Map::new();
        for (key, value) in [("executionId", field("id")), ("surface", field("surface")), ("status", field("status"))] {
            if let Some(value) = value {
                one.insert(key.into(), value);
            }
        }
        one.insert("start".into(), json!(at));
        one.insert("end".into(), json!(end));
        delivered.push(Value::Object(one));
        at = end + 1;
    }
    delivered
}

/// The input row of the one turn a batch of queued completions starts (`drain.mjs` `presentBatch`): the texts merged in queue order,
/// the row's own execution the first one's. A batch of several also records every execution it delivers, `null` for an entry that
/// names none (`consumedExecutionIds`, `completionWakeTranscriptMeta`), which the task reports read to account for consumed results.
pub fn batch_row(entries: &[Value]) -> Value {
    let mut row = input_row(&entries[0]);
    let merged: Vec<String> = entries.iter().map(text).filter(|text| !mixdog_js::js_trim(text).is_empty()).collect();
    row["content"] = Value::String(merged.join("\n"));
    let mut transcript = Map::new();
    transcript.insert("messageId".into(), json!(format!("msg_{}", uuid::Uuid::new_v4().simple())));
    if let Some(first) = entries[0].get("transcriptMeta").filter(|meta| meta.is_object()) {
        for key in ["sender", "fromAgent", "hop", "botChain", "roomRow"] {
            if let Some(value) = first.get(key) {
                transcript.insert(key.to_owned(), value.clone());
            }
        }
    }
    // Always, one entry included (`{ ...meta, consumedExecutionIds }` for every task-notification batch): the turn's input row then
    // carries `meta.transcript`, which the turn's assistant rows take their message id, time and route from (`TurnStamp::of`).
    transcript.insert("consumedExecutionIds".into(), json!(consumed_execution_ids(entries)));
    if entries.len() > 1 {
        transcript.insert("completions".into(), Value::Array(completion_spans(entries)));
    }
    // `userTurnMeta` (`ask-turn-prepare.mjs`) lists `transcript` before the prompt source and its execution.
    let mut meta = Map::new();
    meta.insert("transcript".into(), Value::Object(transcript));
    if let Value::Object(mut rest) = row["meta"].take() {
        meta.append(&mut rest);
    }
    row["meta"] = Value::Object(meta);
    row
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The turn a batch of completions starts takes the hop of the batch's FIRST entry (`completionWakeTranscriptMeta`,
    /// `drain.mjs:99`: `batch[0]?.transcriptMeta`), read off the input row exactly as the turn start stamps it
    /// (`TurnState::stamp(body.pointer("/meta/transcript"))`, `actor.rs`), beside the executions the batch consumed.
    #[test]
    fn a_batch_of_completions_starts_its_turn_at_the_first_ones_hop() {
        let queued = |task: &str, hop: u32| entry("agent", task, "completed", &format!("{task} done"), 1, hop).unwrap().1;
        let stamped = |entries: &[Value]| {
            let row = batch_row(entries);
            let turn = crate::session::delegation::TurnState::default();
            turn.stamp(row.pointer("/meta/transcript"));
            (turn.hop(), row.pointer("/meta/transcript/consumedExecutionIds").cloned())
        };
        assert_eq!(stamped(&[queued("t1", 2), queued("t2", 5)]), (2, Some(json!(["t1", "t2"]))));
        assert_eq!(stamped(&[queued("t1", 0), queued("t2", 5)]), (0, Some(json!(["t1", "t2"]))));
        assert_eq!(stamped(&[queued("t1", 4)]), (4, Some(json!(["t1"]))));
        assert_eq!(stamped(&[queued("t1", 0)]), (0, Some(json!(["t1"]))));
    }

    /// A woken turn's input row carries `meta.transcript` whatever the batch's size, so the turn's assistant rows are stamped with a
    /// message id and time (the installed app stored every tool-call message of a one-completion wake without them).
    #[test]
    fn a_completion_wake_stores_the_input_row_meta_node_stores() {
        let queued = |task: &str, hop: u32| entry("agent", task, "completed", &format!("{task} done"), 1, hop).unwrap().1;
        // The whole meta, its fields in `userTurnMeta` order: `transcript` (`messageId` first) before `source` and `execution`.
        let pinned = |entries: &[Value], transcript: Value, execution: Value| {
            let mut meta = batch_row(entries)["meta"].clone();
            let id = meta["transcript"]["messageId"].as_str().expect("a message id").to_owned();
            assert!(id.strip_prefix("msg_").is_some_and(|hex| hex.len() == 32 && hex.chars().all(|c| c.is_ascii_hexdigit())), "{id}");
            meta["transcript"]["messageId"] = json!("ID");
            assert_eq!(meta.as_object().unwrap().keys().collect::<Vec<_>>(), ["transcript", "source", "execution"]);
            assert_eq!(meta, json!({ "transcript": transcript, "source": "task-notification", "execution": execution }));
            assert_eq!(meta["transcript"].as_object().unwrap().keys().next().map(String::as_str), Some("messageId"));
        };
        let one = json!({ "surface": "agent", "id": "t1", "status": "completed" });
        pinned(&[queued("t1", 0)], json!({ "messageId": "ID", "consumedExecutionIds": ["t1"] }), one.clone());
        pinned(&[queued("t1", 3)], json!({ "messageId": "ID", "hop": 3, "consumedExecutionIds": ["t1"] }), one.clone());
        pinned(
            &[queued("t1", 2), queued("t2", 5)],
            json!({
                "messageId": "ID", "hop": 2, "consumedExecutionIds": ["t1", "t2"],
                "completions": [
                    { "executionId": "t1", "surface": "agent", "status": "completed", "start": 0, "end": 7 },
                    { "executionId": "t2", "surface": "agent", "status": "completed", "start": 8, "end": 15 },
                ],
            }),
            one,
        );
    }

    /// A batch of three completions (an agent with a result, an agent that failed, a shell task) is written as three structured
    /// entries that locate each envelope in the joined text, and the text the model reads is the same bytes as before the entries
    /// existed: the queued texts joined by a newline. An envelope quoted inside a result changes neither.
    #[test]
    fn a_batch_of_three_writes_three_structured_entries_and_the_same_model_text() {
        let envelope = |id: &str, status: &str, summary: &str, result: &str| {
            let body = if result.is_empty() { String::new() } else { format!("<result>\n{result}\n</result>\n") };
            format!("<task-notification>\n<task-id>{id}</task-id>\n<status>{status}</status>\n<summary>{summary}</summary>\n{body}</task-notification>")
        };
        let quoted = envelope("q", "completed", "Agent \"q\" completed", "quoted");
        let ok = envelope("a1", "completed", "Agent \"rev\" completed", &format!("see 한글 😀\n{quoted}\n{quoted}"));
        let bad = envelope("a2", "failed", "Agent \"fix\" failed: boom", "");
        let shell = envelope("j3", "completed", "Shell task completed (exit 0): npm test", "ok");
        let entries: Vec<Value> = [("agent", "a1", "completed", &ok), ("agent", "a2", "failed", &bad), ("shell", "j3", "completed", &shell)]
            .iter()
            .map(|(surface, id, status, text)| entry(surface, id, status, text, 1, 0).unwrap().1)
            .collect();
        let row = batch_row(&entries);
        assert_eq!(row["content"], json!([ok.as_str(), bad.as_str(), shell.as_str()].join("\n")));
        let listed = row["meta"]["transcript"]["completions"].as_array().unwrap().clone();
        assert_eq!(row["meta"]["transcript"]["consumedExecutionIds"], json!(["a1", "a2", "j3"]));
        let want = [("a1", "agent", "completed", &ok), ("a2", "agent", "failed", &bad), ("j3", "shell", "completed", &shell)];
        assert_eq!(listed.len(), 3);
        let units: Vec<u16> = row["content"].as_str().unwrap().encode_utf16().collect();
        for (found, (id, surface, status, text)) in listed.iter().zip(want) {
            assert_eq!((found["executionId"].as_str(), found["surface"].as_str(), found["status"].as_str()), (Some(id), Some(surface), Some(status)));
            let (start, end) = (found["start"].as_u64().unwrap() as usize, found["end"].as_u64().unwrap() as usize);
            assert_eq!(String::from_utf16(&units[start..end]).unwrap(), *text);
        }
    }

    /// An agent job's completion is queued at the bot-chain hop of the turn that started it (`transcriptMeta.hop`, which the
    /// task-report consumers read); a job started outside a chain, and any other surface, carry none.
    #[test]
    fn an_agent_completion_is_queued_at_its_starting_hop() {
        let (_, hopped) = entry("agent", "task_hop_3", "completed", "done", 1, 3).unwrap();
        assert_eq!(hopped["transcriptMeta"], json!({ "hop": 3 }));
        let (_, plain) = entry("agent", "task_no_hop", "completed", "done", 1, 0).unwrap();
        assert!(plain.get("transcriptMeta").is_none());
    }

    /// `promptOriginOf` and the origin on the input row's meta (`ask-turn-prepare.mjs:223-225`).
    #[test]
    fn a_known_origin_rides_the_input_row_and_a_channel_entry_is_not_held_back() {
        let channel = channel_entry(" PR opened ", 5).unwrap();
        assert_eq!(channel, json!({ "message": "PR opened", "mode": "task-notification", "origin": "channel", "priority": "later", "enqueuedAt": 5 }));
        assert!(is_channel(&channel));
        assert_eq!(input_row(&channel)["meta"], json!({ "source": "task-notification", "origin": "channel" }));
        let report = json!({ "message": "x", "mode": "task-notification", "origin": "agent-report" });
        assert!(!is_channel(&report));
        assert_eq!(input_row(&report)["meta"]["origin"], "agent-report");
        let unknown = json!({ "message": "x", "mode": "task-notification", "origin": "other" });
        assert_eq!(input_row(&unknown)["meta"], json!({ "source": "task-notification" }));
        assert!(channel_entry("  ", 5).is_none());
    }
}
