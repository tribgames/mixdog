//! The `IDispatch` proxy around a real Office object, written against the COM C ABI directly (as
//! `mixdog_office_com::com::live` is): the layout of every structure here is the Windows SDK's.
//!
//! A proxy forwards everything to the object it wraps and changes nothing Office or PowerShell sees, except that it
//! logs:
//!
//! * `GetTypeInfoCount` and `GetTypeInfo` are forwarded untouched, so PowerShell's COM adapter reads the real type
//!   information and binds by DISPID. `GetIDsOfNames` is forwarded and remembered (the names, the DISPIDs and the
//!   LCID) until the object's next call, which carries them as `"lookups"`; a name the object does not know is logged
//!   as a call of kind `get`, flags 0, that failed with `unknown_member`.
//! * `Invoke` is forwarded and logged as one [`CallEntry`]: the member name resolved through the type information
//!   (`ITypeInfo::GetNames`), the kind from the flags, the LCID and DISPID, the arguments as typed values in the order
//!   the host wrote them (named ones with their parameter names, a put's value apart), and the result or the failure
//!   (EXCEPINFO after its deferred fill-in, shaped by `errtext::com_error` as PowerShell shows it).
//! * An object found in a result (`VT_DISPATCH` and `VT_UNKNOWN`, also inside a `SAFEARRAY` of `VARIANT`) is replaced by
//!   the proxy of its identity. A proxy found in an argument (also by reference and inside a `SAFEARRAY` of `VARIANT`)
//!   is replaced by the real object before the call, because Office checks that a Range or Row argument is its own
//!   object; the caller's `DISPPARAMS` is never written to.
//! * `DISPID_NEWENUM` is not a call of the recording: the enumerator it answers is wrapped by [`enumproxy`], whose
//!   `Next` is what the recording holds (kind `enum-next` on the id of the enumerated object).
//! * `QueryInterface` answers `IUnknown` and `IDispatch` and nothing else (`E_NOINTERFACE`).
//!
//! ONE proxy exists per COM identity: a map from the `QueryInterface(IUnknown)` pointer of the real object to its
//! proxy, an entry removed when the proxy's count reaches zero. So the host's `[object]::ReferenceEquals` and
//! `RuntimeHelpers.GetHashCode` see one object where Office has one.

use std::collections::HashMap;
use std::ffi::c_void;
use std::mem::size_of;
use std::ptr;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::AtomicU32;
use std::sync::atomic::Ordering;

use mixdog_office_com::com::DISP_E_EXCEPTION;
use mixdog_office_com::com::DISP_E_MEMBERNOTFOUND;
use mixdog_office_com::com::DISP_E_PARAMNOTFOUND;
use mixdog_office_com::com::DISP_E_UNKNOWNNAME;
use mixdog_office_com::com::DISPATCH_METHOD;
use mixdog_office_com::com::DISPATCH_PROPERTYGET;
use mixdog_office_com::com::DISPATCH_PROPERTYPUT;
use mixdog_office_com::com::DISPATCH_PROPERTYPUTREF;
use mixdog_office_com::com::DISPID_NEWENUM;
use mixdog_office_com::com::DISPID_PROPERTYPUT;
use mixdog_office_com::com::Decimal;
use mixdog_office_com::com::Kind;
use mixdog_office_com::com::Value;
use mixdog_office_com::com::calllog::CallEntry;
use mixdog_office_com::com::calllog::Entry;
use mixdog_office_com::com::calllog::ErrorRecord;
use mixdog_office_com::com::calllog::Outcome;
use mixdog_office_com::com::calllog::encode_value;
use mixdog_office_com::com::calllog::entry_line;
use mixdog_office_com::com::errtext;
use mixdog_office_com::com::errtext::Access;
use mixdog_office_com::com::errtext::Raw;
use mixdog_office_com::com::live::system_text;
use serde_json::Value as Json;
use serde_json::json;

use crate::emit_with;
use crate::enumproxy;
use crate::locked;

/// A GUID.
#[repr(C)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct Guid {
    d1: u32,
    d2: u16,
    d3: u16,
    d4: [u8; 8],
}

#[cfg(test)]
pub(crate) const IID_NULL: Guid = Guid { d1: 0, d2: 0, d3: 0, d4: [0; 8] };
pub(crate) const IID_IUNKNOWN: Guid = Guid { d1: 0, d2: 0, d3: 0, d4: [0xC0, 0, 0, 0, 0, 0, 0, 0x46] };
pub(crate) const IID_IDISPATCH: Guid = Guid { d1: 0x0002_0400, d2: 0, d3: 0, d4: [0xC0, 0, 0, 0, 0, 0, 0, 0x46] };
pub(crate) const IID_IENUMVARIANT: Guid = Guid { d1: 0x0002_0404, d2: 0, d3: 0, d4: [0xC0, 0, 0, 0, 0, 0, 0, 0x46] };

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

pub(crate) const S_OK: i32 = 0;
pub(crate) const E_NOINTERFACE: i32 = 0x8000_4002_u32 as i32;
pub(crate) const E_POINTER: i32 = 0x8000_4003_u32 as i32;
const E_INVALIDARG: i32 = 0x8007_0057_u32 as i32;

/// The payload of a VARIANT.
#[allow(dead_code)] // fields that only give the C structure its layout
#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) union VariantData {
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
pub(crate) struct Variant {
    vt: u16,
    reserved1: u16,
    reserved2: u16,
    reserved3: u16,
    data: VariantData,
}

impl Variant {
    pub(crate) fn empty() -> Variant {
        Variant { vt: VT_EMPTY, reserved1: 0, reserved2: 0, reserved3: 0, data: VariantData { record: [0; 2] } }
    }

    /// An interface pointer as a `VT_UNKNOWN` VARIANT (the type an enumerator answers in).
    #[cfg(test)]
    pub(crate) fn unknown(pointer: *mut c_void) -> Variant {
        Variant { vt: VT_UNKNOWN, reserved1: 0, reserved2: 0, reserved3: 0, data: VariantData { ptr: pointer } }
    }

    /// A `VT_I4` VARIANT.
    #[cfg(test)]
    pub(crate) fn int(value: i32) -> Variant {
        Variant { vt: VT_I4, reserved1: 0, reserved2: 0, reserved3: 0, data: VariantData { l: value } }
    }

