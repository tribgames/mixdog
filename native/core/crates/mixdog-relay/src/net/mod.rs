//! The relay's sockets: the TCP listener that `server.listen(port, '0.0.0.0')` is, and the TLS termination that
//! `https.createServer({ cert, key })` is.

pub mod listener;
pub mod tls;

pub use listener::{Server, bind_error_message};
