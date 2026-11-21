use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

/// Object keys sorted by UTF-16 code unit, no whitespace: the text every
/// derived id is hashed from.
pub use mixdog_js::json_stringify_sorted as stable_stringify;

/// `gemini_` + first 16 hex digits of SHA-256 over the canonical text of
/// `{index, name, args}`.
pub fn synthesized_call_id(index: usize, name: &str, args: &Value) -> String {
    let basis = serde_json::json!({ "index": index, "name": name, "args": args });
    let digest = Sha256::digest(stable_stringify(&basis).as_bytes());
    let mut id = String::from("gemini_");
    for byte in digest.iter().take(8) {
        id.push_str(&format!("{byte:02x}"));
    }
    id
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keys_sort_and_integral_floats_print_as_integers() {
        let v = json!({"b": 1.0, "a": [true, null, "x\"y"]});
        assert_eq!(stable_stringify(&v), r#"{"a":[true,null,"x\"y"],"b":1}"#);
    }
}
