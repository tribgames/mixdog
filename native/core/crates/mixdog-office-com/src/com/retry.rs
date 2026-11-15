//! `Invoke-ExcelComRetry` and `Invoke-PowerPointComRetry` of `office-com-host.ps1`: an operation Office answered
//! busy is tried again, 50 attempts 100 ms apart.
//!
//! The helpers compare `$_.Exception.HResult`, the HResult of the exception PowerShell threw, which for a COM failure
//! is [`ComError::hresult`] (the wrapper's, see [`super::errtext::WRAPPED_HRESULT`]), not the COM code inside it. A
//! failure that is not in the list, and a text the host itself threw, goes out unchanged on the first attempt.

use std::time::Duration;

use super::ComError;
use super::Error;
use super::Result;

/// Attempts before the operation is reported busy.
pub const ATTEMPTS: u32 = 50;

/// The pause between attempts.
pub const PAUSE: Duration = Duration::from_millis(100);

/// The HResults `Invoke-ExcelComRetry` retries: `0x800AC472` (Excel is busy, for instance in a modal edit),
/// `RPC_E_CALL_REJECTED` and `RPC_E_SERVERCALL_RETRYLATER`.
pub const EXCEL_TRANSIENT: [i32; 3] = [-2_146_777_998, -2_147_418_111, -2_147_417_846];

/// The HResults `Invoke-PowerPointComRetry` retries.
pub const POWERPOINT_TRANSIENT: [i32; 2] = [-2_147_418_111, -2_147_417_846];

/// Where the pause between attempts comes from. The platform layer's clock is one (it pumps the apartment's messages
/// while it waits); the fake clock of the tests advances at once.
pub trait Pause {
    /// Waits `duration`.
    fn pause(&self, duration: Duration);
}

/// `Invoke-ExcelComRetry { operation } label additionalTransientHResults`.
pub fn excel<T>(pause: &dyn Pause, label: &str, additional: &[i32], operation: impl FnMut() -> Result<T>) -> Result<T> {
    let mut transient: Vec<i32> = EXCEL_TRANSIENT.to_vec();
    transient.extend_from_slice(additional);
    retry(pause, label, &transient, operation)
}

/// `Invoke-PowerPointComRetry { operation } label`.
pub fn powerpoint<T>(pause: &dyn Pause, label: &str, operation: impl FnMut() -> Result<T>) -> Result<T> {
    retry(pause, label, &POWERPOINT_TRANSIENT, operation)
}

fn retry<T>(pause: &dyn Pause, label: &str, transient: &[i32], mut operation: impl FnMut() -> Result<T>) -> Result<T> {
    let mut last_error = String::new();
    for _ in 0..ATTEMPTS {
        match operation() {
            Ok(value) => return Ok(value),
            Err(Error::Com(ComError { hresult, message, .. })) if transient.contains(&hresult) => {
                last_error = message;
                pause.pause(PAUSE);
            }
            Err(error) => return Err(error),
        }
    }
    Err(Error::host(format!("{label} remained busy after transient COM retries. Last error: {last_error}")))
}
