//! Command Code browser sign-in. The Studio CLI auth page mints a Provider API
//! key and POSTs it, with our one-shot state, as JSON to a loopback callback.
//! A pasted key or pasted callback JSON completes the same login by hand. A
//! login already present in the Command Code CLI can be adopted instead.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use async_trait::async_trait;
use mixdog_core_api::domain::login::LoginError;
use mixdog_core_api::domain::login::LoginFailure;
use mixdog_core_api::domain::login::LoginFlow;
use mixdog_core_api::domain::login::LoginSession;
use mixdog_core_api::domain::login::LoginState;
use mixdog_core_api::domain::login::LoginTarget;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ProviderId;
use serde::Deserialize;

use super::Http;
use crate::oauth::FlowGuard;
use crate::oauth::http::call;
use crate::oauth::http::failed;
use crate::oauth::loopback;
use crate::oauth::loopback::Handled;
use crate::oauth::loopback::Request;
use crate::oauth::loopback::Response;
use crate::oauth::http::scrub;
use crate::oauth::start_session;
use crate::accounts::AccountStore;
use crate::oauth::CredentialFile;
use crate::oauth::Probe;
use crate::oauth::random_state;
use crate::providers::compat::creds::COMMAND_CODE_API_ORIGIN;
use crate::providers::compat::creds::COMMAND_CODE_STUDIO_ORIGIN;
use crate::providers::compat::creds::CommandCodeCredentials;

pub const PROVIDER_ID: &str = "command-code-oauth";
/// The callback port Studio is registered with; any free port when taken.
pub const CALLBACK_PORT: u16 = 5959;
const CALLBACK_PATH: &str = "/callback";
const CALLBACK_FIELDS: [&str; 4] = ["apiKey", "userId", "userName", "keyName"];

/// `~/.commandcode/auth.json`, the Command Code CLI's own login.
pub fn default_cli_auth_path() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(".commandcode")
        .join("auth.json")
}

#[derive(Deserialize)]
struct CliAuth {
    #[serde(rename = "apiKey", default)]
    api_key: String,
    #[serde(rename = "userId", default)]
    user_id: String,
}

/// The key of the CLI's login when it states both a well-formed key and a user.
async fn cli_login(file: &CredentialFile) -> Option<CommandCodeCredentials> {
    let Probe::Present(cli) = file.load::<CliAuth>().await else {
        return None;
    };
    let candidate = CommandCodeCredentials {
        api_key: mixdog_js::js_trim(&cli.api_key).to_owned(),
        user_id: String::new(),
        user_name: String::new(),
    };
    (!mixdog_js::js_trim(&cli.user_id).is_empty() && candidate.is_valid()).then_some(candidate)
}

/// The Studio callback body, checked against this login's state.
pub fn parse_callback_payload(doc: &JsonValue, state: &str) -> Result<CommandCodeCredentials, String> {
    let Some(object) = doc.as_object() else {
        return Err("callback body must be an object".into());
    };
    if object.get("state").and_then(JsonValue::as_str) != Some(state) || state.is_empty() {
        return Err("callback state mismatch".into());
    }
    let mut fields = Vec::new();
    for field in CALLBACK_FIELDS {
        match object.get(field).and_then(JsonValue::as_str).map(str::trim).filter(|s| !s.is_empty()) {
            Some(value) => fields.push(value.to_owned()),
            None => return Err(format!("callback is missing {field}")),
        }
    }
    let credentials = CommandCodeCredentials {
        api_key: fields[0].clone(),
        user_id: fields[1].clone(),
        user_name: fields[2].clone(),
    };
    if !credentials.is_valid() {
        return Err("callback carried a malformed API key".into());
    }
    Ok(credentials)
}

