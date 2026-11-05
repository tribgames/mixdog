//! Files of the PC's remote-access identity: relay registration, revocation queue, pairing
//! token, E2EE identity and the paired-device roster. All secrets are owner-only.

pub mod device;
pub mod files;
pub mod roster;
pub mod secret;

pub use device::{DeviceFiles, DeviceIdentity, QueueError};
pub use files::{
    load_or_create_e2ee_identity, load_or_create_pairing_token, rotate_e2ee_identity, rotate_pairing_token,
};
pub use roster::{ClientInfo, ControllerKeyRecord, OwedAccess, Roster};
pub use secret::{SecretError, is_owner_only, read_secret, write_secret};
