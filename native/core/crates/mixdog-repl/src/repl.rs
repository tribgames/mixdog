//! The loop of the plain REPL: banner, a prompt read through the line editor, a `/command` or a turn, and again. The session is
//! connected before the banner; [`Session::dispose`] is idempotent, so the signal path and the loop's own end may both ask for it.

use std::collections::VecDeque;
use std::io;
use std::io::IsTerminal;
use std::io::Write;
use std::path::Path;
use std::time::Duration;

use mixdog_js::js_trim;
use mixdog_markdown_ansi::repl_render::render_repl_markdown_with;
use mixdog_rt::time::Instant;
use mixdog_session_view::store::ConnectionState;
use mixdog_session_view::store::StoreEvent;
use mixdog_term::Decoder;
use mixdog_term::reader::TermEvent;
use mixdog_tui_style::color::Style;
use mixdog_tui_style::color::Styler;
use mixdog_view_model::display::tool_card::render_tool_card;
use tokio::sync::broadcast;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::mpsc::UnboundedReceiver;

use crate::Session;
use crate::line_editor::Effect;
use crate::line_editor::LineEditor;
use crate::slash::SlashContext;
use crate::slash::SlashOutcome;
use crate::slash::handle_slash;
use crate::stream_sink::Out;
use crate::stream_sink::StreamSink;
use crate::turn_output::Footer;
use crate::turn_output::TurnEnd;
use crate::turn_output::TurnFollow;
use crate::turn_output::TurnStep;
use crate::turn_output::finalize_turn_output;
use crate::turn_output::statusline_for;

/// How often the session's state is published while a turn runs (one terminal frame).
const FRAME: Duration = Duration::from_millis(16);

/// The exit code of an interrupted REPL (`code: 130` of the SIGINT cleanup).
pub const SIGINT_EXIT: i32 = 130;

/// What the terminal or a pipe delivers to the REPL.
#[derive(Debug)]
pub enum InputMsg {
    /// What a terminal reader read (keys, pastes) or its size change.
    Term(TermEvent),
    /// A line of a piped input.
    Line(String),
    /// The end of a piped input.
    Eof,
}

/// How the REPL is set up.
#[derive(Debug, Clone)]
pub struct ReplConfig {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub tool_mode: String,
    pub cwd: String,
    pub styler: Styler,
    /// The input is a terminal read through the line editor; otherwise it is lines.
    pub interactive: bool,
}

/// The terminal's output stream.
pub struct StdoutOut {
    stdout: io::Stdout,
    terminal: bool,
}

impl StdoutOut {
    pub fn new() -> Self {
        let stdout = io::stdout();
        let terminal = stdout.is_terminal();
        Self { stdout, terminal }
    }

    /// Whether the output is a terminal.
    pub fn is_terminal(&self) -> bool {
        self.terminal
    }
}

impl Default for StdoutOut {
    fn default() -> Self {
        Self::new()
    }
}

impl Out for StdoutOut {
    fn write_str(&mut self, text: &str) -> io::Result<()> {
        let mut lock = self.stdout.lock();
        lock.write_all(text.as_bytes())?;
        lock.flush()
    }

    fn columns(&self) -> Option<usize> {
        if !self.terminal {
            return None;
        }
        mixdog_term::console::terminal_size().ok().map(|(columns, _)| usize::from(columns))
    }
}

/// `promptText()`.
fn prompt_text(styler: Styler) -> String {
    styler.paint(Style::Cyan, &styler.paint(Style::Bold, "\u{203a} "))
}

/// `printBanner(out, providerName, model, cwd, toolMode)`.
fn banner(config: &ReplConfig) -> String {
    let styler = config.styler;
    let provider = config.provider.as_deref().filter(|name| !name.is_empty()).unwrap_or("auto");
    let model = config.model.as_deref().filter(|name| !name.is_empty()).unwrap_or("default");
    let folder = Path::new(&config.cwd).file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let dim = |text: &str| styler.paint(Style::Dim, text);
    format!(
        "{} {} {} {} {} {} {}\n{}\n\n",
        styler.paint(Style::Bold, "mixdog"),
        dim("\u{2014}"),
        styler.paint(Style::Cyan, &format!("{provider}/{model}")),
        dim("\u{b7}"),
        dim(&config.tool_mode),
        dim("\u{b7}"),
        dim(&folder),
        dim("Type a message, or /help for commands. Ctrl+C to exit."),
    )
}

