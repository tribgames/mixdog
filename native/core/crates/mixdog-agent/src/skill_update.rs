//! The skill-update notice (`session/skill-update-notice.mjs`): between compactions, each turn tells the model once
//! that a skill it holds instructions for changed, went away or came back, as a new runtime message after the
//! history and never by rewriting what was sent.

use std::sync::LazyLock;

use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::Role;
use mixdog_js::JsRegex;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

use crate::message::AgentMessage;
use crate::message::Source;

/// `SKILL_UPDATE_SOURCE`.
pub const SKILL_UPDATE_SOURCE: &str = "skill-update-notice";
/// The skill no longer loads at the session's folder.
const UNAVAILABLE: &str = "unavailable";
/// The loaded body is what the Skill tool delivers again.
const CURRENT: &str = "current";

static SKILL_BODY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^<skill>\n<name>([^<\n]+)<\/name>\n[\s\S]*\n<\/skill>$", ""));
static SKILL_ENTITY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"&(amp|lt|gt|quot|apos);", "g"));

/// `skillMessageText`: a string as it is, the text of every block joined without a separator.
fn skill_message_text(content: &Content) -> String {
    match content {
        Content::Text(text) => text.clone(),
        Content::Parts(parts) => parts
            .iter()
            .map(|part| match part {
                ContentPart::Text(text, _) => text.as_str(),
                _ => "",
            })
            .collect(),
    }
}

/// A skill body the transcript holds: the skill's name, the index of the message that carries it and the body as
/// it is compared (`skillMessageText(message.content).trimStart()`).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct LoadedBody {
    pub name: String,
    pub index: usize,
    pub body: String,
}

/// `latestSkillBodies`: the latest `<skill>` body of every skill in `messages`, in the order of those bodies.
pub fn latest_skill_bodies(messages: &[AgentMessage]) -> Vec<LoadedBody> {
    let mut latest: Vec<LoadedBody> = Vec::new();
    for (index, message) in messages.iter().enumerate() {
        if message.role() != Role::User {
            continue;
        }
        let text = skill_message_text(&message.message.content);
        let text = mixdog_js::js_trim_start(&text);
        let Some(name) = SKILL_BODY.captures(text).and_then(|caps| caps.get(1).map(str::to_owned)) else { continue };
        let name = SKILL_ENTITY.replace_all_with(&name, |c| {
            match c.get(1) {
                Some("amp") => "&",
                Some("lt") => "<",
                Some("gt") => ">",
                Some("quot") => "\"",
                _ => "'",
            }
            .to_owned()
        });
        // `latest.delete(name); latest.set(name, ..)`: a later body moves the skill to the end.
        latest.retain(|body| body.name != name);
        latest.push(LoadedBody { name, index, body: text.to_owned() });
    }
    latest
}

/// The state of a loaded body against what the Skill tool would deliver now (`delivery`, `None` when the skill no
/// longer loads): `current`, `unavailable`, or the first sixteen hex digits of the changed body's SHA-256.
fn version_of(body: &LoadedBody, delivery: Option<&str>) -> String {
    match delivery {
        None => UNAVAILABLE.to_owned(),
        Some(now) if now == body.body => CURRENT.to_owned(),
        Some(now) => Sha256::digest(now.as_bytes()).iter().take(8).map(|byte| format!("{byte:02x}")).collect(),
    }
}

/// The last state told after the body (`meta.version` of the latest notice naming the skill), `current` when none.
fn told(messages: &[AgentMessage], body: &LoadedBody) -> String {
    messages[body.index + 1..]
        .iter()
        .rev()
        .find_map(|message| {
            if message.source != Some(Source::SkillUpdateNotice) {
                return None;
            }
            let meta = message.stored.as_ref()?.get("meta")?;
            (meta.get("skill").and_then(|skill| skill.as_str()) == Some(body.name.as_str()))
                .then(|| meta.get("version").and_then(|version| version.as_str()).filter(|version| !version.is_empty()).unwrap_or(CURRENT).to_owned())
        })
        .unwrap_or_else(|| CURRENT.to_owned())
}

/// `skillUpdateNotice(name, version)`: the runtime message and its stored meta.
fn notice(name: &str, version: &str) -> AgentMessage {
    let text = match version {
        UNAVAILABLE => format!(
            "[mixdog-runtime] Skill \"{name}\" is no longer available in this session (switched off, removed, or outside this project's scope). Do not rely on its instructions."
        ),
        CURRENT => format!("[mixdog-runtime] Skill \"{name}\" is available again, unchanged; its loaded instructions apply again."),
        _ => format!("[mixdog-runtime] Skill \"{name}\" was updated since it was loaded. Reload it with the Skill tool before relying on it."),
    };
    let row = json!({ "role": "user", "content": text, "meta": { "source": SKILL_UPDATE_SOURCE, "synthetic": true, "skill": name, "version": version } });
    crate::message_row::message_of(&row).expect("a skill-update notice is a user row")
}

/// The notice `body` owes (`appendSkillUpdateNotices`, one skill): its state is announced whenever it differs from
/// the last state told after that body, so each transition notifies once.
pub fn skill_update_notice(messages: &[AgentMessage], body: &LoadedBody, delivery: Option<&str>) -> Option<AgentMessage> {
    let version = version_of(body, delivery);
    (told(messages, body) != version).then(|| notice(&body.name, &version))
}