    /// The interface pointer of a `VT_DISPATCH` or `VT_UNKNOWN` VARIANT that is not by reference.
    fn object(&self) -> Option<*mut c_void> {
        // SAFETY: `ptr` is the member `vt` names for these two types.
        (matches!(self.vt, VT_DISPATCH | VT_UNKNOWN)).then(|| unsafe { self.data.ptr }).filter(|pointer| !pointer.is_null())
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
#[derive(Clone, Copy)]
pub(crate) struct ExcepInfo {
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

#[repr(C)]
pub(crate) struct IUnknownVtbl {
    pub(crate) query_interface: unsafe extern "system" fn(*mut c_void, *const Guid, *mut *mut c_void) -> i32,
    pub(crate) add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    pub(crate) release: unsafe extern "system" fn(*mut c_void) -> u32,
}

#[allow(dead_code)] // fields that only give the C structure its layout
#[repr(C)]
pub(crate) struct IDispatchVtbl {
    base: IUnknownVtbl,
    get_type_info_count: unsafe extern "system" fn(*mut c_void, *mut u32) -> i32,
    get_type_info: unsafe extern "system" fn(*mut c_void, u32, u32, *mut *mut c_void) -> i32,
    get_ids_of_names: unsafe extern "system" fn(*mut c_void, *const Guid, *const *const u16, u32, u32, *mut i32) -> i32,
    invoke: unsafe extern "system" fn(*mut c_void, i32, *const Guid, u32, u16, *mut DispParams, *mut Variant, *mut ExcepInfo, *mut u32) -> i32,
}

/// `ITypeInfo` up to `GetNames` (slot 7); the slots in between are not used here.
#[allow(dead_code)] // fields that only give the C structure its layout
#[repr(C)]
struct ITypeInfoVtbl {
    base: IUnknownVtbl,
    get_type_attr: usize,
    get_type_comp: usize,
    get_func_desc: usize,
    get_var_desc: usize,
    get_names: unsafe extern "system" fn(*mut c_void, i32, *mut *mut u16, u32, *mut u32) -> i32,
}

#[link(name = "oleaut32")]
unsafe extern "system" {
    fn SysAllocStringLen(psz: *const u16, len: u32) -> *mut u16;
    fn SysFreeString(bstr: *mut u16);
    fn SysStringLen(bstr: *const u16) -> u32;
    fn VariantClear(variant: *mut Variant) -> i32;
    fn SafeArrayDestroy(array: *mut c_void) -> i32;
    fn SafeArrayCopy(array: *mut c_void, copy: *mut *mut c_void) -> i32;
    fn SafeArrayGetDim(array: *mut c_void) -> u32;
    fn SafeArrayGetLBound(array: *mut c_void, dim: u32, bound: *mut i32) -> i32;
    fn SafeArrayGetUBound(array: *mut c_void, dim: u32, bound: *mut i32) -> i32;
    fn SafeArrayGetVartype(array: *mut c_void, vt: *mut u16) -> i32;
    fn SafeArrayAccessData(array: *mut c_void, data: *mut *mut c_void) -> i32;
    fn SafeArrayUnaccessData(array: *mut c_void) -> i32;
}

fn vtbl<'a, T>(interface: *mut c_void) -> &'a T {
    // SAFETY: every COM interface pointer starts with a pointer to its vtable, and a vtable is valid as long as the
    // interface is; callers hold a reference to the interface for as long as they use the vtable.
    unsafe { &**(interface as *const *const T) }
}

/// `AddRef`.
///
/// # Safety
/// `interface` is a valid COM interface pointer.
pub(crate) unsafe fn add_ref(interface: *mut c_void) -> u32 {
    // SAFETY: the caller guarantees the interface.
    unsafe { (vtbl::<IUnknownVtbl>(interface).add_ref)(interface) }
}

/// `Release`.
///
/// # Safety
/// `interface` is a valid COM interface pointer on which the caller owns a reference.
pub(crate) unsafe fn release(interface: *mut c_void) -> u32 {
    // SAFETY: the caller guarantees the interface and the reference.
    unsafe { (vtbl::<IUnknownVtbl>(interface).release)(interface) }
}

/// `QueryInterface`: an owned reference to `iid`, or `None`.
///
/// # Safety
/// `interface` is a valid COM interface pointer.
pub(crate) unsafe fn query(interface: *mut c_void, iid: &Guid) -> Option<*mut c_void> {
    let mut out: *mut c_void = ptr::null_mut();
    // SAFETY: the caller guarantees the interface; `out` receives an owned reference on success.
    let hr = unsafe { (vtbl::<IUnknownVtbl>(interface).query_interface)(interface, iid, &mut out) };
    (hr >= 0 && !out.is_null()).then_some(out)
}

/// The text of a BSTR (null is the empty string).
///
/// # Safety
/// `bstr` is null or a valid BSTR.
unsafe fn read_bstr(bstr: *const u16) -> String {
    if bstr.is_null() {
        return String::new();
    }
    // SAFETY: a BSTR carries its length in the four bytes before it.
    let units = unsafe { std::slice::from_raw_parts(bstr, SysStringLen(bstr) as usize) };
    String::from_utf16_lossy(units)
}

/// What the proxies know about each other: the proxy of every COM identity that has one, and the next object id.
struct Registry {
    by_identity: HashMap<usize, usize>,
    next_id: u64,
}

fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(Registry { by_identity: HashMap::new(), next_id: 1 }))
}

/// The proxy of one real object. `vtbl` is first: a proxy pointer is an `IDispatch` pointer.
#[allow(dead_code)] // `vtbl` is the first word of the object: COM reads it, this code never does
#[repr(C)]
pub(crate) struct Proxy {
    vtbl: *const IDispatchVtbl,
    refs: AtomicU32,
    /// The real object's `IDispatch`; one reference is held.
    real: *mut c_void,
    /// The real object's `QueryInterface(IUnknown)` pointer: its COM identity and the registry key.
    identity: usize,
    /// The id the recording gives the object.
    id: u64,
    /// The member and parameter names of a DISPID, from the type information (`ITypeInfo::GetNames`).
    names: Mutex<HashMap<i32, Vec<String>>>,
    /// The `GetIDsOfNames` answers since the previous call, to go with the next one.
    lookups: Mutex<Vec<Json>>,
}

static PROXY_VTBL: IDispatchVtbl = IDispatchVtbl {
    base: IUnknownVtbl { query_interface: proxy_query_interface, add_ref: proxy_add_ref, release: proxy_release },
    get_type_info_count: proxy_get_type_info_count,
    get_type_info: proxy_get_type_info,
    get_ids_of_names: proxy_get_ids_of_names,
    invoke: proxy_invoke,
};

/// Whether `pointer` is one of this crate's object proxies.
pub(crate) fn is_proxy(pointer: *mut c_void) -> bool {
    // SAFETY: the first word of a COM interface pointer is its vtable pointer; only the address is compared.
    !pointer.is_null() && ptr::eq(unsafe { *(pointer as *const *const IDispatchVtbl) }, &PROXY_VTBL)
}

fn proxy_ref<'a>(pointer: *mut c_void) -> &'a Proxy {
    // SAFETY: callers pass a pointer `is_proxy` accepted or a proxy's own `this`, valid while its caller holds a reference.
    unsafe { &*(pointer as *const Proxy) }
}

/// The id the recording gives the object behind `pointer`: a proxy's own id, an enumerator's collection, else a proxy is
/// made for it and kept in `holds` until the call that met it is over.
fn object_id(pointer: *mut c_void, holds: &mut Vec<*mut c_void>) -> u64 {
    if is_proxy(pointer) {
        return proxy_ref(pointer).id;
    }
    if let Some(owner) = enumproxy::owner_of(pointer) {
        return owner;
    }
    // SAFETY: `pointer` came out of a VARIANT the caller holds, so it is a valid interface.
    let made = unsafe { wrap_object(pointer) };
    if made.is_null() {
        return 0;
    }
    holds.push(made);
    proxy_ref(made).id
}

fn add_ref_if_alive(proxy: &Proxy) -> bool {
    proxy.refs.fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| (count > 0).then_some(count + 1)).is_ok()
}

