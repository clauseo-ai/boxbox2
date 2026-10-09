//! the half of a lookup that talks to a daemon: the reads of the places a
//! repo keeps its icon, the `find/file` search when those come up empty, and
//! the Next.js prerender fallback (`rank.rs` decides what is a candidate,
//! `sniff.rs` what is an image).
//!
//! reads come first because a listing is expensive: the pinned daemon walks
//! the whole directory with a synchronous ripgrep on its event loop, up to 10
//! s (cmx2-asks a29), so `find/file` runs only when every well-known path
//! answered "no such file". a daemon that cannot read files at all (a28)
//! says so on the first read, and no listing is ever asked for.
//!
//! how a failure is told from a verdict is the point of this file, because
//! each is cached differently (`mod.rs`): a repo that was searched and has
//! no icon is a verdict; a daemon that errored, timed out, answered nothing
//! where something must be, or cannot read files at all is not.
//!
//! files are read through `GET /file/content` (cmx2-asks a28), which the
//! pinned daemon does not serve. the shape asked for: raw bytes, a missing
//! path or directory is a 404 named `FileNotFoundError`, a path outside the
//! directory is a 403, a file over `max` a 413. a 404 with any other name
//! is the unknown route, which is how a daemon without a28 answers: that is
//! `Failure::Unsupported`, never "this repo has no icon".

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use reqwest::Method;
use serde::Deserialize;

use super::rank::{self, Dynamic, MAX_DYNAMIC, MAX_STATIC, WELL_KNOWN};
use super::{Icon, MAX_ICON};
use crate::config::HostConfig;
use crate::http::session::urlencode;
use crate::upstream::{plain, request};

/// a read, or a small list: the daemon answers from memory or one stat.
const CALL: Duration = Duration::from_secs(8);
/// a listing, which the pinned daemon builds with a ripgrep it gives up on
/// after 10 s: waiting less than that leaves it stalled with nobody to
/// tell, and asking again stalls it again.
const LISTING_CALL: Duration = Duration::from_secs(15);
/// the names asked for, in order: the literal, then the app-router
/// convention `icon.*` (and `apple-icon.*`, which the fuzzy match finds).
const QUERIES: [&str; 2] = ["favicon", "icon."];
/// the most paths one query asks for; the daemon's own ceiling.
const LISTED: u32 = 200;
/// a listing is a few thousand bytes of paths; this is far past any.
const LISTING_CAP: usize = 4 * 1024 * 1024;
/// a project list is a handful of rows per project.
const PROJECTS_CAP: usize = 4 * 1024 * 1024;
/// a folder answer for `/` is a few dozen rows.
const FOLDERS_CAP: usize = 1024 * 1024;
/// a prerender's `.meta` is a few hundred bytes.
const META_CAP: usize = 64 * 1024;

/// why a lookup could not conclude.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum Failure {
    /// the daemon has no route to read a file (cmx2-asks a28): a fact about
    /// the daemon, true for every repo on it.
    #[error("the host cannot read files")]
    Unsupported,
    /// anything that may not be true a moment later, in plain words.
    #[error("{0}")]
    Transient(String),
}

impl Failure {
    fn transient(reason: impl Into<String>) -> Self {
        Self::Transient(reason.into())
    }
}

/// what reading one file said, when the daemon answered.
#[derive(Debug, PartialEq, Eq)]
pub enum Read {
    Bytes(Vec<u8>),
    /// a file with nothing in it (`touch public/favicon.ico` is common). it
    /// is a file, not an icon, and not a reason to stop looking.
    Empty,
    /// no such file, or a directory.
    Missing,
    /// over the cap asked for.
    TooLarge,
    /// outside the project.
    Outside,
}

/// one project on one host, as far as these calls go. counts the calls it
/// makes for the log line.
#[derive(Debug)]
pub struct Daemon<'a> {
    client: &'a reqwest::Client,
    host: &'a HostConfig,
    /// the project root as `x-cmx2-directory` carries it: percent-encoded
    /// (a header holds ascii; the daemon decodes it).
    directory: String,
    calls: AtomicU32,
}

