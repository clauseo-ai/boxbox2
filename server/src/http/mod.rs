//! the http surface: the gate, the api, the app, and one log line per
//! request.

pub mod asks;
pub mod assets;
pub mod compose;
pub mod compress;
pub mod error;
pub mod fleet;
pub mod history;
pub mod hosts;
pub mod login;
pub mod needs;
pub mod openapi;
pub mod prefs;
pub mod push;
pub mod repo_icon;
pub mod review;
pub mod session;
pub mod stream;
pub mod telemetry;
pub mod threads;
pub mod transcript;

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Router;
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::HeaderValue;
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{any, get, post};

use crate::pty::routes as pty;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info};

use crate::auth::Auth;
use crate::fleet::Fleet;
use crate::upstream::Upstreams;
use assets::Assets;
use error::ApiError;

/// what every route may read. each part has its own owner; nothing here is
/// mutable.
#[derive(Debug)]
pub struct AppState {
    pub auth: Auth,
    pub upstreams: Upstreams,
    pub fleet: Fleet,
    /// for reads the server makes of a host on a client's behalf.
    pub client: reqwest::Client,
    pub telemetry: crate::telemetry::Sender,
    pub push: crate::push::Push,
    /// `boxbox.db`'s writer: paired hosts and prefs go through it.
    pub store: crate::store::Store,
    /// the terminal relays and what they share.
    pub terminals: crate::pty::Terminals,
    pub assets: Assets,
    /// repo favicons, found on their hosts once and remembered (`icons/`).
    pub icons: crate::icons::Icons,
    /// new threads by client id, so a retried birth makes no second thread.
    pub births: compose::Births,
    /// fired at shutdown; streams end on it.
    pub shutdown: CancellationToken,
}

/// the id `log_request` gave a request, for the routes that log a line of
/// their own about it.
#[derive(Debug, Clone)]
pub struct RequestId(pub Arc<str>);

/// a login or any other small json body; nothing legitimate is larger.
const SMALL_BODY: usize = 64 * 1024;
/// 500 events of a few hundred bytes each, with room to spare.
const TELEMETRY_BODY: usize = 1024 * 1024;
/// a message of 100,000 characters, most of them multibyte, in json (under 1 MiB), with the photos of
/// one message as data urls: at most 24 MiB together (`compose::MAX_PHOTOS_TOTAL`: four resized jpegs,
/// or two heic originals at the limit).
const PROMPT_BODY: usize = 25 * 1024 * 1024;
const MIB: usize = 1024 * 1024;
/// the memory, in MiB, the routes may use for photos at once: two messages at the body limit, each counted twice
/// (`photo_weight`). it is a limit on what the process can reach and not on what it is told, so the peak above an
/// idle server is this and no more however many phones send together (`architecture.md`, memory).
const PHOTO_BUDGET_MIB: usize = 2 * 2 * (PROMPT_BODY / MIB);
/// how long a message with photos waits for room before it is turned away. nothing of it has been read while it
/// waits, so waiting holds no memory, and a message behind two others that are being converted goes when they
/// are done. the device's post is given this on top of everything else it waits for (`postBudgetMs`).
const PHOTO_WAIT: Duration = Duration::from_secs(120);
/// a body this small carries no photo worth counting: words never wait for photos.
const PHOTO_WEIGHT_FLOOR: usize = 256 * 1024;

pub fn router(state: Arc<AppState>) -> Router {
    router_waiting(state, PHOTO_WAIT)
}

