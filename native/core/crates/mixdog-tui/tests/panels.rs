//! The Rust panel controllers against what the Node code does (tests/goldens/panels.json, recorded by
//! tests/recorders/record-panels.mjs): the `/context` model over 316 status answers, the `/context` open, the `/usage`
//! dashboard under a usage claim, and the `/btw` controller under scripted steps; plus the cases of `doctor.test.mjs`,
//! `doctor-session-log.test.mjs` and `usage-context-panels.test.mjs` that concern the terminal UI.
//!
//! The recorder is run on a Node checkout (`node tests/recorders/record-panels.mjs --tree <checkout> --check
//! tests/goldens/panels.json`); this test only reads the recording. The health checks of `doctor.mjs` and the session-log row
//! are the core's now: their cases are in `mixdog-core-domains` (`diagnostics/tests.rs`, a twin of the Node answers).

use std::collections::HashMap;

use mixdog_tui::panels::btw::{BtwAsk, BtwController, BtwHost};
use mixdog_tui::panels::context::{begin_context_open, finish_context_open, inspect_preview, open_context_panel, read_context_status};
use mixdog_tui::panels::context_model::{ContextModelInput, build_context_panel_model};
use mixdog_tui::panels::context_refresh::{ContextPanelRefresh, ContextRefreshFields};
use mixdog_tui::panels::doctor::run_doctor;
use mixdog_tui::panels::usage::open_usage_panel;
use mixdog_tui::panels::{ContextPanel, ContextWindows, PanelsHost};
use mixdog_tui::slash::host::Tone;
use mixdog_tui::surface::epoch::PanelValue;
use mixdog_tui::surface::latch::IndexModePanel;
use mixdog_tui::surface::owner::{PanelSurface, SurfaceEvent};
use mixdog_tui_widgets::panels::context_inspector::InspectOutcome;
use mixdog_tui_widgets::picker::IndexMode;
use serde_json::{Value, json};

// ---------------------------------------------------------------- the host

/// A picker panel the surface can hold.
#[derive(Clone, Debug, PartialEq)]
struct Picker {
    mode: Option<IndexMode>,
}

impl PanelValue for Picker {
    fn kind(&self) -> &str {
        ""
    }
    fn title(&self) -> &str {
        ""
    }
}

impl IndexModePanel for Picker {
    fn index_mode(&self) -> Option<IndexMode> {
        self.mode
    }
    fn with_index_mode(self, mode: IndexMode) -> Self {
        Self { mode: Some(mode) }
    }
}

/// A recording host: the store answers each case scripts, and every effect lands in [`Fake::log`] in the shape
/// `record-panels.mjs` logs it.
#[derive(Default)]
struct Fake {
    surface: PanelSurface<Picker, ContextPanel, Value>,
    store: HashMap<String, Result<Value, String>>,
    windows: ContextWindows,
    log: Vec<Value>,
    calls: Vec<Value>,
    notices: Vec<Value>,
    closes: usize,
}

impl Fake {
    fn new() -> Self {
        Self::default()
    }

    fn script(&mut self, name: &str, reply: Result<Value, String>) {
        self.store.insert(name.to_owned(), reply);
    }

    /// Moves what the surface wrote since the last call into the log.
    fn drain(&mut self) {
        for event in self.surface.take_events() {
            self.log.push(match event {
                SurfaceEvent::Picker(panel) => json!(["picker", panel.map(|_| "panel")]),
                SurfaceEvent::Context(panel) => json!([
                    "context",
                    panel.map(|panel| json!({
                        "kind": "context",
                        "title": panel.title,
                        "detail": panel.detail,
                        "rows": panel.rows,
                    }))
                ]),
                SurfaceEvent::Usage(dashboard) => json!(["usage", dashboard]),
            });
        }
    }
}

impl PanelsHost for Fake {
    type Picker = Picker;

    fn surface(&mut self) -> &mut PanelSurface<Picker, ContextPanel, Value> {
        &mut self.surface
    }

