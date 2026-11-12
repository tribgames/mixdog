//! MiMo browser sign-in. The platform seals the minted API key to a one-shot
//! X25519 key sent in the authorize URL; the reply, by loopback redirect or a
//! pasted code, carries it as `u`. A Token Plan key that arrives without a
//! gateway URL is routed to its region before the credential is stored.

use std::path::Path;
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
use mixdog_protocol::ProviderId;
use serde::Deserialize;
use serde::Serialize;

use super::Http;
use crate::oauth::FlowGuard;
use crate::oauth::http::call_under;
use crate::transport::deadlines::TOKEN_PROBE;
use crate::oauth::http::failed;
use crate::oauth::loopback;
use crate::oauth::loopback::Handled;
use crate::oauth::loopback::Request;
use crate::oauth::loopback::Response;
use crate::oauth::scrub::scrubbed_excerpt;
use crate::oauth::start_session;
use crate::oauth::CredentialFile;
use crate::oauth::Probe;
use crate::providers::compat::creds::MIMO_DEFAULT_BASE_URL;
use crate::providers::compat::creds::MIMO_PLATFORM_ORIGIN;
use crate::providers::compat::creds::MIMO_TOKEN_PLAN_BASE_URLS;
use crate::providers::compat::creds::MimoCredentials;
use crate::providers::compat::creds::MimoLoginKey;
use crate::providers::compat::creds::mimo_authorize_url;
use crate::providers::compat::creds::mimo_code_from_input;

pub const PROVIDER_ID: &str = "mimo-oauth";
const SOURCE_HEADER: (&str, &str) = ("x-mimo-source", "mimocode-cli");
const TOKEN_PLAN_KEY_PREFIX: &str = "tp-";
const TOKEN_PLAN_PROBE_MODEL: &str = "mimo-v2.5";

/// The regional gateway that accepts a Token Plan key. A 401 or any other
/// failure moves on to the next region; every region rejecting the key asks
/// for a new sign-in.
pub async fn probe_token_plan(http: &Http, api_key: &str) -> Result<&'static str, LoginFailure> {
    let body = serde_json::json!({
        "model": TOKEN_PLAN_PROBE_MODEL,
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "ping"}],
    })
    .to_string();
    let mut last = failed("token_plan", "[mimo-oauth] Token Plan check failed");
    // The last refusal's body, which a rejected key's sign-in message repeats (`mimoReauthError(detail)`).
    let mut last_detail = String::new();
    let mut all_rejected = true;
    for base in MIMO_TOKEN_PLAN_BASE_URLS {
        let sent = call_under(
            http.as_ref(),
            TOKEN_PROBE,
            "POST",
            &format!("{base}/chat/completions"),
            vec![
                ("content-type", "application/json".to_owned()),
                ("authorization", format!("Bearer {api_key}")),
                (SOURCE_HEADER.0, SOURCE_HEADER.1.to_owned()),
            ],
            body.clone().into_bytes(),
        )
        .await;
        match sent {
            Ok(reply) if reply.ok() => return Ok(base),
            Ok(reply) => {
                if reply.status != 401 {
                    all_rejected = false;
                }
                last_detail = scrubbed_excerpt(&reply.text(), &[api_key], 300);
                let suffix = if last_detail.is_empty() { String::new() } else { format!(": {last_detail}") };
                last = failed("token_plan", format!("[mimo-oauth] Token Plan check failed ({}){suffix}", reply.status));
            }
            Err(fault) => {
                all_rejected = false;
                last_detail = String::new();
                last = fault;
            }
        }
    }
    if all_rejected {
        let suffix = if last_detail.is_empty() { String::new() } else { format!(": {last_detail}") };
        return Err(failed(
            "invalid_grant",
            format!("[mimo-oauth] API key rejected (401) \u{2014} open /providers in mixdog to sign in again{suffix}"),
        ));
    }
    Err(last)
}

/// A Token Plan key whose gateway is unknown is resolved before storing.
async fn settle(http: &Http, file: &CredentialFile, mut credentials: MimoCredentials) -> Result<Option<String>, LoginFailure> {
    let unrouted = credentials.base_url.is_empty() || credentials.base_url == MIMO_DEFAULT_BASE_URL;
    if credentials.api_key.starts_with(TOKEN_PLAN_KEY_PREFIX) && unrouted {
        credentials.base_url = probe_token_plan(http, &credentials.api_key).await?.to_owned();
    }
    file.keep(&[&credentials.api_key]);
    file.save(&credentials).await.map_err(|err| failed("store", err.to_string()))?;
    Ok(Some(credentials.uid).filter(|u| !u.is_empty()))
}

