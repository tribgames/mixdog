//! `describe_oauth`: an unknown provider is not described and a known one is.

use super::oauth_status::describe_oauth;

#[test]
fn only_the_ten_providers_are_described() {
    assert_eq!(describe_oauth("unknown", None, 0), None);
    assert!(describe_oauth("cursor-oauth", None, 0).is_some());
}
