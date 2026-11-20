//! A failed `IDispatch::Invoke` as Windows PowerShell 5.1 reports it, and the texts the binder gives for the cases
//! that never reach COM.
//!
//! PowerShell's COM binder (the DLR ComInterop) turns an Invoke failure into an inner exception: `DISP_E_EXCEPTION`
//! becomes a `COMException` with the EXCEPINFO `bstrDescription` as its message (after `pfnDeferredFillIn`), any other
//! HRESULT what `Marshal.GetExceptionForHR` builds: the system's text for the HRESULT in the user language, then
//! ` (Exception from HRESULT: 0x%08X`, the symbolic name .NET knows for the code, and `)`. PowerShell wraps that in
//! `Exception calling "<Method>" with "<n>" argument(s): "<text>"`, `Exception getting "<Property>": "<text>"` or
//! `Exception setting "<Property>": "<text>"`; the wrapper is a `MethodInvocationException`,
//! `GetValueInvocationException` or `SetValueInvocationException`, a `SystemException` whose own `HResult` is
//! [`WRAPPED_HRESULT`], with the COM exception as its `InnerException`. The recorded corpus
//! (`tests/fixtures/errors/corpus.json`, made by `recorder/errors-corpus.ps1`) is what the unit tests hold these rules
//! to, and what decides them where the corpus and this file differ.

use super::ComError;
use super::DISP_E_MEMBERNOTFOUND;
use super::DISP_E_UNKNOWNNAME;
use super::Error;

/// `$_.Exception.HResult` of the PowerShell exception that wraps a COM failure (`COR_E_SYSTEM`, 0x80131501): the
/// retry helpers compare this value, not the COM code.
pub const WRAPPED_HRESULT: i32 = 0x8013_1501_u32 as i32;

/// The message of a method call on `$null`.
pub const NULL_METHOD_CALL: &str = "You cannot call a method on a null-valued expression.";

/// How the member was reached, which picks PowerShell's wording.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access<'a> {
    /// `$obj.Name(<argc> arguments)`.
    Method {
        /// The member.
        name: &'a str,
        /// The number of arguments PowerShell counted.
        argc: usize,
    },
    /// `$obj.Name`.
    Get {
        /// The member.
        name: &'a str,
    },
    /// `$obj.Name = value`.
    Set {
        /// The member.
        name: &'a str,
    },
}

/// What a failed Invoke gave.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Raw {
    /// The HRESULT: for `DISP_E_EXCEPTION` the EXCEPINFO scode (its `wCode` when the scode is 0), else Invoke's own.
    pub hresult: i32,
    /// EXCEPINFO `bstrDescription`, after `pfnDeferredFillIn`, when the member gave one.
    pub description: Option<String>,
}

