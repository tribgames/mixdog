//! The loopback redirect receiver of browser logins (PW §6.2), with the
//! strictest validation applied to every provider: `GET` only, the redirect's
//! own `Host`, the fixed path, exactly one `state` compared in constant time,
//! exactly one of `code` / `error`. The authorization server's error text is
//! never reflected.

use std::io;

use tokio::net::TcpListener;
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

/// Checks one request. `Err(None)` is a request that is not this flow's
/// callback at all (answered 400, ignored); `Err(Some(e))` is a callback
/// that failed.
fn parse_request(
    request: &Request,
    host: &str,
    path: &str,
    state: &str,
) -> Result<String, Option<CallbackError>> {
    if request.method != "GET" || request.header("host") != Some(host) || request.path() != path {
        return Err(None);
    }
    code_from_query(request.raw_query(), state).map_err(Some)
}

fn page(status: u16, ok: bool) -> Response {
    let (title, body) = if ok {
        ("Signed in", "Sign-in complete. You can close this tab. / 로그인이 완료되었습니다. 이 탭을 닫아도 됩니다.")
    } else {
        ("Sign-in failed", "Sign-in did not complete. Return to Mixdog. / 로그인이 완료되지 않았습니다. Mixdog로 돌아가세요.")
    };
    Response::new(status)
        .header("cache-control", "no-store")
        .header("referrer-policy", "no-referrer")
        .body(
            "text/html; charset=utf-8",
            format!("<!doctype html><meta charset=utf-8><title>{title}</title><p>{body}</p>"),
        )
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
}

impl CallbackServer {
    /// Listens on every loopback address the redirect's host can reach: for
    /// `localhost` both IPv4 and IPv6 (a browser may try either), for an IP
    /// literal that address.
    pub async fn bind(redirect: Redirect, state: String) -> io::Result<Self> {
        let (listeners, port) = loopback::bind(redirect.port, redirect.host == "localhost").await?;
        Ok(Self {
            listeners,
            redirect,
            port,
            state,
        })
    }

    pub fn redirect_uri(&self) -> String {
        self.redirect.uri(self.port)
    }

    /// Serves until the first valid callback; the result is its code or why it
    /// failed. Other requests get a 400 and are ignored. Dropping the future
    /// closes the listener.
    pub async fn wait(self) -> Result<String, CallbackError> {
        let host = format!("{}:{}", self.redirect.host, self.port);
        let (path, state) = (self.redirect.path, self.state);
        loopback::serve(self.listeners, move |request: Request| -> Handled<Result<String, CallbackError>> {
            let outcome = parse_request(&request, &host, path, &state);
            Box::pin(async move {
                match outcome {
                    Err(None) => (page(400, false), None),
                    Ok(code) => (page(200, true), Some(Ok(code))),
                    Err(Some(error)) => (page(400, false), Some(Err(error))),
                }
            })
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpStream;

    const HOST: &str = "127.0.0.1:1455";

    fn request(target: &str, host: &str) -> String {
        format!("GET {target} HTTP/1.1\r\nHost: {host}\r\n\r\n")
    }

    fn req(method: &str, target: &str, host: &str) -> Request {
        Request {
            method: method.into(),
            target: target.into(),
            headers: vec![("Host".into(), host.into())],
            body: Vec::new(),
        }
    }

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
    fn valid_callback_yields_the_code() {
        let head = req("GET", "/cb?code=abc%20d&state=S", HOST);
        assert_eq!(parse_request(&head, HOST, "/cb", "S"), Ok("abc d".into()));
    }

    #[test]
    fn rejections() {
        let ok = |t: &str| parse_request(&req("GET", t, HOST), HOST, "/cb", "S");
        assert_eq!(ok("/other?code=c&state=S"), Err(None));
        assert_eq!(
            parse_request(&req("GET", "/cb?code=c&state=S", "evil.test"), HOST, "/cb", "S"),
            Err(None)
        );
        assert_eq!(
            parse_request(&req("POST", "/cb?code=c&state=S", HOST), HOST, "/cb", "S"),
            Err(None)
        );
        assert_eq!(ok("/cb?code=c&state=X"), Err(Some(CallbackError::StateMismatch)));
        assert_eq!(ok("/cb?code=c"), Err(Some(CallbackError::StateMismatch)));
        assert_eq!(ok("/cb?code=c&state=S&state=S"), Err(Some(CallbackError::StateMismatch)));
        assert_eq!(ok("/cb?code=a&code=b&state=S"), Err(Some(CallbackError::Malformed)));
        assert_eq!(ok("/cb?code=c&error=x&state=S"), Err(Some(CallbackError::Malformed)));
        assert_eq!(ok("/cb?error=access_denied&state=S"), Err(Some(CallbackError::Denied)));
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

    #[tokio::test]
    async fn server_answers_the_browser_and_returns_the_code() {
        mixdog_rt::testing::tokens();
        let redirect = Redirect { host: "localhost", port: 0, path: "/cb" };
        let server = CallbackServer::bind(redirect, "S".into()).await.unwrap();
        let port = server.port;
        assert_eq!(server.redirect_uri(), format!("http://localhost:{port}/cb"));
        let waiting = tokio::spawn(server.wait());
        let mut stray = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stray.write_all(request("/nope", &format!("localhost:{port}")).as_bytes()).await.unwrap();
        let mut reply = String::new();
        stray.read_to_string(&mut reply).await.unwrap();
        assert!(reply.starts_with("HTTP/1.1 400"));
        let mut browser = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        browser
            .write_all(request("/cb?code=zz&state=S", &format!("localhost:{port}")).as_bytes())
            .await
            .unwrap();
        let mut reply = String::new();
        browser.read_to_string(&mut reply).await.unwrap();
        assert!(reply.contains("cache-control: no-store") && reply.starts_with("HTTP/1.1 200"));
        assert_eq!(waiting.await.unwrap(), Ok("zz".into()));
    }
}