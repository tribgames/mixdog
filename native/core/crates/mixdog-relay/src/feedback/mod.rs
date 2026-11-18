//! The durable feedback queue (`lib/feedback.mjs`, `lib/feedback-attachments.mjs`): a submission is validated, written to
//! disk as a private record, and only then acknowledged; it is mailed at once and retried with bounded backoff, across
//! restarts, until the mail is accepted. Only the submitted kind, message, optional reply-to and attachments are kept;
//! nothing about the caller. The mail itself is sent behind the [`FeedbackSender`] seam ([`Mailer`] speaks SMTP), and
//! `POST /feedback` is answered by [`FeedbackEndpoint`] (`lib/feedback-http.mjs`).

pub mod attachments;
pub mod http;
pub mod mailer;
pub mod records;
pub mod service;

pub use attachments::Attachment;
pub use http::FeedbackEndpoint;
pub use mailer::Mailer;
pub use service::{
    Accepted, Clock, FeedbackError, FeedbackMail, FeedbackOptions, FeedbackSender, FeedbackService, LogSink, MailAttachment,
    SendFailure,
};


/// The most bytes a feedback request body may declare or carry: the text envelope, the base64 of the attachment total cap and
/// the names and JSON around them (`MAX_FEEDBACK_BODY_BYTES`).
pub const MAX_BODY_BYTES: usize = 32_768 + attachments::MAX_TOTAL_BYTES.div_ceil(3) * 4 + 4096;