/// The name .NET appends in `(Exception from HRESULT: 0x... (NAME))`.
pub fn symbolic_name(hresult: i32) -> Option<&'static str> {
    Some(match hresult as u32 {
        0x8001_0001 => "RPC_E_CALL_REJECTED",
        0x8001_0002 => "RPC_E_CALL_CANCELED",
        0x8001_0003 => "RPC_E_CANTPOST_INSENDCALL",
        0x8001_0004 => "RPC_E_CANTCALLOUT_INASYNCCALL",
        0x8001_0005 => "RPC_E_CANTCALLOUT_INEXTERNALCALL",
        0x8001_0006 => "RPC_E_CONNECTION_TERMINATED",
        0x8001_0007 => "RPC_E_SERVER_DIED",
        0x8001_0008 => "RPC_E_CLIENT_DIED",
        0x8001_0009 => "RPC_E_INVALID_DATAPACKET",
        0x8001_000A => "RPC_E_CANTTRANSMIT_CALL",
        0x8001_000B => "RPC_E_CLIENT_CANTMARSHAL_DATA",
        0x8001_000C => "RPC_E_CLIENT_CANTUNMARSHAL_DATA",
        0x8001_000D => "RPC_E_SERVER_CANTMARSHAL_DATA",
        0x8001_000E => "RPC_E_SERVER_CANTUNMARSHAL_DATA",
        0x8001_000F => "RPC_E_INVALID_DATA",
        0x8001_0010 => "RPC_E_INVALID_PARAMETER",
        0x8001_0011 => "RPC_E_CANTCALLOUT_AGAIN",
        0x8001_0012 => "RPC_E_SERVER_DIED_DNE",
        0x8001_0100 => "RPC_E_SYS_CALL_FAILED",
        0x8001_0101 => "RPC_E_OUT_OF_RESOURCES",
        0x8001_0102 => "RPC_E_ATTEMPTED_MULTITHREAD",
        0x8001_0103 => "RPC_E_NOT_REGISTERED",
        0x8001_0104 => "RPC_E_FAULT",
        0x8001_0105 => "RPC_E_SERVERFAULT",
        0x8001_0106 => "RPC_E_CHANGED_MODE",
        0x8001_0107 => "RPC_E_INVALIDMETHOD",
        0x8001_0108 => "RPC_E_DISCONNECTED",
        0x8001_0109 => "RPC_E_RETRY",
        0x8001_010A => "RPC_E_SERVERCALL_RETRYLATER",
        0x8001_010B => "RPC_E_SERVERCALL_REJECTED",
        0x8001_010C => "RPC_E_INVALID_CALLDATA",
        0x8001_010D => "RPC_E_CANTCALLOUT_ININPUTSYNCCALL",
        0x8001_010E => "RPC_E_WRONG_THREAD",
        0x8001_010F => "RPC_E_THREAD_NOT_INIT",
        0x8001_0110 => "RPC_E_VERSION_MISMATCH",
        0x8001_0111 => "RPC_E_INVALID_HEADER",
        0x8001_0112 => "RPC_E_INVALID_EXTENSION",
        0x8001_0113 => "RPC_E_INVALID_IPID",
        0x8001_0114 => "RPC_E_INVALID_OBJECT",
        0x8001_0115 => "RPC_S_CALLPENDING",
        0x8001_0116 => "RPC_S_WAITONTIMER",
        0x8001_0117 => "RPC_E_CALL_COMPLETE",
        0x8001_0118 => "RPC_E_UNSECURE_CALL",
        0x8001_0119 => "RPC_E_TOO_LATE",
        0x8001_011A => "RPC_E_NO_GOOD_SECURITY_PACKAGES",
        0x8001_011B => "RPC_E_ACCESS_DENIED",
        0x8001_011C => "RPC_E_REMOTE_DISABLED",
        0x8001_011D => "RPC_E_INVALID_OBJREF",
        0x8001_011E => "RPC_E_NO_CONTEXT",
        0x8001_011F => "RPC_E_TIMEOUT",
        0x8001_0120 => "RPC_E_NO_SYNC",
        0x8002_0001 => "DISP_E_UNKNOWNINTERFACE",
        0x8002_0003 => "DISP_E_MEMBERNOTFOUND",
        0x8002_0004 => "DISP_E_PARAMNOTFOUND",
        0x8002_0005 => "DISP_E_TYPEMISMATCH",
        0x8002_0006 => "DISP_E_UNKNOWNNAME",
        0x8002_0007 => "DISP_E_NONAMEDARGS",
        0x8002_0008 => "DISP_E_BADVARTYPE",
        0x8002_0009 => "DISP_E_EXCEPTION",
        0x8002_000A => "DISP_E_OVERFLOW",
        0x8002_000B => "DISP_E_BADINDEX",
        0x8002_000C => "DISP_E_UNKNOWNLCID",
        0x8002_000D => "DISP_E_ARRAYISLOCKED",
        0x8002_000E => "DISP_E_BADPARAMCOUNT",
        0x8002_000F => "DISP_E_PARAMNOTOPTIONAL",
        0x8002_0010 => "DISP_E_BADCALLEE",
        0x8002_0011 => "DISP_E_NOTACOLLECTION",
        0x8002_0012 => "DISP_E_DIVBYZERO",
        0x8002_0013 => "DISP_E_BUFFERTOOSMALL",
        0x8000_4005 => "E_FAIL",
        0x8004_0154 => "REGDB_E_CLASSNOTREG",
        0x8004_01E3 => "MK_E_UNAVAILABLE",
        0x8008_0005 => "CO_E_SERVER_EXEC_FAILURE",
        _ => return None,
    })
}

