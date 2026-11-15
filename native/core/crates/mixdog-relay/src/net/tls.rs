//! TLS termination (`createListener`'s `https.createServer({ cert, key })`): the certificate chain and key are read once at
//! start, and the server speaks TLS 1.2 and 1.3 with no ALPN list, so h2 is never offered (the relay's phone legs did not
//! survive h2; the reason is in the comment above `createListener` in `server.mjs`).

use std::sync::Arc;

use mixdog_fsio::Unlaned;
use rustls::ServerConfig;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs1KeyDer, PrivatePkcs8KeyDer, PrivateSec1KeyDer};

/// The server configuration for the files `TLS_CERT` and `TLS_KEY` name. The error is the text `startRelay` reports after
/// `[relay] failed to start:`.
pub fn load(cert_path: &str, key_path: &str) -> Result<Arc<ServerConfig>, String> {
    let cert = read(cert_path)?;
    let key = read(key_path)?;
    from_pem(&cert, &key)
}

/// `readFileSync`'s failure text: `ENOENT: no such file or directory, open 'path'`.
fn read(path: &str) -> Result<Vec<u8>, String> {
    mixdog_fsio::read(&Unlaned, path).map_err(|error| {
        let code = mixdog_js::uv_error::error_code(&error).unwrap_or("UNKNOWN");
        let description = match code {
            "ENOENT" => "no such file or directory",
            "EACCES" => "permission denied",
            "EISDIR" => "illegal operation on a directory",
            _ => return format!("{code}: {error}, open '{path}'"),
        };
        format!("{code}: {description}, open '{path}'")
    })
}

/// The server configuration for a PEM certificate chain and a PEM private key: PKCS#8, SEC1 (`EC PRIVATE KEY`) or PKCS#1
/// (`RSA PRIVATE KEY`), ECDSA or RSA.
pub fn from_pem(cert_pem: &[u8], key_pem: &[u8]) -> Result<Arc<ServerConfig>, String> {
    let chain: Vec<CertificateDer<'static>> = pem::parse_many(cert_pem)
        .map_err(|error| format!("invalid certificate PEM: {error}"))?
        .into_iter()
        .filter(|block| matches!(block.tag(), "CERTIFICATE" | "X509 CERTIFICATE"))
        .map(|block| CertificateDer::from(block.into_contents()))
        .collect();
    if chain.is_empty() {
        return Err("no certificate found in the PEM".to_owned());
    }
    let mut key = None;
    for block in pem::parse_many(key_pem).map_err(|error| format!("invalid private key PEM: {error}"))? {
        if block.tag() == "ENCRYPTED PRIVATE KEY" {
            return Err("an encrypted private key needs a passphrase".to_owned());
        }
        if let Some(der) = private_key(block.tag(), block.contents()) {
            key = Some(der);
            break;
        }
    }
    let key = key.ok_or_else(|| "no private key found in the PEM".to_owned())?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|error| error.to_string())?
        .with_no_client_auth()
        .with_single_cert(chain, key)
        .map_err(|error| error.to_string())?;
    Ok(Arc::new(config))
}

/// The private key a PEM block holds, by its label.
fn private_key(tag: &str, contents: &[u8]) -> Option<PrivateKeyDer<'static>> {
    match tag {
        "PRIVATE KEY" => Some(PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(contents.to_vec()))),
        "EC PRIVATE KEY" => Some(PrivateKeyDer::Sec1(PrivateSec1KeyDer::from(contents.to_vec()))),
        "RSA PRIVATE KEY" => Some(PrivateKeyDer::Pkcs1(PrivatePkcs1KeyDer::from(contents.to_vec()))),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The SEC1 `ECPrivateKey` inside a PKCS#8 `PrivateKeyInfo`.
    fn sec1_of_pkcs8(der: &[u8]) -> Vec<u8> {
        fn tlv(data: &[u8]) -> (u8, &[u8], &[u8]) {
            let (len, header) = if data[1] < 0x80 {
                (usize::from(data[1]), 2)
            } else {
                let count = usize::from(data[1] & 0x7f);
                (data[2..2 + count].iter().fold(0, |len, &b| (len << 8) | usize::from(b)), 2 + count)
            };
            (data[0], &data[header..header + len], &data[header + len..])
        }
        let (_, body, _) = tlv(der);
        let (_, _, rest) = tlv(body);
        let (_, _, rest) = tlv(rest);
        let (tag, sec1, _) = tlv(rest);
        assert_eq!(tag, 0x04);
        sec1.to_vec()
    }

    fn issued() -> (String, Vec<u8>) {
        let issued = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()]).unwrap();
        (issued.cert.pem(), issued.signing_key.serialize_der())
    }

    #[test]
    fn a_pkcs8_key_and_a_certificate_make_a_server_with_no_alpn_list() {
        let (cert, key) = issued();
        let key_pem = pem::encode(&pem::Pem::new("PRIVATE KEY", key));
        let config = from_pem(cert.as_bytes(), key_pem.as_bytes()).unwrap();
        assert!(config.alpn_protocols.is_empty(), "h2 is never offered");
    }

    #[test]
    fn a_sec1_key_is_accepted_and_a_key_file_may_carry_other_blocks_before_it() {
        let (cert, key) = issued();
        let sec1 = pem::Pem::new("EC PRIVATE KEY", sec1_of_pkcs8(&key));
        let params = pem::Pem::new("EC PARAMETERS", vec![0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);
        let key_pem = pem::encode_many(&[params, sec1]);
        assert!(from_pem(cert.as_bytes(), key_pem.as_bytes()).is_ok());
    }

    #[test]
    fn the_key_forms_are_told_apart_by_their_label() {
        assert!(matches!(private_key("PRIVATE KEY", b"k"), Some(PrivateKeyDer::Pkcs8(_))));
        assert!(matches!(private_key("EC PRIVATE KEY", b"k"), Some(PrivateKeyDer::Sec1(_))));
        assert!(matches!(private_key("RSA PRIVATE KEY", b"k"), Some(PrivateKeyDer::Pkcs1(_))));
        assert!(private_key("PUBLIC KEY", b"k").is_none());
    }

    #[test]
    fn a_missing_certificate_or_key_is_reported() {
        let (cert, key) = issued();
        let key_pem = pem::encode(&pem::Pem::new("PRIVATE KEY", key));
        assert!(from_pem(b"", key_pem.as_bytes()).unwrap_err().contains("no certificate"));
        assert!(from_pem(cert.as_bytes(), b"").unwrap_err().contains("no private key"));
        let encrypted = pem::encode(&pem::Pem::new("ENCRYPTED PRIVATE KEY", vec![1, 2, 3]));
        assert!(from_pem(cert.as_bytes(), encrypted.as_bytes()).unwrap_err().contains("passphrase"));
    }

    #[test]
    fn an_unreadable_file_is_reported_as_node_reports_it() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("none.pem");
        let missing = missing.to_str().unwrap();
        assert_eq!(load(missing, missing).err().unwrap(), format!("ENOENT: no such file or directory, open '{missing}'"));
    }
}
