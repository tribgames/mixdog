//! Replays tests/goldens/display.json (recorded from the Node display modules by tests/recorders/record-display.mjs)
//! through the Rust port: every function gives what Node gave over the recorded inputs. A call Node recorded as an
//! exception fails the test instead of being skipped: the golden holds none. A number JSON cannot carry travels as `{ "num": "NaN" | "Infinity" | "-Infinity" }`.

use mixdog_js::json_number;
use mixdog_js::string_to_number;
use mixdog_js::to_number;
use mixdog_js::value_to_string;
use mixdog_tui_style::color::Styler;
use mixdog_view_model::display::clean;
use mixdog_view_model::display::context_inspection;
use mixdog_view_model::display::context_inspection::CategoryTokens;
use mixdog_view_model::display::context_inspection::ContextMapOptions;
use mixdog_view_model::display::context_measurement;
use mixdog_view_model::display::model_alias;
use mixdog_view_model::display::model_display;
use mixdog_view_model::display::provider_display_name;
use mixdog_view_model::display::quiet_progress;
use mixdog_view_model::display::quiet_progress::QuietProgressParts;
use mixdog_view_model::display::session_stats::SessionStats;
use mixdog_view_model::display::skill_mentions;
use mixdog_view_model::display::statusline_format;
use mixdog_view_model::display::statusline_format::StatusStyle;
use mixdog_view_model::display::time_format;
use mixdog_view_model::display::time_format::DurationOptions;
use mixdog_view_model::display::tool_card;
use mixdog_view_model::display::usage_dashboard;
use serde_json::Value;
use serde_json::json;

const STYLE: StatusStyle = StatusStyle::new(Styler::new(true, true));

fn golden() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("tests/goldens/display.json")).expect("the golden is JSON")
}

/// A recorded argument as a number: `{ num }` is the special number, anything else `Number(value)`.
fn f(value: &Value) -> f64 {
    match value {
        Value::Object(map) if map.len() == 1 && map.contains_key("num") => string_to_number(map["num"].as_str().unwrap_or("NaN")),
        other => to_number(other),
    }
}

/// A recorded argument for a function that coerces it itself: the special numbers become the strings that coerce to them.
fn lax(value: &Value) -> Value {
    match value {
        Value::Object(map) if map.len() == 1 && map.contains_key("num") => map["num"].clone(),
        other => other.clone(),
    }
}

/// `String(value || '')`.
fn text(value: &Value) -> String {
    match value {
        Value::Null | Value::Bool(false) => String::new(),
        Value::String(text) => text.clone(),
        other if other.as_f64() == Some(0.0) => String::new(),
        other => value_to_string(other),
    }
}

