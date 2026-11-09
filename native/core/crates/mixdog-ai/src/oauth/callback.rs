//! The loopback redirect receiver of browser logins (PW §6.2) as each Node provider's callback server
//! answers the browser: the same pages, statuses and headers, and the same decision of which request
//! ends the login (`*-oauth*.mjs`, `lib/oauth-page.mjs`). The code exchange runs inside the request
//! that brought the code, because the page the browser is left with is the exchange's outcome. The
//! authorization server's error text is never reflected.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;

use mixdog_core_api::domain::login::LoginFailure;
use mixdog_core_api::domain::login_page;
use tokio::net::TcpListener;
use tokio::sync::OnceCell;
use url::Url;

use super::loopback;
use super::loopback::Handled;
use super::loopback::MAX_REQUEST;
use super::loopback::Request;
use super::loopback::Response;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CallbackError {
    /// The authorization server answered with an `error` parameter.
    Denied,
    StateMismatch,
    Malformed,
}

/// A code exchange that failed: what the login ends with, and the part of the error text Node's
/// failure page shows (`oauthFailureReason`: only an error built from codes, statuses and redacted
/// bodies is quoted, anything else is left to the summary line).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Refusal {
    pub failure: LoginFailure,
    pub detail: Option<String>,
}

impl From<LoginFailure> for Refusal {
    fn from(failure: LoginFailure) -> Self {
        Self { failure, detail: None }
    }
}

pub type Exchanged = Result<Option<String>, Refusal>;
/// The flow's code exchange.
pub type Exchange = Arc<dyn Fn(String) -> Pin<Box<dyn Future<Output = Exchanged> + Send>> + Send + Sync>;

/// How the callback server ended.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Settled {
    Exchanged(Result<Option<String>, LoginFailure>),
    Rejected(CallbackError),
}

/// Which of Node's callback servers a provider has: they differ in what they answer to a request
/// that is not a usable callback.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Style {
    /// Anthropic, OpenAI, Grok: a callback without a code or with another state gets the invalid-callback
    /// page; OpenAI also ends the login when that callback carries this login's own state.
    Standard { ends_on_codeless: bool },
    /// Devin: `GET` only, a page for each way a callback can be wrong, a denial ends the login.
    Devin,
    /// Antigravity: plain-text answers for a wrong state or a missing code, one fixed failure page.
    Antigravity,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct CallbackPages {
    /// The name on the success page (`oauthSuccessHtml(name)`).
    pub name: &'static str,
    /// The first line of the failure page of a failed exchange.
    pub failure_summary: &'static str,
    pub style: Style,
}

pub mod pages {
    use super::CallbackPages;
    use super::Style;

    pub const ANTHROPIC: CallbackPages = CallbackPages {
        name: "Claude",
        failure_summary: "Claude could not complete the token exchange.",
        style: Style::Standard { ends_on_codeless: false },
    };
    pub const OPENAI: CallbackPages = CallbackPages {
        name: "OpenAI",
        failure_summary: "OpenAI could not complete the token exchange.",
        style: Style::Standard { ends_on_codeless: true },
    };
    pub const GROK: CallbackPages = CallbackPages {
        name: "Grok",
        failure_summary: "Grok could not complete the token exchange.",
        style: Style::Standard { ends_on_codeless: false },
    };
    pub const DEVIN: CallbackPages = CallbackPages {
        name: "Devin",
        failure_summary: "Devin could not complete the token exchange.",
        style: Style::Devin,
    };
    pub const ANTIGRAVITY: CallbackPages = CallbackPages {
        name: "Antigravity",
        failure_summary: "Antigravity sign-in was not completed. Return to Mixdog for the error details and any account verification link.",
        style: Style::Antigravity,
    };
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let mut diff = (a.len() ^ b.len()) as u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Checks the query of a callback against the flow's `state`.
fn code_from_query(query: &str, state: &str) -> Result<String, CallbackError> {
    let (mut states, mut codes, mut errors) = (Vec::new(), Vec::new(), 0usize);
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        match key.as_ref() {
            "state" => states.push(value.into_owned()),
            "code" => codes.push(value.into_owned()),
            "error" => errors += 1,
            _ => {}
        }
    }
    let [got] = states.as_slice() else {
        return Err(CallbackError::StateMismatch);
    };
    if !constant_time_eq(got, state) {
        return Err(CallbackError::StateMismatch);
    }
    match (codes.as_slice(), errors) {
        ([code], 0) if !code.is_empty() => Ok(code.clone()),
        ([], 1..) => Err(CallbackError::Denied),
        _ => Err(CallbackError::Malformed),
    }
}

