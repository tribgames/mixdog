//! The `openai-oauth` device-code sign-in for a host with no browser (`openai-oauth-login.mjs` `beginDeviceLogin`,
//! Codex's `codex login --device-auth`): the user enters a short code at the verification URL on any machine while
//! this host polls until the server hands back an authorization code, which is exchanged with the device-auth redirect
//! URI. An issuer that has no device flow (404) leaves the sign-in to the browser flow.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use mixdog_core_api::domain::login::LoginError;
use mixdog_core_api::domain::login::LoginFlow;
use mixdog_core_api::domain::login::LoginSession;
use mixdog_core_api::domain::login::LoginState;
use mixdog_core_api::domain::login::LoginTarget;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ProviderId;

use super::login::OpenAiLogin;
use super::oauth::CLIENT_ID;
use crate::oauth::FlowGuard;
use crate::oauth::Pace;
use crate::oauth::PkceProvider;
use crate::oauth::Poll;
use crate::oauth::Schedule;
use crate::oauth::device;
use crate::oauth::http::failed;
use crate::oauth::http::try_call_under;
use crate::oauth::start_session;
use crate::transport::HttpSend;
use crate::transport::deadlines::credential_signal;

const PROVIDER_ID: &str = "openai-oauth";
const ISSUER: &str = "https://auth.openai.com";
/// The user has 15 minutes to enter the code (`DEVICE_LOGIN_TIMEOUT_MS`).
const LOGIN_WINDOW: Duration = Duration::from_secs(15 * 60);
/// `DEFAULT_DEVICE_INTERVAL_S`: the poll interval when the server names none.
const DEFAULT_INTERVAL: Duration = Duration::from_secs(5);
/// `TOKEN_TIMEOUT_MS`: the start request's own deadline.
const START_WINDOW: Duration = Duration::from_secs(30);

fn json_body(body: &JsonValue) -> Vec<u8> {
    serde_json::to_vec(body).unwrap_or_default()
}

