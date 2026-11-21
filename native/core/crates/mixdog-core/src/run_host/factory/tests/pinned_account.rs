use bytes::Bytes;
use mixdog_ai::accounts::AccountChange;
use mixdog_ai::accounts::AccountStore;
use mixdog_ai::registry::providers::ProviderBuilder;
use mixdog_ai::transport::BodyStream;
use mixdog_ai::transport::Exchange;
use mixdog_ai::transport::HttpResponse;
use mixdog_ai::transport::HttpSend;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;

use super::*;

const OPENAI: &str = "openai-oauth";
const ID_A: &str = "11111111-1111-4111-8111-111111111111";
const ID_B: &str = "22222222-2222-4222-8222-222222222222";

struct Once(Option<Bytes>);

#[async_trait]
impl BodyStream for Once {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.take().map(Ok)
    }
}

fn answered(status: u16, body: String) -> HttpResponse {
    HttpResponse { status, headers: vec![("content-type".into(), "text/event-stream".into())], body: Box::new(Once(Some(Bytes::from(body)))) }
}

/// The ChatGPT endpoint: the second model request (the second turn's) moves the selection to B and is refused with a 401,
/// so the send reads its credential again; every other one answers with encrypted reasoning that names the token it came
/// with; a token refresh renews the refresh token it was sent, for the same account.
struct Endpoint {
    store: AccountStore,
    /// `(url, authorization, body)` of each request.
    sent: Mutex<Vec<(String, String, String)>>,
}

/// A ChatGPT access token of `account` (the claim the Codex route and its refresh read the account from); `tag` tells one
/// token of the account from another.
fn token(account: &str, tag: &str) -> String {
    use base64::Engine;
    let claims = json!({"https://api.openai.com/auth": {"chatgpt_account_id": account}, "tag": tag});
    format!("e30.{}.sig", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string()))
}

fn refresh(account: &str, tag: &str) -> String {
    format!("refresh.{account}.{tag}")
}

fn tag_of(authorization: &str) -> String {
    use base64::Engine;
    let payload = authorization.trim_start_matches("Bearer ").split('.').nth(1).unwrap_or_default();
    let claims: Value = serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload).unwrap_or_default()).unwrap_or_default();
    claims["tag"].as_str().unwrap_or_default().to_owned()
}