/// The proxy of the object behind `unknown`, made when the object has none. The result carries one reference the
/// caller releases; null when the object is not an `IDispatch`.
///
/// # Safety
/// `unknown` is null or a valid COM interface pointer the caller holds a reference to.
pub(crate) unsafe fn wrap_object(unknown: *mut c_void) -> *mut c_void {
    if unknown.is_null() {
        return ptr::null_mut();
    }
    if is_proxy(unknown) {
        // SAFETY: a valid proxy.
        unsafe { add_ref(unknown) };
        return unknown;
    }
    // SAFETY: the caller guarantees `unknown`; each query result is an owned reference, released below or kept.
    unsafe {
        let Some(identity) = query(unknown, &IID_IUNKNOWN) else { return ptr::null_mut() };
        let Some(real) = query(unknown, &IID_IDISPATCH) else {
            release(identity);
            return ptr::null_mut();
        };
        let key = identity as usize;
        // The identity reference is only needed to read the pointer: the real dispatch reference keeps the object alive,
        // and so keeps the pointer the key stands for.
        release(identity);
        let mut registry = locked(registry());
        if let Some(existing) = registry.by_identity.get(&key).copied()
            && add_ref_if_alive(proxy_ref(existing as *mut c_void))
        {
            drop(registry);
            release(real);
            return existing as *mut c_void;
        }
        let id = registry.next_id;
        registry.next_id += 1;
        let proxy = Box::into_raw(Box::new(Proxy {
            vtbl: &PROXY_VTBL,
            refs: AtomicU32::new(1),
            real,
            identity: key,
            id,
            names: Mutex::new(HashMap::new()),
            lookups: Mutex::new(Vec::new()),
        }));
        registry.by_identity.insert(key, proxy as usize);
        proxy.cast()
    }
}

unsafe extern "system" fn proxy_query_interface(this: *mut c_void, iid: *const Guid, out: *mut *mut c_void) -> i32 {
    if out.is_null() {
        return E_POINTER;
    }
    // SAFETY: `out` is a valid out pointer; `iid`, when not null, points at a GUID.
    unsafe {
        *out = ptr::null_mut();
        if iid.is_null() {
            return E_INVALIDARG;
        }
        if *iid == IID_IUNKNOWN || *iid == IID_IDISPATCH {
            proxy_add_ref(this);
            *out = this;
            return S_OK;
        }
    }
    E_NOINTERFACE
}

unsafe extern "system" fn proxy_add_ref(this: *mut c_void) -> u32 {
    proxy_ref(this).refs.fetch_add(1, Ordering::AcqRel) + 1
}

unsafe extern "system" fn proxy_release(this: *mut c_void) -> u32 {
    let proxy = proxy_ref(this);
    let left = proxy.refs.fetch_sub(1, Ordering::AcqRel) - 1;
    if left == 0 {
        {
            let mut registry = locked(registry());
            if registry.by_identity.get(&proxy.identity) == Some(&(this as usize)) {
                registry.by_identity.remove(&proxy.identity);
            }
        }
        // SAFETY: the count reached zero, so nothing else holds the proxy; it was made by `Box::into_raw`, and it owns
        // the reference to the real object.
        unsafe {
            let boxed = Box::from_raw(this as *mut Proxy);
            release(boxed.real);
        }
    }
    left
}

unsafe extern "system" fn proxy_get_type_info_count(this: *mut c_void, count: *mut u32) -> i32 {
    let real = proxy_ref(this).real;
    // SAFETY: the proxy holds a reference to the real object; the argument is the caller's.
    unsafe { (vtbl::<IDispatchVtbl>(real).get_type_info_count)(real, count) }
}

unsafe extern "system" fn proxy_get_type_info(this: *mut c_void, index: u32, lcid: u32, out: *mut *mut c_void) -> i32 {
    let real = proxy_ref(this).real;
    // SAFETY: the proxy holds a reference to the real object; the arguments are the caller's.
    unsafe { (vtbl::<IDispatchVtbl>(real).get_type_info)(real, index, lcid, out) }
}

unsafe extern "system" fn proxy_get_ids_of_names(this: *mut c_void, riid: *const Guid, names: *const *const u16, count: u32, lcid: u32, dispids: *mut i32) -> i32 {
    let proxy = proxy_ref(this);
    // SAFETY: the proxy holds a reference to the real object; the arguments are the caller's.
    let hr = unsafe { (vtbl::<IDispatchVtbl>(proxy.real).get_ids_of_names)(proxy.real, riid, names, count, lcid, dispids) };
    // SAFETY: `names` holds `count` NUL-terminated strings, as IDispatch requires.
    let listed: Vec<String> = (0..count as usize).map(|index| unsafe { crate::read_wide(*names.add(index)) }).collect();
    if hr == DISP_E_UNKNOWNNAME {
        let member = listed.first().cloned().unwrap_or_default();
        let lookups = std::mem::take(&mut *locked(&proxy.lookups));
        log_call(CallEntry {
            seq: 0,
            obj: proxy.id,
            kind: Kind::Get,
            member,
            flags: 0,
            lcid: Some(lcid),
            dispid: None,
            args: Vec::new(),
            named: Vec::new(),
            value: None,
            outcome: Outcome::Error(error_record(errtext::unknown_member(hr))),
        }, lookups);
    } else if hr >= 0 {
        // SAFETY: on success `dispids` holds `count` DISPIDs.
        let ids: Vec<i32> = (0..count as usize).map(|index| unsafe { *dispids.add(index) }).collect();
        locked(&proxy.lookups).push(json!({"names": listed, "dispids": ids, "lcid": lcid}));
    } else {
        locked(&proxy.lookups).push(json!({"names": listed, "hresult": hr, "lcid": lcid}));
    }
    hr
}

fn error_record(error: mixdog_office_com::com::ComError) -> ErrorRecord {
    ErrorRecord {
        hresult: error.hresult,
        inner_hresult: error.inner_hresult,
        message: error.message,
        inner_message: error.inner_message,
        unknown_member: error.unknown_member,
    }
}

/// Writes one call line, with the lookups that led to it.
fn log_call(entry: CallEntry, lookups: Vec<Json>) {
    emit_with(|seq| {
        let mut entry = entry;
        entry.seq = seq;
        let mut line = entry_line(&Entry::Call(entry));
        if !lookups.is_empty()
            && let Json::Object(object) = &mut line
        {
            object.insert("lookups".into(), Json::Array(lookups));
        }
        line
    });
}

/// Every name the type information gives a member (the member first, then its parameters), cached per DISPID.
fn type_names(proxy: &Proxy, memid: i32) -> Vec<String> {
    if let Some(known) = locked(&proxy.names).get(&memid) {
        return known.clone();
    }
    let names = read_type_names(proxy.real, memid).unwrap_or_default();
    locked(&proxy.names).insert(memid, names.clone());
    names
}

