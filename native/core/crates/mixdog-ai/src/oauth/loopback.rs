//! The one loopback HTTP receiver of every login. It parses one request per
//! connection (head and body, bounded), hands it to the flow's handler, and
//! writes the handler's response. [`serve`] ends with the first value a
//! handler produces; dropping it closes every listener. The plain
//! `?code=&state=` redirect ([`super::CallbackServer`]), MiMo's `?u=` payload
//! and Command Code's CORS `POST` are all handlers over it.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;

use mixdog_rt::TaskClass;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Largest request head plus body accepted.
pub const MAX_REQUEST: usize = 64 * 1024;

pub struct Request {
    pub method: String,
    /// Path and query as sent.
    pub target: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    pub fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or("")
    }

    pub fn raw_query(&self) -> &str {
        self.target.split_once('?').map_or("", |(_, q)| q)
    }

    /// The first value of query parameter `name`, percent-decoded.
    pub fn query(&self, name: &str) -> Option<String> {
        url::form_urlencoded::parse(self.raw_query().as_bytes())
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.into_owned())
    }
}

pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn new(status: u16) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_owned(), value.to_owned()));
        self
    }

    pub fn body(mut self, content_type: &str, body: impl Into<Vec<u8>>) -> Self {
        self.body = body.into();
        self.header("content-type", content_type)
    }

    /// A body with no `content-type`, as Node's `res.end(text)` after a bare `writeHead(status)`.
    pub fn untyped_body(mut self, body: impl Into<Vec<u8>>) -> Self {
        self.body = body.into();
        self
    }

    fn bytes(&self) -> Vec<u8> {
        let mut head = format!(
            "HTTP/1.1 {} {}\r\nconnection: close\r\ncontent-length: {}\r\n",
            self.status,
            reason_phrase(self.status),
            self.body.len()
        );
        for (k, v) in &self.headers {
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        head.push_str("\r\n");
        let mut out = head.into_bytes();
        out.extend_from_slice(&self.body);
        out
    }
}

/// Node's `STATUS_CODES` for the statuses a callback server answers with.
fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        302 => "Found",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        500 => "Internal Server Error",
        _ => "-",
    }
}

/// The handler's answer: the response to write, and the value that ends
/// serving (`None` keeps listening).
pub type Handled<T> = Pin<Box<dyn Future<Output = (Response, Option<T>)> + Send>>;

async fn read_request(stream: &mut TcpStream) -> io::Result<Request> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 2048];
    let head_end = loop {
        if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break at;
        }
        let n = stream.read(&mut chunk).await?;
        if n == 0 || buf.len() + n > MAX_REQUEST {
            return Err(io::Error::from(io::ErrorKind::InvalidData));
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let (method, target) = (
        first.next().unwrap_or("").to_owned(),
        first.next().unwrap_or("").to_owned(),
    );
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
        .collect();
    let length = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .unwrap_or(0);
    if head_end + 4 + length > MAX_REQUEST {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < length {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(length);
    Ok(Request {
        method,
        target,
        headers,
        body,
    })
}

/// Binds `127.0.0.1:port` (0 = any), and with `also_v6` `[::1]` on the same
/// port when the host has it: `localhost` may resolve to either.
pub async fn bind(port: u16, also_v6: bool) -> io::Result<(Vec<TcpListener>, u16)> {
    let primary = TcpListener::bind(("127.0.0.1", port)).await?;
    let port = primary.local_addr()?.port();
    let mut listeners = vec![primary];
    if also_v6 && let Ok(secondary) = TcpListener::bind(("::1", port)).await {
        listeners.push(secondary);
    }
    Ok((listeners, port))
}

/// Serves until a handler yields a value.
pub async fn serve<T, H>(listeners: Vec<TcpListener>, handler: H) -> T
where
    T: Send + 'static,
    H: Fn(Request) -> Handled<T> + Send + Sync + 'static,
{
    let handler = Arc::new(handler);
    let (tx, mut rx) = mpsc::unbounded_channel::<T>();
    let stop = CancellationToken::new();
    let _close_on_drop = stop.clone().drop_guard();
    let mut accepting = Vec::new();
    for listener in listeners {
        let (handler, tx, stop) = (handler.clone(), tx.clone(), stop.clone());
        accepting.push(mixdog_rt::spawn("ai.oauth.loopback", TaskClass::Work, async move {
            loop {
                let accepted = tokio::select! {
                    () = stop.cancelled() => return,
                    accepted = listener.accept() => accepted,
                };
                let Ok((mut stream, _)) = accepted else {
                    continue;
                };
                let (handler, tx, stop) = (handler.clone(), tx.clone(), stop.clone());
                mixdog_rt::spawn("ai.oauth.loopback.conn", TaskClass::Work, async move {
                    let work = async {
                        let Ok(request) = read_request(&mut stream).await else {
                            return;
                        };
                        let (response, done) = handler(request).await;
                        let _ = stream.write_all(&response.bytes()).await;
                        let _ = stream.shutdown().await;
                        if let Some(value) = done {
                            let _ = tx.send(value);
                        }
                    };
                    tokio::select! {
                        () = stop.cancelled() => {}
                        () = work => {}
                    }
                });
            }
        }));
    }
    drop(tx);
    // The listener tasks hold the senders; the loop ends only with a value.
    let value = loop {
        if let Some(value) = rx.recv().await {
            break value;
        }
        std::future::pending::<()>().await;
    };
    // The login is over (Node closes its server first): no connection is accepted once this returns.
    stop.cancel();
    for task in accepting {
        let _ = task.await;
    }
    value
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// One raw exchange against a served handler.
    pub(crate) async fn exchange(port: u16, request: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut out = String::new();
        stream.read_to_string(&mut out).await.unwrap();
        out
    }

    #[tokio::test]
    async fn the_first_handled_value_ends_serving_and_other_requests_keep_it_waiting() {
        mixdog_rt::testing::tokens();
        let (listeners, port) = bind(0, true).await.unwrap();
        let server = mixdog_rt::spawn("test.loopback", TaskClass::Work, async move {
            serve(listeners, |request: Request| -> Handled<String> {
                Box::pin(async move {
                    match request.query("u") {
                        Some(u) => (Response::new(200).body("text/plain", "ok"), Some(u)),
                        None => (Response::new(404), None),
                    }
                })
            })
            .await
        });
        assert!(exchange(port, "GET /nope HTTP/1.1\r\nHost: x\r\n\r\n").await.starts_with("HTTP/1.1 404"));
        let ok = exchange(port, "GET /?u=a%20b HTTP/1.1\r\nHost: x\r\n\r\n").await;
        assert!(ok.starts_with("HTTP/1.1 200") && ok.ends_with("ok"));
        assert_eq!(server.await.unwrap(), "a b");
    }

    #[tokio::test]
    async fn a_post_body_reaches_the_handler_whole() {
        mixdog_rt::testing::tokens();
        let (listeners, port) = bind(0, false).await.unwrap();
        let server = mixdog_rt::spawn("test.loopback", TaskClass::Work, async move {
            serve(listeners, |request: Request| -> Handled<Vec<u8>> {
                Box::pin(async move { (Response::new(204), Some(request.body)) })
            })
            .await
        });
        exchange(port, "POST /cb HTTP/1.1\r\nHost: x\r\nContent-Length: 7\r\n\r\n{\"a\":1}").await;
        assert_eq!(server.await.unwrap(), b"{\"a\":1}");
    }
}