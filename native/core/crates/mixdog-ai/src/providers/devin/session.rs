//! Devin request identity, unary RPCs and the session-token → user-JWT
//! exchange.

use std::io::Read;
use std::net::Ipv4Addr;
use std::net::Ipv6Addr;

use flate2::read::GzDecoder;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_core_api::domain::keepalive::TransportKind;
use url::Host;
use url::Url;

use super::decoder::MAX_DECOMPRESSED_BYTES;
use super::error::http_error;
use super::error::protocol_error;
use super::schema::Metadata;
use super::schema::decode_user_jwt;
use super::schema::display;
use super::schema::encode_metadata_request;
use crate::transport::http::HttpSend;

pub const DEFAULT_BASE_URL: &str = "https://server.codeium.com";
pub const GET_USER_JWT_PATH: &str = "/exa.auth_pb.AuthService/GetUserJwt";
pub const ASSIGN_MODEL_PATH: &str = "/exa.api_server_pb.ApiServerService/AssignModel";
pub const GET_CLI_MODEL_CONFIGS_PATH: &str = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";
pub const CHAT_PATH: &str = "/exa.api_server_pb.ApiServerService/GetChatMessage";
pub const SESSION_TOKEN_PREFIX: &str = "devin-session-token$";

const OS: &str = if cfg!(target_os = "macos") {
    "darwin"
} else if cfg!(windows) {
    "windows"
} else {
    "linux"
};

/// Which identity a call presents. The backend gates the CLI model surface
/// and router assignment on this tuple.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Client {
    /// Released CLI identity: auth and chat.
    Cli,
    /// Dev-channel identity that unlocks the full native model config set.
    Discovery,
    /// Editor identity under which legacy Windsurf Enterprise seats expose
    /// their full roster (raw, unprefixed key; no `os`).
    Legacy,
}

/// The session token as the wire carries it: the scheme prefix is required.
pub fn normalize_session_token(token: &str) -> String {
    if token.is_empty() || token.starts_with(SESSION_TOKEN_PREFIX) {
        token.to_owned()
    } else {
        format!("{SESSION_TOKEN_PREFIX}{token}")
    }
}

/// `Metadata` for every Devin call. `api_key` is sent exactly as given.
pub fn request_metadata(api_key: &str, user_jwt: &str, client: Client) -> Metadata {
    let s = str::to_owned;
    match client {
        Client::Discovery => Metadata {
            api_key: api_key.to_owned(),
            ide_name: s("chisel"),
            ide_version: s("0.0.0-dev"),
            extension_name: s("chisel"),
            extension_version: s("0.0.0-dev"),
            locale: s("en"),
            os: s(OS),
            supported_model_displays: vec![
                display::MODEL_ROUTER,
                display::QUICK_REVIEW,
                display::INTERNAL_DEFAULT,
                display::UNCLASSIFIED,
                display::NORMAL,
            ],
            ..Metadata::default()
        },
        Client::Legacy => Metadata {
            api_key: api_key.to_owned(),
            ide_name: s("windsurf"),
            ide_version: s("3.2.23"),
            extension_name: s("windsurf"),
            extension_version: s("1.48.2"),
            locale: s("en"),
            ..Metadata::default()
        },
        Client::Cli => Metadata {
            api_key: api_key.to_owned(),
            user_jwt: user_jwt.to_owned(),
            ide_name: s("devin-cli"),
            ide_type: s("chisel"),
            ide_version: s("3000.11.3"),
            extension_name: s("chisel"),
            extension_version: s("3000.11.3"),
            locale: s("en"),
            os: s(OS),
            ..Metadata::default()
        },
    }
}

pub fn unary_headers() -> Vec<(String, String)> {
    [
        ("content-type", "application/proto"),
        ("connect-protocol-version", "1"),
        ("accept", "*/*"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v.to_owned()))
    .collect()
}

pub fn stream_headers() -> Vec<(String, String)> {
    [
        ("content-type", "application/connect+proto"),
        ("connect-protocol-version", "1"),
        ("connect-content-encoding", "gzip"),
        ("connect-accept-encoding", "gzip"),
        ("accept-encoding", "identity"),
        ("user-agent", "connect-go/1.18.1 (go1.26.3)"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v.to_owned()))
    .collect()
}

pub fn join_url(base: &str, path: &str) -> String {
    format!("{}{path}", base.trim_end_matches('/'))
}

/// One unary RPC: the response message bytes. `secrets` are redacted from
/// any error text.
pub async fn unary(
    http: &dyn HttpSend,
    base_url: &str,
    path: &str,
    body: Vec<u8>,
    secrets: &[String],
) -> Result<Vec<u8>, ProviderError> {
    let operation = path.rsplit('/').next().unwrap_or("request");
    let head = http
        .send(WireRequest {
            transport: TransportKind::Http1,
            method: "POST".to_owned(),
            url: join_url(base_url, path),
            headers: unary_headers(),
            body,
        })
        .await?;
    if (300..400).contains(&head.status) {
        let mut error = protocol_error("Devin server redirected the request; redirects are refused");
        error.status = Some(head.status);
        return Err(error);
    }
    if !head.is_success() {
        let response = head.read_all().await?;
        return Err(http_error(&response, operation, secrets));
    }
    let response = head.read_all().await?;
    let mut bytes = response.body;
    // Some edges return a gzip body without Content-Encoding. A protobuf
    // message can never start with 0x1f (wire type 7), so the magic is
    // unambiguous.
    if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut out = Vec::new();
        GzDecoder::new(bytes.as_slice())
            .take(MAX_DECOMPRESSED_BYTES + 1)
            .read_to_end(&mut out)
            .map_err(|_| protocol_error("invalid gzip payload"))?;
        if out.len() as u64 > MAX_DECOMPRESSED_BYTES {
            return Err(protocol_error("decompressed payload exceeds cap"));
        }
        bytes = out;
    }
    Ok(bytes)
}

