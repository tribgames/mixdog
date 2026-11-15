//! The REPL's output against the recording of the Node product's: `tests/goldens/repl.json`, written by
//! `tests/recorders/record-repl.mjs` from `repl/stream-sink.mjs`, `repl/turn-output.mjs`, `repl/slash-commands.mjs` and
//! `ui/markdown.mjs`, once with colour on and once off. The recorder's `--check` run says whether the recording is still
//! the tree's code; these tests say whether this crate gives the same bytes.
//!
//! * `sink`: scripted streams (deltas, tool cards, tail resets, flushes) and the final render, at several terminal widths:
//!   everything written to the output is one string, and every reset returns whether it was taken.
//! * `slash`: scripted runtimes, as data, played by a session that answers the store actions as the Node runtime answered its
//!   methods: the output, the result (`exit` or none), the error and the calls.

use std::io;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use mixdog_markdown_ansi::repl_render::render_repl_markdown_with;
use mixdog_repl::Footer;
use mixdog_repl::Out;
use mixdog_repl::Session;
use mixdog_repl::slash::SlashContext;
use mixdog_repl::slash::SlashOutcome;
use mixdog_repl::slash::handle_slash;
use mixdog_repl::stream_sink::StreamSink;
use mixdog_repl::turn_output::finalize_turn_output;
use mixdog_rt::time::Instant;
use mixdog_session_view::store::StoreEvent;
use mixdog_tui::footer::RenderArgs;
use mixdog_tui_style::color::Styler;
use serde_json::Value;
use serde_json::json;
use tokio::sync::broadcast;

const GOLDEN: &str = include_str!("goldens/repl.json");

fn golden() -> Value {
    serde_json::from_str(GOLDEN).unwrap_or_else(|error| panic!("the recording does not parse: {error}"))
}

fn cases<'a>(golden: &'a Value, mode: &str, kind: &str) -> &'a [Value] {
    golden["modes"][mode][kind].as_array().map(Vec::as_slice).unwrap_or_default()
}

fn styler_of(mode: &str) -> Styler {
    Styler::new(mode == "color", true)
}

struct Capture {
    text: String,
    columns: Option<usize>,
}

impl Out for Capture {
    fn write_str(&mut self, text: &str) -> io::Result<()> {
        self.text.push_str(text);
        Ok(())
    }

    fn columns(&self) -> Option<usize> {
        self.columns
    }
}

#[test]
fn the_streamed_block_and_its_final_render_are_what_node_printed() {
    let golden = golden();
    let mut checked = 0;
    for mode in ["color", "plain"] {
        let styler = styler_of(mode);
        for case in cases(&golden, mode, "sink") {
            let name = case["name"].as_str().unwrap_or_default();
            let mut out = Capture { text: String::new(), columns: case["columns"].as_u64().map(|columns| columns as usize) };
            // The batch never falls due: the script flushes where it means to.
            let mut sink = StreamSink::with_batch(styler.enabled(), Duration::from_secs(3600));
            let now = Instant::now();
            let mut returns = Vec::new();
            for op in case["ops"].as_array().map(Vec::as_slice).unwrap_or_default() {
                let (kind, value) = (op[0].as_str().unwrap_or_default(), &op[1]);
                match kind {
                    "delta" => sink.push_delta(value.as_str().unwrap_or_default(), now).expect("pushed"),
                    "card" => sink.write_tool_card(&mut out, value.as_str().unwrap_or_default()).expect("card"),
                    "reset" => returns.push(sink.reset_tail(&mut out, value.as_u64().unwrap_or(0) as usize).expect("reset")),
                    "flush" => sink.flush(&mut out).expect("flushed"),
                    other => panic!("the recording has an op this test does not know: {other}"),
                }
            }
            sink.flush(&mut out).expect("flushed");
            finalize_turn_output(&mut out, &sink, case["finalText"].as_str().unwrap_or_default(), styler.enabled(), &|text| render_repl_markdown_with(text, 80, styler)).expect("finalized");
            assert_eq!(out.text, case["out"].as_str().unwrap_or_default(), "{mode}: {name}");
            assert_eq!(json!(returns), case["returns"], "{mode}: {name}");
            checked += 1;
        }
    }
    assert_eq!(checked, 34);
}