/// The wait for the next input message, endless once the input has ended.
async fn pending_forever<T>() -> T {
    std::future::pending().await
}

/// What the input is made of while the REPL reads or runs a turn.
struct Input<'a> {
    rx: &'a mut UnboundedReceiver<InputMsg>,
    interactive: bool,
    decoder: Decoder,
    editor: LineEditor,
    /// Lines entered, in order, with whether they were already echoed under the prompt (a line typed while a turn printed
    /// was not).
    queued: VecDeque<(String, bool)>,
    ended: bool,
}

/// Where a prompt is painted while input is absorbed.
struct Paint<'a> {
    out: &'a mut dyn Out,
    prompt: &'a str,
}

/// What reading a line came to.
enum Read {
    Line(String),
    Eof,
    Interrupt,
}

/// How a turn ended for the loop.
enum TurnExit {
    Done,
    Interrupted,
}

/// How the following of a turn ended.
enum Followed {
    Ended(TurnEnd),
    Failed(String),
    Interrupted,
}

/// The REPL over a session.
pub struct Repl<'a> {
    session: &'a dyn Session,
    footer: &'a dyn Footer,
    config: &'a ReplConfig,
    out: &'a mut dyn Out,
    input: Input<'a>,
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::Mutex;

    use mixdog_term::testing::VtGrid;
    use mixdog_tui::footer::RenderArgs;
    use mixdog_tui_style::color::strip_ansi;
    use serde_json::Value;
    use serde_json::json;
    use tokio::sync::mpsc::unbounded_channel;

    use super::*;
    use crate::stream_sink::Capture;

    /// A session that plays a script: each submit moves it to its next state, the way a core's feed would.
    struct Played {
        feed: broadcast::Sender<StoreEvent>,
        /// Sent once the last scripted state is reached.
        after_last: Option<tokio::sync::mpsc::UnboundedSender<InputMsg>>,
        states: Mutex<Vec<Value>>,
        current: Mutex<Value>,
        submitted: Mutex<Vec<String>>,
        disposed: Mutex<Vec<String>>,
        calls: Mutex<Vec<String>>,
        failure: Option<String>,
    }

    impl Played {
        fn new(first: Value, later: Vec<Value>) -> Self {
            Self {
                feed: broadcast::channel(4).0,
                after_last: None,
                states: Mutex::new(later.into_iter().rev().collect()),
                current: Mutex::new(first),
                submitted: Mutex::new(Vec::new()),
                disposed: Mutex::new(Vec::new()),
                calls: Mutex::new(Vec::new()),
                failure: None,
            }
        }
    }

    #[async_trait::async_trait]
    impl Session for Played {
        fn state(&self) -> Arc<Value> {
            Arc::new(self.current.lock().expect("state").clone())
        }

        /// Once a prompt was submitted, each publication moves to the next scripted state.
        fn tick(&self) -> bool {
            if self.submitted.lock().expect("submitted").is_empty() {
                return false;
            }
            let mut states = self.states.lock().expect("states");
            let Some(next) = states.pop() else { return false };
            *self.current.lock().expect("state") = next;
            if states.is_empty()
                && let Some(after) = &self.after_last
            {
                after.send(bytes("\x03")).expect("sent");
            }
            true
        }

        fn subscribe(&self) -> broadcast::Receiver<StoreEvent> {
            self.feed.subscribe()
        }

        async fn submit(&self, prompt: &str) -> Result<(), String> {
            self.submitted.lock().expect("submitted").push(prompt.to_owned());
            self.failure.clone().map_or(Ok(()), Err)
        }

        async fn call(&self, action: &str, _args: &[Value]) -> Result<Value, String> {
            self.calls.lock().expect("calls").push(action.to_owned());
            Ok(Value::Null)
        }

        async fn dispose(&self, reason: &str) {
            self.disposed.lock().expect("disposed").push(reason.to_owned());
        }
    }

    struct Fixed;

    impl Footer for Fixed {
        fn line(&self, args: &RenderArgs) -> String {
            format!("[{}/{}]", args.provider, args.model)
        }
    }

    fn config(styler: Styler, interactive: bool) -> ReplConfig {
        ReplConfig { provider: Some("p".to_owned()), model: None, tool_mode: "full".to_owned(), cwd: "/work/proj".to_owned(), styler, interactive }
    }

    const OFF: Styler = Styler::new(false, true);
    const ON: Styler = Styler::new(true, true);

    /// Runs the REPL over lines until the input ends; returns the exit code and the output.
    async fn run_lines(session: &Played, styler: Styler, lines: &[&str]) -> (i32, String) {
        let (tx, mut rx) = unbounded_channel();
        for line in lines {
            tx.send(InputMsg::Line((*line).to_owned())).expect("sent");
        }
        tx.send(InputMsg::Eof).expect("sent");
        let mut out = Capture { columns: Some(80), ..Capture::default() };
        let config = config(styler, false);
        let code = Repl::new(session, &Fixed, &config, &mut out, &mut rx).run().await;
        (code, out.text)
    }

    fn base_state() -> Value {
        json!({ "provider": "prov", "model": "mod", "items": [] })
    }

    fn answered(text: &str, extra: Vec<Value>) -> Vec<Value> {
        let mut items = vec![json!({ "id": "a1", "kind": "assistant", "text": text })];
        items.extend(extra);
        items.push(json!({ "id": "e1", "kind": "turndone", "status": "done", "finalAssistantId": "a1" }));
        vec![json!({ "provider": "prov", "model": "mod", "items": items })]
    }

    #[tokio::test]
    async fn a_turn_streams_the_reply_and_ends_with_the_footer() {
        let session = Played::new(base_state(), answered("hello there", vec![]));
        let (code, text) = run_lines(&session, OFF, &["hi", "/quit"]).await;
        assert_eq!(code, 0);
        assert_eq!(session.submitted.lock().expect("submitted").as_slice(), ["hi"]);
        assert!(text.starts_with("mixdog \u{2014} p/default \u{b7} full \u{b7} proj\nType a message, or /help for commands. Ctrl+C to exit.\n\n"));
        assert!(text.contains("\u{203a} \nhello there\n\n[prov/mod]\n\n"), "{text:?}");
        assert!(text.ends_with("bye.\n"));
        assert_eq!(session.disposed.lock().expect("disposed").as_slice(), ["cli-exit"]);
    }

    #[tokio::test]
    async fn a_turn_with_a_tool_call_prints_the_card_after_the_text_and_keeps_the_stream() {
        let tool = json!({ "id": "t1", "kind": "tool", "name": "read", "args": { "path": "src/a.rs" } });
        let session = Played::new(base_state(), answered("done", vec![tool]));
        let (_, text) = run_lines(&session, OFF, &["go"]).await;
        assert!(text.contains("done\n  > read src/a.rs\n\n\n[prov/mod]\n\n"), "{text:?}");
    }

    #[tokio::test]
    async fn a_failed_turn_prints_the_error_and_no_footer() {
        let failed = json!({ "provider": "prov", "model": "mod", "items": [{ "id": "e1", "kind": "turndone", "status": "failed", "detail": "boom" }] });
        let session = Played::new(base_state(), vec![failed]);
        let (_, text) = run_lines(&session, OFF, &["go"]).await;
        assert!(text.contains("\n[error] boom\n\n"), "{text:?}");
        assert!(!text.contains("[prov/mod]"));
        let mut refused = Played::new(base_state(), vec![]);
        refused.failure = Some("no session".to_owned());
        let (_, text) = run_lines(&refused, OFF, &["go"]).await;
        assert!(text.contains("\n[error] no session\n\n"), "{text:?}");
    }

    #[tokio::test]
    async fn end_of_input_closes_the_session_blank_lines_are_skipped_and_a_failing_command_is_reported() {
        let session = Played::new(base_state(), vec![]);
        let (code, text) = run_lines(&session, OFF, &["", "   ", "/nope"]).await;
        assert_eq!(code, 0);
        assert!(session.submitted.lock().expect("submitted").is_empty());
        assert!(text.contains("unknown command: /nope  (try /help)\n"));
        assert_eq!(session.disposed.lock().expect("disposed").as_slice(), ["cli-eof"]);
    }

    /// The key events of a terminal as the reader would deliver them.
    fn bytes(text: &str) -> InputMsg {
        InputMsg::Term(TermEvent::Bytes(text.as_bytes().to_vec()))
    }

    #[tokio::test]
    async fn typed_keys_edit_the_line_echo_on_the_screen_and_enter_runs_the_turn() {
        let (tx, mut rx) = unbounded_channel();
        let mut session = Played::new(base_state(), answered("ok", vec![]));
        session.after_last = Some(tx.clone());
        for msg in [bytes("helo"), bytes("\x1b[D"), bytes("l"), bytes("\r")] {
            tx.send(msg).expect("sent");
        }
        let mut out = Capture { columns: Some(40), ..Capture::default() };
        let config = config(OFF, true);
        let code = Repl::new(&session, &Fixed, &config, &mut out, &mut rx).run().await;
        assert_eq!(code, SIGINT_EXIT);
        assert_eq!(session.submitted.lock().expect("submitted").as_slice(), ["hello"]);
        assert_eq!(session.disposed.lock().expect("disposed").as_slice(), ["SIGINT"]);
        let mut grid = VtGrid::new(40, 20);
        grid.feed(out.text.as_bytes());
        assert!(grid.find_row("\u{203a} hello").is_some(), "{:?}", grid.dump());
        assert!(grid.find_row("ok").is_some());
        assert!(grid.find_row("[prov/mod]").is_some());
    }

    #[tokio::test]
    async fn a_line_and_its_enter_read_in_one_chunk_run_the_turn() {
        let (tx, mut rx) = unbounded_channel();
        let mut session = Played::new(base_state(), answered("ok", vec![]));
        session.after_last = Some(tx.clone());
        tx.send(bytes("hello\r")).expect("sent");
        let mut out = Capture { columns: Some(40), ..Capture::default() };
        let config = config(OFF, true);
        let code = Repl::new(&session, &Fixed, &config, &mut out, &mut rx).run().await;
        assert_eq!(code, SIGINT_EXIT);
        assert_eq!(session.submitted.lock().expect("submitted").as_slice(), ["hello"]);
    }

    #[tokio::test]
    async fn a_markdown_answer_replaces_its_raw_stream_in_place_on_a_terminal() {
        let session = Played::new(base_state(), answered("# Title\n\nsome **bold** words", vec![]));
        let (_, text) = run_lines(&session, ON, &["go", "/quit"]).await;
        let mut grid = VtGrid::new(80, 30);
        grid.feed(text.as_bytes());
        let screen = grid.dump().join("\n");
        assert!(!screen.contains("**bold**"), "{screen}");
        assert!(screen.contains("\u{258c} Title"), "{screen}");
        assert!(screen.contains("some bold words"), "{screen}");
    }

    #[test]
    fn the_banner_names_the_route_the_mode_and_the_folder() {
        let shown = banner(&ReplConfig { provider: None, model: Some("m".to_owned()), ..config(OFF, false) });
        assert!(shown.starts_with("mixdog \u{2014} auto/m \u{b7} full \u{b7} proj\n"));
        assert_eq!(prompt_text(OFF), "\u{203a} ");
        assert_eq!(strip_ansi(&prompt_text(ON)), "\u{203a} ");
    }
}