/// The text of a JSON field a server may send as a string or a number (`String(value ?? '').trim()`).
fn field_text(value: Option<&JsonValue>) -> String {
    match value {
        Some(JsonValue::String(text)) => mixdog_js::js_trim(text).to_owned(),
        Some(JsonValue::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}

pub struct OpenAiDeviceLogin {
    target: LoginTarget,
    login: Arc<OpenAiLogin>,
    http: Arc<dyn HttpSend>,
    pace: Arc<dyn Pace>,
    /// Where the sign-in goes when the issuer has no device flow.
    browser: Arc<dyn LoginFlow>,
    running: Arc<AtomicBool>,
}

impl OpenAiDeviceLogin {
    pub fn new(login: Arc<OpenAiLogin>, http: Arc<dyn HttpSend>, pace: Arc<dyn Pace>, browser: Arc<dyn LoginFlow>) -> Self {
        Self {
            target: LoginTarget::Provider(ProviderId::from(PROVIDER_ID)),
            login,
            http,
            pace,
            browser,
            running: Arc::new(AtomicBool::new(false)),
        }
    }
}

/// One poll of `deviceauth/token`: the grant, not approved yet (403/404), or an answer that ends the login.
fn classify_poll(status: u16, body: &[u8]) -> Poll<JsonValue> {
    if (200..300).contains(&status) {
        return match serde_json::from_slice(body) {
            Ok(granted) => Poll::Granted(granted),
            Err(_) => Poll::Fatal(failed("device_auth", format!("[openai-oauth] device auth failed with status {status}"))),
        };
    }
    if status == 403 || status == 404 {
        return Poll::Pending;
    }
    Poll::Fatal(failed("device_auth", format!("[openai-oauth] device auth failed with status {status}")))
}

#[async_trait]
impl LoginFlow for OpenAiDeviceLogin {
    fn target(&self) -> &LoginTarget {
        &self.target
    }

    async fn start(&self) -> Result<Box<dyn LoginSession>, LoginError> {
        let guard = FlowGuard::claim(&self.running).ok_or(LoginError::Busy)?;
        let api = format!("{ISSUER}/api/accounts");
        let started = try_call_under(
            self.http.as_ref(),
            credential_signal(START_WINDOW),
            "POST",
            &format!("{api}/deviceauth/usercode"),
            vec![("Content-Type", "application/json".to_owned())],
            json_body(&serde_json::json!({ "client_id": CLIENT_ID })),
        )
        .await
        .map_err(|error| LoginError::Failed(failed("transport", error.message)))?;
        if started.status == 404 {
            // Like Codex, an issuer that has none falls back to the browser flow.
            drop(guard);
            return self.browser.start().await;
        }
        if !started.ok() {
            return Err(LoginError::Failed(failed(
                "device_auth",
                format!("[openai-oauth] device code request failed with status {}", started.status),
            )));
        }
        let body = started.json().unwrap_or(JsonValue::Null);
        let user_code = [field_text(body.get("user_code")), field_text(body.get("usercode"))]
            .into_iter()
            .find(|code| !code.is_empty())
            .unwrap_or_default();
        let device_auth_id = field_text(body.get("device_auth_id"));
        if user_code.is_empty() || device_auth_id.is_empty() {
            return Err(LoginError::Failed(failed(
                "device_auth",
                "[openai-oauth] device code response missing user_code or device_auth_id",
            )));
        }
        let interval = field_text(body.get("interval")).parse::<f64>().ok().filter(|seconds| seconds.is_finite() && *seconds > 0.0);
        // A wait never outlasts the login window, so a larger interval is the window (and cannot overflow a Duration).
        let interval = interval.map_or(DEFAULT_INTERVAL, |seconds| Duration::from_secs_f64(seconds.min(LOGIN_WINDOW.as_secs_f64())));
        let now_ms = self.pace.now_ms();
        let first = LoginState::DeviceCode {
            user_code: user_code.clone(),
            verification_uri: format!("{ISSUER}/codex/device"),
            expires_at: Some(UNIX_EPOCH + Duration::from_millis(now_ms) + LOGIN_WINDOW),
        };
        let (login, http, pace) = (self.login.clone(), self.http.clone(), self.pace.clone());
        Ok(start_session(guard, first, false, move |ctx, _| async move {
            ctx.set(LoginState::Waiting);
            let deadline_ms = now_ms + LOGIN_WINDOW.as_millis() as u64;
            let schedule = Schedule { interval, deadline_ms: Some(deadline_ms), ..Schedule::default() };
            let granted = device::run(pace.as_ref(), schedule, || async {
                // One poll dies with the login deadline, so a stalled request cannot outlive it.
                let left = Duration::from_millis(deadline_ms.saturating_sub(pace.now_ms()).max(1));
                let polled = try_call_under(
                    http.as_ref(),
                    credential_signal(left),
                    "POST",
                    &format!("{api}/deviceauth/token"),
                    vec![("Content-Type", "application/json".to_owned())],
                    json_body(&serde_json::json!({ "device_auth_id": device_auth_id, "user_code": user_code })),
                )
                .await;
                match polled {
                    Ok(reply) => classify_poll(reply.status, &reply.body),
                    // A request that stalled to the deadline is the login's timeout; any other fault ends it.
                    Err(error) if error.timed_out => Poll::Expired,
                    Err(error) => Poll::Fatal(failed("transport", error.message)),
                }
            })
            .await?;
            let text = |key: &str| field_text(granted.get(key));
            login.exchange(&text("authorization_code"), &text("code_verifier"), &format!("{ISSUER}/deviceauth/callback")).await
        }))
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::login::LoginFailure;

    use super::*;
    use crate::oauth::CredentialFile;
    use crate::oauth::CredentialIo;
    use crate::oauth::http::testing::Scripted;
    use crate::oauth::http::testing::finish;
    use crate::oauth::pace::FakePace;

    struct Browser;

    #[async_trait]
    impl LoginFlow for Browser {
        fn target(&self) -> &LoginTarget {
            unreachable!("the target of the device flow is read")
        }
        async fn start(&self) -> Result<Box<dyn LoginSession>, LoginError> {
            Err(LoginError::Busy)
        }
    }

    fn flow(http: Arc<Scripted>, dir: &tempfile::TempDir) -> OpenAiDeviceLogin {
        let tokens = mixdog_rt::testing::tokens();
        let file = CredentialFile::new(dir.path().join("openai-oauth.json"), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
        let login = Arc::new(OpenAiLogin::new(file, http.clone()));
        OpenAiDeviceLogin::new(login, http, Arc::new(FakePace::default()), Arc::new(Browser))
    }

    const STARTED: &str = r#"{"user_code":"ABCD-1234","device_auth_id":"dev-1","interval":"1"}"#;

    #[tokio::test]
    async fn the_code_is_shown_then_the_grant_is_exchanged_with_the_device_redirect() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = r#"{"access_token":"a.b.c","refresh_token":"r","expires_in":3600}"#;
        let http = Scripted::new(&[
            (200, STARTED),
            (403, ""),
            (200, r#"{"authorization_code":"code-1","code_verifier":"ver-1"}"#),
            (200, tokens),
        ]);
        let session = flow(http.clone(), &dir).start().await.expect("a device flow");
        let states = finish(session.as_ref()).await;
        assert!(matches!(
            states.first(),
            Some(LoginState::DeviceCode { user_code, verification_uri, .. })
                if user_code == "ABCD-1234" && verification_uri == "https://auth.openai.com/codex/device"
        ));
        assert!(matches!(states.last(), Some(LoginState::Done { .. })), "{states:?}");
        let seen = http.seen.lock().unwrap();
        assert_eq!(seen[0].url, "https://auth.openai.com/api/accounts/deviceauth/usercode");
        assert_eq!(seen[1].url, "https://auth.openai.com/api/accounts/deviceauth/token");
        let exchange = String::from_utf8_lossy(&seen[3].body).into_owned();
        assert!(exchange.contains("code=code-1") && exchange.contains("code_verifier=ver-1"), "{exchange}");
        assert!(exchange.contains("redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback"), "{exchange}");
    }

    #[tokio::test]
    async fn an_issuer_without_a_device_flow_leaves_the_sign_in_to_the_browser_flow() {
        let dir = tempfile::tempdir().unwrap();
        let outcome = flow(Scripted::new(&[(404, "")]), &dir).start().await;
        assert!(matches!(outcome, Err(LoginError::Busy)), "the browser flow's answer is the flow's");
    }

    #[tokio::test]
    async fn a_refused_start_or_a_malformed_answer_fails_the_login() {
        let dir = tempfile::tempdir().unwrap();
        let refused = flow(Scripted::new(&[(500, "")]), &dir).start().await;
        assert!(matches!(
            refused,
            Err(LoginError::Failed(LoginFailure::Failed { message, .. }))
                if message == "[openai-oauth] device code request failed with status 500"
        ));
        let missing = flow(Scripted::new(&[(200, r#"{"user_code":"X"}"#)]), &dir).start().await;
        assert!(matches!(
            missing,
            Err(LoginError::Failed(LoginFailure::Failed { message, .. }))
                if message == "[openai-oauth] device code response missing user_code or device_auth_id"
        ));
    }

    #[tokio::test]
    async fn a_status_other_than_pending_ends_the_login() {
        let dir = tempfile::tempdir().unwrap();
        let session = flow(Scripted::new(&[(200, STARTED), (500, "")]), &dir).start().await.expect("a device flow");
        let states = finish(session.as_ref()).await;
        assert!(matches!(
            states.last(),
            Some(LoginState::Failed(LoginFailure::Failed { message, .. })) if message == "[openai-oauth] device auth failed with status 500"
        ));
    }
}
