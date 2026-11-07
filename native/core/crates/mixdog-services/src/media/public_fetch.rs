//! The production [`PublicFetch`] of the media downloads: the guarded, no-redirect GET of the web
//! tools ([`PublicGet`]) over the daemon's single `RoutedClients`, with Node's wording for a
//! refused address and the abort message for a cancelled request.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::netproxy::RoutedClients;
use mixdog_tools::web::PublicError;
use mixdog_tools::web::PublicGet;
use mixdog_tools::web::PublicReply;
use mixdog_tools::web::WebLanes;
use tokio_util::sync::CancellationToken;

use super::download::AdapterError;
use super::download::PublicFetch;
use super::download::PublicResponse;

pub struct RoutedPublicFetch {
    get: PublicGet,
}

impl RoutedPublicFetch {
    /// `clients` is the daemon's one `RoutedClients`; `lanes` the web tools' (its `dns` lane runs
    /// the guard's name lookups).
    pub fn new(clients: Arc<RoutedClients>, lanes: WebLanes) -> Self {
        Self { get: PublicGet::new(clients, lanes) }
    }
}

/// Node's media path words each failure of the guarded GET: a failed name lookup is the resolver's
/// own error, raised before anything is sent (`getaddrinfo EAI_AGAIN <host>`; the web tools word
/// the same failure `fetch failed: getaddrinfo ...` themselves).
fn adapter_error(error: PublicError) -> AdapterError {
    let code = error.code().map(str::to_owned);
    let message = match error {
        PublicError::InvalidUrl => "Invalid URL".to_owned(),
        PublicError::Refused(words) | PublicError::Client(words) => words,
        PublicError::Lookup { code, host } => format!("getaddrinfo {code} {host}"),
        PublicError::FetchFailed => "fetch failed".to_owned(),
        PublicError::Terminated => "terminated".to_owned(),
    };
    AdapterError { message, code, status: None, usage: None, resets_at: None }
}

struct Reply(PublicReply);

#[async_trait]
impl PublicResponse for Reply {
    fn status(&self) -> u16 {
        self.0.status()
    }

    fn header(&self, name: &str) -> Option<String> {
        self.0.header(name)
    }

    fn has_body(&self) -> bool {
        self.0.has_body()
    }

    async fn chunk(&mut self) -> Result<Option<Vec<u8>>, AdapterError> {
        self.0.chunk().await.map_err(adapter_error)
    }
}

#[async_trait]
impl PublicFetch for RoutedPublicFetch {
    async fn get(&self, url: &str, headers: &[(String, String)], cancel: &CancellationToken) -> Result<Box<dyn PublicResponse>, AdapterError> {
        let reply = tokio::select! {
            () = cancel.cancelled() => return Err(AdapterError::plain("This operation was aborted")),
            reply = self.get.get(url, headers) => reply.map_err(adapter_error)?,
        };
        Ok(Box::new(Reply(reply)))
    }
}

#[cfg(test)]
mod tests {
    use mixdog_ai::netproxy::NetworkProxy;
    use mixdog_ai::netproxy::ProcessEnv;
    use mixdog_ai::netproxy::SystemProxy;

    use super::*;

    fn fetch() -> RoutedPublicFetch {
        let tokens = mixdog_rt::testing::tokens();
        let lanes = WebLanes { extract: tokens.cpu_interactive, dns: tokens.interactive_io };
        let policy = NetworkProxy::new(Arc::new(ProcessEnv), SystemProxy::default());
        RoutedPublicFetch::new(Arc::new(RoutedClients::new(policy, |_| reqwest::Client::builder().build())), lanes)
    }

    #[test]
    fn a_failed_name_lookup_reads_as_nodes_media_path() {
        let golden: serde_json::Value = serde_json::from_str(include_str!("../../../../fixtures/public-get/golden.json")).unwrap();
        let cases = golden["lookup_failures"].as_array().unwrap();
        assert_eq!(cases.len(), 3);
        for case in cases {
            let node = case["message"].as_str().unwrap();
            // What the guarded GET reports: the typed lookup failure for a transient one, the
            // guard's own words when the name has no addresses.
            let host = case["host"].as_str().unwrap().to_owned();
            let reported = if case["code"] == "EAI_AGAIN" {
                PublicError::Lookup { code: "EAI_AGAIN".to_owned(), host }
            } else {
                PublicError::Refused(node.to_owned())
            };
            let error = adapter_error(reported);
            assert_eq!((error.message.as_str(), error.code), (node, None), "{}", case["code"]);
        }
        let again = adapter_error(PublicError::Lookup { code: "EAI_AGAIN".to_owned(), host: "h.example".to_owned() });
        assert_eq!(again.message, "getaddrinfo EAI_AGAIN h.example");
        let kinds = [
            (PublicError::InvalidUrl, "Invalid URL", Some("ERR_INVALID_URL")),
            (PublicError::FetchFailed, "fetch failed", None),
            (PublicError::Terminated, "terminated", None),
        ];
        for (error, message, code) in kinds {
            let mapped = adapter_error(error);
            assert_eq!((mapped.message.as_str(), mapped.code.as_deref()), (message, code));
        }
    }

    #[tokio::test]
    async fn a_refused_address_is_the_adapters_error_in_nodes_words() {
        let fetch = fetch();
        let cancel = CancellationToken::new();
        let cases = [
            ("not a url", "Invalid URL", Some("ERR_INVALID_URL")),
            ("ftp://example.com/a", "Blocked non-HTTP protocol: ftp:", None),
            ("http://10.0.0.1/a", "Blocked request to private address: 10.0.0.1", None),
            ("http://u:p@example.com/", "Blocked URL with userinfo credentials: example.com", None),
            ("http://[::ffff:7f00:1]/", "Blocked request to private address: 127.0.0.1", None),
        ];
        for (url, message, code) in cases {
            let error = fetch.get(url, &[], &cancel).await.err().unwrap();
            assert_eq!((error.message.as_str(), error.code.as_deref(), error.status), (message, code, None), "{url}");
        }
    }
}
