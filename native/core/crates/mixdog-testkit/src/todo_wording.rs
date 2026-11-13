//! Node's sentences about the todo list, as this core says them.
//!
//! The core's `todo` tool is its own (`set`, `advance`, step numbers), so three sentences that named Node's tool (its
//! `append`, its item wordings) are worded for this one. A recording made from Node carries Node's sentences, both
//! in what a test feeds the core and in what it expects back; a test that reads such a recording passes its text
//! through here first, so everything else in it is still compared whole.

const SENTENCES: [(&str, &str); 3] = [
    (
        "- Keep the steps in todo: append work you discover, close items as they finish.",
        "- Keep the steps in todo: advance as each finishes, set the list again when the plan changes.",
    ),
    ("Todo list for this Goal (exact wordings):", "Todo list for this Goal:"),
    ("Context was compacted; your todo list (exact wordings):", "Context was compacted; your todo list:"),
];

/// `recorded` (a fixture's text) with Node's three sentences about the todo list replaced by this core's.
pub fn todo_wording(recorded: &str) -> String {
    SENTENCES.iter().fold(recorded.to_owned(), |text, (node, ours)| text.replace(node, ours))
}
