//! Authenticode verification of the image `install` stages as the SYSTEM
//! service binary.
//!
//! Consent model. The app launches this helper elevated with the `runas` verb,
//! so UAC shows the verified publisher of the exact binary it elevates, and
//! that prompt is the approving user's decision point — the standard model for
//! a per-user application that elevates its own executable. What runs elevated
//! is whatever image was approved; nothing inside that process can prove more
//! about the process itself, and this module does not claim to.
//!
//! What it closes is the gap *after* consent. A running image can be renamed
//! (though not written or deleted), so a user-level process could move the
//! approved exe aside and plant different bytes at its old path before the
//! elevated process opens "itself". `install` therefore never trusts a path:
//!
//! 1. It resolves the **current** name of its own mapped image
//!    (`GetMappedFileNameW` follows renames), opens that file sharing only
//!    read — denying writers and deleters; a rename needs delete access, so the
//!    held file can no longer change or move — and then resolves the image name
//!    again: unchanged, and equal to the handle's final path, means the held
//!    file *is* the running image.
//! 2. It verifies the held handle with `WinVerifyTrust` (Authenticode, chain to
//!    a Windows-trusted root, code-signing usage, timestamp) and takes the
//!    signer certificate from that same verification state.
//! 3. The signer must match the **release signer pin** compiled in at build
//!    time: the full subject DN and the signing-profile EKU ([`release_pin`]),
//!    and its chain (root excluded) must not be revoked — checked online with a
//!    bounded retrieval time; an undeterminable status is refused
//!    ([`check_revocation`]).
//! 4. The bytes staged into protected storage are read from that held handle —
//!    exactly the bytes that were verified.
//!
//! A build without a pin (local / development; only the release workflow sets
//! it) is refused before anything is opened. There is no override.

use std::mem::size_of;
use std::path::Path;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{GetLastError, FILETIME, HANDLE, HWND};
use windows::Win32::Security::Cryptography::{
    CertFreeCertificateChain, CertGetCertificateChain, CertGetEnhancedKeyUsage, CertNameToStrW,
    CERT_CHAIN_CONTEXT, CERT_CHAIN_PARA, CERT_CHAIN_REVOCATION_ACCUMULATIVE_TIMEOUT,
    CERT_CHAIN_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT, CERT_CONTEXT, CERT_FIND_EXT_ONLY_ENHKEY_USAGE_FLAG,
    CERT_NAME_STR_REVERSE_FLAG, CERT_STRING_TYPE, CERT_TRUST_IS_OFFLINE_REVOCATION, CERT_TRUST_IS_REVOKED,
    CERT_TRUST_REVOCATION_STATUS_UNKNOWN, CERT_X500_NAME_STR, CRYPT_INTEGER_BLOB, CTL_USAGE,
    X509_ASN_ENCODING,
};
use windows::Win32::Security::WinTrust::{
    WTHelperGetProvSignerFromChain, WTHelperProvDataFromStateData, WinVerifyTrust,
    WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_FILE_INFO, WTD_CHOICE_FILE,
    WINTRUST_DATA_PROVIDER_FLAGS, WTD_REVOCATION_CHECK_NONE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY,
    WTD_UI_NONE,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, GetFileSizeEx, GetFinalPathNameByHandleW, ReadFile, SetFilePointerEx,
    FILE_ATTRIBUTE_NORMAL, FILE_BEGIN, FILE_GENERIC_READ, FILE_NAME_NORMALIZED, FILE_SHARE_READ,
    GETFINALPATHNAMEBYHANDLE_FLAGS, OPEN_EXISTING, VOLUME_NAME_NT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::ProcessStatus::GetMappedFileNameW;
use windows::Win32::System::Threading::GetCurrentProcess;

use crate::winutil::{wide, OwnedHandle};

/// The release signer, pinned at build time by the release workflow
/// (`.github/workflows/desktop-package.yml`, read here with `option_env!`).
/// Artifact Signing renews the signing certificate daily (72 h validity), so a
/// thumbprint or key cannot be pinned. The subject DN is the publisher's
/// validated identity; the certificate-profile EKU (`1.3.6.1.4.1.311.97.<id>`)
/// is Microsoft's documented durable identity of every certificate one profile
/// issues. Both must match.
const PINNED_SUBJECT: Option<&str> = option_env!("MIXDOG_SECURE_DESKTOP_SIGNER_SUBJECT");
const PINNED_PROFILE_EKU: Option<&str> = option_env!("MIXDOG_SECURE_DESKTOP_SIGNER_EKU");
/// Artifact Signing's EKU arc, and the generic "public trust" marker every
/// Artifact Signing certificate carries (not a profile identity).
const ARTIFACT_SIGNING_EKU_PREFIX: &str = "1.3.6.1.4.1.311.97.";
const ARTIFACT_SIGNING_MARKER_EKU: &str = "1.3.6.1.4.1.311.97.1.0";

/// The refusal for a build that carries no pin.
pub const NO_PIN: &str = "this helper build has no release signer pin (a local or development build); \
only a signed Mixdog release can install the secure-desktop service";

/// The signer identity a release must carry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignerPin {
    subject: String,
    profile_eku: String,
}

