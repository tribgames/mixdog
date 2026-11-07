use std::collections::VecDeque;

use bytes::Bytes;
use mixdog_core_api::domain::provider::TransportFault;

use super::*;
use crate::transport::BodyStream;
use crate::transport::HttpResponse;

struct Once(Option<Bytes>);

#[async_trait]
impl BodyStream for Once {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.take().map(Ok)
    }
}

/// Answers the scripted `(status, headers, body)` rows in order.
struct Server {
    rows: Mutex<VecDeque<(u16, Vec<(String, String)>, String)>>,
    seen: Mutex<Vec<WireRequest>>,
}

fn server(rows: Vec<(u16, Vec<(&str, &str)>, &str)>) -> Arc<Server> {
    Arc::new(Server {
        rows: Mutex::new(
            rows.into_iter()
                .map(|(s, h, b)| (s, h.into_iter().map(|(n, v)| (n.to_owned(), v.to_owned())).collect(), b.to_owned()))
                .collect(),
        ),
        seen: Mutex::default(),
    })
}

#[async_trait]
impl HttpSend for Server {
    async fn send(
        &self,
        request: WireRequest,
        _exchange: crate::transport::Exchange,
    ) -> Result<HttpResponse, ProviderError> {
        self.seen.lock().unwrap().push(request);
        let (status, headers, body) = self.rows.lock().unwrap().pop_front().expect("scripted answer");
        Ok(HttpResponse { status, headers, body: Box::new(Once(Some(Bytes::from(body)))) })
    }
}

const FLAVOR: (&str, &str) = ("metadata-flavor", "Google");

#[tokio::test]
async fn only_a_server_that_names_itself_google_has_a_project() {
    let named = server(vec![(200, vec![FLAVOR], " my-proj\n")]);
    let http: Arc<dyn HttpSend> = named.clone();
    assert_eq!(probe_project(&http).await.as_deref(), Some("my-proj"));
    {
        let seen = named.seen.lock().unwrap();
        assert_eq!(seen[0].url, "http://metadata.google.internal/computeMetadata/v1/project/project-id");
        assert_eq!(seen[0].headers, vec![("Metadata-Flavor".to_owned(), "Google".to_owned())]);
    }
    for row in [(200, vec![], "p"), (404, vec![FLAVOR], "p"), (200, vec![FLAVOR], "  ")] {
        let http: Arc<dyn HttpSend> = server(vec![row]);
        assert_eq!(probe_project(&http).await, None);
    }
}

#[tokio::test]
async fn the_token_is_cached_until_near_expiry_and_dropped_when_rejected() {
    let http = server(vec![
        (200, vec![], r#"{"access_token":"T1","expires_in":3600}"#),
        (200, vec![], r#"{"access_token":"T2","expires_in":3600}"#),
    ]);
    let auth = MetadataAuth::new(http.clone(), "p", Box::new(|| 1_000));
    let first = auth.authorize().await.unwrap();
    assert_eq!(first.headers, vec![("authorization".to_owned(), "Bearer T1".to_owned())]);
    assert_eq!(first.identity, r#"["adc","metadata","p"]"#);
    assert_eq!(auth.authorize().await.unwrap(), first, "served from the cache");
    assert_eq!(http.seen.lock().unwrap().len(), 1);
    assert_eq!(http.seen.lock().unwrap()[0].url, "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token");
    assert!(auth.rejected(&first).await);
    assert_eq!(auth.authorize().await.unwrap().headers[0].1, "Bearer T2");
}

#[tokio::test]
async fn a_refused_token_request_says_why() {
    let http = server(vec![(403, vec![], r#"{"error":{"message":"no scope"}}"#), (500, vec![], "oops")]);
    let auth = MetadataAuth::new(http, "p", Box::new(|| 0));
    let err = auth.authorize().await.unwrap_err();
    assert_eq!((err.message.as_str(), err.status), ("Vertex AI authentication failed: no scope", Some(403)));
    assert_eq!(auth.authorize().await.unwrap_err().message, "Vertex AI authentication failed: HTTP 500");
}