/// A paste is either the callback JSON (state-checked) or a bare API key.
pub fn parse_pasted_input(input: &str, state: &str) -> Result<CommandCodeCredentials, String> {
    let pasted = mixdog_js::js_trim(input);
    if pasted.is_empty() {
        return Err("API key is required".into());
    }
    if pasted.starts_with('{') {
        let doc: JsonValue = serde_json::from_str(pasted).map_err(|_| "pasted callback is not valid JSON".to_owned())?;
        return parse_callback_payload(&doc, state);
    }
    let credentials = CommandCodeCredentials {
        api_key: pasted.to_owned(),
        user_id: String::new(),
        user_name: String::new(),
    };
    if credentials.is_valid() {
        Ok(credentials)
    } else {
        Err("pasted API key is malformed".into())
    }
}

/// The account behind a key: whoami's user id is the stable identity.
async fn whoami(http: &Http, api_key: &str) -> Result<(String, String), LoginFailure> {
    let reply = call(
        http.as_ref(),
        "GET",
        &format!("{COMMAND_CODE_API_ORIGIN}/alpha/whoami"),
        vec![("accept", "application/json".to_owned()), ("authorization", format!("Bearer {api_key}"))],
        Vec::new(),
    )
    .await?;
    if reply.status == 401 {
        return Err(failed("invalid_grant", "API key rejected (401): sign in again"));
    }
    let doc = reply.json().filter(|_| reply.ok()).ok_or_else(|| {
        failed("whoami", format!("whoami {}: {}", reply.status, scrub(mixdog_js::js_trim(&reply.text()), &[api_key], 300)))
    })?;
    let user = doc.get("user");
    let text = |field: &str| user.and_then(|u| u.get(field)).and_then(JsonValue::as_str).map_or("", str::trim).to_owned();
    let user_id = text("id");
    if user_id.is_empty() {
        return Err(failed("whoami", "whoami returned no user id"));
    }
    Ok((user_id, text("userName")))
}

/// Validates the key under its whoami identity and stores it.
async fn settle(http: &Http, file: &CredentialFile, candidate: CommandCodeCredentials) -> Result<Option<String>, LoginFailure> {
    let (user_id, user_name) = whoami(http, &candidate.api_key).await?;
    let credentials = CommandCodeCredentials {
        api_key: candidate.api_key,
        user_id,
        user_name: if user_name.is_empty() { candidate.user_name } else { user_name },
    };
    file.save(&credentials).await.map_err(|err| failed("store", err.to_string()))?;
    Ok(Some(credentials.user_id))
}

fn cors(response: Response) -> Response {
    response
        .header("access-control-allow-origin", COMMAND_CODE_STUDIO_ORIGIN)
        .header("access-control-allow-methods", "POST, OPTIONS")
        .header("access-control-allow-headers", "Content-Type")
        // The Studio page is public and the callback is loopback: Chromium asks first.
        .header("access-control-allow-private-network", "true")
        .header("vary", "Origin")
}

fn json_reply(status: u16, success: bool, error: Option<&str>) -> Response {
    let body = match error {
        Some(message) => serde_json::json!({"success": success, "error": message}),
        None => serde_json::json!({"success": success}),
    };
    cors(Response::new(status).body("application/json", body.to_string()))
}

pub struct CommandCodeLogin {
    target: LoginTarget,
    http: Http,
    file: CredentialFile,
    /// The CLI's login file (see [`default_cli_auth_path`]), adopted on a first sign-in.
    cli_auth: CredentialFile,
    /// The account roster: adding or reconnecting an account must use a fresh
    /// browser identity, never the CLI's.
    accounts: AccountStore,
    running: Arc<AtomicBool>,
}

