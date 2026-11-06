//! `GmailVerifier` as `src/runtime/connectors/gmail-app-password.mjs` verifies an app password:
//! one IMAP session on imap.gmail.com:993 and one SMTP check on smtp.gmail.com:465, both over
//! TLS from the first byte, each with a 20 s connection, 15 s greeting and 60 s socket timeout.
//! A failure becomes one fixed sentence per cause (`GMAIL_APP_PASSWORD_<CODE>: …`) and the
//! password never appears in it.
//!
//! Known gaps against Node: the server certificate is checked against the system roots (Node
//! uses its bundled list), certificate failures carry Node's codes but only the leading words of
//! its messages, and SMTP CRAM-MD5 is not spoken (Gmail does not offer it).

mod imap;
mod smtp;
#[cfg(test)]
mod tests;
mod wire;

use std::sync::{Arc, LazyLock};

use async_trait::async_trait;
use regex::Regex;
use rustls::{ClientConfig, RootCertStore};

use crate::mcp_secrets::GmailVerifier;
pub use wire::{Target, Timeouts};
use wire::Failure;

/// One server to speak to.
pub(crate) struct Leg<'a> {
    pub target: &'a Target,
    pub tls: &'a Arc<ClientConfig>,
    pub timeouts: Timeouts,
}

/// `MESSAGES`: one fixed sentence per cause.
fn sentence(code: &str) -> &'static str {
    match code {
        "REJECTED" => "Google did not accept this address and app password.",
        "UNAVAILABLE" => {
            "Google refused app-password access for this account: app passwords need 2-Step Verification, and a Workspace admin can block them or IMAP."
        }
        "NETWORK" => "Couldn't reach Gmail. Check the network connection.",
        "MISSING" => "No Gmail app password is saved on this computer. Connect Gmail again with an app password.",
        _ => "Gmail refused the request.",
    }
}

/// `NETWORK_CODES`.
const NETWORK_CODES: [&str; 15] = [
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EPIPE",
    "CONNECT_TIMEOUT",
    "GREETING_TIMEOUT",
    "UPGRADE_TIMEOUT",
    "NoConnection",
    "ESOCKET",
    "ECONNECTION",
    "EDNS",
];

// Gmail's answers when an app password cannot be used here, and when it was not accepted.
static UNAVAILABLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)application-specific password|web ?login required|WEBALERT|IMAP access is disabled|not enabled for IMAP|domain administrator|5\.7\.9|5\.7\.14",
    )
    .expect("a fixed pattern")
});
static REJECTED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)AUTHENTICATIONFAILED|Invalid credentials|Username and Password not accepted|5\.7\.8").expect("a fixed pattern")
});

const DETAIL_CHARS: usize = 200;

/// `gmailError(error, password)` rendered as the error's message.
fn describe(failure: &Failure, password: &str) -> String {
    let joined = [failure.response.as_deref(), failure.response_text.as_deref(), Some(failure.message.as_str())]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let detail = if password.is_empty() { joined } else { joined.replace(password, "[redacted]") };
    let code = if UNAVAILABLE.is_match(&detail) || failure.response_code == Some(534) {
        "UNAVAILABLE"
    } else if failure.authentication_failed || failure.code == "EAUTH" || failure.response_code == Some(535) || REJECTED.is_match(&detail) {
        "REJECTED"
    } else if NETWORK_CODES.contains(&failure.code.as_str()) {
        "NETWORK"
    } else {
        "FAILED"
    };
    let suffix = if code == "FAILED" { clip(&collapse(&detail)) } else { String::new() };
    if suffix.is_empty() {
        format!("GMAIL_APP_PASSWORD_{code}: {}", sentence(code))
    } else {
        format!("GMAIL_APP_PASSWORD_{code}: {} ({suffix})", sentence(code))
    }
}

/// `.replace(/\s+/g, ' ').trim()`.
fn collapse(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if mixdog_js::is_js_space(c) {
            in_space = true;
        } else {
            if in_space {
                out.push(' ');
            }
            in_space = false;
            out.push(c);
        }
    }
    // A leading run of spaces leaves one in front; `trim` takes it.
    mixdog_js::js_trim(&out).to_owned()
}

/// `clip(value, 200)`: the first 200 UTF-16 units and an ellipsis.
fn clip(text: &str) -> String {
    if mixdog_js::utf16_len(text) > DETAIL_CHARS {
        format!("{}…", mixdog_js::slice_utf16(text, DETAIL_CHARS))
    } else {
        text.to_owned()
    }
}

/// The Gmail app-password check.
pub struct GmailAppPassword {
    imap: Target,
    smtp: Target,
    tls: Arc<ClientConfig>,
    timeouts: Timeouts,
    hello: String,
}

fn client_config(roots: RootCertStore) -> Arc<ClientConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("the ring provider supports the default protocol versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
    Arc::new(config)
}

impl GmailAppPassword {
    /// Talks to Gmail, trusting the system's roots.
    pub fn new() -> Self {
        let mut roots = RootCertStore::empty();
        for certificate in rustls_native_certs::load_native_certs().certs {
            // A system certificate this library cannot parse is skipped, as Node skips none
            // of its own: the rest still verify.
            let _ = roots.add(certificate);
        }
        Self::with_servers(Target::new("imap.gmail.com", 993), Target::new("smtp.gmail.com", 465), roots, Timeouts::default())
    }

    /// The same check against other servers.
    pub fn with_servers(imap: Target, smtp: Target, roots: RootCertStore, timeouts: Timeouts) -> Self {
        Self { imap, smtp, tls: client_config(roots), timeouts, hello: smtp::default_hello_name() }
    }

    /// Replaces the name sent with EHLO.
    pub fn with_hello_name(mut self, name: &str) -> Self {
        self.hello = name.to_owned();
        self
    }

    /// `verifyGmailAppPassword`: IMAP, then SMTP; the first failure ends it.
    pub async fn check(&self, email: &str, password: &str) -> Result<(), String> {
        let imap = Leg { target: &self.imap, tls: &self.tls, timeouts: self.timeouts };
        let smtp = Leg { target: &self.smtp, tls: &self.tls, timeouts: self.timeouts };
        let outcome = match imap::verify(&imap, email, password).await {
            Ok(()) => smtp::verify(&smtp, &self.hello, email, password).await,
            Err(failure) => Err(failure),
        };
        outcome.map_err(|failure| describe(&failure, password))
    }
}

impl Default for GmailAppPassword {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl GmailVerifier for GmailAppPassword {
    async fn verify(&self, email: &str, password: &str) -> Result<(), String> {
        self.check(email, password).await
    }
}
