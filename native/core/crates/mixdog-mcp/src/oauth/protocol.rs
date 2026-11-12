//! The OAuth 2.1 wire protocol an MCP sign-in speaks: protected-resource discovery (RFC 9728),
//! authorization-server metadata (RFC 8414 / OIDC), dynamic client registration (RFC 7591),
//! PKCE (S256), the authorization-code and refresh grants, and revocation (RFC 7009). Requests
//! never follow redirects, so a token or secret only goes where it was sent.

use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use url::Url;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// The protocol version a discovery request names (the MCP spec revision this client speaks).
const MCP_PROTOCOL_VERSION: &str = "2025-06-18";

/// The `WWW-Authenticate` parameters a sign-in challenge carries.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Challenge {
    pub resource_metadata_url: Option<String>,
    pub scope: Option<String>,
    pub error: Option<String>,
}

pub fn parse_challenge(header: Option<&str>) -> Challenge {
    let Some(header) = header else { return Challenge::default() };
    let param = |name: &str| {
        let pattern = regex::Regex::new(&format!(r#"{name}="([^"]*)""#)).ok()?;
        pattern.captures(header).map(|c| c[1].to_owned())
    };
    Challenge { resource_metadata_url: param("resource_metadata"), scope: param("scope"), error: param("error") }
}

/// What discovery found, stored with the sign-in so a refresh needs no new discovery.
#[derive(Clone, PartialEq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    #[serde(default)]
    pub authorization_server_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_metadata_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_metadata: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorization_server_metadata: Option<Value>,
}

impl Discovery {
    fn endpoint(&self, key: &str, fallback_path: &str) -> Option<Url> {
        let advertised = self.authorization_server_metadata.as_ref().and_then(|m| m.get(key)).and_then(Value::as_str);
        match advertised {
            Some(url) => Url::parse(url).ok(),
            // A server with no metadata uses the legacy default paths.
            None if self.authorization_server_metadata.is_none() => {
                Url::parse(&self.authorization_server_url).ok()?.join(fallback_path).ok()
            }
            None => None,
        }
    }

    pub fn authorization_endpoint(&self) -> Option<Url> {
        self.endpoint("authorization_endpoint", "/authorize")
    }

    pub fn token_endpoint(&self) -> Option<Url> {
        self.endpoint("token_endpoint", "/token")
    }

    pub fn registration_endpoint(&self) -> Option<Url> {
        self.endpoint("registration_endpoint", "/register")
    }

    pub fn revocation_endpoint(&self) -> Option<String> {
        self.authorization_server_metadata.as_ref()?.get("revocation_endpoint")?.as_str().map(str::to_owned)
    }

    pub fn authorization_endpoint_text(&self) -> Option<String> {
        self.authorization_endpoint().map(|u| u.to_string())
    }

    /// The scopes the authorization server offers.
    pub fn offers_scope(&self, scope: &str) -> bool {
        self.authorization_server_metadata
            .as_ref()
            .and_then(|m| m.get("scopes_supported"))
            .and_then(Value::as_array)
            .is_some_and(|list| list.iter().any(|s| s.as_str() == Some(scope)))
    }

    /// PKCE S256 must be offered when the server lists its methods.
    pub fn supports_s256(&self) -> bool {
        match self.authorization_server_metadata.as_ref().and_then(|m| m.get("code_challenge_methods_supported")) {
            Some(Value::Array(list)) => list.iter().any(|m| m.as_str() == Some("S256")),
            Some(_) => false,
            // Nothing listed: PKCE is assumed (MCP requires it).
            None => true,
        }
    }

    /// RFC 8707 resource indicator: the metadata's resource when the server names one, else the
    /// server URL.
    pub fn resource(&self, server: &Url) -> String {
        self.resource_metadata
            .as_ref()
            .and_then(|m| m.get("resource"))
            .and_then(Value::as_str)
            .map_or_else(|| strip_fragment(server).to_string(), str::to_owned)
    }

    pub fn resource_scopes(&self) -> Option<String> {
        let list = self.resource_metadata.as_ref()?.get("scopes_supported")?.as_array()?;
        let joined: Vec<&str> = list.iter().filter_map(Value::as_str).collect();
        (!joined.is_empty()).then(|| joined.join(" "))
    }
}

fn strip_fragment(url: &Url) -> Url {
    let mut url = url.clone();
    url.set_fragment(None);
    url
}

/// A token endpoint failure.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum TokenError {
    /// The server answered with an OAuth error code (`invalid_grant`, `invalid_client`, …).
    Oauth(String),
    /// Anything else: network, malformed answer, no endpoint.
    Failed,
}

