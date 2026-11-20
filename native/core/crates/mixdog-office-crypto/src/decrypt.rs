//! The AES layer and the package steps of [MS-OFFCRYPTO] 2.3.4: the HMAC integrity check (2.3.4.14) and the
//! decryption of `\EncryptedPackage` back into the plain package (2.3.4.15 agile, 2.3.4.4 standard).

use std::fmt;

use aes::cipher::generic_array::GenericArray;
use aes::cipher::{BlockDecrypt, KeyInit};
use aes::{Aes128, Aes192, Aes256};

use crate::descriptor::{AgileDescriptor, Descriptor, Integrity};
use crate::hashes::{HashError, constant_time_equal, hash, hmac};

/// 2.3.4.14: the block keys of the HMAC key and the HMAC value.
const INTEGRITY_KEY_BLOCK: [u8; 8] = [0x5f, 0xb2, 0xad, 0x01, 0x0c, 0xb9, 0xe1, 0xf6];
const INTEGRITY_VALUE_BLOCK: [u8; 8] = [0xa0, 0x67, 0x7f, 0x02, 0xb2, 0x2c, 0x84, 0x33];
const SEGMENT_LENGTH: usize = 4096;
const AES_BLOCK: usize = 16;

/// Why a decryption step failed: the messages OpenSSL-style crypto gives, or the package's own.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CryptoError {
    /// `createDecipheriv`: the key is not 16, 24 or 32 bytes.
    InvalidKeyLength,
    /// `createDecipheriv`: a CBC initialization vector that is not one block.
    InvalidInitializationVector,
    /// `decipher.final()` with automatic padding off over data that is not whole blocks.
    WrongFinalBlockLength,
    /// `\EncryptedPackage` is shorter than its StreamSize says.
    Truncated,
    Hash(HashError),
}

impl fmt::Display for CryptoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidKeyLength => f.write_str("Invalid key length"),
            Self::InvalidInitializationVector => f.write_str("Invalid initialization vector"),
            Self::WrongFinalBlockLength => f.write_str("error:1C80006B:Provider routines::wrong final block length"),
            Self::Truncated => f.write_str("The encrypted package is truncated."),
            Self::Hash(error) => fmt::Display::fmt(error, f),
        }
    }
}

impl std::error::Error for CryptoError {}

impl From<HashError> for CryptoError {
    fn from(error: HashError) -> Self {
        Self::Hash(error)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    Cbc,
    Ecb,
}

enum BlockCipher {
    Aes128(Aes128),
    Aes192(Aes192),
    Aes256(Aes256),
}

impl BlockCipher {
    fn new(key: &[u8]) -> Result<Self, CryptoError> {
        let invalid = |_| CryptoError::InvalidKeyLength;
        match key.len() {
            16 => Aes128::new_from_slice(key).map(Self::Aes128).map_err(invalid),
            24 => Aes192::new_from_slice(key).map(Self::Aes192).map_err(invalid),
            32 => Aes256::new_from_slice(key).map(Self::Aes256).map_err(invalid),
            _ => Err(CryptoError::InvalidKeyLength),
        }
    }

