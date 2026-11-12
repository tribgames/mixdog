//! The built-in Google connectors against Node's (`fixtures/google-mcp`, recorded by `record-google-mcp.mjs`): the address
//! classification, every reply the reserved address gave a script of requests (status, headers a client reads, body text) and
//! every call that reached Google, and the same connector reached through the HTTP transport a configured server uses.

use std::collections::BTreeMap;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_mcp::google_mcp::GoogleFetch;
use mixdog_mcp::google_mcp::GoogleReply;
use mixdog_mcp::google_mcp::GoogleRequest;
use mixdog_mcp::google_mcp::answer;
use mixdog_mcp::google_mcp::service;
use mixdog_mcp::http::HttpTransport;
use mixdog_mcp::transport::Authorizer;
use mixdog_mcp::transport::Incoming;
use mixdog_mcp::transport::Transport;
use mixdog_mcp::transport::TransportError;
use serde_json::Value;
use serde_json::json;
use url::Url;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/google-mcp/golden.json");
/// `Date.now` while the recording ran (`clock.dateNow`).
const NOW_MS: i64 = 1_800_000_000_000;

fn cases() -> Vec<Value> {
    let golden: Value = serde_json::from_str(&GOLDEN).expect("golden");
    assert_eq!(golden["clock"]["dateNow"], NOW_MS);
    golden["cases"].as_array().expect("cases").clone()
}

/// Google as the recording scripted it: each call gets the next recorded reply, and is kept.
struct Scripted {
    replies: Mutex<Vec<Value>>,
    calls: Mutex<Vec<Value>>,
}

impl Scripted {
    fn new(replies: &Value) -> Self {
        Self { replies: Mutex::new(replies.as_array().expect("replies").iter().rev().cloned().collect()), calls: Mutex::new(Vec::new()) }
    }
}

#[async_trait]
impl GoogleFetch for Scripted {
    async fn fetch(&self, request: GoogleRequest) -> Result<GoogleReply, String> {
        self.calls.lock().expect("calls").push(json!({
            "url": request.url,
            "method": request.method,
            "authorization": request.authorization,
            "contentType": request.content_type,
            "body": request.body,
        }));
        let reply = self.replies.lock().expect("replies").pop().ok_or_else(|| format!("no recorded reply for {}", request.url))?;
        Ok(GoogleReply { status: reply["status"].as_u64().expect("status") as u16, body: reply["body"].as_str().unwrap_or_default().to_owned() })
    }
}

#[test]
fn the_address_classification_is_nodes() {
    let cases = cases();
    let case = cases.iter().find(|c| c["case"] == "the address classification").expect("case");
    for row in case["observed"]["urls"].as_array().expect("urls") {
        let got = Url::parse(row["url"].as_str().expect("url")).ok().and_then(|url| service(&url));
        assert_eq!(got, row["service"].as_str(), "{}", row["url"]);
    }
}

#[tokio::test]
async fn the_connectors_answer_and_call_google_as_nodes_do() {
    for case in cases().iter().filter(|c| c.get("input").is_some()) {
        let name = case["case"].as_str().expect("name");
        let input = &case["input"];
        let google = Scripted::new(&input["upstream"]);
        let observed = &case["observed"];
        for (i, request) in input["requests"].as_array().expect("requests").iter().enumerate() {
            let url = Url::parse(request["url"].as_str().expect("url")).expect("a url");
            let body = request["body"].as_str().unwrap_or_default();
            let got = answer(&url, request["method"].as_str().expect("method"), request["authorization"].as_str(), body.as_bytes(), &google, NOW_MS).await.unwrap_or_else(|e| panic!("{name} #{i}: {e}"));
            let want = &observed["responses"][i];
            assert_eq!(got.status, want["status"].as_u64().expect("status") as u16, "{name} #{i}");
            assert_eq!(got.allow, want["allow"].as_str(), "{name} #{i}");
            assert_eq!(got.www_authenticate.as_deref(), want["wwwAuthenticate"].as_str(), "{name} #{i}");
            assert_eq!(got.body.is_some().then_some("application/json"), want["contentType"].as_str(), "{name} #{i}");
            let text = got.body.map(|b| serde_json::to_string(&b).expect("json")).unwrap_or_default();
            assert_eq!(text, want["body"].as_str().expect("body"), "{name} #{i}");
        }
        assert_eq!(*google.calls.lock().expect("calls"), observed["calls"].as_array().expect("calls").clone(), "{name}: the calls that reached Google");
        assert_eq!(google.replies.lock().expect("replies").len() as u64, observed["unused"], "{name}: replies left unused");
    }
}

/// A sign-in holding a token, as the transport asks for it.
struct Token(&'static str);

#[async_trait]
impl Authorizer for Token {
    async fn token(&self) -> Result<Option<String>, TransportError> {
        Ok(Some(self.0.to_owned()))
    }

    async fn renew(&self, _: Option<String>, _: Option<String>) -> Result<(), TransportError> {
        Err(TransportError::AuthRequired)
    }
}

/// A configured server at a reserved address connects and answers through the HTTP transport, as the first `initialize` of
/// the recorded script does; a token Google no longer accepts needs the user, as a 401 from the address does.
#[tokio::test]
async fn a_server_at_a_reserved_address_answers_through_the_transport() {
    let _runtime = mixdog_rt::testing::tokens();
    let cases = cases();
    let case = cases.iter().find(|c| c["case"] == "gmail initializes, lists its tools and pings").expect("case");
    let google = std::sync::Arc::new(Scripted::new(&case["input"]["upstream"]));
    let url = Url::parse("https://gmail.mixdog.invalid/mcp").expect("url");
    let (transport, mut incoming) = HttpTransport::new(url.clone(), &BTreeMap::new(), Some(std::sync::Arc::new(Token("t1")))).expect("transport");
    let transport = transport.with_google_fetch(google.clone());
    let message: Value = serde_json::from_str(case["input"]["requests"][0]["body"].as_str().expect("body")).expect("json");
    transport.send(message, mixdog_mcp::deadlines::CALL).await.expect("sent");
    let Some(Incoming::Message(got)) = incoming.recv().await else { panic!("the answer arrives as a message") };
    let want: Value = serde_json::from_str(case["observed"]["responses"][0]["body"].as_str().expect("body")).expect("json");
    assert_eq!(got, want);
    assert_eq!(google.calls.lock().expect("calls")[0]["authorization"], Value::Null, "the token is checked at Google's tokeninfo, which takes it in the URL");

    // Google refuses the token: the transport asks the sign-in to renew it, which needs the user.
    let refused = Scripted::new(&json!([{ "status": 400, "body": "{}" }]));
    let (transport, _incoming) = HttpTransport::new(url, &BTreeMap::new(), Some(std::sync::Arc::new(Token("t1")))).expect("transport");
    let transport = transport.with_google_fetch(std::sync::Arc::new(refused));
    let error = transport.send(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }), mixdog_mcp::deadlines::CALL).await.expect_err("refused");
    assert!(matches!(error, TransportError::AuthRequired), "{error:?}");
}
