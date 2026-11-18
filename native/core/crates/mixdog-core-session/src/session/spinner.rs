//! The running turn's spinner as Node's TUI store sets it when a turn begins (`turn.mjs` `runTurn`: `busy: true` and a spinner
//! whose verb is `pickVerb(turn.index)`, `labels.mjs:7-9`, over the shared pool, `spinner-verbs.mjs`; `turn.index` is the
//! session's completed turns, `beginTurn`'s `getState().stats.turns`).

use serde_json::Value;
use serde_json::json;

/// `spinner-verbs.mjs` `SPINNER_VERBS`, in order.
const SPINNER_VERBS: [&str; 187] = [
    "Accomplishing", "Actioning", "Actualizing", "Architecting", "Baking", "Beaming", "Beboppin'", "Befuddling", "Billowing", "Blanching",
    "Bloviating", "Boogieing", "Boondoggling", "Booping", "Bootstrapping", "Brewing", "Bunning", "Burrowing", "Calculating", "Canoodling",
    "Caramelizing", "Cascading", "Catapulting", "Cerebrating", "Channeling", "Channelling", "Choreographing", "Churning", "Clauding",
    "Coalescing", "Cogitating", "Combobulating", "Composing", "Computing", "Concocting", "Considering", "Contemplating", "Cooking",
    "Crafting", "Creating", "Crunching", "Crystallizing", "Cultivating", "Deciphering", "Deliberating", "Determining", "Dilly-dallying",
    "Discombobulating", "Doing", "Doodling", "Drizzling", "Ebbing", "Effecting", "Elucidating", "Embellishing", "Enchanting", "Envisioning",
    "Evaporating", "Fermenting", "Fiddle-faddling", "Finagling", "Flambéing", "Flibbertigibbeting", "Flowing", "Flummoxing", "Fluttering",
    "Forging", "Forming", "Frolicking", "Frosting", "Gallivanting", "Galloping", "Garnishing", "Generating", "Gesticulating", "Germinating",
    "Gitifying", "Grooving", "Gusting", "Harmonizing", "Hashing", "Hatching", "Herding", "Honking", "Hullaballooing", "Hyperspacing",
    "Ideating", "Imagining", "Improvising", "Incubating", "Inferring", "Infusing", "Ionizing", "Jitterbugging", "Julienning", "Kneading",
    "Leavening", "Levitating", "Lollygagging", "Manifesting", "Marinating", "Meandering", "Metamorphosing", "Misting", "Moonwalking",
    "Moseying", "Mulling", "Mustering", "Musing", "Nebulizing", "Nesting", "Newspapering", "Noodling", "Nucleating", "Orbiting",
    "Orchestrating", "Osmosing", "Perambulating", "Percolating", "Perusing", "Philosophising", "Photosynthesizing", "Pollinating",
    "Pondering", "Pontificating", "Pouncing", "Precipitating", "Prestidigitating", "Processing", "Proofing", "Propagating", "Puttering",
    "Puzzling", "Quantumizing", "Razzle-dazzling", "Razzmatazzing", "Recombobulating", "Reticulating", "Roosting", "Ruminating", "Sautéing",
    "Scampering", "Schlepping", "Scurrying", "Seasoning", "Shenaniganing", "Shimmying", "Simmering", "Skedaddling", "Sketching",
    "Slithering", "Smooshing", "Sock-hopping", "Spelunking", "Spinning", "Sprouting", "Stewing", "Sublimating", "Swirling", "Swooping",
    "Symbioting", "Synthesizing", "Tempering", "Thinking", "Thundering", "Tinkering", "Tomfoolering", "Topsy-turvying", "Transfiguring",
    "Transmuting", "Twisting", "Undulating", "Unfurling", "Unravelling", "Vibing", "Waddling", "Wandering", "Warping", "Whatchamacalliting",
    "Whirlpooling", "Whirring", "Whisking", "Wibbling", "Working", "Wrangling", "Zesting", "Zigzagging",
];

/// `labels.mjs` `pickVerb(turn)`.
pub(crate) fn pick_verb(turn: u64) -> &'static str {
    SPINNER_VERBS[((turn * 7 + 3) % SPINNER_VERBS.len() as u64) as usize]
}

/// The spinner `runTurn` sets as the turn begins: requesting, nothing received yet.
pub(crate) fn started(turn: u64, started_at: i64) -> Value {
    json!({
        "active": true,
        "verb": pick_verb(turn),
        "startedAt": started_at,
        "responseLength": 0,
        "inputTokens": 0,
        "outputTokens": 0,
        "mode": "requesting",
    })
}

/// Wall-clock milliseconds on the core's clock, the one `retryAt` is stamped on.
pub(crate) fn core_now_ms() -> i64 {
    super::Clock::now_ms(&super::SystemClock)
}

/// The wait left until `retry_at` (the core's clock), never below 0; 0 when the retry names no deadline.
fn remaining_ms(retry_at: i64, now_ms: i64) -> i64 {
    if retry_at > 0 { (retry_at - now_ms).max(0) } else { 0 }
}

