//! build-time code generation. nothing the server decodes or validates is
//! written by hand:
//!
//! - `cmx2.rs`: every cmx2 schema and the `Event` union, from
//!   `vendor/cmx2/openapi.json` (the file `cmx2.pin` vouches for).
//! - `openclaw.rs`: openclaw's gateway protocol types, from
//!   `vendor/openclaw/protocol.schema.json` (the file `openclaw.pin`
//!   vouches for).
//! - `telemetry.rs`: the telemetry dictionary, from `telemetry/schema.json`
//!   (itself generated from `telemetry/schema.ts`, decision 17).
//!
//! it also tells `rust-embed` where the built app lives. a build script is
//! startup configuration: a malformed input is a broken checkout, so it
//! fails the build with a message instead of limping on.

#![allow(
    clippy::expect_used,
    clippy::panic,
    clippy::print_stdout,
    reason = "a build script speaks to cargo on stdout and fails loudly on a broken checkout"
)]

mod cmx2;
mod openclaw;
mod telemetry;

use std::path::{Path, PathBuf};

fn main() {
    let manifest = PathBuf::from(env("CARGO_MANIFEST_DIR"));
    let root = manifest
        .parent()
        .expect("server/ sits inside the repo root");
    let out = PathBuf::from(env("OUT_DIR"));

    let openapi = root.join("vendor/cmx2/openapi.json");
    rerun_if_changed(&openapi);
    write(&out.join("cmx2.rs"), &cmx2::generate(&read(&openapi)));

    let schema = root.join("vendor/openclaw/protocol.schema.json");
    let pin = root.join("openclaw.pin");
    rerun_if_changed(&schema);
    rerun_if_changed(&pin);
    write(
        &out.join("openclaw.rs"),
        &openclaw::generate(&read(&schema), &read(&pin)),
    );

    let dictionary = root.join("telemetry/schema.json");
    rerun_if_changed(&dictionary);
    write(
        &out.join("telemetry.rs"),
        &telemetry::generate(&read(&dictionary)),
    );

    embed_app(root, &out);
}

/// `rust-embed` reads `$BOXBOX_APP_DIST`. a release binary must carry the
/// app, so a missing build is an error there; a debug build without one
/// embeds an empty folder and the dev server proxies vite instead.
fn embed_app(root: &Path, out: &Path) {
    let dist = root.join("app/dist");
    println!("cargo:rerun-if-changed={}", dist.display());
    let release = env("PROFILE") == "release";
    let folder = if dist.join("index.html").is_file() {
        dist
    } else if release {
        panic!("app/dist/index.html is missing: build the app first (`just build` does both)");
    } else {
        let empty = out.join("no-app");
        std::fs::create_dir_all(&empty).expect("OUT_DIR is writable");
        empty
    };
    println!("cargo:rustc-env=BOXBOX_APP_DIST={}", folder.display());
}

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("cargo sets {name} for build scripts"))
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("reading {}: {e}", path.display()))
}

fn write(path: &Path, source: &str) {
    std::fs::write(path, source).unwrap_or_else(|e| panic!("writing {}: {e}", path.display()));
}

fn rerun_if_changed(path: &Path) {
    println!("cargo:rerun-if-changed={}", path.display());
}

/// generated code is formatted so a compile error inside it reads like code.
fn format(tokens: proc_macro2::TokenStream) -> String {
    let file: syn::File = syn::parse2(tokens).expect("generated tokens parse as a rust file");
    prettyplease::unparse(&file)
}
