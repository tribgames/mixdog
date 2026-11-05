//! The sign-in's redirect target: the loopback listener the browser is sent back to, and the
//! pasted-URL path for a remote sign-in. Only a GET of the exact callback path and host that
//! carries exactly the pending state (compared in constant time) and either one code or an
//! error finishes the login.

use std::collections::HashSet;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use url::Url;

use super::page;

/// Upper bound of a pasted redirect URL.
pub const CALLBACK_MAX_BYTES: usize = 64 * 1024;
/// A pasted URL carries the authorization code and is never echoed into an error, a log or a
/// status.
pub const INVALID_CALLBACK_PASTE: &str =
    "The pasted sign-in URL is invalid. Paste the full address the browser was redirected to after signing in.";
pub const CALLBACK_NOT_PENDING: &str = "MCP OAuth sign-in is not waiting for a callback";
pub const CALLBACK_PATH: &str = "/oauth/callback";

const REQUEST_HEAD_MAX: usize = 16 * 1024;
const REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(10);
/// The longest a callback page is held waiting for the login to report its outcome.
const OUTCOME_WAIT: Duration = Duration::from_secs(5 * 60);

pub fn same_state(supplied: Option<&str>, expected: &str) -> bool {
    let supplied = supplied.unwrap_or_default().as_bytes();
    let expected = expected.as_bytes();
    !expected.is_empty()
        && supplied.len() == expected.len()
        && supplied.iter().zip(expected).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

/// What a pasted redirect URL carries.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Pasted {
    Code(String),
    Denied,
}

/// The outcome of a redirect URL pasted from the browser for a pending login whose redirect URI
/// is `redirect_url` and state `state`. Anything that is not exactly that login's callback is
/// refused with a fixed message.
pub fn parse_pasted(pasted: &str, redirect_url: &str, state: &str) -> Result<Pasted, &'static str> {
    let invalid = INVALID_CALLBACK_PASTE;
    if pasted.len() > CALLBACK_MAX_BYTES {
        return Err(invalid);
    }
    let raw = mixdog_js::js_trim(pasted);
    let target = Url::parse(raw).map_err(|_| invalid)?;
    let expected = Url::parse(redirect_url).map_err(|_| invalid)?;
    if raw.contains('#')
        || !target.username().is_empty()
        || target.password().is_some()
        || target.origin() != expected.origin()
        || target.path() != expected.path()
    {
        return Err(invalid);
    }
    let mut seen = HashSet::new();
    for (key, value) in target.query_pairs() {
        if !seen.insert(key.to_string()) {
            return Err(invalid);
        }
        // The redirect URI's own parameters come back unchanged; any others an authorization
        // server adds (Google's scope/authuser/prompt) are ignored.
        if let Some((_, own)) = expected.query_pairs().find(|(k, _)| *k == key)
            && own != value
        {
            return Err(invalid);
        }
    }
    if expected.query_pairs().any(|(k, _)| !seen.contains(k.as_ref())) {
        return Err(invalid);
    }
    let value_of = |name: &str| target.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
    if !same_state(value_of("state").as_deref(), state) {
        return Err(invalid);
    }
    match (seen.contains("code"), seen.contains("error")) {
        (true, false) => value_of("code").filter(|c| !c.is_empty()).map(Pasted::Code).ok_or(invalid),
        (false, true) => Ok(Pasted::Denied),
        _ => Err(invalid),
    }
}

/// How the login ended, reported back so the held browser page can say so.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PageOutcome {
    Done,
    Failed { scope_not_granted: bool },
    /// Nobody is waiting for this callback any more.
    Stale,
}

/// A valid callback: `code` is `None` when the authorization server answered with an error.
pub struct Callback {
    pub code: Option<String>,
    /// Answers the held browser page once the code exchange and scope check ended.
    pub respond: oneshot::Sender<PageOutcome>,
}

pub struct Listener {
    pub port: u16,
    stop: CancellationToken,
}

impl Listener {
    /// Stops accepting; pages already held still finish.
    pub fn stopper(&self) -> CancellationToken {
        self.stop.clone()
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

struct Request {
    method: String,
    target: String,
    host: Option<String>,
}

async fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 2048];
    let read = async {
        loop {
            let n = stream.read(&mut chunk).await.ok()?;
            if n == 0 {
                return None;
            }
            buf.extend_from_slice(&chunk[..n]);
            if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                return Some(());
            }
            if buf.len() > REQUEST_HEAD_MAX {
                return None;
            }
        }
    };
    tokio::time::timeout(REQUEST_READ_TIMEOUT, read).await.ok()??;
    let head = String::from_utf8_lossy(&buf);
    let mut lines = head.lines();
    let mut first = lines.next()?.split(' ');
    let (method, target) = (first.next()?.to_owned(), first.next()?.to_owned());
    let host = lines
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("host"))
        .map(|(_, v)| v.trim().to_owned());
    Some(Request { method, target, host })
}

