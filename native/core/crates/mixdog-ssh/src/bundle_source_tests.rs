//! The download itself, against a local HTTP stand-in for the release (no network): what a success, a refusal and an answer
//! longer than the release lists come to.

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::fetch_with;

/// Serves one HTTP answer of `status` with `body`, with its `Content-Length` when `advertised`, then closes the connection.
async fn release_answering(status: &str, body: &'static [u8], advertised: bool) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let length = if advertised { format!("Content-Length: {}\r\n", body.len()) } else { String::new() };
    let head = format!("HTTP/1.1 {status}\r\n{length}Connection: close\r\n\r\n");
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0_u8; 4096];
        let _ = stream.read(&mut request).await;
        stream.write_all(head.as_bytes()).await.unwrap();
        stream.write_all(body).await.unwrap();
        let _ = stream.shutdown().await;
    });
    format!("http://{address}/mixdog-server-linux-x64.tgz")
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}

#[tokio::test]
async fn a_download_is_the_body_of_a_success_and_a_refusal_is_an_error() {
    let url = release_answering("200 OK", b"the bundle", true).await;
    assert_eq!(fetch_with(&client(), &url, 10).await.unwrap(), b"the bundle");
    let url = release_answering("404 Not Found", b"Not Found", true).await;
    let error = fetch_with(&client(), &url, 10).await.unwrap_err();
    assert!(error.contains("HTTP 404"), "{error}");
}

#[tokio::test]
async fn an_answer_longer_than_the_release_lists_is_refused_whether_or_not_it_says_so() {
    for advertised in [true, false] {
        let url = release_answering("200 OK", b"the bundle and more", advertised).await;
        let error = fetch_with(&client(), &url, 10).await.unwrap_err();
        assert!(error.contains("longer than the 10 bytes"), "advertised {advertised}: {error}");
    }
}
