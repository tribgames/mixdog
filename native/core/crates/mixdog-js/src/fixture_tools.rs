//! The loader of the tool references recorded goldens carry, and the one fixture of the real Node tool
//! definitions. A golden does not inline a real tool definition: it holds
//! `{"$tool": name, "variant"?: v, "hash": h, "override"?: {..}, "unset"?: [..]}` where one would be, and the
//! definitions are recorded once in `fixtures/tool-definitions/definitions.json` (keyed `name` or
//! `name@variant`, each with the content hash of its canonical JSON). [`parse_golden`] resolves a golden's
//! references: the entry must exist, hash to the hash it records, and match the hash the reference names; then
//! the overridden fields are laid over a copy of it and the unset ones dropped. [`definition`] is the same
//! lookup for a test that compares an embedded definition with Node's.
//!
//! A reference names the base definition by having no `variant`; a `variant` is a non-empty string, and every
//! field of a reference has the type given above, else the reference is an error (never read as absent).
//!
//! The hash is the first 16 hex digits of the sha-256 of the canonical JSON (every object's keys sorted by
//! UTF-16 code unit, as JavaScript sorts them, no whitespace), the text `contentHash` of
//! `benchmarks/rust-core/recorders/lib/tool-definitions.mjs` hashes.

use serde_json::Map;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

const DEFINITIONS: &str = include_str!("../../../fixtures/tool-definitions/definitions.json");

fn canonical(value: &Value, out: &mut String) {
    match value {
        Value::Array(items) => {
            out.push('[');
            for (at, item) in items.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                canonical(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            // JavaScript's `Object.keys(..).sort()` compares UTF-16 code units, which is not the UTF-8 byte order
            // for a key above U+FFFF against one in U+E000..U+FFFF.
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (at, key) in keys.into_iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                canonical(&map[key.as_str()], out);
            }
            out.push('}');
        }
        other => out.push_str(&other.to_string()),
    }
}

/// The first 16 hex digits of the sha-256 of `value`'s canonical JSON.
pub fn content_hash(value: &Value) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut text = String::new();
    canonical(value, &mut text);
    let mut hash = String::new();
    for byte in Sha256::digest(text.as_bytes()).iter().take(8) {
        hash.push(char::from(DIGITS[usize::from(byte >> 4)]));
        hash.push(char::from(DIGITS[usize::from(byte & 15)]));
    }
    hash
}

fn definitions() -> Result<Map<String, Value>, String> {
    let fixture: Value = serde_json::from_str(DEFINITIONS).map_err(|error| format!("the shared definitions fixture does not parse: {error}"))?;
    match fixture.get("definitions") {
        Some(Value::Object(map)) => Ok(map.clone()),
        _ => Err("the shared definitions fixture has no definitions".to_owned()),
    }
}

/// The entry `key` of the fixture: its definition and recorded hash, after the entry is checked to hash to it.
fn entry<'a>(key: &str, definitions: &'a Map<String, Value>) -> Result<(&'a Map<String, Value>, &'a str), String> {
    let entry = definitions.get(key).ok_or_else(|| format!("the tool {key} is not in the shared definitions fixture"))?;
    let Some(Value::Object(definition)) = entry.get("definition") else { return Err(format!("{key}: the fixture entry has no definition object")) };
    let Some(recorded) = entry.get("hash").and_then(Value::as_str) else { return Err(format!("{key}: the fixture entry has no hash")) };
    let actual = content_hash(&entry["definition"]);
    if actual != recorded {
        return Err(format!("{key}: the fixture entry hashes to {actual}, not the {recorded} it records"));
    }
    Ok((definition, recorded))
}

/// The real Node definition recorded under `key` (`name` or `name@variant`), its hash checked.
pub fn definition(key: &str) -> Result<Value, String> {
    let definitions = definitions()?;
    entry(key, &definitions).map(|(definition, _)| Value::Object(definition.clone()))
}

fn resolve(node: &Value, definitions: &Map<String, Value>) -> Result<Value, String> {
    match node {
        Value::Array(items) => items.iter().map(|item| resolve(item, definitions)).collect::<Result<Vec<_>, _>>().map(Value::Array),
        Value::Object(map) if map.contains_key("$tool") => resolve_reference(map, definitions),
        Value::Object(map) => map.iter().map(|(key, child)| resolve(child, definitions).map(|child| (key.clone(), child))).collect::<Result<Map<_, _>, _>>().map(Value::Object),
        other => Ok(other.clone()),
    }
}

fn resolve_reference(reference: &Map<String, Value>, definitions: &Map<String, Value>) -> Result<Value, String> {
    let Some(Value::String(name)) = reference.get("$tool") else { return Err(format!("a tool reference whose $tool is not a string: {}", Value::Object(reference.clone()))) };
    let key = match reference.get("variant") {
        None => name.clone(),
        Some(Value::String(variant)) if !variant.is_empty() => format!("{name}@{variant}"),
        Some(other) => return Err(format!("{name}: the variant of a reference is a non-empty string (none for the base definition), not {other}")),
    };
    let (definition, recorded) = entry(&key, definitions)?;
    let Some(Value::String(wanted)) = reference.get("hash") else { return Err(format!("{key}: the reference has no string hash")) };
    if wanted != recorded {
        return Err(format!("{key}: the reference names hash {wanted}, the fixture entry is {recorded}"));
    }
    let mut out = definition.clone();
    match reference.get("override") {
        None => {}
        Some(Value::Object(over)) => {
            for (field, value) in over {
                out.insert(field.clone(), resolve(value, definitions)?);
            }
        }
        Some(other) => return Err(format!("{key}: override is an object, not {other}")),
    }
    match reference.get("unset") {
        None => {}
        Some(Value::Array(fields)) => {
            for field in fields {
                let Value::String(field) = field else { return Err(format!("{key}: unset names fields by string, not {field}")) };
                out.shift_remove(field.as_str());
            }
        }
        Some(other) => return Err(format!("{key}: unset is an array, not {other}")),
    }
    Ok(Value::Object(out))
}

