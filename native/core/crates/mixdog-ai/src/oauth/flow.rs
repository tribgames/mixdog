//! The provider side of [`LoginFlow`]: one PKCE authorization-code flow over a
//! loopback redirect or a pasted code. A provider supplies only the
//! authorize URL and the token exchange ([`PkceProvider`]); the session is
//! the shared one of [`super::session`].

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use async_trait::async_trait;
use mixdog_core_api::domain::login::LoginError;
use mixdog_core_api::domain::login::LoginFailure;
use mixdog_core_api::domain::login::LoginFlow;
use mixdog_core_api::domain::login::LoginSession;
use mixdog_core_api::domain::login::LoginState;
use mixdog_core_api::domain::login::LoginTarget;

use super::callback::CallbackError;
use super::callback::CallbackPages;
use super::callback::CallbackServer;
use super::callback::Exchange;
use super::callback::Redirect;
use super::callback::Refusal;
use super::callback::Settled;
use super::callback::parse_pasted_callback;
use super::pkce::Pkce;
use super::pkce::random_state;
use super::session::FlowGuard;
use super::session::start_session;

pub struct AuthorizeRequest<'a> {
    pub redirect_uri: &'a str,
    pub code_challenge: &'a str,
    pub state: &'a str,
}

#[async_trait]
pub trait PkceProvider: Send + Sync {
    /// The redirect the provider registered, host included: the URI is
    /// compared byte for byte. Use the `redirects` constants.
    fn redirect(&self) -> Redirect;
    /// Random bytes of the verifier (32; OpenAI uses 64).
    fn verifier_bytes(&self) -> usize {
        32
    }
    fn authorize_url(&self, request: &AuthorizeRequest<'_>) -> String;
    /// The authorize URL for a browser on another machine (a registered
    /// manual redirect), when the provider has one.
    fn manual_authorize_url(&self, _request: &AuthorizeRequest<'_>) -> Option<String> {
        None
    }
    /// What a pasted text names: the code and the redirect URI it was issued for. A provider whose hosted page shows a
    /// code to paste overrides this; the default is a callback URL of the loopback redirect.
    fn parse_pasted(&self, text: &str, redirect_uri: &str, state: &str) -> Result<(String, String), CallbackError> {
        parse_pasted_callback(text, redirect_uri, state).map(|code| (code, redirect_uri.to_owned()))
    }
    /// The pages this provider's callback server leaves the browser with.
    fn callback_pages(&self) -> CallbackPages;
    /// Exchanges the code and stores the credential; returns the account
    /// label if the provider states one. A failure also carries the part of
    /// its text the browser's failure page shows.
    async fn exchange_checked(
        &self,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> Result<Option<String>, Refusal>;
    /// [`exchange_checked`](Self::exchange_checked) as the login's failure.
    async fn exchange(
        &self,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> Result<Option<String>, LoginFailure> {
        self.exchange_checked(code, verifier, redirect_uri).await.map_err(|refusal| refusal.failure)
    }
}

pub struct PkceLoginFlow {
    target: LoginTarget,
    provider: Arc<dyn PkceProvider>,
    running: Arc<AtomicBool>,
}

impl PkceLoginFlow {
    pub fn new(target: LoginTarget, provider: Arc<dyn PkceProvider>) -> Self {
        Self {
            target,
            provider,
            running: Arc::new(AtomicBool::new(false)),
        }
    }
}

fn failure_of(error: CallbackError) -> LoginFailure {
    match error {
        CallbackError::Denied => LoginFailure::Denied,
        CallbackError::StateMismatch | CallbackError::Malformed => LoginFailure::Failed {
            code: "invalid_callback".into(),
            message: "the sign-in callback was not valid".into(),
        },
    }
}

impl PkceLoginFlow {
    /// A sign-in with no loopback listener: the user opens the hosted page and pastes what it shows.
    fn paste_only(&self, guard: FlowGuard, first: LoginState, verifier: String, redirect_uri: String, state: String) -> Box<dyn LoginSession> {
        let provider = self.provider.clone();
        start_session(guard, first, true, move |mut ctx, _cancel| async move {
            ctx.set(LoginState::Waiting);
            let Some(text) = ctx.pasted.recv().await else {
                return Err(LoginFailure::Failed { code: "invalid_callback".into(), message: "no authorization code was provided".into() });
            };
            let (code, issued_for) = provider.parse_pasted(&text, &redirect_uri, &state).map_err(failure_of)?;
            provider.exchange(&code, &verifier, &issued_for).await
        })
    }
}

#[async_trait]
impl LoginFlow for PkceLoginFlow {
    fn target(&self) -> &LoginTarget {
        &self.target
    }

    async fn start(&self) -> Result<Box<dyn LoginSession>, LoginError> {
        let guard = FlowGuard::claim(&self.running).ok_or(LoginError::Busy)?;
        let state = random_state();
        let pkce = Pkce::generate(self.provider.verifier_bytes());
        let (server, redirect_uri) = match CallbackServer::bind(self.provider.redirect(), state.clone(), self.provider.callback_pages()).await {
            Ok(server) => {
                let uri = server.redirect_uri();
                (Some(server), uri)
            }
            Err(err) => {
                // The loopback port is taken: a provider with a hosted paste page signs in through it, as Node did.
                let redirect = self.provider.redirect();
                let uri = redirect.uri(redirect.port);
                let request = AuthorizeRequest { redirect_uri: &uri, code_challenge: &pkce.challenge, state: &state };
                let Some(manual) = self.provider.manual_authorize_url(&request) else {
                    return Err(LoginError::Failed(LoginFailure::Failed {
                        code: "listen_failed".into(),
                        message: err.kind().to_string(),
                    }));
                };
                let first = LoginState::Authorize { url: manual.clone(), manual_url: Some(manual) };
                return Ok(self.paste_only(guard, first, pkce.verifier.clone(), uri, state));
            }
        };
        let request = AuthorizeRequest {
            redirect_uri: &redirect_uri,
            code_challenge: &pkce.challenge,
            state: &state,
        };
        let first = LoginState::Authorize {
            url: self.provider.authorize_url(&request),
            manual_url: self.provider.manual_authorize_url(&request),
        };
        let provider = self.provider.clone();
        Ok(start_session(guard, first, true, move |mut ctx, _cancel| async move {
            ctx.set(LoginState::Waiting);
            let exchange: Exchange = {
                let (provider, verifier, redirect_uri) = (provider.clone(), pkce.verifier.clone(), redirect_uri.clone());
                Arc::new(move |code: String| {
                    let (provider, verifier, redirect_uri) = (provider.clone(), verifier.clone(), redirect_uri.clone());
                    Box::pin(async move { provider.exchange_checked(&code, &verifier, &redirect_uri).await })
                })
            };
            let Some(server) = server else { unreachable!("a listening flow has its server") };
            let callback = server.wait(exchange);
            tokio::pin!(callback);
            let code = tokio::select! {
                settled = &mut callback => match settled {
                    Settled::Exchanged(done) => return done,
                    Settled::Rejected(error) => Err(error),
                },
                Some(text) = ctx.pasted.recv() => {
                    provider.parse_pasted(&text, &redirect_uri, &state)
                }
            };
            let (code, issued_for) = code.map_err(failure_of)?;
            provider.exchange(&code, &pkce.verifier, &issued_for).await
        }))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_core_api::domain::conformance::check_login_cancel;
    use tokio::io::AsyncReadExt;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpStream;

    struct Fake;

    #[async_trait]
    impl PkceProvider for Fake {
        fn redirect(&self) -> Redirect {
            Redirect { host: "localhost", port: 0, path: "/cb" }
        }
        fn authorize_url(&self, r: &AuthorizeRequest<'_>) -> String {
            format!("https://auth.test/a?redirect_uri={}&state={}", r.redirect_uri, r.state)
        }
        fn callback_pages(&self) -> CallbackPages {
            super::super::callback::pages::OPENAI
        }
        async fn exchange_checked(&self, code: &str, _: &str, _: &str) -> Result<Option<String>, Refusal> {
            if code == "good" {
                Ok(Some("me".into()))
            } else {
                Err(LoginFailure::Denied.into())
            }
        }
    }

    fn flow() -> PkceLoginFlow {
        mixdog_rt::testing::tokens();
        PkceLoginFlow::new(LoginTarget::Provider("fake".into()), Arc::new(Fake))
    }

    #[tokio::test]
    async fn browser_callback_completes_the_flow() {
        let flow = flow();
        let session = flow.start().await.unwrap();
        assert!(matches!(flow.start().await, Err(LoginError::Busy)));
        let LoginState::Authorize { url, .. } = session.next().await.unwrap() else {
            panic!("authorize first")
        };
        let parsed = url::Url::parse(&url).unwrap();
        let q: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        let redirect = url::Url::parse(&q["redirect_uri"]).unwrap();
        let mut browser = TcpStream::connect(("127.0.0.1", redirect.port().unwrap())).await.unwrap();
        let req = format!(
            "GET /cb?code=good&state={} HTTP/1.1\r\nHost: localhost:{}\r\n\r\n",
            q["state"],
            redirect.port().unwrap()
        );
        browser.write_all(req.as_bytes()).await.unwrap();
        let mut sink = String::new();
        browser.read_to_string(&mut sink).await.unwrap();
        let mut last = None;
        while let Some(state) = session.next().await {
            last = Some(state);
        }
        assert_eq!(last, Some(LoginState::Done { account: Some("me".into()) }));
        // The flow is free again.
        flow.start().await.unwrap().cancel();
    }

    /// Anthropic's sign-in with its loopback port taken (`anthropic-oauth-credentials.mjs:755`): the hosted paste page opens
    /// instead of the sign-in failing with `listen_failed`, and the pasted `code#state` is exchanged against its redirect.
    struct Hosted(std::sync::Mutex<Vec<String>>, u16);

    #[async_trait]
    impl PkceProvider for Hosted {
        fn redirect(&self) -> Redirect {
            Redirect { host: "localhost", port: self.1, path: "/cb" }
        }
        fn authorize_url(&self, r: &AuthorizeRequest<'_>) -> String {
            format!("https://auth.test/a?redirect_uri={}", r.redirect_uri)
        }
        fn manual_authorize_url(&self, r: &AuthorizeRequest<'_>) -> Option<String> {
            Some(format!("https://auth.test/hosted?state={}", r.state))
        }
        fn parse_pasted(&self, text: &str, _: &str, state: &str) -> Result<(String, String), CallbackError> {
            let (code, pasted) = text.split_once('#').ok_or(CallbackError::Malformed)?;
            (pasted == state).then(|| (code.to_owned(), "https://auth.test/hosted".to_owned())).ok_or(CallbackError::StateMismatch)
        }
        fn callback_pages(&self) -> CallbackPages {
            super::super::callback::pages::OPENAI
        }
        async fn exchange_checked(&self, _: &str, _: &str, redirect_uri: &str) -> Result<Option<String>, Refusal> {
            self.0.lock().unwrap().push(redirect_uri.to_owned());
            Ok(Some("me".into()))
        }
    }

    #[tokio::test]
    async fn a_taken_loopback_port_falls_back_to_the_hosted_paste_page() {
        mixdog_rt::testing::tokens();
        let taken = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let provider = Arc::new(Hosted(Default::default(), taken.local_addr().unwrap().port()));
        let flow = PkceLoginFlow::new(LoginTarget::Provider("hosted".into()), provider.clone());
        let session = flow.start().await.expect("a taken port is not a failed sign-in");
        let LoginState::Authorize { url, manual_url } = session.started() else { panic!("authorize first") };
        assert!(url.starts_with("https://auth.test/hosted?state="));
        let state = url.split("state=").nth(1).unwrap().to_owned();
        assert_eq!(manual_url, Some(url));
        session.provide(mixdog_core_api::domain::login::LoginInput::AuthorizationCode(format!("abc#{state}"))).await.unwrap();
        let mut last = None;
        while let Some(next) = session.next().await {
            last = Some(next);
        }
        assert_eq!(last, Some(LoginState::Done { account: Some("me".into()) }));
        assert_eq!(*provider.0.lock().unwrap(), ["https://auth.test/hosted"]);
    }

    #[tokio::test]
    async fn passes_the_p0_cancel_conformance() {
        // check_login_flow waits for a terminal state without input, which a
        // loopback flow only reaches by cancel; the browser test covers Done.
        check_login_cancel(&flow()).await;
    }
}