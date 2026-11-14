//! `shared/labels.mjs`: captions the runtime adds on its own, in the script of the copy they sit with.

use mixdog_js::value_to_string;
use serde_json::Value;

/// The captions of one script.
#[derive(Debug, PartialEq, Eq)]
pub struct PresetLabels {
    pub eyebrow: &'static str,
    pub decision: &'static str,
    pub recommendation: &'static str,
    pub checkpoint: &'static str,
    pub source: &'static str,
    pub gate: [&'static str; 3],
}

pub const LATIN: PresetLabels = PresetLabels {
    eyebrow: "EXECUTIVE DECISION DASHBOARD",
    decision: "DECISION WINDOW",
    recommendation: "RECOMMENDATION",
    checkpoint: "NEXT CHECKPOINT",
    source: "Source",
    gate: ["Track", "Release", "Stop"],
};

pub const HANGUL: PresetLabels = PresetLabels {
    eyebrow: "의사결정 대시보드",
    decision: "결정 사항",
    recommendation: "권고",
    checkpoint: "다음 점검",
    source: "출처",
    gate: ["항목", "진행", "보류"],
};

/// `Array.prototype.flat(Infinity)` then `join(' ')`: a null element is empty.
fn flatten(items: &[Value], out: &mut Vec<String>) {
    for item in items {
        match item {
            Value::Array(inner) => flatten(inner, out),
            Value::Null => out.push(String::new()),
            other => out.push(value_to_string(other)),
        }
    }
}

/// `presetLabels(sample)`: the Hangul captions when the sample (a text, or an array of texts joined by spaces) holds a
/// Hangul syllable, the Latin ones otherwise.
pub fn preset_labels(sample: &Value) -> &'static PresetLabels {
    match sample {
        Value::Array(items) => {
            let mut parts = Vec::new();
            flatten(items, &mut parts);
            preset_labels_for_text(&parts.join(" "))
        }
        Value::Null => &LATIN,
        other => preset_labels_for_text(&value_to_string(other)),
    }
}

/// [`preset_labels`] of a text.
pub fn preset_labels_for_text(text: &str) -> &'static PresetLabels {
    if text.chars().any(|c| ('\u{ac00}'..='\u{d7a3}').contains(&c)) { &HANGUL } else { &LATIN }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn script_follows_the_sample() {
        assert_eq!(preset_labels(&json!("Quarterly")), &LATIN);
        assert_eq!(preset_labels(&json!("분기 보고")), &HANGUL);
        assert_eq!(preset_labels(&json!(["a", ["b", ["한"]]])), &HANGUL);
        assert_eq!(preset_labels(&json!([null, 1, { "x": "한" }])), &LATIN);
        assert_eq!(preset_labels(&Value::Null), &LATIN);
    }
}
