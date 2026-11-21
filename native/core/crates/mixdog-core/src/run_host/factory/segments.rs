//! The text segments of the response streaming now.

use super::*;

/// The text segments of the response streaming now, in order (`committedSegments` and the open segment of `turn-stream.mjs`):
/// each a live item of its own, with how many bytes of the response's text it holds. A tool block's start closes the open one
/// (`closeAssistantSegment`), and text after it opens the next under a new id; a closed segment's id is never reused. The
/// response commits as one assistant message (the model's context), whose row names its segments ([`Segments::take`]).
#[derive(Default)]
pub(crate) struct Segments {
    /// Each segment: its id, its bytes of the text, and how many of the response's tool calls streamed before it.
    pub(super) closed: Vec<(ItemId, usize, usize)>,
    pub(super) open: Option<(ItemId, usize, usize)>,
    /// The response's tool calls streamed so far.
    pub(super) calls: usize,
    /// Everything shown of the response, in order.
    pub(super) shown: String,
    /// A progress update is part of what was shown: the response's own text is then not what its segments cut.
    pub(super) updates: bool,
}

impl Segments {
    /// What streams next is a progress update: shown where the text is, no part of the response's text.
    pub(super) fn update(&mut self) {
        self.updates = true;
    }

    /// `text` streams: into the open segment, else a new one. The segment's id, and whether it opened now.
    pub(super) fn extend(&mut self, text: &str) -> (ItemId, bool) {
        self.shown.push_str(text);
        match &mut self.open {
            Some((id, len, _)) => {
                *len += text.len();
                (id.clone(), false)
            }
            None => {
                let id = new_item_id();
                self.open = Some((id.clone(), text.len(), self.calls));
                (id, true)
            }
        }
    }

    /// A tool call of the response streamed whole: a segment after it shows after its card.
    pub(super) fn called(&mut self) {
        self.calls += 1;
    }

    /// Closes the open segment: its id, when one was open.
    pub(super) fn close(&mut self) -> Option<ItemId> {
        let open = self.open.take()?;
        let id = open.0.clone();
        self.closed.push(open);
        Some(id)
    }

    /// The response's segments, taken whole as its message commits: the row's id (its first segment's) and what the row's
    /// `meta` names of the showing, which the transcript reads back to show the same rows. `segments` when the text was not
    /// shown whole before the calls, as more than one or after a call (`[{id, len, after}]`, `len` in bytes of the shown
    /// text, `after` the tool calls before it), and `shownText` when progress updates were shown among it: the text shown,
    /// which the message's own text then is not.
    pub(super) fn take(&mut self) -> Option<(ItemId, serde_json::Map<String, Value>)> {
        let mut all = std::mem::take(&mut self.closed);
        all.extend(self.open.take());
        self.calls = 0;
        let (shown, updates) = (std::mem::take(&mut self.shown), std::mem::take(&mut self.updates));
        let first = all.first()?.0.clone();
        let mut named = serde_json::Map::new();
        if all.len() > 1 || all[0].2 > 0 {
            named
                .insert("segments".into(), Value::Array(all.iter().map(|(id, len, after)| json!({ "id": id.as_str(), "len": len, "after": after })).collect()));
        }
        if updates {
            named.insert("shownText".into(), Value::String(shown));
        }
        Some((first, named))
    }
}

/// `row`'s `meta` with what it names of how its reply was shown ([`Segments::take`]).
pub(super) fn with_shown(row: &mut Value, named: serde_json::Map<String, Value>) {
    if !named.is_empty()
        && let Some(object) = row.as_object_mut()
        && let Some(meta) = object.entry("meta").or_insert_with(|| json!({})).as_object_mut()
    {
        meta.extend(named);
    }
}
