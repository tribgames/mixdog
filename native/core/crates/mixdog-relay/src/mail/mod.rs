//! The mail the relay sends: the SMTP submission client and the MIME message builder. `send` takes the server and credentials
//! ([`MailConfig`]) and a [`Message`]; a failure carries a `code` (`ETIMEDOUT`, `ECONNECTION`, `ESOCKET`, `EAUTH`, `EENVELOPE`,
//! `EMESSAGE`, `ETLS`, `EPROTOCOL`, `EDNS`), which is all the relay logs.

mod mime;
mod smtp;

pub use mime::{Attachment, Message};
#[cfg(any(test, feature = "test-support"))]
pub use smtp::send_trusting;
pub use smtp::{MailCode, MailConfig, MailError, send};
