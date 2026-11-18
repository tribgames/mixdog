//! What the user's browser is shown by the loopback callback of a browser sign-in, and which request ends the login, for
//! each style of callback server (Anthropic/OpenAI/Grok, Devin, Antigravity).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_ai::oauth::CallbackPages;
use mixdog_ai::oauth::CallbackServer;
use mixdog_ai::oauth::Redirect;
use mixdog_ai::oauth::Refusal;
use mixdog_ai::oauth::pages;
use mixdog_core_api::domain::login::LoginFailure;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

const STATE: &str = "state-1";

type Outcome = Pin<Box<dyn Future<Output = Result<Option<String>, Refusal>> + Send>>;

struct Served {
    port: u16,
    /// The codes the exchange was asked to redeem.
    codes: Arc<Mutex<Vec<String>>>,
    login: tokio::task::JoinHandle<String>,
}

/// A callback server for `pages` whose code exchange answers `outcome`; its end is the `Debug` text of how it settled.
async fn serve(pages: CallbackPages, outcome: Result<Option<String>, Refusal>) -> Served {
    mixdog_rt::testing::tokens();
    let redirect = Redirect { host: "127.0.0.1", port: 0, path: "/callback" };
    let server = CallbackServer::bind(redirect, STATE.to_owned(), pages).await.unwrap();
    let port = url::Url::parse(&server.redirect_uri()).unwrap().port().unwrap();
    let codes = Arc::new(Mutex::new(Vec::new()));
    let seen = codes.clone();
    let exchange = Arc::new(move |code: String| -> Outcome {
        seen.lock().unwrap().push(code);
        let outcome = outcome.clone();
        Box::pin(async move { outcome })
    });
    let login = tokio::spawn(async move { format!("{:?}", server.wait(exchange).await) });
    Served { port, codes, login }
}

struct Answer {
    status: String,
    headers: Vec<(String, String)>,
    body: String,
}

