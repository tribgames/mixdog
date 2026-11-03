use std::io::{self, Read};
use std::path::{Path, PathBuf};

use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::Serialize;
use zeroize::Zeroizing;

mod abe_client;
mod cookies;
mod failure;
mod keys;
mod logins;
mod snapshot;

const MAX_KEY_INPUT_BYTES: u64 = 256;
const MAX_PROFILE_ID_LEN: usize = 120;

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

/// The GPL `runas` admin helper shipped beside the importer; absent in a dev
/// build, in which case the manual route reports it as unavailable.
fn admin_helper_path() -> Option<PathBuf> {
    let current = std::env::current_exe().ok()?;
    let helper = current
        .parent()?
        .join("bitwarden_chromium_import_helper.exe");
    helper.exists().then_some(helper)
}

fn upstream_browser_name(browser: &str) -> Option<&'static str> {
    match browser {
        "chrome" => Some("Chrome"),
        _ => None,
    }
}

fn has_flag(args: &[String], name: &str) -> bool {
    args.iter().any(|value| value == name)
}

/// One base64 line holding exactly 32 bytes, wiped on drop.
fn decode_key(line: &str) -> Result<Zeroizing<Vec<u8>>, ()> {
    let decoded = Zeroizing::new(BASE64_STANDARD.decode(line.trim()).map_err(|_| ())?);
    (decoded.len() == 32).then_some(decoded).ok_or(())
}

/// Stdin carries the transport key as its first line and, only with
/// `--v20-key-stdin`, a saved App-Bound key as its second. Keys never travel in
/// arguments or the environment.
fn read_stdin_keys(saved_key: bool) -> Result<([u8; 32], Option<Zeroizing<Vec<u8>>>), ()> {
    // Wiped on drop. Pre-sized to the read limit so reading never reallocates
    // and leaves an unwiped copy of the base64 key behind.
    let mut encoded = Zeroizing::new(String::with_capacity(MAX_KEY_INPUT_BYTES as usize));
    io::stdin()
        .take(MAX_KEY_INPUT_BYTES)
        .read_to_string(&mut encoded)
        .map_err(|_| ())?;
    parse_stdin_keys(&encoded, saved_key)
}

fn parse_stdin_keys(encoded: &str, saved_key: bool) -> Result<([u8; 32], Option<Zeroizing<Vec<u8>>>), ()> {
    let mut lines = encoded.lines();
    let transport = decode_key(lines.next().ok_or(())?)?;
    let saved = if saved_key {
        Some(decode_key(lines.next().ok_or(())?)?)
    } else {
        None
    };
    if lines.any(|line| !line.trim().is_empty()) {
        return Err(());
    }
    let mut key = [0_u8; 32];
    key.copy_from_slice(&transport);
    Ok((key, saved))
}

fn read_transport_key() -> Result<[u8; 32], ()> {
    read_stdin_keys(false).map(|(key, _)| key)
}

fn seal<T: Serialize>(key: [u8; 32], value: &T) -> Result<String, ()> {
    // Wiped on drop, so every early error return clears them too.
    let key = Zeroizing::new(key);
    let plaintext = Zeroizing::new(serde_json::to_vec(value).map_err(|_| ())?);
    let cipher = Aes256Gcm::new_from_slice(&key[..]).map_err(|_| ())?;
    let nonce = rand::random::<[u8; 12]>();
    let ciphertext = cipher
        .encrypt((&nonce).into(), plaintext.as_slice())
        .map_err(|_| ())?;
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
        // Lets the desktop detect a build that can reuse a saved App-Bound key;
        // an older build rejects the command.
        Some("capabilities") => {
            print!(r#"{{"savedAppBoundKey":1}}"#);
            std::process::exit(0);
        }
        _ => fail("Invalid importer command.", 2),
    }
}

/// Cheap structural checks only: non-empty, bounded, and exactly one normal
/// path component. Whether the id really names a directory directly inside
/// `User Data` is decided by canonicalization in
/// [`cookies::resolve_profile_dir`], which also covers `..`, drive tricks and
/// junctions.
fn valid_profile_id(value: &str) -> bool {
    let mut components = Path::new(value).components();
    !value.is_empty()
        && value.len() <= MAX_PROFILE_ID_LEN
        && matches!(components.next(), Some(std::path::Component::Normal(_)))
        && components.next().is_none()
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
        && profile.as_deref().is_some_and(valid_profile_id);
    if !valid {
        fail("Invalid importer arguments.", 2);
    }
    profile.unwrap_or_default()
}

