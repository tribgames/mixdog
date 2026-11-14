//! The handle every port uses, and the PowerShell binder rules the hosts depend on.
//!
//! * A property read on `$null` answers `$null` (non-strict mode), and so does a property the object does not have.
//! * A method call on `$null` fails with "You cannot call a method on a null-valued expression."; a method the object
//!   does not have fails with PowerShell's "Method invocation failed because ..." text.
//! * A property set on `$null` or on a property the object does not have fails with "The property '<name>' cannot be
//!   found on this object. Verify that the property exists and can be set."
//!
//! The Invoke flags are fixed per kind of access here, in one place, from what the recordings show PowerShell's binder
//! sending: [`GET_FLAGS`], [`GET_WITH_FLAGS`], [`CALL_FLAGS`], [`PUT_FLAGS`], [`PUT_REF_FLAGS`]. A call that may be a
//! method or a parameterized property (`Item(n)`, `Cells.Item(r, c)`) goes out with both method and property-get set,
//! which both kinds of member accept.

use std::fmt;
use std::rc::Rc;

use super::Call;
use super::ComObject;
use super::DISPATCH_METHOD;
use super::DISPATCH_PROPERTYGET;
use super::DISPATCH_PROPERTYPUT;
use super::DISPATCH_PROPERTYPUTREF;
use super::Error;
use super::ItemSource;
use super::Kind;
use super::Result;
use super::Value;
use super::errtext;

/// `$obj.Name`.
pub const GET_FLAGS: u32 = DISPATCH_PROPERTYGET;
/// `$obj.Name(args)` where `Name` is a parameterized property.
pub const GET_WITH_FLAGS: u32 = DISPATCH_METHOD | DISPATCH_PROPERTYGET;
/// `$obj.Name(args)`.
pub const CALL_FLAGS: u32 = DISPATCH_METHOD | DISPATCH_PROPERTYGET;
/// `$obj.Name = value`.
pub const PUT_FLAGS: u32 = DISPATCH_PROPERTYPUT;
/// A property set by reference.
pub const PUT_REF_FLAGS: u32 = DISPATCH_PROPERTYPUTREF;

/// The type name PowerShell prints for a COM object in "Method invocation failed because [...]".
const COM_TYPE_NAME: &str = "System.__ComObject";

/// A COM object. Cloning the handle shares the object; the object is released when the last handle is dropped.
#[derive(Clone)]
pub struct Obj {
    inner: Rc<dyn ComObject>,
}

impl fmt::Debug for Obj {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Obj({})", self.inner.identity_key())
    }
}

impl Obj {
    /// A handle over a backend's object.
    pub fn new(inner: Rc<dyn ComObject>) -> Obj {
        Obj { inner }
    }

    /// The backend's object.
    pub fn backend(&self) -> &dyn ComObject {
        &*self.inner
    }

    fn run(
        &self,
        kind: Kind,
        flags: u32,
        member: &str,
        args: &[Value],
        named: &[(&str, Value)],
        value: Option<&Value>,
    ) -> std::result::Result<Value, super::ComError> {
        self.inner.invoke(&Call { member, kind, flags, args, named, value })
    }

    /// `$obj.Name`: a missing property answers `Null`.
    pub fn get(&self, name: &str) -> Result<Value> {
        match self.run(Kind::Get, GET_FLAGS, name, &[], &[], None) {
            Ok(value) => Ok(value),
            Err(error) if error.unknown_member => Ok(Value::Null),
            Err(error) => Err(Error::Com(error)),
        }
    }

    /// `$obj.Name(args)` on a parameterized property: `Item(n)`, `Cells.Item(r, c)`, `Information(12)`.
    pub fn get_with(&self, name: &str, args: &[Value]) -> Result<Value> {
        match self.run(Kind::Get, GET_WITH_FLAGS, name, args, &[], None) {
            Ok(value) => Ok(value),
            Err(error) if error.unknown_member => Err(errtext::method_not_found(COM_TYPE_NAME, name)),
            Err(error) => Err(Error::Com(error)),
        }
    }

    /// `$obj.Name = value`.
    pub fn put(&self, name: &str, value: Value) -> Result<()> {
        self.put_with(name, &[], value)
    }

    /// `$obj.Name(args) = value`: a parameterized property assignment such as `$document.Compatibility(16) = $true`.
    pub fn put_with(&self, name: &str, args: &[Value], value: Value) -> Result<()> {
        self.set(Kind::Put, PUT_FLAGS, name, args, value)
    }

