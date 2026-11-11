//! A server's header value a client sent holding an unpaired surrogate escape. The frame decoder reads the lone unit as U+FFFD
//! (the value is free text, mixdog-app-protocol `free_text`) and the server is saved with that; Node saves the unit itself and its
//! fetch refuses the value when it connects, naming the unit: `Cannot convert argument to a ByteString because the character at
//! index 3 has a value of 55357 which is greater than 255.` (WebIDL ByteString, undici's `Headers`). The units are kept here,
//! for this process, by the value as the core reads it, so the connection fails with Node's text.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::Value;

/// The lone units (`(UTF-16 index, unit)`) each header value held, by the value as read.
static HELD: Mutex<Option<HashMap<String, Vec<(usize, u16)>>>> = Mutex::new(None);

/// Keeps the lone units of every header value of `input` (an `mcp/addMcpServer` / `mcp/saveMcpServer` input) the request held
/// (`lone`: the request's `CallContext::lone_surrogates`, pointers into its params).
pub fn remember(input: &Value, lone: &[mixdog_js::LoneAt]) {
    let Some(headers) = input.get("headers").and_then(Value::as_object) else { return };
    let mut held = HELD.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    for (name, value) in headers {
        let Some(value) = value.as_str() else { continue };
        let pointer = format!("/input/headers/{}", name.replace('~', "~0").replace('/', "~1"));
        let units = mixdog_js::LoneAt::units_at(lone, &pointer);
        if !units.is_empty() {
            held.get_or_insert_with(HashMap::new).insert(value.to_owned(), units);
        }
    }
}

/// Node's refusal of header value `value` (`Headers` takes a ByteString: no UTF-16 unit over 255), naming the first such unit
/// as the client sent it.
pub fn byte_string_error(value: &str) -> Option<String> {
    let (at, unit) = value.encode_utf16().enumerate().find(|(_, unit)| *unit > 255)?;
    let held = HELD.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let sent = held
        .as_ref()
        .and_then(|held| held.get(value))
        .and_then(|units| units.iter().find(|(index, _)| *index == at))
        .map_or(unit, |(_, unit)| *unit);
    Some(format!("Cannot convert argument to a ByteString because the character at index {at} has a value of {sent} which is greater than 255."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_header_value_names_the_unit_the_client_sent() {
        let lone = [
            mixdog_js::LoneAt::Value("/input/headers/X-Lone".into()),
            mixdog_js::LoneAt::Unit { pointer: "/input/headers/X-Lone".into(), at: 3, unit: 0xd83d },
        ];
        remember(&json!({"headers": {"X-Lone": "xyz\u{fffd}", "X-Plain": "ok"}}), &lone);
        assert_eq!(
            byte_string_error("xyz\u{fffd}").as_deref(),
            Some("Cannot convert argument to a ByteString because the character at index 3 has a value of 55357 which is greater than 255.")
        );
        // A value that held no lone unit names its own: a real U+FFFD, a character outside the BMP (its high unit).
        assert_eq!(
            byte_string_error("a\u{fffd}").as_deref(),
            Some("Cannot convert argument to a ByteString because the character at index 1 has a value of 65533 which is greater than 255.")
        );
        assert_eq!(
            byte_string_error("\u{1f600}").as_deref(),
            Some("Cannot convert argument to a ByteString because the character at index 0 has a value of 55357 which is greater than 255.")
        );
        assert_eq!(byte_string_error("caf\u{e9}"), None);
    }
}