#[derive(Deserialize)]
struct ErrorName {
    name: Option<String>,
}

#[derive(Deserialize)]
struct Project {
    worktree: Option<String>,
}

#[derive(Deserialize)]
struct Folders {
    home: Option<String>,
}

impl<'a> Daemon<'a> {
    #[must_use]
    pub fn new(client: &'a reqwest::Client, host: &'a HostConfig, root: &str) -> Self {
        Self {
            client,
            host,
            directory: urlencode(root).replace("%2F", "/"),
            calls: AtomicU32::new(0),
        }
    }

    #[must_use]
    pub fn calls(&self) -> u32 {
        self.calls.load(Ordering::Relaxed)
    }

    /// one `GET`, its status and at most `cap` bytes of body; a body past
    /// the cap is `None`, whatever the daemon claimed it would send.
    async fn get(
        &self,
        route: &str,
        scoped: bool,
        cap: usize,
        limit: Duration,
    ) -> Result<(u16, Option<Vec<u8>>), Failure> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        let mut call = request(self.client, self.host, Method::GET, route);
        if scoped {
            call = call.header("x-cmx2-directory", &self.directory);
        }
        let reached = tokio::time::timeout(limit, async {
            let mut response = call.send().await?;
            let status = response.status().as_u16();
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await? {
                if body.len() + chunk.len() > cap {
                    return Ok((status, None));
                }
                body.extend_from_slice(&chunk);
            }
            Ok::<_, reqwest::Error>((status, Some(body)))
        })
        .await;
        match reached {
            Err(_) => Err(Failure::transient(format!(
                "no answer within {}s",
                limit.as_secs()
            ))),
            Ok(Err(e)) => Err(Failure::transient(plain(&e))),
            Ok(Ok(answer)) => Ok(answer),
        }
    }

    /// the project roots the daemon lists, which is what it has opened.
    ///
    /// # Errors
    /// the daemon did not answer with a list.
    pub async fn projects(&self) -> Result<Vec<String>, Failure> {
        let (status, body) = self.get("/project", false, PROJECTS_CAP, CALL).await?;
        let body = body.ok_or_else(|| Failure::transient("the project list was too large"))?;
        if status != 200 {
            return Err(Failure::transient(format!(
                "the project list answered {status}"
            )));
        }
        let projects: Vec<Project> = serde_json::from_slice(&body)
            .map_err(|_| Failure::transient("the project list was not a list"))?;
        Ok(projects.into_iter().filter_map(|p| p.worktree).collect())
    }

    /// the host user's home directory, from the daemon's folder browser
    /// (read at `/`, which holds a few dozen folders: a listing of the
    /// home itself would be the very walk this exists to avoid).
    ///
    /// # Errors
    /// the daemon did not answer with a home.
    pub async fn home(&self) -> Result<String, Failure> {
        let (status, body) = self
            .get("/global/fs?path=%2F", false, FOLDERS_CAP, CALL)
            .await?;
        let body = body.ok_or_else(|| Failure::transient("the folder answer was too large"))?;
        if status != 200 {
            return Err(Failure::transient(format!(
                "the folder browser answered {status}"
            )));
        }
        serde_json::from_slice::<Folders>(&body)
            .ok()
            .and_then(|folders| folders.home)
            .filter(|home| home.starts_with('/'))
            .ok_or_else(|| Failure::transient("the folder browser named no home"))
    }

    /// the paths `find/file` lists for `query`, relative to the project, at
    /// most `limit`.
    ///
    /// # Errors
    /// anything but a list of paths.
    pub async fn find(&self, query: &str, limit: u32) -> Result<Vec<String>, Failure> {
        let route = format!(
            "/find/file?query={}&limit={limit}&type=file",
            urlencode(query)
        );
        let (status, body) = self.get(&route, true, LISTING_CAP, LISTING_CALL).await?;
        let body = body.ok_or_else(|| Failure::transient("the file list was too large"))?;
        if status != 200 {
            return Err(Failure::transient(format!("find/file answered {status}")));
        }
        serde_json::from_slice(&body)
            .map_err(|_| Failure::transient("find/file did not answer a list of paths"))
    }

    /// one file's bytes, at most `cap` of them.
    ///
    /// # Errors
    /// `Unsupported` for a daemon without the route; a transient for an
    /// error, a timeout or a refusal of the credential.
    pub async fn read(&self, path: &str, cap: usize) -> Result<Read, Failure> {
        let route = format!("/file/content?path={}&max={cap}", urlencode(path));
        let (status, body) = self.get(&route, true, cap, CALL).await?;
        match status {
            200 => match body {
                None => Ok(Read::TooLarge),
                Some(bytes) if bytes.is_empty() => Ok(Read::Empty),
                Some(bytes) => Ok(Read::Bytes(bytes)),
            },
            404 => {
                let name = body
                    .and_then(|body| serde_json::from_slice::<ErrorName>(&body).ok())
                    .and_then(|error| error.name);
                if name.as_deref() == Some("FileNotFoundError") {
                    Ok(Read::Missing)
                } else {
                    Err(Failure::Unsupported)
                }
            }
            403 => Ok(Read::Outside),
            413 => Ok(Read::TooLarge),
            401 => Err(Failure::transient("the host refused boxbox's credential")),
            other => Err(Failure::transient(format!("a file read answered {other}"))),
        }
    }
}

