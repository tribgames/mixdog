//! Cursor's deep-control sign-in: the user opens a page that carries a PKCE
//! challenge and a uuid, and the client polls the auth endpoint with the uuid
//! and verifier until the page's approval makes the tokens available. The
//! shared PKCE flow does not fit (no redirect, no code), so this is its own
//! [`LoginFlow`]. Pacing is the poll endpoint's own cadence: a pending answer
//! (404) widens the wait by 1.2x up to ten seconds; nothing else times it.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use mixdog_core_api::domain::login::LoginError;
use mixdog_core_api::domain::login::LoginFailure;
use mixdog_core_api::domain::login::LoginFlow;
use mixdog_core_api::domain::login::LoginSession;
use mixdog_core_api::domain::login::LoginState;
use mixdog_core_api::domain::login::LoginTarget;
use mixdog_protocol::ProviderId;
use serde_json::Value;

use super::auth::StoredTokens;
use super::auth::now_ms;
use crate::oauth::CredentialFile;
use crate::oauth::FlowGuard;
use crate::oauth::Pace;
use crate::oauth::Poll;
use crate::oauth::Schedule;
use crate::oauth::device;
use crate::oauth::Pkce;
use crate::oauth::http::call_under;
use crate::transport::deadlines::NODE_DISPATCHER;
use crate::oauth::http::failed;
use crate::oauth::start_session;
use crate::providers::connect::random_uuid;
use crate::transport::http::HttpSend;

pub const LOGIN_URL: &str = "https://cursor.com/loginDeepControl";
pub const POLL_URL: &str = "https://api2.cursor.sh/auth/poll";

pub fn login_url(challenge: &str, uuid: &str) -> String {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("challenge", challenge)
        .append_pair("uuid", uuid)
        .append_pair("mode", "login")
        .append_pair("redirectTarget", "cli")
        .finish();
    format!("{LOGIN_URL}?{query}")
}

fn poll_url(uuid: &str, verifier: &str) -> String {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("uuid", uuid)
        .append_pair("verifier", verifier)
        .finish();
    format!("{POLL_URL}?{query}")
}

/// The `sub`/`email` claims of the access token: the account label.
fn account_label(access_token: &str) -> Option<String> {
    let payload = access_token.split('.').nth(1)?;
    let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
    ["email", "sub"]
        .iter()
        .find_map(|k| claims.get(*k).and_then(Value::as_str).filter(|s| !s.is_empty()))
        .map(str::to_owned)
}

/// Polls until the approval lands, the endpoint fails three times in a row,
/// or the attempts run out.
pub async fn poll_tokens(
    http: &dyn HttpSend,
    pace: &dyn Pace,
    uuid: &str,
    verifier: &str,
) -> Result<StoredTokens, LoginFailure> {
    let url = poll_url(uuid, verifier);
    let poll = || async {
        // Node's poll is a bare `fetch` with no timer of its own (`cursor-auth.mjs:276`).
        match call_under(http, NODE_DISPATCHER, "GET", &url, Vec::new(), Vec::new()).await {
            Ok(reply) if reply.status == 404 => Poll::Pending,
            Ok(reply) if reply.ok() => {
                let tokens = reply.json();
                let access = tokens
                    .as_ref()
                    .and_then(|v| v.get("accessToken"))
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty());
                match access {
                    Some(access) => {
                        let refresh = tokens
                            .as_ref()
                            .and_then(|v| v.get("refreshToken"))
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty());
                        Poll::Granted(StoredTokens::from_exchange(
                            access.to_owned(),
                            refresh.map(str::to_owned),
                            now_ms(),
                        ))
                    }
                    None => Poll::Network {
                        fault: failed("poll", "Cursor OAuth returned no access token"),
                    },
                }
            }
            Ok(reply) => Poll::Network {
                fault: failed("poll", format!("Cursor OAuth failed ({})", reply.status)),
            },
            Err(fault) => Poll::Network { fault },
        }
    };
    match device::run(pace, Schedule::cursor(), poll).await {
        Err(LoginFailure::Expired) => Err(failed("poll", "Cursor OAuth timed out")),
        other => other,
    }
}

pub struct CursorLogin {
    target: LoginTarget,
    http: Arc<dyn HttpSend>,
    file: CredentialFile,
    pace: Arc<dyn Pace>,
    running: Arc<AtomicBool>,
}

