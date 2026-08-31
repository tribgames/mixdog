use std::io::{self, Read};

use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chromium_importer::chromium::{import_logins, LoginImportResult};
use serde::Serialize;
use zeroize::Zeroize;

mod abe_client;
mod cookies;
mod keys;

const MAX_KEY_INPUT_BYTES: u64 = 256;

#[derive(Serialize)]
struct Credential {
    url: String,
    username: String,
    password: String,
    note: String,
}

impl Drop for Credential {
    fn drop(&mut self) {
        self.url.zeroize();
        self.username.zeroize();
        self.password.zeroize();
        self.note.zeroize();
    }
}

#[derive(Serialize)]
struct EncryptedEnvelope {
    version: u8,
    nonce: String,
    ciphertext: String,
}

fn argument(args: &[String], name: &str) -> Option<String> {
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].clone())
}

fn upstream_browser_name(browser: &str) -> Option<&'static str> {
    match browser {
        "chrome" => Some("Chrome"),
        _ => None,
    }
}

fn read_transport_key() -> Result<[u8; 32], ()> {
    let mut encoded = String::new();
    io::stdin()
        .take(MAX_KEY_INPUT_BYTES)
        .read_to_string(&mut encoded)
        .map_err(|_| ())?;
    let mut decoded = BASE64_STANDARD.decode(encoded.trim()).map_err(|_| ())?;
    if decoded.len() != 32 {
        decoded.zeroize();
        return Err(());
    }
    let mut key = [0_u8; 32];
    key.copy_from_slice(&decoded);
    decoded.zeroize();
    Ok(key)
}

fn seal<T: Serialize>(mut key: [u8; 32], value: &T) -> Result<String, ()> {
    let mut plaintext = serde_json::to_vec(value).map_err(|_| ())?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| ())?;
    let nonce = rand::random::<[u8; 12]>();
    let ciphertext = cipher
        .encrypt((&nonce).into(), plaintext.as_ref())
        .map_err(|_| ())?;
    plaintext.zeroize();
    key.zeroize();
    serde_json::to_string(&EncryptedEnvelope {
        version: 1,
        nonce: BASE64_STANDARD.encode(nonce),
        ciphertext: BASE64_STANDARD.encode(ciphertext),
    })
    .map_err(|_| ())
}

fn fail(message: &str, code: i32) -> ! {
    eprintln!("{message}");
    std::process::exit(code);
}

#[tokio::main]
async fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.first().map(String::as_str) {
        Some("import-passwords") => run_import_passwords(&args).await,
        Some("import-cookies") => run_import_cookies(&args).await,
        _ => fail("Invalid importer command.", 2),
    }
}

/// Validate the shared argument shape and return the requested profile id.
fn parse_common(args: &[String], command: &str) -> String {
    let profile = argument(args, "--profile");
    let upstream_browser = argument(args, "--browser")
        .as_deref()
        .and_then(upstream_browser_name);
    let valid = args.first().is_some_and(|value| value == command)
        && upstream_browser.is_some()
        && args.iter().any(|value| value == "--json")
        && profile.as_ref().is_some_and(|value| {
            !value.is_empty() && value.len() <= 120 && !value.contains('/') && !value.contains('\\')
        });
    if !valid {
        fail("Invalid importer arguments.", 2);
    }
    profile.unwrap_or_default()
}

async fn run_import_passwords(args: &[String]) -> ! {
    let profile = parse_common(args, "import-passwords");
    let key = read_transport_key().unwrap_or_else(|_| fail("Invalid importer transport key.", 2));
    let results = import_logins("Chrome", &profile, false)
        .await
        .unwrap_or_else(|_| fail("Chrome password import failed.", 1));

    let mut failures = 0_usize;
    let credentials = results
        .into_iter()
        .filter_map(|result| match result {
            LoginImportResult::Success(login) => Some(Credential {
                url: login.url,
                username: login.username,
                password: login.password,
                note: login.note,
            }),
            LoginImportResult::Failure(_) => {
                failures += 1;
                None
            }
        })
        .collect::<Vec<_>>();
    if credentials.is_empty() && failures > 0 {
        fail("Chrome password decryption failed.", 1);
    }

    let envelope = seal(key, &credentials)
        .unwrap_or_else(|_| fail("Chrome password import encryption failed.", 1));
    print!("{envelope}");
    std::process::exit(0);
}

