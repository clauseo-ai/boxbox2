//! a daemon on a local port that answers the way cmx2 does (and, for
//! `/file/content`, the way cmx2-asks a28 asks it to), for the lookups'
//! tests. the lookups run their real http through it: the wire, the
//! status classification and the byte caps are the code under test, not a
//! stand-in for them. the `find/file` answers are recorded from the pinned
//! dev daemon (`FAVICON_LISTING`, `ICON_LISTING`).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use reqwest::Url;

use crate::config::{HostConfig, Origin};

/// `GET /find/file?query=favicon&limit=200&type=file` for a scratch project with
/// `public/favicon.png`, `public/favicon.svg`, `app/icon.tsx`,
/// `components/icon.svg` and a vendored `node_modules/x/favicon.ico`.
pub const FAVICON_LISTING: &[&str] = &[
    "public/favicon.png",
    "public/favicon.svg",
    "node_modules/x/favicon.ico",
];
/// the same project's answer to `query=icon.`.
pub const ICON_LISTING: &[&str] = &[
    "app/icon.tsx",
    "components/icon.svg",
    "node_modules/x/favicon.ico",
    "public/favicon.png",
    "public/favicon.svg",
];

pub const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x10\0\0\0\x10";
pub const SVG: &[u8] = b"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"/>";

/// what the daemon holds and how it behaves; set the fields, then `serve`.
#[derive(Debug, Default)]
pub struct Fake {
    /// the answer to `find/file` by query; `[]` for a query not here.
    pub finds: HashMap<String, Vec<String>>,
    /// files by project-relative path.
    pub files: HashMap<String, Vec<u8>>,
    /// the roots `GET /project` lists.
    pub projects: Vec<String>,
    /// the daemon has no `/file/content` route (the pin).
    pub no_file_route: bool,
    /// `find/file` answers this status with an error body.
    pub find_status: Option<u16>,
    /// `find/file` answers 200 with this body instead of a list.
    pub find_body: Option<String>,
    /// `/file/content` answers this status for a path, whatever it holds.
    pub read_status: HashMap<String, u16>,
    /// `/file/content` ignores `max` and sends whatever the file holds.
    pub ignore_max: bool,
    /// the home the folder browser reports; `/home/dev` when left out.
    pub home: Option<String>,
    /// the folder browser answers this status with an error body.
    pub fs_status: Option<u16>,
    /// every answer waits this long first.
    pub delay: Duration,
}

impl Fake {
    pub fn listing(mut self, query: &str, paths: &[&str]) -> Self {
        self.finds.insert(
            query.to_owned(),
            paths.iter().map(|p| (*p).to_owned()).collect(),
        );
        self
    }

    pub fn file(mut self, path: &str, bytes: &[u8]) -> Self {
        self.files.insert(path.to_owned(), bytes.to_vec());
        self
    }

    /// the scratch project: `FAVICON_LISTING` and `ICON_LISTING` with the png and svg in place.
    pub fn project() -> Self {
        Self::default()
            .listing("favicon", FAVICON_LISTING)
            .listing("icon.", ICON_LISTING)
            .file("public/favicon.png", PNG)
            .file("public/favicon.svg", SVG)
    }
}

/// a running fake daemon.
#[derive(Debug)]
pub struct Served {
    pub host: Arc<HostConfig>,
    requests: Arc<Mutex<Vec<Request>>>,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Debug, Clone)]
pub struct Request {
    pub path: String,
    /// `query=` for `find/file`, `path=` for `/file/content`.
    pub what: String,
    /// the `x-cmx2-directory` header, as it arrived.
    pub directory: Option<String>,
}

impl Drop for Served {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Served {
    /// every request so far as `route what`, e.g. `find favicon`, `read public/favicon.png`.
    pub fn log(&self) -> Vec<String> {
        self.requests()
            .iter()
            .map(|r| format!("{} {}", r.path, r.what).trim().to_owned())
            .collect()
    }

    pub fn requests(&self) -> Vec<Request> {
        self.requests.lock().map(|r| r.clone()).unwrap_or_default()
    }

