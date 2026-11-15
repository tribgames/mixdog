//! `repl/slash-commands.mjs`: the REPL's `/command` table. Every command writes to the output; only `/exit` and `/quit` end
//! the REPL.
//!
//! A command that Node ran on the in-process runtime is one session action on the store (`clear`, `compact`, `setRoute`,
//! `setOutputStyle`, `setToolMode`, and the reads `listPresets`, `getCompactionSettings`, `getOutputStyle`,
//! `listOutputStyles`). An error an action raises is the command's error, as the rejection of the Node handler was.

use mixdog_js::is_js_space;
use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_js::value_to_string;
use mixdog_tui_style::color::Style;
use mixdog_tui_style::color::Styler;
use serde_json::Value;
use serde_json::json;

use crate::Session;
use crate::stream_sink::Out;
use crate::turn_output::Footer;
use crate::turn_output::statusline_for;

/// `/help` lists exactly the commands `handle_slash` implements below; the slash list of the full-screen UI is not available in
/// the plain REPL.
const REPL_HELP_LINES: [&str; 8] = [
    "Slash commands (plain REPL):",
    "  /help                   show this list",
    "  /clear                  start a fresh chat",
    "  /compact                compact older conversation context",
    "  /model [name]           show or switch the model for subsequent turns",
    "  /outputstyle [name]     show or switch the output style (aliases: /output-style, /style)",
    "  /mode [full|readonly]   show or switch the tool mode",
    "  /quit                   quit the REPL (alias: /exit)",
];

/// What a command is run with.
pub struct SlashContext<'a> {
    pub out: &'a mut dyn Out,
    pub session: &'a dyn Session,
    pub footer: &'a dyn Footer,
    pub styler: Styler,
    pub cwd: &'a str,
    pub provider_name: Option<&'a str>,
    pub model: Option<&'a str>,
    pub tool_mode: &'a str,
}

/// What the REPL does after a command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlashOutcome {
    Continue,
    Exit,
}

impl SlashContext<'_> {
    fn write(&mut self, text: &str) -> Result<(), String> {
        self.out.write_str(text).map_err(|error| error.to_string())
    }

    fn line(&mut self, style: Style, text: &str) -> Result<(), String> {
        let line = format!("{}\n", self.styler.paint(style, text));
        self.write(&line)
    }

    fn columns(&self) -> Option<usize> {
        self.out.columns()
    }
}

/// JavaScript truthiness of a value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0 && !number.is_nan()),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// `a || b || ...` over text fields: the first that is truthy, as text.
fn first_text(values: &[&Value]) -> Option<String> {
    values.iter().find(|value| truthy(value)).map(|value| value_to_string(value))
}

/// `String(value)` of a field that may be missing (`undefined` prints as that word).
fn js_field(value: &Value, key: &str) -> String {
    value.get(key).map_or_else(|| "undefined".to_owned(), value_to_string)
}

async fn clear_conversation(ctx: &mut SlashContext<'_>) -> Result<(), String> {
    ctx.session.call("clear", &[]).await?;
    ctx.session.tick();
    // Clear screen and scrollback and home the cursor.
    ctx.write(if ctx.styler.enabled() { "\x1b[2J\x1b[3J\x1b[H" } else { "\n" })?;
    ctx.line(Style::Dim, "conversation reset.")?;
    let footer = statusline_for(ctx.footer, &ctx.session.state(), ctx.cwd, ctx.columns());
    ctx.write(&format!("{footer}\n"))
}

async fn compact_conversation(ctx: &mut SlashContext<'_>) -> Result<(), String> {
    let result = ctx.session.call("compact", &[]).await?;
    if !truthy(&result) {
        return ctx.line(Style::Yellow, "compact failed");
    }
    if truthy(&result["error"]) {
        return ctx.line(Style::Red, "compact failed");
    }
    if result["changed"] == json!(false) {
        let reason = first_text(&[&result["reason"]]).unwrap_or_else(|| "nothing to compact".to_owned());
        return ctx.line(Style::Yellow, &reason);
    }
    let message = format!(
        "\u{2713} compacted context: {}\u{2192}{} messages, context {}\u{2192}{}",
        js_field(&result, "beforeMessages"),
        js_field(&result, "afterMessages"),
        js_field(&result, "beforeTokens"),
        js_field(&result, "afterTokens"),
    );
    ctx.line(Style::Green, &message)
}