#[async_trait]
impl HttpSend for Endpoint {
    async fn send(&self, request: WireRequest, _exchange: Exchange) -> Result<HttpResponse, ProviderError> {
        let authorization = request.headers.iter().find(|(name, _)| name.eq_ignore_ascii_case("authorization")).map(|(_, v)| v.clone()).unwrap_or_default();
        let body = String::from_utf8_lossy(&request.body).into_owned();
        lock(&self.sent).push((request.url.clone(), authorization.clone(), body.clone()));
        if request.url == mixdog_ai::providers::openai::oauth::TOKEN_URL {
            // The test's refresh tokens (`refresh.<account>.<tag>`) need no form decoding.
            let spent = body.split('&').find_map(|pair| pair.strip_prefix("refresh_token=")).unwrap_or_default().to_owned();
            let mut login = spent.splitn(3, '.').skip(1);
            let (account, tag) = (login.next().unwrap_or_default(), login.next().unwrap_or_default());
            let renewed = json!({"access_token": token(account, &format!("{tag}-renewed")), "refresh_token": refresh(account, &format!("{tag}-next")), "expires_in": 3600});
            return Ok(answered(200, renewed.to_string()));
        }
        if !request.url.ends_with("/responses") {
            return Ok(answered(200, r#"{"data":[]}"#.to_owned()));
        }
        if lock(&self.sent).iter().filter(|(url, _, _)| url.ends_with("/responses")).count() == 2 {
            self.store.change(OPENAI, AccountChange { selected_id: Some(ID_B.into()), ..Default::default() }).await.unwrap();
            return Ok(answered(401, r#"{"error":{"message":"token expired","type":"invalid_request_error"}}"#.to_owned()));
        }
        let reasoning = json!({"type": "reasoning", "id": "rs_1", "encrypted_content": format!("enc-from-{}", tag_of(&authorization)), "summary": []});
        let message = json!({"type": "message", "id": "msg_1", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": "ok", "annotations": []}]});
        let frames = [
            json!({"type": "response.created", "response": {"id": "resp_1", "status": "in_progress"}}),
            json!({"type": "response.output_item.done", "output_index": 0, "item": reasoning}),
            json!({"type": "response.output_item.done", "output_index": 1, "item": message}),
            json!({"type": "response.completed", "response": {"id": "resp_1", "status": "completed", "output": [reasoning, message], "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}}),
        ];
        Ok(answered(200, frames.iter().map(|frame| format!("data: {frame}\n\n")).collect()))
    }
}

#[allow(clippy::disallowed_methods, reason = "the credential files are written directly")]
fn signed_in(store: &AccountStore, id: &str, account: &str, tag: &str) {
    let path = store.account_path(OPENAI, id).unwrap().unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let login = json!({"access_token": token(account, tag), "refresh_token": refresh(account, tag), "expires_at": 4_102_444_800_000u64, "account_id": account});
    std::fs::write(path, login.to_string()).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[allow(clippy::disallowed_methods, reason = "the plugin data folder is made directly")]
async fn a_turns_continuation_stays_with_the_account_whose_credential_sent_it_when_the_roster_moves() {
    let process = super::super::super::process_tests::world(&[("MIXDOG_OAI_TRANSPORT", "http-sse")], json!({}), Vec::new()).await;
    std::fs::create_dir_all(&process.services.plugin_data).unwrap();
    let mut env = super::super::super::builder_env::builder_env(&process.services);
    let store = env.accounts.clone();
    store.register(OPENAI, ID_A, "A", false).await.unwrap();
    store.register(OPENAI, ID_B, "B", false).await.unwrap();
    store.change(OPENAI, AccountChange { selected_id: Some(ID_A.into()), ..Default::default() }).await.unwrap();
    signed_in(&store, ID_A, "acct-a", "a");
    signed_in(&store, ID_B, "acct-b", "b");
    let net = Arc::new(Endpoint { store: store.clone(), sent: Mutex::default() });
    env.http = net.clone();
    let adapter = mixdog_ai::registry::builder::DefaultProviderBuilder::new(env).build(OPENAI, &json!({"enabled": true})).await.unwrap();
    let world = turn_world(adapter).await;
    let (id, handle) = started_thread(&world, json!({ "provider": OPENAI, "model": "gpt-5.2" })).await;

    for (turn, prompt) in [(1, "first"), (2, "next")] {
        let covered_before = handle.header_snapshot().get("turnCoverage").cloned();
        let op = format!("op-{turn}");
        let started =
            handle.request(request("turn/start", json!({ "threadId": id, "opId": op, "input": { "prompt": prompt } }), &op)).await.expect("turn/start");
        assert!(matches!(started, Reply::Value(_)), "turn/start answers a value");
        settled_turns(&world, &id, &handle, turn, covered_before).await;
    }

    let sent = lock(&net.sent).clone();
    let models: Vec<&(String, String, String)> = sent.iter().filter(|(url, _, _)| url.ends_with("/responses")).collect();
    assert_eq!(models.len(), 3, "the first turn's request, the second's refused request and its resend");
    assert_eq!(models[0].1, format!("Bearer {}", token("acct-a", "a")));
    assert_eq!(models[1].1, format!("Bearer {}", token("acct-a", "a")));
    assert!(models[1..].iter().all(|(_, _, body)| body.contains("enc-from-a")), "A's credential is sent the replay A's answer left");
    assert_eq!(models[2].1, format!("Bearer {}", token("acct-a", "a-renewed")), "the resend renewed A's credential, not B's");
    assert!(models.iter().all(|(_, auth, _)| *auth != format!("Bearer {}", token("acct-b", "b"))), "B's credential never went out");
    assert!(
        sent.iter().filter(|(url, _, _)| url == mixdog_ai::providers::openai::oauth::TOKEN_URL).all(|(_, _, body)| body.contains("refresh.acct-a.a")),
        "the refresh spent A's refresh token"
    );
    // No roster walk ran, so the stored answers name no row; the second holds what A's renewed credential was answered.
    let stored = format!("{:?}", world.rig.store.records(&id));
    assert!(!stored.contains(ID_B), "B never served: {stored}");
    assert!(stored.contains("enc-from-a-renewed"), "the second answer's replay is what A's renewed credential was answered");
}
