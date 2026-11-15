//! The COM layer over `IDispatch` (Windows only), written against the C ABI of `oleaut32`/`ole32` directly: the
//! layer owns every VARIANT, BSTR, SAFEARRAY and interface reference it makes, and the raw types here are the ones
//! the Windows SDK documents (`VARIANT`, `DISPPARAMS`, `EXCEPINFO`, `SAFEARRAYBOUND`, the vtables of `IUnknown`,
//! `IDispatch`, `ITypeInfo` and `IEnumVARIANT`).
//!
//! Ownership rules, each held in one place:
//!
//! * an argument VARIANT is built by [`to_variant`] into an [`OwnedVariant`], which `VariantClear`s it on drop, after
//!   `Invoke` has returned (a `VT_DISPATCH` argument was `AddRef`ed when it was built, so the clear balances it);
//! * a result VARIANT is turned into a [`Value`] by [`from_variant`], which clones an interface it finds in it
//!   (`AddRef`) and never takes the pointer; the [`OwnedVariant`] holding the result then clears it (`Release`);
//! * EXCEPINFO's three BSTRs are freed after the description is taken, and `pfnDeferredFillIn` is called first;
//! * a SAFEARRAY built for a call lives in an argument VARIANT and is destroyed by its `VariantClear`; a received one
//!   by the `VariantClear` of the result;
//! * a [`LiveObject`] holds one reference and releases it when its last handle is dropped. Its DISPID cache is its
//!   own, and per type-info GUID once the object was asked for a second distinct member (one `GetTypeInfo` and
//!   `GetTypeAttr` pair, which is what PowerShell's adapter pays per object): no map is keyed by an interface
//!   pointer, whose address another object reuses once the first is released.
//!
//! Every handle is `!Send`: a COM object stays on the apartment thread that made it (see [`Sta`]).

use std::cell::Cell;
use std::cell::OnceCell;
use std::cell::RefCell;
use std::collections::HashMap;
use std::collections::HashSet;
use std::ffi::c_void;
use std::marker::PhantomData;
use std::mem::ManuallyDrop;
use std::ptr;
use std::rc::Rc;

use super::Call;
use super::ComError;
use super::ComObject;
use super::DISP_E_EXCEPTION;
use super::DISP_E_MEMBERNOTFOUND;
use super::DISP_E_PARAMNOTFOUND;
use super::DISP_E_UNKNOWNNAME;
use super::DISPATCH_METHOD;
use super::DISPATCH_PROPERTYGET;
use super::DISPID_NEWENUM;
use super::DISPID_PROPERTYPUT;
use super::Dim;
use super::ItemSource;
use super::Kind;
use super::LCID;
use super::Obj;
use super::SafeArray;
use super::Value;
use super::errtext;
use super::errtext::Access;
use super::errtext::Raw;
use super::value::Decimal;

/// A GUID.
#[repr(C)]
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Guid {
    d1: u32,
    d2: u16,
    d3: u16,
    d4: [u8; 8],
}

const IID_NULL: Guid = Guid { d1: 0, d2: 0, d3: 0, d4: [0; 8] };
const IID_IUNKNOWN: Guid = Guid { d1: 0, d2: 0, d3: 0, d4: [0xC0, 0, 0, 0, 0, 0, 0, 0x46] };
const IID_IDISPATCH: Guid = Guid { d1: 0x0002_0400, d2: 0, d3: 0, d4: [0xC0, 0, 0, 0, 0, 0, 0, 0x46] };
const IID_IENUMVARIANT: Guid = Guid { d1: 0x0002_0404, d2: 0, d3: 0, d4: [0xC0, 0, 0, 0, 0, 0, 0, 0x46] };

const VT_EMPTY: u16 = 0;
const VT_NULL: u16 = 1;
const VT_I2: u16 = 2;
const VT_I4: u16 = 3;
const VT_R4: u16 = 4;
const VT_R8: u16 = 5;
const VT_CY: u16 = 6;
const VT_DATE: u16 = 7;
const VT_BSTR: u16 = 8;
const VT_DISPATCH: u16 = 9;
const VT_ERROR: u16 = 10;
const VT_BOOL: u16 = 11;
const VT_VARIANT: u16 = 12;
const VT_UNKNOWN: u16 = 13;
const VT_DECIMAL: u16 = 14;
const VT_I1: u16 = 16;
const VT_UI1: u16 = 17;
const VT_UI2: u16 = 18;
const VT_UI4: u16 = 19;
const VT_I8: u16 = 20;
const VT_UI8: u16 = 21;
const VT_INT: u16 = 22;
const VT_UINT: u16 = 23;
const VT_ARRAY: u16 = 0x2000;
const VT_BYREF: u16 = 0x4000;
const VT_TYPEMASK: u16 = 0x0FFF;

const E_INVALIDARG: i32 = 0x8007_0057_u32 as i32;
const E_NOINTERFACE: i32 = 0x8000_4002_u32 as i32;
const S_FALSE: i32 = 1;

const CLSCTX_SERVER: u32 = 0x1 | 0x4 | 0x10;
const COINIT_APARTMENTTHREADED: u32 = 0x2;
const FORMAT_MESSAGE_IGNORE_INSERTS: u32 = 0x0000_0200;
const FORMAT_MESSAGE_FROM_SYSTEM: u32 = 0x0000_1000;
const FORMAT_MESSAGE_ARGUMENT_ARRAY: u32 = 0x0000_2000;

/// The payload of a VARIANT.
#[allow(dead_code)] // fields that only give the C structure its layout
#[repr(C)]
#[derive(Clone, Copy)]
pub union VariantData {
    ll: i64,
    l: i32,
    b: u8,
    i: i16,
    flt: f32,
    dbl: f64,
    boolean: i16,
    scode: i32,
    cy: i64,
    date: f64,
    ptr: *mut c_void,
    record: [usize; 2],
}

