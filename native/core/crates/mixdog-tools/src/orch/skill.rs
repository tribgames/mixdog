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

/// What arming a loaded skill's tool dependencies tells the model after the stub (the text of
/// Node's `loadSkillToolDependencies`): "Required tools loaded/available/unavailable: …", or, on a
/// native tool-search provider, the payload that replaces the whole result.
#[derive(Clone, PartialEq, Eq, Default, Debug)]
pub struct ArmNotice {
    /// The lines after the stub, in order.
    pub lines: Vec<String>,
    /// `{provider, toolReferences, openaiTools}` of the deferred tools the provider loads natively;
    /// the result then is `{"nativeToolSearch": {..this, "summary": stub and lines}}`.
    pub native: Option<serde_json::Value>,
}

impl ArmNotice {
    /// The Skill result: `head` (the stub) and the lines, one per line, or the native payload
    /// carrying that text as its summary.
    pub fn result(&self, head: &str) -> String {
        let summary = std::iter::once(head).chain(self.lines.iter().map(String::as_str)).collect::<Vec<_>>().join("\n");
        let Some(serde_json::Value::Object(native)) = &self.native else { return summary };
        let mut payload = native.clone();
        payload.insert("summary".to_owned(), serde_json::Value::String(summary));
        serde_json::json!({ "nativeToolSearch": payload }).to_string()
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct LoadedSkill {
    pub content: String,
    /// The skill's directory, for `<base-dir>` and `${MIXDOG_SKILL_DIR}`.
    pub dir: Option<String>,
    /// `builtin` loads silently; user and plugin skills surface as a card.
    pub source: String,
    /// What arming the skill's tool dependencies adds to the result.
    pub notice: ArmNotice,
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
/// exactly this body. A thread or transcript that cannot be read is an error, never "not
/// present".
#[async_trait]
pub trait SkillPort: Send + Sync {
    async fn load(&self, thread: &ThreadId, name: &str, cwd: &AbsPath) -> Result<SkillLookup, PortError>;
    async fn body_present(&self, thread: &ThreadId, body: &str) -> Result<bool, PortError>;
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
            return Err(invalid("name", "Error: skill name is required"));
        }
        let skill = match self.skills.load(&ctx.thread_id, &name, &ctx.cwd).await? {
            SkillLookup::Refused(text) => return Err(super::util::refused("skill", text)),
            SkillLookup::NotFound => {
                return Err(super::util::not_found(&name, format!("Error: skill \"{name}\" not found")));
            }
            SkillLookup::Loaded(skill) => skill,
        };
        let body = result_envelope(&name, &skill.content, skill.dir.as_deref());
        let already = self.skills.body_present(&ctx.thread_id, &body).await?;
        let head = stub(&name, &skill.source);
        let (text, follow_up) = if already {
            (
                format!("{head} (already active; instructions unchanged — follow them without calling Skill again)"),
                Vec::new(),
            )
        } else {
            (head, vec![FollowUpMessage { text: body, meta: Some("skill".to_owned()) }])
        };
        let text = skill.notice.result(&text);
        Ok(ToolOutput { parts: vec![ToolPart::Text(text)], follow_up_messages: follow_up, ..ToolOutput::default() })
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::tool::ToolError;

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

    struct Port {
        notice: ArmNotice,
        loaded: Result<(), PortError>,
        present: Result<bool, PortError>,
    }

    #[async_trait]
    impl SkillPort for Port {
        async fn load(&self, _: &ThreadId, _: &str, _: &AbsPath) -> Result<SkillLookup, PortError> {
            self.loaded.clone()?;
            Ok(SkillLookup::Loaded(LoadedSkill {
                content: "# Deck guide".to_owned(),
                dir: Some("/skills/deck-guide".to_owned()),
                source: "global".to_owned(),
                notice: self.notice.clone(),
            }))
        }
        async fn body_present(&self, _: &ThreadId, _: &str) -> Result<bool, PortError> {
            self.present.clone()
        }
    }

    fn port(notice: ArmNotice, present: Result<bool, PortError>) -> Arc<Port> {
        Arc::new(Port { notice, loaded: Ok(()), present })
    }

    /// The Skill result of every recorded Node load (`fixtures/skill-session/golden.json`): the
    /// stub, its already-active suffix, the notice lines and the native tool-search payload, byte
    /// for byte; an unchanged repeat load injects no body.
    #[tokio::test]
    async fn the_result_reads_as_node_words_it() {
        let golden: serde_json::Value = mixdog_js::fixture_tools::parse_golden(include_str!("../../../../fixtures/skill-session/golden.json")).expect("fixture");
        for case in golden["arm"].as_array().expect("arm cases") {
            let lines = case["notice"]["lines"].as_array().expect("lines").iter().map(|line| line.as_str().expect("line").to_owned()).collect();
            let native = Some(case["notice"]["native"].clone()).filter(|native| !native.is_null());
            let already = case["already"].as_bool().expect("already");
            let tool = SkillTool::new(port(ArmNotice { lines, native }, Ok(already)));
            let output = tool.call(&crate::orch::tests::ctx(), serde_json::json!({"name": "deck-guide"})).await.expect("loaded");
            assert_eq!(output.parts, vec![ToolPart::Text(case["result"].as_str().expect("result").to_owned())], "{}", case["name"]);
            assert_eq!(output.follow_up_messages.is_empty(), already, "{}", case["name"]);
        }
    }

    struct NoSkill;

    #[async_trait]
    impl SkillPort for NoSkill {
        async fn load(&self, _: &ThreadId, _: &str, _: &AbsPath) -> Result<SkillLookup, PortError> {
            Ok(SkillLookup::NotFound)
        }
        async fn body_present(&self, _: &ThreadId, _: &str) -> Result<bool, PortError> {
            Ok(false)
        }
    }

    /// Node's `viewSkill` answers a missing name and an unknown skill as `Error: …` text
    /// (`fixtures/tool-failures/golden.json`: the model saw `Error: skill "no-such-skill" not found`).
    #[tokio::test]
    async fn a_missing_name_and_an_unknown_skill_are_answered_as_error_lines() {
        let tool = SkillTool::new(Arc::new(NoSkill));
        let unknown = tool.call(&crate::orch::tests::ctx(), serde_json::json!({"name": "no-such-skill"})).await.expect_err("fails");
        assert_eq!(unknown.message_for_model, "Error: skill \"no-such-skill\" not found");
        let missing = tool.call(&crate::orch::tests::ctx(), serde_json::json!({})).await.expect_err("fails");
        assert_eq!(missing.message_for_model, "Error: skill name is required");
    }

    /// A load or transcript read that failed fails the call with the port error's tool error, the
    /// one every port failure maps to.
    #[tokio::test]
    async fn a_failed_port_fails_the_call() {
        let failure = PortError::Failed { capability: "session".to_owned(), message: "header unreadable".to_owned() };
        let expected = ToolError::from(failure.clone());
        let transcript = SkillTool::new(port(ArmNotice::default(), Err(failure.clone())));
        let error = transcript.call(&crate::orch::tests::ctx(), serde_json::json!({"name": "deck-guide"})).await.expect_err("fails");
        assert_eq!(error.message_for_model, expected.message_for_model);
        let arming = SkillTool::new(Arc::new(Port { notice: ArmNotice::default(), loaded: Err(failure), present: Ok(false) }));
        let error = arming.call(&crate::orch::tests::ctx(), serde_json::json!({"name": "deck-guide"})).await.expect_err("fails");
        assert_eq!(error.message_for_model, expected.message_for_model);
    }
}
