//! The hash algorithms an encryption descriptor can name ([MS-OFFCRYPTO] 2.3.4.10 HashAlgorithm), with the answer
//! Node's `crypto.createHash` gave for each name on the reference machine (Node 22, OpenSSL 3.5): SHA-1, SHA-256,
//! SHA-384, SHA-512, MD5 and RIPEMD-160 are computed; MD4 and WHIRLPOOL are legacy algorithms the OpenSSL 3 default
//! provider does not load (`error:0308010C:digital envelope routines::unsupported`); MD2 and RIPEMD-128 are not
//! compiled in (`Digest method not supported`). A descriptor that names an algorithm that cannot be computed is
//! therefore "unsupported", exactly as before: nothing is widened and nothing narrowed.

use std::fmt;
use std::ops::Deref;

use md5::Md5;
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha384, Sha512};

/// The most bytes any supported digest has (SHA-512).
const MAX_DIGEST: usize = 64;

/// A hash algorithm by the name [MS-OFFCRYPTO] gives it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HashAlgorithm {
    Sha1,
    Sha256,
    Sha384,
    Sha512,
    Md5,
    Md4,
    Md2,
    Ripemd128,
    Ripemd160,
    Whirlpool,
}

/// What Node threw for an algorithm that cannot be computed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HashError {
    /// `createHash`: a legacy algorithm the OpenSSL 3 default provider does not load (MD4, WHIRLPOOL).
    LegacyProvider,
    /// `createHash`: an algorithm this OpenSSL does not have (MD2, RIPEMD-128).
    NotCompiledIn,
    /// `createHmac`: the same algorithm as a name no digest answers to.
    InvalidDigest(&'static str),
}

impl fmt::Display for HashError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::LegacyProvider => f.write_str("error:0308010C:digital envelope routines::unsupported"),
            Self::NotCompiledIn => f.write_str("Digest method not supported"),
            Self::InvalidDigest(name) => write!(f, "Invalid digest: {name}"),
        }
    }
}

impl std::error::Error for HashError {}

impl HashAlgorithm {
    /// The algorithm a descriptor's `hashAlgorithm` attribute names, matched exactly: "SHA1" is the name Windows
    /// resolves SHA-1 by, which footnote <21> of [MS-OFFCRYPTO] allows; "SHA-512" or "sha512" are not names.
    #[must_use]
    pub fn from_descriptor_name(name: &str) -> Option<Self> {
        Some(match name {
            "SHA-1" | "SHA1" => Self::Sha1,
            "SHA256" => Self::Sha256,
            "SHA384" => Self::Sha384,
            "SHA512" => Self::Sha512,
            "MD5" => Self::Md5,
            "MD4" => Self::Md4,
            "MD2" => Self::Md2,
            "RIPEMD-128" => Self::Ripemd128,
            "RIPEMD-160" => Self::Ripemd160,
            "WHIRLPOOL" => Self::Whirlpool,
            _ => return None,
        })
    }

    /// The name OpenSSL (and so Node's `createHash`) knows the algorithm by.
    #[must_use]
    pub fn openssl_name(self) -> &'static str {
        match self {
            Self::Sha1 => "sha1",
            Self::Sha256 => "sha256",
            Self::Sha384 => "sha384",
            Self::Sha512 => "sha512",
            Self::Md5 => "md5",
            Self::Md4 => "md4",
            Self::Md2 => "md2",
            Self::Ripemd128 => "ripemd128",
            Self::Ripemd160 => "ripemd160",
            Self::Whirlpool => "whirlpool",
        }
    }

    /// The error `createHash` threw for this algorithm, or `None` when it is computed.
    #[must_use]
    pub fn unsupported(self) -> Option<HashError> {
        match self {
            Self::Md4 | Self::Whirlpool => Some(HashError::LegacyProvider),
            Self::Md2 | Self::Ripemd128 => Some(HashError::NotCompiledIn),
            _ => None,
        }
    }

    /// The digest length in bytes, or `None` when this algorithm cannot be computed.
    #[must_use]
    pub fn digest_length(self) -> Option<usize> {
        match self {
            Self::Sha1 | Self::Ripemd160 => Some(20),
            Self::Sha256 => Some(32),
            Self::Sha384 => Some(48),
            Self::Sha512 => Some(64),
            Self::Md5 => Some(16),
            Self::Md4 | Self::Md2 | Self::Ripemd128 | Self::Whirlpool => None,
        }
    }

    /// The block size of the HMAC construction over this algorithm.
    fn block_size(self) -> usize {
        match self {
            Self::Sha384 | Self::Sha512 => 128,
            _ => 64,
        }
    }
}

