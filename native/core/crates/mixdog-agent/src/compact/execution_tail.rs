//! The execution history a compaction keeps: recent tool-call groups within a
//! small budget, the user's instructions, unanswered notifications, and a
//! recovery reminder naming the archive of everything that was dropped.

use std::collections::BTreeMap;
use std::collections::HashSet;
use std::sync::LazyLock;

use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::Role;
use mixdog_js::JsRegex;
use serde_json::Value as JsonValue;

use super::dropped::Redactor;
use super::estimate::MessageMeter;
use super::messages::is_compact_conversation_row;
use super::messages::is_protected_context_ack;
use super::messages::latest_actual_user_instruction_index;
use super::messages::pending_task_notification_indexes;
use super::messages::request_start;
use super::observation::stale_observations;
use super::observation::supersede_observation;
use mixdog_js::token_estimate::estimate_tokens;
use crate::message::AgentMessage;
use crate::offload::Artifact;
use crate::offload::ArtifactStore;
use crate::message::Source;
use crate::project::is_actual_user_instruction;

const TOOL_HISTORY_CONTEXT_RATIO: f64 = 0.05;
/// The working set of recent execution evidence does not grow with the window.
const TOOL_HISTORY_MAX_TOKENS: u64 = 40_000;
const ARCHIVE_THRESHOLD_TOKENS: u64 = 512;
/// Only the newest reminder survives a compaction; it names the dumps it
/// replaced (each dump holds the reminder that preceded it).
const MAX_EARLIER_DUMPS: usize = 4;
const EARLIER_DUMPS_SEPARATOR: &str = " | ";
/// Below this a reference line saves little and every blob is one more file.
const ARCHIVE_BLOB_MIN_BYTES: usize = 16_384;

static RECOVERY_PATH: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"available at (.+?) \(sha256:", ""));
static EARLIER_DUMPS: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^Earlier dumps \(older first\): (.+)$", "m"));

/// A transcript message as the stored row Node wrote: model-visible fields in
/// stored key order, display ids and UI diffs left out.
pub trait MessageRows: Send + Sync {
    fn row(&self, message: &AgentMessage) -> JsonValue;
}

pub struct TailContext<'a> {
    pub meter: &'a MessageMeter<'a>,
    pub rows: &'a dyn MessageRows,
    pub archive: &'a dyn ArtifactStore,
    /// The session's sensitive-value redaction: the dump is a file like the session log.
    pub redactor: &'a dyn Redactor,
    /// Compute archive references without writing (a preview keeps the transcript).
    pub preview: bool,
}

impl TailContext<'_> {
    async fn store(&self, content: &str) -> Option<Artifact> {
        if self.preview { self.archive.preview(content).await } else { self.archive.persist(content).await }
    }
}

pub struct TailOptions {
    pub context_window: u64,
    pub preserve_conversation: bool,
}

#[derive(Debug)]
pub struct TailOutput {
    pub messages: Vec<AgentMessage>,
    pub tool_tokens: u64,
    pub tool_budget: u64,
    pub retained_groups: usize,
    pub omitted_groups: usize,
}

pub fn tool_history_budget(context_window: u64) -> u64 {
    if context_window == 0 {
        return 0;
    }
    ((context_window as f64 * TOOL_HISTORY_CONTEXT_RATIO).floor() as u64).min(TOOL_HISTORY_MAX_TOKENS)
}

fn execution_tokens(ctx: &TailContext<'_>, messages: &[AgentMessage]) -> u64 {
    if messages.is_empty() {
        return 0;
    }
    let rows: Vec<JsonValue> = messages.iter().map(|m| ctx.rows.row(m)).collect();
    ctx.meter
        .messages(messages)
        .max(estimate_tokens(&mixdog_js::json_stringify(&JsonValue::Array(rows))))
}

#[derive(Clone)]
struct Group {
    start: usize,
    end: usize,
    messages: Vec<AgentMessage>,
}