fn read_type_names(real: *mut c_void, memid: i32) -> Option<Vec<String>> {
    let mut info: *mut c_void = ptr::null_mut();
    // SAFETY: `real` is a valid IDispatch the proxy holds; `info` receives an owned ITypeInfo on success.
    let hr = unsafe { (vtbl::<IDispatchVtbl>(real).get_type_info)(real, 0, 0, &mut info) };
    if hr < 0 || info.is_null() {
        return None;
    }
    let mut buffer = [ptr::null_mut::<u16>(); 32];
    let mut count = 0u32;
    // SAFETY: `info` is the owned ITypeInfo; `buffer` has room for the 32 names asked for; each BSTR the call stores is
    // read and freed here, and the interface is released.
    unsafe {
        let hr = (vtbl::<ITypeInfoVtbl>(info).get_names)(info, memid, buffer.as_mut_ptr(), buffer.len() as u32, &mut count);
        let names = if hr >= 0 {
            let mut names = Vec::new();
            for slot in buffer.iter().take(count as usize) {
                names.push(read_bstr(*slot));
                SysFreeString(*slot);
            }
            Some(names)
        } else {
            None
        };
        release(info);
        names
    }
}

/// The Invoke kind of the flags.
fn kind_of(flags: u32) -> Kind {
    if flags & DISPATCH_PROPERTYPUTREF != 0 {
        Kind::PutRef
    } else if flags & DISPATCH_PROPERTYPUT != 0 {
        Kind::Put
    } else if flags & DISPATCH_METHOD != 0 {
        Kind::Call
    } else {
        Kind::Get
    }
}

/// Which `rgvarg` slots are what, in the order the host wrote them.
#[derive(Debug, PartialEq, Eq)]
struct Split {
    /// The positional arguments, first written first.
    positional: Vec<usize>,
    /// The named arguments, first written first, with their DISPIDs.
    named: Vec<(usize, i32)>,
    /// The assigned value of a put.
    value: Option<usize>,
}

/// `DISPPARAMS` puts the named arguments first and then the positional ones, each group last written first.
fn split(argument_count: usize, named_ids: &[i32]) -> Split {
    let named_count = named_ids.len().min(argument_count);
    let mut result = Split { positional: (named_count..argument_count).rev().collect(), named: Vec::new(), value: None };
    for slot in (0..named_count).rev() {
        if named_ids[slot] == DISPID_PROPERTYPUT {
            result.value = Some(slot);
        } else {
            result.named.push((slot, named_ids[slot]));
        }
    }
    result
}

/// The typed JSON of the VARIANTs of a call and of its result. Objects are named by id.
struct Encoder<'a> {
    holds: &'a mut Vec<*mut c_void>,
}

/// The scalar a VARIANT holds (the types `live::from_variant` reads), `None` for any other type.
///
/// # Safety
/// `variant` is initialised and, when by reference, points at a value of its type.
unsafe fn scalar(variant: &Variant) -> Option<Value> {
    let byref = variant.vt & VT_BYREF != 0;
    let base = variant.vt & VT_TYPEMASK;
    // SAFETY: the union member read is the one `vt` names, and a by-reference pointer is the pointer to a value of that
    // type the owner of the VARIANT supplied.
    unsafe {
        let data = &variant.data;
        let place = data.ptr as *const u8;
        Some(match base {
            VT_EMPTY => Value::Empty,
            VT_NULL => Value::Null,
            VT_I2 => Value::I2(if byref { *(place as *const i16) } else { data.i }),
            VT_I4 | VT_INT => Value::I4(if byref { *(place as *const i32) } else { data.l }),
            VT_R4 => Value::R4(if byref { *(place as *const f32) } else { data.flt }),
            VT_R8 => Value::R8(if byref { *(place as *const f64) } else { data.dbl }),
            VT_CY => Value::Currency(if byref { *(place as *const i64) } else { data.cy }),
            VT_DATE => Value::Date(if byref { *(place as *const f64) } else { data.date }),
            VT_BSTR => Value::Str(read_bstr(if byref { *(place as *const *const u16) } else { data.ptr as *const u16 })),
            VT_ERROR => {
                let scode = if byref { *(place as *const i32) } else { data.scode };
                if scode == DISP_E_PARAMNOTFOUND { Value::Missing } else { Value::Error(scode) }
            }
            VT_BOOL => Value::Bool((if byref { *(place as *const i16) } else { data.boolean }) != 0),
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
            _ => return None,
        })
    }
}

/// The size of one element of a `SAFEARRAY` of `vt`, for the types a host passes or reads.
fn element_size(vt: u16) -> Option<usize> {
    Some(match vt {
        VT_I1 | VT_UI1 => 1,
        VT_I2 | VT_UI2 | VT_BOOL => 2,
        VT_I4 | VT_UI4 | VT_INT | VT_UINT | VT_R4 | VT_ERROR => 4,
        VT_I8 | VT_UI8 | VT_R8 | VT_CY | VT_DATE => 8,
        VT_BSTR | VT_DISPATCH | VT_UNKNOWN => size_of::<usize>(),
        VT_DECIMAL => 16,
        VT_VARIANT => size_of::<Variant>(),
        _ => return None,
    })
}

impl Encoder<'_> {
    /// A VARIANT as the typed JSON of the call log (`encode_value`'s tags, `obj`/`unknown` carrying the object's id).
    ///
    /// # Safety
    /// `variant` is initialised and, when by reference, points at a value of its type.
    unsafe fn encode(&mut self, variant: &Variant) -> Json {
        let byref = variant.vt & VT_BYREF != 0;
        let vt = variant.vt & !VT_BYREF;
        // SAFETY: the union member read is the one `vt` names; a by-reference pointer is the owner's.
        unsafe {
            if vt & VT_ARRAY != 0 {
                let array = if byref { *(variant.data.ptr as *const *mut c_void) } else { variant.data.ptr };
                return if array.is_null() { json!({"t": "null"}) } else { self.encode_array(array) };
            }
            let base = vt & VT_TYPEMASK;
            if byref && base == VT_VARIANT {
                let inner = variant.data.ptr as *const Variant;
                return if inner.is_null() { json!({"t": "null"}) } else { self.encode(&*inner) };
            }
            if base == VT_DISPATCH || base == VT_UNKNOWN {
                let raw = if byref { *(variant.data.ptr as *const *mut c_void) } else { variant.data.ptr };
                if raw.is_null() {
                    return json!({"t": "null"});
                }
                let id = object_id(raw, self.holds);
                let tag = if base == VT_DISPATCH { "obj" } else { "unknown" };
                return json!({"t": tag, "v": id});
            }
            match scalar(variant) {
                Some(value) => encode_value(&value, &|_| 0),
                None => json!({"t": "unsupported", "vt": variant.vt}),
            }
        }
    }

    /// A `SAFEARRAY`: `{"t":"array","dims":[[lbound,len],...],"data":[...]}`, the data in storage order.
    ///
    /// # Safety
    /// `array` is a valid `SAFEARRAY`.
    unsafe fn encode_array(&mut self, array: *mut c_void) -> Json {
        // SAFETY: `array` is valid; the data pointer is only used between `SafeArrayAccessData` and
        // `SafeArrayUnaccessData`, within the element count the bounds give.
        unsafe {
            let rank = SafeArrayGetDim(array);
            let mut dims = Vec::new();
            for dim in 1..=rank {
                let (mut lower, mut upper) = (0i32, 0i32);
                if SafeArrayGetLBound(array, dim, &mut lower) < 0 || SafeArrayGetUBound(array, dim, &mut upper) < 0 {
                    return json!({"t": "unsupported", "vt": VT_ARRAY});
                }
                let len = if upper < lower { 0 } else { (i64::from(upper) - i64::from(lower) + 1) as u32 };
                dims.push((lower, len));
            }
            let count = dims.iter().map(|(_, len)| *len as usize).product::<usize>();
            let mut vt = 0u16;
            if SafeArrayGetVartype(array, &mut vt) < 0 {
                return json!({"t": "unsupported", "vt": VT_ARRAY});
            }
            let mut data: *mut c_void = ptr::null_mut();
            if count > 0 && SafeArrayAccessData(array, &mut data) < 0 {
                return json!({"t": "unsupported", "vt": VT_ARRAY | vt});
            }
            let mut items = Vec::with_capacity(count);
            for index in 0..count {
                items.push(match (vt, element_size(vt)) {
                    (VT_VARIANT, _) => self.encode(&*(data as *const Variant).add(index)),
                    (_, Some(size)) => {
                        let element = Variant {
                            vt: vt | VT_BYREF,
                            reserved1: 0,
                            reserved2: 0,
                            reserved3: 0,
                            data: VariantData { ptr: (data as *mut u8).add(index * size).cast() },
                        };
                        self.encode(&element)
                    }
                    _ => json!({"t": "unsupported", "vt": vt}),
                });
            }
            if count > 0 {
                SafeArrayUnaccessData(array);
            }
            json!({"t": "array", "dims": dims.iter().map(|(lower, len)| json!([lower, len])).collect::<Vec<_>>(), "data": items})
        }
    }
}

