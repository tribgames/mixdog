//! The built-in browser's site-permission policy stored at `desktop.browserPermissions`: one
//! default per kind (allow, ask or block) and per-site exceptions. Storage holds only the
//! defaults that differ from the built-in ones and the exceptions.

use serde_json::Map;
use serde_json::Value;
use url::Url;

pub const MAX_SITES: usize = 300;

const KINDS: [(&str, &str); 13] = [
    ("notifications", "block"),
    ("geolocation", "block"),
    ("clipboard-write", "allow"),
    ("clipboard-read", "ask"),
    ("media:video", "ask"),
    ("media:audio", "ask"),
    ("midi", "ask"),
    ("midiSysex", "ask"),
    ("idle-detection", "ask"),
    ("top-level-storage-access", "ask"),
    ("window-management", "ask"),
    ("speaker-selection", "ask"),
    ("fileSystem", "ask"),
];

fn is_setting(value: Option<&Value>) -> Option<&str> {
    value?.as_str().filter(|s| matches!(*s, "allow" | "ask" | "block"))
}

fn is_kind(value: Option<&Value>) -> Option<&str> {
    value?.as_str().filter(|s| KINDS.iter().any(|(kind, _)| kind == s))
}

/// A web origin written exactly as the URL parser serializes it.
fn web_origin(value: &Value) -> Option<&str> {
    let text = value.as_str().filter(|s| mixdog_js::utf16_len(s) <= 300)?;
    let url = Url::parse(text).ok()?;
    (matches!(url.scheme(), "http" | "https") && url.origin().ascii_serialization() == text)
        .then_some(text)
}

/// A stored or received policy as a whole one: unknown kinds, settings and malformed sites are
/// dropped, a missing default is the built-in one. Never truncated.
pub fn normalize(value: Option<&Value>) -> (Vec<(&'static str, String)>, Vec<Value>) {
    let stored = value.and_then(Value::as_object);
    let defaults_in = stored.and_then(|s| s.get("defaults")).and_then(Value::as_object);
    let defaults = KINDS
        .iter()
        .map(|(kind, built_in)| {
            let setting = defaults_in
                .and_then(|d| is_setting(d.get(*kind)))
                .unwrap_or(built_in);
            (*kind, setting.to_owned())
        })
        .collect();
    let mut sites: Vec<Value> = Vec::new();
    let mut seen: Vec<(String, String, String)> = Vec::new();
    let entries = stored.and_then(|s| s.get("sites")).and_then(Value::as_array);
    for entry in entries.into_iter().flatten() {
        let Some(rule) = entry.as_object() else { continue };
        let Some(origin) = rule.get("origin").and_then(web_origin) else { continue };
        let embedder = match rule.get("embedder") {
            None => None,
            Some(e) => match web_origin(e) {
                Some(e) => Some(e),
                None => continue,
            },
        };
        let (Some(permission), Some(setting)) =
            (is_kind(rule.get("permission")), is_setting(rule.get("setting")))
        else {
            continue;
        };
        let embedder = embedder.filter(|e| *e != origin);
        let identity = (
            origin.to_owned(),
            embedder.unwrap_or(origin).to_owned(),
            permission.to_owned(),
        );
        if seen.contains(&identity) {
            continue;
        }
        seen.push(identity);
        let mut site = Map::new();
        site.insert("origin".into(), origin.into());
        if let Some(embedder) = embedder {
            site.insert("embedder".into(), embedder.into());
        }
        site.insert("permission".into(), permission.into());
        site.insert("setting".into(), setting.into());
        sites.push(Value::Object(site));
    }
    (defaults, sites)
}

/// The policy as the settings view shows it: every default plus the exceptions.
pub fn view(value: Option<&Value>) -> Value {
    let (defaults, sites) = normalize(value);
    let defaults: Map<String, Value> = defaults
        .into_iter()
        .map(|(kind, setting)| (kind.to_owned(), Value::String(setting)))
        .collect();
    serde_json::json!({ "defaults": defaults, "sites": sites })
}

/// What is stored for a received policy, or `None` when there is nothing to keep. A list may
/// only grow up to the limit; one already past it (a hand edit) may still shrink.
pub fn storable(received: &Value, current: Option<&Value>) -> Result<Option<Value>, usize> {
    let (defaults, sites) = normalize(Some(received));
    let kept = normalize(current).1.len();
    if sites.len() > MAX_SITES.max(kept) {
        return Err(MAX_SITES);
    }
    let differing: Map<String, Value> = defaults
        .into_iter()
        .zip(KINDS)
        .filter(|((_, setting), (_, built_in))| setting != built_in)
        .map(|((kind, setting), _)| (kind.to_owned(), Value::String(setting)))
        .collect();
    let mut stored = Map::new();
    if !differing.is_empty() {
        stored.insert("defaults".into(), Value::Object(differing));
    }
    if !sites.is_empty() {
        stored.insert("sites".into(), Value::Array(sites));
    }
    Ok((!stored.is_empty()).then_some(Value::Object(stored)))
}
