//! Built-in `web_fetch` transport routing (`routeWebFetchCall`, Node's `pre-dispatch-deny.mjs`).
//!
//! Only a call whose complete URL set has one unambiguous transport is rewritten: all loopback
//! `http(s)` URLs go to `local_fetch`, all image URLs to `image_fetch`. Mixed or public batches
//! stay on `web_fetch`, whose SSRF checks fail closed rather than broadening `local_fetch`. The
//! public tool name stays `web_fetch`: the call keeps it as its schema name, and the session's
//! surface judges the call under that name.

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_protocol::JsonValue;

use crate::env::GateCall;

static JSON_ARRAY_START: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\s*\[", ""));
static IMAGE_PATH: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"\.(?:png|jpe?g|gif|webp)(?:$|[?#])", "i"));

/// A non-blank string, trimmed.
fn trimmed(value: &JsonValue) -> Option<String> {
    let text = value.as_str()?;
    let text = js_trim(text);
    (!text.is_empty()).then(|| text.to_owned())
}

/// `callUrls`: the trimmed URL string, or the trimmed strings of a non-empty all-string list.
fn call_urls(args: &JsonValue) -> Vec<String> {
    match args.get("url") {
        Some(value @ JsonValue::String(_)) => trimmed(value).into_iter().collect(),
        Some(JsonValue::Array(items)) if !items.is_empty() => {
            items.iter().map(trimmed).collect::<Option<Vec<_>>>().unwrap_or_default()
        }
        _ => Vec::new(),
    }
}

fn is_loopback_http_url(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    if url.scheme() != "http" && url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str().map(str::to_lowercase) else {
        return false;
    };
    if matches!(host.as_str(), "localhost" | "[::1]" | "::1") {
        return true;
    }
    // `^(\d{1,3})(?:\.(\d{1,3})){3}$` with the first group 127.
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() == 4
        && parts.iter().all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
        && parts[0].parse::<u32>() == Ok(127)
}

/// Routes a `web_fetch` call in place. A JSON-stringified array in `url` (a common provider
/// serialisation artifact) is first parsed back into real URLs.
pub fn route_web_fetch(call: &mut GateCall) {
    if call.name != "web_fetch" {
        return;
    }
    if let Some(raw) = call.args.get("url").and_then(JsonValue::as_str)
        && JSON_ARRAY_START.is_match(raw)
        && let Ok(JsonValue::Array(items)) = serde_json::from_str::<JsonValue>(raw)
        && !items.is_empty()
        && let Some(urls) = items.iter().map(trimmed).collect::<Option<Vec<_>>>()
        && let Some(map) = call.args.as_object_mut()
    {
        map.insert("url".to_owned(), JsonValue::Array(urls.into_iter().map(JsonValue::String).collect()));
    }
    let urls = call_urls(&call.args);
    if urls.is_empty() {
        return;
    }
    if urls.iter().all(|u| is_loopback_http_url(u)) {
        call.schema_name = Some("web_fetch".to_owned());
        call.name = "local_fetch".to_owned();
    } else if urls.iter().all(|u| IMAGE_PATH.is_match(u)) {
        call.schema_name = Some("web_fetch".to_owned());
        call.name = "image_fetch".to_owned();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `[args, name, schemaName, arguments]` rows from Node's `routeWebFetchCall`.
    const ROWS: &str = include_str!("../testdata/route_web_fetch.json");

    #[test]
    fn routing_matches_node() {
        let rows: Vec<(JsonValue, String, Option<String>, JsonValue)> = serde_json::from_str(ROWS).expect("fixture");
        assert_eq!(rows.len(), 35);
        for (args, name, schema, after) in rows {
            let mut call = GateCall::new("web_fetch", args.clone());
            route_web_fetch(&mut call);
            assert_eq!((call.name.as_str(), call.schema_name.as_deref()), (name.as_str(), schema.as_deref()), "{args}");
            assert_eq!(call.args, after, "{args}");
        }
    }

    #[test]
    fn other_tools_are_not_routed() {
        let mut call = GateCall::new("read", serde_json::json!({"url": "http://localhost/"}));
        route_web_fetch(&mut call);
        assert_eq!((call.name.as_str(), call.schema_name), ("read", None));
    }
}