/// The `VARIANT` structure (24 bytes on 64-bit Windows).
#[allow(dead_code)] // fields that only give the C structure its layout
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Variant {
    vt: u16,
    reserved1: u16,
    reserved2: u16,
    reserved3: u16,
    data: VariantData,
}

impl Variant {
    fn empty() -> Variant {
        Variant { vt: VT_EMPTY, reserved1: 0, reserved2: 0, reserved3: 0, data: VariantData { record: [0; 2] } }
    }

    fn with(vt: u16, data: VariantData) -> Variant {
        Variant { vt, reserved1: 0, reserved2: 0, reserved3: 0, data }
    }
}

/// The `DECIMAL` structure, which overlays a whole VARIANT.
#[allow(dead_code)] // fields that only give the C structure its layout
#[repr(C)]
#[derive(Clone, Copy)]
struct RawDecimal {
    reserved: u16,
    scale: u8,
    sign: u8,
    hi32: u32,
    lo64: u64,
}

#[allow(dead_code)] // fields that only give the C structure its layout
#[repr(C)]
struct DispParams {
    rgvarg: *mut Variant,
    rgdispid_named_args: *mut i32,
    c_args: u32,
    c_named_args: u32,
}

#[allow(dead_code)] // fields that only give the C structure its layout
#[repr(C)]
struct ExcepInfo {
    w_code: u16,
    w_reserved: u16,
    bstr_source: *mut u16,
    bstr_description: *mut u16,
    bstr_help_file: *mut u16,
    dw_help_context: u32,
    pv_reserved: *mut c_void,
    pfn_deferred_fill_in: Option<unsafe extern "system" fn(*mut ExcepInfo) -> i32>,
    scode: i32,
}

#[allow(dead_code)] // fields that only give the C structure its layout
#[repr(C)]
struct SafeArrayBound {
    c_elements: u32,
    l_lbound: i32,
}

#[repr(C)]
struct IUnknownVtbl {
    query_interface: unsafe extern "system" fn(*mut c_void, *const Guid, *mut *mut c_void) -> i32,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
}

#[allow(dead_code)] // fields that only give the C structure its layout
#[repr(C)]
struct IDispatchVtbl {
    base: IUnknownVtbl,
    get_type_info_count: unsafe extern "system" fn(*mut c_void, *mut u32) -> i32,
    get_type_info: unsafe extern "system" fn(*mut c_void, u32, u32, *mut *mut c_void) -> i32,
    get_ids_of_names: unsafe extern "system" fn(*mut c_void, *const Guid, *const *const u16, u32, u32, *mut i32) -> i32,
    invoke: unsafe extern "system" fn(
        *mut c_void,
        i32,
        *const Guid,
        u32,
        u16,
        *mut DispParams,
        *mut Variant,
        *mut ExcepInfo,
        *mut u32,
    ) -> i32,
}

/// `ITypeInfo`: slots 4 to 18 are not used here.
#[allow(dead_code)] // fields that only give the C structure its layout
#[repr(C)]
struct ITypeInfoVtbl {
    base: IUnknownVtbl,
    get_type_attr: unsafe extern "system" fn(*mut c_void, *mut *mut c_void) -> i32,
    unused: [usize; 15],
    release_type_attr: unsafe extern "system" fn(*mut c_void, *mut c_void),
}

#[repr(C)]
struct IEnumVariantVtbl {
    base: IUnknownVtbl,
    next: unsafe extern "system" fn(*mut c_void, u32, *mut Variant, *mut u32) -> i32,
}

#[link(name = "oleaut32")]
unsafe extern "system" {
    fn SysAllocStringLen(psz: *const u16, len: u32) -> *mut u16;
    fn SysFreeString(bstr: *mut u16);
    fn SysStringLen(bstr: *const u16) -> u32;
    fn VariantClear(variant: *mut Variant) -> i32;
    fn SafeArrayCreate(vt: u16, dims: u32, bounds: *const SafeArrayBound) -> *mut c_void;
    fn SafeArrayDestroy(array: *mut c_void) -> i32;
    fn SafeArrayGetDim(array: *mut c_void) -> u32;
    fn SafeArrayGetLBound(array: *mut c_void, dim: u32, bound: *mut i32) -> i32;
    fn SafeArrayGetUBound(array: *mut c_void, dim: u32, bound: *mut i32) -> i32;
    fn SafeArrayGetVartype(array: *mut c_void, vt: *mut u16) -> i32;
    fn SafeArrayAccessData(array: *mut c_void, data: *mut *mut c_void) -> i32;
    fn SafeArrayUnaccessData(array: *mut c_void) -> i32;
    fn GetActiveObject(clsid: *const Guid, reserved: *mut c_void, unknown: *mut *mut c_void) -> i32;
}

#[link(name = "ole32")]
unsafe extern "system" {
    fn CoInitializeEx(reserved: *mut c_void, flags: u32) -> i32;
    fn CoUninitialize();
    fn CoCreateInstance(clsid: *const Guid, outer: *mut c_void, context: u32, iid: *const Guid, object: *mut *mut c_void) -> i32;
    fn CLSIDFromProgID(prog_id: *const u16, clsid: *mut Guid) -> i32;
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn FormatMessageW(flags: u32, source: *const c_void, message_id: u32, language_id: u32, buffer: *mut u16, size: u32, arguments: *mut c_void) -> u32;
}

fn vtbl<'a, T>(interface: *mut c_void) -> &'a T {
    // SAFETY: every COM interface pointer starts with a pointer to its vtable, and a vtable is valid as long as the
    // interface is; callers hold a reference to the interface for as long as they use the vtable.
    unsafe { &**(interface as *const *const T) }
}

/// One counted reference to a COM interface; dropping it releases the reference.
pub struct Iface(ptr::NonNull<c_void>);

impl Iface {
    /// Takes ownership of one reference. `None` for a null pointer.
    ///
    /// # Safety
    /// `raw` is null or a valid COM interface pointer on which the caller owns one reference.
    pub unsafe fn from_raw(raw: *mut c_void) -> Option<Iface> {
        ptr::NonNull::new(raw).map(Iface)
    }