/// The client a request is made as.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ClientCredentials {
    pub client_id: String,
    pub client_secret: Option<String>,
}

impl ClientCredentials {
    pub fn from_info(info: &Value) -> Option<Self> {
        Some(Self {
            client_id: info.get("client_id")?.as_str()?.to_owned(),
            client_secret: info.get("client_secret").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned),
        })
    }
}

pub struct Protocol {
    client: reqwest::Client,
}

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

pub fn pkce() -> Pkce {
    let verifier = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 48]>());
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    Pkce { verifier, challenge }
}

pub fn random_state() -> String {
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>())
}

impl Protocol {
    pub fn new() -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| e.without_url().to_string())?;
        Ok(Self { client })
    }

    async fn get_json(&self, url: &Url) -> Option<Value> {
        // A built-in Google connector's address is answered in this process, never on the network.
        if let Some(metadata) = crate::google_mcp::protected_resource(url) {
            return Some(metadata);
        }
        let response = self
            .client
            .get(url.clone())
            .header(reqwest::header::ACCEPT, "application/json")
            .header("MCP-Protocol-Version", MCP_PROTOCOL_VERSION)
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        response.json::<Value>().await.ok().filter(Value::is_object)
    }

    /// The protected-resource metadata of `server`: the challenge's hint, else the path-aware
    /// well-known URL, else the root one.
    async fn resource_metadata(&self, server: &Url, hint: Option<&str>) -> Option<(Value, String)> {
        let mut candidates: Vec<String> = Vec::new();
        if let Some(hint) = hint {
            candidates.push(hint.to_owned());
        } else {
            let path = server.path().trim_end_matches('/');
            let origin = server.origin().ascii_serialization();
            if !path.is_empty() {
                candidates.push(format!("{origin}/.well-known/oauth-protected-resource{path}"));
            }
            candidates.push(format!("{origin}/.well-known/oauth-protected-resource"));
        }
        for candidate in candidates {
            let Ok(url) = Url::parse(&candidate) else { continue };
            if let Some(metadata) = self.get_json(&url).await {
                return Some((metadata, candidate));
            }
        }
        None
    }

    async fn server_metadata(&self, issuer: &Url) -> Option<Value> {
        let path = issuer.path().trim_end_matches('/');
        let origin = issuer.origin().ascii_serialization();
        let candidates = if path.is_empty() {
            vec![format!("{origin}/.well-known/oauth-authorization-server"), format!("{origin}/.well-known/openid-configuration")]
        } else {
            vec![
                format!("{origin}/.well-known/oauth-authorization-server{path}"),
                format!("{origin}/.well-known/openid-configuration{path}"),
                format!("{origin}{path}/.well-known/openid-configuration"),
            ]
        };
        for candidate in candidates {
            let Ok(url) = Url::parse(&candidate) else { continue };
            if let Some(metadata) = self.get_json(&url).await
                && metadata.get("authorization_endpoint").is_some_and(Value::is_string)
                && metadata.get("token_endpoint").is_some_and(Value::is_string)
            {
                return Some(metadata);
            }
        }
        None
    }

    pub async fn discover(&self, server: &Url, hint: Option<&str>) -> Discovery {
        let resource = self.resource_metadata(server, hint).await;
        let authorization_server_url = resource
            .as_ref()
            .and_then(|(m, _)| m.get("authorization_servers")?.as_array()?.first()?.as_str().map(str::to_owned))
            .unwrap_or_else(|| server.to_string());
        let authorization_server_metadata = match Url::parse(&authorization_server_url) {
            Ok(issuer) => self.server_metadata(&issuer).await,
            Err(_) => None,
        };
        Discovery {
            authorization_server_url,
            resource_metadata_url: resource.as_ref().map(|(_, url)| url.clone()),
            resource_metadata: resource.map(|(m, _)| m),
            authorization_server_metadata,
        }
    }

    /// RFC 7591 dynamic client registration.
    pub async fn register(&self, discovery: &Discovery, redirect_uri: &str, scope: Option<&str>) -> Result<Value, TokenError> {
        let endpoint = discovery.registration_endpoint().ok_or(TokenError::Failed)?;
        let mut metadata = json!({
            "client_name": "Mixdog",
            "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        });
        if let Some(scope) = scope {
            metadata["scope"] = Value::String(scope.to_owned());
        }
        let response = self.client.post(endpoint).json(&metadata).send().await.map_err(|_| TokenError::Failed)?;
        if !response.status().is_success() {
            return Err(TokenError::Failed);
        }
        let info: Value = response.json().await.map_err(|_| TokenError::Failed)?;
        ClientCredentials::from_info(&info).map(|_| info).ok_or(TokenError::Failed)
    }

    /// One token request (`authorization_code` or `refresh_token`).
    pub async fn token(
        &self,
        discovery: &Discovery,
        client: &ClientCredentials,
        mut form: Vec<(&str, String)>,
        resource: Option<String>,
    ) -> Result<Value, TokenError> {
        let endpoint = discovery.token_endpoint().ok_or(TokenError::Failed)?;
        if let Some(resource) = resource {
            form.push(("resource", resource));
        }
        let methods: Vec<&str> = discovery
            .authorization_server_metadata
            .as_ref()
            .and_then(|m| m.get("token_endpoint_auth_methods_supported"))
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let mut request = self.client.post(endpoint).header(reqwest::header::ACCEPT, "application/json");
        match &client.client_secret {
            Some(secret) if methods.is_empty() || methods.contains(&"client_secret_basic") => {
                request = request.basic_auth(&client.client_id, Some(secret));
            }
            Some(secret) if methods.contains(&"client_secret_post") => {
                form.push(("client_id", client.client_id.clone()));
                form.push(("client_secret", secret.clone()));
            }
            _ => form.push(("client_id", client.client_id.clone())),
        }
        let response = request.form(&form).send().await.map_err(|_| TokenError::Failed)?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            return body.get("access_token").is_some_and(Value::is_string).then_some(body).ok_or(TokenError::Failed);
        }
        match body.get("error").and_then(Value::as_str) {
            Some(code) => Err(TokenError::Oauth(code.to_owned())),
            None => Err(TokenError::Failed),
        }
    }

    /// RFC 7009: revokes the grant at `endpoint`; true when the server confirmed it.
    pub async fn revoke(&self, endpoint: &str, token: &str, is_refresh: bool, client: &ClientCredentials) -> bool {
        let Ok(url) = Url::parse(endpoint) else { return false };
        if url.scheme() != "https" {
            return false;
        }
        let mut form = vec![
            ("token", token.to_owned()),
            ("token_type_hint", if is_refresh { "refresh_token" } else { "access_token" }.to_owned()),
            ("client_id", client.client_id.clone()),
        ];
        if let Some(secret) = &client.client_secret {
            form.push(("client_secret", secret.clone()));
        }
        match self.client.post(url).timeout(Duration::from_secs(5)).form(&form).send().await {
            Ok(response) => response.status().is_success(),
            Err(_) => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_parameters_are_read_from_the_header() {
        let header = r#"Bearer error="insufficient_scope", scope="a b", resource_metadata="https://x/.well-known/oauth-protected-resource""#;
        let challenge = parse_challenge(Some(header));
        assert_eq!(challenge.error.as_deref(), Some("insufficient_scope"));
        assert_eq!(challenge.scope.as_deref(), Some("a b"));
        assert_eq!(challenge.resource_metadata_url.as_deref(), Some("https://x/.well-known/oauth-protected-resource"));
        assert_eq!(parse_challenge(None), Challenge::default());
    }

    #[test]
    fn endpoints_come_from_metadata_or_the_legacy_defaults() {
        let bare = Discovery { authorization_server_url: "https://as.example/mcp".into(), ..Discovery::default() };
        assert_eq!(bare.token_endpoint().unwrap().as_str(), "https://as.example/token");
        let with = Discovery {
            authorization_server_metadata: Some(json!({"token_endpoint": "https://as.example/t", "authorization_endpoint": "https://as.example/a"})),
            ..bare.clone()
        };
        assert_eq!(with.token_endpoint().unwrap().as_str(), "https://as.example/t");
        assert!(with.registration_endpoint().is_none(), "advertised metadata without registration means none");
        assert!(with.supports_s256() && !Discovery {
            authorization_server_metadata: Some(json!({"code_challenge_methods_supported": ["plain"]})),
            ..bare
        }
        .supports_s256());
    }

    #[test]
    fn pkce_challenge_is_the_s256_of_the_verifier() {
        let pair = pkce();
        assert_eq!(pair.challenge, URL_SAFE_NO_PAD.encode(Sha256::digest(pair.verifier.as_bytes())));
        assert!(pair.verifier.len() >= 43);
    }
}