    /// how many requests went to `route` (`find`, `read`, `project`, `home`).
    pub fn count(&self, route: &str) -> usize {
        self.requests().iter().filter(|r| r.path == route).count()
    }
}

struct Inner {
    fake: Fake,
    requests: Arc<Mutex<Vec<Request>>>,
}

pub async fn serve(fake: Fake) -> Served {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let state = Arc::new(Inner {
        fake,
        requests: Arc::clone(&requests),
    });
    let app = Router::new().fallback(answer).with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Served {
        host: host_at(&format!("http://{addr}")),
        requests,
        task,
    }
}

pub fn host_at(url: &str) -> Arc<HostConfig> {
    Arc::new(HostConfig {
        name: "desk".into(),
        url: Url::parse(url).unwrap(),
        credential: None,
        origin: Origin::Config,
    })
}

fn json(status: u16, body: &str) -> Response {
    (
        StatusCode::from_u16(status).unwrap(),
        [(header::CONTENT_TYPE, "application/json")],
        body.to_owned(),
    )
        .into_response()
}

async fn answer(
    State(state): State<Arc<Inner>>,
    uri: axum::http::Uri,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let fake = &state.fake;
    tokio::time::sleep(fake.delay).await;
    let directory = headers
        .get("x-cmx2-directory")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let (route, what) = match uri.path() {
        "/project" => ("project", String::new()),
        "/global/fs" => ("home", String::new()),
        "/find/file" => ("find", query.get("query").cloned().unwrap_or_default()),
        "/file/content" => ("read", query.get("path").cloned().unwrap_or_default()),
        other => (other, String::new()),
    };
    if let Ok(mut log) = state.requests.lock() {
        log.push(Request {
            path: route.to_owned(),
            what: what.clone(),
            directory,
        });
    }
    match route {
        "project" => {
            let rows: Vec<String> = fake
                .projects
                .iter()
                .map(|root| format!(r#"{{"id":"{root}","worktree":"{root}","time":{{"created":1,"updated":2}},"sandboxes":[]}}"#))
                .collect();
            json(200, &format!("[{}]", rows.join(",")))
        }
        "home" => match fake.fs_status {
            Some(status) => json(
                status,
                r#"{"name":"BadRequestError","data":{"message":"no"}}"#,
            ),
            None => json(
                200,
                &format!(
                    r#"{{"path":"/","parent":null,"home":"{}","entries":[]}}"#,
                    fake.home.as_deref().unwrap_or("/home/dev")
                ),
            ),
        },
        "find" if fake.find_body.is_some() => json(200, fake.find_body.as_deref().unwrap_or("")),
        "find" => {
            if let Some(status) = fake.find_status {
                return json(
                    status,
                    r#"{"name":"InternalError","data":{"message":"boom"}}"#,
                );
            }
            let limit: usize = query
                .get("limit")
                .and_then(|l| l.parse().ok())
                .unwrap_or(10);
            let listed: Vec<&String> = fake
                .finds
                .get(&what)
                .map_or_else(Vec::new, |l| l.iter().take(limit).collect());
            json(200, &serde_json::to_string(&listed).unwrap_or_default())
        }
        "read" if fake.no_file_route => json(
            404,
            r#"{"name":"NotFoundError","data":{"message":"no route for GET /file/content"}}"#,
        ),
        "read" => {
            if let Some(status) = fake.read_status.get(&what) {
                return json(*status, r#"{"name":"Error","data":{"message":"no"}}"#);
            }
            let Some(bytes) = fake.files.get(&what) else {
                return json(
                    404,
                    &format!(
                        r#"{{"name":"FileNotFoundError","data":{{"message":"no file {what}"}}}}"#
                    ),
                );
            };
            let max: usize = query
                .get("max")
                .and_then(|m| m.parse().ok())
                .unwrap_or(1 << 20);
            if bytes.len() > max && !fake.ignore_max {
                return json(
                    413,
                    r#"{"name":"FileTooLargeError","data":{"message":"too big"}}"#,
                );
            }
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/octet-stream")],
                bytes.clone(),
            )
                .into_response()
        }
        _ => json(
            404,
            r#"{"name":"NotFoundError","data":{"message":"no route"}}"#,
        ),
    }
}
