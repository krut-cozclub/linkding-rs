mod api;
mod app;
mod auth;
mod config;
mod db;
mod models;
mod netscape;
mod scrape;
mod search;
mod web;

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, RwLock};

use axum::extract::{DefaultBodyLimit, Request};
use axum::http::{HeaderValue, Method, Uri};
use axum::routing::{delete, get, post};
use axum::{Router, ServiceExt};
use tower::Layer;
use tower_http::compression::CompressionLayer;
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::app::{App, S};

/// Collapses `//`, makes API/login paths end in `/` and trims the slash elsewhere,
/// so the extension works whatever base URL the user typed.
fn normalize(mut req: Request) -> Request {
    let uri = req.uri();
    let path = uri.path();
    let needs = path.contains("//")
        || (path.len() > 1 && !path.ends_with('/') && (path.starts_with("/api/") || path == "/login" || path == "/logout"))
        || (path.len() > 1 && path.ends_with('/') && !(path.starts_with("/api/") || path == "/login/" || path == "/logout/"));
    if !needs {
        return req;
    }
    let mut p = String::with_capacity(path.len() + 1);
    let mut prev_slash = false;
    for c in path.chars() {
        if c == '/' {
            if prev_slash {
                continue;
            }
            prev_slash = true;
        } else {
            prev_slash = false;
        }
        p.push(c);
    }
    if p.starts_with("/api/") || p == "/login" || p == "/logout" {
        if !p.ends_with('/') {
            p.push('/');
        }
    } else if p.len() > 1 {
        while p.len() > 1 && p.ends_with('/') {
            p.pop();
        }
    }
    let pq = match uri.query() {
        Some(q) => format!("{p}?{q}"),
        None => p,
    };
    let mut parts = uri.clone().into_parts();
    if let Ok(v) = pq.parse() {
        parts.path_and_query = Some(v);
        if let Ok(u) = Uri::from_parts(parts) {
            *req.uri_mut() = u;
        }
    }
    req
}

fn router(state: S) -> Router {
    let cors_origins = state.cfg.cors_origins.clone();
    let mut r = Router::new()
        .route("/", get(web::root))
        .route("/health", get(web::health))
        .route("/login/", get(web::login_page).post(auth::login))
        .route("/logout/", get(auth::logout).post(auth::logout))
        .route("/static/{*path}", get(web::static_file))
        // pages (single-page app shell)
        .route("/bookmarks", get(web::spa))
        .route("/bookmarks/archived", get(web::spa))
        .route("/bookmarks/shared", get(web::spa_public))
        .route("/bookmarks/new", get(web::spa))
        .route("/bookmarks/close", get(web::spa_public))
        .route("/bookmarks/{id}/edit", get(web::spa))
        .route("/tags", get(web::spa))
        .route("/settings", get(web::spa))
        .route("/settings/general", get(web::spa))
        .route("/settings/integrations", get(web::spa))
        .route("/change-password", get(web::spa))
        .route("/bundles", get(web::spa))
        .route("/bundles/new", get(web::spa))
        .route("/bundles/{id}/edit", get(web::spa))
        .route("/custom_css", get(api::custom_css))
        .route("/settings/export", get(web::export))
        .route("/settings/import", post(web::import).layer(DefaultBodyLimit::max(128 * 1024 * 1024)))
        // linkding REST API
        .route("/api/bookmarks/", get(api::bookmarks_list).post(api::bookmark_create))
        .route("/api/bookmarks/archived/", get(api::bookmarks_archived))
        .route("/api/bookmarks/shared/", get(api::bookmarks_shared))
        .route("/api/bookmarks/check/", get(api::bookmark_check))
        .route("/api/bookmarks/bulk/", post(api::bookmarks_bulk))
        .route(
            "/api/bookmarks/{id}/",
            get(api::bookmark_get)
                .put(api::bookmark_put)
                .patch(api::bookmark_patch)
                .delete(api::bookmark_delete),
        )
        .route("/api/bookmarks/{id}/archive/", post(api::bookmark_archive))
        .route("/api/bookmarks/{id}/unarchive/", post(api::bookmark_unarchive))
        .route("/api/bundles/", get(api::bundles_list).post(api::bundle_create))
        .route(
            "/api/bundles/{id}/",
            get(api::bundle_get).put(api::bundle_put).patch(api::bundle_patch).delete(api::bundle_delete),
        )
        .route("/api/tags/", get(api::tags_list).post(api::tags_create))
        .route("/api/tags/stats/", get(api::tags_stats))
        .route("/api/tags/cloud/", get(api::tag_cloud))
        .route("/api/tags/merge/", post(api::tags_merge))
        .route("/api/tags/{id}/", get(api::tag_get).patch(api::tag_patch).delete(api::tag_delete))
        .route("/api/user/profile/", get(api::profile_get).patch(api::profile_patch))
        .route("/api/user/password/", post(api::password_change))
        .route("/api/user/tokens/", get(api::tokens_list).post(api::tokens_create))
        .route("/api/user/tokens/{id}/", delete(api::tokens_delete))
        .fallback(web::not_found)
        .layer(CompressionLayer::new())
        .with_state(state);
    if !cors_origins.is_empty() {
        let origins: Vec<HeaderValue> = cors_origins.iter().filter_map(|o| o.parse().ok()).collect();
        r = r.layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::list(origins))
                .allow_methods([Method::GET, Method::POST, Method::PUT, Method::PATCH, Method::DELETE, Method::OPTIONS])
                .allow_headers(tower_http::cors::Any),
        );
    }
    r
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let cfg = config::Config::from_env();

    let db = match db::Db::connect(&cfg.database_url, cfg.pool_size).await {
        Ok(d) => d,
        Err(e) => {
            eprintln!("cannot connect to database: {e}");
            std::process::exit(1);
        }
    };
    if let Err(e) = db.migrate().await {
        eprintln!("migration failed: {e}");
        std::process::exit(1);
    }

    let state: S = Arc::new(App {
        http: scrape::build_client(cfg.allowed_internal_hosts.clone()),
        db,
        cfg: cfg.clone(),
        tokens: RwLock::new(HashMap::new()),
        sessions: RwLock::new(HashMap::new()),
        meta_cache: Mutex::new(VecDeque::new()),
        asset_version: web::asset_version(),
    });
    if let Err(e) = auth::ensure_superuser(&state).await {
        eprintln!("could not create superuser: {e}");
    }

    let app = tower::util::MapRequestLayer::new(normalize).layer(router(state));
    let listener = match tokio::net::TcpListener::bind((cfg.host.as_str(), cfg.port)).await {
        Ok(l) => l,
        Err(_) => tokio::net::TcpListener::bind(("0.0.0.0", cfg.port)).await.unwrap_or_else(|e| {
            eprintln!("cannot bind port {}: {e}", cfg.port);
            std::process::exit(1);
        }),
    };
    eprintln!("linkding-rs {} listening on {}", api::VERSION, listener.local_addr().map(|a| a.to_string()).unwrap_or_default());
    let _ = axum::serve(listener, ServiceExt::<Request>::into_make_service(app))
        .with_graceful_shutdown(shutdown())
        .await;
}

async fn shutdown() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
}
