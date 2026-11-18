use mixdog_services::connectors::accounts::{ConnectorAccount, accounts_of_instructions, connector_accounts_instructions};
use mixdog_services::connectors::triggers::{CONNECTOR_TRIGGER_MAX_CHARS, CONNECTOR_TRIGGERS, connector_trigger};

fn account(email: &str, note: Option<&str>) -> ConnectorAccount {
    ConnectorAccount { email: email.into(), note: note.map(String::from) }
}

#[test]
fn every_curated_trigger_is_found_by_its_own_id_and_fits_the_manifest_line() {
    assert_eq!(CONNECTOR_TRIGGER_MAX_CHARS, 100);
    for (id, line) in CONNECTOR_TRIGGERS {
        assert_eq!(connector_trigger(id), line, "{id}");
    }
}

#[test]
fn a_second_account_of_a_connector_shares_its_trigger_and_an_unknown_id_has_none() {
    let github = connector_trigger("github");
    for id in ["github-2", "github_3", "GitHub-12"] {
        assert_eq!(connector_trigger(id), github, "{id}");
    }
    // The suffix is a number only: a word after the dash makes another server.
    assert_eq!(connector_trigger("github-enterprise"), "");
    // Separators never tell servers apart, so a trailing one is still GitHub.
    assert_eq!(connector_trigger("github-"), github);
    assert_eq!(connector_trigger("-2"), "");
}

#[test]
fn accounts_are_told_to_the_model_in_one_line_that_parses_back_to_the_addresses() {
    let one = connector_accounts_instructions(&[account("a@x.com", None)]).unwrap();
    assert_eq!(one, "Accounts: a@x.com. `account` may be left out.");
    let two = connector_accounts_instructions(&[account("a@x.com", None), account("b@x.com", Some("needs sign-in"))]).unwrap();
    assert!(two.starts_with("Accounts: a@x.com, b@x.com (needs sign-in). `account` picks one;"), "{two}");
    assert_eq!(accounts_of_instructions(&two), ["a@x.com", "b@x.com"]);
    // An empty note is no note; an account without an address is not listed at all.
    let quiet = connector_accounts_instructions(&[account("", Some("lost")), account("c@x.com", Some(""))]).unwrap();
    assert_eq!(quiet, "Accounts: c@x.com. `account` may be left out.");
    assert_eq!(connector_accounts_instructions(&[]), None);
    assert_eq!(connector_accounts_instructions(&[account("", None)]), None);
}

#[test]
fn instruction_text_that_is_not_the_accounts_line_names_no_account() {
    for text in ["", "Accounts: ", "no accounts here", "accounts: a@x.com. `account` may be left out.", "Accounts: a@x.com without the marker"] {
        assert!(accounts_of_instructions(text).is_empty(), "{text:?}");
    }
    // The list is one line: a marker on a later line does not close it.
    assert!(accounts_of_instructions("Accounts: a@x.com\nb@x.com. `account` may be left out.").is_empty());
}
