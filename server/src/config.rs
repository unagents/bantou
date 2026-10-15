//! TOML config file and its location.
//!
//! The path comes from `--config <path>`; without it,
//! `$HOME/.config/bantou-server/config.toml`.

use crate::error::{ServerError, ServerResult};
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize, PartialEq)]
pub struct Config {
    /// Workspace folder. `<workspace>/repos/` is the repo expansion space.
    pub workspace: PathBuf,
}

impl Config {
    pub fn load(path: &Path) -> ServerResult<Self> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| ServerError::Config(format!("{}: {e}", path.display())))?;
        Self::parse(&text)
    }

    pub fn parse(text: &str) -> ServerResult<Self> {
        toml::from_str(text).map_err(|e| ServerError::Config(e.to_string()))
    }
}

/// Resolve the config path from argv (without the program name) and `$HOME`.
pub fn resolve_path(args: &[String], home: Option<PathBuf>) -> ServerResult<PathBuf> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--config" => {
                let v = it
                    .next()
                    .ok_or_else(|| ServerError::Config("--config needs a path".into()))?;
                return Ok(PathBuf::from(v));
            }
            other => return Err(ServerError::Config(format!("unknown argument: {other}"))),
        }
    }
    let home = home.ok_or_else(|| ServerError::Config("HOME is not set".into()))?;
    Ok(home.join(".config/bantou-server/config.toml"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_config_from_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "workspace = \"/srv/bantou\"\n").unwrap();
        let cfg = Config::load(&path).unwrap();
        assert_eq!(cfg.workspace, PathBuf::from("/srv/bantou"));
    }

    #[test]
    fn missing_workspace_is_an_error() {
        assert!(Config::parse("").is_err());
    }

    #[test]
    fn resolves_config_path() {
        let home = Some(PathBuf::from("/home/u"));
        assert_eq!(
            resolve_path(&[], home.clone()).unwrap(),
            PathBuf::from("/home/u/.config/bantou-server/config.toml")
        );
        let args = vec!["--config".to_string(), "/x.toml".to_string()];
        assert_eq!(resolve_path(&args, home).unwrap(), PathBuf::from("/x.toml"));
    }
}