    /// Adds a reference to `raw` and owns it.
    ///
    /// # Safety
    /// `raw` is null or a valid COM interface pointer.
    pub unsafe fn from_raw_add_ref(raw: *mut c_void) -> Option<Iface> {
        let iface = ptr::NonNull::new(raw)?;
        // SAFETY: the caller guarantees the pointer is a valid interface.
        unsafe { (vtbl::<IUnknownVtbl>(raw).add_ref)(raw) };
        Some(Iface(iface))
    }

    fn as_ptr(&self) -> *mut c_void {
        self.0.as_ptr()
    }

    fn query(&self, iid: &Guid) -> Result<Iface, i32> {
        let mut out: *mut c_void = ptr::null_mut();
        // SAFETY: `self` holds a reference to a valid interface; `out` receives an owned reference on success.
        let hr = unsafe { (vtbl::<IUnknownVtbl>(self.as_ptr()).query_interface)(self.as_ptr(), iid, &mut out) };
        if hr < 0 {
            return Err(hr);
        }
        // SAFETY: on success `out` is an interface on which the call gave one reference.
        unsafe { Iface::from_raw(out) }.ok_or(E_NOINTERFACE)
    }
}

impl Clone for Iface {
    fn clone(&self) -> Iface {
        // SAFETY: `self` holds a reference to a valid interface.
        unsafe { (vtbl::<IUnknownVtbl>(self.as_ptr()).add_ref)(self.as_ptr()) };
        Iface(self.0)
    }
}

impl Drop for Iface {
    fn drop(&mut self) {
        // SAFETY: `self` owns one reference, given back exactly once here.
        unsafe { (vtbl::<IUnknownVtbl>(self.as_ptr()).release)(self.as_ptr()) };
    }
}

/// A VARIANT this layer owns: it is cleared (`VariantClear`) when dropped.
#[repr(transparent)]
pub struct OwnedVariant(Variant);

impl OwnedVariant {
    fn new(variant: Variant) -> OwnedVariant {
        OwnedVariant(variant)
    }

    fn init() -> OwnedVariant {
        OwnedVariant(Variant::empty())
    }

    fn into_inner(self) -> Variant {
        let this = ManuallyDrop::new(self);
        this.0
    }
}

impl Drop for OwnedVariant {
    fn drop(&mut self) {
        // SAFETY: the VARIANT is initialised and owned here; clearing frees its BSTR, array or interface reference.
        unsafe { VariantClear(&mut self.0) };
    }
}

fn bad_argument(message: impl Into<String>) -> ComError {
    let message = message.into();
    ComError {
        hresult: errtext::WRAPPED_HRESULT,
        inner_hresult: E_INVALIDARG,
        message: message.clone(),
        inner_message: message,
        unknown_member: false,
    }
}

