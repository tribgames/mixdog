//! The `format` and `uniqueItems` keywords as the MCP SDK's Ajv checks them: `ajv-formats` in its full mode
//! (`dist/formats.js` `fullFormats`, the SDK's `addFormats(ajv)`), an unknown format accepted (`strict: false`), and a
//! duplicate reported by the indices Ajv's loops find it at.

use std::collections::HashMap;
use std::sync::LazyLock;

use jsonschema::Keyword;
use jsonschema::ValidationError;
use jsonschema::paths::Location;
use regex::Regex;
use serde_json::Map;
use serde_json::Value;

fn pattern(source: &str) -> Regex {
    Regex::new(source).expect("an ajv-formats pattern")
}

static DATE: LazyLock<Regex> = LazyLock::new(|| pattern(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})$"));
static TIME: LazyLock<Regex> = LazyLock::new(|| {
    pattern(
        r"(?i)^([0-9]{2}):([0-9]{2}):([0-9]{2}(?:\.[0-9]+)?)(z|([+-])([0-9]{2})(?::?([0-9]{2}))?)?$",
    )
});
static DURATION: LazyLock<Regex> = LazyLock::new(|| {
    pattern(r"^P(?:([0-9]+Y)?([0-9]+M)?([0-9]+D)?(T([0-9]+H)?([0-9]+M)?([0-9]+S)?)?|([0-9]+W)?)$")
});
static URI: LazyLock<Regex> = LazyLock::new(|| {
    pattern(
        r##"(?i)^(?:[a-z][a-z0-9+\-.]*:)(?:/?/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)|(?:[a-z0-9\-._~!$&'()*+,;=]|%[0-9a-f]{2})*)(?::[0-9]*)?(?:/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*|/(?:(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)(?:\?(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?$"##,
    )
});
static URI_REFERENCE: LazyLock<Regex> = LazyLock::new(|| {
    pattern(
        r##"(?i)^(?:[a-z][a-z0-9+\-.]*:)?(?:/?/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)|(?:[a-z0-9\-._~!$&'"()*+,;=]|%[0-9a-f]{2})*)(?::[0-9]*)?(?:/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*|/(?:(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?(?:\?(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?$"##,
    )
});
static URI_TEMPLATE: LazyLock<Regex> = LazyLock::new(|| {
    pattern(
        r##"(?i)^(?:(?:[^\x00-\x20"'<>%\\^`{|}]|%[0-9a-f]{2})|\{[+#./;?&=,!@|]?(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?(?:,(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?)*\})*$"##,
    )
});
/// The one pattern with lookaheads (`fancy-regex`, which `jsonschema` already uses for `pattern`).
static URL: LazyLock<fancy_regex::Regex> = LazyLock::new(|| {
    fancy_regex::Regex::new(
        r##"(?i)^(?:https?|ftp)://(?:\S+(?::\S*)?@)?(?:(?!(?:10|127)(?:\.[0-9]{1,3}){3})(?!(?:169\.254|192\.168)(?:\.[0-9]{1,3}){2})(?!172\.(?:1[6-9]|2[0-9]|3[0-1])(?:\.[0-9]{1,3}){2})(?:[1-9][0-9]?|1[0-9][0-9]|2[01][0-9]|22[0-3])(?:\.(?:1?[0-9]{1,2}|2[0-4][0-9]|25[0-5])){2}(?:\.(?:[1-9][0-9]?|1[0-9][0-9]|2[0-4][0-9]|25[0-4]))|(?:(?:[a-z0-9\x{00a1}-\x{ffff}]+-)*[a-z0-9\x{00a1}-\x{ffff}]+)(?:\.(?:[a-z0-9\x{00a1}-\x{ffff}]+-)*[a-z0-9\x{00a1}-\x{ffff}]+)*(?:\.(?:[a-z\x{00a1}-\x{ffff}]{2,})))(?::[0-9]{2,5})?(?:/[^\s]*)?$"##,
    )
    .expect("the ajv-formats url pattern")
});
static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
    pattern(
        r##"(?i)^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$"##,
    )
});
static HOSTNAME: LazyLock<Regex> = LazyLock::new(|| {
    pattern(
        r"(?i)^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-0-9a-z]{0,61}[0-9a-z])?)*\.?$",
    )
});
static IPV4: LazyLock<Regex> = LazyLock::new(|| {
    pattern(
        r"^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$",
    )
});
static IPV6: LazyLock<Regex> = LazyLock::new(|| {
    let byte = r"(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])";
    let v4 = format!(r"({byte}(\.{byte}){{3}})");
    pattern(&format!(
        r"(?i)^((([0-9a-f]{{1,4}}:){{7}}([0-9a-f]{{1,4}}|:))|(([0-9a-f]{{1,4}}:){{6}}(:[0-9a-f]{{1,4}}|{v4}|:))|(([0-9a-f]{{1,4}}:){{5}}(((:[0-9a-f]{{1,4}}){{1,2}})|:{v4}|:))|(([0-9a-f]{{1,4}}:){{4}}(((:[0-9a-f]{{1,4}}){{1,3}})|((:[0-9a-f]{{1,4}})?:{v4})|:))|(([0-9a-f]{{1,4}}:){{3}}(((:[0-9a-f]{{1,4}}){{1,4}})|((:[0-9a-f]{{1,4}}){{0,2}}:{v4})|:))|(([0-9a-f]{{1,4}}:){{2}}(((:[0-9a-f]{{1,4}}){{1,5}})|((:[0-9a-f]{{1,4}}){{0,3}}:{v4})|:))|(([0-9a-f]{{1,4}}:){{1}}(((:[0-9a-f]{{1,4}}){{1,6}})|((:[0-9a-f]{{1,4}}){{0,4}}:{v4})|:))|(:(((:[0-9a-f]{{1,4}}){{1,7}})|((:[0-9a-f]{{1,4}}){{0,5}}:{v4})|:)))$"
    ))
});
static UUID: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"(?i)^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$"));
static JSON_POINTER: LazyLock<Regex> = LazyLock::new(|| pattern(r"^(?:/(?:[^~/]|~0|~1)*)*$"));
static JSON_POINTER_URI_FRAGMENT: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"(?i)^#(?:/(?:[a-z0-9_\-.!$&'()*+,;:=@]|%[0-9a-f]{2}|~0|~1)*)*$"));
static RELATIVE_JSON_POINTER: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"^(?:0|[1-9][0-9]*)(?:#|(?:/(?:[^~/]|~0|~1)*)*)$"));
static BYTE: LazyLock<Regex> = LazyLock::new(|| {
    pattern(r"(?m)^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$")
});