/// Replaces the object in `variant` by the proxy of its identity, in place; an array of VARIANT is walked.
///
/// # Safety
/// `variant` is an initialised VARIANT the caller owns.
unsafe fn wrap_variant(variant: &mut Variant) {
    // SAFETY: the union member read is the one `vt` names; the objects are owned references the VARIANT holds, one
    // given back for the one the proxy took.
    unsafe {
        if let Some(object) = variant.object() {
            let proxy = wrap_object(object);
            if !proxy.is_null() {
                release(object);
                variant.data.ptr = proxy;
            }
        } else if variant.vt == VT_ARRAY | VT_VARIANT {
            for_each_element(variant.data.ptr, |element| wrap_variant(element));
        }
    }
}

/// Calls `visit` with every VARIANT of a `SAFEARRAY` of VARIANT.
///
/// # Safety
/// `array` is null or a valid `SAFEARRAY` of VARIANT.
unsafe fn for_each_element(array: *mut c_void, mut visit: impl FnMut(&mut Variant)) {
    if array.is_null() {
        return;
    }
    // SAFETY: `array` is valid; the data pointer is used only between access and unaccess, within the bounds' count.
    unsafe {
        let mut count = 1usize;
        for dim in 1..=SafeArrayGetDim(array) {
            let (mut lower, mut upper) = (0i32, 0i32);
            if SafeArrayGetLBound(array, dim, &mut lower) < 0 || SafeArrayGetUBound(array, dim, &mut upper) < 0 {
                return;
            }
            count *= if upper < lower { 0 } else { (i64::from(upper) - i64::from(lower) + 1) as usize };
        }
        let mut data: *mut c_void = ptr::null_mut();
        if count == 0 || SafeArrayAccessData(array, &mut data) < 0 {
            return;
        }
        for index in 0..count {
            visit(&mut *(data as *mut Variant).add(index));
        }
        SafeArrayUnaccessData(array);
    }
}

/// The real object behind a proxy pointer, any other pointer as it is.
fn unwrap_pointer(pointer: *mut c_void) -> *mut c_void {
    if is_proxy(pointer) { proxy_ref(pointer).real } else { pointer }
}

/// The arguments of a call with the proxies replaced by the real objects. The caller's VARIANTs are copied (shallowly:
/// the pointers are borrowed for the call), so nothing the caller owns is written to; what this makes (a by-reference
/// slot, a copied array) is held here and released when it is dropped.
#[allow(clippy::vec_box)] // `args` points into each boxed slot: the boxes keep those addresses fixed while the vectors grow
struct Forward {
    args: Vec<Variant>,
    slots: Vec<Box<*mut c_void>>,
    inner: Vec<Box<Variant>>,
    arrays: Vec<*mut c_void>,
}

impl Forward {
    /// # Safety
    /// `source` are initialised VARIANTs, by-reference ones pointing at values of their types.
    unsafe fn build(source: &[Variant]) -> Forward {
        let mut forward = Forward { args: source.to_vec(), slots: Vec::new(), inner: Vec::new(), arrays: Vec::new() };
        for index in 0..forward.args.len() {
            // SAFETY: forwarded from the caller's guarantee.
            unsafe { forward.unwrap_at(index) };
        }
        forward
    }

    /// # Safety
    /// As [`Forward::build`].
    unsafe fn unwrap_at(&mut self, index: usize) {
        let variant = self.args[index];
        // SAFETY: the union member read is the one `vt` names; a by-reference pointer is the owner's.
        unsafe {
            if variant.vt == VT_DISPATCH || variant.vt == VT_UNKNOWN {
                if is_proxy(variant.data.ptr) {
                    self.args[index].data.ptr = unwrap_pointer(variant.data.ptr);
                }
            } else if variant.vt == VT_BYREF | VT_DISPATCH || variant.vt == VT_BYREF | VT_UNKNOWN {
                let place = variant.data.ptr as *const *mut c_void;
                if !place.is_null() && is_proxy(*place) {
                    let mut slot = Box::new(unwrap_pointer(*place));
                    self.args[index].data.ptr = (&mut *slot as *mut *mut c_void).cast();
                    self.slots.push(slot);
                }
            } else if variant.vt == VT_BYREF | VT_VARIANT {
                let inner = variant.data.ptr as *const Variant;
                if !inner.is_null() && let Some(object) = (*inner).object() && is_proxy(object) {
                    let mut copy = Box::new(*inner);
                    copy.data.ptr = unwrap_pointer(object);
                    self.args[index].data.ptr = (&mut *copy as *mut Variant).cast();
                    self.inner.push(copy);
                }
            } else if variant.vt == VT_ARRAY | VT_VARIANT {
                self.unwrap_array(index, variant.data.ptr);
            }
        }
    }

    /// A `SAFEARRAY` of VARIANT that holds a proxy is copied, and the copy's proxies are swapped for the real objects.
    ///
    /// # Safety
    /// `array` is a valid `SAFEARRAY` of VARIANT.
    unsafe fn unwrap_array(&mut self, index: usize, array: *mut c_void) {
        let mut any = false;
        // SAFETY: `array` is valid; the callbacks only read.
        unsafe { for_each_element(array, |element| any |= element.object().is_some_and(is_proxy)) };
        if !any {
            return;
        }
        let mut copy: *mut c_void = ptr::null_mut();
        // SAFETY: `array` is valid; the copy is an owned array whose elements hold their own references.
        unsafe {
            if SafeArrayCopy(array, &mut copy) < 0 || copy.is_null() {
                return;
            }
            for_each_element(copy, |element| {
                if let Some(object) = element.object()
                    && is_proxy(object)
                {
                    let real = unwrap_pointer(object);
                    add_ref(real);
                    release(object);
                    element.data.ptr = real;
                }
            });
        }
        self.args[index].data.ptr = copy;
        self.arrays.push(copy);
    }
}

