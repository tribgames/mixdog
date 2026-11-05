//! `Skill`: loads a skill's SKILL.md. The result is a short stub; the full body arrives once as
//! an injected user message flagged `skill`, and an unchanged repeat load is body-free.

use std::sync::Arc;

use crate::orch::util::JsStr;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::tool::FollowUpMessage;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;

use super::util::PortError;
use super::util::clean;
use super::util::invalid;
use super::util::spec_from_def;

/// The command name model shells find on their PATH to run a bundled skill script.
pub const SKILL_LAUNCHER_COMMAND: &str = "mixdog-skill-node";

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct LoadedSkill {
    pub content: String,
    /// The skill's directory, for `<base-dir>` and `${MIXDOG_SKILL_DIR}`.
    pub dir: Option<String>,
    /// `builtin` loads silently; user and plugin skills surface as a card.
    pub source: String,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum SkillLookup {
    /// The skill is off, out of scope or otherwise refused, with the refusal text.
    Refused(String),
    NotFound,
    Loaded(LoadedSkill),
}

/// The skill catalog. `load` also re-arms the skill's deferred tools for the thread (a repeat
/// load re-arms them as before); `body_present` is true when the live transcript still holds
/// exactly this body.
#[async_trait]
pub trait SkillPort: Send + Sync {
    async fn load(&self, thread: &ThreadId, name: &str, cwd: &AbsPath) -> Result<SkillLookup, PortError>;
    async fn body_present(&self, thread: &ThreadId, body: &str) -> bool;
}

fn escape_xml(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// The injected message: `<skill>` with name, base dir and the body, variables substituted.
pub fn result_envelope(name: &str, content: &str, dir: Option<&str>) -> String {
    let mut body = content.replace("${MIXDOG_SKILL_NODE}", SKILL_LAUNCHER_COMMAND);
    let mut dir_line = String::new();
    if let Some(dir) = dir.filter(|d| !d.is_empty()) {
        let norm = dir.replace('\\', "/");
        body = body.replace("${MIXDOG_SKILL_DIR}", &norm);
        dir_line = format!("<base-dir>{}</base-dir>\n", escape_xml(&norm));
    }
    format!("<skill>\n<name>{}</name>\n{dir_line}{body}\n</skill>", escape_xml(name))
}

fn stub(name: &str, source: &str) -> String {
    let kind = if source == "builtin" { "built-in skill" } else { "skill" };
    format!("Loaded {kind}: {}", name.js_trim())
}

pub struct SkillTool {
    spec: ToolSpec,
    skills: Arc<dyn SkillPort>,
}

impl SkillTool {
    pub fn new(skills: Arc<dyn SkillPort>) -> Self {
        Self { spec: spec_from_def(include_str!("defs/Skill.json"), true, &[]), skills }
    }
}

#[async_trait]
impl Tool for SkillTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let name = clean(args.get("name"));
        if name.is_empty() {
            return Err(invalid("name", "skill name is required"));
        }
        let skill = match self.skills.load(&ctx.thread_id, &name, &ctx.cwd).await? {
            SkillLookup::Refused(text) => return Err(super::util::refused("skill", text)),
            SkillLookup::NotFound => {
                return Err(super::util::not_found(&name, format!("skill \"{name}\" not found")));
            }
            SkillLookup::Loaded(skill) => skill,
        };
        let body = result_envelope(&name, &skill.content, skill.dir.as_deref());
        let already = self.skills.body_present(&ctx.thread_id, &body).await;
        let head = stub(&name, &skill.source);
        let (text, follow_up) = if already {
            (
                format!("{head} (already active; instructions unchanged — follow them without calling Skill again)"),
                Vec::new(),
            )
        } else {
            (head, vec![FollowUpMessage { text: body, meta: Some("skill".to_owned()) }])
        };
        Ok(ToolOutput { parts: vec![ToolPart::Text(text)], follow_up_messages: follow_up, ..ToolOutput::default() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_substitutes_variables_and_escapes_names() {
        assert_eq!(
            result_envelope("a<b", "run ${MIXDOG_SKILL_NODE} ${MIXDOG_SKILL_DIR}/x.mjs", Some("C:\\s\\k")),
            "<skill>\n<name>a&lt;b</name>\n<base-dir>C:/s/k</base-dir>\nrun mixdog-skill-node C:/s/k/x.mjs\n</skill>"
        );
        assert_eq!(result_envelope("n", "body", None), "<skill>\n<name>n</name>\nbody\n</skill>");
    }

    #[test]
    fn stub_marks_builtin_skills() {
        assert_eq!(stub(" x ", "builtin"), "Loaded built-in skill: x");
        assert_eq!(stub("x", "global"), "Loaded skill: x");
    }
}
