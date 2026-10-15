use std::path::PathBuf;
use std::process::ExitCode;

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let path = match bantou_server::config::resolve_path(&args, std::env::var_os("HOME").map(PathBuf::from)) {
        Ok(p) => p,
        Err(e) => {
            log::error!("{e}");
            return ExitCode::from(2);
        }
    };
    match bantou_server::run(&path).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            log::error!("{e}");
            ExitCode::FAILURE
        }
    }
}
