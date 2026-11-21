//! `handoff_user`: a page or app step only the user can supply. `secret`: the user types a
//! value into a bound field on the desktop (the value never passes through the core; only the
//! fill outcome travels). `takeover`: the user does a step and says done.

use std::sync::Arc;
use std::time::Duration;

use crate::orch::util::JsStr;
use async_trait::async_trait;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::approval::ApprovalKind;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::HumanGateResponse;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use serde_json::Value;
use serde_json::json;
use url::Url;

use crate::desktop::host::HostCommands;
use crate::orch::ports::CallerFacts;
use crate::orch::util::action_failed;
use crate::orch::util::cancelled;
use crate::orch::util::invalid;
use crate::orch::util::spec_from_def;
use crate::orch::util::text;
use mixdog_core_api::domain::tool::ToolError;

pub const SECRET_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const HANDOFF_OUTCOMES: [&str; 6] = ["entered", "user_skipped", "no_field", "page_changed", "blocked", "expired"];
/// A takeover nobody finishes ends on its own after this long (`TAKEOVER_EXPIRY_MS`, `takeover-gate.ts`).
pub const TAKEOVER_EXPIRY: Duration = Duration::from_secs(15 * 60);
/// The settle reason of a takeover that expired.
const TAKEOVER_EXPIRED_REASON: &str = "expired";
const UNATTENDED_TAKEOVER: &str =
    "Nobody is present in this routine run, so it ends here and the user is told what needs them. Stop; do not retry or work around this step.";
const NO_TAKEOVER: &str =
    "Blocked: nobody can take over in this session, so this step was not done. Stop and tell the user what needs them; do not work around it.";

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct LoginPage {
    pub url: String,
    pub origin: String,
}

/// A login takeover's sign-in page: https, or http on loopback only; never embedded
/// credentials.
pub fn login_page_url(value: &str) -> Option<LoginPage> {
    if value.js_trim().is_empty() || value.js_len() > 2048 {
        return None;
    }
    let parsed = Url::parse(value.js_trim()).ok()?;
    let host = parsed.host_str()?.trim_start_matches('[').trim_end_matches(']').to_lowercase();
    let loopback = host == "localhost"
        || host.ends_with(".localhost")
        || host == "::1"
        || (host.starts_with("127.") && host.split('.').count() == 4 && host.split('.').all(|p| p.parse::<u16>().is_ok()));
    let scheme_ok = parsed.scheme() == "https" || (parsed.scheme() == "http" && loopback);
    if !scheme_ok || !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    Some(LoginPage { url: parsed.as_str().to_owned(), origin: parsed.origin().ascii_serialization() })
}

#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Identity {
    pub tab: String,
    pub window_id: String,
    pub app: String,
    pub reference: String,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Handoff {
    pub secret: bool,
    pub surface: String,
    pub target: String,
    pub field: String,
    pub instructions: String,
    pub identity: Identity,
    pub need: String,
    pub login: Option<LoginPage>,
}

fn is_token(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '.' | ':' | '#' | '@' | '-'))
}

