//! DS-REM-1: each of the 190 phone methods is served or mapped. A phone connection is a relay
//! origin; a method that maps to protocol methods must be callable from the relay origin.

use std::collections::{BTreeSet, HashMap};

use mixdog_app_protocol::CLIENT_METHODS;
use mixdog_app_protocol::inventory::{INVENTORY, InventoryList, Target};
use mixdog_protocol::{Origin, SectionName};

#[test]
fn all_190_phone_methods_have_a_relay_reachable_target() {
    let methods: HashMap<&str, bool> =
        CLIENT_METHODS.iter().map(|spec| (spec.method, spec.allows(Origin::Relay))).collect();
    let sections: BTreeSet<&str> = SectionName::ALL.iter().map(|s| s.wire()).collect();
    let remote: Vec<_> = INVENTORY.iter().filter(|(list, ..)| *list == InventoryList::Remote).collect();
    assert_eq!(remote.len(), 190);
    let mut unserved = Vec::new();
    for (_, name, target) in &remote {
        let served = match target {
            Target::Method(m) => methods.get(m).copied().unwrap_or(false),
            Target::Methods(ms) => ms.iter().all(|m| methods.get(m).copied().unwrap_or(false)),
            Target::Section(s) => sections.contains(s),
            // Every other kind is a recorded decision with its reason (DS §17), a notification
            // or a host seam, none of which a phone calls as a method.
            Target::Notification(_)
            | Target::ClientNotification(_)
            | Target::ServerRequestResponse(_)
            | Target::HostRequest(_)
            | Target::MediaFrame(_)
            | Target::InitializeField(_) => true,
            Target::ByDesign(why) | Target::Internal(why) | Target::Deleted(why) => !why.is_empty(),
        };
        if !served {
            unserved.push(format!("{name} -> {target:?}"));
        }
    }
    assert!(unserved.is_empty(), "not reachable from a phone: {unserved:#?}");
}
