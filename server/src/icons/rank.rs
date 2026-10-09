//! which of the paths `find/file` listed could be a repo's icon, best
//! first, and what a Next.js build says about the icon it drew. pure: the
//! network half is `discover.rs`.

use serde_json::Value;

/// the most static candidates read before giving up on the list.
pub const MAX_STATIC: usize = 3;
/// the most prerendered icons read; a repo has an `icon` and an `apple-icon`.
pub const MAX_DYNAMIC: usize = 2;

/// image kinds a browser draws in an `<img>`, best first at a few pixels
/// across: svg scales cleanest, an ico is often already 16 px.
const EXTENSIONS: [&str; 8] = ["svg", "png", "ico", "webp", "avif", "gif", "jpg", "jpeg"];
/// directories whose files are vendored or generated, never a repo's face.
const SKIPPED: [&str; 7] = [
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "out",
    "coverage",
];
/// where a bare `icon.*` or `apple-*` counts: the app-identity conventions,
/// at the root or under `src/`. a component library's `icon.png` is not
/// the repo's face.
const HOMES: [&str; 4] = ["app", "public", "static", "assets"];

/// where a repo that has an icon almost always keeps it, in the order
/// `rank_static` would rank them: read straight through the file route,
/// before any listing is asked for (a listing makes the daemon walk the
/// whole directory, which for a big root stalls it, cmx2-asks a29).
pub const WELL_KNOWN: [&str; 15] = [
    "favicon.svg",
    "favicon.png",
    "favicon.ico",
    "public/favicon.svg",
    "static/favicon.svg",
    "public/favicon.png",
    "static/favicon.png",
    "app/favicon.ico",
    "public/favicon.ico",
    "static/favicon.ico",
    "src/app/favicon.ico",
    "app/icon.svg",
    "app/icon.png",
    "src/app/icon.svg",
    "src/app/icon.png",
];

/// a path as the daemon listed it, made safe to read back: no `./`, no
/// directory marker, nothing that could step out of the project.
fn clean(raw: &str) -> Option<&str> {
    let path = raw.strip_prefix("./").unwrap_or(raw);
    let fits = !path.is_empty()
        && !path.ends_with('/')
        && !path.starts_with('/')
        && !path.contains(['\0', '\\'])
        && path.split('/').all(|part| !part.is_empty() && part != "..");
    fits.then_some(path)
}

fn skipped(directories: &[&str]) -> bool {
    directories.iter().any(|part| SKIPPED.contains(part))
}

/// how a name ranks: `favicon` first, then `icon`, then the apple ones.
fn name_rank(stem: &str) -> Option<u8> {
    match stem {
        "favicon" => Some(0),
        "icon" => Some(1),
        "apple-icon" | "apple-touch-icon" => Some(2),
        _ => None,
    }
}

fn in_home(directories: &[&str]) -> bool {
    match directories {
        [] => true,
        [only] => HOMES.contains(only),
        ["src", home] => HOMES.contains(home),
        _ => false,
    }
}

/// the listed paths that could be a repo's icon, best first: the name
/// (`favicon`, then `icon`, then the apple ones), then the shallower path,
/// then the extension ladder, then the path itself so the order is stable.
#[must_use]
pub fn rank_static(paths: &[String]) -> Vec<String> {
    let mut rows: Vec<((u8, usize, usize), &str)> = Vec::new();
    for raw in paths {
        let Some(path) = clean(raw) else { continue };
        let mut parts: Vec<&str> = path.split('/').collect();
        let Some(file) = parts.pop() else { continue };
        if skipped(&parts) {
            continue;
        }
        let lower = file.to_ascii_lowercase();
        let Some((stem, extension)) = lower.rsplit_once('.') else {
            continue;
        };
        let (Some(name), Some(kind)) = (
            name_rank(stem),
            EXTENSIONS.iter().position(|known| *known == extension),
        ) else {
            continue;
        };
        if name != 0 && !in_home(&parts) {
            continue;
        }
        if rows.iter().all(|(_, seen)| *seen != path) {
            rows.push(((name, parts.len(), kind), path));
        }
    }
    rows.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(b.1)));
    rows.into_iter().map(|(_, path)| path.to_owned()).collect()
}

/// a Next.js icon drawn in code (`app/icon.tsx`): where its build output
/// lives and which of the two it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dynamic {
    /// the app's root inside the project, empty or ending in `/`
    /// (`packages/web/`): the build's output is `<root>.next/...`.
    pub root: String,
    /// `icon` or `apple-icon`.
    pub name: &'static str,
}

