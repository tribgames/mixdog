//! Room settings and the pure text rules of a room: addressing (`/ask`, `@Name`), passing and the
//! message budget.

use std::sync::LazyLock;

use mixdog_js::{JsRegex, cut_utf16, is_js_space, js_trim, js_trim_start, js_words, slice_utf16, utf16_len};
use serde::{Deserialize, Serialize};

use super::RoomError;
use super::ids::agent_home_session_id;

pub const ROOM_MIN_MEMBERS: usize = 2;
pub const ROOM_MAX_MEMBERS: usize = 6;
/// The longest supervisor note a member's turn carries.
pub const ROOM_INSTRUCTION_LIMIT: usize = 200;
/// `meta.source` of every row stored in a room's log.
pub const ROOM_ROW_SOURCE: &str = "agent-room";
const ROOM_PASS_REPLY: &str = "(pass)";
const NAME_LIMIT: usize = 80;

struct Limit {
    min: i64,
    max: i64,
    default: i64,
}
const MAX_ROUNDS: Limit = Limit { min: 1, max: 10, default: 3 };
const MAX_MESSAGES: Limit = Limit { min: 1, max: 30, default: 8 };

fn clamp(limit: &Limit, value: Option<f64>) -> u32 {
    match value.map(f64::round) {
        Some(n) if n.is_finite() => (n as i64).clamp(limit.min, limit.max) as u32,
        _ => limit.default as u32,
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomConfig {
    pub name: String,
    pub members: Vec<String>,
    pub max_rounds: u32,
    pub max_messages: u32,
    pub share_tools: bool,
}

/// A room's settings as given by a client; absent limits take their defaults.
#[derive(Clone, Debug, Default)]
pub struct RoomConfigInput {
    pub name: String,
    pub members: Vec<String>,
    pub max_rounds: Option<f64>,
    pub max_messages: Option<f64>,
    pub share_tools: bool,
}

/// A room's settings in canonical shape. Members keep the order given, each once.
pub fn normalize_room_config(input: &RoomConfigInput) -> Result<RoomConfig, RoomError> {
    let name = slice_utf16(&js_words(&input.name).collect::<Vec<_>>().join(" "), NAME_LIMIT);
    if name.is_empty() {
        return Err(RoomError::Invalid("A room needs a name.".into()));
    }
    let mut members: Vec<String> = Vec::new();
    for id in &input.members {
        if agent_home_session_id(id).is_some() && !members.contains(id) {
            members.push(id.clone());
        }
    }
    if !(ROOM_MIN_MEMBERS..=ROOM_MAX_MEMBERS).contains(&members.len()) {
        return Err(RoomError::Invalid(format!("A room has {ROOM_MIN_MEMBERS} to {ROOM_MAX_MEMBERS} members.")));
    }
    Ok(RoomConfig {
        name,
        members,
        max_rounds: clamp(&MAX_ROUNDS, input.max_rounds),
        max_messages: clamp(&MAX_MESSAGES, input.max_messages),
        share_tools: input.share_tools,
    })
}

/// A member as the text rules see it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemberName {
    pub id: String,
    pub name: String,
}

/// The member `text` starts with, by id or name, when the character after it passes `boundary`
/// (or the text ends). The longest label wins ("Bench" never shadows "Bench lead"); two members
/// sharing that label match neither. Lengths are UTF-16 units (JS `length`); `boundary` sees the
/// unit that follows the label in `text`.
fn member_at(text: &str, members: &[MemberName], boundary: impl Fn(u16) -> bool) -> Option<(String, usize)> {
    let lower: Vec<u16> = text.to_lowercase().encode_utf16().collect();
    let original: Vec<u16> = text.encode_utf16().collect();
    let mut best: Option<(&str, usize)> = None;
    let mut tie = false;
    for member in members {
        for label in [member.id.as_str(), member.name.as_str()] {
            let label: Vec<u16> = label.to_lowercase().encode_utf16().collect();
            if label.is_empty() || !lower.starts_with(&label) {
                continue;
            }
            if original.len() > label.len() && !boundary(original[label.len()]) {
                continue;
            }
            match best {
                Some((_, length)) if label.len() < length => {}
                Some((id, length)) if label.len() == length => {
                    if member.id != id {
                        tie = true;
                    }
                }
                _ => {
                    best = Some((member.id.as_str(), label.len()));
                    tie = false;
                }
            }
        }
    }
    if tie { None } else { best.map(|(id, length)| (id.to_owned(), length)) }
}

/// The member `value` names exactly (id or display name, any case); `None` for none or for a name
/// two members share.
pub fn room_member_named(value: &str, members: &[MemberName]) -> Option<String> {
    let text = js_trim(value);
    if text.is_empty() {
        return None;
    }
    member_at(text, members, |_| false).map(|(id, _)| id)
}

fn unit_is(unit: u16, test: impl Fn(char) -> bool) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(test)
}