fn is_leap_year(year: u32) -> bool {
    year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400))
}

fn date(text: &str) -> bool {
    const DAYS: [u32; 13] = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let Some(parts) = DATE.captures(text) else {
        return false;
    };
    let number = |at: usize| parts[at].parse::<u32>().unwrap_or(0);
    let (year, month, day) = (number(1), number(2), number(3));
    (1..=12).contains(&month)
        && day >= 1
        && day
            <= if month == 2 && is_leap_year(year) {
                29
            } else {
                DAYS[month as usize]
            }
}

/// `getTime(strictTimeZone)`, the leap second accepted at 23:59 UTC.
fn time(text: &str, strict_time_zone: bool) -> bool {
    let Some(parts) = TIME.captures(text) else {
        return false;
    };
    let int = |at: usize| {
        parts
            .get(at)
            .map_or(0, |m| m.as_str().parse::<i64>().unwrap_or(0))
    };
    let (hour, minute) = (int(1), int(2));
    let second: f64 = parts[3].parse().unwrap_or(0.0);
    let sign = if parts.get(5).is_some_and(|m| m.as_str() == "-") {
        -1
    } else {
        1
    };
    let (zone_hour, zone_minute) = (int(6), int(7));
    if zone_hour > 23 || zone_minute > 59 || (strict_time_zone && parts.get(4).is_none()) {
        return false;
    }
    if hour <= 23 && minute <= 59 && second < 60.0 {
        return true;
    }
    let utc_minute = minute - zone_minute * sign;
    let utc_hour = hour - zone_hour * sign - i64::from(utc_minute < 0);
    (utc_hour == 23 || utc_hour == -1) && (utc_minute == 59 || utc_minute == -1) && second < 61.0
}

