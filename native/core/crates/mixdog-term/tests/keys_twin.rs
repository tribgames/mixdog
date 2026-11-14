//! The input decoder against what the Ink fork's pipeline delivers for the same bytes (tests/goldens/keys.json, recorded by
//! tests/recorders/record-keys.mjs): every corpus entry whole, byte by byte, split in two at the recorded points, and byte
//! by byte 25 ms apart, with a fake clock for the pending-escape wait.
//!
//! One deliberate difference: the fork delivers a focus report (`ESC [ I`, `ESC [ O`) as a key whose input is `[I` or
//! `[O`; the decoder delivers [`InputEvent::Focus`] for it. The check holds such an event to the recorded sequence.

use std::time::{Duration, Instant};

use mixdog_term::input::{Decoder, InputEvent, KeyEventType, KeyFlags, MouseKind};
use serde_json::Value;

const GOLDEN: &str = include_str!("goldens/keys.json");

fn from_hex(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&hex[at..at + 2], 16).expect("hex byte"))
        .collect()
}

fn flag_names(key: &KeyFlags) -> Vec<&'static str> {
    [
        (key.up_arrow, "upArrow"),
        (key.down_arrow, "downArrow"),
        (key.left_arrow, "leftArrow"),
        (key.right_arrow, "rightArrow"),
        (key.page_down, "pageDown"),
        (key.page_up, "pageUp"),
        (key.home, "home"),
        (key.end, "end"),
        (key.return_key, "return"),
        (key.escape, "escape"),
        (key.ctrl, "ctrl"),
        (key.shift, "shift"),
        (key.tab, "tab"),
        (key.backspace, "backspace"),
        (key.delete, "delete"),
        (key.meta, "meta"),
        (key.super_key, "super"),
        (key.hyper, "hyper"),
        (key.caps_lock, "capsLock"),
        (key.num_lock, "numLock"),
    ]
    .into_iter()
    .filter_map(|(set, name)| set.then_some(name))
    .collect()
}

fn event_type_name(event_type: Option<KeyEventType>) -> Option<&'static str> {
    event_type.map(|kind| match kind {
        KeyEventType::Press => "press",
        KeyEventType::Repeat => "repeat",
        KeyEventType::Release => "release",
    })
}

/// Whether one decoded event is what the recording says.
fn same(event: &InputEvent, golden: &Value) -> bool {
    let tag = golden["t"].as_str().unwrap_or("");
    match event {
        InputEvent::Focus(on) => {
            tag == "key" && golden["sequence"].as_str() == Some(if *on { "\x1b[I" } else { "\x1b[O" })
        }
        InputEvent::Key { input, key } => {
            let want_flags: Vec<&str> = golden["key"]
                .as_array()
                .map(|names| names.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            tag == "key"
                && golden["input"].as_str() == Some(input.as_str())
                && flag_names(key) == want_flags
                && golden.get("eventType").and_then(Value::as_str) == event_type_name(key.event_type)
        }
        InputEvent::Paste(text) => tag == "paste" && golden["text"].as_str() == Some(text.as_str()),
        InputEvent::Mouse(report) => match report.kind {
            MouseKind::WheelUp | MouseKind::WheelDown => {
                let name = if report.kind == MouseKind::WheelUp { "wheelup" } else { "wheeldown" };
                tag == "wheel" && golden["name"].as_str() == Some(name) && golden["ctrl"].as_bool() == Some(report.ctrl)
            }
            kind => {
                let action = if kind == MouseKind::Release { "release" } else { "press" };
                tag == "mouse"
                    && golden["action"].as_str() == Some(action)
                    && golden["button"].as_i64() == Some(i64::from(report.button))
                    && golden["col"].as_i64() == Some(i64::from(report.col) + 1)
                    && golden["row"].as_i64() == Some(i64::from(report.row) + 1)
            }
        },
    }
}

/// Feed the chunks one `gap` of fake time apart, then let the pending-escape wait run out.
fn run(chunks: &[&[u8]], gap: Duration) -> Vec<InputEvent> {
    let base = Instant::now();
    let mut decoder = Decoder::new();
    let mut events = Vec::new();
    for (at, chunk) in chunks.iter().enumerate() {
        events.extend(decoder.feed(chunk, base + gap * u32::try_from(at).expect("chunk count")));
    }
    events.extend(decoder.flush_due(base + gap * u32::try_from(chunks.len()).expect("chunk count") + Duration::from_secs(1)));
    events
}

fn check(label: &str, name: &str, events: &[InputEvent], want: &[Value], failures: &mut Vec<String>) {
    let ok = events.len() == want.len() && events.iter().zip(want).all(|(event, golden)| same(event, golden));
    if !ok && failures.len() < 12 {
        failures.push(format!(
            "{name} [{label}]: {} events, recorded {}; first got {:?}, recorded {}",
            events.len(),
            want.len(),
            events.first(),
            want.first().map_or_else(|| "none".to_string(), Value::to_string),
        ));
    } else if !ok {
        failures.push(String::new());
    }
}

#[test]
fn decoder_matches_the_recorded_ink_pipeline() {
    let golden: Value = serde_json::from_str(GOLDEN).expect("keys.json parses");
    let slow_gap = Duration::from_millis(golden["slowGapMs"].as_u64().expect("slowGapMs"));
    let entries = golden["entries"].as_array().expect("entries");
    assert!(entries.len() > 3000, "the corpus is {} entries", entries.len());

    let mut failures: Vec<String> = Vec::new();
    for entry in entries {
        let name = entry["name"].as_str().expect("name");
        let bytes = from_hex(entry["hex"].as_str().expect("hex"));
        let whole: Vec<Value> = entry["whole"].as_array().expect("whole").clone();
        let others = entry["others"].as_object().expect("others");
        let want = |label: &str| -> Vec<Value> {
            others.get(label).and_then(Value::as_array).cloned().unwrap_or_else(|| whole.clone())
        };

        check("whole", name, &run(&[&bytes], Duration::ZERO), &whole, &mut failures);

        let singles: Vec<&[u8]> = bytes.chunks(1).collect();
        check("bytewise", name, &run(&singles, Duration::ZERO), &want("bytewise"), &mut failures);
        check("slow", name, &run(&singles, slow_gap), &want("slow"), &mut failures);

        for at in entry["splitPoints"].as_array().expect("splitPoints") {
            let at = usize::try_from(at.as_u64().expect("split point")).expect("split point fits");
            let label = format!("split:{at}");
            check(&label, name, &run(&[&bytes[..at], &bytes[at..]], Duration::ZERO), &want(&label), &mut failures);
        }
    }
    let count = failures.len();
    failures.retain(|line| !line.is_empty());
    assert!(count == 0, "{count} variants differ from the recording:\n{}", failures.join("\n"));
}
