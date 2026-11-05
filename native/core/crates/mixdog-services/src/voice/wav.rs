//! Leading silence for converted recordings, so a clipped onset still decodes as the first
//! word. The bundled ffmpeg has no delay filter, so the pad is spliced into the wav here.

pub const ONSET_SILENCE_SECONDS: f64 = 0.3;

#[derive(Debug, PartialEq, Eq)]
pub struct NoPcmData;

impl std::fmt::Display for NoPcmData {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("no PCM data chunk in wav")
    }
}

impl std::error::Error for NoPcmData {}

fn u32_at(wav: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(wav.get(at..at + 4)?.try_into().ok()?))
}

fn u16_at(wav: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(wav.get(at..at + 2)?.try_into().ok()?))
}

/// The wav with `seconds` of zero samples in front of its PCM data.
pub fn prepend_wav_silence(wav: &[u8], seconds: f64) -> Result<Vec<u8>, NoPcmData> {
    let (mut sample_rate, mut block_align) = (0u32, 0u32);
    let mut offset = 12usize;
    while offset + 8 <= wav.len() {
        let id = &wav[offset..offset + 4];
        let size = u32_at(wav, offset + 4).ok_or(NoPcmData)? as usize;
        if id == b"fmt " {
            sample_rate = u32_at(wav, offset + 12).ok_or(NoPcmData)?;
            block_align = u32::from(u16_at(wav, offset + 20).ok_or(NoPcmData)?);
        } else if id == b"data" {
            let silence = (f64::from(sample_rate) * seconds).round() as usize * block_align as usize;
            let mut out = Vec::with_capacity(wav.len() + silence);
            out.extend_from_slice(&wav[..offset + 8]);
            out.resize(out.len() + silence, 0);
            out.extend_from_slice(&wav[offset + 8..]);
            out[offset + 4..offset + 8].copy_from_slice(&((size + silence) as u32).to_le_bytes());
            let riff = (out.len() - 8) as u32;
            out[4..8].copy_from_slice(&riff.to_le_bytes());
            return Ok(out);
        }
        offset += 8 + size + (size % 2);
    }
    Err(NoPcmData)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(rate: u32, samples: &[i16]) -> Vec<u8> {
        let data_len = (samples.len() * 2) as u32;
        let mut w = b"RIFF".to_vec();
        w.extend((36 + data_len).to_le_bytes());
        w.extend(b"WAVEfmt ");
        w.extend(16u32.to_le_bytes());
        w.extend(1u16.to_le_bytes());
        w.extend(1u16.to_le_bytes());
        w.extend(rate.to_le_bytes());
        w.extend((rate * 2).to_le_bytes());
        w.extend(2u16.to_le_bytes());
        w.extend(16u16.to_le_bytes());
        w.extend(b"data");
        w.extend(data_len.to_le_bytes());
        for s in samples {
            w.extend(s.to_le_bytes());
        }
        w
    }

    #[test]
    fn pads_pcm_and_rewrites_both_sizes() {
        let out = prepend_wav_silence(&wav(16000, &[1, 2, 3]), 0.3).unwrap();
        let pad = 4800 * 2;
        assert_eq!(out.len(), 44 + 6 + pad);
        assert_eq!(u32_at(&out, 40).unwrap() as usize, 6 + pad);
        assert_eq!(u32_at(&out, 4).unwrap() as usize, out.len() - 8);
        assert!(out[44..44 + pad].iter().all(|b| *b == 0));
        assert_eq!(&out[44 + pad..], &[1, 0, 2, 0, 3, 0]);
    }

    #[test]
    fn rejects_wav_without_data_chunk() {
        assert_eq!(prepend_wav_silence(&wav(16000, &[])[..36], 0.3), Err(NoPcmData));
    }
}