/// A run of typed text that arrived in one read, cut at its line breaks into the text and an Enter for each (`\r\n` one), as
/// readline reads a chunk key by key; the decoder keeps them inside the run, where the editor would drop them as control text.
fn keystrokes(event: mixdog_term::InputEvent) -> Vec<mixdog_term::InputEvent> {
    use mixdog_term::InputEvent;
    use mixdog_term::KeyFlags;
    let InputEvent::Key { input, key } = &event else { return vec![event] };
    if input.len() < 2 || !input.contains(['\r', '\n']) || *key != KeyFlags::default() {
        return vec![event];
    }
    let enter = KeyFlags { return_key: true, ..KeyFlags::default() };
    let mut keys = Vec::new();
    for (index, text) in input.replace("\r\n", "\r").split(['\r', '\n']).enumerate() {
        if index > 0 {
            keys.push(InputEvent::Key { input: "\r".to_owned(), key: enter.clone() });
        }
        if !text.is_empty() {
            keys.push(InputEvent::Key { input: text.to_owned(), key: KeyFlags::default() });
        }
    }
    keys
}

/// A wait until `due`, endless when there is none.
async fn until(due: Option<Instant>) {
    match due {
        Some(due) => mixdog_rt::time::sleep_until(due).await,
        None => pending_forever().await,
    }
}
impl Input<'_> {
    /// The next message; endless once the input has ended.
    async fn recv(&mut self) -> Option<InputMsg> {
        if self.ended {
            return pending_forever().await;
        }
        self.rx.recv().await
    }

    /// The instant a half-received escape sequence is delivered as typed.
    fn decoder_due(&self) -> Option<Instant> {
        self.decoder.next_deadline().map(|due| Instant::now() + due.saturating_duration_since(std::time::Instant::now()))
    }

    /// Takes one message in. With `paint` the prompt row is kept up to date and a line entered is echoed; without it (a turn
    /// is printing) the keys edit the line silently, so the streamed block's rows stay where the in-place rewrite expects
    /// them. Returns true for Ctrl+C.
    fn absorb(&mut self, msg: Option<InputMsg>, mut paint: Option<Paint<'_>>) -> io::Result<bool> {
        let events = match msg {
            None | Some(InputMsg::Eof | InputMsg::Term(TermEvent::Closed)) => {
                self.ended = true;
                return Ok(false);
            }
            Some(InputMsg::Line(line)) => {
                self.queued.push_back((line, true));
                return Ok(false);
            }
            Some(InputMsg::Term(TermEvent::Resize(..))) => {
                if let Some(paint) = paint.as_mut() {
                    let columns = paint.out.columns().unwrap_or(80);
                    paint.out.write_str(&self.editor.paint(paint.prompt, columns))?;
                }
                return Ok(false);
            }
            Some(InputMsg::Term(TermEvent::Bytes(bytes))) => self.decoder.feed(&bytes, std::time::Instant::now()),
        };
        self.apply(events, paint)
    }

    /// The pending escape sequence whose wait is over.
    fn flush_due(&mut self, paint: Option<Paint<'_>>) -> io::Result<bool> {
        let events = self.decoder.flush_due(std::time::Instant::now());
        self.apply(events, paint)
    }

    fn apply(&mut self, events: Vec<mixdog_term::InputEvent>, mut paint: Option<Paint<'_>>) -> io::Result<bool> {
        let mut dirty = false;
        for event in events.into_iter().flat_map(keystrokes) {
            for effect in self.editor.apply(&event) {
                match effect {
                    Effect::Redraw => dirty = true,
                    Effect::Interrupt => return Ok(true),
                    Effect::Eof => {
                        self.ended = true;
                        return Ok(false);
                    }
                    Effect::ClearScreen => {
                        if let Some(paint) = paint.as_mut() {
                            paint.out.write_str(&self.editor.clear_screen())?;
                        }
                        dirty = true;
                    }
                    Effect::Submit => {
                        let echoed = paint.is_some();
                        if let Some(paint) = paint.as_mut() {
                            let columns = paint.out.columns().unwrap_or(80);
                            paint.out.write_str(&self.editor.paint(paint.prompt, columns))?;
                            paint.out.write_str(&self.editor.finish_line(paint.prompt, columns))?;
                        }
                        let line = self.editor.take();
                        self.queued.push_back((line, echoed));
                        dirty = false;
                    }
                }
            }
        }
        if dirty && let Some(paint) = paint.as_mut() {
            let columns = paint.out.columns().unwrap_or(80);
            paint.out.write_str(&self.editor.paint(paint.prompt, columns))?;
        }
        Ok(false)
    }
}
impl<'a> Repl<'a> {
    pub fn new(
        session: &'a dyn Session,
        footer: &'a dyn Footer,
        config: &'a ReplConfig,
        out: &'a mut dyn Out,
        rx: &'a mut UnboundedReceiver<InputMsg>,
    ) -> Self {
        let input = Input { rx, interactive: config.interactive, decoder: Decoder::new(), editor: LineEditor::new(), queued: VecDeque::new(), ended: false };
        Self { session, footer, config, out, input }
    }

