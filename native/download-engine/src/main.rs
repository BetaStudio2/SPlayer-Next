//! SPlayer 下载引擎 —— Rust 实现
//!
//! CLI 入口，由 TS 层 server/routes/download.ts spawn 调用。
//! 通信协议：CLI 参数 → stdout JSON lines（进度/完成/错误）
//!
//! 用法：
//!   splayer-downloader start --task-id <ID> --url <URL> --dest <PATH> [--tmp <PATH>]

mod downloader;
mod progress;

use clap::{Parser, Subcommand};
use std::path::{Path, PathBuf};

#[derive(Parser)]
#[command(name = "splayer-downloader", version, about = "SPlayer 下载引擎")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// 启动下载任务
    Start {
        /// 任务 ID
        #[arg(long)]
        task_id: String,
        /// 下载 URL
        #[arg(long)]
        url: String,
        /// 最终文件路径
        #[arg(long)]
        dest: PathBuf,
        /// 临时文件路径（可选，默认 {dest}.{task_id}.tmp）
        #[arg(long)]
        tmp: Option<PathBuf>,
    },
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let code = match cli.command {
        Command::Start {
            task_id,
            url,
            dest,
            tmp,
        } => {
            let tmp_path = tmp.unwrap_or_else(|| default_tmp(&dest, &task_id));
            downloader::run(&task_id, &url, &dest, &tmp_path).await
        }
    };
    std::process::exit(code);
}

/// 构造默认临时文件路径：{dest}.{task_id}.tmp
fn default_tmp(dest: &Path, task_id: &str) -> PathBuf {
    let mut name = dest
        .file_name()
        .map(|n| n.to_owned())
        .unwrap_or_default();
    name.push(format!(".{task_id}.tmp"));
    dest.with_file_name(name)
}
