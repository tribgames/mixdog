//! The qpdf side of `pdf/pdf-security.mjs` that needs no qpdf: the arguments of an encryption and a decryption, the
//! temporary sibling of a file secured in place, the response file's text and the refusal of a password a response file
//! cannot carry. No test here starts a program.

use std::path::{Path, PathBuf};

use mixdog_office_pdf::security::{PASSWORD_LINE_BREAK, QPDF_INSTALL_HINT, SecureRequest, check_passwords, plan_secure, response_text};

fn request<'a>(mode: &'a str, input: &'a str, output: &'a str, password: &'a str, owner: &'a str) -> SecureRequest<'a> {
    SecureRequest { input, output, mode, password, owner_password: owner }
}

#[test]
fn an_encryption_names_aes_256_and_the_owner_password_defaults_to_the_user_one() {
    let plan = plan_secure(&request("encrypt", "in.pdf", "out.pdf", "user", ""), "7");
    assert_eq!(plan.args, ["--encrypt", "user", "user", "256", "--", "in.pdf", "out.pdf"]);
    assert!(!plan.same_path);
    assert_eq!(plan.target, PathBuf::from("out.pdf"));
    let owned = plan_secure(&request("encrypt", "in.pdf", "out.pdf", "user", "owner"), "7");
    assert_eq!(owned.args[1..3], ["user", "owner"]);
}

#[test]
fn any_other_mode_decrypts_with_the_password_in_the_option() {
    let plan = plan_secure(&request("decrypt", "in.pdf", "out.pdf", "pw", ""), "7");
    assert_eq!(plan.args, ["--password=pw", "--decrypt", "in.pdf", "out.pdf"]);
    assert_eq!(plan_secure(&request("whatever", "in.pdf", "out.pdf", "", ""), "7").args[1], "--decrypt");
}

#[test]
fn the_same_file_goes_through_a_temporary_sibling_whatever_the_case() {
    let plan = plan_secure(&request("decrypt", "dir/In.pdf", "dir/in.PDF", "pw", ""), "9");
    assert!(plan.same_path);
    assert_eq!(plan.target, Path::new("dir").join(".mixdog-qpdf-9.pdf"));
    assert_eq!(plan.response, Path::new("dir").join(".mixdog-qpdf-9.args"));
    assert_eq!(plan.args[3], plan.target.to_string_lossy());
}

#[test]
fn the_response_file_sits_beside_the_output_and_holds_one_literal_argument_per_line() {
    let plan = plan_secure(&request("decrypt", "in.pdf", "out/out.pdf", "a b\"c", ""), "1");
    assert_eq!(plan.response, Path::new("out").join(".mixdog-qpdf-1.args"));
    assert_eq!(response_text(&plan.args), "--password=a b\"c\n--decrypt\nin.pdf\nout/out.pdf\n");
}

#[test]
fn a_line_break_in_either_password_is_refused_and_other_characters_pass() {
    assert_eq!(check_passwords("a\nb", "").expect_err("refused").message, PASSWORD_LINE_BREAK);
    assert_eq!(check_passwords("a", "b\rc").expect_err("refused").message, PASSWORD_LINE_BREAK);
    assert!(check_passwords("a b", "c\"d '$%").is_ok());
}

#[test]
fn the_install_hint_names_the_variable_and_the_three_package_managers() {
    for word in ["MIXDOG_QPDF_PATH", "winget install qpdf", "brew install qpdf", "apt install qpdf", "left as is"] {
        assert!(QPDF_INSTALL_HINT.contains(word), "{word}");
    }
}
