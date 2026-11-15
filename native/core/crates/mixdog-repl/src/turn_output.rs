//! `repl/turn-output.mjs` and the turn side of `repl.mjs`: what the REPL prints once a turn has settled (the markdown
//! re-render of the streamed block, on a terminal and for text-only turns, and the per-turn statusline), and the fold of the
//! session's state into the pieces a turn prints while it runs.
//!
//! Node's REPL drove an in-process runtime that called back with text deltas, tool calls and the final content. The session
//! the REPL follows now is a core's: its state holds the transcript rows of the turn and the line being streamed.
//! [`TurnFollow`] turns each state into the same steps the callbacks were: text to append, a tail to take back, a tool card,
//! and the end of the turn with its final text.

use std::collections::HashMap;
use std::collections::HashSet;
use std::io;

use mixdog_js::utf16_len;
use mixdog_markdown_ansi::stream::build_stream_final_patch;
use mixdog_tui::footer::RenderArgs;
use mixdog_tui::footer::StatuslineRenderer;
use serde_json::Value;
use serde_json::json;

use crate::stream_sink::Out;
use crate::stream_sink::StreamSink;
use crate::stream_sink::erase_streamed_block;

/// The statusline the REPL prints under a turn.
pub trait Footer: Send + Sync {
    /// `renderStatusline(args)`.
    fn line(&self, args: &RenderArgs) -> String;
}

impl Footer for StatuslineRenderer {
    fn line(&self, args: &RenderArgs) -> String {
        self.render(args)
    }
}

/// `finalizeTurnOutput({ out, sink, finalText, renderMarkdown })`: the raw streamed block is cleared and printed again as
/// markdown, but only on a terminal (a cursor escape must never reach a pipe or an `NO_COLOR` log) and only for a turn that
/// printed no tool card (the cursor would have to move through the card rows). A turn that streamed nothing is rendered once;
/// every other turn keeps its raw stream and only ends the line.
pub fn finalize_turn_output(out: &mut dyn Out, sink: &StreamSink, final_text: &str, color: bool, render_markdown: &dyn Fn(&str) -> String) -> io::Result<()> {
    if final_text.is_empty() {
        return Ok(());
    }
    if sink.printed_any() && color && !sink.printed_tool_card() {
        let rendered = render_markdown(final_text);
        let columns = out.columns().filter(|columns| *columns > 0).unwrap_or(80);
        match build_stream_final_patch(sink.current_text(), &rendered, columns) {
            Some(patch) => out.write_str(&patch.output)?,
            None => {
                erase_streamed_block(out, sink.current_text())?;
                out.write_str(&rendered)?;
            }
        }
        out.write_str("\n")
    } else if !sink.printed_any() {
        // Nothing streamed live: render once.
        out.write_str(&format!("{}\n", render_markdown(final_text)))
    } else {
        // Tool cards are printed after the streamed text: erasing only the text from the cursor would clear and move through
        // the card rows and make the terminal scroll jump, so a mixed turn keeps its live transcript. Without a terminal
        // (or with NO_COLOR) the raw stream stays as well and only the line is ended.
        out.write_str("\n")
    }
}

/// `statuslineFor(renderStatusline, { runtime, cwd, stats })`: the arguments of the footer render from the session's state.
pub fn statusline_args(state: &Value, cwd: &str, columns: Option<usize>) -> RenderArgs {
    let text = |key: &str| state[key].as_str().unwrap_or_default().to_owned();
    let number = |key: &str| state[key].as_f64().unwrap_or(0.0);
    RenderArgs {
        provider: text("provider"),
        model: text("model"),
        cwd: cwd.to_owned(),
        stats: state.get("stats").filter(|stats| stats.is_object()).cloned(),
        context_window: number("contextWindow"),
        raw_context_window: number("rawContextWindow"),
        terminal_columns: columns.map(|columns| columns as f64),
        ..RenderArgs::default()
    }
}

/// The footer line of the session in `state`.
pub fn statusline_for(footer: &dyn Footer, state: &Value, cwd: &str, columns: Option<usize>) -> String {
    footer.line(&statusline_args(state, cwd, columns))
}