    fn dim(&self, text: &str) -> String {
        self.config.styler.paint(Style::Dim, text)
    }

    /// The prompt, painted (a terminal) or written (lines), and one line read after it.
    async fn read_line(&mut self) -> io::Result<Read> {
        let prompt = prompt_text(self.config.styler);
        if self.input.interactive {
            let columns = self.out.columns().unwrap_or(80);
            self.out.write_str(&self.input.editor.paint(&prompt, columns))?;
        } else {
            self.out.write_str(&prompt)?;
        }
        loop {
            if let Some((line, echoed)) = self.input.queued.pop_front() {
                if self.input.interactive && !echoed {
                    // Typed while a turn ran: shown now, under the prompt.
                    self.out.write_str(&format!("{}\r\n", line.replace('\n', "\r\n")))?;
                }
                return Ok(Read::Line(line));
            }
            if self.input.ended {
                return Ok(Read::Eof);
            }
            let due = self.input.decoder_due();
            let interactive = self.input.interactive;
            let interrupted = tokio::select! {
                msg = self.input.recv() => {
                    let target = if interactive { Some(Paint { out: &mut *self.out, prompt: &prompt }) } else { None };
                    self.input.absorb(msg, target)?
                }
                () = until(due) => {
                    let target = if interactive { Some(Paint { out: &mut *self.out, prompt: &prompt }) } else { None };
                    self.input.flush_due(target)?
                }
            };
            if interrupted {
                return Ok(Read::Interrupt);
            }
        }
    }

