//! The COM layer driven through the replaying fake with hand-written call logs, the error texts held to the recorded
//! corpus, the retry helpers with the fake clock, and (Windows) the live backend over a counting fake `IDispatch`.

use std::cell::Cell;
use std::panic::AssertUnwindSafe;
use std::panic::catch_unwind;
use std::time::Duration;

use mixdog_office_com::com::ComError;
use mixdog_office_com::com::Dim;
use mixdog_office_com::com::Error;
use mixdog_office_com::com::Obj;
use mixdog_office_com::com::SafeArray;
use mixdog_office_com::com::Value;
use mixdog_office_com::com::calllog::CallLog;
use mixdog_office_com::com::calllog::decode_value;
use mixdog_office_com::com::calllog::encode_value;
use mixdog_office_com::com::errtext;
use mixdog_office_com::com::errtext::Access;
use mixdog_office_com::com::errtext::Raw;
use mixdog_office_com::com::fake::Fake;
use mixdog_office_com::com::fake::ManualClock;
use mixdog_office_com::com::obj::CALL_FLAGS;
use mixdog_office_com::com::obj::GET_FLAGS;
use mixdog_office_com::com::obj::GET_WITH_FLAGS;
use mixdog_office_com::com::obj::PUT_FLAGS;
use mixdog_office_com::com::obj::PUT_REF_FLAGS;
use mixdog_office_com::com::retry;
use mixdog_office_com::com::value::Decimal;
use serde_json::Value as Json;
use serde_json::json;

fn lines(entries: &[Json]) -> String {
    entries.iter().map(Json::to_string).collect::<Vec<_>>().join("\n")
}

fn call_line(seq: u64, obj: u64, kind: &str, member: &str, flags: u32, args: Json, result: Json) -> Json {
    json!({"seq": seq, "obj": obj, "kind": kind, "member": member, "flags": flags, "args": args, "result": result})
}

fn failure_message(run: impl FnOnce()) -> String {
    let payload = catch_unwind(AssertUnwindSafe(run)).expect_err("the call should have failed the replay");
    payload.downcast_ref::<String>().cloned().or_else(|| payload.downcast_ref::<&str>().map(|text| (*text).to_owned())).unwrap_or_default()
}

fn every_value_kind() -> Vec<Value> {
    let fake = Fake::new(CallLog::default());
    vec![
        Value::Empty,
        Value::Null,
        Value::Bool(true),
        Value::Bool(false),
        Value::I1(-5),
        Value::I2(-300),
        Value::I4(70_000),
        Value::I8(-9_000_000_000),
        Value::UI1(200),
        Value::UI2(60_000),
        Value::UI4(4_000_000_000),
        Value::UI8(18_000_000_000_000_000_000),
        Value::R4(1.5),
        Value::R8(-0.1),
        Value::Currency(123_4567),
        Value::Date(45_000.5),
        Value::Str("a \"quoted\" \u{1F600} text".to_owned()),
        Value::Str(String::new()),
        Value::Error(0x800A_07FA_u32 as i32),
        Value::Decimal(Decimal::parse("-12345678901234567890.123456").expect("decimal")),
        Value::Missing,
        Value::Dispatch(fake.object(7)),
        Value::Unknown(fake.object(8)),
        Value::Array(SafeArray::one_d(1, vec![Value::I4(1), Value::Str("two".to_owned())])),
    ]
}

#[test]
fn every_value_kind_survives_the_typed_json_form() {
    let fake = Fake::new(CallLog::default());
    let ids = |object: &Obj| object.log_id().expect("fake objects have ids");
    for value in every_value_kind() {
        let encoded = encode_value(&value, &ids);
        let decoded = decode_value(&encoded, &mut |id| fake.object(id)).expect("decodes");
        assert_eq!(decoded, value, "{encoded}");
        assert_eq!(encoded["t"], value.type_tag());
    }
}

#[test]
fn a_call_with_every_value_kind_matches_its_recording_and_answers_an_object() {
    let values = every_value_kind();
    let ids = |object: &Obj| object.log_id().expect("id");
    let args: Vec<Json> = values.iter().map(|value| encode_value(value, &ids)).collect();
    let log = lines(&[
        call_line(1, 1, "call", "Add", CALL_FLAGS, Json::Array(args), json!({"t": "obj", "v": 2})),
        call_line(2, 2, "get", "Name", GET_FLAGS, json!([]), json!({"t": "str", "v": "Sheet1"})),
    ]);
    let fake = Fake::from_lines(&log);
    let root = fake.object(1);
    let sheet = root.call("Add", &values).expect("call").into_obj().expect("an object");
    assert_eq!(sheet.get("Name").expect("name"), Value::Str("Sheet1".to_owned()));
    fake.finish();
}