impl Answer {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

async fn request(port: u16, method: &str, target: &str) -> Answer {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream.write_all(format!("{method} {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).await.unwrap();
    let text = String::from_utf8(bytes).unwrap();
    let (head, body) = text.split_once("\r\n\r\n").unwrap();
    let mut lines = head.split("\r\n");
    let status = lines.next().unwrap().to_owned();
    let headers = lines.map(|l| l.split_once(':').unwrap()).map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned())).collect();
    Answer { status, headers, body: body.to_owned() }
}

fn callback(query: &str) -> String {
    format!("/callback?{query}")
}

fn good() -> String {
    callback(&format!("code=C1&state={STATE}"))
}

fn account() -> Result<Option<String>, Refusal> {
    Ok(Some("acct-1".to_owned()))
}

fn failed(detail: Option<&str>) -> Result<Option<String>, Refusal> {
    Err(Refusal { failure: LoginFailure::Failed { code: "exchange".into(), message: "m".into() }, detail: detail.map(str::to_owned) })
}

#[tokio::test]
async fn a_callback_with_the_logins_code_and_state_is_redeemed_and_ends_the_login_on_a_success_page() {
    for (pages, name) in [(pages::ANTHROPIC, "Claude"), (pages::OPENAI, "OpenAI"), (pages::GROK, "Grok"), (pages::DEVIN, "Devin"), (pages::ANTIGRAVITY, "Antigravity")] {
        let served = serve(pages, account()).await;
        let answer = request(served.port, "GET", &good()).await;
        assert_eq!(answer.status, "HTTP/1.1 200 OK", "{name}");
        assert_eq!(answer.header("content-type"), Some("text/html; charset=utf-8"), "{name}");
        assert!(answer.body.contains(name), "{name}: the success page names the provider");
        assert_eq!(served.codes.lock().unwrap().as_slice(), ["C1"], "{name}");
        assert_eq!(served.login.await.unwrap(), r#"Exchanged(Ok(Some("acct-1")))"#, "{name}");
    }
}

#[tokio::test]
async fn a_login_that_is_over_refuses_further_connections() {
    let served = serve(pages::GROK, account()).await;
    request(served.port, "GET", &good()).await;
    served.login.await.unwrap();
    assert_eq!(TcpStream::connect(("127.0.0.1", served.port)).await.unwrap_err().kind(), std::io::ErrorKind::ConnectionRefused);
}

#[tokio::test]
async fn a_failed_exchange_shows_the_summary_and_the_escaped_detail_with_status_500_and_ends_the_login() {
    let served = serve(pages::ANTHROPIC, failed(Some("token endpoint said <b>no</b>"))).await;
    let answer = request(served.port, "GET", &good()).await;
    assert_eq!(answer.status, "HTTP/1.1 500 Internal Server Error");
    assert!(answer.body.contains("Claude could not complete the token exchange."));
    assert!(answer.body.contains("token endpoint said &lt;b&gt;no&lt;/b&gt;"), "the detail is escaped");
    assert!(!answer.body.contains("<b>no</b>"));
    assert!(served.login.await.unwrap().starts_with("Exchanged(Err("));

    let served = serve(pages::ANTHROPIC, failed(None)).await;
    let answer = request(served.port, "GET", &good()).await;
    assert!(answer.body.contains("Claude could not complete the token exchange."), "the summary alone without a detail");
    served.login.await.unwrap();
}

#[tokio::test]
async fn standard_servers_answer_a_wrong_path_with_404_and_a_wrong_state_or_missing_code_with_a_page_and_keep_waiting() {
    let served = serve(pages::ANTHROPIC, account()).await;
    let wrong_path = request(served.port, "GET", &format!("/other?code=C1&state={STATE}")).await;
    assert_eq!((wrong_path.status.as_str(), wrong_path.body.as_str()), ("HTTP/1.1 404 Not Found", ""));
    for query in ["code=C1&state=other".to_owned(),"code=C1".to_owned(), format!("state={STATE}"), format!("code=&state={STATE}")] {
        let answer = request(served.port, "GET", &callback(&query)).await;
        assert_eq!(answer.status, "HTTP/1.1 400 Bad Request", "{query}");
        assert!(answer.body.contains("The sign-in callback was invalid or did not match this login."), "{query}");
    }
    // The server error text is never reflected into the page.
    let denied = request(served.port, "GET", &callback(&format!("error=<script>x</script>&state={STATE}"))).await;
    assert!(!denied.body.contains("<script>x"));
    assert!(served.codes.lock().unwrap().is_empty(), "nothing was redeemed");
    // None of it ended the login: the real callback still does.
    assert_eq!(request(served.port, "GET", &good()).await.status, "HTTP/1.1 200 OK");
    assert_eq!(served.login.await.unwrap(), r#"Exchanged(Ok(Some("acct-1")))"#);
}

#[tokio::test]
async fn only_openai_ends_the_login_on_a_codeless_callback_that_carries_its_own_state() {
    let served = serve(pages::OPENAI, account()).await;
    let denied = request(served.port, "GET", &callback(&format!("error=access_denied&state={STATE}"))).await;
    assert_eq!(denied.status, "HTTP/1.1 400 Bad Request");
    assert_eq!(served.login.await.unwrap(), "Rejected(Denied)");

    let served = serve(pages::OPENAI, account()).await;
    request(served.port, "GET", &callback(&format!("state={STATE}"))).await;
    assert_eq!(served.login.await.unwrap(), "Rejected(Malformed)");

    // A codeless callback of another login's state ends nothing.
    let served = serve(pages::OPENAI, account()).await;
    request(served.port, "GET", &callback("error=access_denied&state=other")).await;
    assert_eq!(request(served.port, "GET", &good()).await.status, "HTTP/1.1 200 OK");
    assert_eq!(served.login.await.unwrap(), r#"Exchanged(Ok(Some("acct-1")))"#);
}

#[tokio::test]
async fn devin_answers_each_way_a_callback_can_be_wrong_and_ends_only_on_a_denial_or_a_code() {
    let served = serve(pages::DEVIN, account()).await;
    assert_eq!(request(served.port, "POST", &good()).await.status, "HTTP/1.1 404 Not Found", "GET only");
    assert_eq!(request(served.port, "GET", &format!("/x?code=C1&state={STATE}")).await.status, "HTTP/1.1 404 Not Found");
    let mismatch = request(served.port, "GET", &callback("code=C1&state=other")).await;
    assert_eq!(mismatch.status, "HTTP/1.1 400 Bad Request");
    assert!(mismatch.body.contains("The sign-in callback did not match this login."));
    let codeless = request(served.port, "GET", &callback(&format!("state={STATE}"))).await;
    assert!(codeless.body.contains("The sign-in callback carried no authorization code."));
    assert!(served.codes.lock().unwrap().is_empty());
    let denied = request(served.port, "GET", &callback(&format!("error=access_denied&state={STATE}"))).await;
    assert!(denied.body.contains("Devin did not authorize this sign-in."));
    assert_eq!(served.login.await.unwrap(), "Rejected(Denied)");
}

#[tokio::test]
async fn antigravity_answers_plain_text_for_a_wrong_state_or_missing_code_and_a_fixed_page_for_a_denial() {
    let served = serve(pages::ANTIGRAVITY, account()).await;
    let mismatch = request(served.port, "GET", &callback("code=C1&state=other")).await;
    assert_eq!((mismatch.status.as_str(), mismatch.body.as_str(), mismatch.header("content-type")), ("HTTP/1.1 400 Bad Request", "Invalid OAuth state", None));
    let codeless = request(served.port, "GET", &callback(&format!("state={STATE}"))).await;
    assert_eq!((codeless.status.as_str(), codeless.body.as_str()), ("HTTP/1.1 400 Bad Request", "Missing authorization code"));
    let denied = request(served.port, "GET", &callback(&format!("error=access_denied&state={STATE}"))).await;
    assert_eq!(denied.header("content-type"), Some("text/html; charset=utf-8"));
    assert!(denied.body.contains("Antigravity sign-in was not completed."));
    assert_eq!(served.login.await.unwrap(), "Rejected(Denied)");
}

#[tokio::test]
async fn a_code_with_surrounding_blanks_is_trimmed_for_devin_and_antigravity() {
    for pages in [pages::DEVIN, pages::ANTIGRAVITY] {
        let served = serve(pages, account()).await;
        request(served.port, "GET", &callback(&format!("code=%20C1%20&state={STATE}"))).await;
        assert_eq!(served.codes.lock().unwrap().as_slice(), ["C1"]);
        served.login.await.unwrap();
    }
}
