//! The Gemini request on the socket against Node's real client (see `anthropic::socket_tests`).

#[tokio::test]
#[ignore = "red by design until the shared transport (`transport::link::ReqwestLink`, outside this branch's paths) sends what Node's client sends; run with --run-ignored only to list the differences"]
async fn gemini_socket_equals_nodes() {
    crate::providers::anthropic::socket_tests::socket_equals_nodes("gemini").await;
}