impl CursorLogin {
    pub fn new(http: Arc<dyn HttpSend>, file: CredentialFile, pace: Arc<dyn Pace>) -> Self {
        Self {
            target: LoginTarget::Provider(ProviderId::from("cursor-oauth")),
            http,
            file,
            pace,
            running: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[async_trait]
impl LoginFlow for CursorLogin {
    fn target(&self) -> &LoginTarget {
        &self.target
    }

    async fn start(&self) -> Result<Box<dyn LoginSession>, LoginError> {
        let Some(guard) = FlowGuard::claim(&self.running) else {
            return Err(LoginError::Busy);
        };
        let pkce = Pkce::generate(32);
        let uuid = random_uuid();
        let first = LoginState::Authorize {
            url: login_url(&pkce.challenge, &uuid),
            manual_url: None,
        };
        let (http, file, pace) = (self.http.clone(), self.file.clone(), self.pace.clone());
        Ok(start_session(guard, first, false, move |ctx, _cancel| async move {
            ctx.set(LoginState::Waiting);
            let tokens = poll_tokens(http.as_ref(), pace.as_ref(), &uuid, &pkce.verifier).await?;
            file.save(&tokens)
                .await
                .map_err(|_| failed("storage", "the tokens could not be stored"))?;
            Ok(account_label(&tokens.access_token))
        }))
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use mixdog_core_api::domain::provider::WireRequest;

    use super::*;
    use crate::oauth::http::testing::Scripted;
    use crate::oauth::pace::FakePace;

    fn jwt(claims: &str) -> String {
        format!("h.{}.s", URL_SAFE_NO_PAD.encode(claims))
    }

    #[tokio::test]
    async fn pending_widens_the_wait_then_the_tokens_land() {
        let access = jwt(r#"{"exp":4000000000,"email":"a@b.c"}"#);
        let body = format!(r#"{{"accessToken":"{access}","refreshToken":"r"}}"#);
        let http = Scripted::new(&[(404, ""), (404, ""), (200, &body)]);
        let pace = FakePace::default();
        let tokens = poll_tokens(http.as_ref(), &pace, "u", "v").await.unwrap();
        assert_eq!(tokens.refresh_token.as_deref(), Some("r"));
        let waits = pace.waits.lock().unwrap().clone();
        assert_eq!(waits, vec![Duration::from_secs(1), Duration::from_millis(1200), Duration::from_millis(1440)]);
        let seen: Vec<WireRequest> = http.seen.lock().unwrap().clone();
        assert_eq!(seen[0].url, "https://api2.cursor.sh/auth/poll?uuid=u&verifier=v");
        assert_eq!(account_label(&access).as_deref(), Some("a@b.c"));
    }

    #[tokio::test]
    async fn the_wait_sequence_is_the_products_ceil_of_one_point_two_steps() {
        let mut replies = vec![(404, String::new()); 11];
        replies.push((500, String::new()));
        replies.push((500, String::new()));
        replies.push((500, String::new()));
        let borrowed: Vec<(u16, &str)> = replies.iter().map(|(s, b)| (*s, b.as_str())).collect();
        let http = Scripted::new(&borrowed);
        let pace = FakePace::default();
        let _ = poll_tokens(http.as_ref(), &pace, "u", "v").await;
        let ms: Vec<u128> = pace.waits.lock().unwrap().iter().map(Duration::as_millis).collect();
        // Math.ceil(delay * 1.2), capped at 10 s, from 1 s; errors keep the wait.
        assert_eq!(ms[..11], [1000, 1200, 1440, 1728, 2074, 2489, 2987, 3585, 4302, 5163, 6196]);
        assert_eq!(ms[11..], [7436, 7436, 7436]);
    }

    /// A poll nothing answers arms no timer: it ends at the dispatcher, and the third failure in a row ends the login with
    /// the last one's text (`sites.cursorPoll`).
    #[tokio::test(start_paused = true)]
    async fn a_poll_nothing_answers_ends_after_three_tries_as_nodes_does() {
        use crate::transport::site_probe::TimingOut;
        use crate::transport::site_probe::assert_dispatcher;
        use crate::transport::site_probe::assert_thrown;
        use crate::transport::site_probe::login_message;
        use crate::transport::site_probe::recorded;

        let transport = TimingOut::new();
        let failure = poll_tokens(transport.as_ref(), &FakePace::default(), "u", "v").await.unwrap_err();
        assert_dispatcher("cursorPoll", &transport);
        assert_eq!(transport.seen().len(), recorded("cursorPoll")["fetchRejected"].as_array().unwrap().len());
        assert_thrown("cursorPoll", login_message(&failure));
    }

    #[tokio::test]
    async fn three_failures_in_a_row_end_the_login() {
        let http = Scripted::new(&[(500, ""), (500, ""), (500, "")]);
        let pace = FakePace::default();
        let failure = poll_tokens(http.as_ref(), &pace, "u", "v").await.unwrap_err();
        assert_eq!(failure, failed("poll", "Cursor OAuth failed (500)"));
    }
}