/// A finished digest: at most 64 bytes, kept on the stack.
#[derive(Clone, Copy)]
pub struct DigestBytes {
    bytes: [u8; MAX_DIGEST],
    len: usize,
}

impl DigestBytes {
    fn from_slice(source: &[u8]) -> Self {
        let mut bytes = [0u8; MAX_DIGEST];
        bytes[..source.len()].copy_from_slice(source);
        Self {
            bytes,
            len: source.len(),
        }
    }
}

impl Deref for DigestBytes {
    type Target = [u8];

    fn deref(&self) -> &[u8] {
        &self.bytes[..self.len]
    }
}

/// An incremental hash of one algorithm.
pub enum Hasher {
    Sha1(Sha1),
    Sha256(Sha256),
    Sha384(Sha384),
    Sha512(Sha512),
    Md5(Md5),
    Ripemd160(Ripemd160),
}

impl Hasher {
    /// `createHash(algorithm)`: the error Node threw for an algorithm it cannot compute.
    pub fn new(algorithm: HashAlgorithm) -> Result<Self, HashError> {
        if let Some(error) = algorithm.unsupported() {
            return Err(error);
        }
        match algorithm {
            HashAlgorithm::Sha1 => Ok(Self::Sha1(Sha1::new())),
            HashAlgorithm::Sha256 => Ok(Self::Sha256(Sha256::new())),
            HashAlgorithm::Sha384 => Ok(Self::Sha384(Sha384::new())),
            HashAlgorithm::Sha512 => Ok(Self::Sha512(Sha512::new())),
            HashAlgorithm::Md5 => Ok(Self::Md5(Md5::new())),
            HashAlgorithm::Ripemd160 => Ok(Self::Ripemd160(Ripemd160::new())),
            // `unsupported` answered for these above.
            HashAlgorithm::Md4 | HashAlgorithm::Md2 | HashAlgorithm::Ripemd128 | HashAlgorithm::Whirlpool => {
                Err(HashError::NotCompiledIn)
            }
        }
    }

    pub fn update(&mut self, data: &[u8]) {
        match self {
            Self::Sha1(hasher) => Digest::update(hasher, data),
            Self::Sha256(hasher) => Digest::update(hasher, data),
            Self::Sha384(hasher) => Digest::update(hasher, data),
            Self::Sha512(hasher) => Digest::update(hasher, data),
            Self::Md5(hasher) => Digest::update(hasher, data),
            Self::Ripemd160(hasher) => hasher.update(data),
        }
    }

    #[must_use]
    pub fn finish(self) -> DigestBytes {
        match self {
            Self::Sha1(hasher) => DigestBytes::from_slice(&hasher.finalize()),
            Self::Sha256(hasher) => DigestBytes::from_slice(&hasher.finalize()),
            Self::Sha384(hasher) => DigestBytes::from_slice(&hasher.finalize()),
            Self::Sha512(hasher) => DigestBytes::from_slice(&hasher.finalize()),
            Self::Md5(hasher) => DigestBytes::from_slice(&hasher.finalize()),
            Self::Ripemd160(hasher) => DigestBytes::from_slice(&hasher.finish()),
        }
    }
}

/// `createHash(algorithm)` over the concatenation of `parts`.
pub fn hash(algorithm: HashAlgorithm, parts: &[&[u8]]) -> Result<DigestBytes, HashError> {
    let mut hasher = Hasher::new(algorithm)?;
    for part in parts {
        hasher.update(part);
    }
    Ok(hasher.finish())
}