    fn store_has(&self, name: &str) -> bool {
        self.store.contains_key(name)
    }

    fn read_store(&mut self, name: &str, args: Value) -> Option<Result<Value, String>> {
        let reply = self.store.get(name)?.clone();
        self.calls.push(json!([name, args.get(0).cloned().unwrap_or(Value::Null)]));
        Some(reply)
    }

    fn clear_text_prompts(&mut self) {
        self.log.push(json!(["prompt", "provider", null]));
        self.log.push(json!(["prompt", "settings", null]));
    }

    fn close_usage_panel(&mut self) {
        self.closes += 1;
        self.surface.close_usage();
    }

    fn notify(&mut self, text: &str, tone: Tone) {
        self.notices.push(json!([text, tone.as_str()]));
    }

    fn context_windows(&self) -> ContextWindows {
        self.windows.clone()
    }
}

fn member(value: &Value, key: &str) -> Value {
    value.get(key).cloned().unwrap_or(Value::Null)
}

// ---------------------------------------------------------------- the context model

fn model_of(input: &Value) -> (Vec<Value>, Value) {
    let (tools, mcp, skills) = (member(input, "toolsStatus"), member(input, "mcpStatus"), member(input, "skillsStatus"));
    let (plugins, context) = (member(input, "pluginsStatus"), member(input, "contextStatus"));
    let usage = member(input, "sessionUsage");
    let state = input.get("state").cloned().unwrap_or(Value::Null);
    let (window, raw) = (member(&state, "contextWindow"), member(&state, "rawContextWindow"));
    let model = build_context_panel_model(&ContextModelInput {
        tools_status: &tools,
        mcp_status: &mcp,
        skills_status: &skills,
        plugins_status: &plugins,
        context_status: &context,
        session_usage: &usage,
        state_context_window: &window,
        state_raw_context_window: &raw,
    });
    (model.rows, model.detail)
}

