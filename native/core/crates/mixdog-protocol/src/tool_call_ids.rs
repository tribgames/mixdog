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
        !id.is_empty() && id.len() <= self.max_len && id.bytes().all(|b| b.is_ascii_alphanumeric() || self.extra.contains(&b))
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
        let stem: String = stem.trim_matches('_').chars().take(self.max_len.saturating_sub(HASH_CHARS + 1)).collect();
        if stem.is_empty() { format!("call_{hash}").chars().take(self.max_len).collect() } else { format!("{stem}_{hash}") }
    }
}

/// What separates a provider's id from what a session adds to it ([`distinct_id`]). No wire's id rule admits it, so an
/// id that holds it never reaches a provider as it is.
const DISTINCT_MARK: char = '~';

/// The header key a session keeps its call epoch under ([`distinct_id`]).
pub const CALL_EPOCH_KEY: &str = "callEpoch";

/// The id of a call that enters a session, of the one `provider_id` its provider gave: a session holds no two calls of
/// one id (`mixdog_agent::repair::ToolCallIds`), though a provider may give two the same. `epoch` counts the times
/// calls have left the session's model context (a compaction, a rewind): the calls still in the context are known and
/// those that left are not, so an id says which epoch its call entered in and can equal none of an earlier one. `n` is
/// the call's number among those of its epoch under that provider id, from 1.
///
/// The provider's text and what the session adds are told apart by construction: every mark in the provider's text is
/// written twice, and a single mark begins the session's part, `<epoch>` or `<epoch>.<n>` (none for the first call of
/// epoch 0). So no provider id, whatever it looks like, reads as carrying an epoch, and two different provider ids
/// give different ids at every epoch.
pub fn distinct_id(provider_id: &str, epoch: u64, n: u32) -> String {
    let mark = DISTINCT_MARK;
    let provider = if provider_id.contains(mark) { provider_id.replace(mark, "~~") } else { provider_id.to_owned() };
    match (epoch, n) {
        (0, 1) => provider,
        (_, 1) => format!("{provider}{mark}{epoch}"),
        _ => format!("{provider}{mark}{epoch}.{n}"),
    }
}

/// `id` as (the id its provider gave, the epoch its call entered in), [`distinct_id`] read back. An id that is no
/// [`distinct_id`] (a single mark not followed by an epoch to its end: a row an earlier build stored) is its provider's
/// text as it stands, at epoch 0.
fn parts(id: &str) -> (std::borrow::Cow<'_, str>, u64) {
    use std::borrow::Cow;
    if !id.contains(DISTINCT_MARK) {
        return (Cow::Borrowed(id), 0);
    }
    let mut provider = String::with_capacity(id.len());
    let mut chars = id.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        if c != DISTINCT_MARK {
            provider.push(c);
        } else if chars.next_if(|(_, next)| *next == DISTINCT_MARK).is_some() {
            provider.push(DISTINCT_MARK);
        } else {
            let tail = &id[at + DISTINCT_MARK.len_utf8()..];
            let (epoch, n) = tail.split_once('.').unwrap_or((tail, "1"));
            let digits = |text: &str| !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit());
            return match epoch.parse() {
                Ok(number) if !provider.is_empty() && digits(epoch) && digits(n) => (Cow::Owned(provider), number),
                _ => (Cow::Borrowed(id), 0),
            };
        }
    }
    (Cow::Owned(provider), 0)
}

/// The id the provider gave the call `id` names.
pub fn provider_id(id: &str) -> std::borrow::Cow<'_, str> {
    parts(id).0
}

/// The epoch the call `id` names entered its session in.
pub fn epoch_of(id: &str) -> u64 {
    parts(id).1
}