async fn run_import_cookies(args: &[String]) -> ! {
    let profile = parse_common(args, "import-cookies");
    let key = read_transport_key().unwrap_or_else(|_| fail("Invalid importer transport key.", 2));
    let cookies = cookies::import_chrome_cookies(&profile)
        .await
        .unwrap_or_else(|error| fail(&format!("Chrome cookie import failed: {error}"), 1));
    let envelope =
        seal(key, &cookies).unwrap_or_else(|_| fail("Chrome cookie import encryption failed.", 1));
    print!("{envelope}");
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::aead::Aead;

    #[test]
    fn maps_cli_chrome_to_the_upstream_browser_key() {
        assert_eq!(upstream_browser_name("chrome"), Some("Chrome"));
        assert_eq!(upstream_browser_name("Chrome"), None);
    }

    #[test]
    fn envelope_round_trip_keeps_plaintext_out_of_stdout() {
        let key = [7_u8; 32];
        let credentials = vec![Credential {
            url: "https://example.test".to_string(),
            username: "fixture-user".to_string(),
            password: "fixture-secret".to_string(),
            note: String::new(),
        }];
        let output = seal(key, &credentials).expect("seal");
        assert!(!output.contains("fixture-secret"));
        let envelope: serde_json::Value = serde_json::from_str(&output).expect("json");
        let nonce: [u8; 12] = BASE64_STANDARD
            .decode(envelope["nonce"].as_str().expect("nonce"))
            .expect("nonce base64")
            .try_into()
            .expect("nonce length");
        let ciphertext = BASE64_STANDARD
            .decode(envelope["ciphertext"].as_str().expect("ciphertext"))
            .expect("ciphertext base64");
        let cipher = Aes256Gcm::new_from_slice(&key).expect("cipher");
        let plaintext = cipher
            .decrypt((&nonce).into(), ciphertext.as_ref())
            .expect("decrypt");
        assert!(String::from_utf8(plaintext)
            .expect("utf8")
            .contains("fixture-secret"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_dpapi_key_and_v10_aes_fixture_round_trip() {
        use chromium_importer::chromium::crypt_unprotect_data;
        use windows::Win32::{
            Foundation::{LocalFree, HLOCAL},
            Security::Cryptography::{
                CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
            },
        };

        let key = [0x42_u8; 32];
        let input = CRYPT_INTEGER_BLOB {
            cbData: key.len() as u32,
            pbData: key.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptProtectData(
                &input,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
            .expect("protect fixture key");
        }
        let protected =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
        unsafe {
            LocalFree(Some(HLOCAL(output.pbData as *mut _)));
        }
        let unwrapped = crypt_unprotect_data(&protected, CRYPTPROTECT_UI_FORBIDDEN)
            .expect("unprotect fixture key");
        assert_eq!(unwrapped, key);

        let nonce = [0x24_u8; 12];
        let cipher = Aes256Gcm::new_from_slice(&unwrapped).expect("fixture cipher");
        let ciphertext = cipher
            .encrypt((&nonce).into(), b"fixture-password".as_ref())
            .expect("encrypt fixture password");
        let mut v10 = b"v10".to_vec();
        v10.extend_from_slice(&nonce);
        v10.extend_from_slice(&ciphertext);
        assert_eq!(&v10[..3], b"v10");
        let decrypted = cipher
            .decrypt((&nonce).into(), &v10[15..])
            .expect("decrypt fixture password");
        assert_eq!(decrypted, b"fixture-password");
    }
}