#[test]
fn the_context_rows_follow_the_runtime_status_getters() {
    // `openContextPicker renders the context rows from the runtime status getters` of usage-context-panels.test.mjs.
    let status = json!({
        "measurement": { "tokens": 50_000, "source": "last_api_request", "updatedAt": 1234 },
        "effectiveContextWindow": 180_000,
        "rawContextWindow": 200_000,
        "usage": {
            "lastContextTokens": 50_000, "lastInputTokens": 6_000, "lastCachedReadTokens": 40_000,
            "lastCacheWriteTokens": 2_000, "lastPromptTokens": 48_000, "lastUncachedInputTokens": 8_000, "lastOutputTokens": 900
        },
        "messages": {
            "estimatedTokens": 30_000, "count": 14, "toolCallCount": 3, "toolCallTokens": 1_200,
            "toolResultCount": 3, "toolResultTokens": 9_500, "semantic": { "kinds": 2 }
        },
        "request": {
            "toolSchemaBreakdown": { "code": { "tokens": 4_000 }, "web": { "tokens": 1_000 }, "mcp": { "tokens": 2_500 } },
            "requestOverheadTokens": 800, "reserveTokens": 16_000
        },
        "compaction": {
            "lastStage": "compacted", "lastChanged": true, "lastTrigger": "reactive", "lastDurationMs": 4200,
            "boundaryTokens": 150_000, "triggerTokens": 140_000, "pressureTokens": 60_000, "reserveTokens": 20_000
        },
        "inspection": { "entries": [] },
    });
    let mut fake = Fake::new();
    fake.windows = ContextWindows { context_window: json!(200_000), raw_context_window: json!(250_000) };
    fake.script("toolsStatus", Ok(json!({ "activeCount": 12, "count": 20, "mcpToolCount": 5, "activeMcpToolCount": 3, "activeTools": [] })));
    fake.script("mcpStatus", Ok(json!({ "connectedCount": 1, "configuredCount": 2, "failedCount": 1 })));
    fake.script("skillsStatus", Ok(json!({ "count": 7 })));
    fake.script("pluginsStatus", Ok(json!({ "count": 2 })));
    fake.script("contextStatus", Ok(status.clone()));
    assert!(open_context_panel(&mut fake));
    fake.drain();

    assert_eq!(fake.calls.iter().filter(|call| call[0] == "contextStatus").map(|call| call[1].clone()).collect::<Vec<_>>(), vec![json!({ "inspect": true })]);
    assert_eq!(fake.log[0], json!(["prompt", "provider", null]));
    assert_eq!(fake.log[1], json!(["prompt", "settings", null]));
    assert_eq!(fake.log[2], json!(["picker", null]));
    let panel = fake.surface.context().expect("the context panel is open").clone();
    assert_eq!(panel.title, "Context Usage");
    let rows: Vec<Vec<String>> =
        panel.rows.iter().map(|row| ["value", "label", "description", "_action"].iter().map(|key| row[key].as_str().unwrap().to_owned()).collect()).collect();
    let want = [
        ["summary", "Context Usage", "50k/180k (27.8%) \u{b7} 130k free \u{b7} Last measured input \u{b7} effective"],
        ["compaction", "Compaction", "Compact complete (overflow recovery) \u{b7} 5s \u{b7} 60k pressure \u{b7} 20k reserve"],
        ["messages", "Messages", "30k tokens (16.7%) \u{b7} 14 messages"],
        ["tools", "Tools", "5.0k schema tokens (2.8%) \u{b7} 12/20 active"],
        ["tool-io", "Tool calls/results", "3 calls (1.2k) \u{b7} 3 results (9.5k)"],
        ["request", "Request overhead", "800 framing \u{b7} 16k reserve incl. tools"],
        ["last-api", "Last API usage", "50k context \u{b7} 6.0k uncached input \u{b7} 900 output \u{b7} last API request"],
        ["reasoning", "Reasoning tokens", "\u{2248}0 tokens (0%) \u{b7} current context estimate"],
        ["cache", "Prompt cache", "83% hit \u{b7} 40k read \u{b7} 2.0k write \u{b7} 6.0k new (last request)"],
        ["free", "Free space", "130k tokens (72.2%) \u{b7} raw window 200k"],
        ["extensions", "Skills/plugins", "7 skills \u{b7} 2 plugins"],
    ];
    for (row, want) in rows.iter().zip(want) {
        assert_eq!(row[0], want[0]);
        assert_eq!(row[1], want[1]);
        assert_eq!(row[2], want[2], "row {}", want[0]);
        assert_eq!(row[3], want[0]);
    }
    assert_eq!(rows.len(), want.len());
    assert_eq!(
        panel.detail["usage"],
        json!({
            "usedTokens": 50_000, "windowTokens": 180_000, "freeTokens": 130_000, "rawWindowTokens": 200_000,
            "source": "Last measured input", "measurementSource": "last_api_request", "measuredAt": 1234, "effective": true
        })
    );
    assert_eq!(
        panel.detail["compaction"],
        json!({
            "stage": "compacted", "state": "Compact complete (overflow recovery)", "triggerTokens": 140_000,
            "boundaryTokens": 150_000, "bufferTokens": 10_000, "pressureTokens": 60_000, "reserveTokens": 20_000,
            "lastChanged": true
        })
    );
    assert_eq!(panel.detail["mcp"], json!({ "connected": 1, "configured": 2, "failed": 1, "tools": 5, "activeTools": 3, "schemaTokens": 2_500 }));
    assert_eq!(panel.detail["lastApi"], json!({ "contextTokens": 50_000, "inputTokens": 6_000, "rawInputTokens": 6_000, "outputTokens": 900 }));
    assert_eq!(panel.detail["inspection"], status["inspection"]);
    assert_eq!(panel.detail["speed"], json!({ "outputTokensPerSecond": null }));
}

