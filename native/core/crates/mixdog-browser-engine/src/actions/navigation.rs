//! Owner: s4-engine-actions-observe-nav
//! Moving between documents (`actions/navigation.ts`): `open`, `navigate` (a URL, or a reload) and `back`. The URL a command names
//! is admitted here by the rules of `mixdog-browser-policy` before the host is asked to load it, and the host admits it once more
//! against the address it resolves to; the load itself, its bound, a download that ends it and a dialog that opens during it are the
//! host's (`host/browser/page/navigate`). What the page then looks like is the runner's reply after the navigation.

use mixdog_app_protocol::v2::browser_engine::BrowserMailLink;
use mixdog_app_protocol::v2::browser_engine::BrowserNavigateKind;
use mixdog_app_protocol::v2::browser_engine::HostBrowserPageNavigateParams;
use mixdog_app_protocol::v2::browser_engine::PageFacts;
use mixdog_app_protocol::v2::browser_engine::Precondition;
use mixdog_browser_policy::url_policy::MAIL_LINK_WINDOW_MS;
use mixdog_browser_policy::url_policy::MailLink;
use mixdog_browser_policy::url_policy::UrlPolicy;
use mixdog_browser_policy::url_policy::normalize_agent_url;
use mixdog_rt::CancelView;
use serde_json::Value;

use super::observe::ActionError;
use super::observe::string_arg;
use crate::port::BrowserHost;
use crate::reply::reply::ToolReply;

/// The page a navigation moves, and the guard the move is decided against (a navigation always carries one).
#[derive(Clone, Copy)]
pub struct NavigateCall<'a> {
    pub host: &'a dyn BrowserHost,
    pub page_id: &'a str,
    pub expect: &'a Precondition,
    pub cancel: &'a CancelView,
}

/// How a navigation ended.
#[derive(Debug, Clone, PartialEq)]
pub enum NavigateOutcome {
    /// The host moved the page; these are its facts. A dialog that opened during the load is among them, and the runner answers
    /// with it instead of a snapshot.
    Moved(Box<PageFacts>),
    /// There was nowhere to go: an answer, not a failure (the text is what the agent reads).
    Refused(String),
}

/// `open`: the page the command addressed is already there (the runner resolved or opened it).
pub fn open(background: bool) -> ToolReply {
    ToolReply::text(if background { "Background browser page is ready." } else { "Browser Use page is ready." })
}

/// The runtime-set provenance of a navigate (`command.mail_link`, never a tool argument): this exact URL is a link of a mail the core
/// read for the session.
fn mail_link_of(command: &Value) -> Option<MailLink> {
    let link = command.get("mail_link")?;
    Some(MailLink {
        url: link.get("url")?.as_str()?.to_owned(),
        from_domain: link.get("from_domain")?.as_str()?.to_owned(),
        read_at: link.get("read_at").and_then(Value::as_i64),
    })
}

/// The wire form of a mail link: the host works out the window from when it ends.
fn wire_mail_link(link: &MailLink) -> Option<BrowserMailLink> {
    Some(BrowserMailLink { url: link.url.clone(), expires_at: link.read_at? + MAIL_LINK_WINDOW_MS })
}

/// `navigate`: to `url`, or, with `reload: true`, the same document again. Exactly one of the two.
pub async fn navigate(call: &NavigateCall<'_>, command: &Value, policy: &UrlPolicy, now_ms: i64) -> Result<NavigateOutcome, ActionError> {
    let url = string_arg(command, "url");
    if command.get("reload") == Some(&Value::Bool(true)) {
        if !url.is_empty() {
            return Err(ActionError::failed("navigate accepts url or reload=true, not both"));
        }
        return moved(call, BrowserNavigateKind::Reload, None, None).await;
    }
    if url.is_empty() {
        return Err(ActionError::failed("navigate requires url or reload=true"));
    }
    let link = mail_link_of(command);
    let admitted = normalize_agent_url(&url, policy, link.as_ref(), now_ms).map_err(|refusal| ActionError::failed(refusal.reason))?;
    moved(call, BrowserNavigateKind::Url, Some(admitted), link.as_ref().and_then(wire_mail_link)).await
}

/// `back`: one step back in the page's history. Only the backward step is a gesture: a forward move is a `navigate` to the URL the
/// earlier snapshot already showed.
pub async fn back(call: &NavigateCall<'_>) -> Result<NavigateOutcome, ActionError> {
    moved(call, BrowserNavigateKind::Back, None, None).await
}

async fn moved(call: &NavigateCall<'_>, kind: BrowserNavigateKind, url: Option<String>, mail_link: Option<BrowserMailLink>) -> Result<NavigateOutcome, ActionError> {
    let params = HostBrowserPageNavigateParams { page_id: call.page_id.to_owned(), kind, url, mail_link, expect: call.expect.clone() };
    let answer = call.host.page_navigate(params, call.cancel.token()).await?;
    Ok(match answer.refused {
        Some(refusal) => NavigateOutcome::Refused(refusal.reason),
        None => NavigateOutcome::Moved(Box::new(answer.facts)),
    })
}

#[cfg(test)]
mod tests {
    use mixdog_rt::CancelSource;
    use serde_json::json;

    use super::*;
    use crate::error::HostCallError;
    use crate::fake::Expect;
    use crate::fake::FakeHost;
    use crate::fake::page_facts;

