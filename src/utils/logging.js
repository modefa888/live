// 独立日志模块：对应 Python src/app/utils/logging.py
// - log():        通用日志（内存 + 控制台 + JSON 文件 + DB 持久化）
// - log_request(): 记录每次 HTTP 请求/响应
// 本地日志按天轮转：data/logs/douyin_YYYY-MM-DD.jsonl
import fs from "node:fs";
import path from "node:path";
import { LOG_DIR } from "./constants.js";

export const LOGS = []; // 内存日志（上限 200 条，/api/logs 会合并这部分）
const MAX_MEMORY_LOGS = 200;

// 日志中需要打码的敏感查询参数
const SENSITIVE_PARAMS = new Set(["mstoken", "a_bogus", "verifyfp", "fp", "ms_token"]);

let logFile = null;
let logFileDate = "";
let logPersister = null; // 由入口在 DB 就绪后注入（对应 Python 延迟导入 get_backend().save_log）

export function setLogPersister(fn) {
  logPersister = fn;
}

function pad(n) { return String(n).padStart(2, "0"); }

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtDay(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function shortUrl(url, maxLen = 180) {
  try {
    const u = new URL(String(url));
    const kept = [];
    for (const [k, v] of u.searchParams.entries()) {
      if (SENSITIVE_PARAMS.has(k.toLowerCase())) {
        kept.push(`${k}=***`);
      } else if (v.length > 40) {
        kept.push(`${k}=${v.slice(0, 40)}...`);
      } else {
        kept.push(`${k}=${v}`);
      }
    }
    const short = `${u.protocol}//${u.host}${u.pathname}${kept.length ? "?" + kept.join("&") : ""}`;
    return short.length <= maxLen ? short : short.slice(0, maxLen) + "...";
  } catch {
    return String(url).slice(0, maxLen);
  }
}

// 将日志以 JSON 追加写入当天日志文件（跨天自动轮转到新文件）
function writeFile(entry) {
  const day = fmtDay(entry.ts);
  if (logFileDate !== day || !logFile) {
    if (logFile) { try { logFile.end(); } catch {} logFile = null; }
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      logFile = fs.createWriteStream(path.join(LOG_DIR, `douyin_${day}.jsonl`), { flags: "a" });
      logFileDate = day;
    } catch {
      logFile = null;
      return;
    }
  }
  try {
    logFile.write(JSON.stringify(entry) + "\n");
  } catch {}
}

export function log(level, msg, secUid = "", webRid = "", eventType = "") {
  const ts = Math.floor(Date.now() / 1000);
  const entry = {
    ts,
    time: fmtTime(ts),
    level: String(level),
    msg: String(msg),
    sec_uid: String(secUid),
    web_rid: String(webRid),
    event_type: String(eventType),
  };
  LOGS.push(entry);
  if (LOGS.length > MAX_MEMORY_LOGS) {
    LOGS.splice(0, LOGS.length - MAX_MEMORY_LOGS);
  }
  writeFile(entry);
  console.log(`[${level}] ${msg}`);
  // 持久化到数据库
  try {
    if (logPersister) {
      logPersister(level, String(msg).slice(0, 2000), String(secUid), String(webRid), String(eventType));
    }
  } catch {}
}

export function logRequest(url, { status = null, duration = 0, size = 0, error = null, secUid = "", webRid = "", eventType = "http" } = {}) {
  const dur = `${Math.round((duration || 0) * 1000)}ms`;
  const short = shortUrl(url);
  if (error) {
    log("error", `[HTTP] ${short} 请求失败(${dur}): ${error}`, secUid, webRid, eventType);
  } else if (status === null || status === undefined) {
    log("info", `[HTTP] ${short} 无响应(${dur})`, secUid, webRid, eventType);
  } else {
    log("info", `[HTTP] ${short} -> ${status} ${size}B (${dur})`, secUid, webRid, eventType);
  }
}