/// Each assistant tool-call turn with the tool results that directly follow it.
fn execution_groups(messages: &[AgentMessage]) -> Vec<Group> {
    let mut groups = Vec::new();
    let mut i = 0;
    while i < messages.len() {
        let m = &messages[i];
        if m.role() != Role::Assistant || m.tool_calls().is_empty() {
            i += 1;
            continue;
        }
        let start = i;
        while messages.get(i + 1).is_some_and(|n| n.role() == Role::Tool) {
            i += 1;
        }
        groups.push(Group { start, end: i + 1, messages: messages[start..=i].to_vec() });
        i += 1;
    }
    groups
}

/// The assistant message without its provider replay (opaque reasoning and a
/// duplicate of its calls); every provider lowers content/calls without it.
fn without_replay(m: &AgentMessage) -> AgentMessage {
    let source = &m.message;
    let mut message = Message::new(source.role, source.content.clone());
    message.cache_tier = source.cache_tier;
    message.tool_calls = source.tool_calls.clone();
    message.tool_call_id = source.tool_call_id.clone();
    message.is_error = source.is_error;
    message.phase = source.phase;
    message.thinking_blocks = source.thinking_blocks.clone();
    message.assistant_blocks = source.assistant_blocks.clone();
    message.native_tool_search = source.native_tool_search.clone();
    message.source = source.source;
    AgentMessage { message, ..m.clone() }
}

/// Only the newest assistant message can still need its replay: an
/// in-progress tool loop continues from it.
fn without_stale_replay(messages: &[AgentMessage]) -> Vec<AgentMessage> {
    let newest = messages.iter().rposition(|m| m.role() == Role::Assistant);
    messages
        .iter()
        .enumerate()
        .map(|(index, m)| {
            if m.role() == Role::Assistant && newest.is_some_and(|n| index < n) {
                without_replay(m)
            } else {
                m.clone()
            }
        })
        .collect()
}

/// One message per line (JSONL): line N + 1 holds message index N. A line that
/// reaches `ARCHIVE_BLOB_MIN_BYTES` is stored once per session as its own
/// content-addressed file and the dump repeats only a reference to it. The session's sensitive
/// values are redacted in both (Node `redactSensitiveMessages`).
async fn serialize_archive(ctx: &TailContext<'_>, transcript: &[AgentMessage]) -> Result<String, String> {
    let rows = ctx.redactor.redact(transcript.iter().map(|m| ctx.rows.row(m)).collect());
    let mut out = String::new();
    for (message, row) in transcript.iter().zip(&rows) {
        let line = format!("{}\n", mixdog_js::json_stringify(row));
        if line.len() < ARCHIVE_BLOB_MIN_BYTES {
            out.push_str(&line);
            continue;
        }
        let blob = ctx
            .store(&line)
            .await
            .ok_or("compact: execution history could not be archived; original context preserved")?;
        let mut reference = serde_json::Map::new();
        reference.insert("path".to_owned(), JsonValue::String(blob.path));
        if let Some(id) = message.tool_call_id() {
            reference.insert("toolCallId".to_owned(), JsonValue::String(id.to_owned()));
        }
        let mut wrapper = serde_json::Map::new();
        wrapper.insert("archivedMessage".to_owned(), JsonValue::Object(reference));
        out.push_str(&format!("{}\n", mixdog_js::json_stringify(&JsonValue::Object(wrapper))));
    }
    Ok(out)
}

/// Dump paths a recovery reminder names, oldest first.
fn recovery_archive_paths(m: &AgentMessage) -> Vec<String> {
    let content = m.text();
    let own = RECOVERY_PATH.captures(&content).and_then(|c| c.get(1)).map(str::to_owned);
    let mut paths: Vec<String> = EARLIER_DUMPS
        .captures(&content)
        .and_then(|c| c.get(1))
        .map(|c| c.split(EARLIER_DUMPS_SEPARATOR).map(str::to_owned).collect())
        .unwrap_or_default();
    paths.extend(own);
    paths
}