/// JavaScript's `\s`.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `getDateTime`: the text split at every `t` or space must be a date and a time.
fn date_time(text: &str, strict_time_zone: bool) -> bool {
    let parts: Vec<&str> = text
        .split(|c: char| c == 't' || c == 'T' || is_js_space(c))
        .collect();
    parts.len() == 2 && date(parts[0]) && time(parts[1], strict_time_zone)
}

/// `^P(?!$)…T(?=\d)…`: something after the `P`, and a digit after a `T`.
fn duration(text: &str) -> bool {
    text != "P"
        && DURATION.is_match(text)
        && text
            .find('T')
            .is_none_or(|at| text[at + 1..].starts_with(|c: char| c.is_ascii_digit()))
}

/// `(?=.{1,253}\.?$)`, then the labels.
fn hostname(text: &str) -> bool {
    let length = text.encode_utf16().count();
    let fits =
        (1..=253).contains(&length) || (text.ends_with('.') && (1..=253).contains(&(length - 1)));
    fits && HOSTNAME.is_match(text)
}

/// A pattern V8 compiles as `new RegExp(text)`, without flags (ajv-formats' `regex`), that does not use `\Z`.
fn regex(text: &str) -> bool {
    static Z_ANCHOR: LazyLock<Regex> = LazyLock::new(|| pattern(r"[^\\]\\Z"));
    !Z_ANCHOR.is_match(text) && mixdog_js::js_regex_error(text, "").is_none()
}

/// `Number.isInteger`.
fn integer(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|number| number.is_finite() && number.fract() == 0.0)
}

/// Whether `value` passes the format `name`; `None` for a format `ajv-formats` does not define.
fn check(name: &str, value: &Value) -> Option<bool> {
    let string = |test: fn(&str) -> bool| Some(value.as_str().is_none_or(test));
    let number = |test: fn(&Value) -> bool| Some(!value.is_number() || test(value));
    match name {
        "date" => string(date),
        "time" => string(|t| time(t, true)),
        "date-time" => string(|t| date_time(t, true)),
        "iso-time" => string(|t| time(t, false)),
        "iso-date-time" => string(|t| date_time(t, false)),
        "duration" => string(duration),
        "uri" => string(|t| (t.contains('/') || t.contains(':')) && URI.is_match(t)),
        "uri-reference" => string(|t| URI_REFERENCE.is_match(t)),
        "uri-template" => string(|t| URI_TEMPLATE.is_match(t)),
        "url" => string(|t| URL.is_match(t).unwrap_or(false)),
        "email" => string(|t| EMAIL.is_match(t)),
        "hostname" => string(hostname),
        "ipv4" => string(|t| IPV4.is_match(t)),
        "ipv6" => string(|t| IPV6.is_match(t)),
        "regex" => string(regex),
        "uuid" => string(|t| UUID.is_match(t)),
        "json-pointer" => string(|t| JSON_POINTER.is_match(t)),
        "json-pointer-uri-fragment" => string(|t| JSON_POINTER_URI_FRAGMENT.is_match(t)),
        "relative-json-pointer" => string(|t| RELATIVE_JSON_POINTER.is_match(t)),
        "byte" => string(|t| BYTE.is_match(t)),
        "int32" => number(|v| {
            integer(v).is_some_and(|n| (-2_147_483_648.0..=2_147_483_647.0).contains(&n))
        }),
        "int64" => number(|v| integer(v).is_some()),
        "float" | "double" | "password" | "binary" => Some(true),
        _ => None,
    }
}

struct Format(String);

