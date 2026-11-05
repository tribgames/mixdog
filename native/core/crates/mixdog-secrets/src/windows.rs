//! Windows: one DPAPI file per account, `<plugin data>/secrets/<account>.dpapi`, holding the base64
//! of `CryptProtectData(utf8 value, no entropy, current user)` — what Node's PowerShell
//! `ProtectedData.Protect(bytes, $null, CurrentUser)` writes and reads (`keychain-cjs.cjs` win32).
#![allow(clippy::disallowed_methods, reason = "every function runs as a durability-lane job")]

use std::path::Path;
use std::path::PathBuf;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_js::js_trim;
use mixdog_rt::DurabilityIo;
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB;
use windows_sys::Win32::Security::Cryptography::CRYPTPROTECT_UI_FORBIDDEN;
use windows_sys::Win32::Security::Cryptography::CryptProtectData;
use windows_sys::Win32::Security::Cryptography::CryptUnprotectData;

use super::SecretError;
use super::SecretStore;
use super::on_lane;

pub struct DpapiStore {
    dir: PathBuf,
    io: DurabilityIo,
}

impl DpapiStore {
    pub fn new(io: DurabilityIo, plugin_data: &Path) -> Self {
        Self { dir: plugin_data.join("secrets"), io }
    }
}

fn file(dir: &Path, account: &str) -> PathBuf {
    dir.join(format!("{account}.dpapi"))
}

/// The bytes of a blob Windows allocated, freed after the copy.
fn take(blob: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    // SAFETY: on success `pbData` points at `cbData` bytes that DPAPI allocated with LocalAlloc.
    let bytes = unsafe { std::slice::from_raw_parts(blob.pbData, blob.cbData as usize) }.to_vec();
    // SAFETY: the buffer came from LocalAlloc and is not used again.
    unsafe { LocalFree(blob.pbData.cast()) };
    bytes
}

fn protect(plain: &[u8]) -> Result<Vec<u8>, SecretError> {
    let input = CRYPT_INTEGER_BLOB { cbData: plain.len() as u32, pbData: plain.as_ptr().cast_mut() };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    // SAFETY: `input` borrows `plain` for the call; every optional argument is null.
    let ok = unsafe {
        CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
    };
    if ok == 0 {
        let code = std::io::Error::last_os_error().raw_os_error().unwrap_or_default();
        return Err(SecretError::new(format!("[keychain] DPAPI encrypt failed (error {code})")));
    }
    Ok(take(output))
}

fn unprotect(cipher: &[u8]) -> Result<Vec<u8>, SecretError> {
    let input = CRYPT_INTEGER_BLOB { cbData: cipher.len() as u32, pbData: cipher.as_ptr().cast_mut() };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    // SAFETY: `input` borrows `cipher` for the call; every optional argument is null.
    let ok = unsafe {
        CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
    };
    if ok == 0 {
        let code = std::io::Error::last_os_error().raw_os_error().unwrap_or_default();
        return Err(SecretError::new(format!("[keychain] DPAPI decrypt failed (error {code})")));
    }
    Ok(take(output))
}

fn read(dir: &Path, account: &str) -> Result<Option<String>, SecretError> {
    let path = file(dir, account);
    let text = match std::fs::read(&path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(SecretError::new(e.to_string())),
    };
    let encoded = js_trim(&text);
    if encoded.is_empty() {
        return Err(SecretError::new(format!("[keychain] DPAPI ciphertext file is empty: {}", path.display())));
    }
    // PowerShell's FromBase64String ignores nothing but surrounding whitespace, so does this.
    let cipher = STANDARD.decode(encoded).map_err(|e| SecretError::new(format!("[keychain] DPAPI decrypt failed: {e}")))?;
    let plain = String::from_utf8_lossy(&unprotect(&cipher)?).into_owned();
    // Node reads the host's stdout and trims it.
    let value = js_trim(&plain);
    if value.is_empty() {
        return Err(SecretError::new("[keychain] DPAPI decrypt returned empty output (stderr: )"));
    }
    Ok(Some(value.to_owned()))
}

fn write(dir: &Path, account: &str, value: &str) -> Result<(), SecretError> {
    let io = |e: std::io::Error| SecretError::new(e.to_string());
    std::fs::create_dir_all(dir).map_err(io)?;
    let encoded = STANDARD.encode(protect(value.as_bytes())?);
    let target = file(dir, account);
    let temporary = dir.join(format!(
        "{}.mixdog-tmp-{}-{:08x}",
        target.file_name().and_then(|n| n.to_str()).unwrap_or("secret"),
        std::process::id(),
        rand::random::<u32>()
    ));
    let written = (|| {
        use std::io::Write;
        let mut handle = std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        handle.write_all(encoded.as_bytes())?;
        handle.sync_all()?;
        std::fs::rename(&temporary, &target)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    written.map_err(io)
}

fn remove(dir: &Path, account: &str) -> Result<(), SecretError> {
    match std::fs::remove_file(file(dir, account)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(SecretError::new(e.to_string())),
    }
}

#[async_trait]
impl SecretStore for DpapiStore {
    async fn get(&self, account: &str) -> Result<Option<String>, SecretError> {
        let (dir, account) = (self.dir.clone(), account.to_owned());
        on_lane(self.io, move || read(&dir, &account)).await?
    }

    async fn set(&self, account: &str, value: &str) -> Result<(), SecretError> {
        let (dir, account, value) = (self.dir.clone(), account.to_owned(), value.to_owned());
        on_lane(self.io, move || write(&dir, &account, &value)).await?
    }

    async fn delete(&self, account: &str) -> Result<(), SecretError> {
        let (dir, account) = (self.dir.clone(), account.to_owned());
        on_lane(self.io, move || remove(&dir, &account)).await?
    }

    async fn has(&self, account: &str) -> bool {
        // `hasSecret` on Windows is the file's existence: no decryption.
        let path = file(&self.dir, account);
        on_lane(self.io, move || path.exists()).await.unwrap_or(false)
    }
}
