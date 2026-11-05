//! Tool-call ids at the wire (Node `providers/lib/tool-call-wire-ids.mjs`). A transcript keeps
//! each call's id as its provider minted it; a wire that refuses it gets a deterministic,
//! collision-free stand-in instead. A valid id passes unchanged, a call and its result map to
//! the same value, and a stand-in is itself valid, so projecting twice changes nothing.

use std::collections::HashMap;
use std::collections::HashSet;

use sha2::Digest;
use sha2::Sha256;

/// A wire's id rule: `[A-Za-z0-9<extra>]`, 1 to `max_len` characters.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct IdRule {
    pub max_len: usize,
    pub extra: &'static [u8],
}

/// `ANTHROPIC_TOOL_CALL_IDS`.
pub const ANTHROPIC_IDS: IdRule = IdRule { max_len: 64, extra: b"_-" };
/// `OPENAI_RESPONSES_TOOL_CALL_IDS`.
pub const OPENAI_RESPONSES_IDS: IdRule = IdRule { max_len: 64, extra: b"_.:-" };
/// `OPENAI_CHAT_TOOL_CALL_IDS`.
pub const OPENAI_CHAT_IDS: IdRule = IdRule { max_len: 40, extra: b"_.:-" };

const HASH_CHARS: usize = 10;

impl IdRule {
    pub fn is_valid(self, id: &str) -> bool {
        !id.is_empty()
            && id.len() <= self.max_len
            && id.bytes().all(|b| b.is_ascii_alphanumeric() || self.extra.contains(&b))
    }

    /// `standIn(id, rule, salt)`.
    fn stand_in(self, id: &str, salt: u32) -> String {
        let digest = Sha256::digest(format!("{salt}\u{0}{id}").as_bytes());
        let hash: String = digest.iter().map(|b| format!("{b:02x}")).collect::<String>()[..HASH_CHARS].to_owned();
        let mut stem = String::new();
        let mut in_run = false;
        for c in id.chars() {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                stem.push(c);
                in_run = false;
            } else if !in_run {
                stem.push('_');
                in_run = true;
            }
        }
        let stem: String = stem
            .trim_matches('_')
            .chars()
            .take(self.max_len.saturating_sub(HASH_CHARS + 1))
            .collect();
        if stem.is_empty() {
            format!("call_{hash}").chars().take(self.max_len).collect()
        } else {
            format!("{stem}_{hash}")
        }
    }
}

/// `toolCallWireIdMap`: the stand-in of every id `rule` refuses, for the call and result ids
/// of one request in message order (a stand-in never takes a valid id of the same request).
pub fn wire_id_map<'a>(ids: impl IntoIterator<Item = &'a str>, rule: IdRule) -> HashMap<String, String> {
    let mut seen = HashSet::new();
    let ids: Vec<&str> = ids.into_iter().filter(|id| !id.is_empty() && seen.insert(*id)).collect();
    let mut taken: HashSet<String> = ids.iter().filter(|id| rule.is_valid(id)).map(|id| (*id).to_owned()).collect();
    let mut map = HashMap::new();
    for id in ids {
        if rule.is_valid(id) {
            continue;
        }
        let mut salt = 0;
        let mut wire = rule.stand_in(id, salt);
        while taken.contains(&wire) {
            salt += 1;
            wire = rule.stand_in(id, salt);
        }
        taken.insert(wire.clone());
        map.insert(id.to_owned(), wire);
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Node's message path (`withWireToolCallIds` under `OPENAI_RESPONSES_TOOL_CALL_IDS`).
    #[test]
    fn refused_ids_get_nodes_stand_ins_and_valid_ids_pass() {
        let long = format!("call_{}", "x".repeat(80));
        let map = wire_id_map([long.as_str(), "functions.read/0", "call_ok", "call_ok"], OPENAI_RESPONSES_IDS);
        assert_eq!(map.len(), 2);
        assert_eq!(map[&long], format!("call_{}_7a42f34ffd", "x".repeat(48)));
        assert_eq!(map["functions.read/0"], "functions_read_0_cf21bf139e");
        for wire in map.values() {
            assert!(wire_id_map([wire.as_str()], OPENAI_RESPONSES_IDS).is_empty());
        }
    }
}
