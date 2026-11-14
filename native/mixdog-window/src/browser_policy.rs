//! The Browser Use URL and redaction rules (crate mixdog-browser-policy) as synchronous Node-API functions, for the Electron main
//! process, which filters every navigation and every outgoing string and cannot await.
//! One export per function `apps/desktop/src/main/browser/{url-policy,redaction}.ts` offered, named in camelCase; a URL the rules
//! refuse throws an Error whose message is the refusal's reason.
//!
//! Hot path: `normalizePageUrl` and `normalizeAgentUrl` run once per page-generated network request, `redactBrowserText` and
//! `redactBrowserUrl` once per string that leaves the host.

use std::time::{SystemTime, UNIX_EPOCH};

use mixdog_browser_policy::redaction;
use mixdog_browser_policy::url_policy::{self, MailLink, UrlPolicy};
use napi::bindgen_prelude::{Error, Result};
use napi_derive::napi;

/// `BrowserUrlPolicy`: the private-network stance and the optional domain allow-list.
#[napi(object)]
#[derive(Default)]
pub struct BrowserUrlPolicyArg {
    pub allow_private_network: Option<bool>,
    pub allowed_domains: Option<Vec<String>>,
}

/// `BrowserMailLink`: the link of a mail the runtime read, with the sender's domain and the read time (ms since the epoch).
#[napi(object)]
pub struct BrowserMailLinkArg {
    pub url: String,
    #[napi(js_name = "from_domain")]
    pub from_domain: String,
    #[napi(js_name = "read_at")]
    pub read_at: Option<f64>,
}

fn policy_of(policy: Option<BrowserUrlPolicyArg>) -> UrlPolicy {
    let policy = policy.unwrap_or_default();
    UrlPolicy { allow_private_network: policy.allow_private_network.unwrap_or(false), allowed_domains: policy.allowed_domains.unwrap_or_default() }
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as i64)
}

fn refused(refusal: url_policy::Refusal) -> Error {
    Error::from_reason(refusal.reason)
}

/// How long after the runtime read a mail its link may still be opened, in milliseconds.
#[napi]
pub fn mail_link_window_ms() -> f64 {
    url_policy::MAIL_LINK_WINDOW_MS as f64
}

#[napi]
pub fn is_loopback_hostname(hostname: String) -> bool {
    url_policy::is_loopback_hostname(&hostname)
}

/// The normalized form of a URL an agent typed; throws the refusal's reason. `mail_link` lifts only the secret-token refusal, for
/// the exact link it names.
#[napi]
pub fn normalize_agent_url(raw: String, policy: Option<BrowserUrlPolicyArg>, mail_link: Option<BrowserMailLinkArg>) -> Result<String> {
    // A read time that is not a finite number never admits the link (`Number(link.read_at)` of the TypeScript rules was NaN).
    let mail_link = mail_link.map(|link| MailLink {
        url: link.url,
        from_domain: link.from_domain,
        read_at: link.read_at.filter(|at| at.is_finite()).map(|at| at as i64),
    });
    url_policy::normalize_agent_url(&raw, &policy_of(policy), mail_link.as_ref(), now_ms()).map_err(refused)
}

/// The normalized form of a URL a page asked for; throws the refusal's reason.
#[napi]
pub fn normalize_page_url(raw: String, policy: Option<BrowserUrlPolicyArg>) -> Result<String> {
    url_policy::normalize_page_url(&raw, &policy_of(policy)).map_err(refused)
}

/// Throws when `address`, the answer for `hostname`, is a metadata endpoint, or a private address the policy does not allow.
#[napi]
pub fn assert_resolved_address_allowed(address: String, hostname: String, policy: Option<BrowserUrlPolicyArg>) -> Result<()> {
    url_policy::assert_resolved_address_allowed(&address, &hostname, &policy_of(policy)).map_err(refused)
}

#[napi]
pub fn browser_url_contains_secret(raw: String) -> bool {
    redaction::url_contains_secret(&raw)
}

#[napi]
pub fn redact_browser_text(value: String) -> String {
    redaction::redact_browser_text(&value)
}

#[napi]
pub fn redact_browser_known_secrets(value: String, secrets: Vec<String>) -> String {
    redaction::redact_known_secrets(&value, &secrets)
}

#[napi]
pub fn redact_browser_url(value: String) -> String {
    redaction::redact_url(&value)
}