fn utf16(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn utf16_nul(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn alloc_bstr(text: &str) -> *mut u16 {
    let units = utf16(text);
    // SAFETY: `units` is valid for `len` code units; a zero length gives an empty (non-null) BSTR.
    unsafe { SysAllocStringLen(units.as_ptr(), units.len() as u32) }
}

fn read_bstr(bstr: *const u16) -> String {
    if bstr.is_null() {
        return String::new();
    }
    // SAFETY: a non-null BSTR is valid for `SysStringLen` code units.
    let units = unsafe { std::slice::from_raw_parts(bstr, SysStringLen(bstr) as usize) };
    String::from_utf16_lossy(units)
}

/// The system's message for an HRESULT in the user language (what .NET's `FormatMessage` call finds), trimmed.
pub fn system_text(hresult: i32) -> Option<String> {
    let mut buffer = [0u16; 1024];
    // SAFETY: the buffer is valid for its length; the flags take no insert arguments.
    let written = unsafe {
        FormatMessageW(
            FORMAT_MESSAGE_IGNORE_INSERTS | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_ARGUMENT_ARRAY,
            ptr::null(),
            hresult as u32,
            0,
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            ptr::null_mut(),
        )
    };
    if written == 0 {
        return None;
    }
    let text = String::from_utf16_lossy(&buffer[..written as usize]);
    let text = text.trim_end();
    (!text.is_empty()).then(|| text.to_owned())
}

/// A [`Value`] as an owned VARIANT of the exact type it names.
pub fn to_variant(value: &Value) -> Result<OwnedVariant, ComError> {
    let variant = match value {
        Value::Empty => Variant::empty(),
        // An argument that is `$null` in the PowerShell host: .NET hands a null object to a late-bound call as VT_EMPTY (VT_NULL is
        // `DBNull`, which no call of the hosts passes). Word refuses VT_NULL where it takes nothing ("Type mismatch" of
        // Hyperlinks.Add's screen tip).
        Value::Null => Variant::empty(),
        Value::Missing => Variant::with(VT_ERROR, VariantData { scode: DISP_E_PARAMNOTFOUND }),
        Value::Bool(v) => Variant::with(VT_BOOL, VariantData { boolean: if *v { -1 } else { 0 } }),
        Value::I1(v) => Variant::with(VT_I1, VariantData { b: *v as u8 }),
        Value::I2(v) => Variant::with(VT_I2, VariantData { i: *v }),
        Value::I4(v) => Variant::with(VT_I4, VariantData { l: *v }),
        Value::I8(v) => Variant::with(VT_I8, VariantData { ll: *v }),
        Value::UI1(v) => Variant::with(VT_UI1, VariantData { b: *v }),
        Value::UI2(v) => Variant::with(VT_UI2, VariantData { i: *v as i16 }),
        Value::UI4(v) => Variant::with(VT_UI4, VariantData { l: *v as i32 }),
        Value::UI8(v) => Variant::with(VT_UI8, VariantData { ll: *v as i64 }),
        Value::R4(v) => Variant::with(VT_R4, VariantData { flt: *v }),
        Value::R8(v) => Variant::with(VT_R8, VariantData { dbl: *v }),
        Value::Currency(v) => Variant::with(VT_CY, VariantData { cy: *v }),
        Value::Date(v) => Variant::with(VT_DATE, VariantData { date: *v }),
        Value::Error(v) => Variant::with(VT_ERROR, VariantData { scode: *v }),
        Value::Str(text) => Variant::with(VT_BSTR, VariantData { ptr: alloc_bstr(text).cast() }),
        Value::Decimal(decimal) => {
            let raw = RawDecimal {
                reserved: VT_DECIMAL,
                scale: decimal.scale,
                sign: if decimal.negative { 0x80 } else { 0 },
                hi32: decimal.hi32,
                lo64: decimal.lo64,
            };
            // SAFETY: `DECIMAL` and `VARIANT` are both 16 bytes or more with the same leading layout, and `Variant` is
            // at least as large as `RawDecimal`; the copy is of plain integers.
            let mut variant = Variant::empty();
            unsafe { ptr::copy_nonoverlapping(&raw as *const RawDecimal as *const u8, &mut variant as *mut Variant as *mut u8, size_of::<RawDecimal>()) };
            variant
        }
        Value::Dispatch(object) => {
            let live = live_of(object)?;
            let dispatch = live.dispatch().ok_or_else(|| bad_argument("the object does not implement IDispatch"))?;
            // SAFETY: the interface is valid; the reference added here is the VARIANT's, released by VariantClear.
            let held = unsafe { Iface::from_raw_add_ref(dispatch.as_ptr()) }.ok_or_else(|| bad_argument("null interface"))?;
            Variant::with(VT_DISPATCH, VariantData { ptr: into_raw(held) })
        }
        Value::Unknown(object) => {
            let live = live_of(object)?;
            // SAFETY: as above.
            let held = unsafe { Iface::from_raw_add_ref(live.iface.as_ptr()) }.ok_or_else(|| bad_argument("null interface"))?;
            Variant::with(VT_UNKNOWN, VariantData { ptr: into_raw(held) })
        }
        Value::Array(array) => Variant::with(VT_ARRAY | VT_VARIANT, VariantData { ptr: build_safearray(array)? }),
    };
    Ok(OwnedVariant::new(variant))
}

fn into_raw(iface: Iface) -> *mut c_void {
    let iface = ManuallyDrop::new(iface);
    iface.as_ptr()
}

fn live_of(object: &Obj) -> Result<&LiveObject, ComError> {
    object
        .backend()
        .as_any()
        .downcast_ref::<LiveObject>()
        .ok_or_else(|| bad_argument("only an object of this backend can be passed to a COM call"))
}

/// What a VARIANT holds, by value; a `VT_BYREF` is read through. An interface in it is cloned (`AddRef`), the VARIANT
/// stays as it was and its owner still clears it.
pub fn from_variant(variant: &Variant) -> Result<Value, ComError> {
    let byref = variant.vt & VT_BYREF != 0;
    let vt = variant.vt & !VT_BYREF;
    // SAFETY (all reads below): the union member read is the one `vt` names, and a by-reference pointer is the pointer
    // to a value of that type the owner of the VARIANT supplied.
    unsafe {
        if vt & VT_ARRAY != 0 {
            let array = if byref { *(variant.data.ptr as *const *mut c_void) } else { variant.data.ptr };
            if array.is_null() {
                return Ok(Value::Null);
            }
            return Ok(Value::Array(read_safearray(array)?));
        }
        if byref && vt & VT_TYPEMASK == VT_VARIANT {
            let inner = variant.data.ptr as *const Variant;
            if inner.is_null() {
                return Ok(Value::Null);
            }
            return from_variant(&*inner);
        }
        let base = vt & VT_TYPEMASK;
        let data = &variant.data;
        let place = data.ptr as *const u8;
        Ok(match base {
            VT_EMPTY => Value::Empty,
            VT_NULL => Value::Null,
            VT_I2 => Value::I2(if byref { *(place as *const i16) } else { data.i }),
            VT_I4 | VT_INT => Value::I4(if byref { *(place as *const i32) } else { data.l }),
            VT_R4 => Value::R4(if byref { *(place as *const f32) } else { data.flt }),
            VT_R8 => Value::R8(if byref { *(place as *const f64) } else { data.dbl }),
            VT_CY => Value::Currency(if byref { *(place as *const i64) } else { data.cy }),
            VT_DATE => Value::Date(if byref { *(place as *const f64) } else { data.date }),
            VT_BSTR => {
                let bstr = if byref { *(place as *const *const u16) } else { data.ptr as *const u16 };
                Value::Str(read_bstr(bstr))
            }
            VT_ERROR => {
                let scode = if byref { *(place as *const i32) } else { data.scode };
                if scode == DISP_E_PARAMNOTFOUND { Value::Missing } else { Value::Error(scode) }
            }
            VT_BOOL => Value::Bool((if byref { *(place as *const i16) } else { data.boolean }) != 0),
            VT_DISPATCH | VT_UNKNOWN => {
                let raw = if byref { *(place as *const *mut c_void) } else { data.ptr };
                match Iface::from_raw_add_ref(raw) {
                    None => Value::Null,
                    Some(iface) => {
                        let object = Obj::new(Rc::new(LiveObject::new(iface, base == VT_DISPATCH)));
                        if base == VT_DISPATCH { Value::Dispatch(object) } else { Value::Unknown(object) }
                    }
                }
            }
            VT_DECIMAL => {
                let raw = if byref { *(place as *const RawDecimal) } else { *(variant as *const Variant as *const RawDecimal) };
                Value::Decimal(Decimal { negative: raw.sign & 0x80 != 0, scale: raw.scale, hi32: raw.hi32, lo64: raw.lo64 })
            }
            VT_I1 => Value::I1(if byref { *(place as *const i8) } else { data.b as i8 }),
            VT_UI1 => Value::UI1(if byref { *place } else { data.b }),
            VT_UI2 => Value::UI2(if byref { *(place as *const u16) } else { data.i as u16 }),
            VT_UI4 | VT_UINT => Value::UI4(if byref { *(place as *const u32) } else { data.l as u32 }),
            VT_I8 => Value::I8(if byref { *(place as *const i64) } else { data.ll }),
            VT_UI8 => Value::UI8(if byref { *(place as *const u64) } else { data.ll as u64 }),
            other => return Err(bad_argument(format!("a VARIANT of type {other} cannot be read"))),
        })
    }
}

/// Reads a SAFEARRAY of any element type PowerShell reads as `object[]`: each element becomes a [`Value`].
fn read_safearray(array: *mut c_void) -> Result<SafeArray, ComError> {
    // SAFETY: `array` is a valid SAFEARRAY owned by a VARIANT the caller holds; the data pointer is only used between
    // `SafeArrayAccessData` and `SafeArrayUnaccessData`, within the element count the bounds give.
    unsafe {
        let rank = SafeArrayGetDim(array);
        let mut dims = Vec::new();
        for dim in 1..=rank {
            let (mut lower, mut upper) = (0i32, 0i32);
            if SafeArrayGetLBound(array, dim, &mut lower) < 0 || SafeArrayGetUBound(array, dim, &mut upper) < 0 {
                return Err(bad_argument("a SAFEARRAY bound cannot be read"));
            }
            let len = if upper < lower { 0 } else { (i64::from(upper) - i64::from(lower) + 1) as u32 };
            dims.push(Dim { lbound: lower, len });
        }
        let count = dims.iter().map(|dim| dim.len as usize).product::<usize>();
        let mut vt = 0u16;
        if SafeArrayGetVartype(array, &mut vt) < 0 {
            return Err(bad_argument("a SAFEARRAY element type cannot be read"));
        }
        let mut data: *mut c_void = ptr::null_mut();
        if count > 0 && SafeArrayAccessData(array, &mut data) < 0 {
            return Err(bad_argument("a SAFEARRAY cannot be accessed"));
        }
        let mut items = Vec::with_capacity(count);
        let mut failure = None;
        for index in 0..count {
            let element = match vt {
                VT_VARIANT => from_variant(&*(data as *const Variant).add(index)),
                VT_BSTR => Ok(Value::Str(read_bstr(*(data as *const *const u16).add(index)))),
                VT_I2 => Ok(Value::I2(*(data as *const i16).add(index))),
                VT_I4 | VT_INT => Ok(Value::I4(*(data as *const i32).add(index))),
                VT_R4 => Ok(Value::R4(*(data as *const f32).add(index))),
                VT_R8 => Ok(Value::R8(*(data as *const f64).add(index))),
                VT_CY => Ok(Value::Currency(*(data as *const i64).add(index))),
                VT_DATE => Ok(Value::Date(*(data as *const f64).add(index))),
                VT_BOOL => Ok(Value::Bool(*(data as *const i16).add(index) != 0)),
                VT_ERROR => Ok(Value::Error(*(data as *const i32).add(index))),
                VT_I1 => Ok(Value::I1(*(data as *const i8).add(index))),
                VT_UI1 => Ok(Value::UI1(*(data as *const u8).add(index))),
                VT_UI2 => Ok(Value::UI2(*(data as *const u16).add(index))),
                VT_UI4 | VT_UINT => Ok(Value::UI4(*(data as *const u32).add(index))),
                VT_I8 => Ok(Value::I8(*(data as *const i64).add(index))),
                VT_UI8 => Ok(Value::UI8(*(data as *const u64).add(index))),
                VT_DISPATCH | VT_UNKNOWN => {
                    let raw = *(data as *const *mut c_void).add(index);
                    Ok(match Iface::from_raw_add_ref(raw) {
                        None => Value::Null,
                        Some(iface) => {
                            let object = Obj::new(Rc::new(LiveObject::new(iface, vt == VT_DISPATCH)));
                            if vt == VT_DISPATCH { Value::Dispatch(object) } else { Value::Unknown(object) }
                        }
                    })
                }
                other => Err(bad_argument(format!("a SAFEARRAY of element type {other} cannot be read"))),
            };
            match element {
                Ok(value) => items.push(value),
                Err(error) => {
                    failure = Some(error);
                    break;
                }
            }
        }
        if count > 0 {
            SafeArrayUnaccessData(array);
        }
        if let Some(error) = failure {
            return Err(error);
        }
        SafeArray::new(dims, items).ok_or_else(|| bad_argument("a SAFEARRAY has no dimension"))
    }
}

/// Builds a SAFEARRAY of VARIANT from `array`. The result is owned by the caller (a VARIANT that holds it destroys it
/// with `VariantClear`). The bounds go to `SafeArrayCreate` in dimension order, dimension 1 (rows) first, and the
/// elements are stored column-major as `array` holds them.
fn build_safearray(array: &SafeArray) -> Result<*mut c_void, ComError> {
    let bounds: Vec<SafeArrayBound> = array.dims().iter().map(|dim| SafeArrayBound { c_elements: dim.len, l_lbound: dim.lbound }).collect();
    // SAFETY: `bounds` is valid for `rank` entries; a VT_VARIANT array is created with every element empty, so a
    // failure part way leaves only VARIANTs that `SafeArrayDestroy` can clear; elements are written inside the count.
    unsafe {
        let created = SafeArrayCreate(VT_VARIANT, bounds.len() as u32, bounds.as_ptr());
        if created.is_null() {
            return Err(bad_argument("a SAFEARRAY could not be created"));
        }
        if array.data().is_empty() {
            return Ok(created);
        }
        let mut data: *mut c_void = ptr::null_mut();
        if SafeArrayAccessData(created, &mut data) < 0 {
            SafeArrayDestroy(created);
            return Err(bad_argument("a SAFEARRAY could not be accessed"));
        }
        for (index, item) in array.data().iter().enumerate() {
            match to_variant(item) {
                Ok(variant) => ptr::write((data as *mut Variant).add(index), variant.into_inner()),
                Err(error) => {
                    SafeArrayUnaccessData(created);
                    SafeArrayDestroy(created);
                    return Err(error);
                }
            }
        }
        SafeArrayUnaccessData(created);
        Ok(created)
    }
}

thread_local! {
    /// DISPIDs by type-info GUID (`TYPEATTR.guid`) and member name, for the objects of this apartment thread.
    static TYPE_DISPIDS: RefCell<HashMap<Guid, HashMap<String, i32>>> = RefCell::new(HashMap::new());
}

#[derive(Default)]
struct Names {
    own: HashMap<String, i32>,
    missing: HashSet<String>,
    /// How many distinct members this object was asked for.
    asked: usize,
    /// `Some(None)`: the object has no type information.
    guid: Option<Option<Guid>>,
}

/// An object reached through `IDispatch` (or an `IUnknown` that is asked for it on first use).
pub struct LiveObject {
    iface: Iface,
    is_dispatch: bool,
    /// The `IDispatch` of an object that was given as a bare `IUnknown`, asked for on first use.
    queried: OnceCell<Option<Iface>>,
    names: RefCell<Names>,
    identity: Cell<usize>,
    /// A handle never crosses to another thread.
    _apartment: PhantomData<*const ()>,
}

impl LiveObject {
    fn new(iface: Iface, is_dispatch: bool) -> LiveObject {
        LiveObject { iface, is_dispatch, queried: OnceCell::new(), names: RefCell::new(Names::default()), identity: Cell::new(0), _apartment: PhantomData }
    }

    /// A handle over an `IDispatch` pointer, adding a reference of its own.
    ///
    /// # Safety
    /// `raw` is a valid `IDispatch` interface pointer.
    pub unsafe fn from_dispatch(raw: *mut c_void) -> Option<Obj> {
        // SAFETY: the caller guarantees the pointer.
        let iface = unsafe { Iface::from_raw_add_ref(raw) }?;
        Some(Obj::new(Rc::new(LiveObject::new(iface, true))))
    }

    fn dispatch(&self) -> Option<&Iface> {
        if self.is_dispatch {
            return Some(&self.iface);
        }
        self.queried.get_or_init(|| self.iface.query(&IID_IDISPATCH).ok()).as_ref()
    }

    fn type_guid(dispatch: &Iface) -> Option<Guid> {
        let mut info: *mut c_void = ptr::null_mut();
        // SAFETY: `dispatch` holds a reference; `info` receives an owned reference on success.
        let hr = unsafe { (vtbl::<IDispatchVtbl>(dispatch.as_ptr()).get_type_info)(dispatch.as_ptr(), 0, LCID, &mut info) };
        if hr < 0 {
            return None;
        }
        // SAFETY: on success `info` carries the reference the call gave.
        let info = unsafe { Iface::from_raw(info) }?;
        let mut attr: *mut c_void = ptr::null_mut();
        // SAFETY: `info` is a valid ITypeInfo; the TYPEATTR (whose first member is the GUID) is read before it is released.
        unsafe {
            let hr = (vtbl::<ITypeInfoVtbl>(info.as_ptr()).get_type_attr)(info.as_ptr(), &mut attr);
            if hr < 0 || attr.is_null() {
                return None;
            }
            let guid = *(attr as *const Guid);
            (vtbl::<ITypeInfoVtbl>(info.as_ptr()).release_type_attr)(info.as_ptr(), attr);
            Some(guid)
        }
    }

    fn get_ids(&self, dispatch: &Iface, names: &[&str]) -> Result<Vec<i32>, i32> {
        let wide: Vec<Vec<u16>> = names.iter().map(|name| utf16_nul(name)).collect();
        let pointers: Vec<*const u16> = wide.iter().map(|name| name.as_ptr()).collect();
        let mut ids = vec![0i32; names.len()];
        // SAFETY: `pointers` holds `names.len()` NUL-terminated strings that outlive the call; `ids` has room for as many.
        let hr = unsafe {
            (vtbl::<IDispatchVtbl>(dispatch.as_ptr()).get_ids_of_names)(
                dispatch.as_ptr(),
                &IID_NULL,
                pointers.as_ptr(),
                pointers.len() as u32,
                LCID,
                ids.as_mut_ptr(),
            )
        };
        if hr < 0 { Err(hr) } else { Ok(ids) }
    }

    /// The DISPID of a member: this object's cache, then the cache of its type, then `GetIDsOfNames`.
    fn dispid(&self, dispatch: &Iface, name: &str) -> Result<i32, i32> {
        let known_type = {
            let names = self.names.borrow();
            if let Some(id) = names.own.get(name) {
                return Ok(*id);
            }
            if names.missing.contains(name) {
                return Err(DISP_E_UNKNOWNNAME);
            }
            names.guid.flatten()
        };
        if let Some(guid) = known_type
            && let Some(id) = TYPE_DISPIDS.with(|types| types.borrow().get(&guid).and_then(|members| members.get(name).copied()))
        {
            self.names.borrow_mut().own.insert(name.to_owned(), id);
            return Ok(id);
        }
        let id = match self.get_ids(dispatch, &[name]) {
            Ok(ids) => ids[0],
            Err(hr) => {
                if hr == DISP_E_UNKNOWNNAME {
                    self.names.borrow_mut().missing.insert(name.to_owned());
                }
                return Err(hr);
            }
        };
        let mut names = self.names.borrow_mut();
        names.own.insert(name.to_owned(), id);
        names.asked += 1;
        if names.guid.is_none() && names.asked >= 2 {
            names.guid = Some(Self::type_guid(dispatch));
            if let Some(Some(guid)) = names.guid {
                TYPE_DISPIDS.with(|types| {
                    types.borrow_mut().entry(guid).or_default().extend(names.own.iter().map(|(member, id)| (member.clone(), *id)));
                });
            }
        } else if let Some(Some(guid)) = names.guid {
            TYPE_DISPIDS.with(|types| {
                types.borrow_mut().entry(guid).or_default().insert(name.to_owned(), id);
            });
        }
        Ok(id)
    }

    fn access<'a>(call: &Call<'a>) -> Access<'a> {
        match call.kind {
            Kind::Put | Kind::PutRef => Access::Set { name: call.member },
            Kind::Call => Access::Method { name: call.member, argc: call.args.len() + call.named.len() },
            Kind::Get | Kind::EnumNext if call.args.is_empty() => Access::Get { name: call.member },
            Kind::Get | Kind::EnumNext => Access::Method { name: call.member, argc: call.args.len() },
        }
    }

    /// `IDispatch::Invoke` of `dispid` with `arguments` (the last argument of the call first, as `DISPPARAMS` wants
    /// them) of which the first `named_ids.len()` are named by `named_ids`.
    fn invoke_id(&self, dispatch: &Iface, dispid: i32, flags: u32, arguments: &mut [OwnedVariant], named_ids: &mut [i32]) -> Result<OwnedVariant, Raw> {
        let mut params = DispParams {
            rgvarg: if arguments.is_empty() { ptr::null_mut() } else { arguments.as_mut_ptr().cast() },
            rgdispid_named_args: if named_ids.is_empty() { ptr::null_mut() } else { named_ids.as_mut_ptr() },
            c_args: arguments.len() as u32,
            c_named_args: named_ids.len() as u32,
        };
        let mut result = OwnedVariant::init();
        // SAFETY: an all-zero EXCEPINFO is the empty one (null pointers, no deferred fill-in).
        let mut excep: ExcepInfo = unsafe { std::mem::zeroed() };
        let mut arg_error = 0u32;
        // SAFETY: `OwnedVariant` is a transparent wrapper of `Variant`, so `rgvarg` points at `c_args` valid VARIANTs;
        // every pointer passed lives through the call; `dispatch` holds a reference.
        let hr = unsafe {
            (vtbl::<IDispatchVtbl>(dispatch.as_ptr()).invoke)(
                dispatch.as_ptr(),
                dispid,
                &IID_NULL,
                LCID,
                flags as u16,
                &mut params,
                &mut result.0,
                &mut excep,
                &mut arg_error,
            )
        };
        let failure = if hr == DISP_E_EXCEPTION {
            if let Some(fill) = excep.pfn_deferred_fill_in {
                // SAFETY: when the member set a deferred fill-in it is the one to call, with the same EXCEPINFO.
                unsafe { fill(&mut excep) };
            }
            let description = (!excep.bstr_description.is_null()).then(|| read_bstr(excep.bstr_description));
            let code = if excep.scode != 0 { excep.scode } else { i32::from(excep.w_code) };
            Some(Raw { hresult: if code == 0 { hr } else { code }, description })
        } else if hr < 0 {
            Some(Raw { hresult: hr, description: None })
        } else {
            None
        };
        // SAFETY: the three BSTRs are the layer's to free once the text is taken (null is allowed).
        unsafe {
            SysFreeString(excep.bstr_source);
            SysFreeString(excep.bstr_description);
            SysFreeString(excep.bstr_help_file);
        }
        match failure {
            Some(raw) => Err(raw),
            None => Ok(result),
        }
    }
}