/// The reminder naming the new dump and the earlier ones it supersedes.
fn recovery_reminder(archive: &Artifact, previous: &[AgentMessage]) -> AgentMessage {
    let mut seen = HashSet::new();
    let earlier_all: Vec<String> = previous
        .iter()
        .flat_map(recovery_archive_paths)
        .filter(|p| seen.insert(p.clone()))
        .filter(|p| *p != archive.path)
        .collect();
    let earlier = &earlier_all[earlier_all.len().saturating_sub(MAX_EARLIER_DUMPS)..];
    let earlier_line = if earlier.is_empty() {
        String::new()
    } else {
        format!("\nEarlier dumps (older first): {}", earlier.join(EARLIER_DUMPS_SEPARATOR))
    };
    AgentMessage::sourced(
        Source::CompactExecutionRecovery,
        format!(
            "<system-reminder>\nSome execution history was omitted or shortened to fit the tool-history budget. This is not an instruction to repeat those calls. The original calls, outcomes, and earlier recovery references are available at {} (sha256:{}). The dump is JSONL: line N+1 is message index N; an \"archivedMessage\" line names the file holding that message, so search its directory too. Read only missing evidence when needed.{}\n</system-reminder>",
            archive.path, archive.sha256, earlier_line
        ),
    )
}

/// Shrink levels, least evidence lost first. 1: large result bodies. 2: also
/// the assistant's opaque replay. 3: also large call arguments.
fn shrink_group(ctx: &TailContext<'_>, group: &Group, archive: &Artifact, level: u8) -> Vec<AgentMessage> {
    let reference = |offset: usize, what: &str, id: &str| {
        format!(
            "[{what} archived without interpretation: {}; message index {} (line {}); toolCallId={id}.",
            archive.path,
            group.start + offset,
            group.start + offset + 1
        )
    };
    group
        .messages
        .iter()
        .enumerate()
        .map(|(offset, message)| {
            if message.role() == Role::Tool {
                if execution_tokens(ctx, std::slice::from_ref(message)) < ARCHIVE_THRESHOLD_TOKENS {
                    return message.clone();
                }
                let id = message.tool_call_id().unwrap_or_default();
                let mut shrunk = message.clone();
                shrunk.message.content = Content::Text(format!(
                    "{} Outcome must be read from the original result if needed.]",
                    reference(offset, "Tool result body", id)
                ));
                return shrunk;
            }
            if level < 2 {
                return message.clone();
            }
            let mut rest = without_replay(message);
            if level < 3 {
                return rest;
            }
            for call in &mut rest.message.tool_calls {
                if estimate_tokens(&mixdog_js::json_stringify(&call.arguments)) >= ARCHIVE_THRESHOLD_TOKENS {
                    let note = format!("{}]", reference(offset, "Tool call arguments", &call.id));
                    call.arguments = serde_json::json!({ "archived": note });
                }
            }
            rest
        })
        .collect()
}

struct Assemble<'a> {
    anchor: usize,
    first_kept: usize,
    preserve_conversation: bool,
    pending: &'a HashSet<usize>,
}