    /// One prompt to one session turn: the live stream, tool cards, the final render and the footer.
    async fn run_turn(&mut self, line: &str) -> io::Result<TurnExit> {
        let styler = self.config.styler;
        self.out.write_str("\n")?;
        let mut sink = StreamSink::new(styler.enabled());
        self.session.tick();
        let mut follow = TurnFollow::after(&self.session.state());
        let mut events = self.session.subscribe();
        let followed = match self.session.submit(line).await {
            Ok(()) => self.follow_turn(&mut sink, &mut follow, &mut events).await?,
            Err(error) => Followed::Failed(error),
        };
        match followed {
            Followed::Interrupted => return Ok(TurnExit::Interrupted),
            Followed::Ended(end) if end.error.is_none() => {
                sink.flush(self.out)?;
                let final_text = end.final_text.filter(|text| !text.is_empty()).unwrap_or_else(|| sink.current_text().to_owned());
                finalize_turn_output(self.out, &sink, &final_text, styler.enabled(), &|text| render_repl_markdown_with(text, 80, styler))?;
                // The per-turn statusline footer.
                self.session.tick();
                let footer = statusline_for(self.footer, &self.session.state(), &self.config.cwd, self.out.columns());
                self.out.write_str(&format!("\n{footer}\n"))?;
            }
            Followed::Ended(TurnEnd { error, .. }) => self.report_failure(&mut sink, error.unwrap_or_default())?,
            Followed::Failed(error) => self.report_failure(&mut sink, error)?,
        }
        self.out.write_str("\n")?;
        Ok(TurnExit::Done)
    }