/// A callback URL the user pasted (flows without a loopback listener).
pub fn parse_pasted_callback(
    pasted: &str,
    redirect_uri: &str,
    state: &str,
) -> Result<String, CallbackError> {
    if pasted.len() > MAX_REQUEST {
        return Err(CallbackError::Malformed);
    }
    let url = Url::parse(mixdog_js::js_trim(pasted)).map_err(|_| CallbackError::Malformed)?;
    let redirect = Url::parse(redirect_uri).map_err(|_| CallbackError::Malformed)?;
    let same_target = url.origin() == redirect.origin() && url.path() == redirect.path();
    if !same_target
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(CallbackError::Malformed);
    }
    code_from_query(url.query().unwrap_or(""), state)
}

fn page(status: u16, html: String) -> Response {
    Response::new(status).body(login_page::CONTENT_TYPE, html)
}

fn plain(status: u16, text: &str) -> Response {
    Response::new(status).untyped_body(text)
}

/// What every callback server of this module shares while it serves.
struct Serving {
    /// The origin a request target is resolved against (`new URL(req.url, origin)`).
    origin: Url,
    path: &'static str,
    state: String,
    pages: CallbackPages,
    exchange: Exchange,
    /// An authorization code is spent once: the first callback starts the exchange and a duplicate
    /// joins it instead of failing the login.
    exchanged: OnceCell<Exchanged>,
}

type Answer = (Response, Option<Settled>);

impl Serving {
    fn failure_reason(&self, refusal: &Refusal) -> String {
        match &refusal.detail {
            Some(detail) => format!("{}\n{detail}", self.pages.failure_summary),
            None => self.pages.failure_summary.to_owned(),
        }
    }

    /// The exchange of `code` (or the one already running), and the page its outcome leaves the browser with.
    async fn exchange(&self, code: String) -> Answer {
        match self.exchanged.get_or_init(|| (self.exchange)(code)).await {
            Ok(account) => (
                page(200, login_page::success_html(self.pages.name)),
                Some(Settled::Exchanged(Ok(account.clone()))),
            ),
            Err(refusal) => (
                page(500, login_page::error_html(&self.failure_reason(refusal))),
                Some(Settled::Exchanged(Err(refusal.failure.clone()))),
            ),
        }
    }

    /// A late denial must not cancel an already accepted code.
    fn denial(&self, error: CallbackError) -> Option<Settled> {
        (!self.exchanged.initialized()).then_some(Settled::Rejected(error))
    }

    async fn answer(&self, request: Request) -> Answer {
        // `new URL(req.url || '/', origin)`: the same resolution, so `/x/..<path>` or `<path>/` are judged as Node judges them.
        let Ok(url) = self.origin.join(&request.target) else {
            return (page(400, login_page::error_html("The sign-in callback was malformed.")), None);
        };
        let first = |name: &str| url.query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.into_owned());
        let state_matches = first("state").is_some_and(|got| constant_time_eq(&got, &self.state));
        let named = |name: &str| first(name).filter(|value| !value.is_empty());
        let wrong_path = url.path() != self.path;
        match self.pages.style {
            Style::Standard { ends_on_codeless } => {
                if wrong_path {
                    return (Response::new(404), None);
                }
                let Some(code) = named("code").filter(|_| state_matches) else {
                    let settles = ends_on_codeless && state_matches;
                    let error = if named("error").is_some() { CallbackError::Denied } else { CallbackError::Malformed };
                    return (
                        page(400, login_page::error_html("The sign-in callback was invalid or did not match this login.")),
                        settles.then(|| self.denial(error)).flatten(),
                    );
                };
                self.exchange(code).await
            }
            Style::Devin => {
                if request.method != "GET" || wrong_path {
                    return (Response::new(404), None);
                }
                if !state_matches {
                    return (page(400, login_page::error_html("The sign-in callback did not match this login.")), None);
                }
                if named("error").is_some() {
                    return (
                        page(400, login_page::error_html("Devin did not authorize this sign-in.")),
                        self.denial(CallbackError::Denied),
                    );
                }
                let code = first("code").map(|code| mixdog_js::js_trim(&code).to_owned()).filter(|code| !code.is_empty());
                match code {
                    Some(code) => self.exchange(code).await,
                    None => (page(400, login_page::error_html("The sign-in callback carried no authorization code.")), None),
                }
            }
            Style::Antigravity => {
                if wrong_path {
                    return (Response::new(404), None);
                }
                if !state_matches {
                    return (plain(400, "Invalid OAuth state"), None);
                }
                if named("error").is_some() {
                    return (
                        page(400, login_page::error_html(self.pages.failure_summary)),
                        self.denial(CallbackError::Denied),
                    );
                }
                let code = first("code").map(|code| mixdog_js::js_trim(&code).to_owned()).filter(|code| !code.is_empty());
                match code {
                    Some(code) => self.exchange(code).await,
                    None => (plain(400, "Missing authorization code"), None),
                }
            }
        }
    }
}

/// The redirect a provider registered: the host as it appears in the
/// `redirect_uri`, the port (0 = any free port, for providers that register
/// none) and the path. The authorization server compares the URI byte for
/// byte, so each provider states exactly what Node sends (`redirects`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Redirect {
    pub host: &'static str,
    pub port: u16,
    pub path: &'static str,
}