#[test]
fn the_inspector_asks_for_the_preview_of_an_entry_with_the_entry_and_its_revision() {
    let mut fake = Fake::new();
    fake.script("contextStatus", Ok(json!({ "inspection": { "preview": { "text": "hello", "truncated": false } } })));
    let outcome = inspect_preview(&mut fake, &json!("entry-1"), &json!(4));
    assert_eq!(outcome, InspectOutcome::Answer(Some(json!({ "text": "hello", "truncated": false }))));
    assert_eq!(fake.calls.last().unwrap()[1], json!({ "inspect": true, "entryId": "entry-1", "revision": 4 }));
    fake.script("contextStatus", Ok(json!({ "inspection": {} })));
    assert_eq!(inspect_preview(&mut fake, &json!("e"), &json!(1)), InspectOutcome::Answer(None));
    fake.script("contextStatus", Err("daemon offline".to_owned()));
    assert_eq!(inspect_preview(&mut fake, &json!("e"), &json!(1)), InspectOutcome::Failed);
    fake.store.remove("contextStatus");
    assert_eq!(inspect_preview(&mut fake, &json!("e"), &json!(1)), InspectOutcome::Failed);
}

#[test]
fn a_running_compaction_shows_no_duration_and_a_finished_one_shows_its_last_duration() {
    let description = |compaction: Value| {
        let input = json!({ "contextStatus": { "contextWindow": 100_000, "compaction": compaction }, "state": {} });
        let (rows, _) = model_of(&input);
        let text = rows.iter().find(|row| row["value"] == "compaction").unwrap()["description"].as_str().unwrap().to_owned();
        let parts: Vec<&str> = text.split(" \u{b7} ").collect();
        parts[..parts.len() - 2].join(" \u{b7} ")
    };
    // The previous compaction's 4.2s must not read as the running one's time.
    assert_eq!(description(json!({ "lastStage": "compacting", "lastDurationMs": 4200 })), "Compacting conversation");
    assert_eq!(description(json!({ "inProgress": true, "lastDurationMs": 4200 })), "Compacting conversation");
    assert_eq!(description(json!({ "lastStage": "pre_send", "lastChanged": true, "lastDurationMs": 4200 })), "Compact complete \u{b7} 5s");
    assert_eq!(description(json!({ "lastStage": "pre_send_check", "lastDurationMs": 4200 })), "Compact checked \u{b7} 5s");
}

#[test]
fn the_last_request_cache_rate_requires_a_measured_prompt_split() {
    for (usage, expected) in [
        (
            json!({
                "lastContextTokens": 24_000, "lastInputTokens": null, "lastOutputTokens": 0,
                "lastUncachedInputTokens": null, "lastCachedReadTokens": null, "lastCacheWriteTokens": null
            }),
            "N/A hit \u{b7} \u{2014} read \u{b7} \u{2014} new (last request)",
        ),
        (
            json!({
                "lastContextTokens": null, "lastOutputTokens": 200,
                "lastPromptTokens": 60, "lastUncachedInputTokens": 60, "lastCachedReadTokens": 0, "lastCacheWriteTokens": 0
            }),
            "0% hit \u{b7} 0 read \u{b7} 0 write \u{b7} 60 new (last request)",
        ),
        (
            json!({ "lastInputTokens": 60, "lastOutputTokens": 200, "lastCachedReadTokens": 40, "lastCacheWriteTokens": 0 }),
            "N/A hit \u{b7} 40 read \u{b7} 0 write \u{b7} \u{2014} new (last request)",
        ),
    ] {
        let (rows, detail) = model_of(&json!({ "contextStatus": { "usage": usage } }));
        let cache = rows.iter().find(|row| row["value"] == "cache").unwrap();
        assert_eq!(cache["description"], expected);
        assert_eq!(detail["lastApi"]["outputTokens"], usage["lastOutputTokens"]);
    }
}

