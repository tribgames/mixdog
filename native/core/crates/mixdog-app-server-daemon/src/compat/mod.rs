//! `compat::order`: the one version comparison behind the `initialize` gate (P §4.4) and the
//! SSH install decision (LR §8.1). Both ask the same question — is the caller newer, equal or
//! older than the core — so they share this function and nothing else compares versions.

use semver::Version;

/// Where the client (or the installing desktop) stands relative to the core.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Order {
    ClientNewer,
    Equal,
    ClientOlder,
}

/// The `initialize` refusal a non-equal order maps to (`-32600 clientOutdated|serverOutdated`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    ClientOutdated,
    ServerOutdated,
}

impl Order {
    pub fn refusal(self) -> Option<Refusal> {
        match self {
            Order::Equal => None,
            Order::ClientOlder => Some(Refusal::ClientOutdated),
            Order::ClientNewer => Some(Refusal::ServerOutdated),
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("not a semantic version: {0:?}")]
pub struct VersionParseError(pub String);

pub fn parse(text: &str) -> Result<Version, VersionParseError> {
    Version::parse(text).map_err(|_| VersionParseError(text.to_owned()))
}

/// Semantic-version precedence. Build metadata does not take part: two builds of one version
/// are `Equal`, and the dev-channel build rule is the installer's decision, not a version fact.
pub fn order(client: &Version, server: &Version) -> Order {
    match client.cmp_precedence(server) {
        std::cmp::Ordering::Greater => Order::ClientNewer,
        std::cmp::Ordering::Equal => Order::Equal,
        std::cmp::Ordering::Less => Order::ClientOlder,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(text: &str) -> Version {
        parse(text).unwrap()
    }

    #[test]
    fn orders_by_precedence() {
        assert_eq!(order(&v("1.4.6"), &v("1.4.5")), Order::ClientNewer);
        assert_eq!(order(&v("1.4.6"), &v("1.4.6")), Order::Equal);
        assert_eq!(order(&v("1.4.5"), &v("1.4.6")), Order::ClientOlder);
        assert_eq!(order(&v("1.4.6"), &v("1.4.6-dev.2")), Order::ClientNewer);
        assert_eq!(order(&v("1.10.0"), &v("1.9.9")), Order::ClientNewer);
    }

    #[test]
    fn build_metadata_is_ignored() {
        assert_eq!(order(&v("1.4.6+aaa"), &v("1.4.6+bbb")), Order::Equal);
    }

    #[test]
    fn refusal_names_the_outdated_side() {
        assert_eq!(Order::Equal.refusal(), None);
        assert_eq!(Order::ClientOlder.refusal(), Some(Refusal::ClientOutdated));
        assert_eq!(Order::ClientNewer.refusal(), Some(Refusal::ServerOutdated));
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse("1.4").is_err());
    }
}