impl ComObject for LiveObject {
    fn invoke(&self, call: &Call<'_>) -> Result<Value, ComError> {
        let Some(dispatch) = self.dispatch() else {
            return Err(errtext::com_error(Self::access(call), &Raw { hresult: E_NOINTERFACE, description: None }, &system_text));
        };
        let access = Self::access(call);
        let wrap = |raw: Raw| errtext::com_error(access, &raw, &system_text);
        let (member_id, mut named_ids) = if call.named.is_empty() {
            match self.dispid(dispatch, call.member) {
                Ok(id) => (id, Vec::new()),
                Err(hr) if hr == DISP_E_UNKNOWNNAME => return Err(errtext::unknown_member(hr)),
                Err(hr) => return Err(wrap(Raw { hresult: hr, description: None })),
            }
        } else {
            let mut names = vec![call.member];
            names.extend(call.named.iter().map(|(name, _)| *name));
            match self.get_ids(dispatch, &names) {
                Ok(ids) => (ids[0], ids[1..].to_vec()),
                Err(hr) if hr == DISP_E_UNKNOWNNAME => return Err(errtext::unknown_member(hr)),
                Err(hr) => return Err(wrap(Raw { hresult: hr, description: None })),
            }
        };
        // The call's arguments in call order: positional, then named; a put's value is the last positional one.
        let mut ordered: Vec<&Value> = call.args.iter().collect();
        ordered.extend(call.value);
        ordered.extend(call.named.iter().map(|(_, value)| value));
        let mut arguments = Vec::with_capacity(ordered.len());
        for value in ordered.iter().rev() {
            arguments.push(to_variant(value)?);
        }
        // DISPPARAMS puts the named arguments first, then the positional ones, each group last to first.
        let put = matches!(call.kind, Kind::Put | Kind::PutRef);
        let flags = call.flags;
        let result = if put {
            // The assigned value is rgvarg[0], named DISPID_PROPERTYPUT, followed by the index arguments reversed.
            let mut named = [DISPID_PROPERTYPUT];
            self.invoke_id(dispatch, member_id, flags, &mut arguments, &mut named)
        } else {
            named_ids.reverse();
            self.invoke_id(dispatch, member_id, flags, &mut arguments, &mut named_ids)
        };
        match result {
            Ok(result) => from_variant(&result.0),
            Err(raw) if raw.hresult == DISP_E_MEMBERNOTFOUND || raw.hresult == DISP_E_UNKNOWNNAME => Err(errtext::unknown_member(raw.hresult)),
            Err(raw) => Err(wrap(raw)),
        }
    }