/// A signer policy as a pair of strings, for storing in the install state (the
/// authorized app's subject DN and Artifact Signing profile EKU) and verifying
/// an arbitrary image against it ([`verify_file_against`]). Decoupled from
/// [`SignerPin`] so `security.rs` can serialize it without this module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignerPolicy {
    pub subject: String,
    pub profile_eku: String,
}

/// The signer of a verified image: its subject DN (X.500, most specific RDN
/// first — the same form `Get-AuthenticodeSignature` prints) and its EKUs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignerIdentity {
    pub subject: String,
    pub ekus: Vec<String>,
}

/// The verified image, held open against writers/deleters, with its bytes and
/// signer. Dropping it releases the file, so the caller keeps it alive until
/// the protected copy has been written.
pub struct VerifiedSource {
    _handle: OwnedHandle,
    pub bytes: Vec<u8>,
    pub subject: String,
}

/// Why an image was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// Not a pinned, validly signed, unrevoked release image (or it moved).
    Untrusted(String),
    /// Revocation could not be determined (no CRL/OCSP answer in time).
    RevocationUnknown(String),
}

impl Refusal {
    pub fn message(&self) -> &str {
        match self {
            Refusal::Untrusted(message) | Refusal::RevocationUnknown(message) => message,
        }
    }
}

impl From<String> for Refusal {
    fn from(message: String) -> Self {
        Refusal::Untrusted(message)
    }
}