fn s(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

/// A number as the recorder wrote it: finite as JSON, the rest as `{ num }`.
fn out_num(n: f64) -> Value {
    if n.is_finite() {
        json_number(n)
    } else if n.is_nan() {
        json!({ "num": "NaN" })
    } else {
        json!({ "num": if n > 0.0 { "Infinity" } else { "-Infinity" } })
    }
}

fn opt(value: Option<Value>) -> Value {
    value.unwrap_or(Value::Null)
}

fn optional(value: &Value) -> Option<&Value> {
    (!value.is_null()).then_some(value)
}

fn parts_value(parts: Option<QuietProgressParts>) -> Value {
    match parts {
        Some(parts) => json!({
            "quietMs": out_num(parts.quiet_ms),
            "minutes": out_num(parts.minutes),
            "wait": parts.wait,
            "tool": parts.tool,
            "escalated": parts.escalated,
        }),
        None => Value::Null,
    }
}

fn parts_of(value: &Value) -> Option<QuietProgressParts> {
    let map = value.as_object()?;
    Some(QuietProgressParts {
        quiet_ms: map.get("quietMs").map_or(0.0, f),
        minutes: map.get("minutes").map_or(0.0, f),
        wait: map.get("wait").map(text).unwrap_or_default(),
        tool: map.get("tool").and_then(Value::as_str).unwrap_or_default().to_owned(),
        escalated: map.get("escalated") == Some(&Value::Bool(true)),
    })
}

fn timestamp_parts(parts: Option<time_format::LocalTimestampParts>) -> Value {
    match parts {
        Some(parts) => json!({ "date": parts.date, "time": parts.time, "timeZone": parts.time_zone, "offset": parts.offset, "utc": parts.utc }),
        None => Value::Null,
    }
}

fn zone(options: &Value) -> Option<&str> {
    options.get("timeZone").and_then(Value::as_str)
}

fn mention_values(mentions: Vec<skill_mentions::SkillMention>) -> Value {
    Value::Array(mentions.into_iter().map(|m| json!({ "name": m.name, "start": m.start, "end": m.end })).collect())
}

fn names_of(value: &Value) -> Vec<String> {
    value.as_array().expect("names").iter().map(|name| s(name).to_owned()).collect()
}

fn numbers(values: &[f64]) -> Value {
    Value::Array(values.iter().map(|n| json_number(*n)).collect())
}

fn replay(name: &str, args: &[Value]) -> Option<Value> {
    let a = |index: usize| args.get(index).unwrap_or(&Value::Null);
    Some(match name {
        "formatDuration" => {
            let options = DurationOptions {
                most_significant_only: a(1).get("mostSignificantOnly") == Some(&Value::Bool(true)),
                hide_trailing_zeros: a(1).get("hideTrailingZeros") == Some(&Value::Bool(true)),
            };
            json!(time_format::format_duration(f(a(0)), options))
        }
        "formatElapsed" => json!(time_format::format_elapsed(f(a(0)))),
        "formatUtcTimestamp" => json!(time_format::format_utc_timestamp(f(a(0)))),
        "localTimestampParts" => timestamp_parts(time_format::local_timestamp_parts(f(a(0)), zone(a(1)))),
        "formatLocalAndUtcTimestamp" => json!(time_format::format_local_and_utc_timestamp(f(a(0)), zone(a(1)))),
        "formatRecallTimestamp" => json!(time_format::format_recall_timestamp(f(a(0)), zone(a(1)))),
        "displayModelName" => json!(model_display::display_model_name(s(a(0)), s(a(2)))),
        "shortenModelName" => json!(model_display::shorten_model_name(s(a(0)), f(a(1)))),
        "canonicalModelDisplay" => json!(model_display::canonical_model_display(s(a(0)))),
        "gatewayBrandDisplay" => json!(model_display::gateway_brand_display(s(a(0)))),
        "titleModelPart" => json!(model_display::title_model_part(s(a(0)))),
        "effortDisplayLabel" => json!(model_display::effort_display_label(&text(a(0)))),
        "isRollingModelAlias" => json!(model_alias::is_rolling_model_alias(s(a(0)))),
        "providerDisplayName" => json!(provider_display_name::provider_display_name(&text(a(0)))),
        "clean" => json!(clean::clean(Some(a(0)))),
        "cleanString" => json!(clean::clean_string(Some(a(0)))),
        "oneLine" => json!(clean::one_line(Some(a(0)))),
        "sessionContextMeasurement" => context_measurement::session_context_measurement(a(0), a(1) == &Value::Bool(true)).to_value(),
        "contextMeasurementStats" => context_measurement::context_measurement_stats(Some(a(0))),
        "contextPercent" => {
            let tokens = (!a(0).is_null()).then(|| f(a(0)));
            opt(context_measurement::context_percent(tokens, f(a(1))).map(out_num))
        }
        "measuredContextUsage" => context_measurement::measured_context_usage(a(0)),
        "contextMeasurementLabel" => json!(context_measurement::context_measurement_label(&text(a(0)))),
        "contextCategories" => Value::Array(
            context_inspection::CONTEXT_CATEGORIES.iter().map(|category| json!({ "key": category.key, "label": category.label })).collect(),
        ),
        "contextShares" => {
            let weights: Vec<f64> = a(0).as_array().expect("weights").iter().map(f).collect();
            numbers(&context_inspection::context_shares(&weights, f(a(1))))
        }
        "buildContextMap" => {
            let categories: Vec<CategoryTokens> = a(0)
                .as_array()
                .expect("categories")
                .iter()
                .map(|category| CategoryTokens { key: s(&category["key"]).to_owned(), tokens: f(&category["tokens"]) })
                .collect();
            let defaults = ContextMapOptions::default();
            let options = ContextMapOptions {
                window_tokens: a(1).get("windowTokens").map_or(defaults.window_tokens, f),
                cells: a(1).get("cells").map_or(defaults.cells, f),
                fit: a(1).get("fit") == Some(&Value::Bool(true)),
            };
            context_inspection::build_context_map(&categories, options).to_value()
        }
        "lastProgressAt" => out_num(quiet_progress::last_progress_at(Some(a(0)))),
        "awaitingModelResponse" => json!(quiet_progress::awaiting_model_response(Some(a(0)))),
        "displayProgressStage" => opt(quiet_progress::display_progress_stage(Some(a(0))).map(Value::String)),
        "quietWaitKind" => json!(quiet_progress::quiet_wait_kind(&text(a(0)))),
        "quietProgress" => {
            let call = a(0);
            let tool = call["tool"].as_str();
            opt(quiet_progress::quiet_progress(f(&call["progressAt"]), s(&call["stage"]), tool, f(&call["now"])))
        }
        "quietProgressParts" => parts_value(quiet_progress::quiet_progress_parts(Some(a(0)), f(a(1)), f(a(2)))),
        "quietProgressLabel" => json!(quiet_progress::quiet_progress_label(parts_of(a(0)).as_ref())),
        "skillMentionCandidates" => mention_values(skill_mentions::skill_mention_candidates(s(a(0)))),
        "mentionedSkillNames" => {
            let known = names_of(a(1));
            json!(skill_mentions::mentioned_skill_names(s(a(0)), |name| known.iter().any(|k| k == name)))
        }
        "skillMentions" => {
            let known = names_of(a(1));
            mention_values(skill_mentions::skill_mentions(s(a(0)), |name| known.iter().any(|k| k == name)))
        }
        "isInMarkdownCode" => {
            let offset = a(1).as_f64().filter(|n| n.fract() == 0.0).map(|n| n as i64);
            json!(offset.is_some_and(|offset| skill_mentions::is_in_markdown_code(s(a(0)), offset)))
        }
        "isReservedMentionName" => json!(skill_mentions::is_reserved_mention_name(&text(a(0)))),
        "contextPctDisplayLabel" => json!(statusline_format::context_pct_display_label(optional(a(0)).map(f))),
        "colourPct" => json!(statusline_format::colour_pct(STYLE, f(a(0)))),
        "formatContextSegment" => {
            let source = if args.len() > 2 { s(a(2)) } else { "pending" };
            json!(statusline_format::format_context_segment(STYLE, optional(a(0)).map(f), f(a(1)), source))
        }
        "fmt" => json!(statusline_format::fmt_value(Some(&lax(a(0))))),
        "num" => out_num(statusline_format::num(Some(&lax(a(0))))),
        "timeMs" => out_num(statusline_format::time_ms(Some(&lax(a(0))))),
        "statusPalette" => json!({
            "R": STYLE.reset(),
            "B": STYLE.bold(),
            "D": STYLE.dim(),
            "GRN": STYLE.green(),
            "YLW": STYLE.yellow(),
            "RED": STYLE.red(),
            "text": STYLE.status_text("x"),
            "subtle": STYLE.status_subtle("x"),
        }),
        "sessionStats" => {
            let mut stats = SessionStats::new();
            for delta in a(0).as_array().expect("deltas") {
                stats.apply_usage_delta(Some(delta));
            }
            stats.to_value()
        }
        "createSessionStats" => SessionStats::new().to_value(),
        "renderToolCard" => json!(tool_card::render_tool_card(a(0), Styler::new(true, true))),
        "money" => json!(usage_dashboard::money(Some(&lax(a(0))))),
        "compactNumber" => json!(usage_dashboard::compact_number(Some(&lax(a(0))))),
        _ => return None,
    })
}

#[test]
fn every_display_function_gives_what_node_gave() {
    let golden = golden();
    let cases = golden["cases"].as_array().expect("cases");
    let mut replayed = 0;
    for case in cases {
        let name = s(&case["fn"]);
        let args = case["args"].as_array().expect("args");
        let expected = case.get("out").unwrap_or_else(|| panic!("{name} has no recorded output (Node threw, which the twin does not list): {case}"));
        let actual = replay(name, args).unwrap_or_else(|| panic!("the golden records {name}, which the twin does not replay"));
        assert_eq!(expected, &actual, "{name} of {}", args.iter().map(Value::to_string).collect::<Vec<_>>().join(", ").chars().take(240).collect::<String>());
        replayed += 1;
    }
    assert!(replayed > 3000, "only {replayed} cases were replayed");
}

#[test]
fn the_golden_covers_every_ported_function() {
    let golden = golden();
    let recorded: std::collections::BTreeSet<&str> = golden["cases"].as_array().expect("cases").iter().map(|case| s(&case["fn"])).collect();
    for name in [
        "formatDuration",
        "formatLocalAndUtcTimestamp",
        "displayModelName",
        "shortenModelName",
        "effortDisplayLabel",
        "sessionContextMeasurement",
        "measuredContextUsage",
        "buildContextMap",
        "quietProgress",
        "skillMentionCandidates",
        "isInMarkdownCode",
        "formatContextSegment",
        "sessionStats",
        "renderToolCard",
        "money",
        "compactNumber",
    ] {
        assert!(recorded.contains(name), "{name} is not in the golden");
    }
}