#[test]
fn put_put_with_and_put_ref_send_their_flags_and_the_assigned_value() {
    let log = lines(&[
        json!({"seq": 1, "obj": 1, "kind": "put", "member": "Visible", "flags": PUT_FLAGS, "args": [], "value": {"t": "bool", "v": false}}),
        json!({"seq": 2, "obj": 1, "kind": "put", "member": "Compatibility", "flags": PUT_FLAGS, "args": [{"t": "i4", "v": 16}], "value": {"t": "bool", "v": true}}),
        json!({"seq": 3, "obj": 1, "kind": "putref", "member": "Target", "flags": PUT_REF_FLAGS, "args": [], "value": {"t": "obj", "v": 2}}),
        call_line(4, 1, "get", "Information", GET_WITH_FLAGS, json!([{"t": "i4", "v": 12}]), json!({"t": "i4", "v": 3})),
    ]);
    let fake = Fake::from_lines(&log);
    let object = fake.object(1);
    object.put("Visible", Value::Bool(false)).expect("put");
    object.put_with("Compatibility", &[Value::I4(16)], Value::Bool(true)).expect("put_with");
    object.put_ref("Target", &fake.object(2)).expect("put_ref");
    assert_eq!(object.get_with("Information", &[Value::I4(12)]).expect("get_with"), Value::I4(3));
    fake.finish();
}

#[test]
fn missing_and_named_arguments_are_compared_in_the_order_given() {
    let log = lines(&[json!({"seq": 1, "obj": 1, "kind": "call", "member": "Open", "flags": CALL_FLAGS,
               "args": [{"t": "str", "v": "a.xlsx"}, {"t": "missing"}, {"t": "bool", "v": true}],
               "named": [["Password", {"t": "str", "v": "x"}], ["ReadOnly", {"t": "bool", "v": true}]],
               "result": {"t": "null"}})]);
    let fake = Fake::from_lines(&log);
    let object = fake.object(1);
    let args = [Value::from("a.xlsx"), Value::Missing, Value::Bool(true)];
    let named = [("Password", Value::from("x")), ("ReadOnly", Value::Bool(true))];
    assert_eq!(object.call_named("Open", &args, &named).expect("call"), Value::Null);
    fake.finish();

    let swapped = Fake::from_lines(&log);
    let object = swapped.object(1);
    let reordered = [("ReadOnly", Value::Bool(true)), ("Password", Value::from("x"))];
    let message = failure_message(|| {
        let _ = object.call_named("Open", &args, &reordered);
    });
    assert!(message.contains("named arguments differ"), "{message}");
}

#[test]
fn one_dimensional_arrays_keep_their_lower_bound() {
    for lbound in [0, 1] {
        let array = SafeArray::one_d(lbound, vec![Value::I4(10), Value::I4(20), Value::I4(30)]);
        assert_eq!(array.rank(), 1);
        assert_eq!(array.lower_bound(0), Some(lbound));
        assert_eq!(array.upper_bound(0), Some(lbound + 2));
        assert_eq!(array.get(&[lbound + 1]), Some(&Value::I4(20)));
        assert_eq!(array.get(&[lbound + 3]), None);
        assert_eq!(array.get(&[lbound - 1]), None);
    }
}

#[test]
fn two_dimensional_arrays_are_column_major_with_their_lower_bounds() {
    let rows = vec![vec![Value::I4(11), Value::I4(12), Value::I4(13)], vec![Value::I4(21), Value::I4(22), Value::I4(23)]];
    for lbounds in [(0, 0), (1, 1)] {
        let array = SafeArray::from_rows(lbounds, rows.clone()).expect("rectangular");
        assert_eq!(array.dims(), &[Dim { lbound: lbounds.0, len: 2 }, Dim { lbound: lbounds.1, len: 3 }]);
        // Storage order: the first index (rows) varies fastest.
        let stored: Vec<i64> = array.data().iter().map(|value| value.as_i64().expect("int")).collect();
        assert_eq!(stored, vec![11, 21, 12, 22, 13, 23]);
        assert_eq!(array.get(&[lbounds.0 + 1, lbounds.1 + 2]), Some(&Value::I4(23)));
        assert_eq!(array.get(&[lbounds.0 + 2, lbounds.1]), None);
        let read_back = array.rows().expect("two-dimensional");
        assert_eq!(read_back[1][0], &Value::I4(21));
    }
    assert!(SafeArray::from_rows((0, 0), vec![vec![Value::Empty], vec![]]).is_none());
    let one_cell = SafeArray::zero_based(vec![vec![Value::from("x")]]).expect("1 x 1");
    assert_eq!(one_cell.dims(), &[Dim { lbound: 0, len: 1 }, Dim { lbound: 0, len: 1 }]);
    assert!(SafeArray::new(vec![Dim { lbound: 1, len: 2 }], vec![Value::Empty]).is_none());
}