impl CommandCodeLogin {
    pub fn new(http: Http, file: CredentialFile, cli_auth: CredentialFile, accounts: AccountStore) -> Self {
        Self {
            target: LoginTarget::Provider(ProviderId::from(PROVIDER_ID)),
            http,
            file,
            cli_auth,
            accounts,
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    /// No account of this provider is connected yet: no roster entry and no
    /// credential in the default slot. An unreadable roster is not a first sign-in.
    async fn is_first_sign_in(&self) -> bool {
        let provider = PROVIDER_ID;
        matches!(self.accounts.accounts(provider).await, Ok(accounts) if accounts.is_empty())
            && matches!(self.accounts.has_credential(provider, "default").await, Ok(false))
    }
}

#[async_trait]
impl LoginFlow for CommandCodeLogin {
    fn target(&self) -> &LoginTarget {
        &self.target
    }

    async fn start(&self) -> Result<Box<dyn LoginSession>, LoginError> {
        let guard = FlowGuard::claim(&self.running).ok_or(LoginError::Busy)?;
        let (http, file) = (self.http.clone(), self.file.clone());
        if self.is_first_sign_in().await
            && let Some(candidate) = cli_login(&self.cli_auth).await
            // A stale or rejected CLI login falls through to the browser.
            && let Ok(account) = settle(&http, &file, candidate).await
        {
            return Ok(start_session(guard, LoginState::Starting, false, move |_, _| async move { Ok(account) }));
        }
        let bound = match loopback::bind(CALLBACK_PORT, true).await {
            Ok(bound) => bound,
            Err(_) => loopback::bind(0, true)
                .await
                .map_err(|err| LoginError::Failed(failed("listen_failed", err.kind().to_string())))?,
        };
        let (listeners, port) = bound;
        let state = random_state();
        let mut url = url::Url::parse(&format!("{COMMAND_CODE_STUDIO_ORIGIN}/studio/auth/cli")).expect("a constant URL parses");
        url.query_pairs_mut()
            .append_pair("callback", &format!("http://127.0.0.1:{port}{CALLBACK_PATH}"))
            .append_pair("state", &state);
        Ok(start_session(guard, LoginState::Authorize { url: url.into(), manual_url: None }, true, move |mut ctx, _| async move {
            ctx.set(LoginState::Waiting);
            let served = {
                let (state, http, file) = (state.clone(), http.clone(), file.clone());
                loopback::serve(listeners, move |request: Request| -> Handled<Result<Option<String>, LoginFailure>> {
                    let (state, http, file) = (state.clone(), http.clone(), file.clone());
                    Box::pin(async move {
                        if request.header("origin").is_some_and(|o| o != COMMAND_CODE_STUDIO_ORIGIN) {
                            return (json_reply(403, false, Some("Forbidden origin")), None);
                        }
                        if request.method == "OPTIONS" {
                            return (cors(Response::new(204)), None);
                        }
                        if request.path() != CALLBACK_PATH {
                            return (json_reply(404, false, Some("Not found")), None);
                        }
                        if request.method != "POST" {
                            return (json_reply(405, false, Some("Method not allowed")), None);
                        }
                        // Anything that is not this login's well-formed callback is
                        // refused and the login keeps waiting.
                        let Ok(doc) = serde_json::from_slice::<JsonValue>(&request.body) else {
                            return (json_reply(400, false, Some("Invalid JSON body")), None);
                        };
                        let candidate = match parse_callback_payload(&doc, &state) {
                            Ok(candidate) => candidate,
                            Err(message) => return (json_reply(400, false, Some(&message)), None),
                        };
                        match settle(&http, &file, candidate).await {
                            Ok(account) => (json_reply(200, true, None), Some(Ok(account))),
                            Err(failure) => (json_reply(400, false, Some("API key validation failed")), Some(Err(failure))),
                        }
                    })
                })
            };
            tokio::pin!(served);
            tokio::select! {
                done = &mut served => done,
                Some(text) = ctx.pasted.recv() => {
                    let candidate = parse_pasted_input(&text, &state).map_err(|message| failed("invalid_code", message))?;
                    settle(&http, &file, candidate).await
                }
            }
        }))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tokio::io::AsyncReadExt;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpStream;
use crate::oauth::http::testing::Scripted;
use crate::oauth::http::testing::finish;
    use super::*;
    use crate::oauth::CredentialIo;
    use crate::oauth::Probe;

    fn store(dir: &tempfile::TempDir) -> CredentialFile {
        let tokens = mixdog_rt::testing::tokens();
        CredentialFile::new(
            dir.path().join("command-code-oauth.json"),
            CredentialIo { read: tokens.interactive_io, write: tokens.durability_io },
        )
    }

    fn accounts(dir: &tempfile::TempDir) -> AccountStore {
        let tokens = mixdog_rt::testing::tokens();
        AccountStore::new(
            dir.path().to_path_buf(),
            CredentialIo { read: tokens.interactive_io, write: tokens.durability_io },
        )
    }

    fn cli_auth(dir: &tempfile::TempDir) -> CredentialFile {
        let tokens = mixdog_rt::testing::tokens();
        CredentialFile::new(
            dir.path().join("cli-auth.json"),
            CredentialIo { read: tokens.interactive_io, write: tokens.durability_io },
        )
    }

    async fn post(port: u16, origin: &str, body: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let request = format!(
            "POST /callback HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: {origin}\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut out = String::new();
        stream.read_to_string(&mut out).await.unwrap();
        out
    }

    async fn start_url(session: &dyn LoginSession) -> (u16, String) {
        loop {
            if let Some(LoginState::Authorize { url, .. }) = session.next().await {
                let url = url::Url::parse(&url).unwrap();
                let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
                let port = url::Url::parse(&query["callback"]).unwrap().port().unwrap();
                return (port, query["state"].clone());
            }
        }
    }

    const WHOAMI: &str = r#"{"user":{"id":"U1","userName":"ann"}}"#;

    #[tokio::test]
    async fn the_studio_callback_stores_the_key_under_its_whoami_identity() {
        mixdog_rt::testing::tokens();
        let dir = tempfile::tempdir().unwrap();
        let http = Scripted::new(&[(200, WHOAMI)]);
        let flow = CommandCodeLogin::new(http.clone(), store(&dir), cli_auth(&dir), accounts(&dir));
        let session = flow.start().await.unwrap();
        let (port, state) = start_url(session.as_ref()).await;
        let body = |state: &str, key: &str| json!({"state": state, "apiKey": key, "userId": "x", "userName": "n", "keyName": "k"}).to_string();
        assert!(post(port, "https://evil.example", &body(&state, "key-1")).await.starts_with("HTTP/1.1 403"));
        assert!(post(port, COMMAND_CODE_STUDIO_ORIGIN, &body("other", "key-1")).await.contains("state mismatch"));
        assert!(post(port, COMMAND_CODE_STUDIO_ORIGIN, "not json").await.starts_with("HTTP/1.1 400"));
        let ok = post(port, COMMAND_CODE_STUDIO_ORIGIN, &body(&state, "key-1")).await;
        assert!(ok.starts_with("HTTP/1.1 200") && ok.contains("access-control-allow-origin"), "{ok}");
        assert_eq!(finish(session.as_ref()).await.last(), Some(&LoginState::Done { account: Some("U1".into()) }));
        assert!(http.seen.lock().unwrap()[0].headers.contains(&("authorization".into(), "Bearer key-1".into())));
        let Probe::Present(saved) = store(&dir).load::<CommandCodeCredentials>().await else { panic!("stored") };
        assert_eq!((saved.api_key.as_str(), saved.user_id.as_str(), saved.user_name.as_str()), ("key-1", "U1", "ann"));
    }

    #[tokio::test]
    async fn a_pasted_key_and_an_adopted_cli_login_complete_the_same_way() {
        mixdog_rt::testing::tokens();
        let dir = tempfile::tempdir().unwrap();
        let flow = CommandCodeLogin::new(Scripted::new(&[(200, WHOAMI)]), store(&dir), cli_auth(&dir), accounts(&dir));
        let session = flow.start().await.unwrap();
        session.provide(mixdog_core_api::domain::login::LoginInput::AuthorizationCode("  key-2 ".into())).await.unwrap();
        assert_eq!(finish(session.as_ref()).await.last(), Some(&LoginState::Done { account: Some("U1".into()) }));
        store(&dir).remove().await.unwrap();

        // The CLI's login is adopted on a first sign-in, without a browser step.
        cli_auth(&dir).save(&json!({"apiKey": "cli-key", "userId": "cli-user"})).await.unwrap();
        let first = CommandCodeLogin::new(Scripted::new(&[(200, WHOAMI)]), store(&dir), cli_auth(&dir), accounts(&dir));
        let session = first.start().await.unwrap();
        let states = finish(session.as_ref()).await;
        assert!(!states.iter().any(|s| matches!(s, LoginState::Authorize { .. })), "no browser step");
        assert_eq!(states.last(), Some(&LoginState::Done { account: Some("U1".into()) }));
        let Probe::Present(saved) = store(&dir).load::<CommandCodeCredentials>().await else { panic!("stored") };
        assert_eq!(saved.api_key, "cli-key");

        // Not on a reconnect (the default slot holds a credential): a fresh browser identity.
        let flow = CommandCodeLogin::new(Scripted::new(&[]), store(&dir), cli_auth(&dir), accounts(&dir));
        let session = flow.start().await.unwrap();
        assert!(matches!(session.next().await, Some(LoginState::Authorize { .. })));
        session.cancel();

        // Nor when the roster already has an account, even with no default credential.
        store(&dir).remove().await.unwrap();
        let second = crate::accounts::new_account_id();
        accounts(&dir).register(PROVIDER_ID, &second, "Second", false).await.unwrap();
        let flow = CommandCodeLogin::new(Scripted::new(&[]), store(&dir), cli_auth(&dir), accounts(&dir));
        let session = flow.start().await.unwrap();
        assert!(matches!(session.next().await, Some(LoginState::Authorize { .. })));
        session.cancel();

        // A rejected CLI login falls through to the browser.
        accounts(&dir).remove(PROVIDER_ID, &second).await.unwrap();
        let stale = CommandCodeLogin::new(Scripted::new(&[(401, "")]), store(&dir), cli_auth(&dir), accounts(&dir));
        let session = stale.start().await.unwrap();
        assert!(matches!(session.next().await, Some(LoginState::Authorize { .. })));
        session.cancel();
    }

    #[tokio::test]
    #[allow(clippy::disallowed_methods, reason = "test fixture write")]
    async fn a_newer_roster_reads_as_empty_and_a_failed_read_is_not_first() {
        mixdog_rt::testing::tokens();
        let dir = tempfile::tempdir().unwrap();
        cli_auth(&dir).save(&json!({"apiKey": "cli-key", "userId": "cli-user"})).await.unwrap();
        // Node's reader returns the empty fallback for a newer roster, so only
        // the default-slot credential decides: none, hence a first sign-in.
        std::fs::write(accounts(&dir).roster_path(), r#"{"version":2,"providers":{}}"#).unwrap();
        let flow = CommandCodeLogin::new(Scripted::new(&[(200, WHOAMI)]), store(&dir), cli_auth(&dir), accounts(&dir));
        assert!(flow.is_first_sign_in().await);

        // A read that fails (here: the roster path is a directory) reaches
        // Node's `catch`, which cannot prove a first account: false.
        std::fs::remove_file(accounts(&dir).roster_path()).unwrap();
        std::fs::create_dir(accounts(&dir).roster_path()).unwrap();
        let flow = CommandCodeLogin::new(Scripted::new(&[]), store(&dir), cli_auth(&dir), accounts(&dir));
        assert!(accounts(&dir).accounts(PROVIDER_ID).await.is_err());
        assert!(!flow.is_first_sign_in().await);
        let session = flow.start().await.unwrap();
        assert!(matches!(session.next().await, Some(LoginState::Authorize { .. })));
        session.cancel();
    }

    #[test]
    fn pasted_input_is_checked() {
        assert!(parse_pasted_input("", "s").is_err());
        assert!(parse_pasted_input("has space", "s").is_err());
        assert!(parse_pasted_input("{\"state\":\"x\"}", "s").is_err());
        let doc = json!({"state": "s", "apiKey": "k", "userId": "u", "userName": "n", "keyName": "kn"}).to_string();
        assert_eq!(parse_pasted_input(&doc, "s").unwrap().user_id, "u");
    }
}
