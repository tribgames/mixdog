//! What an `--abort-cleanup` run restores (`host/lifecycle-abort.ts:38-55`): the pointer and focus a foreground action started from.

use serde_json::Map;
use serde_json::Value;

/// The latest restore point the helper reported (`restore_point` of a foreground result); none until one arrives.
#[derive(Default)]
pub(super) struct RestorePoints {
    latest: Option<Map<String, Value>>,
}

impl RestorePoints {
    /// Takes the restore point a helper result carries; a result without one leaves the last in place.
    pub(super) fn observe(&mut self, result: &Map<String, Value>) {
        if let Some(Value::Object(point)) = result.get("restore_point") {
            self.latest = Some(point.clone());
        }
    }
}

/// The `MIXDOG_ABORT_*` variables of an `--abort-cleanup` run; none while no restore point is known.
pub(super) fn env(points: &RestorePoints) -> Vec<(String, String)> {
    let Some(point) = &points.latest else { return Vec::new() };
    let text = |key: &str| match point.get(key) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        _ => String::new(),
    };
    [
        ("MIXDOG_ABORT_TARGET", "target_window_id"),
        ("MIXDOG_ABORT_RESTORE", "restore_window_id"),
        ("MIXDOG_ABORT_CURSOR_X", "cursor_x"),
        ("MIXDOG_ABORT_CURSOR_Y", "cursor_y"),
    ]
    .into_iter()
    .map(|(name, key)| (name.to_owned(), text(key)))
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn result(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn the_abort_run_gets_the_latest_restore_point() {
        let mut points = RestorePoints::default();
        assert!(env(&points).is_empty());
        points.observe(&result(json!({ "restore_point": {
            "target_window_id": "0x10", "restore_window_id": "0x20", "cursor_x": 5, "cursor_y": -7 } })));
        points.observe(&result(json!({ "ok": true })));
        let env = env(&points);
        let get = |name: &str| env.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str());
        assert_eq!(get("MIXDOG_ABORT_TARGET"), Some("0x10"));
        assert_eq!(get("MIXDOG_ABORT_RESTORE"), Some("0x20"));
        assert_eq!(get("MIXDOG_ABORT_CURSOR_X"), Some("5"));
        assert_eq!(get("MIXDOG_ABORT_CURSOR_Y"), Some("-7"));
    }
}
