//! The `IEnumVARIANT` proxy: what a `DISPID_NEWENUM` call answers, wrapped so the items `Next` gives are recorded.
//!
//! The call that opened the enumeration is not a line of the recording (the replaying backend's `enum_open` is one
//! operation); each item `Next` gives is a call of kind `enum-next` on the id of the enumerated object, with the item
//! as the result (an object in it replaced by its proxy, so the host keeps one object per identity), and the end of the
//! enumeration (fewer items than asked for) is one more such line with a `null` result. A failure of `Next` is a line
//! with the error PowerShell's `MoveNext` shows. `Skip` and `Reset` are forwarded; `Clone` answers a proxy that
//! records under the same object id.

use std::ffi::c_void;
use std::ptr;
use std::sync::atomic::AtomicU32;
use std::sync::atomic::Ordering;

use mixdog_office_com::com::calllog::Outcome;

use crate::proxy::E_NOINTERFACE;
use crate::proxy::E_POINTER;
use crate::proxy::Guid;
use crate::proxy::IID_IENUMVARIANT;
use crate::proxy::IID_IUNKNOWN;
use crate::proxy::IUnknownVtbl;
use crate::proxy::S_OK;
use crate::proxy::Variant;
use crate::proxy::enum_error;
use crate::proxy::log_enum_next;
use crate::proxy::query;
use crate::proxy::release;
use crate::proxy::wrap_and_encode;

#[allow(dead_code)] // fields that only give the C structure its layout
#[repr(C)]
struct IEnumVariantVtbl {
    base: IUnknownVtbl,
    next: unsafe extern "system" fn(*mut c_void, u32, *mut Variant, *mut u32) -> i32,
    skip: unsafe extern "system" fn(*mut c_void, u32) -> i32,
    reset: unsafe extern "system" fn(*mut c_void) -> i32,
    clone: unsafe extern "system" fn(*mut c_void, *mut *mut c_void) -> i32,
}

/// The proxy of one enumerator. `vtbl` is first: a proxy pointer is an `IEnumVARIANT` pointer.
#[allow(dead_code)] // `vtbl` is the first word of the object: COM reads it, this code never does
#[repr(C)]
struct EnumProxy {
    vtbl: *const IEnumVariantVtbl,
    refs: AtomicU32,
    /// The real enumerator; one reference is held.
    real: *mut c_void,
    /// The id of the object that was enumerated.
    owner: u64,
}

static ENUM_VTBL: IEnumVariantVtbl = IEnumVariantVtbl {
    base: IUnknownVtbl { query_interface: enum_query_interface, add_ref: enum_add_ref, release: enum_release },
    next: enum_next,
    skip: enum_skip,
    reset: enum_reset,
    clone: enum_clone,
};

fn enum_ref<'a>(pointer: *mut c_void) -> &'a EnumProxy {
    // SAFETY: callers pass a proxy's own `this` or a pointer `owner_of` accepted, valid while a reference is held.
    unsafe { &*(pointer as *const EnumProxy) }
}

fn real_vtbl<'a>(real: *mut c_void) -> &'a IEnumVariantVtbl {
    // SAFETY: the proxy holds a reference to the real enumerator, whose first word is its vtable pointer.
    unsafe { &**(real as *const *const IEnumVariantVtbl) }
}

/// The id of the enumerated object when `pointer` is one of these proxies.
pub(crate) fn owner_of(pointer: *mut c_void) -> Option<u64> {
    // SAFETY: the first word of a COM interface pointer is its vtable pointer; only the address is compared.
    let ours = !pointer.is_null() && ptr::eq(unsafe { *(pointer as *const *const IEnumVariantVtbl) }, &ENUM_VTBL);
    ours.then(|| enum_ref(pointer).owner)
}

/// The proxy of the enumerator behind `object` (a `DISPID_NEWENUM` answer), recording under `owner`. It carries one
/// reference the caller releases; null when `object` is not an `IEnumVARIANT`.
///
/// # Safety
/// `object` is a valid COM interface pointer the caller holds a reference to.
pub(crate) unsafe fn wrap(object: *mut c_void, owner: u64) -> *mut c_void {
    // SAFETY: forwarded from the caller's guarantee; the queried reference is owned by the proxy.
    let Some(real) = (unsafe { query(object, &IID_IENUMVARIANT) }) else { return ptr::null_mut() };
    Box::into_raw(Box::new(EnumProxy { vtbl: &ENUM_VTBL, refs: AtomicU32::new(1), real, owner })).cast()
}