    fn expect() -> Precondition {
        Precondition { document_id: "p1:1".into(), origin: None, url: None, child_sessions: None, receiver_key: None, snapshot_id: None }
    }

    fn navigated(refused: Option<&str>) -> Expect {
        let mut result = json!({"facts": page_facts("p1", 2)});
        if let Some(reason) = refused {
            result["refused"] = json!({"reason": reason});
        }
        Expect::ok("host/browser/page/navigate", result)
    }

    async fn run(host: &FakeHost, command: Value) -> Result<NavigateOutcome, ActionError> {
        let source = CancelSource::new();
        let view = source.view();
        let guard = expect();
        let call = NavigateCall { host, page_id: "p1", expect: &guard, cancel: &view };
        navigate(&call, &command, &UrlPolicy::default(), 1_000).await
    }

    #[test]
    fn open_says_which_kind_of_page_is_ready() {
        assert_eq!(open(false).text, "Browser Use page is ready.");
        assert_eq!(open(true).text, "Background browser page is ready.");
    }

    #[tokio::test]
    async fn a_url_is_admitted_and_sent_normalised_with_the_guard() {
        let host = FakeHost::scripted(vec![navigated(None).with_params(json!({"pageId": "p1", "kind": "url", "url": "https://example.com/a", "expect": {"documentId": "p1:1"}}))]);
        let outcome = run(&host, json!({"url": "example.com/a"})).await.expect("navigates");
        assert!(matches!(outcome, NavigateOutcome::Moved(facts) if facts.page_id == "p1"));
        host.finish().expect("one call");
    }

    #[tokio::test]
    async fn a_refused_url_never_reaches_the_host() {
        let host = FakeHost::scripted(Vec::new());
        for url in ["file:///etc/passwd", "https://user:pw@example.com/", "http://169.254.169.254/latest", "https://example.com/?api_key=abcdefabcdefabcdefabcd1234"] {
            let error = run(&host, json!({"url": url})).await.expect_err(url);
            assert!(matches!(error, ActionError::Failed(_)), "{url}: {error:?}");
        }
        assert!(host.calls().is_empty());
    }

    #[tokio::test]
    async fn url_and_reload_are_exclusive_and_one_is_required() {
        let host = FakeHost::scripted(Vec::new());
        let both = run(&host, json!({"url": "https://example.com/", "reload": true})).await.expect_err("both");
        assert_eq!(both, ActionError::failed("navigate accepts url or reload=true, not both"));
        let neither = run(&host, json!({})).await.expect_err("neither");
        assert_eq!(neither, ActionError::failed("navigate requires url or reload=true"));
        let falsy = run(&host, json!({"reload": false})).await.expect_err("reload false is no reload");
        assert_eq!(falsy, ActionError::failed("navigate requires url or reload=true"));
        assert!(host.calls().is_empty());
    }

    #[tokio::test]
    async fn a_reload_asks_the_host_to_reload_without_a_url() {
        let host = FakeHost::scripted(vec![navigated(None).with_params(json!({"kind": "reload"}))]);
        run(&host, json!({"reload": true})).await.expect("reloads");
        assert!(host.calls()[0].params.get("url").is_none());
        host.finish().expect("one call");
    }

    #[tokio::test]
    async fn a_mail_link_reaches_the_host_with_the_end_of_its_window() {
        let url = "https://accounts.example.com/verify?token=abcdefabcdefabcdefabcdef1234567890";
        let host = FakeHost::scripted(vec![navigated(None)]);
        let link = json!({"url": url, "from_domain": "example.com", "read_at": 500});
        run(&host, json!({"url": url, "mail_link": link})).await.expect("the mailed link opens");
        let sent = &host.calls()[0].params["mailLink"];
        assert_eq!(sent["url"], url);
        assert_eq!(sent["expiresAt"], 500 + MAIL_LINK_WINDOW_MS);
    }

    #[tokio::test]
    async fn a_token_url_without_a_mail_link_is_refused() {
        let host = FakeHost::scripted(Vec::new());
        let url = "https://accounts.example.com/verify?token=abcdefabcdefabcdefabcdef1234567890";
        assert!(run(&host, json!({"url": url})).await.is_err());
        assert!(host.calls().is_empty());
    }

    #[tokio::test]
    async fn back_is_a_step_and_an_empty_history_is_an_answer() {
        let source = CancelSource::new();
        let view = source.view();
        let guard = expect();
        let host = FakeHost::scripted(vec![navigated(None).with_params(json!({"kind": "back"})), navigated(Some("Cannot go back: no earlier history entry."))]);
        let call = NavigateCall { host: &host, page_id: "p1", expect: &guard, cancel: &view };
        assert!(matches!(back(&call).await, Ok(NavigateOutcome::Moved(_))));
        assert_eq!(back(&call).await, Ok(NavigateOutcome::Refused("Cannot go back: no earlier history entry.".into())));
        host.finish().expect("two calls");
    }

    #[tokio::test]
    async fn a_failed_load_is_the_hosts_failure_as_it_is() {
        let host = FakeHost::scripted(vec![Expect::err("host/browser/page/navigate", HostCallError::Failed { message: "navigation failed: net::ERR_NAME_NOT_RESOLVED".into() })]);
        let error = run(&host, json!({"url": "https://nowhere.example/"})).await.expect_err("fails");
        assert_eq!(error, ActionError::Host(HostCallError::Failed { message: "navigation failed: net::ERR_NAME_NOT_RESOLVED".into() }));
    }
}
