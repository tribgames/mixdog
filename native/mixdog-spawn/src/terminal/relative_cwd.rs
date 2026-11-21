use super::*;

/// node-pty took a relative `cwd` against the process's working directory; so does the tab.
#[test]
fn a_relative_cwd_is_taken_against_the_working_directory() {
    let here = std::env::current_dir().unwrap();
    assert_eq!(resolve_cwd("sub/dir").unwrap(), here.join("sub/dir"));
    assert!(AbsPath::new(resolve_cwd("sub").unwrap()).is_some());
}

#[test]
fn an_absolute_cwd_is_kept() {
    let absolute = std::env::current_dir().unwrap();
    assert_eq!(resolve_cwd(absolute.to_str().unwrap()).unwrap(), absolute);
}
