//! The loader of the tool references recorded goldens carry. A golden does not inline a real tool definition:
//! it holds `{"$tool": name, "variant"?: v, "hash": h, "override"?: {..}, "unset"?: [..]}` where one would be, and
//! the definitions are recorded once in `fixtures/tool-definitions/definitions.json` (keyed `name` or
//! `name@variant`, each with the content hash of its canonical JSON). [`parse_golden`] resolves a golden's
//! references: the entry must exist, hash to the hash it records, and match the hash the reference names; then
//! the overridden fields are laid over a copy of it and the unset ones dropped.
//!
//! The hash is the first 16 hex digits of the sha-256 of the canonical JSON (every object's keys sorted, no
//! whitespace), the text `contentHash` of `benchmarks/rust-core/recorders/lib/tool-definitions.mjs` hashes.

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
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
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
fn resolve(node: &Value, definitions: &Map<String, Value>) -> Result<Value, String> {
    match node {
        Value::Array(items) => items.iter().map(|item| resolve(item, definitions)).collect::<Result<Vec<_>, _>>().map(Value::Array),
        Value::Object(map) => match map.get("$tool").and_then(Value::as_str) {
            Some(name) => resolve_reference(name, map, definitions),
            None => map.iter().map(|(key, child)| resolve(child, definitions).map(|child| (key.clone(), child))).collect::<Result<Map<_, _>, _>>().map(Value::Object),
        },
        other => Ok(other.clone()),
    }
}

fn resolve_reference(name: &str, reference: &Map<String, Value>, definitions: &Map<String, Value>) -> Result<Value, String> {
    let key = match reference.get("variant").and_then(Value::as_str) {
        Some(variant) => format!("{name}@{variant}"),
        None => name.to_owned(),
    };
    let entry = definitions.get(&key).ok_or_else(|| format!("the tool reference {key} is not in the shared definitions fixture"))?;
    let definition = entry.get("definition").ok_or_else(|| format!("{key}: the fixture entry has no definition"))?;
    let recorded = entry.get("hash").and_then(Value::as_str).unwrap_or_default();
    let actual = content_hash(definition);
    if actual != recorded {
        return Err(format!("{key}: the fixture entry hashes to {actual}, not the {recorded} it records"));
    }
    let wanted = reference.get("hash").and_then(Value::as_str).unwrap_or_default();
    if wanted != recorded {
        return Err(format!("{key}: the reference names hash {wanted}, the fixture entry is {recorded}"));
    }
    let Value::Object(fields) = definition else { return Err(format!("{key}: the fixture definition is not an object")) };
    let mut out = fields.clone();
    if let Some(Value::Object(over)) = reference.get("override") {
        for (field, value) in over {
            out.insert(field.clone(), resolve(value, definitions)?);
        }
    }
    for field in reference.get("unset").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
        out.shift_remove(field);
    }
    Ok(Value::Object(out))
}

/// `text` (a recorded golden) parsed, with every tool reference replaced by the definition it names.
pub fn parse_golden(text: &str) -> Result<Value, String> {
    let fixture: Value = serde_json::from_str(DEFINITIONS).map_err(|error| format!("the shared definitions fixture does not parse: {error}"))?;
    let definitions = fixture.get("definitions").and_then(Value::as_object).ok_or("the shared definitions fixture has no definitions")?;
    let golden: Value = serde_json::from_str(text).map_err(|error| format!("the golden does not parse: {error}"))?;
    resolve(&golden, definitions)
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
}