impl<'i> Keyword<'i> for Format {
    fn validate(&self, instance: &'i Value) -> Result<(), ValidationError<'i>> {
        if self.is_valid(instance) {
            Ok(())
        } else {
            Err(ValidationError::custom(format!(
                "must match format \"{}\"",
                self.0
            )))
        }
    }

    fn is_valid(&self, instance: &'i Value) -> bool {
        check(&self.0, instance).unwrap_or(true)
    }
}

/// Accepts everything: a keyword Ajv ignores here.
struct Ignored;

impl<'i> Keyword<'i> for Ignored {
    fn validate(&self, _: &'i Value) -> Result<(), ValidationError<'i>> {
        Ok(())
    }

    fn is_valid(&self, _: &'i Value) -> bool {
        true
    }
}

/// The `format` keyword: a name `ajv-formats` does not define, or a value that is not a name, checks nothing.
pub(crate) fn format_keyword<'a>(
    _: &'a Map<String, Value>,
    value: &'a Value,
    _: Location,
) -> Result<Box<dyn for<'i> Keyword<'i>>, ValidationError<'a>> {
    Ok(match value.as_str() {
        Some(name) if check(name, &Value::Null).is_some() => Box::new(Format(name.to_owned())),
        _ => Box::new(Ignored),
    })
}

/// A text two values share exactly when fast-deep-equal calls them equal: numbers by their JavaScript value (`1` and
/// `1.0` alike), strings, booleans and null by type and value (`1` and `"1"` apart), arrays item by item, objects by
/// their entries whatever the order.
fn equality_key(value: &Value, out: &mut String) {
    match value {
        Value::Number(number) => {
            out.push('n');
            out.push_str(&mixdog_js::number_to_string(
                number.as_f64().unwrap_or(f64::NAN),
            ));
        }
        Value::String(text) => {
            out.push('s');
            mixdog_js::json_quote(text, out);
        }
        Value::Array(items) => {
            out.push('[');
            for item in items {
                equality_key(item, out);
                out.push(',');
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_unstable_by_key(|(key, _)| *key);
            out.push('{');
            for (key, item) in entries {
                mixdog_js::json_quote(key, out);
                out.push(':');
                equality_key(item, out);
                out.push(',');
            }
            out.push('}');
        }
        other => out.push_str(&other.to_string()),
    }
}

fn key_of(value: &Value) -> String {
    let mut key = String::new();
    equality_key(value, &mut key);
    key
}

/// Whether `value` is of the Ajv data type `name`.
fn of_type(name: &str, value: &Value) -> bool {
    match name {
        "number" => value.is_number(),
        "integer" => integer(value).is_some(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        "array" => value.is_array(),
        "object" => value.is_object(),
        _ => false,
    }
}

struct Unique {
    /// The types `items` declares, when they are all scalar (Ajv's `loopN` over a map of seen items).
    item_types: Vec<String>,
}

impl Unique {
    /// The pair Ajv reports, `(j, i)`, found in one pass over the items with a map of the ones seen (each item's key is
    /// built once, so the work grows with the result's size, not with its square).
    fn duplicate(&self, items: &[Value]) -> Option<(usize, usize)> {
        if items.len() < 2 {
            return None;
        }
        if self.item_types.is_empty() {
            // Ajv's `loop2` reports the last item equal to an earlier one, with the nearest earlier one.
            let mut last: HashMap<String, usize> = HashMap::with_capacity(items.len());
            let mut found = None;
            for (i, item) in items.iter().enumerate() {
                if let Some(j) = last.insert(key_of(item), i) {
                    found = Some((j, i));
                }
            }
            return found;
        }
        // Ajv's `loopN` walks backwards and reports the first item equal to a later one, with the nearest later one.
        let mut seen: HashMap<String, usize> = HashMap::with_capacity(items.len());
        for i in (0..items.len()).rev() {
            let item = &items[i];
            if !self.item_types.iter().any(|t| of_type(t, item)) {
                continue;
            }
            match seen.entry(key_of(item)) {
                std::collections::hash_map::Entry::Occupied(later) => {
                    return Some((*later.get(), i));
                }
                std::collections::hash_map::Entry::Vacant(slot) => {
                    slot.insert(i);
                }
            }
        }
        None
    }
}

impl<'i> Keyword<'i> for Unique {
    fn validate(&self, instance: &'i Value) -> Result<(), ValidationError<'i>> {
        match instance.as_array().and_then(|items| self.duplicate(items)) {
            None => Ok(()),
            Some((j, i)) => Err(ValidationError::custom(format!(
                "must NOT have duplicate items (items ## {j} and {i} are identical)"
            ))),
        }
    }

    fn is_valid(&self, instance: &'i Value) -> bool {
        instance
            .as_array()
            .is_none_or(|items| self.duplicate(items).is_none())
    }
}

/// The `uniqueItems` keyword.
pub(crate) fn unique_items_keyword<'a>(
    parent: &'a Map<String, Value>,
    value: &'a Value,
    _: Location,
) -> Result<Box<dyn for<'i> Keyword<'i>>, ValidationError<'a>> {
    if value != &Value::Bool(true) {
        return Ok(Box::new(Ignored));
    }
    let item_types: Vec<String> = match parent.get("items").and_then(|items| items.get("type")) {
        Some(Value::String(one)) => vec![one.clone()],
        Some(Value::Array(many)) => many
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    };
    let scalar =
        !item_types.is_empty() && !item_types.iter().any(|t| t == "object" || t == "array");
    Ok(Box::new(Unique {
        item_types: if scalar { item_types } else { Vec::new() },
    }))
}

/// Ajv's `multipleOf` (no `multipleOfPrecision`): the quotient `res = data / m` is a multiple exactly when
/// `res === parseInt(String(res))`, which holds for an integer-valued quotient JavaScript prints in full (below 1e21).
struct MultipleOf(f64);

impl MultipleOf {
    fn holds(&self, value: &Value) -> bool {
        let Some(number) = value.as_f64().filter(|_| value.is_number()) else {
            return true;
        };
        let quotient = number / self.0;
        quotient.is_finite() && quotient.fract() == 0.0 && quotient.abs() < 1e21
    }
}

impl<'i> Keyword<'i> for MultipleOf {
    fn validate(&self, instance: &'i Value) -> Result<(), ValidationError<'i>> {
        if self.holds(instance) {
            Ok(())
        } else {
            Err(ValidationError::custom(format!(
                "must be multiple of {}",
                mixdog_js::number_to_string(self.0)
            )))
        }
    }

    fn is_valid(&self, instance: &'i Value) -> bool {
        self.holds(instance)
    }
}

/// The `multipleOf` keyword; a value that is not a number is Ajv's to ignore here (strict mode is off).
pub(crate) fn multiple_of_keyword<'a>(
    _: &'a Map<String, Value>,
    value: &'a Value,
    _: Location,
) -> Result<Box<dyn for<'i> Keyword<'i>>, ValidationError<'a>> {
    Ok(match value.as_f64() {
        Some(divisor) => Box::new(MultipleOf(divisor)),
        None => Box::new(Ignored),
    })
}