/// What a run stage sets on the retained spinner (`applyStageChange`, `turn-stream.mjs`), as the fields `patch_spinner` merges: the
/// mode, the verb, and the retry's identity (`retryAt`, the core's clock) with the wait left at `now_ms` (`retryInMs`). `None` when
/// no spinner is shown (a stage delivered after the turn ended never brings it back), when the mode is already shown, or for a stage
/// the run's own phases carry (streaming, tool use, approval). A stage ends on the next phase that sets the mode; the retry fields
/// end with `reconnecting` ([`end_retry`]).
pub(crate) fn stage_fields(spinner: Option<&Value>, stage: &str, detail: Option<&Value>, now_ms: i64) -> Option<[(&'static str, Value); 4]> {
    let spinner = spinner?;
    let mode = match stage {
        "reconnecting" => {
            // A retry the provider's ladder names carries its deadline; an account switch carries only its text.
            let retry_at = detail.and_then(|detail| detail.get("retryAt")).and_then(Value::as_i64).unwrap_or(0).max(0);
            let message = detail.and_then(|detail| detail.get("message")).and_then(Value::as_str).filter(|message| !message.is_empty()).unwrap_or("Reconnecting");
            return Some([
                ("mode", json!("reconnecting")),
                ("verb", json!(message)),
                ("retryAt", json!(retry_at)),
                ("retryInMs", json!(remaining_ms(retry_at, now_ms))),
            ]);
        }
        "requesting" => "requesting",
        "model_thinking" => "model-thinking",
        "compacting" => "compacting",
        _ => return None,
    };
    if spinner.get("mode").and_then(Value::as_str) == Some(mode) {
        return None;
    }
    let verb = spinner.get("verb").cloned().unwrap_or(Value::Null);
    Some([("mode", json!(mode)), ("verb", verb), ("retryAt", Value::Null), ("retryInMs", Value::Null)])
}

/// The retry fields belong to the `reconnecting` mode: a spinner in any other mode holds none.
pub(crate) fn end_retry(spinner: &mut serde_json::Map<String, Value>) {
    if spinner.get("mode").and_then(Value::as_str) == Some("reconnecting") {
        return;
    }
    for key in ["retryAt", "retryInMs"] {
        if spinner.get(key).is_some_and(|held| !held.is_null()) {
            spinner.insert(key.to_owned(), Value::Null);
        }
    }
}

/// `retryInMs` of a reconnecting spinner at `now_ms`, from the deadline the state retains: a client counts the relative wait down
/// from the moment it receives it and never subtracts its own clock from `retryAt`.
pub(crate) fn project_retry(spinner: &mut Value, now_ms: i64) {
    let Some(held) = spinner.as_object_mut() else { return };
    if held.get("mode").and_then(Value::as_str) != Some("reconnecting") {
        return;
    }
    if let Some(retry_at) = held.get("retryAt").and_then(Value::as_i64).filter(|at| *at > 0) {
        held.insert("retryInMs".to_owned(), json!(remaining_ms(retry_at, now_ms)));
    }
}

/// The digits that follow `key` in `body`: where they start and how many.
fn digits_after(body: &[u8], key: &[u8]) -> Option<(usize, usize)> {
    let start = body.windows(key.len()).position(|window| window == key)? + key.len();
    let count = body[start..].iter().take_while(|byte| byte.is_ascii_digit()).count();
    (count > 0).then_some((start, count))
}

/// [`project_retry`] on an encoded frame, without encoding it again: the digits of `"retryInMs":<ms>` of the frame's spinner are
/// replaced with the wait left from its `"retryAt":<ms>`, wherever the two sit among the spinner's keys (the section keeps its
/// own key order, which is not this function's to assume). `None` when the frame holds no retrying spinner (a null deadline has no
/// digits). The copy is the frame's size; it is made only for a snapshot of a thread that is retrying.
pub(crate) fn project_retry_bytes(frame: &[u8], now_ms: i64) -> Option<Vec<u8>> {
    const SPINNER: &[u8] = b"\"spinner\":{";
    let from = frame.windows(SPINNER.len()).position(|window| window == SPINNER)? + SPINNER.len();
    let body = &frame[from..];
    let (deadline_at, deadline_len) = digits_after(body, b"\"retryAt\":")?;
    let retry_at: i64 = std::str::from_utf8(&body[deadline_at..deadline_at + deadline_len]).ok()?.parse().ok()?;
    let (left_at, left_len) = digits_after(body, b"\"retryInMs\":")?;
    let (start, end) = (from + left_at, from + left_at + left_len);
    let mut out = Vec::with_capacity(frame.len());
    out.extend_from_slice(&frame[..start]);
    out.extend_from_slice(remaining_ms(retry_at, now_ms).to_string().as_bytes());
    out.extend_from_slice(&frame[end..]);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spinner(mode: &str) -> Value {
        json!({ "mode": mode, "verb": "Architecting", "startedAt": 1 })
    }

    fn retry() -> Value {
        json!({ "reasonClass": "overloaded", "attempt": 2, "max": 5, "waitMs": 15_000, "retryAt": 1_015_000, "message": "Provider overloaded · retry 2/5 in 15s" })
    }

    fn merged(held: &Value, fields: [(&'static str, Value); 4]) -> serde_json::Map<String, Value> {
        let mut map = held.as_object().expect("a spinner").clone();
        map.extend(fields.into_iter().map(|(key, value)| (key.to_owned(), value)));
        end_retry(&mut map);
        map
    }

    #[test]
    fn a_reconnect_sets_the_mode_the_message_and_the_deadline_with_the_wait_left() {
        let fields = stage_fields(Some(&spinner("requesting")), "reconnecting", Some(&retry()), 1_000_000).expect("a reconnect shows");
        let held = merged(&spinner("requesting"), fields);
        assert_eq!(held["mode"], "reconnecting");
        assert_eq!(held["verb"], "Provider overloaded · retry 2/5 in 15s");
        assert_eq!(held["retryAt"], 1_015_000);
        assert_eq!(held["retryInMs"], 15_000);
    }

    #[test]
    fn the_wait_left_is_computed_from_the_deadline_on_the_core_clock() {
        let mut shown = Value::Object(merged(&spinner("requesting"), stage_fields(Some(&spinner("requesting")), "reconnecting", Some(&retry()), 1_000_000).unwrap()));
        project_retry(&mut shown, 1_007_500);
        assert_eq!(shown["retryInMs"], 7_500);
        project_retry(&mut shown, 2_000_000);
        assert_eq!(shown["retryInMs"], 0);
    }

    #[test]
    fn an_account_switch_has_text_and_no_deadline() {
        let held = merged(&spinner("responding"), stage_fields(Some(&spinner("responding")), "reconnecting", Some(&json!({ "message": "Switching account" })), 5).unwrap());
        assert_eq!((held["verb"].as_str(), held["retryAt"].as_i64(), held["retryInMs"].as_i64()), (Some("Switching account"), Some(0), Some(0)));
    }

    #[test]
    fn the_next_phase_ends_the_retry_and_a_stage_after_the_turn_changes_nothing() {
        let mut held = merged(&spinner("requesting"), stage_fields(Some(&spinner("requesting")), "reconnecting", Some(&retry()), 1_000_000).unwrap());
        held.insert("mode".into(), json!("responding"));
        end_retry(&mut held);
        assert_eq!((held["retryAt"].is_null(), held["retryInMs"].is_null()), (true, true));
        assert!(stage_fields(None, "reconnecting", Some(&retry()), 1).is_none(), "no spinner is shown after the turn");
    }

    #[test]
    fn requesting_model_thinking_and_compacting_set_their_modes_once() {
        for (stage, mode) in [("requesting", "requesting"), ("model_thinking", "model-thinking"), ("compacting", "compacting")] {
            let other = spinner("responding");
            let fields = stage_fields(Some(&other), stage, None, 1).expect(stage);
            assert_eq!(merged(&other, fields)["mode"], mode);
            assert!(stage_fields(Some(&spinner(mode)), stage, None, 1).is_none(), "{stage}: the mode is already shown");
        }
        assert!(stage_fields(Some(&spinner("requesting")), "streaming", None, 1).is_none());
    }

    #[test]
    fn an_encoded_frame_is_projected_without_encoding_it_again() {
        let frame = br#"{"method":"thread/snapshot","params":{"state":{"runtime":{"spinner":{"mode":"reconnecting","retryAt":1015000,"retryInMs":15000,"verb":"x"}}}}}"#;
        let projected = project_retry_bytes(frame, 1_007_500).expect("a retrying spinner");
        assert_eq!(String::from_utf8(projected).unwrap(), String::from_utf8(frame.to_vec()).unwrap().replace("\"retryInMs\":15000", "\"retryInMs\":7500"));
        assert!(project_retry_bytes(br#"{"spinner":{"mode":"requesting","retryAt":null,"retryInMs":null}}"#, 1).is_none());
        // The section's own key order: the wait before the deadline, and other keys between them.
        let reordered = br#"{"params":{"state":{"runtime":{"spinner":{"retryInMs":15000,"mode":"reconnecting","quiet":{"quietMs":1},"retryAt":1015000,"verb":"x"}}}}}"#;
        let projected = String::from_utf8(project_retry_bytes(reordered, 1_007_500).expect("a retrying spinner")).unwrap();
        assert!(projected.contains("\"retryInMs\":7500,") && projected.contains("\"retryAt\":1015000,"), "{projected}");
    }

    /// `pickVerb(0)` is the pool's fourth verb (Node's recorded first turn shows `Architecting`); the index wraps over the pool.
    #[test]
    fn verbs_are_picked_as_node_picks_them() {
        assert_eq!(pick_verb(0), "Architecting");
        assert_eq!(pick_verb(1), SPINNER_VERBS[10]);
        assert_eq!(pick_verb(187), "Architecting");
    }
}