/// finds and reads the repo's icon. `Ok(None)` is the verdict: the repo was
/// searched and has none.
///
/// the order is the cost: the well-known paths (`rank::WELL_KNOWN`) and the
/// root app's Next.js prerender are read first, a read each, and only when
/// every one of them is missing or empty is the directory listed. a file
/// that has content and is not a usable image, at a well-known path, ends
/// the search: that is the repo's icon, broken, and a listing would only
/// find something it did not mean.
///
/// # Errors
/// the search could not conclude (`Failure`).
pub async fn find_icon(daemon: &Daemon<'_>) -> Result<Option<Icon>, Failure> {
    let mut broken = false;
    for path in WELL_KNOWN {
        match daemon.read(path, MAX_ICON).await? {
            Read::Bytes(bytes) => match Icon::from_bytes(bytes) {
                Some(icon) => return Ok(Some(icon)),
                None => broken = true,
            },
            Read::TooLarge | Read::Outside => broken = true,
            Read::Missing | Read::Empty => {}
        }
    }
    if broken {
        return Ok(None);
    }
    let root_app = Dynamic {
        root: String::new(),
        name: "icon",
    };
    if let Some(icon) = prerendered(daemon, &root_app).await? {
        return Ok(Some(icon));
    }
    search(daemon).await
}

/// the listing half: ask `find/file` (both queries, always: a favicon the
/// first finds may be empty or broken, and the daemon keeps its listing a few
/// seconds, so the second costs no second walk), read the best candidates it
/// names, then the prerenders of the icon modules it names.
async fn search(daemon: &Daemon<'_>) -> Result<Option<Icon>, Failure> {
    let mut paths: Vec<String> = Vec::new();
    let mut listed = false;
    for query in QUERIES {
        let found = daemon.find(query, LISTED).await?;
        listed |= !found.is_empty();
        paths.extend(found);
    }
    if !listed && daemon.find("", 1).await?.is_empty() {
        // "icon." matches half of any repo, so empty for both queries means
        // a small repo or a directory with nothing in it. one file of any
        // name says which: none is a directory the daemon has not indexed
        // (or cannot see), never a repo without an icon
        return Err(Failure::transient(
            "find/file lists no files in the directory",
        ));
    }

    let candidates: Vec<String> = candidates(&paths).into_iter().take(MAX_STATIC).collect();
    let mut gone = 0;
    for path in &candidates {
        match daemon.read(path, MAX_ICON).await? {
            Read::Bytes(bytes) => {
                if let Some(icon) = Icon::from_bytes(bytes) {
                    return Ok(Some(icon));
                }
            }
            Read::Missing => gone += 1,
            // an empty file is a file (a 200 of length 0, `touch`ed as a
            // placeholder): the repo has no icon there, and says so
            Read::Empty | Read::TooLarge | Read::Outside => {}
        }
    }
    if !candidates.is_empty() && gone == candidates.len() {
        // every listed icon is gone when read: the listing and the files
        // disagree for a moment, which says nothing about the repo
        return Err(Failure::transient("listed icons could not be read"));
    }

    // the root app's prerender was read before the listing
    let dynamics = rank::rank_dynamic(&paths)
        .into_iter()
        .filter(|dynamic| !(dynamic.root.is_empty() && dynamic.name == "icon"));
    for dynamic in dynamics.take(MAX_DYNAMIC) {
        if let Some(icon) = prerendered(daemon, &dynamic).await? {
            return Ok(Some(icon));
        }
    }
    Ok(None)
}

