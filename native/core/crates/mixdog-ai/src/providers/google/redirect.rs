//! Model ids the Gemini API serves as another model, and the models that ignore the sampling parameters (port of
//! `gemini-model-redirect.mjs`). Effective 2026-12-01 every API request to `gemini-2.5-pro` routes to
//! `gemini-3.8-flash` and every request to `gemini-2.5-flash` to `gemini-3.5-flash-lite`; the date is taken as UTC
//! midnight, as in Node.

use mixdog_js::JsRegex;
use std::sync::LazyLock;

/// `Date.parse('2026-12-01T00:00:00Z')`.
const REDIRECT_FROM_MS: u64 = 1_796_083_200_000;

const REDIRECTS: [(&str, &str); 2] = [("gemini-2.5-pro", "gemini-3.8-flash"), ("gemini-2.5-flash", "gemini-3.5-flash-lite")];

static MODELS_PREFIX: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^models/", "i"));
static FLASH_3_5: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^gemini-3\.5-flash(?:-lite)?$", ""));

fn bare_id(model: &str) -> String {
    let stripped = if model.get(..7).is_some_and(|head| MODELS_PREFIX.is_match(head)) { &model[7..] } else { model };
    stripped.to_lowercase()
}

/// `geminiRedirectTarget`: the id the API serves `model` as at `now_ms`, or `None` when it is served as itself.
pub fn served_as(model: &str, now_ms: u64) -> Option<&'static str> {
    if now_ms < REDIRECT_FROM_MS {
        return None;
    }
    let bare = bare_id(model);
    REDIRECTS.iter().find(|(from, _)| *from == bare).map(|(_, to)| *to)
}

/// `geminiIgnoresSamplingParams`: Gemini 3.6 Flash, 3.5 Flash(-Lite) and every later release ignore `temperature`.
pub fn ignores_sampling(model: &str) -> bool {
    let bare = bare_id(model);
    if FLASH_3_5.is_match(&bare) {
        return true;
    }
    let Some(rest) = bare.strip_prefix("gemini-") else { return false };
    let digits = |s: &str| s.bytes().take_while(u8::is_ascii_digit).count();
    let major_len = digits(rest);
    if major_len == 0 {
        return false;
    }
    let after_major = &rest[major_len..];
    let (minor, tail) = match after_major.strip_prefix('.') {
        Some(minor_and_tail) if digits(minor_and_tail) > 0 => {
            let n = digits(minor_and_tail);
            (minor_and_tail[..n].parse::<u64>().unwrap_or(u64::MAX), &minor_and_tail[n..])
        }
        _ => (0, after_major),
    };
    if !(tail.is_empty() || tail.starts_with('-')) {
        return false;
    }
    let major = rest[..major_len].parse::<u64>().unwrap_or(u64::MAX);
    major >= 4 || (major == 3 && minor >= 6)
}