/// The handoff of a `handoff_user` call, validated with the existing wordings.
pub fn validate(args: &Value) -> Result<Handoff, String> {
    let handoff = match args.get("handoff") {
        None | Some(Value::Null) => return Err("handoff_user needs a handoff".to_owned()),
        Some(Value::Object(o)) => o,
        Some(_) => return Err("handoff_user handoff must be an object".to_owned()),
    };
    let kind = handoff.get("kind").and_then(Value::as_str);
    let secret = match kind {
        Some("secret") => true,
        Some("takeover") => false,
        _ => return Err("handoff_user handoff kind is secret or takeover".to_owned()),
    };
    let surface = match handoff.get("surface").and_then(Value::as_str) {
        Some(s @ ("browser" | "computer")) => s.to_owned(),
        _ => return Err("handoff_user handoff surface is browser or computer".to_owned()),
    };
    let text = |key: &str, limit: usize| -> String {
        handoff.get(key).and_then(Value::as_str).map(|s| mixdog_js::slice_utf16(s.js_trim(), limit)).unwrap_or_default()
    };
    if !secret && text("instructions", 2000).is_empty() {
        return Err("handoff_user takeover needs instructions".to_owned());
    }
    let login = match handoff.get("purpose") {
        None | Some(Value::Null) => None,
        Some(p) => {
            if p.as_str() != Some("login") || secret || surface != "browser" {
                return Err("handoff_user purpose login is a browser takeover".to_owned());
            }
            let url = handoff.get("url").and_then(Value::as_str).unwrap_or_default();
            Some(login_page_url(url).ok_or("handoff_user login needs an https url (http only on localhost)")?)
        }
    };
    let need = match handoff.get("need").and_then(Value::as_str) {
        Some(n @ ("sign_in" | "action" | "confirmation")) => n.to_owned(),
        _ if login.is_some() => "sign_in".to_owned(),
        _ => "action".to_owned(),
    };
    let token = |key: &str, limit: usize| -> String {
        let v = handoff.get(key).and_then(Value::as_str).map(mixdog_js::js_trim).unwrap_or_default();
        if !v.is_empty() && v.js_len() <= limit && is_token(v) { v.to_owned() } else { String::new() }
    };
    let identity = if surface == "browser" {
        Identity { tab: token("tab", 64), ..Identity::default() }
    } else {
        let app = handoff.get("app").and_then(Value::as_str).map(|a| mixdog_js::slice_utf16(a.replace(['\r', '\n'], " ").js_trim(), 120)).unwrap_or_default();
        Identity { window_id: token("window_id", 128), app, reference: if secret { token("ref", 64) } else { String::new() }, ..Identity::default() }
    };
    if secret && surface == "computer" && (identity.window_id.is_empty() || identity.reference.is_empty()) {
        return Err("handoff_user computer secret needs a valid window_id and ref".to_owned());
    }
    Ok(Handoff { secret, surface, target: text("target", 200), field: text("field", 80), instructions: text("instructions", 2000), identity, need, login })
}

/// The site a takeover is about: the first host its target (or instructions) names, else the
/// target as the model wrote it.
pub fn handoff_site(handoff: &Handoff) -> String {
    if let Some(login) = &handoff.login {
        return Url::parse(&login.url).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_default();
    }
    let host = mixdog_js::JsRegex::new_static(r"\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b", "i");
    for text in [&handoff.target, &handoff.instructions] {
        if let Some(m) = host.captures(text).and_then(|c| c.get(1)) {
            return m.to_lowercase();
        }
    }
    handoff.target.js_trim().to_owned()
}

/// A page address as the agent may see it: origin and path, no query or fragment.
fn fact_url(value: &str) -> String {
    match Url::parse(value) {
        Ok(u) if matches!(u.scheme(), "http" | "https") => {
            format!("{}{}", u.origin().ascii_serialization(), u.path())
        }
        _ => String::new(),
    }
}

fn expired(resolution: &ApprovalResolution) -> bool {
    match resolution {
        ApprovalResolution::TimedOut { .. } => true,
        ApprovalResolution::Decided { decision, .. } => decision.reason.as_deref() == Some(TAKEOVER_EXPIRED_REASON),
        _ => false,
    }
}

fn decided(resolution: &ApprovalResolution) -> Option<&mixdog_protocol::ToolApprovalDecision> {
    match resolution {
        ApprovalResolution::Decided { decision, .. } if decision.approved => Some(decision),
        _ => None,
    }
}

/// The device that answered (`result?.device`); a timeout has none.
fn device_of(resolution: &ApprovalResolution) -> &str {
    match resolution {
        ApprovalResolution::Decided { device, .. } => device,
        _ => "",
    }
}

/// Result of a takeover: what the user did and where the page is now, never "signed in".
pub fn takeover_outcome(resolution: &ApprovalResolution, page_url: &str) -> String {
    if expired(resolution) {
        return "expired".to_owned();
    }
    if matches!(resolution, ApprovalResolution::Unavailable { .. }) {
        return "blocked".to_owned();
    }
    let Some(decision) = decided(resolution) else {
        return "user_skipped".to_owned();
    };
    let did = if decision.reason.as_deref() == Some("saved_login") { "User chose a saved login; it was filled in" } else { "User pressed Done" };
    match fact_url(page_url).as_str() {
        "" => did.to_owned(),
        url => format!("{did}; page now at {url}"),
    }
}

