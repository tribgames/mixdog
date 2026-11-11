//! A fixture is read from the checkout the test was built and runs in, whichever checkout compiled the libraries it
//! links: rustc-slot shares a compiled library between checkouts, and a library that kept another checkout's path would
//! read that checkout's fixture. (The compile cache never shares mixdog-testkit's library, whose dep-info names its
//! manifest directory; the test binary itself is never shared.)

use mixdog_testkit::Fixture;
use mixdog_testkit::fixture;
use mixdog_testkit::fixture_const;
use mixdog_testkit::read_string;

const OWN: Fixture = fixture_const!("tests/own_checkout.txt");

#[test]
fn a_fixture_is_the_file_of_the_checkout_the_test_runs_in() {
    // The checkout cargo and nextest name at run time, not the one any compile saw.
    let here = read_string(std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("tests/own_checkout.txt"));
    assert_eq!(fixture!("tests/own_checkout.txt"), here);
    assert_eq!(&*OWN, here);
}