impl Drop for Forward {
    fn drop(&mut self) {
        for array in &self.arrays {
            // SAFETY: each array is the owned copy `unwrap_array` made; destroying it releases its elements.
            unsafe { SafeArrayDestroy(*array) };
        }
    }
}

/// What `Invoke` was called with.
struct InvokeCall {
    dispid: i32,
    riid: *const Guid,
    lcid: u32,
    flags: u16,
    params: *mut DispParams,
    result: *mut Variant,
    excep: *mut ExcepInfo,
    arg_error: *mut u32,
}

#[allow(clippy::too_many_arguments)] // the fixed IDispatch::Invoke signature
unsafe extern "system" fn proxy_invoke(
    this: *mut c_void,
    dispid: i32,
    riid: *const Guid,
    lcid: u32,
    flags: u16,
    params: *mut DispParams,
    result: *mut Variant,
    excep: *mut ExcepInfo,
    arg_error: *mut u32,
) -> i32 {
    let call = InvokeCall { dispid, riid, lcid, flags, params, result, excep, arg_error };
    // SAFETY: the caller of Invoke guarantees the structures it passes; `this` is a proxy.
    unsafe { invoke(proxy_ref(this), &call) }
}

/// # Safety
/// The pointers of `call` are what an `IDispatch::Invoke` caller passes: null or valid.
unsafe fn invoke(proxy: &Proxy, call: &InvokeCall) -> i32 {
    let flags = u32::from(call.flags);
    let mut holds: Vec<*mut c_void> = Vec::new();
    // SAFETY: `params` is null or a valid DISPPARAMS whose `rgvarg` holds `c_args` VARIANTs and whose named-argument
    // array holds `c_named_args` DISPIDs.
    let (source, named_ids): (&[Variant], &[i32]) = unsafe {
        match call.params.as_ref() {
            Some(params) if params.c_args > 0 && !params.rgvarg.is_null() => (
                std::slice::from_raw_parts(params.rgvarg, params.c_args as usize),
                if params.c_named_args > 0 && !params.rgdispid_named_args.is_null() {
                    std::slice::from_raw_parts(params.rgdispid_named_args, params.c_named_args as usize)
                } else {
                    &[] as &[i32]
                },
            ),
            _ => (&[] as &[Variant], &[] as &[i32]),
        }
    };
    let enumeration = call.dispid == DISPID_NEWENUM && flags & (DISPATCH_METHOD | DISPATCH_PROPERTYGET) != 0;
    let kind = kind_of(flags);
    let names = if enumeration { Vec::new() } else { type_names(proxy, call.dispid) };
    let member = if enumeration { "GetEnumerator".to_owned() } else { names.first().cloned().unwrap_or_else(|| format!("dispid:{}", call.dispid)) };

    // What the host wrote, as typed values, before any proxy is swapped for its object.
    let layout = split(source.len(), named_ids);
    let (args, named, value) = {
        let mut encoder = Encoder { holds: &mut holds };
        // SAFETY: the VARIANTs are the caller's, initialised for the call.
        unsafe {
            let args: Vec<Json> = layout.positional.iter().map(|slot| encoder.encode(&source[*slot])).collect();
            // A named argument's DISPID is the index of its parameter: the name after the member's own.
            let parameter = |id: i32| usize::try_from(id).ok().and_then(|index| names.get(index + 1)).cloned().unwrap_or_else(|| format!("arg{id}"));
            let named: Vec<(String, Json)> = layout.named.iter().map(|(slot, id)| (parameter(*id), encoder.encode(&source[*slot]))).collect();
            let value = layout.value.map(|slot| encoder.encode(&source[slot]));
            (args, named, value)
        }
    };

    // SAFETY: the VARIANTs are the caller's, initialised for the call.
    let mut forward = unsafe { Forward::build(source) };
    let mut params = DispParams {
        rgvarg: if forward.args.is_empty() { ptr::null_mut() } else { forward.args.as_mut_ptr() },
        rgdispid_named_args: if named_ids.is_empty() { ptr::null_mut() } else { named_ids.as_ptr().cast_mut() },
        c_args: forward.args.len() as u32,
        c_named_args: named_ids.len() as u32,
    };
    let params_pointer = if call.params.is_null() { ptr::null_mut() } else { &mut params as *mut DispParams };
    let mut local_result = Variant::empty();
    let result_pointer = if call.result.is_null() { &mut local_result as *mut Variant } else { call.result };
    // SAFETY: an all-zero EXCEPINFO is the empty one (null pointers, no deferred fill-in).
    let mut local_excep: ExcepInfo = unsafe { std::mem::zeroed() };

    // SAFETY: the proxy holds a reference to the real object; every pointer lives through the call.
    let hr = unsafe {
        (vtbl::<IDispatchVtbl>(proxy.real).invoke)(proxy.real, call.dispid, call.riid, call.lcid, call.flags, params_pointer, result_pointer, &mut local_excep, call.arg_error)
    };

    let mut description = None;
    let mut code = 0;
    if hr == DISP_E_EXCEPTION {
        // SAFETY: the callee filled `local_excep`; a deferred fill-in is called once, with the same structure, and the
        // BSTRs are the caller's to free (moved to its EXCEPINFO) or freed here when it passed none.
        unsafe {
            if let Some(fill) = local_excep.pfn_deferred_fill_in.take() {
                fill(&mut local_excep);
            }
            description = (!local_excep.bstr_description.is_null()).then(|| read_bstr(local_excep.bstr_description));
            code = if local_excep.scode != 0 { local_excep.scode } else { i32::from(local_excep.w_code) };
            if call.excep.is_null() {
                SysFreeString(local_excep.bstr_source);
                SysFreeString(local_excep.bstr_description);
                SysFreeString(local_excep.bstr_help_file);
            } else {
                *call.excep = local_excep;
            }
        }
    }

    let lookups = std::mem::take(&mut *locked(&proxy.lookups));
    let outcome = if enumeration {
        if hr >= 0 {
            // SAFETY: on success `result_pointer` holds an initialised VARIANT; the enumerator replaces the object in it.
            unsafe { wrap_enumeration(&mut *result_pointer, proxy.id) };
            None
        } else {
            let raw = Raw { hresult: if hr == DISP_E_EXCEPTION && code != 0 { code } else { hr }, description: description.clone() };
            Some(Outcome::Error(error_record(errtext::com_error(Access::Method { name: "GetEnumerator", argc: 0 }, &raw, &system_text))))
        }
    } else if hr >= 0 {
        // SAFETY: on success `result_pointer` holds an initialised VARIANT.
        let json = unsafe {
            wrap_variant(&mut *result_pointer);
            Encoder { holds: &mut holds }.encode(&*result_pointer)
        };
        Some(Outcome::Result(json))
    } else if hr == DISP_E_MEMBERNOTFOUND || hr == DISP_E_UNKNOWNNAME {
        Some(Outcome::Error(error_record(errtext::unknown_member(hr))))
    } else {
        let raw = Raw { hresult: if hr == DISP_E_EXCEPTION && code != 0 { code } else { hr }, description };
        let access = match kind {
            Kind::Put | Kind::PutRef => Access::Set { name: &member },
            Kind::Call => Access::Method { name: &member, argc: args.len() + named.len() },
            Kind::Get | Kind::EnumNext if args.is_empty() => Access::Get { name: &member },
            Kind::Get | Kind::EnumNext => Access::Method { name: &member, argc: args.len() },
        };
        Some(Outcome::Error(error_record(errtext::com_error(access, &raw, &system_text))))
    };
    if let Some(outcome) = outcome {
        let kind = if enumeration { Kind::EnumNext } else { kind };
        let (args, named, value) = if enumeration { (Vec::new(), Vec::new(), None) } else { (args, named, value) };
        log_call(CallEntry {
            seq: 0,
            obj: proxy.id,
            kind,
            member: if enumeration { String::new() } else { member },
            flags: if enumeration { 0 } else { flags },
            lcid: Some(call.lcid),
            dispid: Some(call.dispid),
            args,
            named,
            value,
            outcome,
        }, lookups);
    }
    if call.result.is_null() {
        // SAFETY: the VARIANT was initialised by the call (or is empty) and is owned here.
        unsafe { VariantClear(&mut local_result) };
    }
    for held in holds {
        // SAFETY: each is a proxy reference `object_id` made for this call.
        unsafe { release(held) };
    }
    drop(forward);
    hr
}

