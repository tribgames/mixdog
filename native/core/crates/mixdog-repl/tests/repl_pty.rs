//! The REPL on a screen: the bytes it writes are replayed on a terminal (the VT grid of `mixdog-term`, which is the in-process
//! pseudo-terminal of this crate's tests) and the rows are checked after a streamed markdown answer, a tool call and `/quit`.
//! The keys come in as the bytes a terminal sends and go through the real decoder and line editor.
//!
//! The session is a stand-in for a core that streams: after each prompt it publishes the states of a scripted turn, one per
//! frame. The REPL is not run against a core in a pseudo-terminal here (that would start a binary and a core, which a test of
//! this crate does not do); what is checked is the screen the REPL's own output makes.

use std::collections::VecDeque;
use std::io;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_repl::Footer;
use mixdog_repl::InputMsg;
use mixdog_repl::Out;
use mixdog_repl::Repl;
use mixdog_repl::ReplConfig;
use mixdog_repl::Session;
use mixdog_session_view::store::StoreEvent;
use mixdog_term::reader::TermEvent;
use mixdog_term::testing::VtGrid;
use mixdog_tui::footer::RenderArgs;
use mixdog_tui_style::color::Styler;
use serde_json::Value;
use serde_json::json;
use tokio::sync::broadcast;
use tokio::sync::mpsc::unbounded_channel;

/// A core that streams the scripted turns, one after another.
struct Streaming {
    turns: Mutex<VecDeque<Vec<Value>>>,
    playing: Mutex<VecDeque<Value>>,
    current: Mutex<Value>,
    submitted: Mutex<Vec<String>>,
    disposed: Mutex<Vec<String>>,
    feed: broadcast::Sender<StoreEvent>,
    /// Told Ctrl+C once the last scripted state is published: the user's interrupt arrives after the answer.
    interrupt_after: Mutex<Option<tokio::sync::mpsc::UnboundedSender<InputMsg>>>,
}

impl Streaming {
    fn new(turns: Vec<Vec<Value>>) -> Self {
        Self {
            turns: Mutex::new(turns.into()),
            playing: Mutex::new(VecDeque::new()),
            current: Mutex::new(json!({ "provider": "prov", "model": "mod", "items": [] })),
            submitted: Mutex::new(Vec::new()),
            disposed: Mutex::new(Vec::new()),
            feed: broadcast::channel(1).0,
            interrupt_after: Mutex::new(None),
        }
    }
}

#[async_trait::async_trait]
impl Session for Streaming {
    fn state(&self) -> Arc<Value> {
        Arc::new(self.current.lock().expect("state").clone())
    }

    fn tick(&self) -> bool {
        let mut playing = self.playing.lock().expect("playing");
        let Some(next) = playing.pop_front() else { return false };
        *self.current.lock().expect("state") = next;
        if playing.is_empty()
            && self.turns.lock().expect("turns").is_empty()
            && let Some(interrupt) = self.interrupt_after.lock().expect("interrupt").as_ref()
        {
            interrupt.send(keys("\u{3}")).expect("sent");
        }
        true
    }

    fn subscribe(&self) -> broadcast::Receiver<StoreEvent> {
        self.feed.subscribe()
    }

    async fn submit(&self, prompt: &str) -> Result<(), String> {
        self.submitted.lock().expect("submitted").push(prompt.to_owned());
        let turn = self.turns.lock().expect("turns").pop_front().unwrap_or_default();
        self.playing.lock().expect("playing").extend(turn);
        Ok(())
    }

    async fn call(&self, _action: &str, _args: &[Value]) -> Result<Value, String> {
        Ok(Value::Null)
    }

    async fn dispose(&self, reason: &str) {
        self.disposed.lock().expect("disposed").push(reason.to_owned());
    }
}

struct Tag;

impl Footer for Tag {
    fn line(&self, args: &RenderArgs) -> String {
        format!("[{}/{}]", args.provider, args.model)
    }
}

/// The terminal the REPL writes to.
struct Terminal {
    grid: VtGrid,
}

impl Out for Terminal {
    fn write_str(&mut self, text: &str) -> io::Result<()> {
        self.grid.feed(text.as_bytes());
        Ok(())
    }

    fn columns(&self) -> Option<usize> {
        Some(60)
    }
}

fn keys(text: &str) -> InputMsg {
    InputMsg::Term(TermEvent::Bytes(text.as_bytes().to_vec()))
}

/// The states of a turn that streams `parts` line by line and then ends, after the rows of the earlier turns in `before`.
fn streamed_turn(before: &[Value], id: &str, parts: &[&str], tools: &[Value]) -> Vec<Value> {
    let state = |items: Vec<Value>, live: Option<(&str, &str)>| {
        let mut state = json!({ "provider": "prov", "model": "mod", "items": items });
        if let Some((tail, partial)) = live {
            if !tail.is_empty() {
                state["streamingTail"] = json!({ "id": id, "text": tail });
            }
            state["streamingPartial"] = json!({ "id": id, "from": tail.len(), "text": partial });
        }
        state
    };
    let mut states = Vec::new();
    let mut shown = String::new();
    for part in parts {
        let (tail, partial) = (shown.clone(), (*part).to_owned());
        states.push(state(before.to_vec(), Some((&tail, &partial))));
        shown.push_str(part);
        shown.push('\n');
    }
    let text = parts.join("\n");
    let mut items = before.to_vec();
    items.push(json!({ "id": id, "kind": "assistant", "text": text }));
    items.extend(tools.iter().cloned());
    items.push(json!({ "id": format!("{id}-end"), "kind": "turndone", "status": "done", "finalAssistantId": id }));
    states.push(state(items, None));
    states
}