    fn enum_open(&self) -> Result<Box<dyn ItemSource>, ComError> {
        let access = Access::Method { name: "GetEnumerator", argc: 0 };
        let wrap = |hresult: i32| errtext::com_error(access, &Raw { hresult, description: None }, &system_text);
        let dispatch = self.dispatch().ok_or_else(|| wrap(E_NOINTERFACE))?;
        let result = self
            .invoke_id(dispatch, DISPID_NEWENUM, DISPATCH_METHOD | DISPATCH_PROPERTYGET, &mut [], &mut [])
            .map_err(|raw| errtext::com_error(access, &raw, &system_text))?;
        let raw = match result.0.vt & !VT_BYREF {
            VT_UNKNOWN | VT_DISPATCH => {
                // SAFETY: the VARIANT holds an interface pointer; the reference added here is ours.
                unsafe { Iface::from_raw_add_ref(result.0.data.ptr) }
            }
            _ => None,
        };
        let unknown = raw.ok_or_else(|| wrap(E_NOINTERFACE))?;
        let enumerator = unknown.query(&IID_IENUMVARIANT).map_err(wrap)?;
        Ok(Box::new(LiveEnum { enumerator }))
    }

    fn same_object(&self, other: &dyn ComObject) -> bool {
        other.as_any().downcast_ref::<LiveObject>().is_some_and(|other| self.identity_pointer() == other.identity_pointer())
    }

