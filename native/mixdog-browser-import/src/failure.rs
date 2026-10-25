//! Classified, fixed failure messages for the importer's stderr.
//!
//! The desktop shows stderr to the user, and parser, SQLite and elevated-helper
//! errors can quote the input they choke on (for example a serde type error
//! echoing a `Local State` value, or a helper reply). Failures are therefore
//! reduced to a [`Failure`] class at the point they happen, the detail text is
//! dropped, and only the class's fixed message is ever printed.

use std::fmt;

/// Why an import failed, as far as the user needs to know.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// The database is locked: Chrome is still running.
    ChromeRunning,
    /// The profile or its database does not exist.
    ProfileNotFound,
    /// The data exists but could not be read or understood.
    DataUnreadable,
    /// A key or value could not be decrypted.
    DecryptionFailed,
    /// The elevated helper was unavailable, declined, or failed.
    ElevationFailed,
}

impl Failure {
    pub const fn message(self) -> &'static str {
        match self {
            Self::ChromeRunning => "Chrome is still running. Close Chrome and try again.",
            Self::ProfileNotFound => "Chrome profile not found.",
            Self::DataUnreadable => "Chrome data could not be read.",
            Self::DecryptionFailed => "Chrome data decryption failed.",
            Self::ElevationFailed => "Elevation was cancelled or failed.",
        }
    }
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for Failure {}

/// What an error without a [`Failure`] class reports.
const UNCLASSIFIED: &str = "Chrome import failed.";

/// The only text that may be shown for `error`: its class's fixed message, or
/// a generic one. Never the error's own text.
pub fn user_message(error: &anyhow::Error) -> &'static str {
    error
        .downcast_ref::<Failure>()
        .map_or(UNCLASSIFIED, |failure| failure.message())
}

/// Replace a raw failure with a [`Failure`] class, discarding its detail.
pub trait Classify<T> {
    fn classify(self, failure: Failure) -> anyhow::Result<T>;
}

impl<T, E> Classify<T> for Result<T, E> {
    fn classify(self, failure: Failure) -> anyhow::Result<T> {
        self.map_err(|_| failure.into())
    }
}

impl<T> Classify<T> for Option<T> {
    fn classify(self, failure: Failure) -> anyhow::Result<T> {
        self.ok_or_else(|| failure.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classified_errors_report_only_their_fixed_message() {
        let raw: Result<(), _> = Err(std::io::Error::other(
            "invalid type: string \"SECRET-LOCAL-STATE\", expected a map",
        ));
        let error = raw.classify(Failure::DataUnreadable).unwrap_err();
        assert_eq!(user_message(&error), "Chrome data could not be read.");
        assert!(!format!("{error:?}").contains("SECRET"));
        let missing = None::<u8>.classify(Failure::ProfileNotFound).unwrap_err();
        assert_eq!(user_message(&missing), "Chrome profile not found.");
    }

    #[test]
    fn unclassified_errors_never_forward_their_text() {
        let error = anyhow::anyhow!("failed to parse Local State: SECRET-LOCAL-STATE");
        assert_eq!(user_message(&error), UNCLASSIFIED);
    }

    #[test]
    fn every_class_has_a_distinct_single_line_message() {
        let all = [
            Failure::ChromeRunning,
            Failure::ProfileNotFound,
            Failure::DataUnreadable,
            Failure::DecryptionFailed,
            Failure::ElevationFailed,
        ];
        let messages: std::collections::HashSet<_> = all.iter().map(|f| f.message()).collect();
        assert_eq!(messages.len(), all.len());
        for message in messages {
            assert!(message.is_ascii() && !message.contains('\n'));
        }
        // Only a real lock may tell the user to close Chrome.
        for failure in &all[1..] {
            assert!(!failure.message().to_lowercase().contains("close chrome"));
        }
    }
}
