//! Password-protected Office containers for the document preview: a bounded reader of the Compound File Binary
//! container, the probes that tell whether a document is password protected, and the [MS-OFFCRYPTO] decryption of an
//! encrypted OOXML package (agile and standard encryption).
//!
//! - [`cfb`]: the bounded compound-file reader ([MS-CFB]); every refusal has the message Node's reader gave.
//! - [`protection`]: the probes (OOXML `EncryptionInfo` + `EncryptedPackage`, a .doc FIB `fEncrypted`, a .ppt
//!   `EncryptedSummary` or `Current User` header token) and the readers of the two OOXML streams.
//! - [`descriptor`]: the agile (XML) and standard (binary) encryption descriptors.
//! - [`keys`]: the password derivation on its own cancellable thread (two at a time) and the verifier check.
//! - [`decrypt`]: the HMAC integrity check and the segment decryption of the package.
//! - [`hashes`]: the hash algorithms a descriptor can name, each as Node's crypto answered for it.
//!
//! Everything here is blocking: callers run it from a job on an I/O or CPU lane.

pub mod cfb;
pub mod decrypt;
pub mod descriptor;
pub mod hashes;
pub mod keys;
pub mod protection;

pub use cfb::{CfbError, CompoundFile};
pub use decrypt::{CryptoError, decrypt_package, package_intact};
pub use descriptor::{AgileCipher, AgileDescriptor, Descriptor, Integrity, StandardDescriptor, ooxml_encryption};
pub use keys::{
    CancelToken, DerivationCounts, KeyDerivation, KeyError, MAX_KEY_DERIVATIONS, key_derivations, password_key,
};
pub use protection::{
    EncryptedOoxml, is_encrypted_binary_presentation, is_encrypted_ooxml, is_encrypted_word_document,
    read_encrypted_ooxml, read_ooxml_encryption_info,
};