/// What a JWT exchange yielded for one turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserSession {
    pub jwt: String,
    /// The wire key that was accepted (the prefixed session token, or the raw
    /// token for legacy keys), reused in `Metadata.apiKey`.
    pub api_key: String,
    /// The validated per-account API server, when the server names one.
    pub api_host: Option<String>,
}

fn rejected_host(reason: &str) -> ProviderError {
    protocol_error(&format!("Devin returned an unsafe API host: {reason}"))
}

fn private_v4(a: Ipv4Addr) -> bool {
    let [a0, b, ..] = a.octets();
    a0 == 0
        || a0 == 10
        || a0 == 127
        || (a0 == 100 && (64..=127).contains(&b))
        || (a0 == 169 && b == 254)
        || (a0 == 172 && (16..=31).contains(&b))
        || (a0 == 192 && b == 168)
        || (a0 == 198 && (b == 18 || b == 19))
        || a0 >= 224
}

fn private_v6(a: Ipv6Addr) -> bool {
    if let Some(v4) = a.to_ipv4_mapped() {
        return private_v4(v4);
    }
    let first = a.segments()[0];
    a.is_unspecified()
        || a.is_loopback()
        || (first & 0xfe00) == 0xfc00
        || (first & 0xffc0) == 0xfe80
        || (first & 0xff00) == 0xff00
}

/// Validates a server-supplied API host before any credential is sent to
/// it. Only public https origins (optionally with a path) are accepted;
/// returns the normalized base URL without a trailing slash.
pub fn validate_api_host(value: &str) -> Result<String, ProviderError> {
    let url = Url::parse(value.trim()).map_err(|_| rejected_host("not a URL"))?;
    if url.scheme() != "https" {
        return Err(rejected_host("https is required"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(rejected_host("embedded credentials"));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(rejected_host("query or fragment"));
    }
    match url.host().ok_or_else(|| rejected_host("missing host"))? {
        Host::Ipv4(a) if private_v4(a) => return Err(rejected_host("private address")),
        Host::Ipv6(a) if private_v6(a) => return Err(rejected_host("private address")),
        Host::Domain(name) => {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            if !name.contains('.') {
                return Err(rejected_host("single-label host"));
            }
            const LOCAL: [&str; 6] = ["localhost", "local", "internal", "localdomain", "home.arpa", "localhost."];
            if LOCAL
                .iter()
                .any(|l| name == *l || name.ends_with(&format!(".{l}")))
            {
                return Err(rejected_host("local host name"));
            }
        }
        _ => {}
    }
    let origin = url.origin().ascii_serialization();
    Ok(format!("{origin}{}", url.path().trim_end_matches('/')))
}

async fn request_user_jwt(
    http: &dyn HttpSend,
    base_url: &str,
    api_key: &str,
    secrets: &[String],
) -> Result<Vec<u8>, ProviderError> {
    let body = encode_metadata_request(&request_metadata(api_key, "", Client::Cli));
    unary(http, base_url, GET_USER_JWT_PATH, body, secrets).await
}

/// Exchanges a Devin session token for the user JWT chat calls carry.
pub async fn exchange_user_jwt(
    http: &dyn HttpSend,
    base_url: &str,
    session_token: &str,
) -> Result<UserSession, ProviderError> {
    if session_token.is_empty() {
        let mut error = ProviderError::new(ErrorKind::Auth, mixdog_core_api::domain::provider::DeliveryState::NotSent);
        error.reauth_required = true;
        error.status = Some(401);
        error.message = "Devin session token is missing".to_owned();
        return Err(error);
    }
    let mut api_key = normalize_session_token(session_token);
    let secrets = |key: &str| vec![key.to_owned(), session_token.to_owned()];
    let response = match request_user_jwt(http, base_url, &api_key, &secrets(&api_key)).await {
        Ok(bytes) => bytes,
        // Raw API keys are rejected (HTTP 401) with the session prefix; retry them as-is.
        Err(error) if error.status == Some(401) && session_token != api_key => {
            api_key = session_token.to_owned();
            request_user_jwt(http, base_url, &api_key, &secrets(&api_key))
                .await
                .map_err(|e| if e.status.is_some() { e } else { error })?
        }
        Err(error) => return Err(error),
    };
    let decoded = decode_user_jwt(&response).map_err(|e| protocol_error(&format!("malformed GetUserJwtResponse: {e}")))?;
    if decoded.user_jwt.is_empty() {
        return Err(protocol_error("Devin GetUserJwt returned no user JWT"));
    }
    let custom = decoded.custom_api_server_url.trim();
    Ok(UserSession {
        jwt: decoded.user_jwt,
        api_key,
        api_host: if custom.is_empty() { None } else { Some(validate_api_host(custom)?) },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_token_gets_its_scheme_once() {
        assert_eq!(normalize_session_token("abc"), "devin-session-token$abc");
        assert_eq!(normalize_session_token("devin-session-token$abc"), "devin-session-token$abc");
        assert_eq!(normalize_session_token(""), "");
    }

    #[test]
    fn api_host_must_be_a_public_https_origin() {
        assert_eq!(validate_api_host("https://api.example.com/v1/").unwrap(), "https://api.example.com/v1");
        for bad in [
            "http://api.example.com",
            "https://user:pw@api.example.com",
            "https://api.example.com/?q=1",
            "https://10.0.0.1",
            "https://127.0.0.1",
            "https://[::1]",
            "https://[::ffff:7f00:1]",
            "https://intranet",
            "https://x.localhost",
            "not a url",
        ] {
            assert!(validate_api_host(bad).is_err(), "{bad}");
        }
    }
}