    /// A property set by reference (`DISPATCH_PROPERTYPUTREF`).
    pub fn put_ref(&self, name: &str, object: &Obj) -> Result<()> {
        self.set(Kind::PutRef, PUT_REF_FLAGS, name, &[], Value::Dispatch(object.clone()))
    }

    fn set(&self, kind: Kind, flags: u32, name: &str, args: &[Value], value: Value) -> Result<()> {
        match self.run(kind, flags, name, args, &[], Some(&value)) {
            Ok(_) => Ok(()),
            Err(error) if error.unknown_member => Err(errtext::property_not_found(name)),
            Err(error) => Err(Error::Com(error)),
        }
    }

    /// `$obj.Name(args)`.
    pub fn call(&self, name: &str, args: &[Value]) -> Result<Value> {
        self.call_named(name, args, &[])
    }

    /// A call with named arguments after the positional ones (`rgdispidNamedArgs` in reverse order). The hosts never
    /// use them, PowerShell cannot, but the layer offers them.
    pub fn call_named(&self, name: &str, positional: &[Value], named: &[(&str, Value)]) -> Result<Value> {
        match self.run(Kind::Call, CALL_FLAGS, name, positional, named, None) {
            Ok(value) => Ok(value),
            Err(error) if error.unknown_member => Err(errtext::method_not_found(COM_TYPE_NAME, name)),
            Err(error) => Err(Error::Com(error)),
        }
    }

    /// `foreach` and `@(...)`: `DISPID_NEWENUM`, then `IEnumVARIANT::Next` one item at a time.
    pub fn enumerate(&self) -> Result<Enumeration> {
        Ok(Enumeration { source: self.inner.enum_open().map_err(Error::Com)? })
    }

    /// Every item of the collection, as `@($collection)`.
    pub fn items(&self) -> Result<Vec<Value>> {
        self.enumerate()?.collect()
    }

    /// `[int]$collection.Count`.
    pub fn count(&self) -> Result<i64> {
        let value = self.get("Count")?;
        match &value {
            Value::Null | Value::Empty => Ok(0),
            other => other
                .as_i64()
                .or_else(|| other.as_f64().map(|number| number.round() as i64))
                .ok_or_else(|| Error::host(format!("Cannot convert the value of type \"{}\" to type \"System.Int32\".", other.dotnet_type_name()))),
        }
    }

    /// `$collection.Item(index)`.
    pub fn item(&self, index: i32) -> Result<Value> {
        self.get_with("Item", &[Value::I4(index)])
    }

    /// `[object]::ReferenceEquals(a, b)` over the COM identity: both are the same object.
    pub fn same_object(&self, other: &Obj) -> bool {
        Rc::ptr_eq(&self.inner, &other.inner) || self.inner.same_object(&*other.inner)
    }

    /// The `rcw:<n>` key that stands for the object where it has no window handle.
    pub fn identity_key(&self) -> String {
        self.inner.identity_key()
    }

    /// The recording's id of the object, for a backend that has one.
    pub fn log_id(&self) -> Option<u64> {
        self.inner.log_id()
    }
}

/// The items of a collection, one `IEnumVARIANT::Next` per step.
pub struct Enumeration {
    source: Box<dyn ItemSource>,
}

impl Iterator for Enumeration {
    type Item = Result<Value>;

    fn next(&mut self) -> Option<Result<Value>> {
        match self.source.next_item() {
            Ok(Some(value)) => Some(Ok(value)),
            Ok(None) => None,
            Err(error) => Some(Err(Error::Com(error))),
        }
    }
}

impl Value {
    /// `$value.Name`: a property read on `$null`, or on a value that has no such property, answers `Null`.
    pub fn member(&self, name: &str) -> Result<Value> {
        match self.as_obj() {
            Some(object) => object.get(name),
            None => Ok(Value::Null),
        }
    }

    /// `$value.Name(args)`: fails on `$null` and on a value without that method.
    pub fn call_member(&self, name: &str, args: &[Value]) -> Result<Value> {
        match self {
            Value::Null | Value::Empty => Err(errtext::null_method_call()),
            Value::Dispatch(object) | Value::Unknown(object) => object.call(name, args),
            other => Err(errtext::method_not_found(other.dotnet_type_name(), name)),
        }
    }

    /// `$value.Name = x`: fails on `$null` and on a value without that property.
    pub fn set_member(&self, name: &str, value: Value) -> Result<()> {
        match self.as_obj() {
            Some(object) => object.put(name, value),
            None => Err(errtext::property_not_found(name)),
        }
    }
}