impl Dynamic {
    /// where the build left what this icon drew, without the extension:
    /// `<root>.next/server/app/<name>`, whose `.body` is the pixels and
    /// `.meta` says what they are.
    #[must_use]
    pub fn prerender(&self) -> String {
        format!("{}.next/server/app/{}", self.root, self.name)
    }
}

/// the listed paths that are an app-router icon module, `icon` before
/// `apple-icon`, shallower apps before deeper ones. at most one of each
/// per app, whatever its extension.
#[must_use]
pub fn rank_dynamic(paths: &[String]) -> Vec<Dynamic> {
    let mut rows: Vec<(u8, usize, Dynamic)> = Vec::new();
    for raw in paths {
        let Some(path) = clean(raw) else { continue };
        let mut parts: Vec<&str> = path.split('/').collect();
        let Some(file) = parts.pop() else { continue };
        if skipped(&parts) || parts.pop() != Some("app") {
            continue;
        }
        let name = match file.rsplit_once('.') {
            Some(("icon", "tsx" | "ts" | "jsx" | "js")) => "icon",
            Some(("apple-icon", "tsx" | "ts" | "jsx" | "js")) => "apple-icon",
            _ => continue,
        };
        if parts.last() == Some(&"src") {
            parts.pop();
        }
        let root = if parts.is_empty() {
            String::new()
        } else {
            format!("{}/", parts.join("/"))
        };
        if rows
            .iter()
            .all(|(_, _, seen)| seen.root != root || seen.name != name)
        {
            rows.push((
                u8::from(name != "icon"),
                parts.len(),
                Dynamic { root, name },
            ));
        }
    }
    rows.sort_by_key(|(name, depth, _)| (*name, *depth));
    rows.into_iter().map(|(_, _, dynamic)| dynamic).collect()
}