    /// `[error] <message>` after what streamed so far.
    fn report_failure(&mut self, sink: &mut StreamSink, error: String) -> io::Result<()> {
        // A failed flush is the error shown, as a failed flush replaced it in Node.
        let shown = match sink.flush(self.out) {
            Ok(()) => error,
            Err(flush_error) => flush_error.to_string(),
        };
        let red = self.config.styler.paint(Style::Red, &format!("[error] {shown}"));
        self.out.write_str(&format!("\n{red}\n"))
    }

    /// Follows the session until the turn ends, printing as it goes.
    async fn follow_turn(&mut self, sink: &mut StreamSink, follow: &mut TurnFollow, events: &mut broadcast::Receiver<StoreEvent>) -> io::Result<Followed> {
        let styler = self.config.styler;
        let mut frame = mixdog_rt::time::interval(FRAME);
        frame.set_missed_tick_behavior(mixdog_rt::time::MissedTickBehavior::Skip);
        loop {
            let sink_due = sink.next_deadline();
            let decoder_due = self.input.decoder_due();
            let mut interrupted = false;
            tokio::select! {
                _ = frame.tick() => {}
                event = events.recv() => match event {
                    Ok(StoreEvent::ConnectionStatus(ConnectionState::Closed { reason })) => return Ok(Followed::Failed(format!("the connection closed: {reason}"))),
                    Ok(StoreEvent::SessionLost { reason }) => return Ok(Followed::Failed(format!("the session was lost: {reason}"))),
                    Err(RecvError::Closed) => return Ok(Followed::Failed("the session closed".to_owned())),
                    Ok(_) | Err(RecvError::Lagged(_)) => {}
                },
                msg = self.input.recv() => interrupted = self.input.absorb(msg, None)?,
                () = until(sink_due) => {}
                () = until(decoder_due) => interrupted = self.input.flush_due(None)?,
            }
            if interrupted {
                return Ok(Followed::Interrupted);
            }
            sink.flush_due(self.out, Instant::now());
            self.session.tick();
            for step in follow.follow(&self.session.state()) {
                match step {
                    TurnStep::Delta(text) => sink.push_delta(&text, Instant::now())?,
                    TurnStep::Reset { chars } => {
                        sink.reset_tail(self.out, chars)?;
                    }
                    TurnStep::Card(call) => sink.write_tool_card(self.out, &render_tool_card(&call, styler))?,
                    TurnStep::Approval(tool) => {
                        sink.flush(self.out)?;
                        let notice = self.dim(&format!("approval needed for {tool}: answer it from another mixdog client"));
                        self.out.write_str(&format!("{notice}\n"))?;
                    }
                    TurnStep::Done(end) => return Ok(Followed::Ended(end)),
                }
            }
        }
    }

