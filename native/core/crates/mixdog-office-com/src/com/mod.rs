//! The late-bound COM layer every Office port calls: a handle over an `IDispatch` object whose members are reached by
//! name, with the argument, result and error behaviour of Windows PowerShell 5.1's COM binder (the layer the
//! PowerShell hosts relied on), and no knowledge of Office.
//!
//! * [`value`]: the [`Value`] a call takes and answers (a VARIANT kept at its exact type) and `Value::Missing`.
//! * [`safearray`]: 1-D and 2-D SAFEARRAYs of VARIANT with their lower bounds.
//! * [`obj`]: the [`Obj`] handle (`get`, `put`, `put_ref`, `call`, `call_named`, `enumerate`) and the binder's rules for
//!   a null receiver and a member that does not exist.
//! * [`errtext`]: a failed Invoke turned into the text and HRESULTs PowerShell's exception shows.
//! * [`retry`]: `Invoke-ExcelComRetry` and `Invoke-PowerPointComRetry`.
//! * [`calllog`]: the recording format; `live` (Windows) is the backend over `IDispatch`; `fake` (tests) is a backend
//!   that replays a recording.
//!
//! The handle is `!Send`: a COM object stays on the apartment thread that made it.

pub mod calllog;
pub mod errtext;
#[cfg(any(test, feature = "test-support"))]
pub mod fake;
#[cfg(windows)]
pub mod live;
pub mod obj;
pub mod retry;
pub mod safearray;
pub mod value;

use std::any::Any;
use std::fmt;

pub use obj::Enumeration;
pub use obj::Obj;
pub use safearray::Dim;
pub use safearray::SafeArray;
pub use value::Decimal;
pub use value::Value;

/// `IDispatch::Invoke` flag.
pub const DISPATCH_METHOD: u32 = 1;
/// `IDispatch::Invoke` flag.
pub const DISPATCH_PROPERTYGET: u32 = 2;
/// `IDispatch::Invoke` flag.
pub const DISPATCH_PROPERTYPUT: u32 = 4;
/// `IDispatch::Invoke` flag.
pub const DISPATCH_PROPERTYPUTREF: u32 = 8;

/// The DISPID that names the argument of a property put (`DISPID_PROPERTYPUT`).
pub const DISPID_PROPERTYPUT: i32 = -3;
/// The DISPID of the `_NewEnum` member (`DISPID_NEWENUM`).
pub const DISPID_NEWENUM: i32 = -4;

/// `DISP_E_PARAMNOTFOUND`: the scode of `[Type]::Missing`.
pub const DISP_E_PARAMNOTFOUND: i32 = 0x8002_0004_u32 as i32;
/// `DISP_E_UNKNOWNNAME`: `GetIDsOfNames` does not know the member.
pub const DISP_E_UNKNOWNNAME: i32 = 0x8002_0006_u32 as i32;
/// `DISP_E_MEMBERNOTFOUND`: `Invoke` does not know the member.
pub const DISP_E_MEMBERNOTFOUND: i32 = 0x8002_0003_u32 as i32;
/// `DISP_E_EXCEPTION`: the member raised an exception and described it in EXCEPINFO.
pub const DISP_E_EXCEPTION: i32 = 0x8002_0009_u32 as i32;

/// The locale passed to `GetIDsOfNames` and `Invoke`: the DLR COM binder of Windows PowerShell passes LCID 0.
pub const LCID: u32 = 0;

/// What one call does to a member; it decides the Invoke flags and the PowerShell wording of a failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// `$obj.Name` (a property read, with or without index arguments).
    Get,
    /// `$obj.Name = value`.
    Put,
    /// A property set by reference (`DISPATCH_PROPERTYPUTREF`).
    PutRef,
    /// `$obj.Name(args)`.
    Call,
    /// One `IEnumVARIANT::Next`.
    EnumNext,
}