/// `selectedModel(runtime, request, ...)`: the provider and model a selection names; a bare preset id or name names the
/// preset's model.
async fn selected_model(ctx: &SlashContext<'_>, model: &str, session_provider: &str, session_model: &str) -> (String, String) {
    let model = js_trim(model);
    if !model.is_empty() {
        let wanted = js_to_lowercase(model);
        let presets = ctx.session.call("listPresets", &[]).await.unwrap_or(Value::Null);
        let named = |preset: &Value, key: &str| preset.get(key).is_some_and(|value| js_to_lowercase(js_trim(&value_to_string(value))) == wanted);
        let found = presets.as_array().and_then(|presets| presets.iter().find(|preset| named(preset, "id") || named(preset, "name")));
        if let Some(preset) = found
            && truthy(&preset["provider"])
            && truthy(&preset["model"])
        {
            return (value_to_string(&preset["provider"]), value_to_string(&preset["model"]));
        }
    }
    (session_provider.to_owned(), if model.is_empty() { session_model.to_owned() } else { model.to_owned() })
}

/// `switchesSessionModel(runtime, request)`: a selection of another model than the established conversation's own.
async fn switches_session_model(ctx: &SlashContext<'_>, model: &str) -> bool {
    let state = ctx.session.state();
    let session_provider = state["sessionProvider"].as_str().unwrap_or_default();
    let session_model = state["sessionModel"].as_str().unwrap_or_default();
    if session_provider.is_empty() || session_model.is_empty() {
        return false;
    }
    let (provider, selected) = selected_model(ctx, model, session_provider, session_model).await;
    provider != session_provider || selected != session_model
}

async fn set_model(ctx: &mut SlashContext<'_>, arg: &str) -> Result<(), String> {
    if arg.is_empty() {
        let state = ctx.session.state();
        let provider = first_text(&[&state["provider"]]).or_else(|| ctx.provider_name.map(str::to_owned)).unwrap_or_else(|| "auto".to_owned());
        let current = first_text(&[&state["model"]]).or_else(|| ctx.model.map(str::to_owned)).unwrap_or_else(|| "default".to_owned());
        ctx.line(Style::Yellow, &format!("current model: {provider}/{current}"))?;
        return ctx.line(Style::Dim, "usage: /model <preset-or-model>");
    }
    let request = json!({ "model": arg });
    // The user's model choice switches this conversation in place; with auto-compact on model change (default on) the
    // history is compacted on the current model first. A failed compaction never blocks the switch.
    if switches_session_model(ctx, arg).await {
        let settings = ctx.session.call("getCompactionSettings", &[]).await.unwrap_or(Value::Null);
        if settings["onModelChange"] != json!(false) {
            ctx.line(Style::Dim, "compacting conversation before the model change\u{2026}")?;
            // The next turn's auto-compaction fits the new window.
            let _ = ctx.session.call("compact", &[]).await;
        }
    }
    let route = ctx.session.call("setRoute", &[request]).await?;
    ctx.session.tick();
    let state = ctx.session.state();
    let shown = |key: &str| first_text(&[&route[key], &state[key]]).unwrap_or_default();
    let target = format!("{}/{}", shown("provider"), shown("model"));
    ctx.line(Style::Green, &format!("\u{2713} model \u{2192} {target}"))
}

async fn set_output_style(ctx: &mut SlashContext<'_>, arg: &str) -> Result<(), String> {
    let lower = js_to_lowercase(arg);
    if arg.is_empty() || matches!(lower.as_str(), "status" | "current" | "show") {
        let mut status = ctx.session.call("getOutputStyle", &[]).await.unwrap_or(Value::Null);
        if !truthy(&status) {
            status = ctx.session.call("listOutputStyles", &[]).await.unwrap_or(Value::Null);
        }
        let label = first_text(&[&status["current"]["label"], &status["current"]["id"], &status["configured"]]).unwrap_or_else(|| "Default".to_owned());
        let available = status["styles"]
            .as_array()
            .map(|styles| styles.iter().filter_map(|style| first_text(&[&style["label"], &style["id"]])).collect::<Vec<_>>().join(", "))
            .unwrap_or_default();
        ctx.line(Style::Yellow, &format!("current output style: {label}"))?;
        if !available.is_empty() {
            ctx.line(Style::Dim, &format!("available: {available}"))?;
        }
        return Ok(());
    }
    let result = ctx.session.call("setOutputStyle", &[json!(arg)]).await?;
    let label = first_text(&[&result["current"]["label"], &result["current"]["id"]]).unwrap_or_else(|| arg.to_owned());
    let suffix = if result["appliedToCurrentSession"] == json!(false) { " (use /clear to apply to this chat)" } else { "" };
    ctx.line(Style::Green, &format!("\u{2713} output style \u{2192} {label}{suffix}"))
}

