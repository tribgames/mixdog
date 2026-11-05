use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use sha2::Digest;
use sha2::Sha256;

fn random_b64(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

/// A PKCE verifier and its S256 challenge.
#[derive(Clone, Debug)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

impl Pkce {
    /// `verifier_bytes` of randomness (32 for most providers, 64 for OpenAI).
    pub fn generate(verifier_bytes: usize) -> Self {
        Self::from_verifier(random_b64(verifier_bytes))
    }

    pub fn from_verifier(verifier: String) -> Self {
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        Self {
            verifier,
            challenge,
        }
    }
}

/// An unguessable `state` value.
pub fn random_state() -> String {
    random_b64(32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_matches_the_rfc7636_vector() {
        let pkce = Pkce::from_verifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".into());
        assert_eq!(pkce.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn verifier_length_follows_the_byte_count() {
        assert_eq!(Pkce::generate(32).verifier.len(), 43);
        assert_eq!(Pkce::generate(64).verifier.len(), 86);
        assert_ne!(random_state(), random_state());
    }
}