/// `text` (a recorded golden) parsed, with every tool reference replaced by the definition it names.
pub fn parse_golden(text: &str) -> Result<Value, String> {
    let definitions = definitions()?;
    let golden: Value = serde_json::from_str(text).map_err(|error| format!("the golden does not parse: {error}"))?;
    resolve(&golden, &definitions)
}
#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn fixture() -> Value {
        serde_json::from_str(DEFINITIONS).expect("the shared definitions fixture")
    }

    /// The hash the JavaScript recorder took of each definition is the one this loader takes: the canonical JSON
    /// and the digest agree across the two languages.
    #[test]
    fn every_recorded_definition_hashes_to_its_recorded_hash() {
        let fixture = fixture();
        let definitions = fixture["definitions"].as_object().expect("definitions");
        assert!(definitions.len() > 50, "the fixture holds the product's tools");
        for (key, entry) in definitions {
            assert_eq!(content_hash(&entry["definition"]), entry["hash"].as_str().expect("hash"), "{key}");
        }
    }

    #[test]
    fn a_reference_resolves_to_its_definition_less_the_unset_fields_and_with_the_overridden_ones() {
        let fixture = fixture();
        let read = &fixture["definitions"]["read"];
        let hash = read["hash"].as_str().expect("hash");
        let golden = json!({ "plain": { "$tool": "read", "hash": hash }, "changed": [{ "$tool": "read", "hash": hash, "override": { "description": "Fresher.", "deferLoading": true }, "unset": ["annotations"] }] });
        let resolved = parse_golden(&golden.to_string()).expect("resolves");
        assert_eq!(resolved["plain"], read["definition"]);
        let changed = &resolved["changed"][0];
        assert_eq!((changed["description"].clone(), changed["deferLoading"].clone()), (json!("Fresher."), json!(true)));
        assert!(changed.get("annotations").is_none());
        assert_eq!(changed["inputSchema"], read["definition"]["inputSchema"]);
    }

    #[test]
    fn a_reference_that_is_not_in_the_fixture_or_names_another_hash_is_an_error() {
        let fixture = fixture();
        let hash = fixture["definitions"]["read"]["hash"].as_str().expect("hash");
        let unknown = parse_golden(&json!({ "$tool": "nope", "hash": hash }).to_string()).unwrap_err();
        assert!(unknown.contains("nope"), "{unknown}");
        let stale = parse_golden(&json!({ "$tool": "read", "hash": "0000000000000000" }).to_string()).unwrap_err();
        assert!(stale.contains("0000000000000000"), "{stale}");
        let variant = parse_golden(&json!({ "$tool": "git", "variant": "agent", "hash": fixture["definitions"]["git@agent"]["hash"] }).to_string()).expect("the agent's git");
        assert_eq!(variant["name"], "git");
    }

    /// JavaScript sorts keys by UTF-16 code unit: U+10000 (a surrogate pair, D800 DC00) before U+E000, the reverse of
    /// the UTF-8 byte order. The hash is the one `contentHash` of the recorder took of the same object.
    #[test]
    fn keys_sort_by_utf16_code_unit_as_javascript_sorts_them() {
        let value = json!({ "\u{10000}": 1, "\u{e000}": 2, "a": [true, null, "x"] });
        let mut text = String::new();
        canonical(&value, &mut text);
        assert_eq!(text, "{\"a\":[true,null,\"x\"],\"\u{10000}\":1,\"\u{e000}\":2}");
        assert_eq!(content_hash(&value), "8db78ec640aa52d6");
    }

    #[test]
    fn a_reference_with_an_empty_or_mistyped_field_is_an_error() {
        let hash = fixture()["definitions"]["read"]["hash"].clone();
        let bad = |reference: Value| parse_golden(&json!({ "x": reference }).to_string()).unwrap_err();
        assert!(bad(json!({ "$tool": "read", "variant": "", "hash": hash })).contains("non-empty"));
        assert!(bad(json!({ "$tool": "read", "variant": 3, "hash": hash })).contains("non-empty"));
        assert!(bad(json!({ "$tool": "read", "variant": null, "hash": hash })).contains("non-empty"));
        assert!(bad(json!({ "$tool": 7, "hash": hash })).contains("not a string"));
        assert!(bad(json!({ "$tool": "read", "hash": 5 })).contains("string hash"));
        assert!(bad(json!({ "$tool": "read", "hash": hash, "override": [] })).contains("override"));
        assert!(bad(json!({ "$tool": "read", "hash": hash, "unset": "annotations" })).contains("unset"));
        assert!(bad(json!({ "$tool": "read", "hash": hash, "unset": [1] })).contains("unset"));
    }

    #[test]
    fn a_definition_is_looked_up_by_name_or_name_and_variant() {
        assert_eq!(definition("task").expect("task")["name"], "task");
        assert_ne!(definition("task").expect("task"), definition("task@agent").expect("the agent's task"));
        assert!(definition("shell@").is_err() && definition("nope").is_err());
    }
}