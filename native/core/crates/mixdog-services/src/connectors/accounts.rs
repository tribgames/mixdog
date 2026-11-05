//! What a connector server tells the model about its accounts (MCP `instructions`), in one
//! line: the connected accounts, and that each tool takes `account` (left out, the account
//! used last). An account that cannot be used right now is listed with why.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectorAccount {
    pub email: String,
    /// A short reason the account is unusable, such as "needs sign-in".
    pub note: Option<String>,
}

/// The MCP instructions naming `accounts`, or None when none has an address.
pub fn connector_accounts_instructions(accounts: &[ConnectorAccount]) -> Option<String> {
    let named: Vec<_> = accounts.iter().filter(|a| !a.email.is_empty()).collect();
    if named.is_empty() {
        return None;
    }
    let list = named
        .iter()
        .map(|a| match a.note.as_deref().filter(|n| !n.is_empty()) {
            Some(note) => format!("{} ({note})", a.email),
            None => a.email.clone(),
        })
        .collect::<Vec<_>>()
        .join(", ");
    Some(if named.len() == 1 {
        format!("Accounts: {list}. `account` may be left out.")
    } else {
        format!(
            "Accounts: {list}. `account` picks one; left out, a call uses the account used last, and its result names it."
        )
    })
}

/// The account addresses `connector_accounts_instructions` named.
pub fn accounts_of_instructions(instructions: &str) -> Vec<String> {
    let Some(rest) = instructions.strip_prefix("Accounts: ") else { return Vec::new() };
    let Some(end) = rest.find(". `account`") else { return Vec::new() };
    rest[..end]
        .split(", ")
        .map(|part| match part.find(" (") {
            Some(i) if part.ends_with(')') => mixdog_js::js_trim(&part[..i]),
            _ => mixdog_js::js_trim(part),
        })
        .filter(|p| !p.is_empty())
        .map(String::from)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acct(email: &str, note: Option<&str>) -> ConnectorAccount {
        ConnectorAccount { email: email.into(), note: note.map(String::from) }
    }

    #[test]
    fn single_and_multiple_account_lines() {
        assert_eq!(connector_accounts_instructions(&[acct("", None)]), None);
        assert_eq!(
            connector_accounts_instructions(&[acct("a@x.com", None), acct("", None)]).unwrap(),
            "Accounts: a@x.com. `account` may be left out."
        );
        assert_eq!(
            connector_accounts_instructions(&[acct("a@x.com", None), acct("b@x.com", Some("needs sign-in"))]).unwrap(),
            "Accounts: a@x.com, b@x.com (needs sign-in). `account` picks one; left out, a call uses the account used last, and its result names it."
        );
    }

    #[test]
    fn addresses_round_trip_without_notes() {
        let text = connector_accounts_instructions(&[acct("a@x.com", Some("n")), acct("b@x.com", None)]).unwrap();
        assert_eq!(accounts_of_instructions(&text), vec!["a@x.com", "b@x.com"]);
        assert!(accounts_of_instructions("nothing").is_empty());
    }
}
