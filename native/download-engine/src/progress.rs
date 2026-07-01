//! 进度上报 —— stdout JSON lines（TS 层逐行解析 → WS 转发）
//!
//! 协议：
//!   {"type":"progress","taskId":"...","received":12345,"total":99999}
//!   {"type":"done","taskId":"...","filePath":"/app/..."}
//!   {"type":"error","taskId":"...","error":"..."}

use serde_json::json;
use std::io::{self, Write};

fn emit(obj: serde_json::Value) {
    let stdout = io::stdout();
    let mut handle = stdout.lock();
    let _ = writeln!(handle, "{obj}");
    let _ = handle.flush();
}

pub fn progress(task_id: &str, received: u64, total: u64) {
    emit(json!({
        "type": "progress",
        "taskId": task_id,
        "received": received,
        "total": total,
    }));
}

pub fn done(task_id: &str, file_path: &str) {
    emit(json!({
        "type": "done",
        "taskId": task_id,
        "filePath": file_path,
    }));
}

pub fn error(task_id: &str, msg: &str) {
    emit(json!({
        "type": "error",
        "taskId": task_id,
        "error": msg,
    }));
}