/// The takeover card's request: it expires after [`TAKEOVER_EXPIRY`], resolved `timedOut`, which
/// [`takeover_outcome`] answers as `expired`.
fn takeover_ask(call_id: Option<mixdog_protocol::ToolCallId>, takeover: Value) -> ApprovalAsk {
    ApprovalAsk {
        kind: ApprovalKind::Tool,
        call_id,
        tool: Some("handoff_user".to_owned()),
        action_kind: None,
        reason: None,
        payload: json!({"kind": "takeover", "takeover": takeover}),
        remember: Vec::new(),
        expires_after: Some(TAKEOVER_EXPIRY),
    }
}

/// What the tool layer records about a human decision.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct GateRecord {
    pub kind: &'static str,
    pub tool: String,
    pub target: String,
}

/// The services a handoff touches besides the approval gate and the host.
#[async_trait]
pub trait HandoffEnv: Send + Sync {
    /// A schedule or webhook run has nobody to take over: the step ends the run now and the
    /// user is told what needs them. True when that happened.
    async fn human_needed(&self, thread: &ThreadId, outcome: &str, site: &str) -> bool;
    /// `recordHumanDecision(gate, { response, device })`: the audit line of the answer. `Err` is
    /// the store's failure, which fails the call as it did in Node.
    async fn record_decision(&self, thread: &ThreadId, gate: &GateRecord, response: &str, device: &str) -> Result<(), String>;
    /// Computer Use secret: bound to the exact window and field ref. `bound` on success.
    async fn computer_bind(&self, thread: &ThreadId, request_id: &str, window_id: &str, reference: &str) -> String;
    /// Fill the secret the user handed the desktop for `request_id`; a handoff outcome.
    async fn computer_input(&self, thread: &ThreadId, request_id: &str, window_id: &str, reference: &str) -> String;
}

pub struct HandoffUserTool {
    spec: ToolSpec,
    facts: Arc<dyn CallerFacts>,
    host: Arc<dyn HostCommands>,
    env: Arc<dyn HandoffEnv>,
    ids: Arc<dyn Fn() -> String + Send + Sync>,
}

impl HandoffUserTool {
    /// `ids` mints unique request ids (`secret_<uuid>`).
    pub fn new(facts: Arc<dyn CallerFacts>, host: Arc<dyn HostCommands>, env: Arc<dyn HandoffEnv>, ids: Arc<dyn Fn() -> String + Send + Sync>) -> Self {
        Self { spec: spec_from_def(include_str!("defs/handoff_user.json"), false, &[]), facts, host, env, ids }
    }

    /// A value from the host's page facts, `None` when the desktop is absent or refuses.
    async fn page(&self, thread: &ThreadId, action: &str, input: Value, cancel: &mixdog_rt::CancellationToken) -> Option<Value> {
        let value = self.host.browser(thread, action, input, cancel).await.ok()?;
        value.is_object().then_some(value)
    }

    #[allow(clippy::result_large_err, reason = "Preserve the canonical structured ToolError and ToolOutcome contract without per-error boxing.")]
    async fn record(&self, thread: &ThreadId, gate: &GateRecord, response: &str, device: &str) -> Result<(), ToolError> {
        self.env.record_decision(thread, gate, response, device).await.map_err(|message| action_failed("handoff", message))
    }