/// `createHmac(algorithm, key)` over `data` ([RFC2104]).
pub fn hmac(algorithm: HashAlgorithm, key: &[u8], data: &[u8]) -> Result<DigestBytes, HashError> {
    // createHmac names an algorithm it does not have where createHash says the method is not supported.
    match algorithm.unsupported() {
        Some(HashError::NotCompiledIn) => return Err(HashError::InvalidDigest(algorithm.openssl_name())),
        Some(error) => return Err(error),
        None => {}
    }
    let block = algorithm.block_size();
    let mut padded = vec![0u8; block];
    if key.len() > block {
        let digest = hash(algorithm, &[key])?;
        padded[..digest.len()].copy_from_slice(&digest);
    } else {
        padded[..key.len()].copy_from_slice(key);
    }
    let inner_key: Vec<u8> = padded.iter().map(|byte| byte ^ 0x36).collect();
    let outer_key: Vec<u8> = padded.iter().map(|byte| byte ^ 0x5c).collect();
    let inner = hash(algorithm, &[&inner_key, data])?;
    hash(algorithm, &[&outer_key, &inner])
}

/// Equal contents, compared without stopping at the first difference (`timingSafeEqual`, which refuses slices of
/// different lengths: here they are simply unequal).
#[must_use]
pub fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len() && left.iter().zip(right).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

/// RIPEMD-160 (Dobbertin, Bosselaers, Preneel): the one algorithm of the list that Node computes and no cached crate
/// provides.
pub struct Ripemd160 {
    state: [u32; 5],
    block: [u8; 64],
    filled: usize,
    length: u64,
}

const LEFT_WORD: [usize; 80] = [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8, 3, 10,
    14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12, 1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2, 4, 0, 5, 9, 7,
    12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13,
];
const RIGHT_WORD: [usize; 80] = [
    5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12, 6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2, 15, 5,
    1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13, 8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14, 12, 15, 10, 4,
    1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11,
];
const LEFT_SHIFT: [u32; 80] = [
    11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8, 7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12, 11,
    13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5, 11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12, 9, 15,
    5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6,
];
const RIGHT_SHIFT: [u32; 80] = [
    8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6, 9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11, 9,
    7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5, 15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8, 8, 5,
    12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11,
];
const LEFT_CONSTANT: [u32; 5] = [0, 0x5A82_7999, 0x6ED9_EBA1, 0x8F1B_BCDC, 0xA953_FD4E];
const RIGHT_CONSTANT: [u32; 5] = [0x50A2_8BE6, 0x5C4D_D124, 0x6D70_3EF3, 0x7A6D_76E9, 0];

fn round_function(round: usize, x: u32, y: u32, z: u32) -> u32 {
    match round {
        0 => x ^ y ^ z,
        1 => (x & y) | (!x & z),
        2 => (x | !y) ^ z,
        3 => (x & z) | (y & !z),
        _ => x ^ (y | !z),
    }
}

impl Ripemd160 {
    #[must_use]
    pub fn new() -> Self {
        Self {
            state: [0x6745_2301, 0xEFCD_AB89, 0x98BA_DCFE, 0x1032_5476, 0xC3D2_E1F0],
            block: [0; 64],
            filled: 0,
            length: 0,
        }
    }

    pub fn update(&mut self, mut data: &[u8]) {
        self.length = self.length.wrapping_add(data.len() as u64);
        if self.filled > 0 {
            let take = (64 - self.filled).min(data.len());
            self.block[self.filled..self.filled + take].copy_from_slice(&data[..take]);
            self.filled += take;
            data = &data[take..];
            if self.filled < 64 {
                return;
            }
            let block = self.block;
            self.compress(&block);
            self.filled = 0;
        }
        while data.len() >= 64 {
            let mut block = [0u8; 64];
            block.copy_from_slice(&data[..64]);
            self.compress(&block);
            data = &data[64..];
        }
        self.block[..data.len()].copy_from_slice(data);
        self.filled = data.len();
    }