unsafe extern "system" fn enum_query_interface(this: *mut c_void, iid: *const Guid, out: *mut *mut c_void) -> i32 {
    if out.is_null() {
        return E_POINTER;
    }
    // SAFETY: `out` is a valid out pointer; `iid` is null or points at a GUID.
    unsafe {
        *out = ptr::null_mut();
        if !iid.is_null() && (*iid == IID_IUNKNOWN || *iid == IID_IENUMVARIANT) {
            enum_add_ref(this);
            *out = this;
            return S_OK;
        }
    }
    E_NOINTERFACE
}

unsafe extern "system" fn enum_add_ref(this: *mut c_void) -> u32 {
    enum_ref(this).refs.fetch_add(1, Ordering::AcqRel) + 1
}

unsafe extern "system" fn enum_release(this: *mut c_void) -> u32 {
    let left = enum_ref(this).refs.fetch_sub(1, Ordering::AcqRel) - 1;
    if left == 0 {
        // SAFETY: the count reached zero, so nothing else holds the proxy; it was made by `Box::into_raw` and owns the
        // reference to the real enumerator.
        unsafe {
            let boxed = Box::from_raw(this as *mut EnumProxy);
            release(boxed.real);
        }
    }
    left
}

unsafe extern "system" fn enum_next(this: *mut c_void, count: u32, items: *mut Variant, fetched: *mut u32) -> i32 {
    let proxy = enum_ref(this);
    let mut got = 0u32;
    // SAFETY: the proxy holds a reference to the real enumerator; `items` holds room for `count` VARIANTs, the caller's.
    let hr = unsafe { (real_vtbl(proxy.real).next)(proxy.real, count, items, &mut got) };
    if !fetched.is_null() {
        // SAFETY: the caller's out pointer.
        unsafe { *fetched = got };
    }
    if hr < 0 {
        log_enum_next(proxy.owner, enum_error(hr));
        return hr;
    }
    for index in 0..got as usize {
        // SAFETY: the enumerator initialised `got` items; each is the caller's to own, and an object in it is replaced by
        // its proxy.
        let item = unsafe { wrap_and_encode(&mut *items.add(index)) };
        log_enum_next(proxy.owner, Outcome::Result(item));
    }
    if got < count {
        log_enum_next(proxy.owner, Outcome::End);
    }
    hr
}

unsafe extern "system" fn enum_skip(this: *mut c_void, count: u32) -> i32 {
    let real = enum_ref(this).real;
    // SAFETY: the proxy holds a reference to the real enumerator.
    unsafe { (real_vtbl(real).skip)(real, count) }
}

unsafe extern "system" fn enum_reset(this: *mut c_void) -> i32 {
    let real = enum_ref(this).real;
    // SAFETY: the proxy holds a reference to the real enumerator.
    unsafe { (real_vtbl(real).reset)(real) }
}

unsafe extern "system" fn enum_clone(this: *mut c_void, out: *mut *mut c_void) -> i32 {
    let proxy = enum_ref(this);
    let mut cloned: *mut c_void = ptr::null_mut();
    // SAFETY: the proxy holds a reference to the real enumerator; `cloned` receives an owned reference on success.
    let hr = unsafe { (real_vtbl(proxy.real).clone)(proxy.real, &mut cloned) };
    if hr >= 0 && !cloned.is_null() && !out.is_null() {
        // SAFETY: `cloned` is the owned enumerator the call gave; the proxy takes its own reference and the one the call
        // gave is returned; `out` is the caller's.
        unsafe {
            let wrapped = wrap(cloned, proxy.owner);
            *out = if wrapped.is_null() {
                cloned
            } else {
                release(cloned);
                wrapped
            };
        }
    } else if !out.is_null() {
        // SAFETY: the caller's out pointer.
        unsafe { *out = cloned };
    }
    hr
}

#[cfg(test)]
mod tests {
    use mixdog_office_com::com::calllog::CallLog;