async fn run_import_passwords(args: &[String]) -> ! {
    let profile = parse_common(args, "import-passwords");
    let key = read_transport_key().unwrap_or_else(|_| fail("Invalid importer transport key.", 2));
    let admin_exe_path = admin_helper_path();
    let route = keys::V20Route {
        admin_exe: admin_exe_path.as_deref().and_then(Path::to_str),
        saved_key: None,
        allow_elevation: true,
    };
    let key = Zeroizing::new(key);
    let outcome = match logins::import_chrome_logins(&profile, &route).await {
        Ok(credentials) => {
            let sealed = seal(*key, &credentials);
            drop(credentials);
            sealed.map_err(|_| "Chrome password import encryption failed.")
        }
        Err(error) => Err(failure::user_message(&error)),
    };
    // `process::exit` runs no destructors, so on success and failure alike the
    // key material is wiped before leaving.
    drop(route);
    drop(key);
    match outcome {
        Ok(envelope) => {
            print!("{envelope}");
            std::process::exit(0);
        }
        Err(message) => fail(message, 1),
    }
}

async fn run_import_cookies(args: &[String]) -> ! {
    let profile = parse_common(args, "import-cookies");
    let (key, saved_key) = read_stdin_keys(has_flag(args, "--v20-key-stdin"))
        .unwrap_or_else(|_| fail("Invalid importer transport key.", 2));
    let admin_exe_path = admin_helper_path();
    let route = keys::V20Route {
        admin_exe: admin_exe_path.as_deref().and_then(Path::to_str),
        saved_key: saved_key.as_deref().map(Vec::as_slice),
        // An automatic import passes --no-elevation: it never raises a UAC prompt.
        allow_elevation: !has_flag(args, "--no-elevation"),
    };
    let key = Zeroizing::new(key);
    let outcome =
        match cookies::import_chrome_cookies(&profile, &route, has_flag(args, "--return-v20-key"))
            .await
        {
            Ok(cookies) => {
                let sealed = seal(*key, &cookies);
                // Wipes the cookie values and any key grant.
                drop(cookies);
                sealed.map_err(|_| "Chrome cookie import encryption failed.")
            }
            Err(error) => Err(failure::user_message(&error)),
        };
    // `process::exit` runs no destructors, so on success and failure alike
    // (a rejected saved key included) the key material is wiped before leaving.
    drop(route);
    drop(saved_key);
    drop(key);
    match outcome {
        Ok(envelope) => {
            print!("{envelope}");
            std::process::exit(0);
        }
        Err(message) => fail(message, 1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::aead::Aead;

    #[test]
    fn profile_ids_must_be_a_single_plain_directory_name() {
        for good in ["Default", "Profile 1", "Guest Profile", "a.b", "..a"] {
            assert!(valid_profile_id(good), "expected {good:?} to be accepted");
        }
        // Structural rejects only; escapes that still look like one component
        // (junctions, trailing dots) are decided by canonicalization.
        for bad in [
            "",
            ".",
            "..",
            "a/b",
            "a\\b",
            "../Default",
            "..\\Default",
            "C:",
            "C:Users",
            "\\\\server\\share",
            "\\Default",
        ] {
            assert!(!valid_profile_id(bad), "expected {bad:?} to be rejected");
        }
        assert!(valid_profile_id(&"a".repeat(MAX_PROFILE_ID_LEN)));
        assert!(!valid_profile_id(&"a".repeat(MAX_PROFILE_ID_LEN + 1)));
    }

    #[test]
    fn stdin_carries_a_saved_key_only_when_the_flag_announces_it() {
        let transport = BASE64_STANDARD.encode([1_u8; 32]);
        let saved = BASE64_STANDARD.encode([2_u8; 32]);
        // The original single-key protocol is unchanged, with or without a newline.
        for text in [transport.clone(), format!("{transport}\n")] {
            let (key, none) = parse_stdin_keys(&text, false).expect("transport key");
            assert_eq!(key, [1_u8; 32]);
            assert!(none.is_none());
        }
        let (key, some) = parse_stdin_keys(&format!("{transport}\n{saved}"), true).expect("both keys");
        assert_eq!(key, [1_u8; 32]);
        assert_eq!(some.as_deref().map(Vec::as_slice), Some(&[2_u8; 32][..]));
        // A key that was announced must be present and well-formed; one that
        // was not announced must not appear.
        for (text, announced) in [
            (transport.clone(), true),
            (format!("{transport}\n"), true),
            (format!("{transport}\nnot-base64"), true),
            (format!("{transport}\n{}", BASE64_STANDARD.encode([2_u8; 16])), true),
            (format!("{transport}\n{saved}"), false),
            (format!("{transport}\n{saved}\n{saved}"), true),
            (String::new(), false),
        ] {
            assert!(parse_stdin_keys(&text, announced).is_err(), "{text:?} announced={announced}");
        }
    }

    #[test]
    fn maps_cli_chrome_to_the_upstream_browser_key() {
        assert_eq!(upstream_browser_name("chrome"), Some("Chrome"));
        assert_eq!(upstream_browser_name("Chrome"), None);
    }

    #[test]
    fn envelope_round_trip_keeps_plaintext_out_of_stdout() {
        let key = [7_u8; 32];
        let credentials = vec![logins::Credential {
            url: "https://example.test".to_string(),
            username: "fixture-user".to_string(),
            password: "fixture-secret".to_string(),
            note: String::new(),
            last_used_at: None,
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
