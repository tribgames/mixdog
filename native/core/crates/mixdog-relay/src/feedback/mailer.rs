//! The mail transport of the feedback queue (`feedbackMailConfig` and `nodemailerSender` of `lib/feedback.mjs`): mail is
//! configured only when `SMTP_USER` and `SMTP_PASSWORD` are both set, and each feedback becomes one message sent through
//! [`crate::mail`]. A failed send reports the `code` of the [`MailError`](crate::mail::MailError) and nothing else.

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;

use super::service::{FeedbackMail, FeedbackOptions, FeedbackSender, SendFailure};
use crate::mail::{self, Attachment, MailConfig, Message};

const DEFAULT_HOST: &str = "smtp.gmail.com";
const DEFAULT_PORT: u16 = 465;
const DEFAULT_TO: &str = "support@mixdog.ai";

/// The SMTP transport behind the feedback queue.
pub struct Mailer {
    config: MailConfig,
    to: String,
    /// Certificates trusted besides the web roots: the fake servers of the tests.
    #[cfg(any(test, feature = "test-support"))]
    roots: Vec<Vec<u8>>,
}

impl Mailer {
    /// `feedbackMailConfig(env)`: `None` unless `SMTP_USER` (trimmed) and `SMTP_PASSWORD` (as given) are both non-empty. The host is
    /// `SMTP_HOST` or `smtp.gmail.com`, the port `Number(SMTP_PORT) || 465` (a value that is not a port number never connects),
    /// the recipient `FEEDBACK_TO` or `support@mixdog.ai`.
    pub fn from_env(env: &BTreeMap<String, String>) -> Option<Self> {
        let text = |name: &str| env.get(name).map_or("", String::as_str);
        let user = mixdog_js::js_trim(text("SMTP_USER"));
        let pass = text("SMTP_PASSWORD");
        if user.is_empty() || pass.is_empty() {
            return None;
        }
        let host = Some(mixdog_js::js_trim(text("SMTP_HOST"))).filter(|host| !host.is_empty()).unwrap_or(DEFAULT_HOST);
        let number = mixdog_js::string_to_number(text("SMTP_PORT"));
        let port = if number.is_nan() || number == 0.0 {
            DEFAULT_PORT
        } else if number.fract() == 0.0 && (1.0..65536.0).contains(&number) {
            number as u16
        } else {
            0
        };
        let to = Some(mixdog_js::js_trim(text("FEEDBACK_TO"))).filter(|to| !to.is_empty()).unwrap_or(DEFAULT_TO);
        Some(Self::new(MailConfig::new(host, port, user, pass), to.to_owned()))
    }

    pub fn new(config: MailConfig, to: String) -> Self {
        Self {
            config,
            to,
            #[cfg(any(test, feature = "test-support"))]
            roots: Vec::new(),
        }
    }

    /// `options` with the `From` (the SMTP user) and `To` of every mail this transport sends.
    pub fn options(&self, options: FeedbackOptions) -> FeedbackOptions {
        FeedbackOptions { from: self.config.user.clone(), to: self.to.clone(), ..options }
    }

    /// Trusts these DER certificates besides the web roots.
    #[cfg(any(test, feature = "test-support"))]
    pub fn trusting(mut self, roots: Vec<Vec<u8>>) -> Self {
        self.roots = roots;
        self
    }

    async fn deliver(&self, message: &Message) -> Result<(), mail::MailError> {
        #[cfg(any(test, feature = "test-support"))]
        if !self.roots.is_empty() {
            return mail::send_trusting(&self.config, message, &self.roots).await;
        }
        mail::send(&self.config, message).await
    }
}

fn message(mail: FeedbackMail) -> Message {
    Message {
        from: mail.from,
        to: mail.to,
        reply_to: mail.reply_to,
        subject: mail.subject,
        text: mail.text,
        attachments: mail
            .attachments
            .into_iter()
            .map(|a| Attachment { filename: a.filename, content: a.content, content_type: a.content_type })
            .collect(),
        message_id: Some(mail.message_id),
    }
}