/// the listed paths worth reading, best first, without the well-known ones
/// already read.
fn candidates(paths: &[String]) -> Vec<String> {
    rank::rank_static(paths)
        .into_iter()
        .filter(|path| !WELL_KNOWN.contains(&path.as_str()))
        .collect()
}

/// what a Next.js build drew for an icon module, read from its output and
/// never by running the module: the `.meta` must say a 200 image, and the
/// `.body` must sniff as one.
async fn prerendered(daemon: &Daemon<'_>, dynamic: &Dynamic) -> Result<Option<Icon>, Failure> {
    let prerender = dynamic.prerender();
    let Read::Bytes(meta) = daemon.read(&format!("{prerender}.meta"), META_CAP).await? else {
        return Ok(None);
    };
    if rank::prerender_image(&meta).is_none() {
        return Ok(None);
    }
    let Read::Bytes(body) = daemon.read(&format!("{prerender}.body"), MAX_ICON).await? else {
        return Ok(None);
    };
    Ok(Icon::from_bytes(body))
}

#[cfg(test)]
mod tests {
    use super::super::testing::{Fake, PNG, SVG, serve};
    use super::*;

    async fn found(fake: Fake) -> (Result<Option<Icon>, Failure>, Vec<String>) {
        let daemon = serve(fake).await;
        let client = reqwest::Client::new();
        let result = find_icon(&Daemon::new(&client, &daemon.host, "/work/app")).await;
        (result, daemon.log())
    }

