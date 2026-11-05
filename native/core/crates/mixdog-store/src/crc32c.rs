//! CRC-32C (Castagnoli), FORMAT.md §2: reflected polynomial `0x82F63B78`, init and final
//! XOR `0xFFFF_FFFF`. Slicing-by-8 tables, built at compile time.

use crate::schema::frame::CRC32C_POLY_REFLECTED;

const fn tables() -> [[u32; 256]; 8] {
    let mut t = [[0u32; 256]; 8];
    let mut i = 0;
    while i < 256 {
        let mut crc = i as u32;
        let mut bit = 0;
        while bit < 8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ CRC32C_POLY_REFLECTED
            } else {
                crc >> 1
            };
            bit += 1;
        }
        t[0][i] = crc;
        i += 1;
    }
    let mut k = 1;
    while k < 8 {
        let mut i = 0;
        while i < 256 {
            let prev = t[k - 1][i];
            t[k][i] = (prev >> 8) ^ t[0][(prev & 0xff) as usize];
            i += 1;
        }
        k += 1;
    }
    t
}

static TABLES: [[u32; 256]; 8] = tables();

/// CRC-32C of `data`.
pub fn crc32c(data: &[u8]) -> u32 {
    !update(!0, data)
}

fn update(mut crc: u32, data: &[u8]) -> u32 {
    let t = &TABLES;
    let mut chunks = data.chunks_exact(8);
    for c in &mut chunks {
        let lo = crc ^ u32::from_le_bytes([c[0], c[1], c[2], c[3]]);
        let hi = u32::from_le_bytes([c[4], c[5], c[6], c[7]]);
        crc = t[7][(lo & 0xff) as usize]
            ^ t[6][((lo >> 8) & 0xff) as usize]
            ^ t[5][((lo >> 16) & 0xff) as usize]
            ^ t[4][(lo >> 24) as usize]
            ^ t[3][(hi & 0xff) as usize]
            ^ t[2][((hi >> 8) & 0xff) as usize]
            ^ t[1][((hi >> 16) & 0xff) as usize]
            ^ t[0][(hi >> 24) as usize];
    }
    for &b in chunks.remainder() {
        crc = t[0][((crc ^ u32::from(b)) & 0xff) as usize] ^ (crc >> 8);
    }
    crc
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::frame::CRC32C_CHECK;

    #[test]
    fn check_value_and_bitwise_agreement() {
        assert_eq!(crc32c(b"123456789"), CRC32C_CHECK);
        let data: Vec<u8> = (0..1000u32).map(|i| (i * 31 % 251) as u8).collect();
        for n in [0, 1, 7, 8, 9, 63, 1000] {
            let mut crc = u32::MAX;
            for &byte in &data[..n] {
                crc ^= u32::from(byte);
                for _ in 0..8 {
                    crc = if crc & 1 == 1 { (crc >> 1) ^ CRC32C_POLY_REFLECTED } else { crc >> 1 };
                }
            }
            assert_eq!(crc32c(&data[..n]), !crc, "{n}");
        }
    }
}