    /// `runRepl` after the setup: returns the exit code.
    pub async fn run(&mut self) -> i32 {
        match self.run_loop().await {
            Ok(code) => code,
            Err(error) => {
                // A terminal that cannot be written to ends the REPL: the session is closed like any other exit.
                self.session.dispose("cli-exit").await;
                eprintln!("mixdog: {error}");
                1
            }
        }
    }

    async fn run_loop(&mut self) -> io::Result<i32> {
        let banner = banner(self.config);
        self.out.write_str(&banner)?;
        loop {
            let raw = match self.read_line().await? {
                Read::Line(raw) => raw,
                Read::Eof => {
                    self.session.dispose("cli-eof").await;
                    return Ok(0);
                }
                Read::Interrupt => return Ok(self.interrupt().await),
            };
            let line = js_trim(&raw);
            if line.is_empty() {
                continue;
            }
            if line.starts_with('/') {
                let outcome = {
                    let mut ctx = SlashContext {
                        out: &mut *self.out,
                        session: self.session,
                        footer: self.footer,
                        styler: self.config.styler,
                        cwd: &self.config.cwd,
                        provider_name: self.config.provider.as_deref(),
                        model: self.config.model.as_deref(),
                        tool_mode: &self.config.tool_mode,
                    };
                    handle_slash(line, &mut ctx).await
                };
                match outcome {
                    Ok(SlashOutcome::Exit) => return Ok(0),
                    Ok(SlashOutcome::Continue) => {}
                    Err(message) => {
                        // The Node handler's rejection ended the process; a command that fails is reported and the REPL goes on.
                        let red = self.config.styler.paint(Style::Red, &format!("[error] {message}"));
                        self.out.write_str(&format!("{red}\n"))?;
                    }
                }
            } else if let TurnExit::Interrupted = self.run_turn(line).await? {
                return Ok(self.interrupt().await);
            }
        }
    }

    /// Ctrl+C: a newline under the prompt, the session closed, the exit code of a SIGINT.
    async fn interrupt(&mut self) -> i32 {
        // The terminal may be gone: the cleanup goes on without the newline.
        let _ = self.out.write_str("\n");
        self.session.dispose("SIGINT").await;
        SIGINT_EXIT
    }
}
