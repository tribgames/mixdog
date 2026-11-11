//! The assistant turn's replay blocks reduced to what the API accepts back (`lib/anthropic-replay-blocks.mjs`): an
//! empty text block is dropped (the API rejects it), and a thinking block that only became adjacent to the previous
//! kept thinking block through that removal is dropped too (two runs fused into one are rejected as modified).

use serde_json::Value;

/// What a reduction removed (`onDrop(kind, block)`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Dropped {
    /// `empty_text`.
    EmptyText,
    /// `merged_thinking`.
    MergedThinking,
}

impl Dropped {
    /// Node's kind string.
    pub fn kind(self) -> &'static str {
        match self {
            Self::EmptyText => "empty_text",
            Self::MergedThinking => "merged_thinking",
        }
    }
}

/// `isAnthropicThinkingBlock`.
pub fn is_thinking(block: &Value) -> bool {
    matches!(block.get("type").and_then(Value::as_str), Some("thinking" | "redacted_thinking"))
}

fn is_empty_text(block: &Value) -> bool {
    block.get("type").and_then(Value::as_str) == Some("text") && block.get("text").and_then(Value::as_str).is_none_or(str::is_empty)
}

/// `sanitizeAnthropicReplayBlocks(blocks, onDrop)`: the stream-ordered blocks reduced, each removal reported.
pub fn sanitize(blocks: &[Value], on_drop: &mut dyn FnMut(Dropped, &Value)) -> Vec<Value> {
    let mut out = Vec::new();
    let mut separator_removed = false;
    let mut last_kept_thinking = false;
    for block in blocks.iter().filter(|b| b.is_object()) {
        if is_empty_text(block) {
            separator_removed = true;
            on_drop(Dropped::EmptyText, block);
            continue;
        }
        if is_thinking(block) && last_kept_thinking && separator_removed {
            on_drop(Dropped::MergedThinking, block);
            continue;
        }
        out.push(block.clone());
        last_kept_thinking = is_thinking(block);
        separator_removed = false;
    }
    out
}

/// `sanitizeAnthropicReplayEntries(entries, onDrop)`: blocks keyed by their content-block index, ordered by it.
pub fn sanitize_entries(entries: &[(u64, Value)], on_drop: &mut dyn FnMut(Dropped, &Value)) -> Vec<Value> {
    let mut ordered: Vec<&(u64, Value)> = entries.iter().collect();
    ordered.sort_by_key(|(index, _)| *index);
    let blocks: Vec<Value> = ordered.into_iter().map(|(_, block)| block.clone()).collect();
    sanitize(&blocks, on_drop)
}

/// `sanitizeAnthropicThinkingRun(blocks, onDrop)`: the thinking blocks that survive the reduction.
pub fn thinking_run(blocks: &[Value], on_drop: &mut dyn FnMut(Dropped, &Value)) -> Vec<Value> {
    sanitize(blocks, on_drop).into_iter().filter(is_thinking).collect()
}
