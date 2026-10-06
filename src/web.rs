use std::collections::HashMap;

use axum::extract::{Multipart, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use rust_embed::RustEmbed;

use crate::app::*;
use crate::auth::{authenticate, Auth};
use crate::models::*;
use crate::netscape;

#[derive(RustEmbed)]
#[folder = "static/"]
struct Assets;

pub fn asset_version() -> String {
    let mut acc: u64 = 0xcbf29ce484222325;
    let mut names: Vec<_> = Assets::iter().collect();
    names.sort();
    for n in names {
        if let Some(f) = Assets::get(&n) {
            for b in f.metadata.sha256_hash() {
                acc ^= b as u64;
                acc = acc.wrapping_mul(0x100000001b3);
            }
        }
    }
    format!("{:08x}", acc as u32)
}

fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "json" | "webmanifest" => "application/json",
        _ => "application/octet-stream",
    }
}

fn page(app: &S, name: &str, headers: &HeaderMap) -> Response {
    let Some(f) = Assets::get(name) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let etag = format!("\"{}-{}\"", app.asset_version, name);
    if headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(etag.as_str()) {
        return (StatusCode::NOT_MODIFIED, [(header::ETAG, etag)]).into_response();
    }
    let body = String::from_utf8_lossy(&f.data).replace("{{v}}", &app.asset_version);
    let mut r = (StatusCode::OK, body).into_response();
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    if let Ok(v) = HeaderValue::from_str(&etag) {
        h.insert(header::ETAG, v);
    }
    r
}

/// The single-page app shell; requires a login.
pub async fn spa(State(app): State<S>, headers: HeaderMap) -> Response {
    match authenticate(&app, &headers, &Method::GET).await {
        Ok(Some(_)) => page(&app, "index.html", &headers),
        _ => Redirect::to("/login/").into_response(),
    }
}

/// The shell for pages that may be viewed anonymously (shared bookmarks).
pub async fn spa_public(State(app): State<S>, headers: HeaderMap) -> Response {
    page(&app, "index.html", &headers)
}

pub async fn login_page(State(app): State<S>, headers: HeaderMap) -> Response {
    page(&app, "login.html", &headers)
}

pub async fn root(State(app): State<S>, headers: HeaderMap) -> Response {
    match authenticate(&app, &headers, &Method::GET).await {
        Ok(Some(_)) => Redirect::to("/bookmarks").into_response(),
        _ => Redirect::to("/login/").into_response(),
    }
}

pub async fn static_file(
    State(app): State<S>,
    Path(path): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let Some(f) = Assets::get(&path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let etag = format!("\"{}\"", f.metadata.sha256_hash().iter().take(8).map(|b| format!("{b:02x}")).collect::<String>());
    if headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(etag.as_str()) {
        return (StatusCode::NOT_MODIFIED, [(header::ETAG, etag)]).into_response();
    }
    let cache = if q.get("v").map(|v| v == &app.asset_version).unwrap_or(false) {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let mut r = (StatusCode::OK, f.data.into_owned()).into_response();
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime(&path)));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    if let Ok(v) = HeaderValue::from_str(&etag) {
        h.insert(header::ETAG, v);
    }
    r
}

pub async fn health(State(app): State<S>) -> Response {
    let ok = app.db.fetch_opt(&app.db.pool, "SELECT 1", &[]).await.is_ok();
    let status = if ok { StatusCode::OK } else { StatusCode::INTERNAL_SERVER_ERROR };
    json_response(
        status,
        &serde_json::json!({ "version": crate::api::VERSION, "status": if ok { "healthy" } else { "unhealthy" } }),
    )
}

pub async fn not_found(uri: axum::http::Uri) -> Response {
    if uri.path().starts_with("/api/") {
        ApiError::not_found().into_response()
    } else {
        (StatusCode::NOT_FOUND, "Not found").into_response()
    }
}

pub async fn export(State(app): State<S>, Auth(uid): Auth) -> ApiResult<Response> {
    let sql = format!("SELECT {BM_COLS} FROM bookmarks b WHERE b.owner_id = ? ORDER BY b.id");
    let rows = app.db.fetch_all(&app.db.pool, &sql, &[uid.into()]).await?;
    let mut bms = rows.iter().map(Bm::from_row).collect::<Result<Vec<_>, _>>()?;
    attach_tags(&app.db, &mut bms).await?;
    let body = netscape::export(&bms);
    let name = chrono::Utc::now().format("bookmarks_%Y-%m-%d_%H-%M-%S.html").to_string();
    let mut r = (StatusCode::OK, body).into_response();
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=UTF-8"));
    if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{name}\"")) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    Ok(r)
}

pub async fn import(State(app): State<S>, Auth(uid): Auth, mut mp: Multipart) -> ApiResult<Response> {
    let mut file: Option<Vec<u8>> = None;
    let mut map_private = false;
    while let Some(field) = mp
        .next_field()
        .await
        .map_err(|_| ApiError::detail(StatusCode::BAD_REQUEST, "Invalid upload."))?
    {
        match field.name().unwrap_or("") {
            "import_file" => {
                file = Some(
                    field
                        .bytes()
                        .await
                        .map_err(|_| ApiError::detail(StatusCode::BAD_REQUEST, "Invalid upload."))?
                        .to_vec(),
                )
            }
            "map_private_flag" => map_private = true,
            _ => {}
        }
    }
    let Some(bytes) = file.filter(|f| !f.is_empty()) else {
        return Err(ApiError::detail(StatusCode::BAD_REQUEST, "Please select a file to import."));
    };
    let html = String::from_utf8_lossy(&bytes).into_owned();
    let items = netscape::parse(&html);
    let res = netscape::import(&app, uid, items, map_private).await?;
    let mut msg = format!("{} bookmarks were successfully imported.", res.imported);
    if res.failed > 0 {
        msg.push_str(&format!(" {} bookmarks could not be imported. Please check the logs for more details.", res.failed));
    }
    Ok(json_response(
        StatusCode::OK,
        &serde_json::json!({ "imported": res.imported, "failed": res.failed, "message": msg }),
    ))
}