/// the router, with `photo_wait` as the time a message with photos waits for room (the tests make it short)
#[allow(
    clippy::too_many_lines,
    reason = "the route table is one list, read top to bottom"
)]
fn router_waiting(state: Arc<AppState>, photo_wait: Duration) -> Router {
    let photos = PhotoBudget {
        room: Arc::new(Semaphore::new(PHOTO_BUDGET_MIB)),
        wait: photo_wait,
    };
    let gated = Router::new()
        .route("/api/hosts", get(hosts::list))
        .route("/api/hosts/pair", post(hosts::pair))
        .route("/api/hosts/{host}", axum::routing::delete(hosts::forget))
        .route("/api/hosts/{host}/reload", post(hosts::reload))
        .route("/api/hosts/{host}/restart", post(hosts::restart))
        .route("/api/hosts/{host}/models", get(hosts::models))
        .route("/api/prefs", get(prefs::all))
        .route(
            "/api/prefs/devices/{device}",
            axum::routing::put(prefs::device),
        )
        .route("/api/prefs/repos", axum::routing::put(prefs::repo))
        .route(
            "/api/prefs/models",
            axum::routing::put(prefs::favorite_models),
        )
        .route("/api/stream", get(stream::stream))
        .route("/api/fleet", get(fleet::snapshot))
        .route(
            "/api/hosts/{host}/sessions/{session}/messages",
            get(transcript::messages),
        )
        .route(
            "/api/hosts/{host}/sessions/{session}/messages/{message}",
            get(transcript::message).delete(session::unsend),
        )
        .merge(lifecycle())
        .route("/api/needs", get(needs::list))
        .route("/api/read", post(needs::read))
        .route(
            "/api/hosts/{host}/permissions/{ask}",
            post(asks::permission),
        )
        .route("/api/hosts/{host}/questions/{ask}", post(asks::question))
        .route(
            "/api/hosts/{host}/questions/{ask}/reject",
            post(asks::reject),
        )
        .route(
            "/api/hosts/{host}/sessions/{session}/prompt",
            post(asks::prompt)
                .layer(DefaultBodyLimit::max(PROMPT_BODY))
                .layer(middleware::from_fn_with_state(photos.clone(), photo_budget)),
        )
        .route(
            "/api/hosts/{host}/sessions/{session}/steer",
            post(compose::steer)
                .layer(DefaultBodyLimit::max(PROMPT_BODY))
                .layer(middleware::from_fn_with_state(photos.clone(), photo_budget)),
        )
        .route(
            "/api/hosts/{host}/sessions/{session}/shell",
            post(compose::shell),
        )
        .route(
            "/api/hosts/{host}/sessions/{session}/command",
            post(compose::command),
        )
        .route(
            "/api/hosts/{host}/sessions",
            post(compose::start)
                .layer(DefaultBodyLimit::max(PROMPT_BODY))
                .layer(middleware::from_fn_with_state(photos.clone(), photo_budget)),
        )
        .route("/api/hosts/{host}/commands", get(compose::commands))
        .route("/api/hosts/{host}/projects", get(compose::projects))
        .route("/api/hosts/{host}/folders", get(compose::folders))
        .route(
            "/api/hosts/{host}/sessions/{session}/abort",
            post(asks::abort),
        )
        .route(
            "/api/hosts/{host}/sessions/{session}/compact",
            post(asks::compact),
        )
        .route(
            "/api/hosts/{host}/sessions/{session}/queue",
            post(session::queue).layer(DefaultBodyLimit::max(session::SEND_BODY)),
        )
        .route(
            "/api/hosts/{host}/sessions/{session}/loop",
            post(session::run_now),
        )
        .route(
            "/api/hosts/{host}/sessions/{session}/review",
            get(review::show),
        )
        .route(
            "/api/hosts/{host}/sessions/{session}/review/merge",
            post(review::merge),
        )
        .route(
            "/api/hosts/{host}/sessions/{session}/review/discard",
            post(review::discard),
        )
        .route("/api/hosts/{host}/providers", get(session::providers))
        .route("/api/hosts/{host}/find/file", get(session::find_file))
        .route("/api/push", get(push::state))
        .route("/api/push/subscribe", post(push::subscribe))
        .route("/api/push/unsubscribe", post(push::unsubscribe))
        .route("/api/push/test", post(push::test))
        .route("/api/presence", post(push::presence))
        .route("/api/hosts/{host}/pty", get(pty::list).post(pty::create))
        .route("/api/hosts/{host}/pty/shells", get(pty::shells))
        .route(
            "/api/hosts/{host}/pty/{id}",
            get(pty::one).put(pty::update).delete(pty::kill),
        )
        .route("/api/hosts/{host}/pty/{id}/connect", get(pty::connect))
        .route(
            "/api/telemetry",
            post(telemetry::ingest).layer(DefaultBodyLimit::max(TELEMETRY_BODY)),
        )
        .route_layer(middleware::from_fn_with_state(
            Arc::clone(&state),
            require_session,
        ))
        // after the gate, so a refusal is compressed like any answer; json only (compress.rs), so the stream is not
        .layer(compress::layer());
    // its own router, so the headers that make an svg harmless wrap every answer
    // it gives, the sign-in refusal and the errors included
    let repo_icon = Router::new()
        .route("/api/hosts/{host}/repo-icon", get(repo_icon::repo_icon))
        .route_layer(middleware::from_fn_with_state(
            Arc::clone(&state),
            require_session,
        ))
        .layer(middleware::map_response(repo_icon::isolated));
    Router::new()
        .route("/api/login", post(login::login))
        .route("/api/logout", post(login::logout))
        .merge(gated)
        .merge(repo_icon)
        .route("/api/{*rest}", any(no_such_route))
        .fallback(assets::serve)
        .layer(DefaultBodyLimit::max(SMALL_BODY))
        .layer(middleware::from_fn(log_request))
        .with_state(state)
}