/// One piece of a running turn.
#[derive(Debug, Clone, PartialEq)]
pub enum TurnStep {
    /// Streamed text to append (`onTextDelta`).
    Delta(String),
    /// Take the last `chars` UTF-16 units of the streamed text back (`onTextReset`).
    Reset { chars: usize },
    /// A tool call, as `{ name, arguments }` (`onToolCall`).
    Card(Value),
    /// A tool approval the session waits for, by its tool name.
    Approval(String),
    /// The turn ended.
    Done(TurnEnd),
}

/// How a turn ended.
#[derive(Debug, Clone, PartialEq)]
pub struct TurnEnd {
    /// The final assistant message (`result.content`), when the turn has one.
    pub final_text: Option<String>,
    /// The failure the turn ended with, as the line `[error] ...` shows it; none for a turn that did not fail.
    pub error: Option<String>,
}

/// The rows of the transcript a turn adds and the line being streamed, followed state by state.
#[derive(Debug, Default)]
pub struct TurnFollow {
    before: HashSet<String>,
    streamed: HashMap<String, String>,
    cards: HashSet<String>,
    asked: HashSet<String>,
}

fn id_of(row: &Value) -> String {
    match &row["id"] {
        Value::String(id) => id.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// The line streamed now: the lines the fold completed and the unfinished one beyond them.
fn live_text(state: &Value) -> Option<(String, String)> {
    let tail = &state["streamingTail"];
    let partial = &state["streamingPartial"];
    let id = [&partial["id"], &tail["id"]].into_iter().find_map(|id| id.as_str().map(str::to_owned))?;
    let text = format!("{}{}", tail["text"].as_str().unwrap_or_default(), partial["text"].as_str().unwrap_or_default());
    Some((id, text))
}

fn common_prefix_len(a: &str, b: &str) -> usize {
    a.chars().zip(b.chars()).take_while(|(x, y)| x == y).map(|(x, _)| x.len_utf8()).sum()
}

impl TurnFollow {
    /// A follow of the turn that starts after `state`: its rows are not the turn's.
    pub fn after(state: &Value) -> Self {
        let before = state["items"].as_array().map(|rows| rows.iter().map(id_of).collect()).unwrap_or_default();
        Self { before, ..Self::default() }
    }

    fn text(&mut self, id: &str, text: &str, steps: &mut Vec<TurnStep>) {
        let shown = self.streamed.entry(id.to_owned()).or_default();
        if shown == text {
            return;
        }
        if let Some(delta) = text.strip_prefix(shown.as_str()) {
            steps.push(TurnStep::Delta(delta.to_owned()));
        } else {
            // The text moved under what was shown: take back what differs, then show the rest.
            let common = common_prefix_len(shown, text);
            steps.push(TurnStep::Reset { chars: utf16_len(&shown[common..]) });
            if common < text.len() {
                steps.push(TurnStep::Delta(text[common..].to_owned()));
            }
        }
        *shown = text.to_owned();
    }

    /// What `state` adds to the turn since the last call.
    pub fn follow(&mut self, state: &Value) -> Vec<TurnStep> {
        let mut steps = Vec::new();
        let mut ended = None;
        let mut last_assistant: Option<(String, String)> = None;
        let rows = state["items"].as_array().map(Vec::as_slice).unwrap_or_default();
        for row in rows {
            let id = id_of(row);
            if self.before.contains(&id) {
                continue;
            }
            match row["kind"].as_str() {
                Some("assistant") => {
                    let text = row["text"].as_str().unwrap_or_default().to_owned();
                    self.text(&id, &text, &mut steps);
                    last_assistant = Some((id, text));
                }
                Some("tool") => {
                    if self.cards.insert(id) {
                        steps.push(TurnStep::Card(json!({ "name": row["name"], "arguments": row["args"] })));
                    }
                }
                Some("turndone") => ended = Some(row),
                _ => {}
            }
        }
        if let Some((id, text)) = live_text(state).filter(|(id, _)| !last_assistant.as_ref().is_some_and(|(last, _)| last == id) && !self.before.contains(id)) {
            self.text(&id, &text, &mut steps);
        }
        if let Some(approval) = state["toolApproval"].as_object() {
            let key = approval.get("id").map_or_else(String::new, |id| id.as_str().map_or_else(|| id.to_string(), str::to_owned));
            if self.asked.insert(key) {
                let tool = ["tool", "name", "kind"].into_iter().find_map(|field| approval.get(field).and_then(Value::as_str)).unwrap_or("a tool");
                steps.push(TurnStep::Approval(tool.to_owned()));
            }
        }
        if let Some(end) = ended {
            let wanted = end["finalAssistantId"].as_str();
            let final_text = rows
                .iter()
                .filter(|row| row["kind"] == "assistant" && !self.before.contains(&id_of(row)))
                .rev()
                .find(|row| wanted.is_none_or(|wanted| id_of(row) == wanted))
                .or_else(|| rows.iter().rfind(|row| row["kind"] == "assistant" && !self.before.contains(&id_of(row))))
                .and_then(|row| row["text"].as_str())
                .filter(|text| !text.is_empty())
                .map(str::to_owned);
            let failed = matches!(end["status"].as_str(), Some("failed"));
            let error = failed.then(|| {
                ["errorDetails", "detail"].into_iter().find_map(|field| end[field].as_str().filter(|text| !text.is_empty())).unwrap_or("the turn failed").to_owned()
            });
            steps.push(TurnStep::Done(TurnEnd { final_text, error }));
        }
        steps
    }
}

#[cfg(test)]
mod tests {
    use mixdog_rt::time::Instant;

    use super::*;
    use crate::stream_sink::Capture;

    fn finalize(color: bool, tool_card: bool, final_text: &str) -> String {
        let mut out = Capture::default();
        let mut sink = StreamSink::new(color);
        sink.push_delta("hello", Instant::now()).expect("pushed");
        if tool_card {
            sink.write_tool_card(&mut out, "[tool]").expect("card");
        }
        sink.flush(&mut out).expect("flushed");
        finalize_turn_output(&mut out, &sink, final_text, color, &|_| panic!("the live transcript must not be re-rendered")).expect("finalized");
        out.text
    }

    #[test]
    fn a_coloured_turn_with_a_tool_card_keeps_its_stream_and_ends_the_line() {
        assert_eq!(finalize(true, true, "hello"), "hello\n[tool]\n\n");
    }

    #[test]
    fn a_turn_without_colour_keeps_its_raw_stream_and_ends_the_line() {
        assert_eq!(finalize(false, false, "hello"), "hello\n");
    }

    #[test]
    fn a_coloured_text_turn_is_patched_in_place_or_redrawn() {
        let mut out = Capture { columns: Some(80), ..Capture::default() };
        let mut sink = StreamSink::new(true);
        sink.push_delta("a\n**b**", Instant::now()).expect("pushed");
        sink.flush(&mut out).expect("flushed");
        finalize_turn_output(&mut out, &sink, "a\n**b**", true, &|_| "a\nB".to_owned()).expect("finalized");
        assert_eq!(out.text, "a\n**b**\r\x1b[2KB\r\x1b[1A\r\x1b[1B\x1b[1C\n");

        let mut wrapped = Capture { columns: Some(4), ..Capture::default() };
        let mut long = StreamSink::new(true);
        long.push_delta("abcdef", Instant::now()).expect("pushed");
        long.flush(&mut wrapped).expect("flushed");
        finalize_turn_output(&mut wrapped, &long, "abcdef", true, &|_| "X".to_owned()).expect("finalized");
        assert_eq!(wrapped.text, "abcdef\r\x1b[2K\x1b[1A\x1b[2K\rX\n");
    }

    #[test]
    fn a_turn_that_streamed_nothing_is_rendered_once_and_an_empty_final_text_prints_nothing() {
        let mut out = Capture::default();
        let sink = StreamSink::new(true);
        finalize_turn_output(&mut out, &sink, "text", true, &|text| format!("<{text}>")).expect("finalized");
        finalize_turn_output(&mut out, &sink, "", true, &|text| format!("<{text}>")).expect("finalized");
        assert_eq!(out.text, "<text>\n");
    }

    fn state(items: &Value) -> Value {
        json!({ "items": items })
    }

    #[test]
    fn the_follow_turns_rows_and_the_live_line_into_steps() {
        let before = state(&json!([{ "id": "u0", "kind": "user", "text": "earlier" }, { "id": "a0", "kind": "assistant", "text": "old" }]));
        let mut follow = TurnFollow::after(&before);
        assert_eq!(follow.follow(&before), Vec::<TurnStep>::new());

        let mut live = state(&json!([{ "id": "u0", "kind": "user" }, { "id": "a0", "kind": "assistant", "text": "old" }, { "id": "u1", "kind": "user" }]));
        live["streamingPartial"] = json!({ "id": "a1", "from": 0, "text": "Hel" });
        assert_eq!(follow.follow(&live), vec![TurnStep::Delta("Hel".to_owned())]);
        live["streamingTail"] = json!({ "id": "a1", "text": "Hello\n" });
        live["streamingPartial"] = json!({ "id": "a1", "from": 6, "text": "wor" });
        assert_eq!(follow.follow(&live), vec![TurnStep::Delta("lo\nwor".to_owned())]);

        let done = state(&json!([
            { "id": "a0", "kind": "assistant", "text": "old" },
            { "id": "a1", "kind": "assistant", "text": "Hello\nworld" },
            { "id": "t1", "kind": "tool", "name": "read", "args": { "path": "x" } },
            { "id": "e1", "kind": "turndone", "status": "done", "finalAssistantId": "a1" },
        ]));
        assert_eq!(
            follow.follow(&done),
            vec![
                TurnStep::Delta("ld".to_owned()),
                TurnStep::Card(json!({ "name": "read", "arguments": { "path": "x" } })),
                TurnStep::Done(TurnEnd { final_text: Some("Hello\nworld".to_owned()), error: None }),
            ]
        );
        // A card is told once.
        assert!(follow.follow(&done).iter().all(|step| !matches!(step, TurnStep::Card(_))));
    }

    #[test]
    fn text_that_moves_under_what_was_shown_takes_the_difference_back() {
        let mut follow = TurnFollow::default();
        let first = state(&json!([{ "id": "a", "kind": "assistant", "text": "abcdef" }]));
        assert_eq!(follow.follow(&first), vec![TurnStep::Delta("abcdef".to_owned())]);
        let second = state(&json!([{ "id": "a", "kind": "assistant", "text": "abXY" }]));
        assert_eq!(follow.follow(&second), vec![TurnStep::Reset { chars: 4 }, TurnStep::Delta("XY".to_owned())]);
    }

    #[test]
    fn a_failed_turn_carries_its_error_and_an_approval_is_told_once() {
        let mut follow = TurnFollow::default();
        let mut failed = state(&json!([{ "id": "e", "kind": "turndone", "status": "failed", "detail": "boom" }]));
        failed["toolApproval"] = json!({ "id": "c1", "tool": "shell" });
        assert_eq!(
            follow.follow(&failed),
            vec![TurnStep::Approval("shell".to_owned()), TurnStep::Done(TurnEnd { final_text: None, error: Some("boom".to_owned()) })]
        );
        assert!(follow.follow(&failed).iter().all(|step| !matches!(step, TurnStep::Approval(_))));
    }

    #[test]
    fn the_footer_arguments_come_from_the_state() {
        let state = json!({ "provider": "p", "model": "m", "contextWindow": 1000, "rawContextWindow": 2000, "stats": { "inputTokens": 3 } });
        let args = statusline_args(&state, "/w", Some(100));
        assert_eq!((args.provider.as_str(), args.model.as_str(), args.cwd.as_str()), ("p", "m", "/w"));
        assert_eq!((args.context_window, args.raw_context_window, args.terminal_columns), (1000.0, 2000.0, Some(100.0)));
        assert_eq!(args.stats, Some(json!({ "inputTokens": 3 })));
        assert_eq!(statusline_args(&json!({}), "/w", None).stats, None);
    }
}