    #[allow(clippy::result_large_err, reason = "Preserve the canonical structured ToolError and ToolOutcome contract without per-error boxing.")]
    /// What the secret request is bound to (the page's origin and form, empty for a computer field); the
    /// handoff outcome when it cannot be bound.
    async fn bind_secret(&self, ctx: &ToolContext, h: &Handoff, request_id: &str) -> Result<Value, &'static str> {
        let thread = &ctx.thread_id;
        if h.surface != "browser" {
            return match self.env.computer_bind(thread, request_id, &h.identity.window_id, &h.identity.reference).await.as_str() {
                "bound" => Ok(json!({})),
                "no_field" => Err("no_field"),
                _ => Err("blocked"),
            };
        }
        let mut input = json!({"request_id": request_id, "field": h.field});
        if !h.identity.tab.is_empty() {
            input["tab"] = json!(h.identity.tab);
        }
        let facts = self.page(thread, "secret_bind", input, &ctx.cancel).await;
        let origin = facts.as_ref().and_then(|f| f.get("origin")).and_then(Value::as_str).filter(|o| !o.is_empty()).ok_or("blocked")?;
        let form = facts.as_ref().and_then(|f| f.get("form")).and_then(Value::as_str).filter(|o| !o.is_empty()).ok_or("no_field")?;
        let mut bound = json!({"origin": origin, "form": form});
        if let Some(length) = facts.as_ref().and_then(|f| f.get("length")).filter(|l| l.as_u64().is_some_and(|n| n > 0)) {
            bound["length"] = length.clone();
        }
        Ok(bound)
    }

    /// The outcome of the fill the user handed the desktop for `request_id`.
    async fn fill_secret(&self, ctx: &ToolContext, h: &Handoff, request_id: &str) -> String {
        let thread = &ctx.thread_id;
        let filled = if h.surface == "browser" {
            let value = self.page(thread, "secret_input", json!({"request_id": request_id}), &ctx.cancel).await;
            value.and_then(|v| v.get("text").and_then(Value::as_str).map(str::to_owned)).unwrap_or_default()
        } else {
            self.env.computer_input(thread, request_id, &h.identity.window_id, &h.identity.reference).await
        };
        if filled != "user_skipped" && HANDOFF_OUTCOMES.contains(&filled.as_str()) { filled } else { "blocked".to_owned() }
    }

    #[allow(clippy::result_large_err, reason = "Preserve the canonical structured ToolError and ToolOutcome contract without per-error boxing.")]
    async fn secret(&self, ctx: &ToolContext, h: &Handoff, gate: &GateRecord) -> Result<String, ToolError> {
        let thread = &ctx.thread_id;
        let request_id = (self.ids)();
        let bound = match self.bind_secret(ctx, h, &request_id).await {
            Ok(bound) => bound,
            Err(outcome) => {
                self.record(thread, gate, outcome, "").await?;
                return Ok(outcome.to_owned());
            }
        };
        let mut secret = json!({"requestId": request_id, "surface": h.surface, "target": h.target, "field": h.field});
        if let (Some(dst), Some(src)) = (secret.as_object_mut(), bound.as_object()) {
            dst.extend(src.clone());
        }
        let resolution = ctx
            .approvals
            .request(ApprovalAsk {
                kind: ApprovalKind::Tool,
                call_id: Some(ctx.call_id.clone()),
                tool: Some("handoff_user".to_owned()),
                action_kind: None,
                reason: None,
                payload: json!({"kind": "secret", "secret": secret}),
                remember: Vec::new(),
                expires_after: Some(SECRET_REQUEST_TIMEOUT),
            })
            .await;
        if matches!(resolution, ApprovalResolution::Cancelled { .. } | ApprovalResolution::Interrupted { .. }) {
            return Err(cancelled());
        }
        let outcome = if expired(&resolution) {
            "expired".to_owned()
        } else if matches!(resolution, ApprovalResolution::Unavailable { .. }) {
            "blocked".to_owned()
        } else if !matches!(decided(&resolution), Some(d) if d.response == Some(HumanGateResponse::ProvideSecret)) {
            "user_skipped".to_owned()
        } else {
            self.fill_secret(ctx, h, &request_id).await
        };
        self.record(thread, gate, &outcome, device_of(&resolution)).await?;
        Ok(outcome)
    }

    #[allow(clippy::result_large_err, reason = "Preserve the canonical structured ToolError and ToolOutcome contract without per-error boxing.")]
    async fn takeover(&self, ctx: &ToolContext, h: &Handoff, gate: &GateRecord) -> Result<String, ToolError> {
        let thread = &ctx.thread_id;
        let tab_input = |mut base: Value| {
            if !h.identity.tab.is_empty() {
                base["tab"] = json!(h.identity.tab);
            }
            base
        };
        let fill_id = h.login.as_ref().map(|_| (self.ids)()).unwrap_or_default();
        let accounts = match &h.login {
            Some(login) => self
                .page(thread, "login_accounts", tab_input(json!({"url": login.url, "request_id": fill_id})), &ctx.cancel)
                .await
                .and_then(|v| v.get("accounts").cloned())
                .filter(|a| a.as_array().is_some_and(|a| !a.is_empty())),
            None => None,
        };
        let mut takeover = json!({"surface": h.surface, "instructions": h.instructions, "target": h.target});
        if let Some(map) = takeover.as_object_mut() {
            for (key, value) in [("tab", &h.identity.tab), ("windowId", &h.identity.window_id), ("app", &h.identity.app)] {
                if !value.is_empty() {
                    map.insert(key.to_owned(), json!(value));
                }
            }
            if let Some(login) = &h.login {
                map.insert("purpose".into(), json!("login"));
                map.insert("url".into(), json!(login.url));
            }
            if let Some(accounts) = accounts {
                map.insert("accounts".into(), accounts);
                map.insert("fillId".into(), json!(fill_id));
            }
        }
        let resolution = ctx.approvals.request(takeover_ask(Some(ctx.call_id.clone()), takeover)).await;
        if matches!(resolution, ApprovalResolution::Cancelled { .. } | ApprovalResolution::Interrupted { .. }) {
            return Err(cancelled());
        }
        let page_url = if !expired(&resolution) && decided(&resolution).is_some() && h.surface == "browser" {
            self.page(thread, "page_url", tab_input(json!({})), &ctx.cancel)
                .await
                .and_then(|v| v.get("url").and_then(Value::as_str).map(str::to_owned))
                .unwrap_or_default()
        } else {
            String::new()
        };
        let answer = takeover_outcome(&resolution, &page_url);
        let response = if decided(&resolution).is_some() && !expired(&resolution) { "done" } else { answer.as_str() };
        self.record(thread, gate, response, device_of(&resolution)).await?;
        Ok(answer)
    }
}