async fn set_mode(ctx: &mut SlashContext<'_>, arg: &str) -> Result<(), String> {
    if arg.is_empty() {
        let state = ctx.session.state();
        let mode = first_text(&[&state["toolMode"]]).unwrap_or_else(|| ctx.tool_mode.to_owned());
        ctx.line(Style::Yellow, &format!("current mode: {mode}"))?;
        return ctx.line(Style::Dim, "usage: /mode full|readonly");
    }
    let result = ctx.session.call("setToolMode", &[json!(arg)]).await?;
    ctx.session.tick();
    let state = ctx.session.state();
    let mode = first_text(&[&result["toolMode"], &state["toolMode"]]).unwrap_or_else(|| arg.to_owned());
    ctx.line(Style::Green, &format!("\u{2713} mode \u{2192} {mode}"))
}

/// `line.slice(1).split(/\s+/)`: the pieces between runs of white space; a run at either end leaves an empty piece.
fn split_words(text: &str) -> Vec<&str> {
    let mut pieces = Vec::new();
    let mut start = 0;
    let mut in_run = false;
    let mut run_start = 0;
    for (at, c) in text.char_indices() {
        let space = is_js_space(c);
        if space && !in_run {
            in_run = true;
            run_start = at;
        } else if !space && in_run {
            in_run = false;
            pieces.push(&text[start..run_start]);
            start = at;
        }
    }
    if in_run {
        pieces.push(&text[start..run_start]);
        pieces.push("");
    } else {
        pieces.push(&text[start..]);
    }
    pieces
}

