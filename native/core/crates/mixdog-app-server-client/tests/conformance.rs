//! Every shared conformance scenario against the engine over the mock transport. The same scenarios run over a real
//! WebSocket in `conformance_ws.rs`.

mod common;

use std::sync::Arc;

use async_trait::async_trait;
use common::{Net, ServerConn};
use mixdog_app_server_client::{
    Connector, DEFAULT_LADDER, Json,
    engine::{ladder_delay, new_op_id},
    mock::{MockConn, MockNetwork},
};

struct MockServerConn(MockConn);

#[async_trait]
impl ServerConn for MockServerConn {
    async fn next_sent(&self) -> String {
        self.0.next_sent().await
    }
    fn queued(&self) -> usize {
        self.0.queued()
    }
    fn server_send(&self, frame: &Json) {
        self.0.server_send(frame);
    }
    fn server_send_raw(&self, text: &str) {
        self.0.server_send_raw(text);
    }
    fn server_close(&self, code: u16, reason: &str) {
        self.0.server_close(code, reason);
    }
    fn client_close(&self) -> Option<u16> {
        self.0.client_close()
    }
}

struct MockNet(Arc<MockNetwork>);

#[async_trait]
impl Net for MockNet {
    fn connector(&self) -> Arc<dyn Connector> {
        self.0.clone()
    }
    async fn accept(&self) -> Box<dyn ServerConn> {
        Box::new(MockServerConn(self.0.accept().await))
    }
    fn fail_next(&self, n: usize) {
        self.0.fail_next(n);
    }
    async fn settle(&self) {
        for _ in 0..60 {
            tokio::task::yield_now().await;
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn conformance_scenarios() {
    common::run_all(|| async { Arc::new(MockNet(Arc::new(MockNetwork::default()))) as Arc<dyn Net> })
        .await;
}

#[test]
fn ladder_is_full_jitter_doubling_to_the_cap() {
    let got: Vec<u64> = [0, 1, 2, 3, 4, 5, 9]
        .iter()
        .map(|a| ladder_delay(*a, 0.5, DEFAULT_LADDER))
        .collect();
    assert_eq!(got, [125, 250, 500, 1000, 2000, 2500, 2500]);
    assert_eq!(ladder_delay(3, 0.0, DEFAULT_LADDER), 0);
}

#[test]
fn default_op_ids_are_uuid_v7() {
    let id = new_op_id();
    assert_eq!(id.len(), 36);
    assert_eq!(id.as_bytes()[14], b'7');
}
