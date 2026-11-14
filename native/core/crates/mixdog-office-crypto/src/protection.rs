//! Password protection, read from the Compound File Binary container itself.
//!
//! An encrypted Office document is a CFB container ([MS-CFB]) whose root storage holds well-known streams. The CFB
//! signature alone proves nothing (an unencrypted legacy .doc renamed .docx has it too), so the root-level stream
//! names are listed the way [MS-CFB] lays them out. Only the header, the directory sectors and at most one 64-byte
//! slice of one stream are read for a verdict, never the whole file. Any malformed or truncated container is "not
//! protected", and the renderer then decides exactly as it would have.

use std::path::Path;

use mixdog_fsio::{File, ReadProof};

use crate::cfb::{CfbError, CompoundFile, MAX_ENCRYPTED_PACKAGE_BYTES, MAX_ENCRYPTION_INFO_BYTES};

/// The `\EncryptionInfo` and `\EncryptedPackage` streams of an encrypted OOXML document ([MS-OFFCRYPTO] 2.3.4.4,
/// 2.3.4.5).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EncryptedOoxml {
    pub encryption_info: Vec<u8>,
    pub encrypted_package: Vec<u8>,
}

/// Runs `decide` over the container at `path`; a file that cannot be opened or read, or a container that is
/// malformed, is `fallback`.
fn inspect<P, T, F>(proof: &P, path: &Path, fallback: T, decide: F) -> T
where
    P: ReadProof,
    F: FnOnce(&mut CompoundFile<File>) -> Result<T, CfbError>,
{
    let Ok(file) = File::open(proof, path) else {
        return fallback;
    };
    match CompoundFile::open(file) {
        Ok(mut container) => decide(&mut container).unwrap_or(fallback),
        Err(_) => fallback,
    }
}

/// The two streams of an encrypted OOXML document, or `None` when the container cannot be read or the package is too
/// large to unlock.
pub fn read_encrypted_ooxml<P: ReadProof>(proof: &P, path: &Path) -> Option<EncryptedOoxml> {
    inspect(proof, path, None, |file| {
        Ok(Some(EncryptedOoxml {
            encryption_info: file.read_stream("EncryptionInfo", MAX_ENCRYPTION_INFO_BYTES)?,
            encrypted_package: file.read_stream("EncryptedPackage", MAX_ENCRYPTED_PACKAGE_BYTES)?,
        }))
    })
}

/// Only the `\EncryptionInfo` stream, enough to tell whether the encryption is one a preview can unlock.
pub fn read_ooxml_encryption_info<P: ReadProof>(proof: &P, path: &Path) -> Option<Vec<u8>> {
    inspect(proof, path, None, |file| {
        file.read_stream("EncryptionInfo", MAX_ENCRYPTION_INFO_BYTES).map(Some)
    })
}

/// [MS-DOC] 2.5.1 FibBase, at the start of the "WordDocument" stream: wIdent 0xA5EC, and fEncrypted (bit 0x0100 of the
/// flags word at offset 10) set when the document is encrypted or XOR-obfuscated, both opened by a password.
pub fn is_encrypted_word_document<P: ReadProof>(proof: &P, path: &Path) -> bool {
    inspect(proof, path, false, |file| {
        let fib = file.read_stream_head("WordDocument", 12)?;
        Ok(u16::from_le_bytes([fib[0], fib[1]]) == 0xa5ec && (u16::from_le_bytes([fib[10], fib[11]]) & 0x0100) != 0)
    })
}

/// [MS-OFFCRYPTO] 2.3.4 (ECMA-376 Document Encryption): an encrypted OOXML document is a CFB container holding the
/// root-level streams `\EncryptionInfo` (2.3.4.5) and `\EncryptedPackage` (2.3.4.4).
pub fn is_encrypted_ooxml<P: ReadProof>(proof: &P, path: &Path) -> bool {
    inspect(proof, path, false, |file| {
        Ok(file.has_stream("EncryptionInfo") && file.has_stream("EncryptedPackage"))
    })
}

/// [MS-PPT] binary presentation: an "EncryptedSummary" stream (2.1.6) exists only in an encrypted document, and an
/// encrypted file's "Current User" stream (2.1.1), which is never encrypted, holds a CurrentUserAtom (2.3.2:
/// RecordHeader with recType 0x0FF6, size, headerToken) whose headerToken 0xF3D1C4DF means the file MUST be encrypted.
pub fn is_encrypted_binary_presentation<P: ReadProof>(proof: &P, path: &Path) -> bool {
    inspect(proof, path, false, |file| {
        if file.has_stream("EncryptedSummary") {
            return Ok(true);
        }
        let atom = file.read_stream_head("Current User", 16)?;
        Ok(u16::from_le_bytes([atom[2], atom[3]]) == 0x0ff6
            && u32::from_le_bytes([atom[12], atom[13], atom[14], atom[15]]) == 0xf3d1_c4df)
    })
}