/// The text of a settle failure (`error.message`), never its Debug form.
fn failure_message(failure: &LoginFailure) -> String {
    match failure {
        LoginFailure::Failed { message, .. } => message.clone(),
        LoginFailure::Denied => "authorization denied".to_owned(),
        LoginFailure::Expired => "authorization expired".to_owned(),
        LoginFailure::Unavailable { capability } => format!("{capability} is unavailable"),
        LoginFailure::VerificationRequired { url, .. } => format!("verify the account at {url}"),
    }
}

fn result_redirect(error: Option<&str>) -> Response {
    let mut url = url::Url::parse(&format!("{MIMO_PLATFORM_ORIGIN}/authorize/callback")).expect("a constant URL parses");
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("status", if error.is_some() { "error" } else { "success" });
        if let Some(message) = error {
            query.append_pair("message", &mixdog_js::slice_utf16(message, 200));
        }
    }
    Response::new(302).header("location", url.as_str())
}

/// `mimo-oauth-key-name.json` in the data directory.
pub fn key_name_path(data_dir: &Path) -> PathBuf {
    data_dir.join("mimo-oauth-key-name.json")
}

#[derive(Serialize, Deserialize)]
struct KeyName {
    #[serde(rename = "keyName")]
    key_name: String,
}

/// The name the platform shows the key under: generated once, then reused so
/// repeated sign-ins replace one key instead of piling up new ones.
async fn key_name(file: &CredentialFile) -> Result<String, LoginFailure> {
    if let Probe::Present(saved) = file.load::<KeyName>().await
        && !saved.key_name.is_empty()
    {
        return Ok(saved.key_name);
    }
    let name = format!("mimo-code-cli-key-{:08x}", rand::random::<u32>());
    file.save(&KeyName { key_name: name.clone() })
        .await
        .map_err(|err| failed("store", err.to_string()))?;
    Ok(name)
}

pub struct MimoLogin {
    target: LoginTarget,
    http: Http,
    file: CredentialFile,
    /// The file holding the key name (see [`key_name_path`]).
    key_name_file: CredentialFile,
    running: Arc<AtomicBool>,
}