/// The enumerator a `DISPID_NEWENUM` call answered, replaced in place by the proxy of its `IEnumVARIANT`.
///
/// # Safety
/// `variant` is an initialised VARIANT the caller owns.
unsafe fn wrap_enumeration(variant: &mut Variant, owner: u64) {
    if let Some(object) = variant.object() {
        // SAFETY: `object` is the reference the VARIANT holds; the proxy takes its own.
        unsafe {
            let proxy = enumproxy::wrap(object, owner);
            if !proxy.is_null() {
                release(object);
                variant.data.ptr = proxy;
            }
        }
    }
}

/// Wraps an item an enumerator gave, in place, and encodes it (an object by its proxy's id).
///
/// # Safety
/// `variant` is an initialised VARIANT the caller owns.
pub(crate) unsafe fn wrap_and_encode(variant: &mut Variant) -> Json {
    let mut holds = Vec::new();
    // SAFETY: forwarded from the caller's guarantee.
    let json = unsafe {
        wrap_variant(variant);
        Encoder { holds: &mut holds }.encode(variant)
    };
    for held in holds {
        // SAFETY: each is a proxy reference `object_id` made here.
        unsafe { release(held) };
    }
    json
}

/// The call-log line of one failed or finished `Next` of an enumerator, written by [`enumproxy`].
pub(crate) fn log_enum_next(owner: u64, outcome: Outcome) {
    emit_with(|seq| {
        entry_line(&Entry::Call(CallEntry {
            seq,
            obj: owner,
            kind: Kind::EnumNext,
            member: String::new(),
            flags: 0,
            lcid: None,
            dispid: None,
            args: Vec::new(),
            named: Vec::new(),
            value: None,
            outcome,
        }))
    });
}

/// The failure of an enumerator's `Next`, as PowerShell's `MoveNext` shows it.
pub(crate) fn enum_error(hresult: i32) -> Outcome {
    let raw = Raw { hresult, description: None };
    Outcome::Error(error_record(errtext::com_error(Access::Method { name: "MoveNext", argc: 0 }, &raw, &system_text)))
}

#[cfg(test)]
mod tests {
    use mixdog_office_com::com::calllog::CallLog;

    use super::*;
    use crate::CAPTURE;

    /// A real object stand-in: an `IDispatch` of the C ABI whose members are `1` (answers an I4 of 42) and `2` (answers
    /// another object), and that has no type information.
    #[allow(dead_code)] // `vtbl` is the first word of the object: COM reads it, this code never does
    #[repr(C)]
    struct Fake {
        vtbl: *const IDispatchVtbl,
        refs: AtomicU32,
        other: *mut c_void,
    }

    unsafe extern "system" fn fake_qi(this: *mut c_void, iid: *const Guid, out: *mut *mut c_void) -> i32 {
        // SAFETY: the test passes valid pointers.
        unsafe {
            if *iid == IID_IUNKNOWN || *iid == IID_IDISPATCH {
                fake_add_ref(this);
                *out = this;
                return S_OK;
            }
            *out = ptr::null_mut();
        }
        E_NOINTERFACE
    }

    unsafe extern "system" fn fake_add_ref(this: *mut c_void) -> u32 {
        // SAFETY: `this` is a `Fake`.
        unsafe { &*(this as *const Fake) }.refs.fetch_add(1, Ordering::AcqRel) + 1
    }

    unsafe extern "system" fn fake_release(this: *mut c_void) -> u32 {
        // SAFETY: `this` is a `Fake`.
        unsafe { &*(this as *const Fake) }.refs.fetch_sub(1, Ordering::AcqRel) - 1
    }

    unsafe extern "system" fn fake_count(_: *mut c_void, count: *mut u32) -> i32 {
        // SAFETY: the test passes a valid pointer.
        unsafe { *count = 0 };
        0
    }

    unsafe extern "system" fn fake_info(_: *mut c_void, _: u32, _: u32, _: *mut *mut c_void) -> i32 {
        0x8000_4001_u32 as i32
    }

    unsafe extern "system" fn fake_ids(_: *mut c_void, _: *const Guid, _: *const *const u16, _: u32, _: u32, _: *mut i32) -> i32 {
        DISP_E_UNKNOWNNAME
    }

    #[allow(clippy::too_many_arguments)] // the fixed IDispatch::Invoke signature
    unsafe extern "system" fn fake_invoke(this: *mut c_void, dispid: i32, _: *const Guid, _: u32, _: u16, params: *mut DispParams, result: *mut Variant, _: *mut ExcepInfo, _: *mut u32) -> i32 {
        // SAFETY: the test passes valid structures.
        unsafe {
            let fake = &*(this as *const Fake);
            match dispid {
                1 => {
                    let arguments = (*params).c_args;
                    (*result) = Variant::int(42 + arguments as i32);
                    0
                }
                2 => {
                    add_ref(fake.other);
                    (*result) = Variant::unknown(fake.other);
                    0
                }
                _ => DISP_E_MEMBERNOTFOUND,
            }
        }
    }

    static FAKE_VTBL: IDispatchVtbl = IDispatchVtbl {
        base: IUnknownVtbl { query_interface: fake_qi, add_ref: fake_add_ref, release: fake_release },
        get_type_info_count: fake_count,
        get_type_info: fake_info,
        get_ids_of_names: fake_ids,
        invoke: fake_invoke,
    };

    fn fake(other: *mut c_void) -> Box<Fake> {
        Box::new(Fake { vtbl: &FAKE_VTBL, refs: AtomicU32::new(1), other })
    }

