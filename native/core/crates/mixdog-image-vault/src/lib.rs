//! The versioned image verdict store ([`vault`]) and the migration of the images a restored history already holds into it
//! ([`migration`]). Kept apart from the session and core crates so both can use it.

pub mod migration;
pub mod vault;

pub use vault::ImageVault;