    use super::*;
    use crate::CAPTURE;

    /// An enumerator of the integers 1 to `limit`.
    #[repr(C)]
    struct Fake {
        vtbl: *const IEnumVariantVtbl,
        refs: AtomicU32,
        next: std::cell::Cell<i32>,
        limit: i32,
    }

    unsafe extern "system" fn qi(this: *mut c_void, iid: *const Guid, out: *mut *mut c_void) -> i32 {
        // SAFETY: the test passes valid pointers.
        unsafe {
            if *iid == IID_IUNKNOWN || *iid == IID_IENUMVARIANT {
                add(this);
                *out = this;
                return S_OK;
            }
            *out = ptr::null_mut();
        }
        E_NOINTERFACE
    }

    unsafe extern "system" fn add(this: *mut c_void) -> u32 {
        // SAFETY: `this` is a `Fake`.
        unsafe { &*(this as *const Fake) }.refs.fetch_add(1, Ordering::AcqRel) + 1
    }

    unsafe extern "system" fn rel(this: *mut c_void) -> u32 {
        // SAFETY: `this` is a `Fake`.
        unsafe { &*(this as *const Fake) }.refs.fetch_sub(1, Ordering::AcqRel) - 1
    }

    unsafe extern "system" fn next(this: *mut c_void, count: u32, items: *mut Variant, fetched: *mut u32) -> i32 {
        // SAFETY: the test passes valid pointers; `this` is a `Fake`.
        unsafe {
            let fake = &*(this as *const Fake);
            let mut got = 0u32;
            while got < count && fake.next.get() < fake.limit {
                fake.next.set(fake.next.get() + 1);
                items.add(got as usize).write(Variant::int(fake.next.get()));
                got += 1;
            }
            *fetched = got;
            if got < count { 1 } else { 0 }
        }
    }

    unsafe extern "system" fn skip(_: *mut c_void, _: u32) -> i32 {
        0
    }

    unsafe extern "system" fn reset(_: *mut c_void) -> i32 {
        0
    }

    unsafe extern "system" fn clone(_: *mut c_void, _: *mut *mut c_void) -> i32 {
        0x8000_4001_u32 as i32
    }

    static FAKE_VTBL: IEnumVariantVtbl = IEnumVariantVtbl {
        base: IUnknownVtbl { query_interface: qi, add_ref: add, release: rel },
        next,
        skip,
        reset,
        clone,
    };

    #[test]
    fn each_item_and_the_end_are_recorded_under_the_collection_id() {
        let mut fake = Fake { vtbl: &FAKE_VTBL, refs: AtomicU32::new(1), next: std::cell::Cell::new(0), limit: 2 };
        let object: *mut c_void = (&mut fake as *mut Fake).cast();
        CAPTURE.with(|capture| *capture.borrow_mut() = Some(Vec::new()));
        // SAFETY: a valid fake enumerator; every reference taken is released; the VARIANTs are initialised by `next`.
        unsafe {
            let proxy = wrap(object, 77);
            assert!(!proxy.is_null());
            assert_eq!(owner_of(proxy), Some(77));
            assert_eq!(owner_of(object), None);
            for _ in 0..3 {
                let mut item = Variant::empty();
                let mut fetched = 0u32;
                let hr = (real_vtbl(proxy).next)(proxy, 1, &mut item, &mut fetched);
                assert!(hr == 0 || hr == 1);
            }
            release(proxy);
        }
        let lines = CAPTURE.with(|capture| capture.borrow_mut().take()).unwrap_or_default();
        let log = CallLog::parse(&lines.join("\n")).expect("the lines are a call log");
        assert_eq!(log.entries.len(), 3);
        assert!(lines[0].contains("\"kind\":\"enum-next\"") && lines[0].contains("\"obj\":77"), "{}", lines[0]);
        assert!(lines[0].contains("\"result\":{\"t\":\"i4\",\"v\":1}"), "{}", lines[0]);
        assert!(lines[1].contains("\"result\":{\"t\":\"i4\",\"v\":2}"), "{}", lines[1]);
        assert!(lines[2].contains("\"result\":null"), "{}", lines[2]);
        assert_eq!(fake.refs.load(Ordering::Acquire), 1, "the proxy gave its reference back");
    }
}