/// Open `path` for reading while denying other writers and deleters, so its
/// bytes cannot change or be swapped (rename needs delete access) while held.
fn open_denying_writers(path: &Path) -> Result<OwnedHandle, String> {
    let wide_path = wide(&path.to_string_lossy());
    let handle = unsafe {
        CreateFileW(
            PCWSTR(wide_path.as_ptr()),
            FILE_GENERIC_READ.0,
            FILE_SHARE_READ,
            None,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
    }
    .map_err(|error| format!("open source image {}: {error}", path.display()))?;
    OwnedHandle::new(handle)
        .ok_or_else(|| format!("open source image {}: invalid handle", path.display()))
}

/// Read the whole file behind an open handle, from the start (verification
/// reads through the same handle and moves its file pointer). The helper is a
/// few MiB, so the size is bounded well under a sane ceiling before allocating.
fn read_all(handle: &OwnedHandle, label: &str) -> Result<Vec<u8>, String> {
    unsafe { SetFilePointerEx(handle.get(), 0, None, FILE_BEGIN) }
        .map_err(|error| format!("rewind {label}: {error}"))?;
    let mut size: i64 = 0;
    unsafe { GetFileSizeEx(handle.get(), &mut size) }
        .map_err(|error| format!("size {label}: {error}"))?;
    if !(0..=256 * 1024 * 1024).contains(&size) {
        return Err(format!("{label} has an implausible size ({size} bytes)"));
    }
    let mut buffer = vec![0u8; size as usize];
    let mut offset = 0usize;
    while offset < buffer.len() {
        let mut read = 0u32;
        unsafe { ReadFile(handle.get(), Some(&mut buffer[offset..]), Some(&mut read), None) }
            .map_err(|error| format!("read {label}: {error}"))?;
        if read == 0 {
            return Err(format!("{label} ended early ({offset} of {} bytes)", buffer.len()));
        }
        offset += read as usize;
    }
    Ok(buffer)
}

/// Verify the Authenticode signature of the held file, require its signer to be
/// the pinned release signer, and check that signer's chain for revocation.
/// The open handle is passed, so what is verified is exactly the locked file,
/// and the signer certificate comes from that same verification state rather
/// than from a second parse of a path. Returns the signer's subject.
fn verify_signed_handle(path: &str, handle: &OwnedHandle, pin: &SignerPin) -> Result<String, Refusal> {
    let wide_path = wide(path);
    let mut file_info = WINTRUST_FILE_INFO {
        cbStruct: size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: PCWSTR(wide_path.as_ptr()),
        hFile: handle.get(),
        pgKnownSubject: std::ptr::null_mut(),
    };
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    let mut data = WINTRUST_DATA {
        cbStruct: size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        dwStateAction: WTD_STATEACTION_VERIFY,
        dwProvFlags: wintrust_provider_flags(),
        ..Default::default()
    };
    data.Anonymous.pFile = &mut file_info;
    let status =
        unsafe { WinVerifyTrust(HWND(std::ptr::null_mut()), &mut action, &mut data as *mut _ as *mut _) };
    // The signer certificate lives in the provider state: use it before CLOSE.
    let verdict = if status == 0 {
        verify_signer(data.hWVTStateData, pin)
    } else {
        Err(Refusal::Untrusted(format!(
            "{path} is not validly signed (Authenticode status 0x{:08x})",
            status as u32
        )))
    };
    // Always release the provider state, whatever the verdict.
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    unsafe {
        WinVerifyTrust(HWND(std::ptr::null_mut()), &mut action, &mut data as *mut _ as *mut _);
    }
    verdict
}

/// The primary signer of a successful verification: its leaf certificate and
/// the time its signature is verified as of (the timestamp time when the
/// signature is countersigned, as release signatures are).
fn signer_from_state(state: HANDLE) -> Result<(*const CERT_CONTEXT, FILETIME), String> {
    let provider = unsafe { WTHelperProvDataFromStateData(state) };
    if provider.is_null() {
        return Err("Authenticode verification left no provider data".into());
    }
    let signer = unsafe { WTHelperGetProvSignerFromChain(provider, 0, false, 0) };
    if signer.is_null() {
        return Err("Authenticode verification found no signer".into());
    }
    let signer = unsafe { &*signer };
    if signer.csCertChain == 0 || signer.pasCertChain.is_null() {
        return Err("the Authenticode signer has no certificate chain".into());
    }
    let cert = unsafe { (*signer.pasCertChain).pCert };
    if cert.is_null() {
        return Err("the Authenticode signer has no certificate".into());
    }
    Ok((cert, signer.sftVerifyAsOf))
}

/// The signer must be the pinned release signer (checked first: offline and
/// cheap), and its chain must not be revoked.
fn verify_signer(state: HANDLE, pin: &SignerPin) -> Result<String, Refusal> {
    let (cert, verified_as_of) = signer_from_state(state)?;
    let signer = SignerIdentity { subject: cert_subject_dn(cert)?, ekus: cert_ekus(cert)? };
    check_signer(&signer, pin)?;
    check_revocation(cert, &verified_as_of)?;
    Ok(signer.subject)
}

/// Cumulative ceiling for every online revocation retrieval (CRL / OCSP) of
/// one check: Windows' own default "path validation cumulative retrieval
/// timeout" of 20 seconds (Certificate Path Validation Settings > Network
/// Retrieval, registry `ChainRevAccumulativeUrlRetrievalTimeoutMilliseconds`;
/// Microsoft Learn ff627826, "Change Timeout on Certification Path Validation
/// Settings"), used as written with `CERT_CHAIN_REVOCATION_ACCUMULATIVE_TIMEOUT`.
/// It is also the value *CertGetCertificateChain* documents for
/// `CERT_CHAIN_REVOCATION_ACCUMULATIVE_TIMEOUT` without a caller value: "the
/// maximum cumulative timeout is set, by default, to 20 seconds".
pub const REVOCATION_RETRIEVAL_TIMEOUT_MS: u32 = 20_000;

/// Windows' default per-URL retrieval timeout: the limit on each single
/// network retrieval of chain building that no caller value overrides — AIA
/// issuer certificates, Microsoft's automatic root update (the Microsoft
/// Identity Verification root) and the platform CTL cabs — in both
/// `WinVerifyTrust`'s Authenticode chain and the intermediate fetches of
/// [`check_revocation`]'s chain. It is a configurable policy value (Group
/// Policy can change it on a machine), not set by this crate, and it limits
/// one retrieval at a time — not the whole `WinVerifyTrust` operation, which
/// may make several. Recorded here so the default is named and tested:
/// - Microsoft Learn, *CertGetCertificateChain*: "each revocation URL is
///   assigned a maximum default timeout of 15 seconds", and among the
///   recommendations "Enable network retrievals for CRLs, OCSP, AIA issuers
///   and Windows platform CTL cabs and Third Party roots … Reduce the maximum
///   time allowed for each network retrieval from 15 to 10 seconds" — i.e. 15 s
///   per retrieval by default; "You can set the default values by using Group
///   Policy";
/// - Microsoft Learn ee619786 (*Appendix A: Managing OCSP Settings with Group
///   Policy*) and *Authority Information Access in Windows*: Public Key
///   Policies > Certificate Path Validation Settings > Network Retrieval,
///   "Default URL retrieval timeout" 15 s, with "Allow issuer certificate (AIA)
///   retrieval during path validation" — the machine-wide chain-engine policy
///   every chain build uses, `WinVerifyTrust`'s included (its *WINTRUST_DATA*
///   doc: without `WTD_CACHE_ONLY_URL_RETRIEVAL` it does network retrieval
///   "when verifying code signatures").
#[cfg_attr(not(test), allow(dead_code))]
pub const WINDOWS_DEFAULT_URL_RETRIEVAL_TIMEOUT_MS: u32 = 15_000;

/// `WinVerifyTrust`'s provider flags: no revocation there
/// (`WTD_REVOCATION_CHECK_NONE`; revocation is the separate, bounded chain step
/// below). Deliberately **not** `WTD_CACHE_ONLY_URL_RETRIEVAL`: on a fresh PC
/// Windows fetches the Microsoft Identity Verification root or an intermediate
/// on demand (automatic root update / AIA), and cache-only would refuse a
/// genuine Mixdog install there. Each such fetch is subject to Windows' default
/// per-URL retrieval timeout ([`WINDOWS_DEFAULT_URL_RETRIEVAL_TIMEOUT_MS`]).
pub fn wintrust_provider_flags() -> WINTRUST_DATA_PROVIDER_FLAGS {
    WTD_REVOCATION_CHECK_NONE
}

/// `CertGetCertificateChain` flags of the revocation step: revocation for the
/// whole chain except the root, under the cumulative revocation timeout. No
/// cache-only or AIA-disabling flag, so each of the chain's own fetches keeps
/// Windows' default per-URL retrieval timeout.
fn revocation_chain_flags() -> u32 {
    CERT_CHAIN_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT | CERT_CHAIN_REVOCATION_ACCUMULATIVE_TIMEOUT
}

/// The refusal when revocation could not be determined.
pub const REVOCATION_UNKNOWN: &str = "could not check certificate revocation (offline?)";

/// Check the signer's chain for revocation. `WinVerifyTrust` above runs with
/// `WTD_REVOKE_NONE` because WinTrust offers no per-call bound on revocation
/// retrieval; this builds the chain again with `CertGetCertificateChain` and:
/// - `CERT_CHAIN_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT` — check every certificate
///   in the chain except the self-signed root;
/// - `CERT_CHAIN_PARA.dwUrlRetrievalTimeout` with
///   `CERT_CHAIN_REVOCATION_ACCUMULATIVE_TIMEOUT` — "the value you specify in
///   dwUrlRetrievalTimeout represents the cumulative timeout across all
///   revocation URL retrievals" (Microsoft Learn, *CertGetCertificateChain*);
/// - `pTime` = the signature's verified-as-of (timestamp) time, which "is used
///   to determine whether a certificate listed in a CRL has been revoked" (the
///   CRL itself must be current), so the daily-renewed, since-expired signing
///   certificate is judged as of when it signed.
/// The aggregate `TrustStatus.dwErrorStatus` then decides ([`revocation_verdict`]);
/// a revoked or undeterminable status is never accepted.
fn check_revocation(cert: *const CERT_CONTEXT, verified_as_of: &FILETIME) -> Result<(), Refusal> {
    let para = CERT_CHAIN_PARA {
        cbSize: size_of::<CERT_CHAIN_PARA>() as u32,
        dwUrlRetrievalTimeout: REVOCATION_RETRIEVAL_TIMEOUT_MS,
        ..Default::default()
    };
    let mut chain: *mut CERT_CHAIN_CONTEXT = std::ptr::null_mut();
    unsafe {
        CertGetCertificateChain(
            None,
            cert,
            Some(verified_as_of as *const FILETIME),
            Some((*cert).hCertStore),
            &para,
            revocation_chain_flags(),
            None,
            &mut chain,
        )
    }
    .map_err(|error| Refusal::RevocationUnknown(format!("{REVOCATION_UNKNOWN}: build the signer chain: {error}")))?;
    let error_status = unsafe { (*chain).TrustStatus.dwErrorStatus };
    unsafe { CertFreeCertificateChain(chain) };
    revocation_verdict(error_status)
}

/// Decide from a chain's aggregate error status: revoked anywhere is a refusal,
/// and so is a status that could not be determined (offline / unknown). Other
/// bits (time validity of the expired daily certificate, trust) are
/// `WinVerifyTrust`'s verdict above, not revocation's. Pure; unit-tested.
fn revocation_verdict(error_status: u32) -> Result<(), Refusal> {
    if error_status & CERT_TRUST_IS_REVOKED != 0 {
        return Err(Refusal::Untrusted(
            "the image's signing certificate, or one of its issuers, has been revoked".into(),
        ));
    }
    if error_status & (CERT_TRUST_REVOCATION_STATUS_UNKNOWN | CERT_TRUST_IS_OFFLINE_REVOCATION) != 0 {
        return Err(Refusal::RevocationUnknown(REVOCATION_UNKNOWN.into()));
    }
    Ok(())
}

/// A certificate's subject as an X.500 DN, most specific RDN first
/// (`CN=…, O=…, L=…, S=…, C=…`), values with separators quoted.
fn cert_subject_dn(cert: *const CERT_CONTEXT) -> Result<String, String> {
    let info = unsafe { (*cert).pCertInfo };
    if info.is_null() {
        return Err("the signer certificate has no subject".into());
    }
    let name = unsafe { &(*info).Subject as *const CRYPT_INTEGER_BLOB };
    let format = CERT_STRING_TYPE(CERT_X500_NAME_STR.0 | CERT_NAME_STR_REVERSE_FLAG);
    let length = unsafe { CertNameToStrW(X509_ASN_ENCODING, name, format, None) };
    if length <= 1 {
        return Err("the signer certificate has an empty subject".into());
    }
    let mut buffer = vec![0u16; length as usize];
    let written = unsafe { CertNameToStrW(X509_ASN_ENCODING, name, format, Some(&mut buffer)) } as usize;
    let end = buffer[..written.min(buffer.len())].iter().position(|&c| c == 0).unwrap_or(written);
    Ok(String::from_utf16_lossy(&buffer[..end]))
}

/// The EKU OIDs in a certificate's enhanced-key-usage extension.
fn cert_ekus(cert: *const CERT_CONTEXT) -> Result<Vec<String>, String> {
    let flags = CERT_FIND_EXT_ONLY_ENHKEY_USAGE_FLAG.0;
    let mut size = 0u32;
    unsafe { CertGetEnhancedKeyUsage(cert, flags, None, &mut size) }
        .map_err(|error| format!("read the signer certificate's key usages: {error}"))?;
    // u64 storage keeps the CTL_USAGE header and its pointer array aligned.
    let mut buffer = vec![0u64; (size as usize).div_ceil(size_of::<u64>())];
    let usage = buffer.as_mut_ptr() as *mut CTL_USAGE;
    unsafe { CertGetEnhancedKeyUsage(cert, flags, Some(usage), &mut size) }
        .map_err(|error| format!("read the signer certificate's key usages: {error}"))?;
    let usage = unsafe { &*usage };
    (0..usage.cUsageIdentifier as usize)
        .map(|index| {
            unsafe { (*usage.rgpszUsageIdentifier.add(index)).to_string() }
                .map_err(|error| format!("a signer key usage is not an OID string: {error}"))
        })
        .collect()
}

/// Whether `eku` is an Artifact Signing certificate-profile EKU: under the
/// Artifact Signing arc, all-numeric, and not the generic public-trust marker
/// that every Artifact Signing certificate carries.
fn is_profile_eku(eku: &str) -> bool {
    eku != ARTIFACT_SIGNING_MARKER_EKU
        && eku.strip_prefix(ARTIFACT_SIGNING_EKU_PREFIX).is_some_and(|rest| {
            !rest.is_empty() && rest.split('.').all(|arc| !arc.is_empty() && arc.bytes().all(|b| b.is_ascii_digit()))
        })
}

/// The pin from its two build-time parts: both or neither (neither = an
/// unpinned local/dev build), and the EKU must be a real profile EKU.
fn pin_from(subject: Option<&str>, profile_eku: Option<&str>) -> Result<SignerPin, String> {
    let subject = subject.map(str::trim).filter(|value| !value.is_empty());
    let profile_eku = profile_eku.map(str::trim).filter(|value| !value.is_empty());
    match (subject, profile_eku) {
        (None, None) => Err(NO_PIN.into()),
        (Some(subject), Some(profile_eku)) if is_profile_eku(profile_eku) => {
            Ok(SignerPin { subject: subject.to_string(), profile_eku: profile_eku.to_string() })
        }
        (Some(_), Some(profile_eku)) => Err(format!(
            "the release signer pin's EKU {profile_eku:?} is not an Artifact Signing certificate-profile EKU"
        )),
        _ => Err("the release signer pin is incomplete (it needs both the subject and the profile EKU)".into()),
    }
}

/// This build's release signer pin, or why it has none.
pub fn release_pin() -> Result<SignerPin, String> {
    pin_from(PINNED_SUBJECT, PINNED_PROFILE_EKU)
}

/// This build's release signer as a storable [`SignerPolicy`]: the authorized
/// app delegation records this at the elevated opt-in, because the Mixdog app
/// and this helper share the one release signer. An unpinned build has none.
pub fn release_signer_policy() -> Result<SignerPolicy, String> {
    let pin = release_pin()?;
    Ok(SignerPolicy { subject: pin.subject, profile_eku: pin.profile_eku })
}

/// Verify an image against a stored [`SignerPolicy`] (the delegated app's
/// recorded signer) rather than this build's compile-time pin: full
/// Authenticode + chain + revocation, and the signer must match the policy's
/// subject DN and carry its profile EKU. Used by the service to authenticate
/// the calling EXE on the delegation pipe. The handle is held against
/// writers/deleters across the check, so the bytes verified are the image's.
pub fn verify_file_against(path: &Path, policy: &SignerPolicy) -> Result<VerifiedSource, Refusal> {
    let pin = pin_from(Some(&policy.subject), Some(&policy.profile_eku))?;
    let handle = open_denying_writers(path)?;
    verify_held(&path.to_string_lossy(), handle, &pin)
}

/// The verified signer must be the pinned release signer: the exact subject DN
/// and the signing-profile EKU.
fn check_signer(signer: &SignerIdentity, pin: &SignerPin) -> Result<(), String> {
    if signer.subject != pin.subject {
        return Err(format!(
            "the image is signed by {:?}, not the pinned release publisher {:?}",
            signer.subject, pin.subject
        ));
    }
    if !signer.ekus.iter().any(|eku| eku == &pin.profile_eku) {
        return Err(format!(
            "the image's signing certificate lacks the pinned signing-profile EKU {}",
            pin.profile_eku
        ));
    }
    Ok(())
}

/// The NT path (`\Device\HarddiskVolumeN\…`) the running image is mapped from,
/// as it is named *now*: the mapping follows the file through renames.
fn own_image_name() -> Result<String, String> {
    let module =
        unsafe { GetModuleHandleW(PCWSTR::null()) }.map_err(|error| format!("locate the running image: {error}"))?;
    let mut buffer = vec![0u16; 32 * 1024];
    let length = unsafe { GetMappedFileNameW(GetCurrentProcess(), module.0 as *const core::ffi::c_void, &mut buffer) };
    if length == 0 {
        return Err(format!("resolve the running image's name (error {})", unsafe { GetLastError() }.0));
    }
    Ok(String::from_utf16_lossy(&buffer[..length as usize]))
}

/// The NT path an open handle resolves to.
fn final_nt_path(handle: &OwnedHandle) -> Result<String, String> {
    let mut buffer = vec![0u16; 32 * 1024];
    let flags = GETFINALPATHNAMEBYHANDLE_FLAGS(FILE_NAME_NORMALIZED.0 | VOLUME_NAME_NT.0);
    let length = unsafe { GetFinalPathNameByHandleW(handle.get(), &mut buffer, flags) } as usize;
    if length == 0 || length >= buffer.len() {
        return Err(format!("resolve the held image's path (error {})", unsafe { GetLastError() }.0));
    }
    Ok(String::from_utf16_lossy(&buffer[..length]))
}

/// The held file is the running image when the image kept the name it was
/// opened by across the open (the held file can no longer move, so that name
/// is now pinned to it) and the handle resolves to that same name. Pure;
/// unit-tested.
fn held_file_is_image(opened: &str, image_after_open: &str, held_final: &str) -> bool {
    opened == image_after_open && held_final.to_lowercase() == opened.to_lowercase()
}

/// Verify the held file against the pin and read its bytes through the same
/// handle.
fn verify_held(path: &str, handle: OwnedHandle, pin: &SignerPin) -> Result<VerifiedSource, Refusal> {
    let subject = verify_signed_handle(path, &handle, pin)?;
    let bytes = read_all(&handle, "source image")?;
    Ok(VerifiedSource { _handle: handle, bytes, subject })
}

/// Verify the running image — the bytes `install` stages — and hold it open.
pub fn verify_own_image() -> Result<VerifiedSource, Refusal> {
    let pin = release_pin()?;
    let image = own_image_name()?;
    let open_path = format!(r"\\?\GLOBALROOT{image}");
    let handle = open_denying_writers(Path::new(&open_path))?;
    let after = own_image_name()?;
    let held = final_nt_path(&handle)?;
    if !held_file_is_image(&image, &after, &held) {
        return Err(Refusal::Untrusted(format!(
            "the running image moved while it was being opened ({image} became {after}, held {held}); refusing it"
        )));
    }
    verify_held(&open_path, handle, &pin)
}

/// Verify an arbitrary file against this build's pin (the diagnostic
/// `verify-image <path>`); never staged.
pub fn verify_file(path: &Path) -> Result<VerifiedSource, Refusal> {
    let pin = release_pin()?;
    let handle = open_denying_writers(path)?;
    verify_held(&path.to_string_lossy(), handle, &pin)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUBJECT: &str = r#"CN=TRIBGAMES, O=TRIBGAMES, L="Suji-gu, Yongin-si", S=Gyeonggi, C=KR"#;
    const PROFILE: &str = "1.3.6.1.4.1.311.97.242221699.625311035.127201735.767223184";

    fn signer(subject: &str, ekus: &[&str]) -> SignerIdentity {
        SignerIdentity { subject: subject.into(), ekus: ekus.iter().map(|e| e.to_string()).collect() }
    }

    #[test]
    fn an_unpinned_build_is_refused_and_a_partial_pin_is_an_error() {
        assert_eq!(pin_from(None, None), Err(NO_PIN.into()));
        assert_eq!(pin_from(Some("  "), Some("")), Err(NO_PIN.into()));
        assert!(pin_from(Some(SUBJECT), None).unwrap_err().contains("incomplete"));
        assert!(pin_from(None, Some(PROFILE)).unwrap_err().contains("incomplete"));
        assert!(pin_from(Some(SUBJECT), Some(PROFILE)).is_ok());
    }

    #[test]
    fn only_a_certificate_profile_eku_is_accepted_as_the_pin() {
        assert!(is_profile_eku(PROFILE));
        // The generic Artifact Signing marker every certificate carries, code
        // signing itself, a bare prefix, and malformed arcs identify nobody.
        assert!(!is_profile_eku(ARTIFACT_SIGNING_MARKER_EKU));
        assert!(!is_profile_eku("1.3.6.1.5.5.7.3.3"));
        assert!(!is_profile_eku(ARTIFACT_SIGNING_EKU_PREFIX));
        assert!(!is_profile_eku("1.3.6.1.4.1.311.97.12..3"));
        assert!(!is_profile_eku("1.3.6.1.4.1.311.97.12a"));
        assert!(pin_from(Some(SUBJECT), Some("1.3.6.1.5.5.7.3.3")).unwrap_err().contains("not an Artifact"));
    }

    #[test]
    fn the_signer_must_match_the_full_subject_and_carry_the_profile_eku() {
        let pin = pin_from(Some(SUBJECT), Some(PROFILE)).unwrap();
        let release = [ARTIFACT_SIGNING_MARKER_EKU, "1.3.6.1.5.5.7.3.3", PROFILE];
        assert_eq!(check_signer(&signer(SUBJECT, &release), &pin), Ok(()));
        // Same CN, different DN (another organisation's validated identity).
        let other_dn = r#"CN=TRIBGAMES, O=Someone Else, L=Seoul, C=KR"#;
        assert!(check_signer(&signer(other_dn, &release), &pin).unwrap_err().contains("not the pinned"));
        // Another Artifact Signing profile with a copied subject.
        let other_profile = [ARTIFACT_SIGNING_MARKER_EKU, "1.3.6.1.5.5.7.3.3", "1.3.6.1.4.1.311.97.1.2.3.4"];
        assert!(check_signer(&signer(SUBJECT, &other_profile), &pin).unwrap_err().contains("EKU"));
        // The DN comparison is exact, not a display-name or case-folded match.
        let folded = SUBJECT.to_lowercase();
        assert!(check_signer(&signer(&folded, &release), &pin).is_err());
    }

    #[test]
    fn chain_building_keeps_windows_network_retrieval_and_its_default_bound() {
        use windows::Win32::Security::Cryptography::{
            CERT_CHAIN_CACHE_ONLY_URL_RETRIEVAL, CERT_CHAIN_DISABLE_AIA, CERT_CHAIN_REVOCATION_CHECK_CACHE_ONLY,
        };
        // The revocation chain checks the whole chain except the root under
        // the cumulative revocation bound, and never forbids fetching an
        // intermediate, a root or a CRL/OCSP answer.
        let flags = revocation_chain_flags();
        assert_ne!(flags & CERT_CHAIN_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT, 0);
        assert_ne!(flags & CERT_CHAIN_REVOCATION_ACCUMULATIVE_TIMEOUT, 0);
        for forbidden in [CERT_CHAIN_CACHE_ONLY_URL_RETRIEVAL, CERT_CHAIN_DISABLE_AIA, CERT_CHAIN_REVOCATION_CHECK_CACHE_ONLY] {
            assert_eq!(flags & forbidden, 0);
        }
        // WinVerifyTrust: no revocation of its own and not cache-only.
        assert_eq!(wintrust_provider_flags(), WTD_REVOCATION_CHECK_NONE);
    }

    #[test]
    fn revocation_is_accepted_only_when_determined_and_clean() {
        assert_eq!(revocation_verdict(0), Ok(()));
        // The since-expired daily certificate's time validity is not a
        // revocation verdict (WinVerifyTrust judged it against the timestamp).
        const CERT_TRUST_IS_NOT_TIME_VALID: u32 = 0x1;
        assert_eq!(revocation_verdict(CERT_TRUST_IS_NOT_TIME_VALID), Ok(()));
        // Revoked anywhere in the chain is refused as untrusted…
        let revoked = revocation_verdict(CERT_TRUST_IS_REVOKED).unwrap_err();
        assert!(matches!(revoked, Refusal::Untrusted(_)));
        assert!(revoked.message().contains("revoked"));
        // …even when the status of another element is also unknown.
        assert!(matches!(
            revocation_verdict(CERT_TRUST_IS_REVOKED | CERT_TRUST_REVOCATION_STATUS_UNKNOWN),
            Err(Refusal::Untrusted(_))
        ));
        // Unknown or offline is never silently accepted.
        for status in [
            CERT_TRUST_REVOCATION_STATUS_UNKNOWN,
            CERT_TRUST_IS_OFFLINE_REVOCATION,
            CERT_TRUST_REVOCATION_STATUS_UNKNOWN | CERT_TRUST_IS_OFFLINE_REVOCATION,
        ] {
            assert_eq!(revocation_verdict(status), Err(Refusal::RevocationUnknown(REVOCATION_UNKNOWN.into())));
        }
    }

    #[test]
    fn the_held_file_is_the_image_only_when_the_image_did_not_move() {
        let name = r"\Device\HarddiskVolume3\Users\u\AppData\Local\Programs\mixdog-desktop\resources\native-tools\mixdog-secure-desktop.exe";
        assert!(held_file_is_image(name, name, name));
        // The final path may differ only in letter case.
        assert!(held_file_is_image(name, name, &name.to_uppercase()));
        // The running image was renamed away and something else opened at its
        // old name: the image's current name no longer matches.
        let moved = name.replace("mixdog-secure-desktop.exe", "moved.exe");
        assert!(!held_file_is_image(name, &moved, name));
        // The open resolved somewhere else (a redirected path component).
        assert!(!held_file_is_image(name, name, r"\Device\HarddiskVolume3\Users\u\planted.exe"));
    }
}