#[async_trait]
impl Tool for HandoffUserTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let h = validate(&args).map_err(|m| invalid("handoff", m))?;
        let gate = GateRecord {
            kind: if h.secret { "secret" } else { "takeover" },
            tool: format!("handoff_user:{}", h.surface),
            target: if h.target.is_empty() { h.field.clone() } else { h.target.clone() },
        };
        if !h.secret {
            let outcome = match h.need.as_str() {
                "sign_in" => "login_required",
                "confirmation" => "sensitive_confirmation_required",
                _ => "human_action_required",
            };
            if self.env.human_needed(&ctx.thread_id, outcome, &handoff_site(&h)).await {
                return text(UNATTENDED_TAKEOVER);
            }
        }
        if !self.facts.user_available(&ctx.thread_id).await {
            // Nobody can take over or type here: blocked, never "proceed".
            if !h.secret {
                return text(NO_TAKEOVER);
            }
            self.record(&ctx.thread_id, &gate, "blocked", "").await?;
            return text("blocked");
        }
        let answer = if h.secret { self.secret(ctx, &h, &gate).await? } else { self.takeover(ctx, &h, &gate).await? };
        text(answer)
    }
}

#[cfg(test)]
mod tests {
    use mixdog_protocol::ConnectionKind;
    use mixdog_protocol::ToolApprovalDecision;

    use super::*;

    fn decision(approved: bool, reason: Option<&str>, response: Option<HumanGateResponse>) -> ApprovalResolution {
        ApprovalResolution::Decided {
            decision: ToolApprovalDecision {
                approved,
                reason: reason.map(str::to_owned),
                answers: None,
                reply: None,
                response,
                edited_args: None,
                remember: None,
                scope: None,
            },
            device: "d".into(),
            connection_kind: ConnectionKind::Desktop,
            at: 0,
        }
    }

    #[test]
    fn login_urls_are_https_or_loopback_without_credentials() {
        assert!(login_page_url("https://example.com/login?x=1").is_some());
        assert!(login_page_url("http://localhost:3000/in").is_some());
        assert!(login_page_url("http://example.com/").is_none());
        assert!(login_page_url("https://u:p@example.com/").is_none());
        assert_eq!(login_page_url("https://Example.com/a").unwrap().origin, "https://example.com");
    }

    #[test]
    fn takeover_outcomes_are_facts_without_query() {
        assert_eq!(takeover_outcome(&ApprovalResolution::Unavailable { at: 0 }, ""), "blocked");
        let done = decision(true, None, Some(HumanGateResponse::Done));
        assert_eq!(takeover_outcome(&done, "https://a.com/home?token=1#x"), "User pressed Done; page now at https://a.com/home");
        assert_eq!(takeover_outcome(&done, "about:blank"), "User pressed Done");
        assert_eq!(takeover_outcome(&decision(false, None, None), ""), "user_skipped");
        assert_eq!(takeover_outcome(&ApprovalResolution::TimedOut { at: 1 }, ""), "expired");
        assert_eq!(takeover_outcome(&decision(true, Some("expired"), None), ""), "expired");
    }