/// `text.slice(units)`.
fn after_units(text: &str, units: usize) -> &str {
    &text[cut_utf16(text, units).head.len()..]
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AskError {
    /// No such member.
    Member,
    /// Nothing to ask.
    Message,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedAsk {
    /// Ordered member ids; empty for the whole room.
    pub to: Vec<String>,
    pub text: String,
    pub error: Option<AskError>,
}

/// A user message to the room: `/ask <agent>[, <agent>…] <message>` addresses those members, in
/// that order, by id or by name.
pub fn parse_room_ask(text: &str, members: &[MemberName]) -> ParsedAsk {
    let raw = js_trim(text);
    let is_ask = raw.get(..4).is_some_and(|head| head.eq_ignore_ascii_case("/ask"))
        && raw[4..].chars().next().is_none_or(is_js_space);
    if !is_ask {
        return ParsedAsk { to: vec![], text: raw.to_owned(), error: None };
    }
    let mut rest = js_trim_start(&raw[4..]).to_owned();
    let mut to: Vec<String> = Vec::new();
    loop {
        let Some((id, length)) = member_at(&rest, members, |u| unit_is(u, is_js_space) || u == u16::from(b',')) else {
            return ParsedAsk { to: vec![], text: String::new(), error: Some(AskError::Member) };
        };
        if !to.contains(&id) {
            to.push(id);
        }
        rest = after_units(&rest, length).to_owned();
        match js_trim_start(&rest).strip_prefix(',') {
            Some(after) => rest = js_trim_start(after).to_owned(),
            None => break,
        }
    }
    let message = js_trim(&rest).to_owned();
    if message.is_empty() {
        ParsedAsk { to, text: String::new(), error: Some(AskError::Message) }
    } else {
        ParsedAsk { to, text: message, error: None }
    }
}

/// Text a mention never counts in: code, block quotes and quoted strings.
static UNSPOKEN: LazyLock<Vec<JsRegex>> = LazyLock::new(|| {
    [
        (r"```[\s\S]*?(?:```|$)", "g"),
        (r"~~~[\s\S]*?(?:~~~|$)", "g"),
        (r"`[^`\n]*`", "g"),
        (r"^[ \t]*>.*$", "gm"),
        (r#""[^"\n]*""#, "g"),
        (r"“[^”\n]*”", "g"),
    ]
    .iter()
    .map(|(pattern, flags)| JsRegex::new_static(pattern, flags))
    .collect()
});
static MENTION: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"(^|[\s(])@", "g"));

/// The one peer a member's words address: the first `@Name` (id or name of another member) that
/// leads the text or stands apart from the words around it, outside code and quotes. Unknown,
/// ambiguous and self mentions stay plain text.
pub fn room_mention_of(text: &str, members: &[MemberName], self_id: &str) -> Option<String> {
    let mut value = text.to_owned();
    for pattern in UNSPOKEN.iter() {
        value = pattern.replace_all_with(&value, |_| " ".to_owned());
    }
    for found in MENTION.find_iter(&value) {
        let rest = &value[found.end..];
        let boundary = |u: u16| unit_is(u, |c| is_js_space(c) || ".,:;!?)]}…".contains(c));
        if let Some((id, _)) = member_at(rest, members, boundary) {
            if id != self_id {
                return Some(id);
            }
        }
    }
    None
}

/// A member passes by replying nothing, or with "(pass)" as its last words.
pub fn is_pass_reply(text: &str) -> bool {
    let value = js_trim(text);
    value.is_empty() || value.to_lowercase().ends_with(ROOM_PASS_REPLY)
}

/// A reply without its trailing "(pass)" marker, trimmed.
pub fn without_pass_marker(text: &str) -> String {
    let value = js_trim(text);
    if value.to_lowercase().ends_with(ROOM_PASS_REPLY) {
        js_trim(cut_utf16(value, utf16_len(value) - ROOM_PASS_REPLY.len()).head).to_owned()
    } else {
        value.to_owned()
    }
}

/// One exchange's message budget: a random whole number from enough for every member to speak once
/// and one more reply, up to the room's cap. `unit` is in [0, 1).
pub fn room_message_budget(member_count: u32, max_messages: u32, unit: f64) -> u32 {
    let low = (member_count + 1).min(max_messages);
    max_messages.min(low + (unit * f64::from(max_messages - low + 1)).floor() as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn members() -> Vec<MemberName> {
        [("alpha", "Alpha"), ("bench", "Bench"), ("bench-lead", "Bench lead")]
            .iter()
            .map(|(id, name)| MemberName { id: (*id).into(), name: (*name).into() })
            .collect()
    }
    fn input(name: &str, members: &[&str]) -> RoomConfigInput {
        RoomConfigInput {
            name: name.into(),
            members: members.iter().map(|m| (*m).into()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn normalizes_name_members_and_limits() {
        let config = normalize_room_config(&RoomConfigInput {
            max_rounds: Some(99.4),
            max_messages: Some(0.0),
            ..input("  Plan   room ", &["a", "b", "a", "Bad Id"])
        })
        .unwrap();
        assert_eq!(config.name, "Plan room");
        assert_eq!(config.members, ["a", "b"]);
        assert_eq!((config.max_rounds, config.max_messages), (10, 1));
        let defaults = normalize_room_config(&input("x", &["a", "b"])).unwrap();
        assert_eq!((defaults.max_rounds, defaults.max_messages), (3, 8));
        assert!(normalize_room_config(&input(" ", &["a", "b"])).is_err());
        assert!(normalize_room_config(&input("x", &["a"])).is_err());
        assert!(normalize_room_config(&input("x", &["a", "b", "c", "d", "e", "f", "g"])).is_err());
    }

    #[test]
    fn ask_addresses_members_in_order_longest_label_first() {
        let m = members();
        let ask = parse_room_ask("/ask Bench lead, alpha what now?", &m);
        assert_eq!(ask.to, ["bench-lead", "alpha"]);
        assert_eq!(ask.text, "what now?");
        let ask = parse_room_ask("/ASK bench hello", &m);
        assert_eq!((ask.to, ask.text), (vec!["bench".to_string()], "hello".to_string()));
        assert_eq!(parse_room_ask("/ask nobody hi", &m).error, Some(AskError::Member));
        assert_eq!(parse_room_ask("/ask alpha", &m).error, Some(AskError::Message));
        assert_eq!(parse_room_ask("/asking", &m), ParsedAsk { to: vec![], text: "/asking".into(), error: None });
        assert_eq!(parse_room_ask("hello all", &m).to, Vec::<String>::new());
    }

    #[test]
    fn a_label_two_members_share_matches_neither() {
        let dup = vec![
            MemberName { id: "a".into(), name: "Sam".into() },
            MemberName { id: "b".into(), name: "sam".into() },
        ];
        assert_eq!(room_member_named("Sam", &dup), None);
        assert_eq!(room_member_named("a", &dup).as_deref(), Some("a"));
        assert_eq!(room_member_named("alpha", &members()).as_deref(), Some("alpha"));
        assert_eq!(room_member_named("bench lead", &members()).as_deref(), Some("bench-lead"));
    }

    #[test]
    fn mentions_skip_code_quotes_self_and_unknown() {
        let m = members();
        assert_eq!(room_mention_of("@Alpha please look", &m, "bench").as_deref(), Some("alpha"));
        assert_eq!(room_mention_of("ok (@bench, go)", &m, "alpha").as_deref(), Some("bench"));
        assert_eq!(room_mention_of("`@alpha` and \"@alpha\"", &m, "bench"), None);
        assert_eq!(room_mention_of("```\n@alpha\n```\n> @alpha", &m, "bench"), None);
        assert_eq!(room_mention_of("@bench thanks", &m, "bench"), None);
        assert_eq!(room_mention_of("@ghost hi", &m, "bench"), None);
        assert_eq!(room_mention_of("mail me@alpha", &m, "bench"), None);
        assert_eq!(room_mention_of("@bench lead go", &m, "alpha").as_deref(), Some("bench-lead"));
    }

    #[test]
    fn pass_replies_and_budget() {
        assert!(is_pass_reply("  "));
        assert!(is_pass_reply("nothing to add (PASS)"));
        assert!(!is_pass_reply("(pass) but wait"));
        assert_eq!(without_pass_marker("explained (pass)"), "explained");
        assert_eq!(without_pass_marker("kept"), "kept");
        assert_eq!(room_message_budget(3, 8, 0.0), 4);
        assert_eq!(room_message_budget(3, 8, 0.999), 8);
        assert_eq!(room_message_budget(9, 8, 0.5), 8);
    }
}