#[test]
fn failing_getters_fall_back_to_the_visible_window_and_placeholders() {
    let mut fake = Fake::new();
    fake.windows = ContextWindows { context_window: json!(100_000), raw_context_window: Value::Null };
    for name in ["toolsStatus", "mcpStatus", "skillsStatus", "pluginsStatus", "contextStatus"] {
        fake.script(name, Err("daemon offline".to_owned()));
    }
    assert!(open_context_panel(&mut fake));
    let panel = fake.surface.context().unwrap().clone();
    let row = |value: &str| panel.rows.iter().find(|row| row["value"] == value).unwrap()["description"].as_str().unwrap().to_owned();
    assert_eq!(row("summary"), "\u{2014}/100k (\u{2014}) \u{b7} \u{2014} free \u{b7} Awaiting measurement \u{b7} effective");
    assert_eq!(row("compaction"), "Compact checked \u{b7} 0 pressure \u{b7} 0 reserve");
    assert_eq!(row("tools"), "0 schema tokens (0%) \u{b7} 0/0 active");
    assert_eq!(row("cache"), "N/A hit \u{b7} \u{2014} read \u{b7} \u{2014} new (last request)");
    assert_eq!(row("free"), "\u{2014} tokens (\u{2014}) \u{b7} raw window 100k");
    assert_eq!(
        panel.detail["compaction"],
        json!({
            "stage": "pending", "state": "Compact checked", "triggerTokens": 100_000, "boundaryTokens": 100_000,
            "bufferTokens": 0, "pressureTokens": null, "reserveTokens": null, "lastChanged": false
        })
    );
}

#[test]
fn the_context_open_paints_nothing_when_the_claim_was_lost_during_the_reads() {
    let mut fake = Fake::new();
    fake.script("toolsStatus", Ok(json!({ "activeCount": 1 })));
    let mut open = begin_context_open(&mut fake);
    let reads = read_context_status(&mut fake);
    // An Esc during the reads supersedes the surface.
    fake.surface.supersede();
    assert!(!finish_context_open(&mut fake, &mut open, &reads));
    fake.drain();
    assert!(fake.log.is_empty());
    assert!(fake.surface.context().is_none());
}

#[test]
fn an_open_context_panel_is_rebuilt_when_a_summarised_field_changes() {
    let fields = ContextRefreshFields { session_id: json!("s1"), provider: json!("openai"), ..ContextRefreshFields::default() };
    let mut refresh = ContextPanelRefresh::new();
    // Mounted with another panel open: nothing to rebuild; the same render again changes nothing.
    assert!(!refresh.observe(false, &fields));
    assert!(!refresh.observe(false, &fields));
    // The context panel opens: it is rebuilt once, then left alone while the fields hold.
    assert!(refresh.observe(true, &fields));
    assert!(!refresh.observe(true, &fields));
    // Each summarised field is a trigger.
    let changes: Vec<ContextRefreshFields> = vec![
        ContextRefreshFields { stats: json!({ "n": 1 }), ..fields.clone() },
        ContextRefreshFields { context_window: json!(1), ..fields.clone() },
        ContextRefreshFields { raw_context_window: json!(1), ..fields.clone() },
        ContextRefreshFields { session_id: json!("s2"), ..fields.clone() },
        ContextRefreshFields { tool_mode: json!("full"), ..fields.clone() },
        ContextRefreshFields { agent_workers: json!([1]), ..fields.clone() },
        ContextRefreshFields { agent_jobs: json!([1]), ..fields.clone() },
        ContextRefreshFields { provider: json!("anthropic"), ..fields.clone() },
        ContextRefreshFields { model: json!("m"), ..fields.clone() },
        ContextRefreshFields { effort: json!("high"), ..fields.clone() },
        ContextRefreshFields { fast: json!(true), ..fields.clone() },
        ContextRefreshFields { cwd: json!("/tmp"), ..fields.clone() },
        ContextRefreshFields { client_host_pid: json!(42), ..fields.clone() },
    ];
    for changed in &changes {
        assert!(refresh.observe(true, changed), "{changed:?}");
        assert!(!refresh.observe(true, changed));
        assert!(refresh.observe(true, &fields), "back to the base");
    }
    // A change while another panel is open does not open the context panel; closing it is no rebuild either.
    assert!(!refresh.observe(false, &changes[0]));
    assert!(!refresh.observe(false, &changes[1]));
}