#[test]
fn an_array_answer_comes_back_with_its_bounds() {
    let answer = json!({"t": "array", "dims": [[1, 2], [1, 2]],
        "data": [{"t": "i4", "v": 1}, {"t": "i4", "v": 3}, {"t": "i4", "v": 2}, {"t": "i4", "v": 4}]});
    let log = lines(&[call_line(1, 1, "get", "Value2", GET_FLAGS, json!([]), answer)]);
    let fake = Fake::from_lines(&log);
    let Value::Array(array) = fake.object(1).get("Value2").expect("get") else {
        panic!("an array");
    };
    assert_eq!(array.lower_bound(0), Some(1));
    assert_eq!(array.get(&[1, 2]), Some(&Value::I4(2)));
    assert_eq!(array.get(&[2, 1]), Some(&Value::I4(3)));
}

#[test]
fn enumeration_walks_one_item_at_a_time_to_the_end() {
    let next = |seq: u64, result: Json| json!({"seq": seq, "obj": 1, "kind": "enum-next", "member": "", "flags": 0, "args": [], "result": result});
    let log = lines(&[
        next(1, json!({"t": "obj", "v": 2})),
        next(2, json!({"t": "obj", "v": 3})),
        next(3, Json::Null),
        call_line(4, 3, "get", "Name", GET_FLAGS, json!([]), json!({"t": "str", "v": "last"})),
    ]);
    let fake = Fake::from_lines(&log);
    let items = fake.object(1).items().expect("items");
    assert_eq!(items.len(), 2);
    assert!(items[0].as_obj().expect("object").same_object(&fake.object(2)));
    let last = items[1].as_obj().expect("object");
    assert_eq!(last.get("Name").expect("name"), Value::from("last"));
    fake.finish();
}

#[test]
fn the_binder_rules_for_null_and_missing_members() {
    let unknown = json!({"hresult": -2147352570, "inner_hresult": -2147352570, "message": "", "unknown_member": true});
    let log = lines(&[
        json!({"seq": 1, "obj": 1, "kind": "get", "member": "Nope", "flags": GET_FLAGS, "args": [], "error": unknown}),
        json!({"seq": 2, "obj": 1, "kind": "call", "member": "Nope", "flags": CALL_FLAGS, "args": [], "error": unknown}),
        json!({"seq": 3, "obj": 1, "kind": "put", "member": "Nope", "flags": PUT_FLAGS, "args": [], "value": {"t": "i4", "v": 1}, "error": unknown}),
        json!({"seq": 4, "obj": 1, "kind": "get", "member": "Count", "flags": GET_FLAGS, "args": [], "result": {"t": "i4", "v": 4}}),
    ]);
    let fake = Fake::from_lines(&log);
    let object = fake.object(1);
    assert_eq!(object.get("Nope").expect("a missing property answers null"), Value::Null);
    assert_eq!(
        object.call("Nope", &[]).expect_err("a missing method fails").message(),
        "Method invocation failed because [System.__ComObject] does not contain a method named 'Nope'."
    );
    assert_eq!(
        object.put("Nope", Value::I4(1)).expect_err("a missing property fails to set").message(),
        "The property 'Nope' cannot be found on this object. Verify that the property exists and can be set."
    );
    assert_eq!(object.count().expect("count"), 4);

    assert_eq!(Value::Null.member("Anything").expect("a property of null is null"), Value::Null);
    assert_eq!(Value::Empty.member("Anything").expect("a property of null is null"), Value::Null);
    assert_eq!(Value::Null.call_member("Quit", &[]).expect_err("a method of null fails").message(), "You cannot call a method on a null-valued expression.");
    assert_eq!(
        Value::Null.set_member("Visible", Value::Bool(true)).expect_err("a property set on null fails").message(),
        "The property 'Visible' cannot be found on this object. Verify that the property exists and can be set."
    );
}