/// what a message with photos takes of the budget, in MiB: twice its size, since while it is parsed the server holds the
/// bytes it came in and the strings read from them (and, a moment later, the value and the body written from it). none
/// for a body too small to carry a photo
fn photo_weight(announced: usize) -> Option<u32> {
    if announced <= PHOTO_WEIGHT_FLOOR {
        return None;
    }
    u32::try_from(2 * announced.min(PROMPT_BODY).div_ceil(MIB)).ok()
}

/// the room photos may take on the server, and how long a message waits for it
#[derive(Clone)]
struct PhotoBudget {
    room: Arc<Semaphore>,
    wait: Duration,
}

/// takes a place in the photo budget by the size of the body the request announces, before a byte of it is read, and
/// keeps it until the answer has gone. a body that does not say its size is counted at the most a route takes. a message
/// that does not fit the room left waits for it (nothing is held while it does, so the wait costs no memory), and one
/// that has not had its turn within the wait is turned away with a 503 that says so.
async fn photo_budget(
    State(budget): State<PhotoBudget>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let announced = request
        .headers()
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(PROMPT_BODY);
    let Some(weight) = photo_weight(announced) else {
        return Ok(next.run(request).await);
    };
    let started = Instant::now();
    let taken = tokio::time::timeout(
        budget.wait,
        Arc::clone(&budget.room).acquire_many_owned(weight),
    )
    .await;
    let waited_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let Ok(Ok(_permit)) = taken else {
        info!(
            weight,
            waited_ms, "a message with photos was turned away: the photo budget stayed in use"
        );
        return Err(ApiError::PhotosBusy);
    };
    if waited_ms > 50 {
        info!(
            weight,
            waited_ms, "a message with photos waited for room in the photo budget"
        );
    }
    Ok(next.run(request).await)
}

/// threads leaving and returning: history, clearing off home, archive, and
/// opening one the fleet does not hold.
fn lifecycle() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/history", get(history::page))
        .route("/api/clear", post(threads::clear))
        .route(
            "/api/hosts/{host}/sessions/{session}/archive",
            post(threads::archive),
        )
        .route(
            "/api/hosts/{host}/sessions/{session}/adopt",
            post(threads::adopt),
        )
}

async fn require_session(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    match state.auth.token_in(request.headers()) {
        Some(token) if state.auth.verify(token, crate::now_ms()) => Ok(next.run(request).await),
        _ => Err(ApiError::SignInFirst),
    }
}

async fn no_such_route() -> ApiError {
    ApiError::NotFound
}