// ---------------------------------------------------------------- the usage dashboard

#[test]
fn the_usage_dashboard_streams_through_the_claim_and_a_newer_open_ends_the_old_one() {
    // `openUsagePanel streams dashboard updates through the usage claim`.
    let mut fake = Fake::new();
    fake.script("getUsageDashboard", Ok(Value::Null));
    let first = open_usage_panel(&mut fake, "--refresh");
    assert!(first.refresh);
    assert_eq!(first.args(), json!({ "refresh": true }));
    assert!(first.due(&mut fake));
    first.update(&mut fake, json!({ "title": "partial", "rows": [1] }));
    first.update(&mut fake, Value::Null);
    first.settle(&mut fake, Ok(json!({ "title": "final", "rows": [1, 2] })));
    assert_eq!(fake.surface.usage(), Some(&json!({ "title": "final", "rows": [1, 2] })));
    assert_eq!(fake.closes, 0);
    // A newer /usage invalidates the first: its late answer paints nothing and notifies nothing.
    let second = open_usage_panel(&mut fake, "");
    assert!(!second.refresh);
    assert!(!first.due(&mut fake));
    first.update(&mut fake, json!({ "title": "late" }));
    first.settle(&mut fake, Err("late failure".to_owned()));
    assert!(fake.notices.is_empty());
    assert_eq!(fake.closes, 0);
    assert_eq!(fake.surface.usage().unwrap()["checking"], json!(true));
    // Esc closes the panel and invalidates the second one too.
    fake.close_usage_panel();
    second.settle(&mut fake, Ok(json!({ "title": "after Esc" })));
    assert_eq!(fake.surface.usage(), None);
}

#[test]
fn an_unavailable_or_failed_dashboard_closes_the_panel_and_says_so() {
    let mut fake = Fake::new();
    fake.script("getUsageDashboard", Ok(Value::Null));
    let request = open_usage_panel(&mut fake, "");
    request.settle(&mut fake, Ok(Value::Null));
    assert_eq!(fake.closes, 1);
    assert_eq!(fake.notices, vec![json!(["usage dashboard unavailable", "warn"])]);
    assert_eq!(fake.surface.usage(), None);

    let mut failing = Fake::new();
    failing.script("getUsageDashboard", Ok(Value::Null));
    let request = open_usage_panel(&mut failing, "");
    request.settle(&mut failing, Err("quota api down".to_owned()));
    assert_eq!(failing.closes, 1);
    assert_eq!(failing.notices, vec![json!(["usage failed: quota api down", "error"])]);
}

// ---------------------------------------------------------------- /doctor

#[test]
fn doctor_asks_the_core_for_the_checks_and_the_report_notice() {
    let mut fake = Fake::new();
    fake.script("runDoctor", Ok(json!({ "busy": true })));
    assert_eq!(run_doctor(&mut fake), Ok(()), "a run that found another one in progress is not an error");
    assert_eq!(fake.calls, vec![json!(["runDoctor", { "notice": true }])]);
    fake.script("runDoctor", Ok(json!({ "checkedAt": 1, "summary": { "ok": 16, "warn": 0, "fail": 0 }, "checks": [] })));
    assert_eq!(run_doctor(&mut fake), Ok(()));
    fake.script("runDoctor", Err("daemon offline".to_owned()));
    assert_eq!(run_doctor(&mut fake), Err("daemon offline".to_owned()));
    // A store without the action does nothing (the optional call of the Node code).
    fake.store.remove("runDoctor");
    assert_eq!(run_doctor(&mut fake), Ok(()));
}