    #[test]
    fn a_takeover_card_expires_after_fifteen_minutes_and_a_secret_card_keeps_its_own_limit() {
        let card = takeover_ask(None, json!({"surface": "computer"}));
        assert_eq!(card.expires_after, Some(Duration::from_secs(900)));
        assert_eq!(card.payload, json!({"kind": "takeover", "takeover": {"surface": "computer"}}));
        assert_eq!(SECRET_REQUEST_TIMEOUT, Duration::from_secs(120));
        // The expiry ends the wait as Node's expiry settle does: reason `expired`.
        assert_eq!(takeover_outcome(&ApprovalResolution::TimedOut { at: 900_000 }, "https://a.com/x"), "expired");
    }

    struct Present;

    #[async_trait]
    impl CallerFacts for Present {
        async fn is_heartbeat(&self, _: &ThreadId) -> bool {
            false
        }
        async fn is_unattended(&self, _: &ThreadId) -> bool {
            false
        }
        async fn user_available(&self, _: &ThreadId) -> bool {
            true
        }
    }

    struct Page(std::collections::HashMap<&'static str, Value>);

    #[async_trait]
    impl HostCommands for Page {
        async fn browser(
            &self,
            _: &ThreadId,
            action: &str,
            _: JsonValue,
            _: &mixdog_rt::CancellationToken,
        ) -> Result<JsonValue, crate::desktop::host::HostCommandError> {
            self.0.get(action).cloned().ok_or(crate::desktop::host::HostCommandError::NoHost)
        }
        async fn visualize(
            &self,
            _: &ThreadId,
            _: &str,
            _: &str,
            _: JsonValue,
            _: &mixdog_rt::CancellationToken,
        ) -> Result<JsonValue, crate::desktop::host::HostCommandError> {
            unreachable!()
        }
    }

    struct Desk {
        bind: &'static str,
        input: &'static str,
        recorded: std::sync::Mutex<Vec<String>>,
    }

    #[async_trait]
    impl HandoffEnv for Desk {
        async fn human_needed(&self, _: &ThreadId, _: &str, _: &str) -> bool {
            false
        }
        async fn record_decision(&self, _: &ThreadId, _: &GateRecord, response: &str, _: &str) -> Result<(), String> {
            self.recorded.lock().unwrap().push(response.to_owned());
            Ok(())
        }
        async fn computer_bind(&self, _: &ThreadId, _: &str, _: &str, _: &str) -> String {
            self.bind.to_owned()
        }
        async fn computer_input(&self, _: &ThreadId, _: &str, _: &str, _: &str) -> String {
            self.input.to_owned()
        }
    }

    struct Run {
        answer: String,
        recorded: Vec<String>,
        asks: Vec<ApprovalAsk>,
    }

    async fn handoff(args: Value, page: &[(&'static str, Value)], bind: &'static str, input: &'static str, answers: Vec<ApprovalResolution>) -> Run {
        let gate = Arc::new(mixdog_core_api::domain::mock::MockApprovalGate::default());
        gate.script.lock().unwrap().extend(answers);
        let env = Arc::new(Desk { bind, input, recorded: Default::default() });
        let tool = HandoffUserTool::new(Arc::new(Present), Arc::new(Page(page.iter().cloned().collect())), env.clone(), Arc::new(|| "req_1".to_owned()));
        let ctx = ToolContext { approvals: gate.clone(), ..crate::orch::tests::ctx() };
        let out = tool.call(&ctx, args).await.expect("handoff answers");
        let mixdog_core_api::domain::tool::ToolPart::Text(answer) = out.parts[0].clone() else { panic!("text") };
        let asks = gate.asks.lock().unwrap().clone();
        let recorded = env.recorded.lock().unwrap().clone();
        Run { answer, recorded, asks }
    }

    fn secret_args(surface: &str) -> Value {
        match surface {
            "browser" => json!({"handoff": {"kind": "secret", "surface": "browser", "field": "password", "target": "shop"}}),
            _ => json!({"handoff": {"kind": "secret", "surface": "computer", "field": "pin", "window_id": "w1", "ref": "r1"}}),
        }
    }

    #[tokio::test]
    async fn a_browser_secret_is_bound_to_its_origin_and_form_then_filled() {
        let page = [("secret_bind", json!({"origin": "https://a.com", "form": "f1", "length": 8})), ("secret_input", json!({"text": "entered"}))];
        let provided = decision(true, None, Some(HumanGateResponse::ProvideSecret));
        let run = handoff(secret_args("browser"), &page, "", "", vec![provided]).await;
        assert_eq!((run.answer.as_str(), run.recorded), ("entered", vec!["entered".to_owned()]));
        assert_eq!(
            run.asks[0].payload,
            json!({"kind": "secret", "secret": {"requestId": "req_1", "surface": "browser", "target": "shop", "field": "password", "origin": "https://a.com", "form": "f1", "length": 8}})
        );
    }

    #[tokio::test]
    async fn a_browser_secret_without_an_origin_is_blocked_and_without_a_form_has_no_field() {
        let blocked = handoff(secret_args("browser"), &[("secret_bind", json!({"form": "f1"}))], "", "", vec![]).await;
        assert_eq!((blocked.answer.as_str(), blocked.recorded, blocked.asks.len()), ("blocked", vec!["blocked".to_owned()], 0));
        let no_field = handoff(secret_args("browser"), &[("secret_bind", json!({"origin": "https://a.com"}))], "", "", vec![]).await;
        assert_eq!((no_field.answer.as_str(), no_field.recorded, no_field.asks.len()), ("no_field", vec!["no_field".to_owned()], 0));
    }

    #[tokio::test]
    async fn a_computer_secret_ends_as_its_bind_or_the_users_answer_says() {
        let no_field = handoff(secret_args("computer"), &[], "no_field", "", vec![]).await;
        assert_eq!((no_field.answer.as_str(), no_field.asks.len()), ("no_field", 0));
        let refused = handoff(secret_args("computer"), &[], "weird", "", vec![]).await;
        assert_eq!(refused.answer, "blocked");
        let skipped = handoff(secret_args("computer"), &[], "bound", "entered", vec![decision(false, None, None)]).await;
        assert_eq!((skipped.answer.as_str(), skipped.recorded), ("user_skipped", vec!["user_skipped".to_owned()]));
        let provided = decision(true, None, Some(HumanGateResponse::ProvideSecret));
        let filled = handoff(secret_args("computer"), &[], "bound", "entered", vec![provided.clone()]).await;
        assert_eq!(filled.answer, "entered");
        let unknown = handoff(secret_args("computer"), &[], "bound", "garbage", vec![provided]).await;
        assert_eq!(unknown.answer, "blocked");
    }

    #[tokio::test]
    async fn a_finished_takeover_records_done_and_answers_with_the_page() {
        let args = json!({"handoff": {"kind": "takeover", "surface": "browser", "instructions": "sign in"}});
        let page = [("page_url", json!({"url": "https://a.com/home?x=1"}))];
        let run = handoff(args, &page, "", "", vec![decision(true, None, Some(HumanGateResponse::Done))]).await;
        assert_eq!(run.answer, "User pressed Done; page now at https://a.com/home");
        assert_eq!(run.recorded, vec!["done".to_owned()]);
    }

    #[tokio::test]
    async fn a_timed_out_takeover_records_the_outcome_itself() {
        let args = json!({"handoff": {"kind": "takeover", "surface": "browser", "instructions": "sign in"}});
        let run = handoff(args, &[], "", "", vec![ApprovalResolution::TimedOut { at: 1 }]).await;
        assert_eq!((run.answer.as_str(), run.recorded), ("expired", vec!["expired".to_owned()]));
    }

    #[test]
    fn validation_wordings_and_defaults() {
        assert_eq!(validate(&json!({})).unwrap_err(), "handoff_user needs a handoff");
        assert_eq!(validate(&json!({"handoff":{"kind":"takeover","surface":"browser"}})).unwrap_err(), "handoff_user takeover needs instructions");
        let h = validate(&json!({"handoff":{"kind":"takeover","surface":"browser","instructions":"do it on shop.example.com","tab":"p1"}})).unwrap();
        assert_eq!((h.need.as_str(), h.identity.tab.as_str()), ("action", "p1"));
        assert_eq!(handoff_site(&h), "shop.example.com");
    }
}