impl Kind {
    /// The name the call log uses.
    pub fn name(self) -> &'static str {
        match self {
            Kind::Get => "get",
            Kind::Put => "put",
            Kind::PutRef => "putref",
            Kind::Call => "call",
            Kind::EnumNext => "enum-next",
        }
    }

    /// The kind a call log names.
    pub fn from_name(name: &str) -> Option<Kind> {
        Some(match name {
            "get" => Kind::Get,
            "put" => Kind::Put,
            "putref" => Kind::PutRef,
            "call" => Kind::Call,
            "enum-next" => Kind::EnumNext,
            _ => return None,
        })
    }
}

/// One member access a backend carries out.
pub struct Call<'a> {
    /// The member name, as the host wrote it.
    pub member: &'a str,
    /// What the access is.
    pub kind: Kind,
    /// The `IDispatch::Invoke` flags PowerShell's binder used for it.
    pub flags: u32,
    /// Positional arguments, in the order the caller wrote them (the backend reverses them for `DISPPARAMS`).
    pub args: &'a [Value],
    /// Named arguments after the positional ones.
    pub named: &'a [(&'a str, Value)],
    /// For a put: the value assigned (it is the last positional argument in the Invoke, named `DISPID_PROPERTYPUT`).
    pub value: Option<&'a Value>,
}

/// A COM failure as PowerShell reports it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComError {
    /// `$_.Exception.HResult`: the outer exception PowerShell wraps the COM failure in.
    pub hresult: i32,
    /// The HRESULT of the innermost exception, the COM failure itself (what a walk down `InnerException` ends on).
    pub inner_hresult: i32,
    /// `$_.Exception.Message`.
    pub message: String,
    /// The message of the innermost exception.
    pub inner_message: String,
    /// The member does not exist on the object (`DISP_E_UNKNOWNNAME`/`DISP_E_MEMBERNOTFOUND`), which the binder
    /// answers by rule, not by this failure.
    pub unknown_member: bool,
}

/// A failure the host itself raised (`throw "..."`): only a message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostError {
    /// The text.
    pub message: String,
}

impl HostError {
    /// A host-thrown text.
    pub fn new(message: impl Into<String>) -> HostError {
        HostError { message: message.into() }
    }
}

/// Either kind of failure of a call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    /// A COM failure.
    Com(ComError),
    /// A host-thrown text.
    Host(HostError),
}

impl Error {
    /// A host-thrown text.
    pub fn host(message: impl Into<String>) -> Error {
        Error::Host(HostError::new(message))
    }

    /// `$_.Exception.Message`.
    pub fn message(&self) -> &str {
        match self {
            Error::Com(error) => &error.message,
            Error::Host(error) => &error.message,
        }
    }

    /// The COM failure, when it is one.
    pub fn as_com(&self) -> Option<&ComError> {
        match self {
            Error::Com(error) => Some(error),
            Error::Host(_) => None,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for Error {}

impl From<ComError> for Error {
    fn from(error: ComError) -> Error {
        Error::Com(error)
    }
}

impl From<HostError> for Error {
    fn from(error: HostError) -> Error {
        Error::Host(error)
    }
}

/// What a call answers.
pub type Result<T> = std::result::Result<T, Error>;

/// One item at a time out of an `IEnumVARIANT`.
pub trait ItemSource {
    /// The next item, `None` at the end.
    fn next_item(&mut self) -> std::result::Result<Option<Value>, ComError>;
}

/// The object a backend implements; [`Obj`] is the handle over it.
pub trait ComObject {
    /// Carries out one member access. A member that does not exist fails with `unknown_member` set.
    fn invoke(&self, call: &Call<'_>) -> std::result::Result<Value, ComError>;
    /// `DISPID_NEWENUM` then the `IEnumVARIANT` it answers.
    fn enum_open(&self) -> std::result::Result<Box<dyn ItemSource>, ComError>;
    /// Whether both are the same COM object (`QueryInterface(IUnknown)` pointers equal).
    fn same_object(&self, other: &dyn ComObject) -> bool;
    /// The `rcw:<n>` key that stands for the object when it has no window handle.
    fn identity_key(&self) -> String;
    /// The object as `Any`, for `same_object` to compare two objects of one backend.
    fn as_any(&self) -> &dyn Any;
    /// The recording's id of the object, for a backend that has one.
    fn log_id(&self) -> Option<u64> {
        None
    }
}
