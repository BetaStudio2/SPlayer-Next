//! 下载核心：reqwest 流式拉取 → tokio::fs 流式落盘 → 进度回调

use crate::progress;
use futures::StreamExt;
use std::path::Path;
use tokio::fs::File;
use tokio::io::AsyncWriteExt;

/// 进度上报节流间隔（毫秒）
const PROGRESS_THROTTLE_MS: u128 = 200;

/// 执行下载任务，返回退出码（0=成功, 1=失败）
pub async fn run(task_id: &str, url: &str, dest: &Path, tmp: &Path) -> i32 {
    let client = match reqwest::Client::builder().build() {
        Ok(c) => c,
        Err(e) => {
            progress::error(task_id, &format!("client build failed: {e}"));
            return 1;
        }
    };

    let resp = match client.get(url).send().await {
        Ok(r) => r,
        Err(e) => {
            progress::error(task_id, &e.to_string());
            return 1;
        }
    };

    if !resp.status().is_success() {
        progress::error(task_id, &format!("HTTP {}", resp.status()));
        return 1;
    }

    let total = resp.content_length().unwrap_or(0);

    let mut file = match File::create(tmp).await {
        Ok(f) => f,
        Err(e) => {
            progress::error(task_id, &format!("create tmp file failed: {e}"));
            return 1;
        }
    };

    let mut stream = resp.bytes_stream();
    let mut received: u64 = 0;
    let mut last_emit = std::time::Instant::now();

    while let Some(chunk_result) = stream.next().await {
        match chunk_result {
            Ok(chunk) => {
                if let Err(e) = file.write_all(&chunk).await {
                    progress::error(task_id, &format!("write failed: {e}"));
                    cleanup_tmp(tmp).await;
                    return 1;
                }
                received += chunk.len() as u64;
                if last_emit.elapsed().as_millis() >= PROGRESS_THROTTLE_MS {
                    progress::progress(task_id, received, total);
                    last_emit = std::time::Instant::now();
                }
            }
            Err(e) => {
                progress::error(task_id, &e.to_string());
                cleanup_tmp(tmp).await;
                return 1;
            }
        }
    }

    if let Err(e) = file.flush().await {
        progress::error(task_id, &format!("flush failed: {e}"));
        cleanup_tmp(tmp).await;
        return 1;
    }

    // 最终进度上报（确保 done 之前有完整进度）
    progress::progress(task_id, received, total);

    if let Err(e) = tokio::fs::rename(tmp, dest).await {
        progress::error(task_id, &format!("rename failed: {e}"));
        cleanup_tmp(tmp).await;
        return 1;
    }

    progress::done(task_id, &dest.to_string_lossy());
    0
}

async fn cleanup_tmp(tmp: &Path) {
    let _ = tokio::fs::remove_file(tmp).await;
}
