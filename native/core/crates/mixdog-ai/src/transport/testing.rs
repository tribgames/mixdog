//! Stubs of the transport the tests across the crate share.

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::provider::TransportFault;

use super::http::BodyStream;

/// A response body that is one chunk, or none, and then ends.
pub(crate) struct Once(pub Option<Bytes>);

#[async_trait]
impl BodyStream for Once {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.take().map(Ok)
    }
}