/// Each provider's redirect, as `*-oauth*.mjs` has it. The host is part of
/// the registration: Anthropic and OpenAI register `localhost`, the others
/// `127.0.0.1` (OpenAI listens on 127.0.0.1 but registers `localhost`).
pub mod redirects {
    use super::Redirect;

    pub const ANTHROPIC: Redirect = Redirect { host: "localhost", port: 54545, path: "/callback" };
    pub const OPENAI: Redirect = Redirect { host: "localhost", port: 1455, path: "/auth/callback" };
    pub const ANTIGRAVITY: Redirect = Redirect { host: "127.0.0.1", port: 51121, path: "/oauth-callback" };
    pub const GROK: Redirect = Redirect { host: "127.0.0.1", port: 56121, path: "/callback" };
    pub const DEVIN: Redirect = Redirect { host: "127.0.0.1", port: 59653, path: "/callback" };
    /// MiMo registers no port: any free one, on `localhost`.
    pub const MIMO: Redirect = Redirect { host: "localhost", port: 0, path: "/" };
}

impl Redirect {
    pub fn uri(&self, port: u16) -> String {
        format!("http://{}:{port}{}", self.host, self.path)
    }
}

pub struct CallbackServer {
    listeners: Vec<TcpListener>,
    redirect: Redirect,
    port: u16,
    state: String,
    pages: CallbackPages,
}

impl CallbackServer {
    /// Listens on every loopback address the redirect's host can reach: for
    /// `localhost` both IPv4 and IPv6 (a browser may try either), for an IP
    /// literal that address.
    pub async fn bind(redirect: Redirect, state: String, pages: CallbackPages) -> io::Result<Self> {
        let (listeners, port) = loopback::bind(redirect.port, redirect.host == "localhost").await?;
        Ok(Self {
            listeners,
            redirect,
            port,
            state,
            pages,
        })
    }

    pub fn redirect_uri(&self) -> String {
        self.redirect.uri(self.port)
    }

    /// Serves until a callback ends the login: the exchange of the first code
    /// (its page is the exchange's outcome), or a request the provider's server
    /// treats as the login's end. Other requests are answered and ignored.
    /// Dropping the future closes the listener.
    pub async fn wait(self, exchange: Exchange) -> Settled {
        let origin = Url::parse(&format!("http://{}:{}", self.redirect.host, self.port)).expect("a loopback origin parses");
        let serving = Arc::new(Serving {
            origin,
            path: self.redirect.path,
            state: self.state,
            pages: self.pages,
            exchange,
            exchanged: OnceCell::new(),
        });
        loopback::serve(self.listeners, move |request: Request| -> Handled<Settled> {
            let serving = serving.clone();
            Box::pin(async move { serving.answer(request).await })
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The redirect URIs exactly as the Node providers send them
    /// (`anthropic-oauth-credentials.mjs`, `openai-oauth-login.mjs`,
    /// `antigravity-oauth-tokens.mjs`, `grok-oauth-tokens.mjs`,
    /// `devin-auth.mjs`, `mimo-oauth-login.mjs`).
    #[test]
    fn each_provider_redirect_is_nodes_uri() {
        assert_eq!(redirects::ANTHROPIC.uri(54545), "http://localhost:54545/callback");
        assert_eq!(redirects::OPENAI.uri(1455), "http://localhost:1455/auth/callback");
        assert_eq!(redirects::ANTIGRAVITY.uri(51121), "http://127.0.0.1:51121/oauth-callback");
        assert_eq!(redirects::GROK.uri(56121), "http://127.0.0.1:56121/callback");
        assert_eq!(redirects::DEVIN.uri(59653), "http://127.0.0.1:59653/callback");
        assert_eq!(redirects::MIMO.uri(40123), "http://localhost:40123/");
        for fixed in [
            redirects::ANTHROPIC,
            redirects::OPENAI,
            redirects::ANTIGRAVITY,
            redirects::GROK,
            redirects::DEVIN,
        ] {
            assert_ne!(fixed.port, 0);
        }
    }

    #[test]
    fn pasted_callback_is_held_to_the_same_rules() {
        let redirect = "http://127.0.0.1:1455/cb";
        assert_eq!(
            parse_pasted_callback("http://127.0.0.1:1455/cb?code=c&state=S", redirect, "S"),
            Ok("c".into())
        );
        for bad in [
            "http://127.0.0.1:1456/cb?code=c&state=S",
            "http://127.0.0.1:1455/cb?code=c&state=S#frag",
            "http://u:p@127.0.0.1:1455/cb?code=c&state=S",
            "not a url",
        ] {
            assert_eq!(
                parse_pasted_callback(bad, redirect, "S"),
                Err(CallbackError::Malformed),
                "{bad}"
            );
        }
    }

}