/// Walk from the anchor: kept groups verbatim, user instructions, unanswered
/// task notifications, and the conversation the mode allows.
fn assemble_tail(messages: &[AgentMessage], kept: &BTreeMap<usize, Group>, a: &Assemble<'_>) -> Vec<AgentMessage> {
    let mut tail = Vec::new();
    let mut i = a.anchor;
    while i < messages.len() {
        if let Some(group) = kept.get(&i) {
            tail.extend(group.messages.iter().cloned());
            i = group.end;
            continue;
        }
        let m = &messages[i];
        if a.preserve_conversation && m.role() == Role::Assistant && !is_protected_context_ack(m) {
            // Omitted execution stays in the archive; its conversational text
            // remains verbatim without replaying an orphaned call.
            if !m.tool_calls().is_empty() {
                let text = m.text();
                if !text.is_empty() {
                    let mut copy = AgentMessage::assistant(text, Vec::new());
                    copy.source = Some(Source::CompactExecutionText);
                    copy.message_id = m.message_id.clone();
                    tail.push(copy);
                }
            } else {
                tail.push(m.clone());
            }
            i += 1;
            continue;
        }
        if is_actual_user_instruction(m)
            || a.pending.contains(&i)
            || (a.preserve_conversation && is_compact_conversation_row(m))
            || (i >= a.first_kept && m.role() == Role::Assistant && m.tool_calls().is_empty())
        {
            tail.push(m.clone());
        }
        i += 1;
    }
    tail
}

/// Writes the dump once per pass and replaces the recovery reminder with one
/// naming it.
async fn ensure_archive(
    ctx: &TailContext<'_>,
    transcript: &[AgentMessage],
    previous: &[AgentMessage],
    archive: &mut Option<Artifact>,
    recovery: &mut Vec<AgentMessage>,
) -> Result<(), String> {
    if archive.is_some() {
        return Ok(());
    }
    let text = serialize_archive(ctx, transcript).await?;
    let dump = ctx
        .store(&text)
        .await
        .ok_or("compact: execution history could not be archived; original context preserved")?;
    *recovery = vec![recovery_reminder(&dump, previous)];
    *archive = Some(dump);
    Ok(())
}

pub async fn build_execution_tail(
    ctx: &TailContext<'_>,
    transcript: &[AgentMessage],
    options: &TailOptions,
) -> Result<TailOutput, String> {
    let budget = tool_history_budget(options.context_window);
    let messages = without_stale_replay(transcript);
    let groups = execution_groups(&messages);
    let stale = stale_observations(&messages);
    let previous_recovery: Vec<AgentMessage> = messages
        .iter()
        .filter(|m| m.source == Some(Source::CompactExecutionRecovery))
        .cloned()
        .collect();
    let mut kept: BTreeMap<usize, Group> = BTreeMap::new();
    let mut tokens = 0u64;
    let mut archive: Option<Artifact> = None;
    // One reminder at most: the newest, which replaces any earlier ones.
    let mut recovery: Vec<AgentMessage> = previous_recovery.last().cloned().into_iter().collect();

    let latest_start = groups.last().map(|g| g.start);
    for group in groups.iter().rev() {
        let kept_ok = keep_group(
            ctx,
            transcript,
            &previous_recovery,
            &stale,
            group,
            Some(group.start) == latest_start,
            budget,
            &mut tokens,
            &mut kept,
            &mut archive,
            &mut recovery,
        )
        .await?;
        if !kept_ok {
            break;
        }
    }
    // Adding the archive reference may displace an older retained group.
    while !kept.is_empty() && tokens + execution_tokens(ctx, &recovery) > budget {
        let oldest = *kept.keys().next().expect("non-empty");
        let removed = kept.remove(&oldest).expect("present");
        tokens -= execution_tokens(ctx, &removed.messages);
    }
    if execution_tokens(ctx, &recovery) > budget {
        return Err(
            "compact: tool-history budget cannot hold its recovery reference; original context preserved".into(),
        );
    }
    // A displaced latest group is refit against the final reference.
    if let Some(latest) = groups.last()
        && kept.is_empty()
    {
        keep_group(
            ctx,
            transcript,
            &previous_recovery,
            &stale,
            latest,
            true,
            budget,
            &mut tokens,
            &mut kept,
            &mut archive,
            &mut recovery,
        )
        .await?;
    }
    if !groups.is_empty() && kept.is_empty() {
        return Err(
            "compact: latest execution group cannot fit the tool-history budget; original context preserved".into(),
        );
    }
    let latest = latest_actual_user_instruction_index(&messages);
    let pending_indexes = pending_task_notification_indexes(&messages);
    let pending: HashSet<usize> = pending_indexes.iter().copied().collect();
    let first_kept = kept.keys().next().copied().unwrap_or(messages.len());
    let latest_kept = latest.unwrap_or(first_kept);
    let anchor = if options.preserve_conversation {
        0
    } else {
        let start = request_start(&messages, first_kept.min(latest_kept)).unwrap_or(0);
        pending_indexes.iter().copied().fold(start, usize::min)
    };
    let tail = assemble_tail(
        &messages,
        &kept,
        &Assemble { anchor, first_kept, preserve_conversation: options.preserve_conversation, pending: &pending },
    );
    // With no execution to retain, keep the existing latest-request contract.
    if !options.preserve_conversation && groups.is_empty() && previous_recovery.is_empty() {
        return Ok(TailOutput {
            messages: messages
                .iter()
                .enumerate()
                .filter(|(index, _)| Some(*index) == latest || pending.contains(index))
                .map(|(_, m)| m.clone())
                .collect(),
            tool_tokens: 0,
            tool_budget: budget,
            retained_groups: 0,
            omitted_groups: 0,
        });
    }
    let mut out = recovery.clone();
    out.extend(tail);
    Ok(TailOutput {
        messages: out,
        tool_tokens: tokens + execution_tokens(ctx, &recovery),
        tool_budget: budget,
        retained_groups: kept.len(),
        omitted_groups: groups.len() - kept.len(),
    })
}

