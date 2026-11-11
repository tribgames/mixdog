//! A session's reference set (`offloadSources`, a header field): the sessions whose tool-result sidecars its
//! transcript may name, by their path segment (`tool-results/<segment>/`), its own left out. A copy of a conversation
//! (an inheritance's heir, a clear's fork) is given its source's set and its source when it is made, so a copy of a
//! copy names the first source directly; while the copy is being made its header names the source it copies
//! (`offloadInheriting`). A session Node stored without a set (a version before the prune-after-save fix: a clear's
//! fork there names no source) gets the set its transcript names when it is migrated ([`stamp`]). The index holds every
//! set (`offload_refs`), so the sessions naming a session are one read.

use serde_json::Map;
use serde_json::Value;

/// The header field holding the set.
pub const SOURCES: &str = "offloadSources";
/// The header field naming the session a copy is still being made from.
pub const INHERITING: &str = "offloadInheriting";

/// Session ids are path segments: anything outside `[A-Za-z0-9_-]` becomes `_`, so a `..` or a slash cannot leave the
/// tool-results root (Node's `safeSessionSegment`).
pub fn safe_segment(session_id: &str) -> String {
    let cleaned: String = session_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .take(200)
        .collect();
    if cleaned.is_empty() { "_invalid".to_owned() } else { cleaned }
}

fn separator(byte: u8) -> bool {
    byte == b'/' || byte == b'\\'
}

/// The segments `text` names as `tool-results/<segment>/` (either separator, any number of them): Node's
/// `/tool-results[\\/]+([A-Za-z0-9_-]+)[\\/]/g` over the same text.
pub fn named_in(text: &str) -> std::collections::BTreeSet<String> {
    const NEEDLE: &str = "tool-results";
    let bytes = text.as_bytes();
    let mut named = std::collections::BTreeSet::new();
    let mut at = 0;
    while let Some(found) = text[at..].find(NEEDLE) {
        let start = at + found;
        let mut i = start + NEEDLE.len();
        let separators = i;
        while i < bytes.len() && separator(bytes[i]) {
            i += 1;
        }
        let segment = i;
        while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] == b'-') {
            i += 1;
        }
        if segment > separators && i > segment && i < bytes.len() && separator(bytes[i]) {
            named.insert(text[segment..i].to_owned());
            at = i + 1;
        } else {
            at = start + 1;
        }
    }
    named
}

/// The set a session `id` of `messages` (its whole transcript, system messages included) is migrated with: the one its
/// header holds (a session Node with the fix stored), else what its transcript names; written only when it names any.
pub fn stamp(header: &mut Map<String, Value>, id: &str, messages: &[Value]) {
    if header.get(SOURCES).is_some_and(Value::is_array) {
        return;
    }
    let mut named = named_in(&serde_json::to_string(messages).unwrap_or_default());
    named.remove(&safe_segment(id));
    if !named.is_empty() {
        header.insert(SOURCES.into(), Value::Array(named.into_iter().map(Value::String).collect()));
    }
}

/// The set `header` holds.
pub fn sources(header: &Map<String, Value>) -> Vec<String> {
    header.get(SOURCES).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned).collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_segments_named_are_nodes_matches_either_separator_its_own_left_out() {
        let text = r#"see C:\\data\\tool-results\\sess_a\\x.txt, /d/tool-results//sess-b/y.txt, tool-results/sess c/z, tool-results/tool-results/sess_d/w"#;
        assert_eq!(named_in(text).into_iter().collect::<Vec<_>>(), ["sess-b", "sess_a", "tool-results"]);
        let mut header = Map::new();
        stamp(&mut header, "sess_a", &[json!({"role": "system", "content": text})]);
        assert_eq!(header[SOURCES], json!(["sess-b", "tool-results"]));
        let mut own = Map::new();
        stamp(&mut own, "sess_a", &[json!({"role": "user", "content": r"tool-results/sess_a/x.txt"})]);
        assert!(own.is_empty(), "a session naming only its own sidecars gets no set");
        let mut kept = json!({ "offloadSources": [] }).as_object().cloned().expect("object");
        stamp(&mut kept, "sess_z", &[json!({"role": "user", "content": text})]);
        assert_eq!(kept[SOURCES], json!([]), "the set a record holds is kept");
    }
}