/// `handleSlash(line, ctx)`: runs a `/command` line. An error is the command's own failure; the REPL reports it and goes on.
pub async fn handle_slash(line: &str, ctx: &mut SlashContext<'_>) -> Result<SlashOutcome, String> {
    let body = line.strip_prefix('/').unwrap_or(line);
    let pieces = split_words(body);
    let command = js_to_lowercase(pieces.first().copied().unwrap_or_default());
    let arg = js_trim(&pieces.iter().skip(1).copied().collect::<Vec<_>>().join(" ")).to_owned();

    match command.as_str() {
        "help" => ctx.write(&format!("{}\n", REPL_HELP_LINES.join("\n")))?,
        "clear" => clear_conversation(ctx).await?,
        "compact" => compact_conversation(ctx).await?,
        "model" => set_model(ctx, &arg).await?,
        "outputstyle" | "output-style" | "style" => set_output_style(ctx, &arg).await?,
        "mode" => set_mode(ctx, &arg).await?,
        "exit" | "quit" => {
            ctx.session.dispose("cli-exit").await;
            ctx.line(Style::Dim, "bye.")?;
            return Ok(SlashOutcome::Exit);
        }
        _ => {
            let message = format!("{}{}\n", ctx.styler.paint(Style::Red, &format!("unknown command: /{command}")), ctx.styler.paint(Style::Dim, "  (try /help)"));
            ctx.write(&message)?;
        }
    }
    Ok(SlashOutcome::Continue)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::sync::Mutex;

    use mixdog_session_view::store::StoreEvent;
    use mixdog_tui::footer::RenderArgs;
    use tokio::sync::broadcast;

    use super::*;
    use crate::stream_sink::Capture;

    /// A session that answers each action with a canned value and keeps the calls it was given.
    pub(crate) struct Scripted {
        pub state: Mutex<Value>,
        pub answers: HashMap<&'static str, Result<Value, String>>,
        pub calls: Mutex<Vec<(String, Vec<Value>)>>,
        pub disposed: Mutex<Vec<String>>,
    }

    impl Scripted {
        pub(crate) fn new(state: Value, answers: Vec<(&'static str, Result<Value, String>)>) -> Self {
            Self { state: Mutex::new(state), answers: answers.into_iter().collect(), calls: Mutex::new(Vec::new()), disposed: Mutex::new(Vec::new()) }
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().expect("calls").iter().map(|(action, _)| action.clone()).collect()
        }
    }

    #[async_trait::async_trait]
    impl Session for Scripted {
        fn state(&self) -> Arc<Value> {
            Arc::new(self.state.lock().expect("state").clone())
        }

        fn tick(&self) -> bool {
            false
        }

        fn subscribe(&self) -> broadcast::Receiver<StoreEvent> {
            broadcast::channel(1).1
        }

        async fn submit(&self, _prompt: &str) -> Result<(), String> {
            Ok(())
        }

        async fn call(&self, action: &str, args: &[Value]) -> Result<Value, String> {
            self.calls.lock().expect("calls").push((action.to_owned(), args.to_vec()));
            self.answers.get(action).cloned().unwrap_or(Ok(Value::Null))
        }

        async fn dispose(&self, reason: &str) {
            self.disposed.lock().expect("disposed").push(reason.to_owned());
        }
    }

    struct FixedFooter;

    impl Footer for FixedFooter {
        fn line(&self, args: &RenderArgs) -> String {
            format!("footer {}/{}", args.provider, args.model)
        }
    }

    async fn run(session: &Scripted, line: &str, styler: Styler) -> (Result<SlashOutcome, String>, String) {
        let mut out = Capture::default();
        let result = {
            let mut ctx = SlashContext { out: &mut out, session, footer: &FixedFooter, styler, cwd: "/w", provider_name: Some("cfg"), model: None, tool_mode: "full" };
            handle_slash(line, &mut ctx).await
        };
        (result, out.text)
    }

    const OFF: Styler = Styler::new(false, true);

    #[tokio::test]
    async fn help_lists_exactly_the_commands_the_plain_repl_implements() {
        let session = Scripted::new(json!({}), vec![]);
        let (result, text) = run(&session, "/help", OFF).await;
        assert_eq!(result, Ok(SlashOutcome::Continue));
        let mut listed: Vec<&str> = text.split(|c: char| !(c.is_ascii_alphabetic() || c == '-' || c == '/')).filter(|word| word.len() > 1 && word.starts_with('/')).collect();
        listed.sort_unstable();
        listed.dedup();
        let mut expected = vec!["/clear", "/compact", "/exit", "/help", "/mode", "/model", "/output-style", "/outputstyle", "/quit", "/style"];
        expected.sort_unstable();
        assert_eq!(listed, expected);
    }

    #[tokio::test]
    async fn compact_reports_the_reason_its_default_both_failures_and_a_success() {
        for (answer, expected) in [
            (json!({ "changed": false, "reason": "context is already small" }), "context is already small\n"),
            (json!({ "changed": false }), "nothing to compact\n"),
            (json!({ "error": "boom" }), "compact failed\n"),
            (Value::Null, "compact failed\n"),
            (json!({ "changed": true, "beforeMessages": 5, "afterMessages": 2, "beforeTokens": 100, "afterTokens": 40 }), "\u{2713} compacted context: 5\u{2192}2 messages, context 100\u{2192}40\n"),
        ] {
            let session = Scripted::new(json!({}), vec![("compact", Ok(answer))]);
            let (result, text) = run(&session, "/compact", OFF).await;
            assert_eq!((result, text.as_str()), (Ok(SlashOutcome::Continue), expected));
        }
    }

    fn model_session(session_model: Option<&str>, on_model_change: bool, compact: Result<Value, String>) -> Scripted {
        let state = json!({ "provider": "google", "model": session_model, "sessionProvider": session_model.map(|_| "google"), "sessionModel": session_model });
        Scripted::new(
            state,
            vec![
                ("listPresets", Ok(json!([{ "id": "flash", "provider": "google", "model": "gemini-3.8-flash" }]))),
                ("getCompactionSettings", Ok(json!({ "onModelChange": on_model_change }))),
                ("compact", compact),
                ("setRoute", Ok(json!({ "provider": "google", "model": "gemini-3.5-flash" }))),
            ],
        )
    }

    #[tokio::test]
    async fn model_switches_the_conversation_in_place_compacting_first_on_the_current_model() {
        let session = model_session(Some("gemini-3.8-flash"), true, Ok(json!({ "changed": true })));
        let (result, text) = run(&session, "/model gemini-3.5-flash", OFF).await;
        assert_eq!(result, Ok(SlashOutcome::Continue));
        assert_eq!(text, "compacting conversation before the model change\u{2026}\n\u{2713} model \u{2192} google/gemini-3.5-flash\n");
        let calls = session.calls.lock().expect("calls").clone();
        assert_eq!(calls.iter().map(|(action, _)| action.as_str()).filter(|action| matches!(*action, "compact" | "setRoute")).collect::<Vec<_>>(), ["compact", "setRoute"]);
        assert_eq!(calls.last().expect("a call").1, vec![json!({ "model": "gemini-3.5-flash" })]);
    }

    #[tokio::test]
    async fn model_skips_the_pre_compaction_when_off_for_the_same_model_or_preset_and_for_an_empty_chat() {
        for (session, arg) in [
            (model_session(Some("gemini-3.8-flash"), false, Ok(Value::Null)), "gemini-3.5-flash"),
            (model_session(Some("gemini-3.8-flash"), true, Ok(Value::Null)), "gemini-3.8-flash"),
            (model_session(Some("gemini-3.8-flash"), true, Ok(Value::Null)), "flash"),
            (model_session(None, true, Ok(Value::Null)), "gemini-3.5-flash"),
        ] {
            let (result, _) = run(&session, &format!("/model {arg}"), OFF).await;
            assert_eq!(result, Ok(SlashOutcome::Continue));
            assert!(!session.calls().contains(&"compact".to_owned()), "{arg}");
            assert_eq!(session.calls.lock().expect("calls").last().expect("a call").0, "setRoute", "{arg}");
        }
    }

    #[tokio::test]
    async fn model_still_switches_when_the_pre_compaction_fails() {
        let session = model_session(Some("gemini-3.8-flash"), true, Err("boom".to_owned()));
        let (result, _) = run(&session, "/model gemini-3.5-flash", OFF).await;
        assert_eq!(result, Ok(SlashOutcome::Continue));
        assert_eq!(session.calls().iter().filter(|action| matches!(action.as_str(), "compact" | "setRoute")).count(), 2);
    }

    #[tokio::test]
    async fn model_without_an_argument_shows_the_current_route_and_a_failed_switch_is_the_commands_error() {
        let session = model_session(Some("gemini-3.8-flash"), true, Ok(Value::Null));
        let (_, text) = run(&session, "/model", OFF).await;
        assert_eq!(text, "current model: google/gemini-3.8-flash\nusage: /model <preset-or-model>\n");
        let refused = Scripted::new(json!({}), vec![("setRoute", Err("Invalid model selector \"bogus\"".to_owned()))]);
        let (result, _) = run(&refused, "/model bogus", OFF).await;
        assert_eq!(result, Err("Invalid model selector \"bogus\"".to_owned()));
    }

    #[tokio::test]
    async fn output_style_and_mode_show_and_switch() {
        let styles = json!({ "current": { "label": "Concise" }, "styles": [{ "label": "Concise" }, { "id": "verbose" }] });
        let session = Scripted::new(json!({ "toolMode": "readonly" }), vec![("getOutputStyle", Ok(styles)), ("setOutputStyle", Ok(json!({ "current": { "id": "verbose" }, "appliedToCurrentSession": false }))), ("setToolMode", Ok(Value::Null))]);
        assert_eq!(run(&session, "/style", OFF).await.1, "current output style: Concise\navailable: Concise, verbose\n");
        assert_eq!(run(&session, "/output-style verbose", OFF).await.1, "\u{2713} output style \u{2192} verbose (use /clear to apply to this chat)\n");
        assert_eq!(run(&session, "/mode", OFF).await.1, "current mode: readonly\nusage: /mode full|readonly\n");
        assert_eq!(run(&session, "/mode full", OFF).await.1, "\u{2713} mode \u{2192} readonly\n");
    }

    #[tokio::test]
    async fn clear_resets_the_chat_and_prints_the_footer_quit_ends_the_repl_and_an_unknown_command_says_so() {
        let session = Scripted::new(json!({ "provider": "p", "model": "m" }), vec![]);
        assert_eq!(run(&session, "/clear", OFF).await.1, "\nconversation reset.\nfooter p/m\n");
        assert_eq!(run(&session, "/clear", Styler::new(true, true)).await.1.split("\x1b[H").next(), Some("\x1b[2J\x1b[3J"));
        let (result, text) = run(&session, "/QUIT", OFF).await;
        assert_eq!((result, text.as_str()), (Ok(SlashOutcome::Exit), "bye.\n"));
        assert_eq!(session.disposed.lock().expect("disposed").as_slice(), ["cli-exit"]);
        assert_eq!(run(&session, "/nope arg", OFF).await.1, "unknown command: /nope  (try /help)\n");
        assert_eq!(run(&session, "/ help", OFF).await.1, "unknown command: /  (try /help)\n");
    }

    #[test]
    fn a_line_is_split_between_runs_of_white_space_as_the_pattern_does() {
        assert_eq!(split_words("a  b\tc"), ["a", "b", "c"]);
        assert_eq!(split_words(" a"), ["", "a"]);
        assert_eq!(split_words("a "), ["a", ""]);
        assert_eq!(split_words(""), [""]);
    }
}
