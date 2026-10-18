//! links an `Info.plist` into the macos binary (`__TEXT,__info_plist`), so the
//! microphone prompt has its usage string and codesign binds the bundle id.
//! a bare binary has no bundle to carry one, and a wrapper process would
//! take the permission away from the daemon itself.

// a build script talks to cargo through stdout.
#![allow(clippy::print_stdout)]

use std::fmt::Write as _;
use std::path::PathBuf;

const USAGE: &str = "the board's meter shows your voice level while the talk key is held. nothing is recorded or sent.";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return Ok(());
    }
    let version = std::env::var("CARGO_PKG_VERSION")?;
    let mut plist = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n<dict>\n",
    );
    for (key, value) in [
        ("CFBundleIdentifier", "dev.boxbox.board"),
        ("CFBundleName", "boxbox-board"),
        ("CFBundleVersion", version.as_str()),
        ("CFBundleShortVersionString", version.as_str()),
        ("NSMicrophoneUsageDescription", USAGE),
    ] {
        writeln!(
            plist,
            "\t<key>{key}</key>\n\t<string>{}</string>",
            escape(value)
        )?;
    }
    plist.push_str("</dict>\n</plist>\n");
    let path = PathBuf::from(std::env::var("OUT_DIR")?).join("Info.plist");
    std::fs::write(&path, plist)?;
    println!(
        "cargo:rustc-link-arg-bin=boxbox-board=-Wl,-sectcreate,__TEXT,__info_plist,{}",
        path.display()
    );
    Ok(())
}

fn escape(raw: &str) -> String {
    raw.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