/// The runtime of a recorded case, as a session: its answers are the data's, as the fake runtime of the recorder gave them.
struct Played {
    data: Value,
    state: Mutex<Value>,
    calls: Mutex<Vec<Value>>,
    feed: broadcast::Sender<StoreEvent>,
}

impl Played {
    fn new(data: &Value) -> Self {
        let mut state = serde_json::Map::new();
        for key in ["provider", "model", "sessionProvider", "sessionModel", "toolMode"] {
            if let Some(value) = data.get(key) {
                state.insert(key.to_owned(), value.clone());
            }
        }
        Self { data: data.clone(), state: Mutex::new(Value::Object(state)), calls: Mutex::new(Vec::new()), feed: broadcast::channel(1).0 }
    }

    fn log(&self, name: &str, first: &Value) {
        self.calls.lock().expect("calls").push(json!([name, first]));
    }
}

#[async_trait::async_trait]
impl Session for Played {
    fn state(&self) -> Arc<Value> {
        Arc::new(self.state.lock().expect("state").clone())
    }

    fn tick(&self) -> bool {
        false
    }

    fn subscribe(&self) -> broadcast::Receiver<StoreEvent> {
        self.feed.subscribe()
    }

    async fn submit(&self, _prompt: &str) -> Result<(), String> {
        Ok(())
    }

    async fn call(&self, action: &str, args: &[Value]) -> Result<Value, String> {
        let first = args.first().cloned().unwrap_or(Value::Null);
        self.log(action, &first);
        let data = |key: &str| self.data.get(key).cloned().unwrap_or(Value::Null);
        match action {
            "listPresets" => Ok(data("presets")),
            "getCompactionSettings" => Ok(json!({ "onModelChange": data("onModelChange") })),
            "compact" => match data("compact") {
                Value::Object(compact) if compact.contains_key("throws") => Err(compact["throws"].as_str().unwrap_or_default().to_owned()),
                other => Ok(other),
            },
            "setRoute" => {
                self.state.lock().expect("state")["model"] = first["model"].clone();
                Ok(json!({ "provider": data("provider"), "model": first["model"] }))
            }
            "getOutputStyle" => Ok(data("outputStyle")),
            "listOutputStyles" => Ok(data("listOutputStyles")),
            "setOutputStyle" => Ok(data("setOutputStyle")),
            "setToolMode" => {
                self.state.lock().expect("state")["toolMode"] = first.clone();
                Ok(json!({ "toolMode": first }))
            }
            _ => Ok(Value::Null),
        }
    }

    async fn dispose(&self, reason: &str) {
        self.log("close", &json!(reason));
    }
}

struct Line;

impl Footer for Line {
    fn line(&self, args: &RenderArgs) -> String {
        format!("footer {}/{} {}", args.provider, args.model, args.cwd)
    }
}

#[tokio::test]
async fn the_slash_commands_print_and_call_what_node_did() {
    let golden = golden();
    let mut checked = 0;
    for mode in ["color", "plain"] {
        for case in cases(&golden, mode, "slash") {
            let name = case["name"].as_str().unwrap_or_default();
            let session = Played::new(&case["runtime"]);
            let mut out = Capture { text: String::new(), columns: None };
            let result = {
                let mut ctx = SlashContext { out: &mut out, session: &session, footer: &Line, styler: styler_of(mode), cwd: "/w", provider_name: Some("cfg"), model: None, tool_mode: "full" };
                handle_slash(case["line"].as_str().unwrap_or_default(), &mut ctx).await
            };
            let (returned, error) = match result {
                Ok(SlashOutcome::Exit) => (json!("exit"), Value::Null),
                Ok(SlashOutcome::Continue) => (Value::Null, Value::Null),
                Err(message) => (Value::Null, json!(message)),
            };
            assert_eq!(out.text, case["out"].as_str().unwrap_or_default(), "{mode}: {name}");
            assert_eq!(returned, case["ret"], "{mode}: {name}");
            assert_eq!(error, case["error"], "{mode}: {name}");
            assert_eq!(Value::Array(session.calls.lock().expect("calls").clone()), case["calls"], "{mode}: {name}");
            checked += 1;
        }
    }
    assert_eq!(checked, 62);
}
