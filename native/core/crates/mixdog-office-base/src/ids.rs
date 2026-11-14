//! The ids of Office sessions and transactions: a prefix and 16 hex digits of a random UUID.

use uuid::Uuid;

fn sixteen_hex() -> String {
    Uuid::new_v4().simple().to_string()[..16].to_owned()
}

/// `officeSessionId()`: `office_` and 16 hex digits.
pub fn office_session_id() -> String {
    format!("office_{}", sixteen_hex())
}

/// The id of a transaction (`office-transactions.mjs`): `office_tx_` and 16 hex digits.
pub fn office_transaction_id() -> String {
    format!("office_tx_{}", sixteen_hex())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shaped(id: &str, prefix: &str) -> bool {
        id.strip_prefix(prefix).is_some_and(|rest| rest.len() == 16 && rest.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    }

    // Port of `office session ids are stable in shape and unique` (core/office-session-record.test.mjs).
    #[test]
    fn office_session_ids_are_stable_in_shape_and_unique() {
        let first = office_session_id();
        let second = office_session_id();
        assert!(shaped(&first, "office_"), "{first}");
        assert_ne!(first, second);
    }

    #[test]
    fn transaction_ids_have_their_own_prefix() {
        let id = office_transaction_id();
        assert!(shaped(&id, "office_tx_"), "{id}");
        assert_ne!(id, office_transaction_id());
    }
}