/// Retains `group` if it fits the tool-history budget, shedding evidence in
/// levels when it does not.
#[allow(clippy::too_many_arguments)]
async fn keep_group(
    ctx: &TailContext<'_>,
    transcript: &[AgentMessage],
    previous_recovery: &[AgentMessage],
    stale: &std::collections::HashMap<usize, super::observation::Found>,
    group: &Group,
    is_latest: bool,
    budget: u64,
    tokens: &mut u64,
    kept: &mut BTreeMap<usize, Group>,
    archive: &mut Option<Artifact>,
    recovery: &mut Vec<AgentMessage>,
) -> Result<bool, String> {
    let ensure = ensure_archive;
    // An observation a later one of the same page or window replaced keeps
    // only its outcome and a reference to the archived original.
    let mut observed = group.clone();
    if (0..group.messages.len()).any(|offset| stale.contains_key(&(group.start + offset))) {
        ensure(ctx, transcript, previous_recovery, archive, recovery).await?;
        let dump = archive.as_ref().expect("ensured");
        observed.messages = group
            .messages
            .iter()
            .enumerate()
            .map(|(offset, message)| match stale.get(&(group.start + offset)) {
                Some(found) => {
                    let origin = format!(
                        "The original is archived at {} (message index {}).",
                        dump.path,
                        group.start + offset
                    );
                    supersede_observation(message, found, &origin)
                }
                None => message.clone(),
            })
            .collect();
    }
    let fits = |selected: &[AgentMessage], recovery: &[AgentMessage], tokens: u64| {
        tokens + execution_tokens(ctx, selected) + execution_tokens(ctx, recovery) <= budget
    };
    let mut selected = observed.messages.clone();
    if !fits(&selected, recovery, *tokens) {
        ensure(ctx, transcript, previous_recovery, archive, recovery).await?;
        let dump = archive.as_ref().expect("ensured");
        let levels: &[u8] = if is_latest { &[1, 2, 3] } else { &[1] };
        let mut found = None;
        for level in levels {
            let shrunk = shrink_group(ctx, &observed, dump, *level);
            if fits(&shrunk, recovery, *tokens) {
                found = Some(shrunk);
                break;
            }
        }
        match found {
            Some(shrunk) => selected = shrunk,
            None => return Ok(false),
        }
    }
    *tokens += execution_tokens(ctx, &selected);
    kept.insert(group.start, Group { messages: selected, ..group.clone() });
    Ok(true)
}