#[cfg(test)]
mod tests {
    use super::Unique;
    use serde_json::Value;
    use serde_json::json;

    /// Duplicates are found in one pass: 200 000 distinct items (twenty billion comparisons pairwise) take moments,
    /// and the pair reported is Ajv's, `1` and `1.0` equal, `1` and `"1"` apart.
    #[test]
    fn unique_items_takes_one_pass_and_reports_ajvs_pair() {
        let many: Vec<Value> = (0..200_000).map(|n| json!(n)).collect();
        let started = std::time::Instant::now();
        for types in [vec!["number".to_owned()], Vec::new()] {
            assert_eq!(Unique { item_types: types }.duplicate(&many), None);
        }
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "{:?}",
            started.elapsed()
        );
        let scalar = Unique {
            item_types: vec!["number".to_owned(), "string".to_owned()],
        };
        let items: Vec<Value> = serde_json::from_str(r#"["a", 1, 2, "a", 1.0, "1"]"#).unwrap();
        assert_eq!(scalar.duplicate(&items), Some((4, 1)));
        let any = Unique {
            item_types: Vec::new(),
        };
        let items = vec![
            json!({"a": 1, "b": [1]}),
            json!(2),
            json!({"b": [1.0], "a": 1}),
            json!(2),
        ];
        assert_eq!(any.duplicate(&items), Some((1, 3)));
    }
}