// ---------------------------------------------------------------- /btw

#[derive(Default)]
struct BtwFake {
    session: String,
    calls: Vec<Value>,
}

impl BtwHost for BtwFake {
    fn session_id(&self) -> String {
        self.session.clone()
    }
    fn cancel_side(&mut self, session_id: &str) {
        self.calls.push(json!(["cancelSide", session_id]));
    }
}

/// The run loop of the panel for a script: the asks of a step are dispatched when the script flushes, and an answer settles
/// the latest dispatched request of its question.
struct BtwRun {
    controller: BtwController,
    host: BtwFake,
    queued: Vec<BtwAsk>,
    in_flight: Vec<(BtwAsk, bool)>,
}

impl BtwRun {
    fn new() -> Self {
        Self { controller: BtwController::new(), host: BtwFake { session: "s1".to_owned(), calls: Vec::new() }, queued: Vec::new(), in_flight: Vec::new() }
    }

    /// The microtasks after the asks: each queued ask is dispatched or dropped.
    fn flush(&mut self) {
        for ask in std::mem::take(&mut self.queued) {
            if self.controller.dispatch(&self.host, &ask) {
                self.host.calls.push(json!(["askSide", ask.question]));
                self.in_flight.push((ask, false));
            } else {
                self.controller.settle(&self.host, &ask, Ok(Value::Null));
            }
        }
    }

    fn answer(&mut self, question: &str, result: Result<Value, String>) {
        self.flush();
        let Some((ask, settled)) = self.in_flight.iter_mut().rev().find(|(ask, _)| ask.question == question) else { return };
        if std::mem::replace(settled, true) {
            return;
        }
        let ask = ask.clone();
        self.controller.settle(&self.host, &ask, result);
    }

    fn step(&mut self, step: &[Value]) {
        let text = |at: usize| step.get(at).and_then(Value::as_str).unwrap_or_default().to_owned();
        match step[0].as_str().unwrap() {
            "ask" => {
                let ask = self.controller.ask(&mut self.host, &text(1));
                self.queued.push(ask);
            }
            "flush" => self.flush(),
            "resolve" => {
                let answer = if step[2].is_null() { json!({ "text": null }) } else { json!({ "text": step[2] }) };
                self.answer(&text(1), Ok(answer));
            }
            "reject" => {
                let message = if step[2].is_null() { "plain failure".to_owned() } else { text(2) };
                self.answer(&text(1), Err(message));
            }
            "close" => self.controller.close(&mut self.host),
            "session" => self.host.session = text(1),
            "sync" => self.controller.sync(&mut self.host),
            "dispose" => self.controller.dispose(&mut self.host),
            other => panic!("unknown step {other}"),
        }
    }
}

#[test]
fn a_btw_answer_lives_only_in_the_panel_and_a_replaced_ask_is_ignored() {
    let mut run = BtwRun::new();
    run.step(&[json!("ask"), json!("why?")]);
    assert_eq!(run.controller.panel(), Some(&json!({ "question": "why?", "status": "pending", "text": "" })));
    run.step(&[json!("flush")]);
    // A second question replaces the panel and cancels the one in flight for its own session.
    run.step(&[json!("ask"), json!("again")]);
    assert_eq!(run.host.calls, vec![json!(["askSide", "why?"]), json!(["cancelSide", "s1"])]);
    run.step(&[json!("resolve"), json!("why?"), json!("stale")]);
    assert_eq!(run.controller.panel().unwrap()["question"], "again");
    assert_eq!(run.controller.panel().unwrap()["status"], "pending");
    run.step(&[json!("resolve"), json!("again"), json!("fresh")]);
    assert_eq!(run.controller.panel(), Some(&json!({ "question": "again", "status": "done", "text": "fresh" })));
    run.step(&[json!("close")]);
    assert_eq!(run.controller.panel(), None);
}