/// The exception `Marshal.GetExceptionForHR` builds for the codes .NET does not make a `COMException` of: the message
/// that exception carries.
fn mapped_message(hresult: i32) -> Option<&'static str> {
    Some(match hresult as u32 {
        0x8000_4001 => "The method or operation is not implemented.",
        0x8000_4003 => "Object reference not set to an instance of an object.",
        0x8007_0005 => "Access is denied.",
        0x8007_000E => "Insufficient memory to continue the execution of the program.",
        0x8007_0057 => "Value does not fall within the expected range.",
        0x8002_000A => "Arithmetic operation resulted in an overflow.",
        0x8002_0012 => "Attempted to divide by zero.",
        _ => return None,
    })
}

/// The text of the exception at the bottom of PowerShell's chain: the EXCEPINFO description, or what .NET makes of
/// the HRESULT with `system_text` (the system's message for it in the user language, trimmed) in `FormatMessage`'s
/// place.
pub fn inner_message(raw: &Raw, system_text: &dyn Fn(i32) -> Option<String>) -> String {
    if let Some(description) = &raw.description {
        return description.clone();
    }
    if let Some(text) = mapped_message(raw.hresult) {
        return text.to_owned();
    }
    let suffix = match symbolic_name(raw.hresult) {
        Some(name) => format!("Exception from HRESULT: 0x{:08X} ({name})", raw.hresult as u32),
        None => format!("Exception from HRESULT: 0x{:08X}", raw.hresult as u32),
    };
    match system_text(raw.hresult) {
        Some(text) if !text.is_empty() => format!("{text} ({suffix})"),
        _ => suffix,
    }
}

/// What PowerShell throws for a failed Invoke of the member.
pub fn com_error(access: Access<'_>, raw: &Raw, system_text: &dyn Fn(i32) -> Option<String>) -> ComError {
    let inner = inner_message(raw, system_text);
    let message = match access {
        Access::Method { name, argc } => format!("Exception calling \"{name}\" with \"{argc}\" argument(s): \"{inner}\""),
        Access::Get { name } => format!("Exception getting \"{name}\": \"{inner}\""),
        Access::Set { name } => format!("Exception setting \"{name}\": \"{inner}\""),
    };
    ComError { hresult: WRAPPED_HRESULT, inner_hresult: raw.hresult, message, inner_message: inner, unknown_member: false }
}

/// The failure of a member the object does not have (`GetIDsOfNames` answered `DISP_E_UNKNOWNNAME`, or `Invoke`
/// `DISP_E_MEMBERNOTFOUND`); the binder answers it by rule, see [`property_not_found`] and [`method_not_found`].
pub fn unknown_member(hresult: i32) -> ComError {
    debug_assert!(hresult == DISP_E_UNKNOWNNAME || hresult == DISP_E_MEMBERNOTFOUND);
    ComError {
        hresult,
        inner_hresult: hresult,
        message: inner_message(&Raw { hresult, description: None }, &|_| None),
        inner_message: String::new(),
        unknown_member: true,
    }
}

/// A property set on a value that has no such property (or on `$null`).
pub fn property_not_found(name: &str) -> Error {
    Error::host(format!("The property '{name}' cannot be found on this object. Verify that the property exists and can be set."))
}

/// A method called on a value that has no such method.
pub fn method_not_found(type_name: &str, name: &str) -> Error {
    Error::host(format!("Method invocation failed because [{type_name}] does not contain a method named '{name}'."))
}

/// A method called on `$null`.
pub fn null_method_call() -> Error {
    Error::host(NULL_METHOD_CALL)
}