async fn run(session: &Streaming, input: Vec<InputMsg>, interrupt_at_the_end: bool) -> (i32, VtGrid) {
    let (tx, mut rx) = unbounded_channel();
    if interrupt_at_the_end {
        *session.interrupt_after.lock().expect("interrupt") = Some(tx.clone());
    }
    for msg in input {
        tx.send(msg).expect("sent");
    }
    let config = ReplConfig { provider: Some("prov".to_owned()), model: Some("mod".to_owned()), tool_mode: "full".to_owned(), cwd: "/work/proj".to_owned(), styler: Styler::new(true, true), interactive: true };
    let mut terminal = Terminal { grid: VtGrid::new(60, 40) };
    let code = Repl::new(session, &Tag, &config, &mut terminal, &mut rx).run().await;
    (code, terminal.grid)
}

#[tokio::test]
async fn a_streamed_markdown_answer_is_rewritten_in_place_and_quit_says_bye() {
    let session = Streaming::new(vec![streamed_turn(&[], "a1", &["# Plan", "", "do **it** now"], &[])]);
    let (code, grid) = run(&session, vec![keys("explain"), keys("\r"), keys("/quit"), keys("\r")], false).await;
    assert_eq!(code, 0);
    let screen = grid.dump();
    let at = |marker: &str| grid.find_row(marker).unwrap_or_else(|| panic!("no row holds {marker:?} in {screen:#?}"));
    assert!(screen[0].starts_with("mixdog \u{2014} prov/mod"), "{screen:#?}");
    let asked = at("\u{203a} explain");
    // The raw markdown is gone; what stands there is the rendered answer, between the prompt and the footer.
    assert!(grid.find_row("**it**").is_none(), "{screen:#?}");
    assert!(grid.find_row("# Plan").is_none(), "{screen:#?}");
    let (heading, body, footer, bye) = (at("\u{258c} Plan"), at("do it now"), at("[prov/mod]"), at("bye."));
    assert!(asked < heading && heading < body && body < footer && footer < bye, "{screen:#?}");
    assert_eq!(session.submitted.lock().expect("submitted").as_slice(), ["explain"]);
    assert_eq!(session.disposed.lock().expect("disposed").as_slice(), ["cli-exit"]);
}

#[tokio::test]
async fn a_tool_call_prints_its_card_and_the_turn_keeps_its_live_transcript() {
    let tool = json!({ "id": "t1", "kind": "tool", "name": "read", "args": { "path": "src/lib.rs" } });
    let session = Streaming::new(vec![streamed_turn(&[], "a1", &["looking at **it**"], &[tool])]);
    let (code, grid) = run(&session, vec![keys("go"), keys("\r")], true).await;
    assert_eq!(code, 130);
    let screen = grid.dump();
    let at = |marker: &str| grid.find_row(marker).unwrap_or_else(|| panic!("no row holds {marker:?} in {screen:#?}"));
    let (text, card, footer) = (at("looking at **it**"), at("read src/lib.rs"), at("[prov/mod]"));
    assert!(text < card && card < footer, "{screen:#?}");
    assert_eq!(session.disposed.lock().expect("disposed").as_slice(), ["SIGINT"]);
}

#[tokio::test]
async fn two_turns_and_editing_keys_before_enter() {
    let first = streamed_turn(&[], "a1", &["one"], &[]);
    let earlier = vec![json!({ "id": "a1", "kind": "assistant", "text": "one" }), json!({ "id": "a1-end", "kind": "turndone", "status": "done", "finalAssistantId": "a1" })];
    let second = streamed_turn(&earlier, "a2", &["two"], &[]);
    let session = Streaming::new(vec![first, second]);
    // "hexllo", Left x3, Backspace, Right x3 -> "hello"; the second prompt is recalled from the history with Up.
    let (left, right, up, back) = ("\u{1b}[D", "\u{1b}[C", "\u{1b}[A", "\u{7f}");
    let input = vec![
        keys("hexllo"),
        keys(left),
        keys(left),
        keys(left),
        keys(back),
        keys(right),
        keys(right),
        keys(right),
        keys("\r"),
        keys(up),
        keys(left),
        keys("\r"),
        keys("/quit"),
        keys("\r"),
    ];
    let (code, grid) = run(&session, input, false).await;
    assert_eq!(code, 0);
    assert_eq!(session.submitted.lock().expect("submitted").as_slice(), ["hello", "hello"]);
    let screen = grid.dump();
    assert!(grid.find_row("one").is_some() && grid.find_row("two").is_some(), "{screen:#?}");
}