/// `toolCallWireIdMap`: the stand-in of every id `rule` refuses, for the call and result ids
/// of one request in message order (a stand-in never takes a valid id of the same request). A call whose id is not
/// its provider's as it came ([`distinct_id`]) goes out under that provider's id when no other call of the request has
/// it: the provider is answered under the id it gave, and one that holds its calls by id is given its own.
pub fn wire_id_map<'a>(ids: impl IntoIterator<Item = &'a str>, rule: IdRule) -> HashMap<String, String> {
    let mut seen = HashSet::new();
    let ids: Vec<&str> = ids.into_iter().filter(|id| !id.is_empty() && seen.insert(*id)).collect();
    let mut taken: HashSet<String> = ids.iter().filter(|id| rule.is_valid(id)).map(|id| (*id).to_owned()).collect();
    let mut map = HashMap::new();
    for id in ids {
        if rule.is_valid(id) {
            continue;
        }
        let own = provider_id(id);
        if own != id && rule.is_valid(&own) && taken.insert(own.to_string()) {
            map.insert(id.to_owned(), own.into_owned());
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

    /// A call whose id is not its provider's as it came is sent under the provider's id while it is the only call of the
    /// request with it, and under a stand-in beside another; its result goes with it either way.
    #[test]
    fn a_call_made_distinct_goes_out_under_its_providers_id_unless_another_call_of_the_request_has_it() {
        assert_eq!(
            (distinct_id("call_0", 0, 1), distinct_id("call_0", 3, 1), distinct_id("call_0", 0, 2), distinct_id("call_0", 3, 2)),
            ("call_0".to_owned(), "call_0~3".to_owned(), "call_0~0.2".to_owned(), "call_0~3.2".to_owned())
        );
        for (id, provider, epoch) in [("call_0~3", "call_0", 3), ("call_0~0.2", "call_0", 0), ("call_0~3.2", "call_0", 3), ("call_0", "call_0", 0)] {
            assert_eq!((provider_id(id).as_ref(), epoch_of(id)), (provider, epoch), "{id}");
        }
        for id in ["a~b", "~3", "a~3.", "a~.2", "a~3.x"] {
            assert_eq!((provider_id(id).as_ref(), epoch_of(id)), (id, 0), "{id} is no id made here");
        }
        let alone = wire_id_map(["call_0~2", "call_0~2", "toolu_A"], ANTHROPIC_IDS);
        assert_eq!(alone, HashMap::from([("call_0~2".to_owned(), "call_0".to_owned())]));
        let beside = wire_id_map(["call_0", "call_0~2", "call_0~2.2"], OPENAI_CHAT_IDS);
        assert_eq!(beside.len(), 2, "{beside:?}");
        let wires: HashSet<&str> = beside.values().map(String::as_str).chain(["call_0"]).collect();
        assert_eq!(wires.len(), 3, "three calls, three ids on the wire: {beside:?}");
        assert!(beside.values().all(|wire| OPENAI_CHAT_IDS.is_valid(wire)));
        // The first of two that are not under the provider's id takes it once the earlier holder has left the request.
        let later = wire_id_map(["call_0~2", "call_0~2.2"], OPENAI_CHAT_IDS);
        assert_eq!(later["call_0~2"], "call_0");
        assert!(later["call_0~2.2"] != "call_0" && OPENAI_CHAT_IDS.is_valid(&later["call_0~2.2"]));
    }

    /// A server may issue an id that looks like one a session made (`c~1`). Stored, its text is told from what the
    /// session adds: it reads back whole at the epoch it entered in, it is not the id of a call `c` at epoch 1, and at a
    /// later epoch it is again its own.
    #[test]
    fn a_providers_id_that_holds_the_mark_never_reads_as_carrying_an_epoch() {
        for provider in ["c~1", "c~1.2", "c~", "~", "~~", "a~~b~3", "c~0", "한~1"] {
            for (epoch, n) in [(0, 1), (0, 2), (1, 1), (7, 3)] {
                let id = distinct_id(provider, epoch, n);
                assert_eq!((provider_id(&id).as_ref(), epoch_of(&id)), (provider, epoch), "{provider} at {epoch}.{n} is stored as {id}");
            }
        }
        assert_eq!(distinct_id("c~1", 0, 1), "c~~1");
        assert_ne!(distinct_id("c~1", 0, 1), distinct_id("c", 1, 1), "a server's `c~1` is not the session's id of `c` at epoch 1");
        let ids = [distinct_id("c", 0, 1), distinct_id("c~1", 0, 1), distinct_id("c", 1, 1), distinct_id("c~1", 2, 1), distinct_id("c~1~2", 0, 1)];
        assert_eq!(ids.iter().collect::<HashSet<_>>().len(), ids.len(), "{ids:?}");
        // On a wire with an id rule the server's own `c~1` is refused as it is, so it goes out under a stand-in, and no
        // two calls of the request share an id.
        let wire = wire_id_map(ids.iter().map(String::as_str), OPENAI_CHAT_IDS);
        let sent: HashSet<&str> = ids.iter().map(|id| wire.get(id).map_or(id.as_str(), String::as_str)).collect();
        assert_eq!(sent.len(), ids.len(), "{wire:?}");
        assert!(sent.iter().all(|id| OPENAI_CHAT_IDS.is_valid(id)), "{sent:?}");
    }

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
