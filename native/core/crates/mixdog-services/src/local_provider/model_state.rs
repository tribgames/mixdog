//! In-memory per-model state: what the loaded server reported (capabilities, load time), the
//! last inference's timings, and the last integrity verification. Never persisted.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

use serde_json::{Map, Value, json};

use super::change::ChangeSignal;

#[derive(Default)]
pub struct ModelState {
    states: Mutex<HashMap<String, Map<String, Value>>>,
    signal: ChangeSignal,
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Tool support tri-state: false when either flag denies, true when both affirm, else unknown.
fn tool_capability(caps: &Value) -> Value {
    let flag = |k: &str| caps.get(k).and_then(Value::as_bool);
    if flag("supports_tools") == Some(false) || flag("supports_tool_calls") == Some(false) {
        json!(false)
    } else if flag("supports_tools") == Some(true) && flag("supports_tool_calls") == Some(true) {
        json!(true)
    } else {
        Value::Null
    }
}

impl ModelState {
    /// State that ticks `signal` on every change.
    pub fn with_signal(signal: ChangeSignal) -> Self {
        Self { signal, ..Self::default() }
    }

    fn with<T>(&self, id: &str, f: impl FnOnce(&mut Map<String, Value>) -> T) -> T {
        let out = f(self.states.lock().unwrap().entry(id.to_owned()).or_default());
        self.signal.notify();
        out
    }

    pub fn get(&self, id: &str) -> Value {
        self.states.lock().unwrap().get(id).map_or_else(|| json!({}), |s| Value::Object(s.clone()))
    }

    pub fn record_load(&self, id: &str, props: &Value, load_time_ms: Option<f64>) {
        let caps = props.get("chat_template_caps").cloned().unwrap_or_else(|| json!({}));
        self.with(id, |s| {
            s.insert("capabilities".into(), json!({"tools": tool_capability(&caps), "images": false, "audio": false, "video": false, "reasoningSettings": false}));
            s.insert("loadTimeMs".into(), load_time_ms.filter(|v| v.is_finite()).map_or(Value::Null, |v| json!(v.round() as i64)));
        });
    }

    pub fn record_verification(&self, id: &str, verification: Value) {
        let mut v = verification;
        v["at"] = json!(now_iso());
        self.with(id, |s| {
            s.insert("verification".into(), v);
        });
    }

    pub fn forget(&self, id: &str) {
        self.states.lock().unwrap().remove(id);
        self.signal.notify();
    }

    /// Marks an inference as running; `queued_at` is when the request entered the queue.
    pub fn begin_inference<'a>(&'a self, id: &str, queued_at: Instant) -> Inference<'a> {
        let started = Instant::now();
        let wait = started.saturating_duration_since(queued_at).as_millis() as i64;
        self.with(id, |s| {
            s.insert("inference".into(), json!({"state": "running", "queueWaitMs": wait}));
        });
        Inference { owner: self, id: id.to_owned(), queued_at, started, first: Mutex::new(None) }
    }
}

pub struct Inference<'a> {
    owner: &'a ModelState,
    id: String,
    queued_at: Instant,
    started: Instant,
    first: Mutex<Option<Instant>>,
}

impl Inference<'_> {
    /// A stream event; transport-level events do not count as the first response.
    pub fn progress(&self, kind: &str) {
        let mut first = self.first.lock().unwrap();
        if kind != "transport" && first.is_none() {
            *first = Some(Instant::now());
        }
    }

    pub fn finish(&self, input_tokens: Option<i64>, output_tokens: Option<i64>, error: Option<&str>) {
        let end = Instant::now();
        let first = *self.first.lock().unwrap();
        let generation_ms = first.map(|f| end.saturating_duration_since(f).as_secs_f64() * 1000.0);
        let tps = match (generation_ms, output_tokens) {
            (Some(g), Some(o)) if g > 0.0 && o > 1 => json!((((o - 1) as f64 / (g / 1000.0)) * 10.0).round() / 10.0),
            _ => Value::Null,
        };
        let ms = |a: Instant, b: Instant| b.saturating_duration_since(a).as_secs_f64() * 1000.0;
        self.owner.with(&self.id, |s| {
            s.insert(
                "inference".into(),
                json!({
                    "state": if error.is_some() { "failed" } else { "complete" },
                    "at": now_iso(),
                    "queueWaitMs": ms(self.queued_at, self.started).round() as i64,
                    "firstResponseMs": first.map_or(Value::Null, |f| json!(ms(self.started, f).round() as i64)),
                    "durationMs": ms(self.started, end).round() as i64,
                    "outputTokens": output_tokens, "inputTokens": input_tokens, "tokensPerSecond": tps,
                    "error": error.map(|e| mixdog_js::slice_utf16(e, 1024)),
                }),
            );
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_records_tool_support_as_a_tri_state() {
        let state = ModelState::default();
        state.record_load("m", &json!({"chat_template_caps": {"supports_tools": true, "supports_tool_calls": true}}), Some(1234.6));
        assert_eq!((state.get("m")["capabilities"]["tools"].clone(), state.get("m")["loadTimeMs"].clone()), (json!(true), json!(1235)));
        state.record_load("m", &json!({"chat_template_caps": {"supports_tools": true, "supports_tool_calls": false}}), None);
        assert_eq!((state.get("m")["capabilities"]["tools"].clone(), state.get("m")["loadTimeMs"].clone()), (json!(false), Value::Null));
        state.record_load("m", &json!({}), None);
        assert_eq!(state.get("m")["capabilities"]["tools"], Value::Null);
        state.forget("m");
        assert_eq!(state.get("m"), json!({}));
    }

    #[test]
    fn inference_reports_running_then_a_finished_summary() {
        let state = ModelState::default();
        let run = state.begin_inference("m", Instant::now());
        assert_eq!(state.get("m")["inference"]["state"], "running");
        run.progress("transport");
        run.progress("delta");
        std::thread::sleep(std::time::Duration::from_millis(5));
        run.finish(Some(10), Some(5), None);
        let done = &state.get("m")["inference"];
        assert_eq!((done["state"].clone(), done["outputTokens"].clone()), (json!("complete"), json!(5)));
        assert!(done["tokensPerSecond"].is_number() && done["firstResponseMs"].is_number());
        let failing = state.begin_inference("m", Instant::now());
        failing.finish(None, None, Some("boom"));
        let failed = &state.get("m")["inference"];
        assert_eq!((failed["state"].clone(), failed["error"].clone(), failed["tokensPerSecond"].clone()), (json!("failed"), json!("boom"), Value::Null));
        state.record_verification("m", json!({"valid": true}));
        assert!(state.get("m")["verification"]["at"].is_string());
    }
}