    fn identity_key(&self) -> String {
        format!("rcw:{}", self.identity_pointer())
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

impl LiveObject {
    /// The `QueryInterface(IUnknown)` pointer, which is the COM identity of the object: it is stable while this handle
    /// holds its reference.
    fn identity_pointer(&self) -> usize {
        if self.identity.get() == 0 {
            let pointer = match self.iface.query(&IID_IUNKNOWN) {
                Ok(unknown) => unknown.as_ptr() as usize,
                Err(_) => self.iface.as_ptr() as usize,
            };
            self.identity.set(pointer);
        }
        self.identity.get()
    }
}

struct LiveEnum {
    enumerator: Iface,
}

impl ItemSource for LiveEnum {
    fn next_item(&mut self) -> Result<Option<Value>, ComError> {
        let mut item = OwnedVariant::init();
        let mut fetched = 0u32;
        // SAFETY: the enumerator holds a reference; `item` and `fetched` live through the call.
        let hr = unsafe { (vtbl::<IEnumVariantVtbl>(self.enumerator.as_ptr()).next)(self.enumerator.as_ptr(), 1, &mut item.0, &mut fetched) };
        if hr < 0 {
            return Err(errtext::com_error(Access::Method { name: "MoveNext", argc: 0 }, &Raw { hresult: hr, description: None }, &system_text));
        }
        if hr == S_FALSE || fetched == 0 {
            return Ok(None);
        }
        from_variant(&item.0).map(Some)
    }
}

fn prog_id_clsid(prog_id: &str) -> Result<Guid, ComError> {
    let wide = utf16_nul(prog_id);
    let mut clsid = IID_NULL;
    // SAFETY: `wide` is NUL-terminated and outlives the call.
    let hr = unsafe { CLSIDFromProgID(wide.as_ptr(), &mut clsid) };
    if hr < 0 {
        return Err(plain_error(hr));
    }
    Ok(clsid)
}

fn plain_error(hresult: i32) -> ComError {
    let message = errtext::inner_message(&Raw { hresult, description: None }, &system_text);
    ComError { hresult, inner_hresult: hresult, message: message.clone(), inner_message: message, unknown_member: false }
}

/// `New-Object -ComObject <ProgId>`: `CoCreateInstance` with `CLSCTX_SERVER`.
pub fn create_object(prog_id: &str) -> Result<Obj, ComError> {
    let clsid = prog_id_clsid(prog_id)?;
    let mut out: *mut c_void = ptr::null_mut();
    // SAFETY: a valid CLSID and IID; `out` receives an owned reference on success.
    let hr = unsafe { CoCreateInstance(&clsid, ptr::null_mut(), CLSCTX_SERVER, &IID_IDISPATCH, &mut out) };
    if hr < 0 {
        return Err(plain_error(hr));
    }
    // SAFETY: on success `out` is an IDispatch carrying the reference the call gave.
    let iface = unsafe { Iface::from_raw(out) }.ok_or_else(|| plain_error(E_NOINTERFACE))?;
    Ok(Obj::new(Rc::new(LiveObject::new(iface, true))))
}

/// `[Marshal]::GetActiveObject(<ProgId>)`: the running object of the class, as the running object table has it.
pub fn active_object(prog_id: &str) -> Result<Obj, ComError> {
    let clsid = prog_id_clsid(prog_id)?;
    let mut out: *mut c_void = ptr::null_mut();
    // SAFETY: a valid CLSID; `out` receives an owned IUnknown reference on success.
    let hr = unsafe { GetActiveObject(&clsid, ptr::null_mut(), &mut out) };
    if hr < 0 {
        return Err(plain_error(hr));
    }
    // SAFETY: on success `out` carries the reference the call gave.
    let unknown = unsafe { Iface::from_raw(out) }.ok_or_else(|| plain_error(E_NOINTERFACE))?;
    let dispatch = unknown.query(&IID_IDISPATCH).map_err(plain_error)?;
    Ok(Obj::new(Rc::new(LiveObject::new(dispatch, true))))
}

/// A single-threaded apartment on this thread (`CoInitializeEx(COINIT_APARTMENTTHREADED)`), left when dropped.
pub struct Sta {
    _thread: PhantomData<*const ()>,
}

impl Sta {
    /// Enters the apartment. Fails when the thread already entered a multithreaded one.
    pub fn enter() -> Result<Sta, ComError> {
        // SAFETY: plain initialisation of the calling thread; balanced by `CoUninitialize` in `drop`.
        let hr = unsafe { CoInitializeEx(ptr::null_mut(), COINIT_APARTMENTTHREADED) };
        if hr < 0 {
            return Err(plain_error(hr));
        }
        Ok(Sta { _thread: PhantomData })
    }
}

impl Drop for Sta {
    fn drop(&mut self) {
        // SAFETY: balances the successful `CoInitializeEx` of `enter`.
        unsafe { CoUninitialize() };
    }
}
