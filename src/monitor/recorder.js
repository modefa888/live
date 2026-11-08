// 录制引擎模块：对应 Python src/app/monitor/recorder.py
// ffmpeg 主路径 + 纯 fetch 下载兜底（python-flv）
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { UA_DESKTOP } from "../utils/constants.js";
import { log } from "../utils/logging.js";
import { getDispatcher } from "../utils/httputil.js";
import { getBackend } from "../db/mongo.js";
import { fetch as undiciFetch } from "undici";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function checkFfmpeg() {
  try {
    const r = spawnSync("ffmpeg", ["-version"], { stdio: "ignore", timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

function fileSize(p) {
  try {
    return fs.existsSync(p) ? fs.statSync(p).size : 0;
  } catch {
    return 0;
  }
}

function pad(n) { return String(n).padStart(2, "0"); }

function timestampStr(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export class Recorder {
  constructor(config) {
    this.config = config; // 持有 record_dir 的配置对象
    this.records = new Map(); // sec_uid -> rec
    this.has_ffmpeg = checkFfmpeg();
  }

  async start(sec_uid, nickname, web_rid, url, label) {
    if (this.records.has(sec_uid)) {
      return [false, "该主播已在录制中"];
    }
    const safe_name = String(nickname || "unknown").replace(/[\\/:*?"<>|\s]+/g, "_");
    const safe_rid = web_rid || sec_uid || "norid";
    const sub_dir = `${safe_name}_${safe_rid}`;
    const record_dir = path.join(this.config.record_dir, sub_dir);
    fs.mkdirSync(record_dir, { recursive: true });
    const fname = `${safe_name}_${timestampStr()}.flv`;
    const fpath = path.join(record_dir, fname);
    const rec = {
      sec_uid,
      nickname,
      web_rid,
      file: fpath,
      label,
      started_at: Date.now() / 1000,
      size: 0,
      method: "",
      proc: null,
      ac: null,          // python-flv 下载的 AbortController（对应 Python response）
      thread_done: false,
      stop: false,
      history_saved: false,
    };
    this.records.set(sec_uid, rec);
    log("info", `开始录制: ${nickname} -> ${fpath}`);
    if (this.has_ffmpeg) {
      rec.method = "ffmpeg";
      const cmd = [
        "-y",
        "-user_agent", UA_DESKTOP,
        "-referer", "https://live.douyin.com/",
        "-i", url,
        "-c", "copy",
        "-f", "flv",
        fpath,
      ];
      log("info", `ffmpeg 命令: ffmpeg ${cmd.join(" ")}`);
      rec.proc = spawn("ffmpeg", cmd, { stdio: "ignore" });
      rec.proc.on("error", (e) => log("warn", `ffmpeg 进程异常: ${nickname}: ${e.message}`));
      this._spawn_watcher(rec);
    } else {
      rec.method = "python-flv";
      this._download_flv(rec, url); // 后台异步执行（对应 daemon thread）
    }
    return [true, "已开始录制"];
  }

  _spawn_watcher(rec) {
    const watch = async () => {
      while (!rec.stop) {
        if (rec.proc && rec.proc.exitCode !== null) break;
        rec.size = fileSize(rec.file);
        await sleep(2000);
      }
      if (rec.stop) {
        await this._stop_ffmpeg_proc(rec);
      }
      rec.size = fileSize(rec.file);
      await this._finalize_recording(rec);
      log("info", `录制结束: ${rec.nickname} 文件大小 ${(rec.size / 1024 / 1024).toFixed(1)} MB`);
    };
    watch(); // 后台异步（对应 daemon thread）
  }

  async _stop_ffmpeg_proc(rec) {
    const proc = rec.proc;
    if (!proc || proc.exitCode !== null) return;
    const onceExit = new Promise((res) => proc.once("exit", () => res(true)));
    try {
      proc.kill("SIGTERM");
      const exited = await Promise.race([onceExit, sleep(10000).then(() => false)]);
      if (exited) return;
      log("warn", `ffmpeg 停止超时，强制结束: ${rec.nickname}`);
    } catch (e) {
      log("warn", `ffmpeg 停止异常: ${rec.nickname}: ${e && e.message ? e.message : e}`);
    }
    try {
      proc.kill("SIGKILL");
      await Promise.race([onceExit, sleep(3000)]);
    } catch {}
  }

  async _download_flv(rec, url) {
    // 无 ffmpeg 时的兜底：fetch 流式写文件（对应 Python _download_flv）
    const ac = new AbortController();
    rec.ac = ac;
    let ws = null;
    try {
      const res = await undiciFetch(url, {
        headers: {
          "User-Agent": UA_DESKTOP,
          "Referer": "https://live.douyin.com/",
          "Accept": "*/*",
          "Accept-Encoding": "identity",
        },
        dispatcher: getDispatcher(),
        signal: ac.signal,
        redirect: "follow",
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      ws = fs.createWriteStream(rec.file);
      rec.ws = ws;
      const reader = res.body.getReader();
      while (!rec.stop) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!ws.write(Buffer.from(value))) {
          // 背压处理：等缓冲排空
          await new Promise((r) => ws.once("drain", r));
        }
        rec.size = ws.bytesWritten;
      }
    } catch (e) {
      if (!rec.stop) {
        log("warn", `录制中断: ${rec.nickname}: ${e && e.message ? e.message : e}`);
      }
    } finally {
      rec.ac = null;
      try { if (ws) ws.end(); } catch {}
      rec.stop = true;
      rec.size = fileSize(rec.file);
      await this._finalize_recording(rec);
      rec.thread_done = true;
      log("info", `录制结束: ${rec.nickname} 文件大小 ${(rec.size / 1024 / 1024).toFixed(1)} MB`);
    }
  }

  async _finalize_recording(rec) {
    // 幂等保护（对应 Python finalize_lock + history_saved）；失败允许下次重试
    if (rec._finalizePromise) return rec._finalizePromise;
    rec._finalizePromise = (async () => {
      try {
        rec.size = fileSize(rec.file);
        const end_time = Date.now() / 1000;
        const duration = Math.floor(end_time - rec.started_at);
        await getBackend().addRecording(
          rec.sec_uid,
          rec.nickname,
          rec.web_rid,
          rec.file,
          Math.floor(rec.started_at),
          Math.floor(end_time),
          duration,
          rec.size,
          rec.label,
          rec.method,
        );
        rec.history_saved = true;
        if (this.records.get(rec.sec_uid) === rec) {
          this.records.delete(rec.sec_uid);
        }
        log("info", `录制历史已保存: ${rec.nickname} 时长 ${duration}s`);
      } catch (e) {
        rec._finalizePromise = null; // 允许重试
        log("error", `写入录制历史失败: ${e && e.message ? e.message : e}`);
      }
    })();
    return rec._finalizePromise;
  }

  async stop(sec_uid) {
    const rec = this.records.get(sec_uid);
    if (!rec) return [false, "该主播未在录制"];
    rec.stop = true;
    if (rec.ac) {
      try { rec.ac.abort(); } catch {}
    }
    if (rec.proc) {
      await this._stop_ffmpeg_proc(rec);
    }
    // python-flv 下载线程退出等待（对应 thread.join(timeout=10)）
    if (rec.method === "python-flv" && !rec.thread_done) {
      for (let i = 0; i < 50 && !rec.thread_done; i++) {
        await sleep(200);
      }
    }
    rec.size = fileSize(rec.file);
    await this._finalize_recording(rec);
    log("info", `已停止录制: ${rec.nickname}, 文件大小 ${(rec.size / 1024 / 1024).toFixed(1)} MB`);
    return [true, "已停止"];
  }

  list() {
    const out = [];
    const now = Date.now() / 1000;
    for (const [sec_uid, rec] of this.records) {
      out.push({
        sec_uid,
        nickname: rec.nickname,
        file: rec.file,
        file_path: rec.file,
        label: rec.label,
        started_at: rec.started_at,
        duration: Math.floor(now - rec.started_at),
        size: rec.size,
        method: rec.method,
      });
    }
    return out.sort((a, b) => a.started_at - b.started_at);
  }

  async get_history(limit = 200) {
    return getBackend().getRecordingHistory(limit);
  }
}
