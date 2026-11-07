//! The live end of a failed turn: Node's `turnDoneItem` (`src/tui/session/turn.mjs:573-601`), built from what the run
//! showed while it ran, not from the durable completion (`failedTurnCompletion`, `ask-turn-failure.mjs:26-45`) the
//! history restores from. The two share the failure record (`turnFailureRecord`) and the turn's own identity; the
//! live row adds the stream's counters (`finalOutputTokens`, `accumulatedThinkingMs`, `cards.toolCards`) and stamps
//! the close time, where the completion stamps the start.

use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::failure_record::Facts;

/// What the turn's stream and cards counted: `stream.assistantText` and `stream.thinkingText` (UTF-16 code units, as
/// `String.length`), the spinner's `outputTokens`, the thinking segments (`startThinkingSegment`,
/// `closeThinkingSegment`) and `cards.toolCards`.
#[derive(Debug, Default)]
pub(crate) struct LiveCounts {
    output_tokens: u64,
    reply_units: u64,
    reasoning_units: u64,
    tool_cards: u64,
    /// `stream.thinkingStartedAt` is set: the turn thought at all.
    thought: bool,
    /// `stream.accumulatedThinkingMs`.
    thinking_ms: i64,
    /// `stream.thinkingSegmentStartedAt`: the open segment's start.
    segment_since: Option<i64>,
}

fn units(text: &str) -> u64 {
    text.encode_utf16().count() as u64
}

impl LiveCounts {
    /// One model call's `deltaOutput` (`applyUsageDelta` into the spinner's `outputTokens`).
    pub(crate) fn usage(&mut self, output_tokens: u64) {
        self.output_tokens += output_tokens;
    }

    /// An assistant text delta (`appendTextDelta`): the open thinking segment ends. An empty chunk is nothing
    /// (`onTextDelta`).
    pub(crate) fn text(&mut self, text: &str, now: i64) {
        if text.is_empty() {
            return;
        }
        self.end_thinking(now);
        self.reply_units += units(text);
    }

    /// A reasoning delta (`appendReasoningDelta`): a segment opens unless one is open.
    pub(crate) fn reasoning(&mut self, text: &str, now: i64) {
        self.thought = true;
        self.segment_since.get_or_insert(now);
        self.reasoning_units += units(text);
    }

    /// A tool call opened its card (`openToolCalls`): the open thinking segment ends.
    pub(crate) fn tool_card(&mut self, now: i64) {
        self.end_thinking(now);
        self.tool_cards += 1;
    }

    /// `closeThinkingSegment` at the turn's close.
    pub(crate) fn close(&mut self, now: i64) {
        self.end_thinking(now);
    }

    fn end_thinking(&mut self, now: i64) {
        if let Some(since) = self.segment_since.take() {
            self.thinking_ms += (now - since).max(0);
        }
    }

    /// `finalOutputTokens`: the spinner's tokens, or the estimate of the text and thinking when it is larger
    /// (`Math.round(length / 4)`, half up).
    fn final_output_tokens(&self) -> u64 {
        self.output_tokens.max((self.reply_units + self.reasoning_units + 2) / 4)
    }
}

/// `turnDoneItem` of a failed turn, as the row Node's transcript holds, keys in Node's order. `record` is the
/// `turnFailureRecord` of the failure (the turn's `failureDetail`, `failureDiagnostic`, `quota`, `errorKind`).
/// `facts.raw` is the turn's `meta.transcript`, of which Node's `routeMeta` is all but `at` and `messageId`.
pub(crate) fn live_end_row(counts: &LiveCounts, facts: &Facts<'_>, record: &Map<String, Value>, id: &str) -> Map<String, Value> {
    let mut row = Map::new();
    row.insert("kind".into(), json!("turndone"));
    row.insert("id".into(), json!(id));
    if let Some(checkpoint) = facts.text("checkpointId") {
        row.insert("checkpointId".into(), json!(checkpoint));
    }
    row.insert("elapsedMs".into(), json!((facts.now - facts.started()).max(0)));
    row.insert("status".into(), json!("failed"));
    row.insert("outputTokens".into(), json!(counts.final_output_tokens()));
    row.insert("thinkingElapsedMs".into(), json!(if counts.thought { counts.thinking_ms } else { 0 }));
    row.insert("toolCount".into(), json!(counts.tool_cards));
    row.insert("verb".into(), json!(facts.verb()));
    row.insert("at".into(), json!(facts.now));
    for key in ["detail", "errorDetails"] {
        if let Some(text) = record.get(key).filter(|text| text.as_str().is_some_and(|text| !text.is_empty())) {
            row.insert(key.into(), text.clone());
        }
    }
    if let Some(meta) = facts.raw.as_object() {
        for (key, value) in meta.iter().filter(|(key, _)| !matches!(key.as_str(), "at" | "messageId")) {
            row.insert(key.clone(), value.clone());
        }
    }
    // The turn's identity is in every live row (`beginTurn`); a turn whose input row states none takes the one its
    // completion records.
    row.entry("attemptId").or_insert_with(|| json!(facts.attempt()));
    for key in ["quota", "errorKind"] {
        if let Some(value) = record.get(key) {
            row.insert(key.into(), value.clone());
        }
    }
    row
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_estimate_rounds_half_up_and_a_thinking_segment_counts_only_when_it_closed() {
        let mut counts = LiveCounts::default();
        counts.reasoning("ab", 10);
        counts.text("cdefg", 40);
        counts.close(90);
        // 7 units / 4 = 1.75 rounds to 2; the segment 10..40.
        assert_eq!((counts.final_output_tokens(), counts.thinking_ms), (2, 30));
        counts.usage(5);
        assert_eq!(counts.final_output_tokens(), 5);
    }
}