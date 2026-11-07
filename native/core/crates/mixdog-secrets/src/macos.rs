//! macOS: a generic-password item with account `<account>` and service `mixdog` — the item
//! `security add-generic-password -a <account> -s mixdog -w <value> -U` writes and
//! `security find-generic-password -a <account> -s mixdog -w` reads (`keychain-cjs.cjs` darwin).
//! The Security framework is called directly, so no process is spawned.

use async_trait::async_trait;
use mixdog_js::js_trim_end;
use mixdog_rt::DurabilityIo;
use security_framework::passwords::delete_generic_password;
use security_framework::passwords::get_generic_password;
use security_framework::passwords::set_generic_password;

use super::SERVICE;
use super::SecretError;
use super::SecretStore;
use super::on_lane;

/// `errSecItemNotFound`: the keychain answered that the account holds nothing (`security` exits 44).
const ITEM_NOT_FOUND: i32 = -25300;

pub struct KeychainStore {
    io: DurabilityIo,
}

impl KeychainStore {
    pub fn new(io: DurabilityIo) -> Self {
        Self { io }
    }
}

#[async_trait]
impl SecretStore for KeychainStore {
    async fn get(&self, account: &str) -> Result<Option<String>, SecretError> {
        let account = account.to_owned();
        on_lane(self.io, move || match get_generic_password(SERVICE, &account) {
            // `security ... -w` prints the value and a newline; Node drops trailing whitespace.
            Ok(bytes) => Ok(Some(js_trim_end(&String::from_utf8_lossy(&bytes)).to_owned())),
            Err(error) if error.code() == ITEM_NOT_FOUND => Ok(None),
            // Node reads any other failure as "nothing stored".
            Err(_) => Ok(None),
        })
        .await?
    }

    async fn set(&self, account: &str, value: &str) -> Result<(), SecretError> {
        let (account, value) = (account.to_owned(), value.to_owned());
        on_lane(self.io, move || {
            set_generic_password(SERVICE, &account, value.as_bytes())
                .map_err(|error| SecretError::new(format!("[keychain] security set failed: {error}")))
        })
        .await?
    }

    async fn delete(&self, account: &str) -> Result<(), SecretError> {
        let account = account.to_owned();
        on_lane(self.io, move || match delete_generic_password(SERVICE, &account) {
            Ok(()) => Ok(()),
            // Exit 44 is errSecItemNotFound: nothing stored, so nothing to delete.
            Err(error) if error.code() == ITEM_NOT_FOUND => Ok(()),
            Err(error) => Err(SecretError::new(format!("[keychain] security delete failed: {error}"))),
        })
        .await?
    }

    async fn is_fallback(&self, _account: &str) -> Result<bool, SecretError> {
        Ok(false)
    }
}