impl FeedbackSender for Mailer {
    fn send<'a>(&'a self, mail: FeedbackMail) -> Pin<Box<dyn Future<Output = Result<(), SendFailure>> + Send + 'a>> {
        Box::pin(async move { self.deliver(&message(mail)).await.map_err(|error| SendFailure::with_code(error.code.as_str())) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::feedback::MailAttachment;

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
    }

    fn port_of(value: &str) -> u16 {
        Mailer::from_env(&env(&[("SMTP_USER", "u@x.co"), ("SMTP_PASSWORD", "p"), ("SMTP_PORT", value)])).unwrap().config.port
    }

    #[test]
    fn mail_is_configured_only_with_a_user_and_a_password() {
        assert!(Mailer::from_env(&env(&[])).is_none());
        assert!(Mailer::from_env(&env(&[("SMTP_USER", "u@x.co")])).is_none());
        assert!(Mailer::from_env(&env(&[("SMTP_PASSWORD", "p")])).is_none());
        assert!(Mailer::from_env(&env(&[("SMTP_USER", "   "), ("SMTP_PASSWORD", "p")])).is_none());
        assert!(Mailer::from_env(&env(&[("SMTP_USER", "u@x.co"), ("SMTP_PASSWORD", "")])).is_none());
        assert!(Mailer::from_env(&env(&[("SMTP_USER", " u@x.co "), ("SMTP_PASSWORD", " ")])).is_some());
    }

    #[test]
    fn the_defaults_are_gmail_on_465_and_support_at_mixdog() {
        let mailer = Mailer::from_env(&env(&[("SMTP_USER", " u@x.co "), ("SMTP_PASSWORD", "p")])).unwrap();
        assert_eq!((mailer.config.host.as_str(), mailer.config.port, mailer.config.secure), ("smtp.gmail.com", 465, true));
        assert_eq!((mailer.config.user.as_str(), mailer.to.as_str()), ("u@x.co", "support@mixdog.ai"));
        let options = mailer.options(FeedbackOptions::default());
        assert_eq!((options.from.as_str(), options.to.as_str()), ("u@x.co", "support@mixdog.ai"));
    }

    #[test]
    fn host_port_and_recipient_come_from_the_environment() {
        let mailer = Mailer::from_env(&env(&[
            ("SMTP_USER", "u@x.co"),
            ("SMTP_PASSWORD", "p"),
            ("SMTP_HOST", " mail.example.org "),
            ("SMTP_PORT", "587"),
            ("FEEDBACK_TO", " inbox@example.org "),
        ]))
        .unwrap();
        assert_eq!((mailer.config.host.as_str(), mailer.config.port, mailer.config.secure), ("mail.example.org", 587, false));
        assert_eq!(mailer.to, "inbox@example.org");
    }

    #[test]
    fn a_port_that_is_not_a_number_or_is_zero_is_465_and_one_out_of_range_never_connects() {
        assert_eq!(port_of("abc"), 465);
        assert_eq!(port_of("0"), 465);
        assert_eq!(port_of(""), 465);
        assert_eq!(port_of("99999"), 0);
        assert_eq!(port_of("25.5"), 0);
    }

    #[test]
    fn the_message_carries_every_part_of_the_mail() {
        let built = message(FeedbackMail {
            from: "u@x.co".into(),
            to: "t@x.co".into(),
            reply_to: Some("r@x.co".into()),
            subject: "[Mixdog feedback] bug id".into(),
            text: "body".into(),
            attachments: vec![MailAttachment { filename: "a.png".into(), content: vec![1, 2], content_type: "image/png".into() }],
            message_id: "<id@feedback.mixdog>".into(),
        });
        assert_eq!((built.from.as_str(), built.to.as_str(), built.reply_to.as_deref()), ("u@x.co", "t@x.co", Some("r@x.co")));
        assert_eq!(built.subject, "[Mixdog feedback] bug id");
        assert_eq!((built.text.as_str(), built.message_id.as_deref()), ("body", Some("<id@feedback.mixdog>")));
        assert_eq!(built.attachments[0].filename, "a.png");
        assert_eq!(built.attachments[0].content, vec![1u8, 2]);
        assert_eq!(built.attachments[0].content_type, "image/png");
    }
}
