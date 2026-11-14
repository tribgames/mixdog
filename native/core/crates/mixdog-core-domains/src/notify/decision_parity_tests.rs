//! Runs every case of `mixdog-testkit/parity/notification-decision.json` against the core decider. The desktop's
//! `notification-decision.parity.test.mjs` runs the same table against the TypeScript decider; the input shape is
//! documented at the top of that file.

use mixdog_testkit::parity::{assert_case, cases};
use serde_json::{Value, json};

use super::decision::{
    Conversation, ConversationKind, ConversationOverride, Decision, DecisionInput, DevicePreferences, Event,
    LocalClock, Origin, OverrideSetting, PreferencesView, SessionFields, SkipReason, TargetKind, active_overrides,
    allows_device_notice, allows_taskbar_flash, conversation_override, decide, in_quiet_hours,
};

const NOW_MS: i64 = 1_000_000;

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}

fn clock_of(input: &Value) -> LocalClock {
    let clock = &input["clock"];
    if clock.is_null() {
        return LocalClock { minute_of_day: 12 * 60, weekday: 5 };
    }
    let number = |key: &str| clock[key].as_u64().expect("clock fields are numbers") as u32;
    LocalClock { minute_of_day: number("hour") * 60 + number("minute"), weekday: number("weekday") }
}

fn preferences_of(input: &Value) -> DevicePreferences {
    let spec = input["prefs"].as_object().cloned().unwrap_or_default();
    let base = if spec.get("base").and_then(Value::as_str) == Some("newPhone") {
        DevicePreferences::new_phone()
    } else {
        DevicePreferences::default()
    };
    let mut merged = serde_json::to_value(base).expect("preferences serialize");
    for (key, value) in spec.iter().filter(|(key, _)| key.as_str() != "base") {
        match (merged[key.as_str()].as_object_mut(), value.as_object()) {
            (Some(into), Some(patch)) => into.extend(patch.iter().map(|(k, v)| (k.clone(), v.clone()))),
            _ => merged[key.as_str()] = value.clone(),
        }
    }
    serde_json::from_value(merged).expect("the case's preferences read as the decision's")
}

fn kind_of(name: &str) -> TargetKind {
    match name {
        "session" => TargetKind::Session,
        "room" => TargetKind::Room,
        "agent" => TargetKind::Agent,
        other => panic!("unknown target kind {other}"),
    }
}

fn overrides_of(input: &Value) -> Vec<ConversationOverride> {
    input["overrides"]
        .as_array()
        .map(|list| {
            list.iter()
                .map(|entry| ConversationOverride {
                    kind: kind_of(text(entry, "kind")),
                    id: text(entry, "id").to_owned(),
                    setting: if text(entry, "mode") == "always" {
                        OverrideSetting::Always
                    } else {
                        OverrideSetting::Muted { until: entry["untilOffsetMs"].as_i64().map(|offset| NOW_MS + offset) }
                    },
                })
                .collect()
        })
        .unwrap_or_default()
}

fn origin_of(name: &str) -> Origin {
    match name {
        "schedule" => Origin::Schedule,
        "webhook" => Origin::Webhook,
        _ => Origin::User,
    }
}

fn conversation_of(input: &Value) -> Conversation {
    if let Some(given) = input.get("conversation") {
        return Conversation {
            session_id: text(given, "sessionId").to_owned(),
            kind: match text(given, "kind") {
                "bot" => ConversationKind::Bot,
                "room" => ConversationKind::Room,
                "task" => ConversationKind::Task,
                _ => ConversationKind::Coding,
            },
            origin: origin_of(text(given, "origin")),
            agent_id: text(given, "agentId").to_owned(),
            room_id: text(given, "roomId").to_owned(),
        };
    }
    let session = &input["session"];
    let fields = SessionFields {
        agent_home: session["agentHome"].as_str().map(str::to_owned),
        agent_room_id: session["agentRoomId"].as_str().map(str::to_owned),
        task_agent: session["taskAgent"].as_bool().unwrap_or(false),
        agent_mode: session["agentMode"].as_bool().unwrap_or(false),
        origin: session["origin"].as_str().map(origin_of),
        run_owner: session["runOwner"].as_str().map(str::to_owned),
    };
    Conversation::of(text(session, "id"), &fields)
}