/// one line per request: id, method, path, status, latency. api calls log
/// at info; app files at debug, since a cold load fetches a dozen.
async fn log_request(mut request: Request, next: Next) -> Response {
    let started = Instant::now();
    let id = format!("{:08x}", rand::random::<u32>());
    request
        .extensions_mut()
        .insert(RequestId(Arc::from(id.as_str())));
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let mut response = next.run(request).await;
    let status = response.status().as_u16();
    let latency_ms = started.elapsed().as_secs_f64() * 1000.0;
    if path.starts_with("/api/") {
        info!(request = %id, %method, %path, status, latency_ms = format_args!("{latency_ms:.1}"), "request");
    } else {
        debug!(request = %id, %method, %path, status, latency_ms = format_args!("{latency_ms:.1}"), "request");
    }
    if let Ok(value) = HeaderValue::from_str(&id) {
        response.headers_mut().insert("x-request-id", value);
    }
    response
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;

    use tokio::sync::{mpsc, watch};

    use super::*;
    use crate::config::{CookieConfig, Secret};
    use crate::fleet::Fleet;
    use crate::upstream::{Hosts, Upstreams};

    const PASSWORD: &str = "a long enough password";

    /// the real router on a local port, with nothing behind it: no hosts, no
    /// fleet, no store. what these tests judge is how the router wraps a route.
    async fn serve() -> SocketAddr {
        serve_waiting(PHOTO_WAIT).await
    }

    /// the same, with a message that is waiting for room in the photo budget given `photo_wait` for it
    async fn serve_waiting(photo_wait: Duration) -> SocketAddr {
        let client = reqwest::Client::new();
        let fleet = Fleet::detached();
        let shutdown = CancellationToken::new();
        let (icons, _task) = crate::icons::spawn(client.clone(), fleet.clone(), shutdown.clone());
        let (_published, hosts) = watch::channel::<Hosts>(Arc::from(Vec::new()));
        let state = Arc::new(AppState {
            auth: Auth::new(
                [7; 32],
                &Secret::new(PASSWORD.into()),
                CookieConfig {
                    name: "boxbox_test".into(),
                    secure: false,
                },
            ),
            upstreams: Upstreams {
                hosts,
                reload: mpsc::channel(1).0,
            },
            fleet,
            client,
            telemetry: crate::telemetry::Sender::detached(),
            push: crate::push::Push::detached(),
            store: crate::store::Store::detached(),
            terminals: crate::pty::Terminals::new().unwrap(),
            assets: Assets::Embedded,
            icons,
            births: compose::Births::default(),
            shutdown,
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router_waiting(state, photo_wait)).await;
        });
        addr
    }

    /// signs in through the real login route and returns the cookie to send back.
    async fn sign_in(addr: SocketAddr) -> String {
        let answer = reqwest::Client::new()
            .post(format!("http://{addr}/api/login"))
            .header("content-type", "application/json")
            .body(serde_json::json!({ "password": PASSWORD }).to_string())
            .send()
            .await
            .unwrap();
        assert_eq!(answer.status(), 200);
        let set = answer.headers()[reqwest::header::SET_COOKIE]
            .to_str()
            .unwrap();
        set.split(';').next().unwrap().to_owned()
    }

    fn isolated(answer: &reqwest::Response) -> bool {
        answer
            .headers()
            .get("x-content-type-options")
            .map(axum::http::HeaderValue::as_bytes)
            == Some(b"nosniff")
            && answer
                .headers()
                .get("content-security-policy")
                .map(axum::http::HeaderValue::as_bytes)
                == Some(repo_icon::POLICY.as_bytes())
    }

    /// a prompt on its way: the head has gone, the body is being written, and the connection stays open until this is dropped
    struct OnItsWay {
        read: tokio::net::tcp::OwnedReadHalf,
        writing: tokio::task::JoinHandle<()>,
    }

    impl Drop for OnItsWay {
        fn drop(&mut self) {
            self.writing.abort();
        }
    }

    impl OnItsWay {
        /// the status of the answer, when it comes
        async fn status(&mut self) -> u16 {
            use tokio::io::AsyncReadExt;
            let mut line = [0u8; 12];
            self.read.read_exact(&mut line).await.unwrap();
            String::from_utf8_lossy(&line[9..12]).parse().unwrap()
        }
    }

    /// sends the head of a prompt that announces `announced` bytes of body and, in the background, the first `sent` of them
    /// (a server that is waiting to take it does not read them, so the writing must not hold the test up)
    async fn announce(addr: SocketAddr, cookie: &str, announced: usize, sent: usize) -> OnItsWay {
        use tokio::io::AsyncWriteExt;
        let stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let (read, mut write) = stream.into_split();
        let head = format!(
            "POST /api/hosts/desk/sessions/ses_a/prompt HTTP/1.1\r\nhost: boxbox\r\ncookie: {cookie}\r\ncontent-type: application/json\r\ncontent-length: {announced}\r\n\r\n"
        );
        let writing = tokio::spawn(async move {
            let _ = write.write_all(head.as_bytes()).await;
            let _ = write.write_all(&vec![b' '; sent]).await;
            // the connection stays open: closing it would end the body early, and with it the message's place in the budget
            std::future::pending::<()>().await;
        });
        tokio::time::sleep(Duration::from_millis(150)).await;
        OnItsWay { read, writing }
    }

    #[test]
    fn a_message_is_counted_twice_over_and_the_budget_holds_two_at_the_limit() {
        assert_eq!(photo_weight(2), None);
        assert_eq!(photo_weight(PHOTO_WEIGHT_FLOOR), None);
        assert_eq!(photo_weight(PHOTO_WEIGHT_FLOOR + 1), Some(2));
        assert_eq!(photo_weight(24 * MIB), Some(48));
        assert_eq!(photo_weight(24 * MIB + 1), Some(50));
        // a body is never counted past what the routes take
        assert_eq!(photo_weight(40 * MIB), photo_weight(PROMPT_BODY));
        assert_eq!(
            2 * photo_weight(PROMPT_BODY).unwrap() as usize,
            PHOTO_BUDGET_MIB
        );
    }

    #[tokio::test]
    async fn photos_in_flight_are_bounded_and_a_message_that_gets_no_room_is_turned_away_after_its_wait()
     {
        let addr = serve_waiting(Duration::from_millis(400)).await;
        let cookie = sign_in(addr).await;
        // two messages at the limit hold the whole budget while their bodies are still coming
        let _first = announce(addr, &cookie, 24 * MIB, 0).await;
        let _second = announce(addr, &cookie, 24 * MIB, 0).await;
        // a third waits for room, and when none comes it is turned away in words that say so (a 503 of its own kind)
        let started = Instant::now();
        let mut third = announce(addr, &cookie, 8 * MIB, 0).await;
        assert_eq!(third.status().await, 503);
        assert!(started.elapsed() >= Duration::from_millis(400));
        // words are never counted: a small message goes through whatever photos are in flight
        let mut words = announce(addr, &cookie, 2, 2).await;
        assert_ne!(words.status().await, 503);
    }

    #[tokio::test]
    async fn a_message_waits_for_room_and_goes_when_another_ends() {
        let addr = serve_waiting(Duration::from_secs(10)).await;
        let cookie = sign_in(addr).await;
        let first = announce(addr, &cookie, 24 * MIB, 0).await;
        let _second = announce(addr, &cookie, 24 * MIB, 0).await;
        // the third waits (it is not turned away) and takes the room the first gives up
        let mut third = announce(addr, &cookie, 8 * MIB, 8 * MIB).await;
        drop(first);
        // its body is not json: the answer is the route's own refusal, which only a message that was let in can get
        assert_eq!(third.status().await, 400);
    }

    #[tokio::test]
    async fn a_message_is_read_into_one_buffer_and_refused_in_words_when_it_is_not_one() {
        let addr = serve().await;
        let cookie = sign_in(addr).await;
        let post = |kind: &'static str, body: String| {
            let cookie = cookie.clone();
            async move {
                reqwest::Client::new()
                    .post(format!(
                        "http://{addr}/api/hosts/desk/sessions/ses_a/prompt"
                    ))
                    .header("cookie", cookie)
                    .header("content-type", kind)
                    .body(body)
                    .send()
                    .await
                    .unwrap()
            }
        };
        let plain = post("text/plain", "hello".into()).await;
        assert_eq!(plain.status(), 400);
        let empty = post("application/json", "{}".into()).await;
        assert_eq!(empty.status(), 400);
        let said = empty.text().await.unwrap();
        assert!(said.contains("not a message boxbox can read"), "{said}");
        // a body announced past what the routes take is refused before it is read
        let mut big = announce(addr, &cookie, 26 * MIB, 0).await;
        assert_eq!(big.status().await, 413);
    }

    #[tokio::test]
    async fn the_sign_in_refusal_of_the_icon_route_carries_nosniff_and_the_policy() {
        let addr = serve().await;
        let answer = reqwest::get(format!(
            "http://{addr}/api/hosts/desk/repo-icon?root=/work/app"
        ))
        .await
        .unwrap();
        assert_eq!(answer.status(), 401);
        assert!(isolated(&answer), "{:?}", answer.headers());
    }

    #[tokio::test]
    async fn the_errors_of_a_signed_in_icon_request_carry_them_too() {
        let addr = serve().await;
        let cookie = sign_in(addr).await;
        let get = |query: &'static str, host: &'static str| {
            let cookie = cookie.clone();
            async move {
                reqwest::Client::new()
                    .get(format!("http://{addr}/api/hosts/{host}/repo-icon?{query}"))
                    .header("cookie", cookie)
                    .send()
                    .await
                    .unwrap()
            }
        };
        let bad_root = get("root=/", "desk").await;
        assert_eq!(bad_root.status(), 400);
        assert!(isolated(&bad_root), "{:?}", bad_root.headers());
        let unknown_host = get("root=/work/app", "nowhere").await;
        assert_eq!(unknown_host.status(), 404);
        assert!(isolated(&unknown_host), "{:?}", unknown_host.headers());
    }

    #[tokio::test]
    async fn no_other_route_wears_the_icon_policy() {
        let addr = serve().await;
        let answer = reqwest::get(format!("http://{addr}/api/hosts"))
            .await
            .unwrap();
        assert_eq!(answer.status(), 401);
        assert!(
            answer.headers().get("content-security-policy").is_none(),
            "the layer belongs to the icon route alone"
        );
    }
}
