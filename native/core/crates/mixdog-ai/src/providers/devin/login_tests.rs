//! The Devin sign-in against Node's (`fixtures/devin-login/golden.json`, `record-devin-login.mjs`):
//! the authorize URL for the recorded state and challenge, and every code exchange: the request
//! sent, the token record stored (key order included) or the failure raised.

use std::sync::Arc;

use super::login::DevinLogin;
use crate::oauth::http::testing::Scripted;
use crate::oauth::{CredentialFile, CredentialIo, PkceProvider};
use crate::transport::HttpSend;

fn io() -> CredentialIo {
    let tokens = mixdog_rt::testing::tokens();
    CredentialIo { read: tokens.interactive_io, write: tokens.durability_io }
}

fn login(file: CredentialFile, http: Arc<dyn HttpSend>, now: u64) -> DevinLogin {
    DevinLogin::new(file, http).with_clock(Arc::new(move || now))
}

/// The token Devin's sign-in keeps (`token`, a field no OAuth grant names) is a credential from the moment it is kept:
/// a later text that repeats it is redacted (review 1124e).
#[tokio::test]
async fn the_token_a_sign_in_keeps_is_a_credential_at_once() {
    let dir = tempfile::tempdir().unwrap();
    let scripted = Scripted::new(&[(200, r#"{"token":"devin-login-token-7a31c9e0"}"#)]);
    let provider = login(CredentialFile::new(dir.path().join("devin-oauth.json"), io()), scripted, 0);
    provider.exchange("the-code", "the-verifier", "unused").await.expect("signed in");
    assert_eq!(crate::oauth::carried::remembered().redact_str("echo devin-login-token-7a31c9e0 end"), "echo [REDACTED] end");
}

/// The code exchange that outlives its timer reads as the real Node function did (`sites.devinExchange`): a coded failure
/// naming the cause, "timed out".
#[tokio::test(start_paused = true)]
async fn an_exchange_that_outlives_its_timer_reads_as_nodes() {
    use crate::transport::site_probe::{TimingOut, assert_thrown, assert_transport, login_message};

    let transport = TimingOut::new();
    let dir = tempfile::tempdir().unwrap();
    let provider = login(CredentialFile::new(dir.path().join("devin-oauth.json"), io()), transport.clone(), 0);
    let failure = provider.exchange("c", "v", "unused").await.expect_err("never answers");
    assert_transport("devinExchange", &transport);
    assert_thrown("devinExchange", login_message(&failure));
}