#[cfg(test)]
mod tests {
    use super::*;

    const V1: &str = "<skill>\n<name>deck</name>\n<base-dir>/skills/deck</base-dir>\n# Deck v1\n</skill>";
    const V2: &str = "<skill>\n<name>deck</name>\n<base-dir>/skills/deck</base-dir>\n# Deck v2\n</skill>";

    fn row(message: &AgentMessage) -> serde_json::Value {
        crate::message_row::row_of(message)
    }

    /// One turn of `appendSkillUpdateNotices` over a single delivery answer for every skill.
    fn turn(messages: &mut Vec<AgentMessage>, delivery: Option<&str>) -> Vec<serde_json::Value> {
        let notices: Vec<AgentMessage> = latest_skill_bodies(messages).iter().filter_map(|body| skill_update_notice(messages, body, delivery)).collect();
        messages.extend(notices.iter().cloned());
        notices.iter().map(row).collect()
    }

    /// `latestSkillBodies`: only user rows whose whole (left-trimmed) text is a `<skill>` body count, a name's
    /// entities are decoded, and a later body of the same skill replaces the earlier one at the end of the order.
    #[test]
    fn the_latest_body_of_each_skill_is_found_as_node_finds_it() {
        let other = "<skill>\n<name>a &amp; b</name>\nbody\n</skill>";
        let messages = vec![
            AgentMessage::sourced(Source::Skill, V1),
            AgentMessage::assistant(V2, Vec::new()),
            AgentMessage::sourced(Source::Skill, format!("\n  {other}")),
            AgentMessage::user(format!("{V1}\ntrailing")),
            AgentMessage::user_content(Content::Parts(vec![ContentPart::Text("<skill>\n<name>deck</name>\n".into(), None), ContentPart::Text("# Deck v2\n</skill>".into(), None)])),
        ];
        let bodies = latest_skill_bodies(&messages);
        assert_eq!(bodies.iter().map(|body| (body.name.as_str(), body.index)).collect::<Vec<_>>(), [("a & b", 2), ("deck", 4)]);
        assert_eq!(bodies[0].body, other);
        assert_eq!(bodies[1].body, "<skill>\n<name>deck</name>\n# Deck v2\n</skill>");
    }

    /// `appendSkillUpdateNotices`: nothing while the body is current; a changed body, a skill gone and a skill back
    /// unchanged each notify once, with Node's text and meta; a reload starts over.
    #[test]
    fn each_transition_of_a_loaded_skill_is_announced_once_in_nodes_words() {
        let mut messages = vec![AgentMessage::user("hi"), AgentMessage::sourced(Source::Skill, V1)];
        assert!(turn(&mut messages, Some(V1)).is_empty());
        // Changed: the version is the first sixteen hex digits of the new body's SHA-256 (`createHash('sha256')`).
        assert_eq!(
            turn(&mut messages, Some(V2)),
            [json!({
                "role": "user",
                "content": "[mixdog-runtime] Skill \"deck\" was updated since it was loaded. Reload it with the Skill tool before relying on it.",
                "meta": { "source": "skill-update-notice", "synthetic": true, "skill": "deck", "version": "c362f715667552d1" },
            })]
        );
        assert!(turn(&mut messages, Some(V2)).is_empty(), "told once");
        // Switched off, removed or out of scope.
        assert_eq!(
            turn(&mut messages, None),
            [json!({
                "role": "user",
                "content": "[mixdog-runtime] Skill \"deck\" is no longer available in this session (switched off, removed, or outside this project's scope). Do not rely on its instructions.",
                "meta": { "source": "skill-update-notice", "synthetic": true, "skill": "deck", "version": "unavailable" },
            })]
        );
        assert!(turn(&mut messages, None).is_empty(), "told once");
        // Back with the loaded body.
        assert_eq!(
            turn(&mut messages, Some(V1)),
            [json!({
                "role": "user",
                "content": "[mixdog-runtime] Skill \"deck\" is available again, unchanged; its loaded instructions apply again.",
                "meta": { "source": "skill-update-notice", "synthetic": true, "skill": "deck", "version": "current" },
            })]
        );
        assert!(turn(&mut messages, Some(V1)).is_empty());
        // A reload replaces the body: the notices before it no longer count, and the new body is current.
        messages.push(AgentMessage::sourced(Source::Skill, V2));
        assert!(turn(&mut messages, Some(V2)).is_empty());
        assert_eq!(turn(&mut messages, None).len(), 1);
    }

    /// A notice read back from its stored row (the next turn's history) still names the state it told.
    #[test]
    fn a_stored_notice_is_read_back_as_told() {
        let mut messages = vec![AgentMessage::sourced(Source::Skill, V1)];
        let told = turn(&mut messages, None);
        let mut reread = vec![messages[0].clone(), crate::message_row::message_of(&told[0]).expect("row")];
        assert!(turn(&mut reread, None).is_empty());
        // A notice about another skill does not count for this one.
        let mut other = vec![messages[0].clone(), notice("other", UNAVAILABLE)];
        assert_eq!(turn(&mut other, None).len(), 1);
    }
}