async fn write_page(stream: &mut TcpStream, status: &str, html: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
        page::CONTENT_TYPE,
        html.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

async fn answer(mut stream: TcpStream, port: u16, state: String, server: String, tx: mpsc::UnboundedSender<Callback>) {
    let invalid = page::error_html("This sign-in link is invalid or has expired.");
    let Some(request) = read_request(&mut stream).await else { return };
    let Ok(target) = Url::parse(&format!("http://127.0.0.1:{port}{}", request.target)) else {
        return write_page(&mut stream, "400 Bad Request", &invalid).await;
    };
    let all = |name: &str| target.query_pairs().filter(|(k, _)| k == name).map(|(_, v)| v.into_owned()).collect::<Vec<_>>();
    let states = all("state");
    let valid = request.method == "GET"
        && request.host.as_deref() == Some(&format!("127.0.0.1:{port}"))
        && target.path() == CALLBACK_PATH
        && states.len() == 1
        && same_state(states.first().map(String::as_str), &state);
    let has_error = target.query_pairs().any(|(k, _)| k == "error");
    if !valid || (!has_error && all("code").len() != 1) {
        return write_page(&mut stream, "400 Bad Request", &invalid).await;
    }
    if has_error {
        // The authorization server's error text is never reflected.
        write_page(&mut stream, "400 Bad Request", &page::error_html(&format!("Sign-in to {server} was not completed."))).await;
        let (respond, _) = oneshot::channel();
        let _ = tx.send(Callback { code: None, respond });
        return;
    }
    let (respond, outcome) = oneshot::channel();
    if tx.send(Callback { code: all("code").pop(), respond }).is_err() {
        return write_page(&mut stream, "400 Bad Request", &invalid).await;
    }
    // The code is only the start: the page stays open until the login reports its outcome.
    match tokio::time::timeout(OUTCOME_WAIT, outcome).await {
        Ok(Ok(PageOutcome::Done)) => write_page(&mut stream, "200 OK", &page::success_html(&server)).await,
        Ok(Ok(PageOutcome::Stale)) => write_page(&mut stream, "400 Bad Request", &invalid).await,
        Ok(Ok(PageOutcome::Failed { scope_not_granted })) => {
            write_page(&mut stream, "400 Bad Request", &page::error_html(&page::failure_reason(&server, scope_not_granted))).await;
        }
        _ => {
            write_page(&mut stream, "400 Bad Request", &page::error_html(&page::failure_reason(&server, false))).await;
        }
    }
}

/// Listens on the loopback `port` (0: any free one) for the callback of the login whose state is
/// `state`; valid callbacks arrive on `tx`.
pub async fn listen(
    port: u16,
    state: String,
    server: String,
    tx: mpsc::UnboundedSender<Callback>,
) -> std::io::Result<Listener> {
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    let port = listener.local_addr()?.port();
    let stop = CancellationToken::new();
    let token = stop.clone();
    mixdog_rt::spawn("mcp.oauth.callback", mixdog_rt::TaskClass::Work, async move {
        loop {
            let accepted = tokio::select! {
                () = token.cancelled() => break,
                accepted = listener.accept() => accepted,
            };
            let Ok((stream, _)) = accepted else { continue };
            // Held pages finish on their own tasks after the listener stops accepting.
            let (state, server, tx) = (state.clone(), server.clone(), tx.clone());
            mixdog_rt::spawn("mcp.oauth.callback.page", mixdog_rt::TaskClass::Work, answer(stream, port, state, server, tx));
        }
    });
    Ok(Listener { port, stop })
}

#[cfg(test)]
mod tests {
    use super::*;

    const REDIRECT: &str = "http://127.0.0.1:5555/oauth/callback";

    #[test]
    fn a_paste_must_be_exactly_the_pending_logins_callback() {
        let ok = |url: &str| parse_pasted(url, REDIRECT, "st4te");
        assert_eq!(ok(&format!("{REDIRECT}?code=abc&state=st4te&scope=x")), Ok(Pasted::Code("abc".into())));
        assert_eq!(ok(&format!("{REDIRECT}?error=access_denied&state=st4te")), Ok(Pasted::Denied));
        for bad in [
            format!("{REDIRECT}?code=abc&state=other"),
            format!("{REDIRECT}?code=abc&code=def&state=st4te"),
            format!("{REDIRECT}?code=abc&error=x&state=st4te"),
            format!("{REDIRECT}?code=abc&state=st4te#frag"),
            "http://127.0.0.1:5555/elsewhere?code=abc&state=st4te".to_owned(),
            "http://127.0.0.1:6666/oauth/callback?code=abc&state=st4te".to_owned(),
            "not a url".to_owned(),
        ] {
            assert_eq!(ok(&bad), Err(INVALID_CALLBACK_PASTE), "{bad}");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_loopback_holds_the_page_until_the_outcome_and_refuses_other_requests() {
        let _runtime = mixdog_rt::testing::tokens();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let listener = listen(0, "st4te".into(), "Acme".into(), tx).await.unwrap();
        let port = listener.port;
        let get = move |path: String| async move {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            stream.write_all(format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").as_bytes()).await.unwrap();
            let mut out = String::new();
            stream.read_to_string(&mut out).await.unwrap();
            out
        };
        assert!(get("/oauth/callback?code=c&state=wrong".into()).await.starts_with("HTTP/1.1 400"));
        let page = tokio::spawn(get("/oauth/callback?code=c0de&state=st4te".into()));
        let callback = rx.recv().await.unwrap();
        assert_eq!(callback.code.as_deref(), Some("c0de"));
        callback.respond.send(PageOutcome::Done).unwrap();
        let body = page.await.unwrap();
        assert!(body.starts_with("HTTP/1.1 200") && body.contains("Acme"));
    }
}