    fn pointer(fake: &mut Fake) -> *mut c_void {
        (fake as *mut Fake).cast()
    }

    fn capture<T>(body: impl FnOnce() -> T) -> (T, Vec<String>) {
        CAPTURE.with(|capture| *capture.borrow_mut() = Some(Vec::new()));
        let value = body();
        let lines = CAPTURE.with(|capture| capture.borrow_mut().take()).unwrap_or_default();
        (value, lines)
    }

    fn invoke_member(proxy: *mut c_void, dispid: i32, flags: u16, arguments: &mut [Variant]) -> (i32, Variant) {
        let mut params = DispParams { rgvarg: arguments.as_mut_ptr(), rgdispid_named_args: ptr::null_mut(), c_args: arguments.len() as u32, c_named_args: 0 };
        let mut result = Variant::empty();
        // SAFETY: a zeroed EXCEPINFO is the empty one; the pointers live through the call; `proxy` is a proxy.
        unsafe {
            let mut excep: ExcepInfo = std::mem::zeroed();
            let mut arg_error = 0u32;
            let hr = (vtbl::<IDispatchVtbl>(proxy).invoke)(proxy, dispid, &IID_NULL, 0, flags, &mut params, &mut result, &mut excep, &mut arg_error);
            (hr, result)
        }
    }

    #[test]
    fn named_and_positional_arguments_come_back_in_the_order_the_host_wrote_them() {
        // Call Method(a, b, Name1: c, Name2: d): DISPPARAMS holds d, c (named, last first), then b, a.
        assert_eq!(
            split(4, &[7, 5]),
            Split { positional: vec![3, 2], named: vec![(1, 5), (0, 7)], value: None }
        );
        // A put: the value is the named DISPID_PROPERTYPUT slot, the index arguments follow reversed.
        assert_eq!(split(3, &[DISPID_PROPERTYPUT]), Split { positional: vec![2, 1], named: vec![], value: Some(0) });
        assert_eq!(split(0, &[]), Split { positional: vec![], named: vec![], value: None });
    }

    #[test]
    fn flags_pick_the_kind() {
        assert_eq!(kind_of(2), Kind::Get);
        assert_eq!(kind_of(1), Kind::Call);
        assert_eq!(kind_of(3), Kind::Call);
        assert_eq!(kind_of(4), Kind::Put);
        assert_eq!(kind_of(8), Kind::PutRef);
    }

    #[test]
    fn one_proxy_stands_for_one_identity_until_its_count_reaches_zero() {
        let mut real = fake(ptr::null_mut());
        let object = pointer(&mut real);
        // SAFETY: `object` is a valid fake object; every proxy reference taken is released.
        unsafe {
            let ((first, second), _) = capture(|| (wrap_object(object), wrap_object(object)));
            assert!(!first.is_null());
            assert_eq!(first, second, "the same identity gets the same proxy");
            assert!(is_proxy(first));
            assert_eq!(wrap_object(first), first, "a proxy is wrapped as itself");
            assert_eq!(release(first), 2);
            assert_eq!(release(first), 1);
            let id = proxy_ref(first).id;
            assert_eq!(release(first), 0);
            // The last reference is gone: the real object's reference count shows the proxy released its hold.
            assert_eq!(real.refs.load(Ordering::Acquire), 1);
            let again = wrap_object(object);
            assert_ne!(proxy_ref(again).id, id, "a new proxy is a new object id");
            release(again);
        }
    }

    #[test]
    fn a_call_is_forwarded_and_logged_with_its_result_and_an_object_by_id() {
        let mut other = fake(ptr::null_mut());
        let other_pointer = pointer(&mut other);
        let mut real = fake(other_pointer);
        let object = pointer(&mut real);
        let ((), lines) = capture(|| {
            // SAFETY: valid fakes; every reference taken is released.
            unsafe {
                let proxy = wrap_object(object);
                let (hr, answer) = invoke_member(proxy, 1, 1, &mut [Variant::int(5)]);
                assert_eq!(hr, 0);
                assert_eq!(answer.data.l, 43);
                let (hr, answer) = invoke_member(proxy, 2, 2, &mut []);
                assert_eq!(hr, 0);
                let wrapped = answer.data.ptr;
                assert!(is_proxy(wrapped), "an object in a result is a proxy");
                assert_eq!(answer.vt, VT_UNKNOWN, "the type of the result is kept");
                let (hr, _) = invoke_member(proxy, 9, 2, &mut []);
                assert_eq!(hr, DISP_E_MEMBERNOTFOUND);
                release(wrapped);
                release(proxy);
            }
        });
        let log = CallLog::parse(&lines.join("\n")).expect("the lines are a call log");
        assert_eq!(log.entries.len(), 3);
        assert!(lines[0].contains("\"args\":[{\"t\":\"i4\",\"v\":5}]"), "{}", lines[0]);
        assert!(lines[0].contains("\"result\":{\"t\":\"i4\",\"v\":43}"), "{}", lines[0]);
        assert!(lines[1].contains("\"t\":\"unknown\""), "{}", lines[1]);
        assert!(lines[2].contains("\"unknown_member\":true"), "{}", lines[2]);
        let _ = (&other, &real);
    }

    #[test]
    fn a_proxy_in_an_argument_reaches_the_real_object() {
        let mut inner = fake(ptr::null_mut());
        let inner_pointer = pointer(&mut inner);
        let mut real = fake(ptr::null_mut());
        let object = pointer(&mut real);
        // SAFETY: valid fakes; every reference taken is released.
        unsafe {
            let (inner_proxy, _) = capture(|| wrap_object(inner_pointer));
            let mut slot = Variant::unknown(inner_proxy);
            slot.vt = VT_DISPATCH;
            let forward = Forward::build(&[slot]);
            assert_eq!(forward.args[0].data.ptr, inner_pointer, "the real object is what goes out");
            assert_eq!(slot.data.ptr, inner_proxy, "the caller's VARIANT is not written to");
            drop(forward);
            release(inner_proxy);
            let _ = object;
        }
    }

    #[test]
    fn a_scalar_and_an_array_are_typed_like_the_call_log_says() {
        let mut holds = Vec::new();
        let mut encoder = Encoder { holds: &mut holds };
        let text: Vec<u16> = "hi".encode_utf16().collect();
        // SAFETY: a BSTR made here is freed here; the VARIANTs are initialised.
        unsafe {
            let bstr = SysAllocStringLen(text.as_ptr(), 2);
            let variant = Variant { vt: VT_BSTR, reserved1: 0, reserved2: 0, reserved3: 0, data: VariantData { ptr: bstr.cast() } };
            assert_eq!(encoder.encode(&variant), json!({"t": "str", "v": "hi"}));
            SysFreeString(bstr);
            assert_eq!(encoder.encode(&Variant::int(7)), json!({"t": "i4", "v": 7}));
            let missing = Variant { vt: VT_ERROR, reserved1: 0, reserved2: 0, reserved3: 0, data: VariantData { scode: DISP_E_PARAMNOTFOUND } };
            assert_eq!(encoder.encode(&missing), json!({"t": "missing"}));
            assert_eq!(encoder.encode(&Variant::empty()), json!({"t": "empty"}));
        }
    }
}