/// what a prerender's `.meta` sidecar says it holds: only a 200 whose
/// content type is an image means the build produced pixels. the type it
/// names is not trusted for serving (`sniff.rs` decides that); this only
/// says whether to read the body at all.
#[must_use]
pub fn prerender_image(meta: &[u8]) -> Option<String> {
    let meta: Value = serde_json::from_slice(meta).ok()?;
    if meta.get("status")?.as_u64()? != 200 {
        return None;
    }
    let kind = meta.get("headers")?.get("content-type")?.as_str()?;
    let kind = kind.trim().to_ascii_lowercase();
    kind.starts_with("image/").then_some(kind)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(paths: &[&str]) -> Vec<String> {
        paths.iter().map(|p| (*p).to_owned()).collect()
    }

    #[test]
    fn the_well_known_paths_are_all_candidates_and_already_in_rank_order() {
        let known: Vec<String> = WELL_KNOWN.iter().map(|p| (*p).to_owned()).collect();
        assert_eq!(rank_static(&known), known);
    }

    #[test]
    fn a_favicon_beats_shallower_depth_and_svg_beats_ico() {
        let ranked = rank_static(&list(&[
            "packages/web/public/favicon.ico",
            "app/favicon.ico",
            "public/favicon.svg",
        ]));
        assert_eq!(
            ranked,
            [
                "public/favicon.svg",
                "app/favicon.ico",
                "packages/web/public/favicon.ico"
            ]
        );
    }

    #[test]
    fn a_favicon_beats_an_app_icon_and_apple_icons_trail() {
        let ranked = rank_static(&list(&[
            "public/apple-touch-icon.png",
            "app/icon.png",
            "public/apple-icon.png",
            "public/favicon.ico",
        ]));
        assert_eq!(
            ranked,
            [
                "public/favicon.ico",
                "app/icon.png",
                "public/apple-icon.png",
                "public/apple-touch-icon.png"
            ]
        );
    }

    #[test]
    fn the_extension_ladder_runs_svg_png_ico_webp_avif_gif_jpg_jpeg() {
        let ranked = rank_static(&list(&[
            "favicon.jpeg",
            "favicon.jpg",
            "favicon.gif",
            "favicon.avif",
            "favicon.webp",
            "favicon.ico",
            "favicon.png",
            "favicon.svg",
        ]));
        let order: Vec<&str> = ranked
            .iter()
            .map(|p| p.rsplit('.').next().unwrap_or(""))
            .collect();
        assert_eq!(
            order,
            ["svg", "png", "ico", "webp", "avif", "gif", "jpg", "jpeg"]
        );
    }

    #[test]
    fn a_bare_icon_only_counts_at_an_identity_home() {
        let ranked = rank_static(&list(&[
            "components/ui/icon.svg",
            "src/app/icon.png",
            "assets/icon.ico",
            "src/lib/icon.png",
            "packages/ui/public/icon.png",
            "icon.gif",
        ]));
        assert_eq!(ranked, ["icon.gif", "assets/icon.ico", "src/app/icon.png"]);
    }

    #[test]
    fn a_favicon_counts_wherever_it_lives() {
        assert_eq!(
            rank_static(&list(&["docs/site/static/img/favicon.png"])),
            ["docs/site/static/img/favicon.png"]
        );
    }

    #[test]
    fn vendored_generated_and_look_alike_files_never_rank() {
        let ranked = rank_static(&list(&[
            "node_modules/pkg/favicon.ico",
            "web/.next/static/favicon.ico",
            "dist/favicon.png",
            "build/icon.png",
            "out/favicon.svg",
            "coverage/favicon.png",
            ".git/favicon.png",
            "app/favicon.tsx",
            "docs/favicons.md",
            "lib/favicon.ico.bak",
            "lib/favicon-colors.ts",
            "public/my-favicon.png",
            "public/favicon",
            "public/",
        ]));
        assert!(ranked.is_empty(), "{ranked:?}");
    }

    #[test]
    fn a_directory_that_only_starts_like_a_skipped_one_is_kept() {
        // `outer` is not `out`: a whole directory name has to match
        assert_eq!(
            rank_static(&list(&["public/favicon.png", "outer/favicon.png"])),
            ["outer/favicon.png", "public/favicon.png"]
        );
    }

    #[test]
    fn names_match_in_any_case_and_duplicates_collapse() {
        let ranked = rank_static(&list(&[
            "public/Favicon.ICO",
            "./public/Favicon.ICO",
            "public/Favicon.ICO",
        ]));
        assert_eq!(ranked, ["public/Favicon.ICO"]);
    }

    #[test]
    fn a_path_that_could_leave_the_project_is_dropped() {
        let ranked = rank_static(&list(&[
            "../favicon.ico",
            "/etc/favicon.ico",
            "a/../favicon.ico",
            "a\\favicon.ico",
            "a//favicon.ico",
        ]));
        assert!(ranked.is_empty(), "{ranked:?}");
    }

    #[test]
    fn ties_in_everything_break_by_path_so_the_order_is_stable() {
        assert_eq!(
            rank_static(&list(&["b/favicon.png", "a/favicon.png"])),
            ["a/favicon.png", "b/favicon.png"]
        );
    }

    #[test]
    fn an_app_icon_module_is_found_wherever_the_app_lives() {
        let ranked = rank_dynamic(&list(&[
            "app/icon.tsx",
            "src/app/icon.tsx",
            "packages/web/app/icon.ts",
            "packages/docs/src/app/icon.js",
        ]));
        let roots: Vec<&str> = ranked.iter().map(|d| d.root.as_str()).collect();
        assert_eq!(roots, ["", "packages/web/", "packages/docs/"]);
        assert!(ranked.iter().all(|d| d.name == "icon"));
    }

    #[test]
    fn icon_comes_before_apple_icon_and_noise_never_counts() {
        let ranked = rank_dynamic(&list(&[
            "app/apple-icon.tsx",
            "app/icon.jsx",
            "components/icon.tsx",
            "node_modules/pkg/app/icon.tsx",
            "app/icon.css",
            "app/icon.png",
            "pages/icon.tsx",
        ]));
        assert_eq!(
            ranked,
            [
                Dynamic {
                    root: String::new(),
                    name: "icon"
                },
                Dynamic {
                    root: String::new(),
                    name: "apple-icon"
                },
            ]
        );
    }

    #[test]
    fn a_prerender_lives_under_the_apps_dot_next() {
        let ranked = rank_dynamic(&list(&["packages/web/src/app/apple-icon.tsx"]));
        assert_eq!(
            ranked[0].prerender(),
            "packages/web/.next/server/app/apple-icon"
        );
        assert_eq!(
            Dynamic {
                root: String::new(),
                name: "icon"
            }
            .prerender(),
            ".next/server/app/icon"
        );
    }

    #[test]
    fn a_prerender_meta_with_status_200_and_an_image_type_is_an_image() {
        let meta = br#"{"status":200,"headers":{"content-type":"image/png","cache-control":"public, max-age=0"}}"#;
        assert_eq!(prerender_image(meta).as_deref(), Some("image/png"));
    }

    #[test]
    fn a_prerender_meta_that_is_not_a_200_image_is_refused() {
        let refused = |meta: &str| prerender_image(meta.as_bytes()).is_none();
        assert!(refused(
            r#"{"status":404,"headers":{"content-type":"image/png"}}"#
        ));
        assert!(refused(
            r#"{"status":200,"headers":{"content-type":"text/html"}}"#
        ));
        assert!(refused(r#"{"status":200,"headers":{}}"#));
        assert!(refused(r#"{"headers":{"content-type":"image/png"}}"#));
        assert!(refused("not json"));
        assert!(refused(""));
    }
}
