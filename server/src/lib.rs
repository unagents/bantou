//! bantou-server: remote-side orchestration daemon (scaffold).
//!
//! A plain Linux daemon that receives instructions from bantou-desktop and
//! manages the work sessions on this host. Only the process skeleton exists
//! (config load, workspace preparation, signal-driven shutdown); the
//! business logic is not implemented.

pub mod agent;
pub mod broker;
pub mod config;
pub mod error;
pub mod frontmatter;
pub mod security;
pub mod session;
pub mod state;
pub mod task;
pub mod thread;
pub mod workspace;

use error::{ServerError, ServerResult};
use std::path::Path;
use tokio::signal::unix::{signal, SignalKind};

/// Load the config, prepare the workspace, then stay resident until
/// SIGTERM or SIGINT arrives.
pub async fn run(config_path: &Path) -> ServerResult<()> {
    log::info!("bantou-server {} starting", env!("CARGO_PKG_VERSION"));
    let cfg = config::Config::load(config_path)?;
    log::info!("config loaded: {}", config_path.display());
    let layout = workspace::prepare(&cfg.workspace)?;
    log::info!(
        "workspace ready: {} (repos: {})",
        layout.root.display(),
        layout.repos.display()
    );

    let mut term = signal(SignalKind::terminate()).map_err(ServerError::Io)?;
    let mut int = signal(SignalKind::interrupt()).map_err(ServerError::Io)?;
    let name = tokio::select! {
        _ = term.recv() => "SIGTERM",
        _ = int.recv() => "SIGINT",
    };
    log::info!("{name} received, shutting down");
    // No resources to release yet; the broker / session teardown goes here.
    log::info!("shutdown complete");
    Ok(())
}