    fn type_of(result: &Result<Option<Icon>, Failure>) -> Option<&'static str> {
        result.as_ref().ok()?.as_ref().map(|icon| icon.content_type)
    }

    fn asked_for_a_listing(log: &[String]) -> bool {
        log.iter().any(|line| line.starts_with("find"))
    }

    fn reads(log: &[String]) -> Vec<&str> {
        log.iter()
            .filter_map(|line| line.strip_prefix("read "))
            .collect()
    }

    #[tokio::test]
    async fn a_favicon_in_public_is_found_by_reads_alone_never_a_listing() {
        let (result, log) = found(Fake::project()).await;
        // the svg outranks the png: the root and public/ are read in rank order
        assert_eq!(type_of(&result), Some("image/svg+xml"));
        assert!(!asked_for_a_listing(&log), "{log:?}");
        assert_eq!(
            reads(&log),
            [
                "favicon.svg",
                "favicon.png",
                "favicon.ico",
                "public/favicon.svg"
            ]
        );
    }

    #[tokio::test]
    async fn an_app_router_icon_is_found_by_reads_alone() {
        let (result, log) = found(Fake::default().file("src/app/icon.png", PNG)).await;
        assert_eq!(type_of(&result), Some("image/png"));
        assert!(!asked_for_a_listing(&log));
        assert_eq!(reads(&log).last(), Some(&"src/app/icon.png"));
    }

    #[tokio::test]
    async fn the_type_comes_from_the_bytes_not_from_the_name() {
        let (result, _) = found(Fake::default().file("public/favicon.ico", PNG)).await;
        assert_eq!(type_of(&result), Some("image/png"));
    }

    #[tokio::test]
    async fn an_empty_favicon_gives_way_to_the_next_candidate() {
        // `touch public/favicon.ico` is common, and a 200 of length 0 is a file, not a failure
        let fake = Fake::default()
            .file("public/favicon.ico", b"")
            .file("app/icon.png", PNG);
        let (result, log) = found(fake).await;
        assert_eq!(type_of(&result), Some("image/png"));
        assert!(!asked_for_a_listing(&log));
    }

    #[tokio::test]
    async fn an_empty_favicon_in_a_listing_gives_way_to_the_next_listed_candidate() {
        let fake = Fake::default()
            .listing("favicon", &["web/public/favicon.svg"])
            .listing(
                "icon.",
                &["web/public/favicon.svg", "web/static/favicon.png"],
            )
            .file("web/public/favicon.svg", b"")
            .file("web/static/favicon.png", PNG);
        let (result, _) = found(fake).await;
        assert_eq!(type_of(&result), Some("image/png"));
    }

    #[tokio::test]
    async fn a_repo_whose_only_icon_file_is_empty_is_without_an_icon_not_failing() {
        let fake = Fake::default()
            .listing("favicon", &["public/favicon.ico"])
            .file("public/favicon.ico", b"");
        let (result, _) = found(fake).await;
        assert!(matches!(result, Ok(None)), "{result:?}");
    }

    #[tokio::test]
    async fn a_well_known_file_with_content_that_is_not_an_image_ends_the_search() {
        let fake = Fake::default()
            .listing("favicon", &["web/public/favicon.svg"])
            .file("public/favicon.svg", b"<!doctype html><title>404</title>")
            .file("web/public/favicon.svg", SVG);
        let (result, log) = found(fake).await;
        assert!(matches!(result, Ok(None)), "{result:?}");
        assert!(
            !asked_for_a_listing(&log),
            "a broken icon is the repo's icon"
        );
    }

    #[tokio::test]
    async fn a_well_known_file_over_the_cap_ends_the_search_even_when_the_daemon_ignores_max() {
        let mut fake = Fake::default().file("public/favicon.png", &vec![0; MAX_ICON + 1]);
        fake.ignore_max = true;
        let (result, log) = found(fake).await;
        assert!(matches!(result, Ok(None)), "{result:?}");
        assert!(!asked_for_a_listing(&log));
    }

    #[tokio::test]
    async fn a_daemon_that_answers_413_and_403_for_a_well_known_file_is_not_a_failure() {
        for status in [413, 403] {
            let mut fake = Fake::default();
            fake.read_status.insert("public/favicon.svg".into(), status);
            let (result, _) = found(fake).await;
            assert!(matches!(result, Ok(None)), "{status}: {result:?}");
        }
    }

    #[tokio::test]
    async fn the_listing_is_asked_only_when_every_well_known_path_is_missing() {
        let fake = Fake::default()
            .listing("favicon", &["packages/web/public/favicon.svg"])
            .listing("icon.", &["packages/web/public/favicon.svg"])
            .file("packages/web/public/favicon.svg", SVG);
        let (result, log) = found(fake).await;
        assert_eq!(type_of(&result), Some("image/svg+xml"));
        let first_find = log.iter().position(|l| l.starts_with("find")).unwrap();
        assert_eq!(
            first_find,
            WELL_KNOWN.len() + 1,
            "15 reads and the prerender's meta come first"
        );
    }

    #[tokio::test]
    async fn both_queries_run_because_the_first_may_find_only_a_broken_icon() {
        let (_, log) = found(Fake::default().listing("favicon", &["web/favicon.ico"])).await;
        let finds: Vec<&String> = log.iter().filter(|l| l.starts_with("find")).collect();
        assert_eq!(finds, ["find favicon", "find icon."]);
    }

    #[tokio::test]
    async fn the_recorded_listing_drops_the_vendored_icon_and_reads_the_rest_by_rank() {
        // the project's recorded find/file answers, with its files not at a well-known path
        let fake = Fake::default()
            .listing(
                "favicon",
                &[
                    "site/favicon.png",
                    "site/favicon.svg",
                    "node_modules/x/favicon.ico",
                ],
            )
            .listing(
                "icon.",
                &[
                    "app2/icon.tsx",
                    "components/icon.svg",
                    "node_modules/x/favicon.ico",
                    "site/favicon.png",
                    "site/favicon.svg",
                ],
            )
            .file("site/favicon.png", PNG)
            .file("site/favicon.svg", SVG);
        let (result, log) = found(fake).await;
        assert_eq!(type_of(&result), Some("image/svg+xml"));
        assert!(!log.iter().any(|l| l.contains("node_modules")));
        assert_eq!(reads(&log).last(), Some(&"site/favicon.svg"));
    }

    #[tokio::test]
    async fn at_most_three_listed_candidates_are_read() {
        let fake = Fake::default()
            .listing(
                "favicon",
                &[
                    "a/favicon.svg",
                    "b/favicon.svg",
                    "c/favicon.svg",
                    "d/favicon.svg",
                ],
            )
            .file("a/favicon.svg", b"x")
            .file("b/favicon.svg", b"x")
            .file("c/favicon.svg", b"x")
            .file("d/favicon.svg", SVG);
        let (result, log) = found(fake).await;
        assert!(matches!(result, Ok(None)), "{result:?}");
        // after the well-known paths and the root prerender's meta
        let listed: Vec<&str> = reads(&log)[WELL_KNOWN.len() + 1..].to_vec();
        assert_eq!(listed, ["a/favicon.svg", "b/favicon.svg", "c/favicon.svg"]);
    }

    #[tokio::test]
    async fn a_listed_file_over_the_cap_is_skipped_for_the_next() {
        let mut fake = Fake::default()
            .listing("favicon", &["a/favicon.png", "b/favicon.ico"])
            .file("a/favicon.png", &vec![0; MAX_ICON + 1])
            .file("b/favicon.ico", PNG);
        fake.ignore_max = true;
        let (result, _) = found(fake).await;
        assert_eq!(type_of(&result), Some("image/png"));
    }

    #[tokio::test]
    async fn a_nextjs_build_is_read_as_its_prerender_never_run_and_without_a_listing() {
        let fake = Fake::default()
            .file(
                ".next/server/app/icon.meta",
                br#"{"status":200,"headers":{"content-type":"image/png"}}"#,
            )
            .file(".next/server/app/icon.body", PNG);
        let (result, log) = found(fake).await;
        assert_eq!(type_of(&result), Some("image/png"));
        assert!(!asked_for_a_listing(&log));
        assert_eq!(
            reads(&log)[WELL_KNOWN.len()..],
            [".next/server/app/icon.meta", ".next/server/app/icon.body"]
        );
    }

    #[tokio::test]
    async fn a_prerender_found_in_a_package_is_read_from_that_packages_build() {
        let fake = Fake::default()
            .listing("favicon", &["README.md"])
            .listing("icon.", &["packages/web/src/app/icon.tsx"])
            .file(
                "packages/web/.next/server/app/icon.meta",
                br#"{"status":200,"headers":{"content-type":"image/svg+xml"}}"#,
            )
            .file("packages/web/.next/server/app/icon.body", SVG);
        let (result, log) = found(fake).await;
        assert_eq!(type_of(&result), Some("image/svg+xml"));
        assert!(
            !reads(&log).contains(&"packages/web/src/app/icon.tsx"),
            "the module itself is never read"
        );
    }

    #[tokio::test]
    async fn a_prerender_that_is_not_a_200_image_is_not_read_further() {
        let fake = Fake::default()
            .listing("icon.", &["app/icon.tsx"])
            .file(
                ".next/server/app/icon.meta",
                br#"{"status":404,"headers":{"content-type":"image/png"}}"#,
            )
            .file(".next/server/app/icon.body", PNG);
        let (result, log) = found(fake).await;
        assert!(matches!(result, Ok(None)), "{result:?}");
        assert!(!reads(&log).iter().any(|p| p.ends_with("icon.body")));
    }

    #[tokio::test]
    async fn an_unbuilt_nextjs_app_is_a_repo_without_an_icon() {
        // the module is listed; the build has not run, so there is no .meta (a missing file)
        let fake = Fake::default()
            .listing("favicon", &["README.md"])
            .listing("icon.", &["app/icon.tsx"]);
        let (result, _) = found(fake).await;
        assert!(matches!(result, Ok(None)), "{result:?}");
    }

    #[tokio::test]
    async fn files_listed_and_none_an_icon_is_a_verdict_of_none() {
        let fake = Fake::default()
            .listing("favicon", &["src/favicon-colors.ts"])
            .listing("icon.", &["src/icons.ts", "docs/icon-guide.md"]);
        let (result, log) = found(fake).await;
        assert!(matches!(result, Ok(None)), "{result:?}");
        assert_eq!(
            log.iter()
                .filter(|l| l.starts_with("find"))
                .collect::<Vec<_>>(),
            ["find favicon", "find icon."]
        );
    }

    #[tokio::test]
    async fn a_small_repo_matching_neither_query_is_told_from_an_empty_directory_by_one_file() {
        // "favicon" and "icon." are not subsequences of anything in a crate of three files
        let fake = Fake::default().listing("", &["Cargo.toml"]);
        let (result, log) = found(fake).await;
        assert!(matches!(result, Ok(None)), "{result:?}");
        assert_eq!(
            log.iter()
                .rfind(|l| l.starts_with("find"))
                .map(String::as_str),
            Some("find")
        );
    }

    #[tokio::test]
    async fn a_directory_that_lists_nothing_at_all_is_a_daemon_not_ready_never_a_verdict() {
        // the v1 scar: a cold index answers [] with a clean 200. at the pin so does a directory that is not there
        let (result, log) = found(Fake::default()).await;
        assert_eq!(
            result.unwrap_err(),
            Failure::Transient("find/file lists no files in the directory".into())
        );
        let finds: Vec<&String> = log.iter().filter(|l| l.starts_with("find")).collect();
        assert_eq!(finds, ["find favicon", "find icon.", "find"]);
    }

    #[tokio::test]
    async fn an_error_from_find_file_is_transient() {
        let mut fake = Fake::project();
        fake.files.clear();
        fake.find_status = Some(500);
        let (result, _) = found(fake).await;
        assert_eq!(
            result.unwrap_err(),
            Failure::Transient("find/file answered 500".into())
        );
    }

    #[tokio::test]
    async fn find_file_answering_something_that_is_not_a_list_is_transient() {
        let fake = Fake {
            find_body: Some(r#"{"name":"BadRequestError","data":{"message":"x"}}"#.into()),
            ..Fake::default()
        };
        let (result, _) = found(fake).await;
        assert_eq!(
            result.unwrap_err(),
            Failure::Transient("find/file did not answer a list of paths".into())
        );
    }

    #[tokio::test]
    async fn every_listed_icon_missing_when_read_is_transient() {
        let fake = Fake::default().listing("favicon", &["web/favicon.png", "web/favicon.svg"]);
        let (result, _) = found(fake).await;
        assert_eq!(
            result.unwrap_err(),
            Failure::Transient("listed icons could not be read".into())
        );
    }

    #[tokio::test]
    async fn listed_icons_that_are_all_empty_files_are_a_repo_without_an_icon_not_a_failure() {
        // a monorepo of `touch`ed placeholders: a real, empty file is an answer
        let fake = Fake::default()
            .listing(
                "favicon",
                &[
                    "packages/a/public/favicon.ico",
                    "packages/b/public/favicon.ico",
                    "packages/c/public/favicon.ico",
                ],
            )
            .file("packages/a/public/favicon.ico", b"")
            .file("packages/b/public/favicon.ico", b"")
            .file("packages/c/public/favicon.ico", b"");
        let (result, _) = found(fake).await;
        assert!(matches!(result, Ok(None)), "{result:?}");
    }

    #[tokio::test]
    async fn one_empty_and_the_rest_missing_is_still_not_every_icon_gone() {
        let fake = Fake::default()
            .listing("favicon", &["web/favicon.svg", "web/favicon.png"])
            .file("web/favicon.svg", b"");
        let (result, _) = found(fake).await;
        assert!(matches!(result, Ok(None)), "{result:?}");
    }

    #[tokio::test]
    async fn a_daemon_without_the_file_route_is_unsupported_and_is_never_asked_for_a_listing() {
        // the pinned daemon: a 404 NotFoundError "no route for GET /file/content". the first read says so
        let mut fake = Fake::project();
        fake.no_file_route = true;
        let (result, log) = found(fake).await;
        assert_eq!(result.unwrap_err(), Failure::Unsupported);
        assert_eq!(
            log,
            ["read favicon.svg"],
            "one read, and no listing for the daemon to walk"
        );
    }

    #[tokio::test]
    async fn a_404_that_is_not_a_missing_file_is_taken_for_a_missing_route() {
        let mut fake = Fake::default();
        fake.read_status.insert("favicon.svg".into(), 404);
        let (result, _) = found(fake).await;
        assert_eq!(result.unwrap_err(), Failure::Unsupported);
    }

    #[tokio::test]
    async fn a_failing_or_refusing_daemon_on_a_read_is_transient() {
        for status in [500, 502, 401, 400] {
            let mut fake = Fake::project();
            fake.read_status.insert("favicon.svg".into(), status);
            let (result, _) = found(fake).await;
            assert!(
                matches!(result, Err(Failure::Transient(_))),
                "{status}: {result:?}"
            );
        }
    }

    #[tokio::test]
    async fn a_daemon_that_cannot_be_reached_is_transient() {
        let client = reqwest::Client::new();
        let dead = crate::icons::testing::host_at("http://127.0.0.1:9");
        let result = find_icon(&Daemon::new(&client, &dead, "/work/app")).await;
        match result {
            Err(Failure::Transient(reason)) => assert!(reason.contains("connect"), "{reason}"),
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn the_root_travels_percent_encoded_in_the_directory_header() {
        let daemon = serve(Fake::project()).await;
        let client = reqwest::Client::new();
        let daemon_for = Daemon::new(&client, &daemon.host, "/work/café app");
        find_icon(&daemon_for).await.unwrap();
        let sent = daemon.requests();
        assert!(!sent.is_empty());
        assert!(
            sent.iter()
                .all(|r| r.directory.as_deref() == Some("/work/caf%C3%A9%20app"))
        );
    }

    #[tokio::test]
    async fn the_project_list_is_read_without_a_directory_header() {
        let fake = Fake {
            projects: vec!["/work/app".into(), "/work/other/".into()],
            ..Fake::default()
        };
        let daemon = serve(fake).await;
        let client = reqwest::Client::new();
        let list = Daemon::new(&client, &daemon.host, "/work/app")
            .projects()
            .await
            .unwrap();
        assert_eq!(list, ["/work/app", "/work/other/"]);
        assert_eq!(daemon.requests()[0].directory, None);
    }

    #[tokio::test]
    async fn the_hosts_home_is_read_from_the_folder_browser_at_the_root() {
        let fake = Fake {
            home: Some("/Users/me".into()),
            ..Fake::default()
        };
        let daemon = serve(fake).await;
        let client = reqwest::Client::new();
        let home = Daemon::new(&client, &daemon.host, "/Users/me/app")
            .home()
            .await;
        assert_eq!(home.unwrap(), "/Users/me");
        assert_eq!(daemon.requests()[0].directory, None);
        assert_eq!(daemon.requests()[0].what, "");
    }

    #[tokio::test]
    async fn a_folder_browser_that_fails_gives_no_home() {
        let fake = Fake {
            fs_status: Some(500),
            ..Fake::default()
        };
        let daemon = serve(fake).await;
        let client = reqwest::Client::new();
        let home = Daemon::new(&client, &daemon.host, "/w").home().await;
        assert!(matches!(home, Err(Failure::Transient(_))), "{home:?}");
    }
}