impl MimoLogin {
    pub fn new(http: Http, file: CredentialFile, key_name_file: CredentialFile) -> Self {
        Self {
            target: LoginTarget::Provider(ProviderId::from(PROVIDER_ID)),
            http,
            file,
            key_name_file,
            running: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[async_trait]
impl LoginFlow for MimoLogin {
    fn target(&self) -> &LoginTarget {
        &self.target
    }

    async fn start(&self) -> Result<Box<dyn LoginSession>, LoginError> {
        let guard = FlowGuard::claim(&self.running).ok_or(LoginError::Busy)?;
        let (listeners, port) = loopback::bind(0, true).await.map_err(|err| {
            LoginError::Failed(failed("listen_failed", err.kind().to_string()))
        })?;
        let key = Arc::new(MimoLoginKey::generate());
        let key_name = key_name(&self.key_name_file).await.map_err(LoginError::Failed)?;
        let url = mimo_authorize_url(&key.public_key_b64(), &format!("http://localhost:{port}/"), &key_name);
        let (http, file) = (self.http.clone(), self.file.clone());
        // Node `manualRedirectUri`: the platform's own page shows the sealed code to paste.
        let manual_url = mimo_authorize_url(
            &key.public_key_b64(),
            &format!("{MIMO_PLATFORM_ORIGIN}/authorize/code/callback"),
            &key_name,
        );
        let state = LoginState::Authorize { url, manual_url: Some(manual_url) };
        Ok(start_session(guard, state, true, move |mut ctx, _| async move {
            ctx.set(LoginState::Waiting);
            let served = {
                let (key, http, file) = (key.clone(), http.clone(), file.clone());
                loopback::serve(listeners, move |request: Request| -> Handled<Result<Option<String>, LoginFailure>> {
                    let (key, http, file) = (key.clone(), http.clone(), file.clone());
                    Box::pin(async move {
                        let u = request.query("u").filter(|u| !u.is_empty() && request.path() == "/");
                        let Some(u) = u else { return (Response::new(404), None) };
                        // Only a payload sealed to this login's key settles it.
                        let Ok(credentials) = key.open(&u) else {
                            return (Response::new(400).body("text/plain; charset=utf-8", "Invalid authorization payload"), None);
                        };
                        match settle(&http, &file, credentials).await {
                            Ok(account) => (result_redirect(None), Some(Ok(account))),
                            Err(failure) => (result_redirect(Some(&failure_message(&failure))), Some(Err(failure))),
                        }
                    })
                })
            };
            tokio::pin!(served);
            tokio::select! {
                done = &mut served => done,
                Some(text) = ctx.pasted.recv() => {
                    let credentials = mimo_code_from_input(&text)
                        .ok_or_else(|| failed("invalid_code", "authorization code is required"))
                        .and_then(|code| key.open(&code).map_err(|err| failed("invalid_code", err.to_string())))?;
                    settle(&http, &file, credentials).await
                }
            }
        }))
    }
}

#[cfg(test)]
mod tests {
    use aes_gcm::Aes256Gcm;
    use aes_gcm::Nonce;
    use aes_gcm::aead::Aead;
    use aes_gcm::aead::KeyInit;
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use sha2::Digest;
    use sha2::Sha256;
    use tokio::io::AsyncReadExt;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpStream;
    use x25519_dalek::PublicKey;
    use x25519_dalek::StaticSecret;
use crate::oauth::http::testing::Scripted;
use crate::oauth::http::testing::finish;
    use super::*;

    #[test]
    fn a_failed_settle_redirects_with_its_message_not_its_debug_form() {
        let failure = failed("store", "disk full");
        let response = result_redirect(Some(&failure_message(&failure)));
        let location = response
            .headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("location"))
            .map(|(_, v)| v.clone())
            .unwrap();
        let url = url::Url::parse(&location).unwrap();
        let pairs: Vec<_> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        assert_eq!(pairs, [("status".into(), "error".into()), ("message".into(), "disk full".into())]);
    }
    use crate::oauth::CredentialIo;
    use crate::oauth::Probe;

    /// The Token Plan probe whose every region outlives its timer ends as the real Node function did
    /// (`sites.mimoProbe`): the last region's `AbortSignal.timeout` error.
    #[tokio::test(start_paused = true)]
    async fn a_probe_that_outlives_its_timer_reads_as_nodes() {
        use crate::transport::site_probe::TimingOut;
        use crate::transport::site_probe::assert_thrown;
        use crate::transport::site_probe::assert_transport;
        use crate::transport::site_probe::login_message;

        let transport = TimingOut::new();
        let http: Http = transport.clone();
        let failure = probe_token_plan(&http, "k").await.expect_err("never answers");
        assert_transport("mimoProbe", &transport);
        assert_eq!(
            transport.seen().len(),
            crate::transport::site_probe::recorded("mimoProbe")["armed"].as_array().unwrap().len(),
            "every region is tried under a timer of its own"
        );
        assert_thrown("mimoProbe", login_message(&failure));
    }

    fn names(dir: &tempfile::TempDir) -> CredentialFile {
        let tokens = mixdog_rt::testing::tokens();
        CredentialFile::new(
            key_name_path(dir.path()),
            CredentialIo { read: tokens.interactive_io, write: tokens.durability_io },
        )
    }

    fn store(dir: &tempfile::TempDir) -> CredentialFile {
        let tokens = mixdog_rt::testing::tokens();
        CredentialFile::new(
            dir.path().join("mimo-oauth.json"),
            CredentialIo { read: tokens.interactive_io, write: tokens.durability_io },
        )
    }

    /// The platform's side: seals `doc` to the public key found in the authorize URL.
    fn seal(authorize_url: &str, doc: &serde_json::Value) -> String {
        let url = url::Url::parse(authorize_url).unwrap();
        let pk = url.query_pairs().find(|(k, _)| k == "pk").unwrap().1.into_owned();
        let der = URL_SAFE_NO_PAD.decode(pk).unwrap();
        let public: [u8; 32] = der[12..].try_into().unwrap();
        let ephemeral = StaticSecret::from([9u8; 32]);
        let shared = ephemeral.diffie_hellman(&PublicKey::from(public));
        let cipher = Aes256Gcm::new_from_slice(&Sha256::digest(shared.as_bytes())).unwrap();
        let sealed = cipher.encrypt(Nonce::from_slice(&[4u8; 12]), doc.to_string().as_bytes()).unwrap();
        let mut payload = PublicKey::from(&ephemeral).as_bytes().to_vec();
        payload.extend_from_slice(&[4u8; 12]);
        payload.extend_from_slice(&sealed);
        URL_SAFE_NO_PAD.encode(payload)
    }

    async fn browser(url: &str, u: &str) -> String {
        let redirect = url::Url::parse(url).unwrap().query_pairs().find(|(k, _)| k == "redirect_uri").unwrap().1.into_owned();
        let port = url::Url::parse(&redirect).unwrap().port().unwrap();
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(format!("GET /?u={u} HTTP/1.1\r\nHost: localhost\r\n\r\n").as_bytes()).await.unwrap();
        let mut out = String::new();
        stream.read_to_string(&mut out).await.unwrap();
        out
    }

    async fn authorize(session: &dyn LoginSession) -> String {
        loop {
            if let Some(LoginState::Authorize { url, .. }) = session.next().await {
                return url;
            }
        }
    }

    #[tokio::test]
    async fn the_loopback_reply_stores_the_credential_and_redirects() {
        mixdog_rt::testing::tokens();
        let dir = tempfile::tempdir().unwrap();
        // A name saved by an earlier sign-in is reused.
        names(&dir).save(&KeyName { key_name: "key-1".into() }).await.unwrap();
        let flow = MimoLogin::new(Scripted::new(&[]), store(&dir), names(&dir));
        let session = flow.start().await.unwrap();
        let url = authorize(session.as_ref()).await;
        assert!(url.starts_with("https://platform.xiaomimimo.com/authorize?pk="));
        assert!(url.contains("key_name=key-1"));
        // Something that is not sealed to this login's key is refused and the login waits on.
        assert!(browser(&url, "AAAA").await.starts_with("HTTP/1.1 400"));
        let u = seal(&url, &serde_json::json!({"sk": "sk-live", "uid": 7}));
        let answer = browser(&url, &u).await;
        assert!(answer.starts_with("HTTP/1.1 302") && answer.contains("status=success"), "{answer}");
        assert_eq!(finish(session.as_ref()).await.last(), Some(&LoginState::Done { account: Some("7".into()) }));
        let Probe::Present(saved) = store(&dir).load::<MimoCredentials>().await else { panic!("stored") };
        assert_eq!((saved.api_key.as_str(), saved.base_url.as_str()), ("sk-live", ""));
    }

    #[tokio::test]
    async fn a_pasted_token_plan_key_is_routed_to_the_first_region_that_accepts_it() {
        mixdog_rt::testing::tokens();
        let dir = tempfile::tempdir().unwrap();
        let http = Scripted::new(&[(401, "no"), (200, "{}")]);
        let flow = MimoLogin::new(http.clone(), store(&dir), names(&dir));
        let session = flow.start().await.unwrap();
        let url = authorize(session.as_ref()).await;
        // No name saved yet: one is generated and kept for the next sign-in.
        let generated = key_name(&names(&dir)).await.unwrap();
        assert!(generated.starts_with("mimo-code-cli-key-") && generated.len() == "mimo-code-cli-key-".len() + 8);
        assert!(url.contains(&format!("key_name={generated}")));
        let u = seal(&url, &serde_json::json!({"sk": "tp-abc"}));
        session.provide(mixdog_core_api::domain::login::LoginInput::AuthorizationCode(u)).await.unwrap();
        assert_eq!(finish(session.as_ref()).await.last(), Some(&LoginState::Done { account: None }));
        let Probe::Present(saved) = store(&dir).load::<MimoCredentials>().await else { panic!("stored") };
        assert_eq!(saved.base_url, "https://token-plan-ams.xiaomimimo.com/v1");
        let seen = http.seen.lock().unwrap();
        assert_eq!(seen[0].url, "https://token-plan-sgp.xiaomimimo.com/v1/chat/completions");
        assert!(seen[0].headers.contains(&("x-mimo-source".into(), "mimocode-cli".into())));
    }

    #[tokio::test]
    async fn a_key_every_region_rejects_asks_for_a_new_sign_in() {
        let http = Scripted::new(&[(401, "a"), (401, "b"), (401, "c")]);
        let got = probe_token_plan(&(http as Http), "tp-x").await;
        assert!(matches!(got, Err(LoginFailure::Failed { code, .. }) if code == "invalid_grant"));
    }
}