    #[must_use]
    pub fn finish(mut self) -> [u8; 20] {
        let bits = self.length.wrapping_mul(8);
        let mut padding = vec![0x80u8];
        while (self.filled + padding.len()) % 64 != 56 {
            padding.push(0);
        }
        padding.extend_from_slice(&bits.to_le_bytes());
        self.update(&padding);
        let mut out = [0u8; 20];
        for (chunk, word) in out.chunks_exact_mut(4).zip(self.state) {
            chunk.copy_from_slice(&word.to_le_bytes());
        }
        out
    }

    fn compress(&mut self, block: &[u8; 64]) {
        let mut words = [0u32; 16];
        for (word, chunk) in words.iter_mut().zip(block.chunks_exact(4)) {
            *word = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        }
        let [mut a, mut b, mut c, mut d, mut e] = self.state;
        let [mut ap, mut bp, mut cp, mut dp, mut ep] = self.state;
        for j in 0..80 {
            let round = j / 16;
            let t = a
                .wrapping_add(round_function(round, b, c, d))
                .wrapping_add(words[LEFT_WORD[j]])
                .wrapping_add(LEFT_CONSTANT[round])
                .rotate_left(LEFT_SHIFT[j])
                .wrapping_add(e);
            a = e;
            e = d;
            d = c.rotate_left(10);
            c = b;
            b = t;
            let t = ap
                .wrapping_add(round_function(4 - round, bp, cp, dp))
                .wrapping_add(words[RIGHT_WORD[j]])
                .wrapping_add(RIGHT_CONSTANT[round])
                .rotate_left(RIGHT_SHIFT[j])
                .wrapping_add(ep);
            ap = ep;
            ep = dp;
            dp = cp.rotate_left(10);
            cp = bp;
            bp = t;
        }
        let t = self.state[1].wrapping_add(c).wrapping_add(dp);
        self.state[1] = self.state[2].wrapping_add(d).wrapping_add(ep);
        self.state[2] = self.state[3].wrapping_add(e).wrapping_add(ap);
        self.state[3] = self.state[4].wrapping_add(a).wrapping_add(bp);
        self.state[4] = self.state[0].wrapping_add(b).wrapping_add(cp);
        self.state[0] = t;
    }
}

impl Default for Ripemd160 {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[test]
    fn ripemd160_matches_the_digests_node_computes() {
        // Recorded from node:crypto createHash('ripemd160') on the reference machine.
        let cases: [(&[u8], &str); 3] = [
            (b"", "9c1185a5c5e9fc54612808977ee8f548b2258d31"),
            (b"abc", "8eb208f7e05d987a9b044a8e98c6b087f15a0bfc"),
            (
                b"12345678901234567890123456789012345678901234567890123456789012345678901234567890",
                "9b752e45573d4b39f4dbd3323cab82bf63326bfb",
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(
                hex(&hash(HashAlgorithm::Ripemd160, &[input]).expect("computed")),
                expected
            );
        }
        // A message fed in pieces across the 64-byte block boundary equals the whole.
        let long = vec![0x61u8; 200];
        let mut pieces = Hasher::new(HashAlgorithm::Ripemd160).expect("computed");
        for piece in long.chunks(37) {
            pieces.update(piece);
        }
        assert_eq!(
            &*pieces.finish(),
            &*hash(HashAlgorithm::Ripemd160, &[&long]).expect("computed")
        );
    }

    #[test]
    fn hashes_that_node_cannot_compute_carry_its_error_text() {
        for (algorithm, text) in [
            (
                HashAlgorithm::Md4,
                "error:0308010C:digital envelope routines::unsupported",
            ),
            (
                HashAlgorithm::Whirlpool,
                "error:0308010C:digital envelope routines::unsupported",
            ),
            (HashAlgorithm::Md2, "Digest method not supported"),
            (HashAlgorithm::Ripemd128, "Digest method not supported"),
        ] {
            assert_eq!(algorithm.digest_length(), None);
            assert_eq!(
                Hasher::new(algorithm).err().map(|error| error.to_string()).as_deref(),
                Some(text)
            );
        }
    }
}
