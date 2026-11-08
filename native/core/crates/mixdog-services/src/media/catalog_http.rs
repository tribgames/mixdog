//! The production [`CatalogHttp`]: every catalog request rides the daemon's single
//! [`RoutedClients`] (`createRoutedProxyDispatcher`), so it follows the network proxy setting like
//! every other outbound request. No client of its own is built here.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_ai::netproxy::RoutedClients;
use mixdog_ai::transport::FETCH_FAILED;

use super::catalog_fetch::{CatalogHttp, HttpFailure, HttpReply};

pub struct RoutedCatalogHttp {
    clients: Arc<RoutedClients>,
}

impl RoutedCatalogHttp {
    pub fn new(clients: Arc<RoutedClients>) -> Self {
        Self { clients }
    }
}

fn transport(error: &reqwest::Error) -> HttpFailure {
    if error.is_timeout() {
        // `AbortSignal.timeout`: a `TimeoutError`.
        HttpFailure { message: "The operation was aborted due to timeout".to_owned(), timed_out: true }
    } else {
        HttpFailure { message: FETCH_FAILED.to_owned(), timed_out: false }
    }
}

#[async_trait]
impl CatalogHttp for RoutedCatalogHttp {
    async fn get(&self, url: &str, headers: &[(String, String)], timeout: Duration) -> Result<HttpReply, HttpFailure> {
        // A route the policy cannot decide fails the request; it never goes direct.
        let client = self.clients.client_for(url).await.map_err(|error| HttpFailure { message: error.to_string(), timed_out: false })?;
        let mut request = client.get(url).timeout(timeout);
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let response = request.send().await.map_err(|error| transport(&error))?;
        // `redirect: 'error'`: a catalog that answers with a redirect is a failed fetch, not a
        // credential sent on to another host.
        let status = response.status();
        if status.is_redirection() || response.url().as_str() != url && !same_after_normalising(response.url().as_str(), url) {
            return Err(HttpFailure { message: FETCH_FAILED.to_owned(), timed_out: false });
        }
        let body = response.text().await.map_err(|error| transport(&error))?;
        Ok(HttpReply { status: status.as_u16(), body })
    }
}

/// `reqwest` reports the URL in its normalised form (`https://host` gains its `/`).
fn same_after_normalising(answered: &str, asked: &str) -> bool {
    reqwest::Url::parse(asked).is_ok_and(|asked| asked.as_str() == answered)
}
