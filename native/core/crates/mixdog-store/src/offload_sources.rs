//! A session's reference set (`offloadSources`, a header field): the sessions whose tool-result sidecars its
//! transcript may name, by their path segment (`tool-results/<segment>/`), its own left out. A copy of a conversation
//! (an inheritance's heir, a clear's fork) is given its source's set and its source when it is made, so a copy of a
//! copy names the first source directly; while the copy is being made its header names the source it copies
//! (`offloadInheriting`, with the [`boot`] of the process making it: a mark another boot left is not a copy in
//! progress, as one process owns the data dir at a time). Every session this core creates holds a set from its first
//! record (an empty one); a session Node stored without a set (a version before the prune-after-save fix: a clear's
//! fork there names no source) gets the set its transcript names when it is migrated ([`stamp`]). A session that holds
//! none all the same (an older core build's) is unknown, not empty: its transcript is scanned before any prune that
//! could delete what it names. The index holds every set (`offload_refs`), so the sessions naming a session are one
//! read.

use serde_json::Map;
use serde_json::Value;

/// The header field holding the set.
pub const SOURCES: &str = "offloadSources";
/// The header field naming the session a copy is still being made from.
pub const INHERITING: &str = "offloadInheriting";
/// The header field naming the [`boot`] of the process making that copy.
pub const INHERITING_BOOT: &str = "offloadInheritingBoot";

/// This process's boot: the marks it writes name it.
pub fn boot() -> &'static str {
    static BOOT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    BOOT.get_or_init(|| {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_nanos());
        format!("{}-{nanos}", std::process::id())
    })
}

/// A segment as the file system compares directory names: a reference is text anyone may write (a model quoting a
/// path, a user pasting one), so on Windows, where a directory is the same in any letter case, segments compare
/// case-insensitively (as the prune's own sidecar match folds its text there, `artifact.rs` `unkept`).
pub fn segment_key(segment: &str) -> String {
    if cfg!(windows) { segment.to_lowercase() } else { segment.to_owned() }
}

/// The copy mark `header` holds: the session copied and the boot of the process copying it.
pub fn mark(header: &Map<String, Value>) -> Option<(String, String)> {
    let source = header.get(INHERITING).and_then(Value::as_str).filter(|source| !source.is_empty())?;
    let boot = header.get(INHERITING_BOOT).and_then(Value::as_str).unwrap_or_default();
    Some((source.to_owned(), boot.to_owned()))
}

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

/// The segments `text` names as `tool-results/<segment>/` (either separator, any number of them), by
/// [`segment_key`]: Node's `/tool-results[\\/]+([A-Za-z0-9_-]+)[\\/]/g` over `segmentKey(text)`.
pub fn named_in(text: &str) -> std::collections::BTreeSet<String> {
    const NEEDLE: &str = "tool-results";
    let text = &segment_key(text);
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

/// The set a session `id` of `messages` (its whole transcript, system messages included) holds: the one its header
/// holds (a session Node with the fix stored), else what its transcript names (Node's `withOffloadSources`), empty
/// when it names none.
pub fn stamp(header: &mut Map<String, Value>, id: &str, messages: &[Value]) {
    if header.get(SOURCES).is_some_and(Value::is_array) {
        return;
    }
    let named = named_in(&serde_json::to_string(messages).unwrap_or_default());
    header.insert(SOURCES.into(), Value::Array(transcript_sources(named, id).into_iter().map(Value::String).collect()));
}

/// `named` (a transcript's [`named_in`]) without the session `id`'s own segment.
pub fn transcript_sources(mut named: std::collections::BTreeSet<String>, id: &str) -> Vec<String> {
    named.remove(&segment_key(&safe_segment(id)));
    named.into_iter().collect()
}

/// Whether `header` holds a set (an empty one included): a session holding none is unknown.
pub fn holds_set(header: &Map<String, Value>) -> bool {
    header.get(SOURCES).is_some_and(Value::is_array)
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
        assert_eq!(own[SOURCES], json!([]), "a session naming only its own sidecars gets an empty set, not none");
        let mut kept = json!({ "offloadSources": [] }).as_object().cloned().expect("object");
        stamp(&mut kept, "sess_z", &[json!({"role": "user", "content": text})]);
        assert_eq!(kept[SOURCES], json!([]), "the set a record holds is kept");
    }

    /// A reference in another letter case names the same session where the file system ignores case (Windows), and a
    /// different one elsewhere.
    #[test]
    fn a_reference_in_another_letter_case_names_the_session_as_the_file_system_does() {
        let named = named_in(r"see C:\\DATA\\TOOL-RESULTS\\SESS_A\\AB.TXT");
        let own = |id: &str| transcript_sources(named.clone(), id);
        if cfg!(windows) {
            assert_eq!(named.iter().collect::<Vec<_>>(), ["sess_a"]);
            assert_eq!(own("sess_a"), Vec::<String>::new(), "its own sidecars, in any case");
            assert_eq!(segment_key("Sess_A"), segment_key("sess_a"));
        } else {
            assert!(named.is_empty(), "`tool-results` is another directory than `TOOL-RESULTS`");
            assert_ne!(segment_key("Sess_A"), segment_key("sess_a"));
        }
    }
}