fn conversation_json(conversation: &Conversation) -> Value {
    json!({
        "sessionId": conversation.session_id,
        "kind": match conversation.kind {
            ConversationKind::Bot => "bot",
            ConversationKind::Room => "room",
            ConversationKind::Task => "task",
            ConversationKind::Coding => "coding",
        },
        "origin": match conversation.origin {
            Origin::User => "user",
            Origin::Schedule => "schedule",
            Origin::Webhook => "webhook",
        },
        "agentId": conversation.agent_id,
        "roomId": conversation.room_id,
    })
}

fn target_json(entry: &ConversationOverride) -> Value {
    json!({
        "kind": match entry.kind {
            TargetKind::Session => "session",
            TargetKind::Room => "room",
            TargetKind::Agent => "agent",
        },
        "id": entry.id,
    })
}

fn entry_json(entry: &ConversationOverride) -> Value {
    let mut out = target_json(entry);
    let (mode, offset) = match entry.setting {
        OverrideSetting::Always => ("always", Value::Null),
        OverrideSetting::Muted { until } => ("muted", until.map_or(Value::Null, |until| json!(until - NOW_MS))),
    };
    out["mode"] = json!(mode);
    out["untilOffsetMs"] = offset;
    out
}

fn event_of(name: &str) -> Event {
    match name {
        "finished" => Event::Finished,
        "question" => Event::Question,
        "approval" => Event::Approval,
        "error" => Event::Error,
        other => panic!("unknown event {other}"),
    }
}

fn reason_name(reason: SkipReason) -> &'static str {
    match reason {
        SkipReason::QuietHours => "quiet-hours",
        SkipReason::Muted => "muted",
        SkipReason::Scope => "scope",
        SkipReason::Event => "event",
        SkipReason::AutomaticRuns => "automatic-runs",
        SkipReason::Foreground => "foreground",
        SkipReason::DesktopActive => "desktop-active",
    }
}

fn run(input: &Value) -> Value {
    let clock = clock_of(input);
    let preferences = preferences_of(input);
    let overrides = overrides_of(input);
    match text(input, "fn") {
        "conversation" => conversation_json(&conversation_of(input)),
        "quietHours" => json!(in_quiet_hours(&preferences.quiet_hours, clock)),
        "override" => conversation_override(&conversation_of(input), &overrides, NOW_MS).map_or(Value::Null, target_json),
        "activeOverrides" => Value::Array(active_overrides(&overrides, NOW_MS).iter().map(entry_json).collect()),
        "taskbarFlash" => {
            json!(allows_taskbar_flash(&PreferencesView { preferences, overrides }, &conversation_of(input), NOW_MS, clock))
        }
        "deviceNotice" => json!(allows_device_notice(&preferences, clock)),
        "decide" => {
            let conversation = conversation_of(input);
            let view = PreferencesView { preferences, overrides };
            let decision = decide(&DecisionInput {
                event: event_of(text(input, "event")),
                conversation: &conversation,
                view: &view,
                now_ms: NOW_MS,
                clock,
                foreground: input["foreground"].as_bool().unwrap_or(false),
                desktop_active: input["desktopActive"].as_bool().unwrap_or(false),
            });
            match decision {
                Decision::Notify => json!({ "notify": true }),
                Decision::Skip(reason) => json!({ "notify": false, "reason": reason_name(reason) }),
            }
        }
        other => panic!("unknown parity fn {other}"),
    }
}

#[test]
fn every_notification_decision_case_matches() {
    let table = cases("notification-decision");
    assert!(table.len() >= 40, "only {} cases", table.len());
    for case in &table {
        assert_case(case, &run(&case.input));
    }
}
