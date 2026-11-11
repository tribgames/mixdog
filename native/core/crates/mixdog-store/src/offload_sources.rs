//! A session's reference set (`offloadSources`, a header field): the sessions whose tool-result sidecars its
//! transcript may name, by their path segment (`tool-results/<segment>/`), its own left out. A copy of a conversation
//! (an inheritance's heir, a clear's fork) is given its source's set and its source when it is made, so a copy of a
//! copy names the first source directly; while the copy is being made its header names the source it copies
//! (`offloadInheriting`, with the [`boot`] of the process making it: a mark another boot left is not a copy in
//! progress, as one process owns the data dir at a time). Every session this core creates holds a set from its first
//! record (an empty one); a session Node stored without a set (a version before the prune-after-save fix: a clear's
//! fork there names no source) gets the set its transcript names when it is migrated ([`stamp`]). A session that holds
//! none all the same (an older core build's), or one computed under earlier [`RULES`], is unknown, not empty: its
//! transcript is scanned before any prune that could delete what it names. The index holds every set
//! (`offload_refs`), so the sessions naming a session are one read.

use serde_json::Map;
use serde_json::Value;

/// The header field holding the set.
pub const SOURCES: &str = "offloadSources";
/// The header field naming the session a copy is still being made from.
pub const INHERITING: &str = "offloadInheriting";
/// The header field naming the [`boot`] of the process making that copy.
pub const INHERITING_BOOT: &str = "offloadInheritingBoot";
/// The header field naming the [`RULES`] the set was computed under.
pub const SOURCES_RULES: &str = "offloadSourcesRules";
/// The rules a set is computed under: what a transcript names ([`named_in`]) and how segments compare
/// ([`segment_key`]). A set stored under other rules, or none (one written before they were numbered: 1 matched case
/// everywhere), counts as unknown: it is computed again from the transcript, the stored one kept with it (a set only
/// grows). A change to either function is a new number, and a new row of the pinned fingerprints (`tests`), as Node's
/// `OFFLOAD_SOURCES_RULES`.
pub const RULES: i64 = 2;
/// Where [`segment_key`] folds letter case (rules 2).
const FOLDS_ON_WINDOWS: bool = true;
const FOLDS_ELSEWHERE: bool = false;
const FOLDS: bool = if cfg!(windows) { FOLDS_ON_WINDOWS } else { FOLDS_ELSEWHERE };

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
    key_as(segment, FOLDS)
}

fn key_as(segment: &str, fold: bool) -> String {
    if fold { segment.to_lowercase() } else { segment.to_owned() }
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
    named_as(text, FOLDS)
}

fn named_as(text: &str, fold: bool) -> std::collections::BTreeSet<String> {
    const NEEDLE: &str = "tool-results";
    let text = &key_as(text, fold);
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
/// holds under the present rules (a session Node with the fix stored), else what its transcript names (Node's
/// `withOffloadSources`) with any set held under earlier rules, empty when they name none.
pub fn stamp(header: &mut Map<String, Value>, id: &str, messages: &[Value]) {
    if holds_set(header) {
        return;
    }
    let mut sources: std::collections::BTreeSet<String> = sources(header).into_iter().collect();
    sources.extend(transcript_sources(named_in(&serde_json::to_string(messages).unwrap_or_default()), id));
    set_sources(header, sources.into_iter().collect());
}

/// `header` holds `sources` as its set, computed under the present [`RULES`].
pub fn set_sources(header: &mut Map<String, Value>, sources: Vec<String>) {
    header.insert(SOURCES.into(), Value::Array(sources.into_iter().map(Value::String).collect()));
    header.insert(SOURCES_RULES.into(), Value::from(RULES));
}

/// `named` (a transcript's [`named_in`]) without the session `id`'s own segment.
pub fn transcript_sources(mut named: std::collections::BTreeSet<String>, id: &str) -> Vec<String> {
    named.remove(&segment_key(&safe_segment(id)));
    named.into_iter().collect()
}

/// Whether `header` holds a set (an empty one included) computed under the present [`RULES`]: a session holding none,
/// or one computed under other rules, is unknown.
pub fn holds_set(header: &Map<String, Value>) -> bool {
    header.get(SOURCES).is_some_and(Value::is_array) && header.get(SOURCES_RULES).and_then(Value::as_i64) == Some(RULES)
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
        let mut kept = json!({ "offloadSources": [], "offloadSourcesRules": RULES }).as_object().cloned().expect("object");
        stamp(&mut kept, "sess_z", &[json!({"role": "user", "content": text})]);
        assert_eq!(kept[SOURCES], json!([]), "the set a record holds under the present rules is kept");
        let mut earlier = json!({ "offloadSources": ["sess_q"] }).as_object().cloned().expect("object");
        stamp(&mut earlier, "sess_z", &[json!({"role": "user", "content": text})]);
        assert_eq!(earlier[SOURCES], json!(["sess-b", "sess_a", "sess_q", "tool-results"]), "a set of earlier rules is computed again, and kept with it");
        assert_eq!(earlier[SOURCES_RULES], json!(RULES));
    }

    /// The rules' fingerprint (`RULES`): what [`named_as`] and [`key_as`] give for a pinned corpus, folding and not,
    /// and where [`segment_key`] folds, hashed (FNV-1a 64 over the lines) as Node's test hashes the same corpus. A
    /// change to either function or to where it folds changes the fingerprint: it is a new rules number with its own
    /// row, never an edited row (the sets stored under the old number are then computed again).
    #[test]
    fn the_reference_rules_are_pinned_to_their_number() {
        const PINNED: [(i64, &str); 2] = [(1, "7293f3f82a8e52b6"), (2, "dd4890f63f642197")];
        const CORPUS: [&str; 10] = [
            "see C:\\data\\tool-results\\sess_a\\x.txt",
            "/d/tool-results//sess-b/y.txt",
            "tool-results/sess c/z",
            "tool-results/tool-results/sess_d/w",
            "C:\\DATA\\TOOL-RESULTS\\SESS_A\\AB.TXT",
            "Tool-Results/Mixed_Case-1/f.txt and tool-results/sess_e",
            "tool-results\\\\sess_f\\\\g.txt",
            "no reference here",
            "tool-results/",
            "xtool-results/sess_g/h",
        ];
        const IDS: [&str; 3] = ["sess_a", "SESS_A", "Mixed_Case-1"];
        let mut lines = String::new();
        for fold in [false, true] {
            for (index, text) in CORPUS.iter().enumerate() {
                lines += &format!("{index}|{}|{}\n", u8::from(fold), named_as(text, fold).into_iter().collect::<Vec<_>>().join(","));
            }
            for id in IDS {
                lines += &format!("k|{}|{}\n", u8::from(fold), key_as(id, fold));
            }
        }
        lines += &format!("folds|{FOLDS_ON_WINDOWS}|{FOLDS_ELSEWHERE}\n");
        let hash = lines.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3));
        assert_eq!(PINNED.last().map(|(rules, _)| *rules), Some(RULES), "the last pinned row is the present rules");
        assert_eq!(PINNED.iter().map(|(rules, _)| *rules).collect::<Vec<_>>(), (1..=RULES).collect::<Vec<_>>(), "one row per rules number");
        assert_eq!(format!("{hash:016x}"), PINNED[PINNED.len() - 1].1, "the rules changed: give them a new number and a new row\n{lines}");
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