    fn decrypt_block(&self, block: &mut [u8]) {
        let block = GenericArray::from_mut_slice(block);
        match self {
            Self::Aes128(cipher) => cipher.decrypt_block(block),
            Self::Aes192(cipher) => cipher.decrypt_block(block),
            Self::Aes256(cipher) => cipher.decrypt_block(block),
        }
    }
}

/// `createDecipheriv('aes-<bits>-<mode>', key, iv)` with automatic padding off, over `data` of whole blocks. ECB takes
/// no initialization vector.
pub(crate) fn aes_decrypt(mode: Mode, key: &[u8], iv: &[u8], data: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let cipher = BlockCipher::new(key)?;
    if mode == Mode::Cbc && iv.len() != AES_BLOCK {
        return Err(CryptoError::InvalidInitializationVector);
    }
    if data.len() % AES_BLOCK != 0 {
        return Err(CryptoError::WrongFinalBlockLength);
    }
    let mut plain = data.to_vec();
    let mut previous = [0u8; AES_BLOCK];
    if mode == Mode::Cbc {
        previous.copy_from_slice(iv);
    }
    for (chunk, cipher_block) in plain.chunks_exact_mut(AES_BLOCK).zip(data.chunks_exact(AES_BLOCK)) {
        cipher.decrypt_block(chunk);
        if mode == Mode::Cbc {
            for (byte, mask) in chunk.iter_mut().zip(previous) {
                *byte ^= mask;
            }
            previous.copy_from_slice(cipher_block);
        }
    }
    Ok(plain)
}

/// Truncated to, or padded with 0x36 up to, `length` bytes (2.3.4.11, 2.3.4.12).
pub(crate) fn fitted(bytes: &[u8], length: usize) -> Vec<u8> {
    let mut out = bytes[..bytes.len().min(length)].to_vec();
    out.resize(length, 0x36);
    out
}

pub(crate) fn uint32(value: u32) -> [u8; 4] {
    value.to_le_bytes()
}

/// 2.3.4.14: whether `\EncryptedPackage` is the stream the descriptor's HMAC was computed over. The HMAC key (the salt)
/// and value are decrypted with the package key and IVs H(keyData salt + block key) (2.3.4.12), and the HMAC covers the
/// whole stream, its StreamSize field included. Standard encryption and an agile descriptor without dataIntegrity carry
/// nothing to check (the schema makes the element optional); a malformed one never passes.
pub fn package_intact(descriptor: &Descriptor, key: &[u8], encrypted_package: &[u8]) -> Result<bool, CryptoError> {
    let Descriptor::Agile(agile) = descriptor else {
        return Ok(true);
    };
    match &agile.integrity {
        None => Ok(true),
        Some(Integrity::Malformed) => Ok(false),
        Some(Integrity::Present { hmac_key, hmac_value, salt_length }) => {
            let data = &agile.data;
            let open = |block: &[u8], value: &[u8]| -> Result<Vec<u8>, CryptoError> {
                let iv = fitted(&hash(data.algorithm, &[&data.salt, block])?, data.block_size);
                aes_decrypt(Mode::Cbc, key, &iv, value)
            };
            // The HMAC key is the salt without its block padding (its length read in dataIntegrity), the HMAC the
            // first hashSize bytes.
            let opened_key = open(&INTEGRITY_KEY_BLOCK, hmac_key)?;
            let hmac_key = &opened_key[..(*salt_length).min(opened_key.len())];
            let opened_value = open(&INTEGRITY_VALUE_BLOCK, hmac_value)?;
            let expected = &opened_value[..data.hash_size.min(opened_value.len())];
            let actual = hmac(data.algorithm, hmac_key, encrypted_package)?;
            Ok(constant_time_equal(&actual, expected))
        }
    }
}

/// 2.3.4.15 (agile) / 2.3.4.4 (standard): the plain package. `\EncryptedPackage` starts with the 8-byte StreamSize of
/// the plain package; agile ciphertext is 4096-byte segments, each with IV H(keyData salt + segment index), standard
/// ciphertext is one AES-ECB run.
pub fn decrypt_package(descriptor: &Descriptor, key: &[u8], encrypted_package: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if encrypted_package.len() < 8 {
        return Err(CryptoError::Truncated);
    }
    let mut size_bytes = [0u8; 8];
    size_bytes.copy_from_slice(&encrypted_package[..8]);
    let size = u64::from_le_bytes(size_bytes);
    let body = &encrypted_package[8..];
    if size > body.len() as u64 {
        return Err(CryptoError::Truncated);
    }
    let mut plain = match descriptor {
        Descriptor::Agile(agile) => decrypt_agile_segments(agile, key, body)?,
        Descriptor::Standard(_) => aes_decrypt(Mode::Ecb, key, &[], &body[..body.len() - body.len() % AES_BLOCK])?,
    };
    if (plain.len() as u64) < size {
        return Err(CryptoError::Truncated);
    }
    plain.truncate(size as usize);
    Ok(plain)
}

fn decrypt_agile_segments(agile: &AgileDescriptor, key: &[u8], body: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let data = &agile.data;
    let mut plain = Vec::with_capacity(body.len());
    for (index, segment) in body.chunks(SEGMENT_LENGTH).enumerate() {
        let whole = &segment[..segment.len() - segment.len() % data.block_size];
        let index = u32::try_from(index).unwrap_or(u32::MAX);
        let iv = fitted(&hash(data.algorithm, &[&data.salt, &uint32(index)])?, data.block_size);
        plain.extend_from_slice(&aes_decrypt(Mode::Cbc, key, &iv, whole)?);
    }
    Ok(plain)
}