#[test]
fn a_recorded_com_failure_comes_back_as_the_error_with_both_hresults() {
    let log = lines(&[json!({"seq": 1, "obj": 1, "kind": "call", "member": "Quit", "flags": CALL_FLAGS, "args": [],
        "error": {"hresult": -2146233087, "inner_hresult": -2147417848, "message": "outer", "inner_message": "inner"}})]);
    let fake = Fake::from_lines(&log);
    match fake.object(1).call("Quit", &[]) {
        Err(Error::Com(error)) => {
            assert_eq!((error.hresult, error.inner_hresult), (-2_146_233_087, -2_147_417_848));
            assert_eq!((error.message.as_str(), error.inner_message.as_str()), ("outer", "inner"));
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn the_first_difference_fails_with_both_calls_in_the_message() {
    let log = lines(&[call_line(1, 1, "call", "Open", CALL_FLAGS, json!([{"t": "i4", "v": 1}, {"t": "bool", "v": true}]), json!({"t": "null"}))]);
    let args = [Value::I4(1), Value::Bool(true)];

    let message = failure_message(|| {
        let _ = Fake::from_lines(&log).object(1).call("Open", &[Value::I4(1), Value::I2(1)]);
    });
    assert!(message.contains("argument 1"), "{message}");
    assert!(message.contains("recorded:") && message.contains("actual:"), "{message}");

    let message = failure_message(|| {
        let _ = Fake::from_lines(&log).object(1).call("Close", &args);
    });
    assert!(message.contains("member: recorded \"Open\", actual \"Close\""), "{message}");

    let message = failure_message(|| {
        let _ = Fake::from_lines(&log).object(1).get("Open");
    });
    assert!(message.contains("kind: recorded call, actual get"), "{message}");

    let message = failure_message(|| {
        let _ = Fake::from_lines(&log).object(2).call("Open", &args);
    });
    assert!(message.contains("receiver: recorded obj#1, actual obj#2"), "{message}");

    let message = failure_message(|| {
        let fake = Fake::from_lines(&log);
        let object = fake.object(1);
        let _ = object.call("Open", &args);
        let _ = object.call("Open", &args);
    });
    assert!(message.contains("the recording does not have"), "{message}");

    let message = failure_message(|| Fake::from_lines(&log).finish());
    assert!(message.contains("unplayed"), "{message}");
}

#[test]
fn boundaries_are_consumed_by_name_and_a_call_that_meets_one_fails() {
    let log =
        [json!({"seq": 1, "boundary": "operation", "name": "set_range"}), call_line(2, 1, "get", "Name", GET_FLAGS, json!([]), json!({"t": "str", "v": "x"}))];
    let source = lines(&log);
    let fake = Fake::from_lines(&source);
    fake.boundary("operation", "set_range");
    assert_eq!(fake.object(1).get("Name").expect("name"), Value::from("x"));
    fake.finish();

    let message = failure_message(|| {
        let _ = Fake::from_lines(&source).object(1).get("Name");
    });
    assert!(message.contains("boundary operation \"set_range\""), "{message}");

    let lenient = Fake::from_lines(&source);
    lenient.ignore_boundaries();
    assert_eq!(lenient.object(1).get("Name").expect("name"), Value::from("x"));
}

#[test]
fn a_reviewed_allowance_skips_the_repeat_powershell_made() {
    let read = |seq| call_line(seq, 1, "get", "Text", GET_FLAGS, json!([]), json!({"t": "str", "v": "same"}));
    let allowed = format!(
        "{}\n{}",
        json!({"allow": {"member": "Text", "kind": "get", "repeats": 1}}),
        lines(&[read(1), read(2), call_line(3, 1, "call", "Save", CALL_FLAGS, json!([]), json!({"t": "empty"}))])
    );
    let fake = Fake::from_lines(&allowed);
    let object = fake.object(1);
    object.get("Text").expect("read once");
    object.call("Save", &[]).expect("the repeat was skipped");
    fake.finish();

    let strict = lines(&[read(1), read(2), call_line(3, 1, "call", "Save", CALL_FLAGS, json!([]), json!({"t": "empty"}))]);
    let message = failure_message(|| {
        let fake = Fake::from_lines(&strict);
        let object = fake.object(1);
        object.get("Text").expect("read once");
        let _ = object.call("Save", &[]);
    });
    assert!(message.contains("kind: recorded get, actual call"), "{message}");
}

#[test]
fn a_log_survives_being_written_and_read_again() {
    let source = format!(
        "{}\n{}",
        json!({"allow": {"member": "Text", "kind": "get", "repeats": 2}}),
        lines(&[
            json!({"seq": 1, "boundary": "snapshot", "name": "doc", "payload": {"a": 1}}),
            json!({"seq": 2, "obj": 1, "kind": "put", "member": "Name", "flags": PUT_FLAGS, "lcid": 0, "dispid": 5, "args": [], "value": {"t": "str", "v": "n"}, "result": {"t": "empty"}}),
            json!({"seq": 3, "obj": 1, "kind": "enum-next", "member": "", "flags": 0, "args": [], "result": null}),
        ])
    );
    let log = CallLog::parse(&source).expect("parses");
    assert_eq!(log.entries.len(), 3);
    assert_eq!(CallLog::parse(&log.to_lines()).expect("parses again"), log);
    assert!(CallLog::parse("not json").expect_err("fails").contains("line 1"));
}

#[test]
fn same_object_is_true_for_two_handles_of_one_object_and_false_for_two_objects() {
    let fake = Fake::new(CallLog::default());
    assert!(fake.object(1).same_object(&fake.object(1)));
    assert!(!fake.object(1).same_object(&fake.object(2)));
    assert_eq!(fake.object(5).identity_key(), fake.object(5).identity_key());
    assert_ne!(fake.object(5).identity_key(), fake.object(6).identity_key());
}

#[test]
fn decimals_parse_and_print_exactly() {
    for text in ["0", "1", "-1", "1.50", "0.0001", "-79228162514264337593543950335", "12345.678900"] {
        assert_eq!(Decimal::parse(text).expect("parses").to_string(), text);
    }
    assert!(Decimal::parse("79228162514264337593543950336").is_none());
    assert!(Decimal::parse("1e5").is_none());
    assert!(Decimal::parse("").is_none());
    assert_eq!(Decimal::from_i64(-7).to_string(), "-7");
}

#[test]
fn symbolic_names_follow_the_net_suffix_rule() {
    let text = |_: i32| Some("The object invoked has disconnected from its clients.".to_owned());
    let raw = Raw { hresult: 0x8001_0108_u32 as i32, description: None };
    assert_eq!(
        errtext::inner_message(&raw, &text),
        "The object invoked has disconnected from its clients. (Exception from HRESULT: 0x80010108 (RPC_E_DISCONNECTED))"
    );
    let unnamed = Raw { hresult: 0x800A_AAAA_u32 as i32, description: None };
    assert_eq!(errtext::inner_message(&unnamed, &|_: i32| None), "Exception from HRESULT: 0x800AAAAA");
    let described = Raw { hresult: 0x8002_0009_u32 as i32, description: Some("Boom".to_owned()) };
    assert_eq!(errtext::inner_message(&described, &text), "Boom");
}

// ---- retry --------------------------------------------------------------------------------------------------

fn com_error(hresult: i32) -> Error {
    Error::Com(ComError { hresult, inner_hresult: hresult, message: format!("busy {hresult}"), inner_message: String::new(), unknown_member: false })
}

fn attempts_until_failure(
    hresult: i32,
    run: impl Fn(&ManualClock, &dyn Fn() -> Result<(), Error>) -> Result<(), Error>,
) -> (u32, Result<(), Error>, ManualClock) {
    let clock = ManualClock::new();
    let attempts = Cell::new(0);
    let operation = || {
        attempts.set(attempts.get() + 1);
        Err(com_error(hresult))
    };
    let result = run(&clock, &operation);
    (attempts.get(), result, clock)
}

#[test]
fn excel_retries_its_three_codes_fifty_times_then_reports_busy() {
    for hresult in retry::EXCEL_TRANSIENT {
        let (attempts, result, clock) = attempts_until_failure(hresult, |clock, operation| retry::excel(clock, "Excel chart proxy", &[], operation));
        assert_eq!(attempts, 50);
        assert_eq!(clock.pauses(), vec![Duration::from_millis(100); 50]);
        assert_eq!(result.expect_err("busy").message(), format!("Excel chart proxy remained busy after transient COM retries. Last error: busy {hresult}"));
    }
}

#[test]
fn a_code_outside_the_list_is_thrown_at_once_and_the_callers_extra_codes_are_retried() {
    let (attempts, result, clock) = attempts_until_failure(-1, |clock, operation| retry::excel(clock, "x", &[], operation));
    assert_eq!(attempts, 1);
    assert!(clock.pauses().is_empty());
    assert_eq!(result.expect_err("thrown").message(), "busy -1");

    let (attempts, _, _) = attempts_until_failure(-1, |clock, operation| retry::excel(clock, "x", &[-1], operation));
    assert_eq!(attempts, 50);

    let host = Cell::new(0);
    let result: Result<(), Error> = retry::excel(&ManualClock::new(), "x", &[], || {
        host.set(host.get() + 1);
        Err(Error::host("thrown by the host"))
    });
    assert_eq!((host.get(), result.expect_err("thrown").message()), (1, "thrown by the host"));
}

#[test]
fn powerpoint_retries_two_codes_and_not_excels_third() {
    for hresult in retry::POWERPOINT_TRANSIENT {
        let (attempts, _, _) = attempts_until_failure(hresult, |clock, operation| retry::powerpoint(clock, "PowerPoint chart series", operation));
        assert_eq!(attempts, 50);
    }
    let (attempts, _, _) = attempts_until_failure(retry::EXCEL_TRANSIENT[0], |clock, operation| retry::powerpoint(clock, "x", operation));
    assert_eq!(attempts, 1);
}

#[test]
fn an_operation_that_succeeds_after_a_few_busy_answers_returns_its_value() {
    let clock = ManualClock::new();
    let calls = Cell::new(0);
    let value = retry::excel(&clock, "x", &[], || {
        calls.set(calls.get() + 1);
        if calls.get() < 4 { Err(com_error(retry::EXCEL_TRANSIENT[0])) } else { Ok(42) }
    })
    .expect("succeeds");
    assert_eq!((value, clock.pauses().len()), (42, 3));
}

// ---- the live backend over a counting fake IDispatch (Windows) ------------------------------------------------

#[cfg(windows)]
mod live {
    use std::cell::RefCell;
    use std::ffi::c_void;
    use std::sync::atomic::AtomicI32;
    use std::sync::atomic::Ordering;

    use mixdog_office_com::com::DISPATCH_PROPERTYPUT;
    use mixdog_office_com::com::DISPID_PROPERTYPUT;
    use mixdog_office_com::com::Value;
    use mixdog_office_com::com::live::LiveObject;

    const VT_I4: u16 = 3;
    const VT_BSTR: u16 = 8;
    const VT_DISPATCH: u16 = 9;
    const VT_ERROR: u16 = 10;
    const E_NOTIMPL: i32 = 0x8000_4001_u32 as i32;
    const E_NOINTERFACE: i32 = 0x8000_4002_u32 as i32;
    const DISP_E_UNKNOWNNAME: i32 = 0x8002_0006_u32 as i32;

    #[repr(C)]
    struct Variant {
        vt: u16,
        reserved: [u16; 3],
        data: [usize; 2],
    }

    #[repr(C)]
    struct DispParams {
        rgvarg: *mut Variant,
        rgdispid_named_args: *mut i32,
        c_args: u32,
        c_named_args: u32,
    }

    #[repr(C)]
    struct Vtbl {
        query_interface: unsafe extern "system" fn(*mut c_void, *const [u8; 16], *mut *mut c_void) -> i32,
        add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
        release: unsafe extern "system" fn(*mut c_void) -> u32,
        get_type_info_count: unsafe extern "system" fn(*mut c_void, *mut u32) -> i32,
        get_type_info: unsafe extern "system" fn(*mut c_void, u32, u32, *mut *mut c_void) -> i32,
        get_ids_of_names: unsafe extern "system" fn(*mut c_void, *const [u8; 16], *const *const u16, u32, u32, *mut i32) -> i32,
        invoke: unsafe extern "system" fn(*mut c_void, i32, *const [u8; 16], u32, u16, *mut DispParams, *mut Variant, *mut c_void, *mut u32) -> i32,
    }

    #[derive(Default, Debug)]
    struct Seen {
        flags: u16,
        c_args: u32,
        c_named_args: u32,
        named_id: Option<i32>,
        arg_types: Vec<u16>,
    }

    #[repr(C)]
    struct FakeDispatch {
        vtbl: *const Vtbl,
        refs: AtomicI32,
        seen: RefCell<Seen>,
    }

    unsafe extern "system" fn query_interface(this: *mut c_void, iid: *const [u8; 16], out: *mut *mut c_void) -> i32 {
        // SAFETY: the test passes valid pointers; IUnknown ({0...}) and IDispatch ({00020400...}) are answered.
        unsafe {
            let first = u32::from_le_bytes([(*iid)[0], (*iid)[1], (*iid)[2], (*iid)[3]]);
            if first == 0 || first == 0x0002_0400 {
                add_ref(this);
                *out = this;
                0
            } else {
                E_NOINTERFACE
            }
        }
    }

    unsafe extern "system" fn add_ref(this: *mut c_void) -> u32 {
        // SAFETY: `this` is a FakeDispatch.
        let fake = unsafe { &*(this as *const FakeDispatch) };
        (fake.refs.fetch_add(1, Ordering::SeqCst) + 1) as u32
    }

    unsafe extern "system" fn release(this: *mut c_void) -> u32 {
        // SAFETY: `this` is a FakeDispatch.
        let fake = unsafe { &*(this as *const FakeDispatch) };
        (fake.refs.fetch_sub(1, Ordering::SeqCst) - 1) as u32
    }

    unsafe extern "system" fn get_type_info_count(_: *mut c_void, count: *mut u32) -> i32 {
        // SAFETY: valid out pointer.
        unsafe { *count = 0 };
        0
    }

    unsafe extern "system" fn get_type_info(_: *mut c_void, _: u32, _: u32, _: *mut *mut c_void) -> i32 {
        E_NOTIMPL
    }

    unsafe extern "system" fn get_ids_of_names(_: *mut c_void, _: *const [u8; 16], names: *const *const u16, _: u32, _: u32, ids: *mut i32) -> i32 {
        // SAFETY: one NUL-terminated name is passed; the first code unit picks the DISPID.
        unsafe {
            let first = **names;
            if first == u16::from(b'U') {
                return DISP_E_UNKNOWNNAME;
            }
            *ids = 100 + i32::from(first);
        }
        0
    }

    #[allow(clippy::too_many_arguments)] // the shape of IDispatch::Invoke
    unsafe extern "system" fn invoke(
        this: *mut c_void,
        dispid: i32,
        _iid: *const [u8; 16],
        _lcid: u32,
        flags: u16,
        params: *mut DispParams,
        result: *mut Variant,
        _excep: *mut c_void,
        _arg_error: *mut u32,
    ) -> i32 {
        // SAFETY: `this` is a FakeDispatch; `params` and `result` are valid for the call.
        unsafe {
            let fake = &*(this as *const FakeDispatch);
            let params = &*params;
            let mut seen = fake.seen.borrow_mut();
            seen.flags = flags;
            seen.c_args = params.c_args;
            seen.c_named_args = params.c_named_args;
            seen.named_id = (params.c_named_args > 0).then(|| *params.rgdispid_named_args);
            seen.arg_types = (0..params.c_args as usize).map(|index| (*params.rgvarg.add(index)).vt).collect();
            // A member whose first letter is S answers this object; every other one answers the Int32 7.
            if dispid == 100 + i32::from(b'S') {
                add_ref(this);
                (*result).vt = VT_DISPATCH;
                (*result).data[0] = this as usize;
            } else {
                (*result).vt = VT_I4;
                (*result).data[0] = 7;
            }
        }
        0
    }

    static VTBL: Vtbl = Vtbl { query_interface, add_ref, release, get_type_info_count, get_type_info, get_ids_of_names, invoke };

    fn fake() -> *mut FakeDispatch {
        Box::into_raw(Box::new(FakeDispatch { vtbl: &VTBL, refs: AtomicI32::new(1), seen: RefCell::new(Seen::default()) }))
    }

    #[test]
    fn put_sends_dispid_propertyput_reversed_arguments_and_balances_every_reference() {
        let raw = fake();
        // SAFETY: `raw` is a valid IDispatch with one reference of the test's own.
        let object = unsafe { LiveObject::from_dispatch(raw.cast()) }.expect("object");
        // SAFETY: the pointer stays valid until the last Release below.
        let state = unsafe { &*raw };

        object.put_with("Item", &[Value::I4(5)], Value::from("value")).expect("put_with");
        {
            let seen = state.seen.borrow();
            assert_eq!(u32::from(seen.flags), DISPATCH_PROPERTYPUT);
            assert_eq!((seen.c_args, seen.c_named_args), (2, 1));
            assert_eq!(seen.named_id, Some(DISPID_PROPERTYPUT));
            // rgvarg is reversed: the assigned value first, then the index.
            assert_eq!(seen.arg_types, vec![VT_BSTR, VT_I4]);
        }

        // An object argument is AddRef'd for the call and released by VariantClear; the answer is a new handle.
        let answer = object.call("Self", &[Value::Dispatch(object.clone()), Value::Missing]).expect("call");
        assert_eq!(state.seen.borrow().arg_types, vec![VT_ERROR, VT_DISPATCH]);
        let again = answer.into_obj().expect("an object");
        assert!(again.same_object(&object));
        assert_eq!(object.call("Other", &[]).expect("call"), Value::I4(7));
        assert_eq!(object.get("Unknown").expect("an unknown property answers null"), Value::Null);

        drop(again);
        drop(object);
        assert_eq!(state.refs.load(Ordering::SeqCst), 1, "every AddRef was released exactly once");
        // SAFETY: the test's own reference is the last one; the allocation is freed once.
        unsafe { drop(Box::from_raw(raw)) };
    }
}

// ---- error texts ------------------------------------------------------------------------

#[test]
fn a_failed_call_get_or_set_is_worded_by_how_the_member_was_reached() {
    let raw = Raw { hresult: 0x8002_0009_u32 as i32, description: Some("Cannot do that".to_owned()) };
    let nothing = |_: i32| None;
    let call = errtext::com_error(Access::Method { name: "Open", argc: 2 }, &raw, &nothing);
    assert_eq!(call.message, "Exception calling \"Open\" with \"2\" argument(s): \"Cannot do that\"");
    let get = errtext::com_error(Access::Get { name: "Count" }, &raw, &nothing);
    assert_eq!(get.message, "Exception getting \"Count\": \"Cannot do that\"");
    let set = errtext::com_error(Access::Set { name: "Visible" }, &raw, &nothing);
    assert_eq!(set.message, "Exception setting \"Visible\": \"Cannot do that\"");
    // The wrapper carries the exception's own code; the COM code stays beside it, and the inner text is kept apart.
    for error in [&call, &get, &set] {
        assert_eq!(error.hresult, errtext::WRAPPED_HRESULT);
        assert_eq!(error.hresult as u32, 0x8013_1501);
        assert_eq!(error.inner_hresult, 0x8002_0009_u32 as i32);
        assert_eq!(error.inner_message, "Cannot do that");
        assert!(!error.unknown_member);
    }
}

#[test]
fn codes_the_runtime_maps_to_an_exception_use_that_exceptions_message_and_others_name_their_hresult() {
    let system = |code: i32| Some(format!("system text for {code:08X}"));
    for (code, message) in [
        (0x8000_4001_u32, "The method or operation is not implemented."),
        (0x8000_4003, "Object reference not set to an instance of an object."),
        (0x8007_0005, "Access is denied."),
        (0x8007_000E, "Insufficient memory to continue the execution of the program."),
        (0x8007_0057, "Value does not fall within the expected range."),
        (0x8002_000A, "Arithmetic operation resulted in an overflow."),
        (0x8002_0012, "Attempted to divide by zero."),
    ] {
        let raw = Raw { hresult: code as i32, description: None };
        assert_eq!(errtext::inner_message(&raw, &system), message, "{code:08X}");
    }
    // Any other code: the system's text, then the hex code and, when known, its symbolic name.
    let raw = Raw { hresult: 0x8004_0154_u32 as i32, description: None };
    assert_eq!(errtext::inner_message(&raw, &system), "system text for 80040154 (Exception from HRESULT: 0x80040154 (REGDB_E_CLASSNOTREG))");
    // A description from the member wins over every rule.
    let raw = Raw { hresult: 0x8007_0005_u32 as i32, description: Some("Mine".to_owned()) };
    assert_eq!(errtext::inner_message(&raw, &system), "Mine");
    // An empty system text adds nothing before the suffix.
    let raw = Raw { hresult: 0x8004_0154_u32 as i32, description: None };
    assert_eq!(errtext::inner_message(&raw, &|_: i32| Some(String::new())), "Exception from HRESULT: 0x80040154 (REGDB_E_CLASSNOTREG)");
}

#[test]
fn a_member_the_object_does_not_have_and_a_call_on_null_are_refused_with_the_binders_words() {
    let property = errtext::property_not_found("Zoom");
    assert_eq!(property.message(), "The property 'Zoom' cannot be found on this object. Verify that the property exists and can be set.");
    let method = errtext::method_not_found("System.__ComObject", "Frobnicate");
    assert_eq!(method.message(), "Method invocation failed because [System.__ComObject] does not contain a method named 'Frobnicate'.");
    assert_eq!(errtext::null_method_call().message(), "You cannot call a method on a null-valued expression.");
    let unknown = errtext::unknown_member(0x8002_0006_u32 as i32);
    assert!(unknown.unknown_member);
    assert_eq!(unknown.message, "Exception from HRESULT: 0x80020006 (DISP_E_UNKNOWNNAME)");
}

#[test]
fn a_com_failure_is_retried_by_the_wrapped_hresult_not_the_com_code() {
    // The retry helpers compare `$_.Exception.HResult`, the wrapper's code: a failure whose COM code is on the list
    // is not retried unless the wrapper carries a listed code too.
    let raw = Raw { hresult: retry::EXCEL_TRANSIENT[0], description: None };
    let wrapped = errtext::com_error(Access::Get { name: "Value" }, &raw, &|_: i32| None);
    assert_eq!(wrapped.hresult, errtext::WRAPPED_HRESULT);
    let (attempts, _, _) = attempts_until_failure(wrapped.hresult, |clock, operation| retry::excel(clock, "x", &[], operation));
    assert_eq!(attempts, 1);
}
