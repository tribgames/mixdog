//! The composition receipt a session resends: read from the saved deck, then delivered once and collapsed to what changed.

use mixdog_office_author::receipt::{DeliveredReceipt, composition_receipt, receipt_for_delivery};
use serde_json::{Value, json};

fn title(size: u32) -> Value {
    json!({ "text": "Title", "font": { "size": size }, "width": 800, "height": 60 })
}

fn deck(second_slide_size: u32) -> Value {
    json!({ "slides": [
        { "index": 1, "background": { "color": "0F1B26" }, "shapes": [title(47), { "text": "01", "font": { "size": 240 }, "width": 400, "height": 300 }] },
        { "index": 2, "background": { "color": "F7F9FB" }, "shapes": [title(second_slide_size), { "text": "body", "font": { "size": 18 }, "width": 800, "height": 200 }] },
        { "index": 3, "background": { "color": "F7F9FB" }, "shapes": [title(36), { "text": "detail", "font": { "size": 13 }, "width": 200, "height": 80 }] },
    ] })
}

fn slides(receipt: &Value) -> Vec<Value> {
    receipt["slides"].as_array().unwrap_or_else(|| panic!("{receipt}")).clone()
}

#[test]
fn a_receipt_has_one_entry_per_saved_slide() {
    let receipt = composition_receipt(&deck(36), None);
    assert_eq!(slides(&receipt).len(), 3, "{receipt}");
}

#[test]
fn without_a_session_the_receipt_goes_out_as_it_is() {
    let receipt = composition_receipt(&deck(36), None);
    assert_eq!(receipt_for_delivery(&receipt, None), receipt);
}

#[test]
fn a_part_the_session_already_holds_goes_out_unchanged_and_only_a_changed_slide_is_sent_in_full() {
    let mut session = DeliveredReceipt::default();
    let first = composition_receipt(&deck(36), None);
    let first_out = receipt_for_delivery(&first, Some(&mut session));
    assert!(slides(&first_out).iter().all(|slide| slide.get("unchanged").is_none()), "the first delivery is whole: {first_out}");
    assert!(first_out.get("unchangedMeans").is_none());

    let again = receipt_for_delivery(&composition_receipt(&deck(36), None), Some(&mut session));
    assert!(slides(&again).iter().all(|slide| slide["unchanged"] == true), "{again}");
    assert!(again["unchangedMeans"].as_str().expect("the explanation").starts_with("unchanged: this part matches the receipt this session sent last"));

    let changed = receipt_for_delivery(&composition_receipt(&deck(20), None), Some(&mut session));
    let out = slides(&changed);
    assert_eq!(out.len(), 3);
    assert_eq!((out[0].get("unchanged").is_some(), out[1].get("unchanged").is_some(), out[2].get("unchanged").is_some()), (true, false, true), "{changed}");
}

#[test]
fn delivery_changes_nothing_in_the_receipt_it_is_given() {
    let mut session = DeliveredReceipt::default();
    let receipt = composition_receipt(&deck(36), None);
    let before = receipt.clone();
    receipt_for_delivery(&receipt, Some(&mut session));
    receipt_for_delivery(&receipt, Some(&mut session));
    assert_eq!(receipt, before);
}
