// HTTP 服务器与 API 处理器：对应 Python src/app/web/server.py
// 路由、鉴权、响应形状与 Python 版逐一对齐；存储层统一为 MongoDB（sqlite/mysql 参数作别名兼容）。
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import express from "express";
import { Readable } from "node:stream";
import { fetch as undiciFetch } from "undici";
import {
  PUBLIC_DIR, DEFAULT_RECORD_DIR, ALLOWED_STREAM_HOSTS, UA_DESKTOP,
} from "../utils/constants.js";
import { log, LOGS } from "../utils/logging.js";
import { resolveInput } from "../utils/misc.js";
import { parseAweme } from "../collectors/aweme.js";
import { parseUser } from "../collectors/user.js";
import { getBackend } from "../db/mongo.js";
import { cmdBackup, cmdList, cmdRestore, cmdDelete } from "../utils/backup.js";
import { getDispatcher, setGlobalProxy } from "../utils/httputil.js";

const nowSec = () => Math.floor(Date.now() / 1000);

// ---------- 会话（进程内存，重启失效；与 Python Handler._sessions 一致） ----------
const sessions = new Map(); // token -> {username, role, created_at}（本实例热缓存；持久层见 MongoDB sessions 集合）

// 需要登录才能操作的 API 路径（POST）
const PROTECTED_PATHS = new Set([
  "/api/add", "/api/remove", "/api/record", "/api/config",
  "/api/import", "/api/pin", "/api/update", "/api/notify",
  "/api/backup/create", "/api/backup/restore", "/api/backup/delete",
  "/api/storage/test", "/api/storage/copy", "/api/parse/cookie",
]);
// 需要登录才能访问的 GET 接口；/api/square/* 与 /api/account/* 保持公开
const PROTECTED_GET = new Set([
  "/api/streamers", "/api/room", "/api/parse", "/api/refresh", "/api/recordings",
  "/api/record_history", "/api/record_download", "/api/config", "/api/export",
  "/api/logs", "/api/search", "/api/proxy", "/api/open_dir", "/api/play", "/api/pin",
  "/api/notify", "/api/backup/list", "/api/fudai", "/api/fudai/right",
  "/api/storage/status", "/api/notify/logs", "/api/fudai/history", "/api/fudai/current",
  "/api/admin/tables", "/api/admin/records", "/api/parse/video", "/api/parse/user",
  "/api/parse/cookie",
]);

// 后台管理表定义（顺序与 Python TABLE_INFO 一致）
const TABLE_INFO = {
  config: "设置", streamers: "主播列表", history: "直播历史",
  recordings: "录制记录", logs: "系统日志",
  notify_logs: "通知记录", fudai: "福袋状态", fudai_history: "福袋历史",
  accounts: "账号",
};

export class State {
  constructor() {
    this.config = {};
    this.streamers = [];
  }
}

// ---------- 配置脱敏 ----------
function maskValue(val) {
  return val.length > 40 ? val.slice(0, 40) + "●●●●●●" : val;
}

function sanitizeConfig(cfg) {
  // 脱敏返回：tg_bot_token 永久不可逆；tg_chat_ids/fudai_cookie 普通隐藏（可经 raw API 还原）
  const out = { ...cfg };
  if (out.tg_bot_token) out.tg_bot_token = "●●●●●●";
  if (out.tg_chat_ids) out.tg_chat_ids = "●●●●●●";
  if (out.fudai_cookie) out.fudai_cookie = maskValue(out.fudai_cookie);
  if (out.square_cookie) out.square_cookie = maskValue(out.square_cookie);
  if (out.cookie) out.cookie = maskValue(out.cookie);
  return out;
}

// ---------- express 适配辅助 ----------
// async 处理器包装：异常转发到错误中间件（对应 Python 的 try/except → 500 {error}）
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// 对应 Python (qs.get("id") or [""])[0]
function q1(req, key, def = "") {
  const v = req.query[key];
  if (v === undefined || v === null) return def;
  return Array.isArray(v) ? (v[0] ?? def) : v;
}

function qint(req, key, def) {
  const n = parseInt(q1(req, key, String(def)), 10);
  return Number.isNaN(n) ? def : n;
}

// 当前登录账号的「个人解析 Cookie」：仅本人可用，未设置时回退到站点全局配置
async function personalParseCookie(username) {
  if (!username) return "";
  try {
    return String(await getBackend().getParseCookie(username) || "");
  } catch {
    return "";
  }
}

function maskAuth(req) {
  const h = req.headers["authorization"] || req.headers["x-auth-token"] || "";
  let token = String(h).replace("Bearer ", "").trim();
  // <video>/<a> 等媒体标签无法携带 Authorization 头，允许 ?token= 查询参数鉴权
  if (!token && req.query && req.query.token) token = String(req.query.token).trim();
  return token;
}

// ---------- 会话持久化（MongoDB） ----------
// 本地原版会话存进程内存（重启失效）；Serverless 环境多实例/冷启动会互相看不到，
// 因此会话写入 MongoDB 的 sessions 集合（多实例共享、重启不丢），内存 Map 仅作热缓存。
function getSessionsColl() {
  try {
    const backend = getBackend();
    return backend.collection ? backend.collection("sessions") : null;
  } catch {
    return null;
  }
}

function pruneSessions() {
  if (sessions.size > 2000) {
    const entries = [...sessions.entries()].sort((a, b) => a[1].created_at - b[1].created_at);
    for (let i = 0; i < entries.length / 2; i++) sessions.delete(entries[i][0]);
  }
}

async function checkAuth(req, res, allowUnauth = false) {
  // 检查当前请求是否已登录。返回 [authenticated, user_dict 或 null]
  const token = maskAuth(req);
  if (!token) {
    if (allowUnauth) return [false, null];
    res.status(401).json({ ok: false, msg: "需要登录", code: "unauthorized" });
    return [null, null];
  }
  // 1. 本实例热缓存
  let session = sessions.get(token);
  if (!session) {
    // 2. MongoDB 持久会话（跨实例共享）
    try {
      const coll = getSessionsColl();
      if (coll) {
        const doc = await coll.findOne({ token });
        if (doc) {
          session = { username: doc.username, role: doc.role, created_at: doc.created_at };
          sessions.set(token, session);
        }
      }
    } catch {}
  }
  if (session) return [true, session];
  if (allowUnauth) return [false, null];
  res.status(401).json({ ok: false, msg: "需要登录", code: "unauthorized" });
  return [null, null];
}

async function requireAuth(req, res) {
  const [authed] = await checkAuth(req, res);
  return !!authed;
}

// 路由门 Middleware：未登录直接 401（异步版，适配 Mongo 会话查询）
async function authMw(req, res, next) {
  try {
    const authed = await requireAuth(req, res);
    if (!authed) return; // 401 已写入
    next();
  } catch (e) {
    next(e);
  }
}

// ---------- 备份操作串行锁（对应 Python _BACKUP_LOCK） ----------
let _backupChain = Promise.resolve();
function withBackupLock(fn) {
  const p = _backupChain.then(fn, fn);
  _backupChain = p.catch(() => {});
  return p;
}

// 检查外部命令是否存在（对应 shutil.which）
function which(cmd) {
  try {
    const r = spawnSync("which", [cmd], { timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

export function createApp(state, services) {
  const { client, recorder, notifier, monitor } = services;

  const app = express();
  app.disable("x-powered-by");

  // 所有 JSON 响应带 CORS（对应 _json 的 Access-Control-Allow-Origin: *）
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    next();
  });
  // CORS 预检
  app.options("*", (req, res) => {
    res.status(204);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.end();
  });
  // JSON body 解析；解析失败按 {} 处理（对应 Python _read_body 的容错）
  app.use(express.json({ limit: "10mb" }));
  app.use((err, req, res, next) => {
    if (err && err.type === "entity.parse.failed") {
      req.body = {};
      return next();
    }
    next(err);
  });
  app.use((req, res, next) => {
    if (req.body === undefined) req.body = {};
    next();
  });

  // ---------- 页面 ----------
  function servePage(res, file, fallbackTitle) {
    let body;
    try {
      body = fs.readFileSync(path.join(PUBLIC_DIR, file));
    } catch {
      body = Buffer.from(
        `<html><body><h1>${fallbackTitle}</h1><p>请将 ${file} 放在同目录下</p></body></html>`,
        "utf-8"
      );
    }
    res.status(200);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Length", String(body.length));
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.end(body);
  }

  app.get(["/", "/index.html"], (req, res) => servePage(res, "index.html", "抖音直播监控"));
  app.get(["/admin.html", "/admin"], (req, res) => servePage(res, "admin.html", "后台管理"));
  // js 静态资源（原版页面未引用，保留以兼容未来扩展）
  app.get("/js/:name", (req, res) => {
    const name = path.basename(req.params.name);
    const fp = path.join(PUBLIC_DIR, "js", name);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: "not found" });
    const ext = name.endsWith(".js") ? "application/javascript; charset=utf-8" : "application/octet-stream";
    res.setHeader("Content-Type", ext);
    res.end(fs.readFileSync(fp));
  });

  // 网站图标
  const FAVICON_TYPES = {
    "/favicon.svg": ["favicon.svg", "image/svg+xml"],
    "/favicon.png": ["favicon.png", "image/png"],
    "/favicon.ico": ["favicon.ico", "image/x-icon"],
  };
  for (const [route, [file, ctype]] of Object.entries(FAVICON_TYPES)) {
    app.get(route, (req, res) => {
      const fp = path.join(PUBLIC_DIR, file);
      if (!fs.existsSync(fp)) return res.status(404).json({ error: "not found" });
      res.setHeader("Content-Type", ctype);
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.end(fs.readFileSync(fp));
    });
  }

  // ---------- 主播 / 监控数据 ----------
  function findStreamer(sid) {
    sid = String(sid || "");
    for (const s of state.streamers) {
      if (sid === String(s.sec_uid || "") || sid === String(s.web_rid || "")) return s;
    }
    return null;
  }

  const streamerId = (s) => s.sec_uid || s.web_rid || "";

  async function streamerPayload(s) {
    return { ...s, history_today: await monitor.history_stats(s) };
  }

  app.get("/api/streamers", authMw, ah(async (req, res) => {
    // 仅返回当前登录用户关联的主播；游客返回空列表
    const [authed, user] = await checkAuth(req, res, true);
    let streamers = [];
    if (authed && user) {
      const ids = new Set(await getBackend().loadUserStreamerIds(user.username));
      for (const s of state.streamers) {
        if (ids.has(streamerId(s))) streamers.push(await streamerPayload(s));
      }
    }
    res.json({
      streamers,
      has_ffmpeg: recorder.has_ffmpeg,
      last_refresh: monitor.last_refresh,
      recording_count: recorder.list().length,
    });
  }));

  app.get("/api/room", authMw, ah(async (req, res) => {
    const s = findStreamer(q1(req, "id"));
    if (!s) return res.status(404).json({ error: "未找到该主播" });
    const web_rid = s.web_rid || "";
    if (web_rid) await monitor._refresh_one(s);
    res.json(await streamerPayload(s));
  }));

  app.get("/api/parse", authMw, ah(async (req, res) => {
    const text = q1(req, "text");
    res.json(await resolveInput(text, client));
  }));

  app.get("/api/parse/video", authMw, ah(async (req, res) => {
    // 抖音作品解析：视频（无水印直链）/ 图集（图片 + 动图 + 实况图动态视频）
    const text = q1(req, "text");
    const [, user] = await checkAuth(req, res);
    if (!user) return;
    const personal = await personalParseCookie(user.username);
    res.json(await parseAweme(text, { cookie: personal || String(state.config.cookie || "") }));
  }));

  app.get("/api/parse/user", authMw, ah(async (req, res) => {
    // 抖音用户主页解析：资料 + 作品列表（cursor 翻页）
    const [, user] = await checkAuth(req, res);
    if (!user) return;
    const personal = await personalParseCookie(user.username);
    res.json(await parseUser(q1(req, "text"), {
      cookie: personal || String(state.config.cookie || ""),
      cursor: q1(req, "cursor") || "0",
    }));
  }));

  // ---------- 个人解析 Cookie：按登录账号隔离，不进全局配置 / 后台表 / 日志 ----------
  app.get("/api/parse/cookie", authMw, ah(async (req, res) => {
    const [, user] = await checkAuth(req, res);
    if (!user) return;
    let cookie = "", updated_at = 0;
    try {
      const backend = getBackend();
      cookie = String(await backend.getParseCookie(user.username) || "");
      const coll = backend.collection && backend.collection("parse_cookies");
      const row = coll ? await coll.findOne({ username: user.username }, { projection: { updated_at: 1 } }) : null;
      updated_at = Number(row && row.updated_at) || 0;
    } catch {}
    // 状态接口不回传明文 Cookie，只返回长度与末尾 4 位
    res.json({
      ok: true, username: user.username, has: !!cookie,
      length: cookie.length, tail: cookie ? cookie.slice(-4) : "", updated_at,
    });
  }));

  app.post("/api/parse/cookie", authMw, ah(async (req, res) => {
    const [, user] = await checkAuth(req, res);
    if (!user) return;
    const raw = String((req.body || {}).cookie || "").replace(/[\r\n]+/g, " ").trim();
    if (raw.length > 8192) {
      return res.status(400).json({ ok: false, msg: "Cookie 过长（上限 8192 字符）" });
    }
    try {
      if (!raw) {
        await getBackend().deleteParseCookie(user.username);
        return res.json({ ok: true, has: false, msg: "已清除个人 Cookie" });
      }
      await getBackend().saveParseCookie(user.username, raw);
      return res.json({ ok: true, has: true, length: raw.length, msg: "已保存个人 Cookie" });
    } catch (e) {
      return res.status(500).json({ ok: false, msg: `保存失败: ${e && e.message ? e.message : e}` });
    }
  }));

  app.get("/api/refresh", authMw, ah(async (req, res) => {
    // 仅管理员可触发刷新（拉取主播最新状态）
    const [, user] = await checkAuth(req, res);
    if (!user) return;
    if (user.role !== "admin") {
      return res.status(403).json({ ok: false, msg: "仅管理员可触发刷新", code: "forbidden" });
    }
    const sid = q1(req, "id");
    if (sid) {
      const s = findStreamer(sid);
      if (!s) return res.status(404).json({ ok: false, msg: "未找到该主播" });
      await monitor._refresh_one(s, true);
      await getBackend().saveStreamers(state.streamers);
      return res.json({ ok: true, msg: "已刷新" });
    }
    monitor.refresh_all(true, true).catch(() => {});
    res.json({ ok: true, msg: "刷新已开始" });
  }));

  // ---------- Vercel Cron 定时刷新（Serverless 环境，无常驻线程） ----------
  app.get("/api/cron/refresh", ah(async (req, res) => {
    // 安全：必须在 Vercel 项目设置 CRON_SECRET 环境变量（Vercel 会自动附带 Bearer 头调用）
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      return res.status(401).json({ ok: false, msg: "未设置 CRON_SECRET 环境变量，定时刷新接口已禁用" });
    }
    const auth = String(req.headers["authorization"] || "");
    if (auth !== `Bearer ${secret}`) {
      return res.status(401).json({ ok: false, msg: "无效的 CRON_SECRET" });
    }
    try {
      // 软截止 45s：避免超出 Serverless 执行时限导致状态丢失
      await monitor.refresh_all(true, false, { deadlineMs: 45000 });
      res.json({ ok: true, msg: "定时刷新完成", last_refresh: monitor.last_refresh });
    } catch (e) {
      res.json({ ok: false, msg: String(e && e.message ? e.message : e) });
    }
  }));

  // ---------- 录播 ----------
  app.get("/api/recordings", authMw, ah(async (req, res) => {
    res.json({ records: recorder.list() });
  }));

  app.get("/api/record_history", authMw, ah(async (req, res) => {
    const history = await recorder.get_history();
    for (const rec of history) {
      rec.exists = fs.existsSync(rec.file_path || "");
    }
    res.json({ history });
  }));

  app.get("/api/record_download", authMw, ah(async (req, res) => {
    const rec_id = parseInt(q1(req, "id"), 10);
    if (Number.isNaN(rec_id)) return res.status(400).json({ error: "缺少录播 ID" });

    const history = await recorder.get_history(10000);
    const item = history.find((r) => r.id === rec_id);
    if (!item) return res.status(404).json({ error: "录播记录不存在" });

    const fpath = path.resolve(item.file_path || "");
    const record_root = path.resolve(state.config.record_dir || DEFAULT_RECORD_DIR);
    if (!(fpath === record_root || fpath.startsWith(record_root + path.sep))) {
      return res.status(403).json({ error: "录播路径不允许下载" });
    }
    let stat;
    try {
      stat = fs.statSync(fpath);
      if (!stat.isFile()) throw new Error("not a file");
    } catch {
      return res.status(404).json({ error: "录播文件不存在" });
    }

    const filename = path.basename(fpath);
    res.status(200);
    res.setHeader("Content-Type", "video/x-flv");
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    const stream = fs.createReadStream(fpath, { highWaterMark: 1024 * 1024 });
    stream.pipe(res);
    res.on("close", () => stream.destroy());
  }));

  // ---------- 配置 / 日志 / 导入导出 ----------
  app.get("/api/config", authMw, ah(async (req, res) => {
    // 仅管理员可读取系统配置
    const [, user] = await checkAuth(req, res);
    if (!user) return;
    if (user.role !== "admin") {
      return res.status(403).json({ ok: false, msg: "仅管理员可查看配置", code: "forbidden" });
    }
    // tg_bot_token 永久脱敏（不可逆）；tg_chat_ids/fudai_cookie 支持 ?raw=1 查真实值
    const raw = q1(req, "raw") === "1";
    const cfg = { ...state.config };
    // 存储后端选择（系统级设置）
    const sb = await getBackend().getStorageBackend();
    if (sb) cfg.storage_backend = sb;
    cfg.tg_bot_token = cfg.tg_bot_token ? "●●●●●●" : "";
    if (!raw) {
      if (cfg.tg_chat_ids) cfg.tg_chat_ids = "●●●●●●";
      if (cfg.fudai_cookie) cfg.fudai_cookie = maskValue(cfg.fudai_cookie);
      if (cfg.square_cookie) cfg.square_cookie = maskValue(cfg.square_cookie);
      if (cfg.cookie) cfg.cookie = maskValue(cfg.cookie);
    }
    res.json({ config: cfg });
  }));

  app.get("/api/export", authMw, ah(async (req, res) => {
    const body = Buffer.from(JSON.stringify(state.streamers, null, 2), "utf-8");
    res.status(200);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=douyin_watchlist.json");
    res.setHeader("Content-Length", String(body.length));
    res.end(body);
  }));

  app.get("/api/logs", authMw, ah(async (req, res) => {
    const sec_uid = q1(req, "sec_uid");
    const logs = await getBackend().getLogs(sec_uid);
    // 同时合并内存中的新日志（避免重启前丢失）
    for (const entry of LOGS) {
      if (!sec_uid || entry.sec_uid === sec_uid) logs.push(entry);
    }
    res.json({ logs });
  }));

  app.get("/api/search", authMw, ah(async (req, res) => {
    const keyword = (q1(req, "keyword") || q1(req, "q") || "").trim();
    if (!keyword) return res.json({ ok: false, msg: "请输入关键词" });
    res.json(await client.search(keyword));
  }));

  // ---------- 直播广场（公开） ----------
  app.get("/api/square/hot", ah(async (req, res) => {
    res.json(await client.get_hot_list());
  }));
  app.get("/api/square/search", ah(async (req, res) => {
    const keyword = q1(req, "keyword").trim();
    if (!keyword) return res.json({ ok: false, msg: "请输入关键词" });
    res.json(await client.search_live(keyword));
  }));
  app.get("/api/square/feed", ah(async (req, res) => {
    res.json(await client.get_live_feed());
  }));
  app.get("/api/square/partitions", ah(async (req, res) => {
    // 返回分区名称映射表（分类查看用）
    res.json(await client.get_partition_list());
  }));
  app.get("/api/square/partition", ah(async (req, res) => {
    const pid = qint(req, "pid", 0);
    const offset = qint(req, "offset", 0);
    const count = qint(req, "count", 20);
    res.json(await client.get_partition_rooms(pid || "", offset, count));
  }));
  app.get("/api/square/categorynew", ah(async (req, res) => {
    const type_id = qint(req, "type", 4);
    const cat_id = qint(req, "id", 0);
    res.json(await client.get_categorynew_rooms(type_id, cat_id));
  }));

  // ---------- 流代理 / 本地操作 ----------
  app.get("/api/proxy", authMw, ah(async (req, res) => {
    const url = q1(req, "u");
    let parsed = null;
    try { parsed = new URL(url); } catch {}
    const host = parsed ? parsed.hostname : "";
    if (!parsed || !["http:", "https:"].includes(parsed.protocol) ||
        !ALLOWED_STREAM_HOSTS.some((h) => host.endsWith(h))) {
      return res.status(400).json({ error: "不允许代理该地址" });
    }
    let upstream;
    try {
      const upHeaders = {
        "User-Agent": UA_DESKTOP,
        "Referer": "https://live.douyin.com/",
        "Accept": "*/*",
        "Accept-Encoding": "identity",
      };
      // 透传 Range 头：视频/音频拖动进度条需要 206 分段响应
      const range = req.headers["range"];
      if (range) upHeaders.Range = range;
      upstream = await undiciFetch(url, {
        headers: upHeaders,
        dispatcher: getDispatcher(),
        redirect: "follow",
      });
      if (!upstream.ok && upstream.status !== 206) throw new Error(`HTTP ${upstream.status}`);
    } catch (e) {
      log("warn", `代理失败: ${e && e.message ? e.message : e}`);
      if (!res.headersSent) return res.status(502).json({ error: String(e && e.message ? e.message : e) });
      return;
    }
    // 透传上游状态码（200/206）与分段响应相关头
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
    for (const h of ["content-range", "accept-ranges", "content-length"]) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Connection", "close");
    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.pipe(res);
    res.on("close", () => nodeStream.destroy());
    nodeStream.on("error", () => res.destroy());
  }));

  app.get("/api/open_dir", authMw, ah(async (req, res) => {
    const p = state.config.record_dir || DEFAULT_RECORD_DIR;
    fs.mkdirSync(p, { recursive: true });
    try {
      const child = spawn("xdg-open", [p], { detached: true, stdio: "ignore" });
      child.unref();
      res.json({ ok: true, path: p });
    } catch (e) {
      res.json({ ok: false, msg: String(e && e.message ? e.message : e), path: p });
    }
  }));

  app.get("/api/play", authMw, ah(async (req, res) => {
    const url = q1(req, "u");
    const players = [
      ["mpv", ["mpv", url]],
      ["ffplay", ["ffplay", "-autoexit", url]],
      ["vlc", ["vlc", url]],
      ["potplayer", ["potplayer", url]],
    ];
    for (const [name, cmd] of players) {
      if (which(cmd[0])) {
        try {
          const child = spawn(cmd[0], cmd.slice(1), { stdio: "ignore", detached: true });
          child.unref();
          return res.json({ ok: true, player: name });
        } catch (e) {
          return res.json({ ok: false, msg: String(e && e.message ? e.message : e) });
        }
      }
    }
    res.json({ ok: false, msg: "未找到 mpv/ffplay/vlc/potplayer" });
  }));

  // ---------- Pin / 通知 / 福袋 / 存储 ----------
  app.get("/api/pin", authMw, ah(async (req, res) => {
    // 获取当前置顶状态
    const s = findStreamer(q1(req, "id"));
    if (!s) return res.status(404).json({ error: "未找到该主播" });
    res.json({ pinned: Number(s.pinned) || 0 });
  }));

  // 通知测试（GET + POST 共用）
  async function apiNotify(req, res) {
    let event = "live_start";
    let sid = "";
    if (req.query && Object.keys(req.query).length) {
      event = q1(req, "event", "live_start");
      sid = q1(req, "id");
    }
    const data = req.body || {};
    if (data && Object.keys(data).length) {
      event = data.event !== undefined ? data.event : event;
      sid = (data.id !== undefined ? data.id : sid) || sid;
    }
    if (event !== "live_start" && event !== "live_end") {
      return res.json({ ok: false, msg: "event 必须为 live_start 或 live_end" });
    }
    if (!notifier) {
      return res.json({ ok: false, msg: "通知模块未初始化" });
    }
    try {
      let ok, msg;
      if (sid) {
        const s = findStreamer(sid);
        if (!s) return res.json({ ok: false, msg: "未找到该主播" });
        [ok, msg] = await notifier.notify_sync(event, s);
      } else {
        [ok, msg] = await notifier.notify_test(event);
      }
      res.json({ ok, msg, event });
    } catch (e) {
      res.json({ ok: false, msg: String(e && e.message ? e.message : e) });
    }
  }
  app.get("/api/notify", authMw, ah(apiNotify));
  app.post("/api/notify", authMw, ah(apiNotify));

  app.get("/api/backup/list", authMw, ah(async (req, res) => {
    // 获取备份列表（进程内实现，无需子进程）
    try {
      const data = cmdList();
      res.json({ ok: true, backups: data.backups || [] });
    } catch (e) {
      res.json({ ok: false, msg: String(e && e.message ? e.message : e) });
    }
  }));

  app.get("/api/fudai", authMw, ah(async (req, res) => {
    // 手动检测福袋（调试用）。GET /api/fudai?id=<web_rid>&force=1
    const web_rid = q1(req, "id").trim();
    if (!web_rid) return res.json({ ok: false, msg: "缺少 id 参数" });
    const force = ["1", "true", "yes"].includes(q1(req, "force"));
    try {
      const fd = await client.get_room_fudai(web_rid, { force });
      res.json({ ok: true, fudai: fd.toDict() });
    } catch (e) {
      res.json({ ok: false, msg: String(e && e.message ? e.message : e) });
    }
  }));

  app.get("/api/fudai/right", authMw, ah(async (req, res) => {
    // 查询当前账号参与福袋资格（调试用）
    const lottery_id = q1(req, "lottery_id").trim();
    const room_id = q1(req, "room_id").trim();
    const anchor_id = q1(req, "anchor_id").trim();
    if (!lottery_id || !room_id || !anchor_id) {
      return res.json({ ok: false, msg: "缺少 lottery_id/room_id/anchor_id 参数" });
    }
    try {
      const data = await client.check_fudai_right(lottery_id, room_id, anchor_id);
      if (data) return res.json({ ok: true, right: data });
      res.json({ ok: false, msg: "查询失败（无返回/风控），请检查福袋参数配置" });
    } catch (e) {
      res.json({ ok: false, msg: String(e && e.message ? e.message : e) });
    }
  }));

  app.get("/api/storage/status", authMw, ah(async (req, res) => {
    // 获取存储状态（Node 版单一 MongoDB 后端）
    const backend = getBackend();
    const mongo = await backend.getStatus();
    res.json({
      ok: true,
      mongodb: mongo,
      current: "mongodb",
    });
  }));

  app.get("/api/notify/logs", authMw, ah(async (req, res) => {
    // 获取通知记录
    const sec_uid = q1(req, "sec_uid");
    const channel = q1(req, "channel");
    const event_type = q1(req, "event_type");
    const limit = qint(req, "limit", 200);
    try {
      const logs = await getBackend().getNotifyLogs(sec_uid, channel, event_type, limit);
      res.json({ ok: true, logs });
    } catch (e) {
      res.json({ ok: false, msg: String(e && e.message ? e.message : e) });
    }
  }));

  app.get("/api/fudai/history", authMw, ah(async (req, res) => {
    // 获取福袋历史记录
    const sec_uid = q1(req, "sec_uid");
    const limit = qint(req, "limit", 200);
    try {
      const history = await getBackend().getFudaiHistory(sec_uid, limit);
      res.json({ ok: true, history });
    } catch (e) {
      res.json({ ok: false, msg: String(e && e.message ? e.message : e) });
    }
  }));

  app.get("/api/fudai/current", authMw, ah(async (req, res) => {
    // 获取指定主播的当前福袋状态。注意此处用 sec_uid（/api/fudai 用 web_rid）
    const sec_uid = q1(req, "id").trim();
    if (!sec_uid) return res.json({ ok: false, msg: "缺少 id 参数" });
    try {
      const fudai = await getBackend().getFudai(sec_uid);
      res.json({ ok: true, fudai });
    } catch (e) {
      res.json({ ok: false, msg: String(e && e.message ? e.message : e) });
    }
  }));

  // ---------- 账号 API（公开） ----------
  app.get("/api/account/status", ah(async (req, res) => {
    // 检查当前登录状态
    const [authed, user] = await checkAuth(req, res, true);
    if (authed) {
      res.json({ ok: true, logged_in: true, user: { username: user.username, role: user.role } });
    } else {
      const has_accounts = (await getBackend().accountCount()) > 0;
      res.json({ ok: true, logged_in: false, has_accounts });
    }
  }));

  app.post("/api/account/setup", ah(async (req, res) => {
    // 首次设置管理员账号（当 accounts 表为空时）
    const body = req.body || {};
    const username = String(body.username || "").trim();
    const password = body.password || "";
    if (username.length < 2 || username.length > 32) {
      return res.json({ ok: false, msg: "用户名需2-32个字符" });
    }
    if (password.length < 6) {
      return res.json({ ok: false, msg: "密码至少6位" });
    }
    try {
      const backend = getBackend();
      if ((await backend.accountCount()) > 0) {
        return res.json({ ok: false, msg: "已有账号存在" });
      }
      const { ok, msg } = await backend.createAccount(username, password, "admin");
      if (ok) res.json({ ok: true, msg: "管理员账号创建成功", username });
      else res.json({ ok: false, msg });
    } catch (e) {
      res.json({ ok: false, msg: String(e && e.message ? e.message : e) });
    }
  }));

  app.post("/api/account/register", ah(async (req, res) => {
    // 注册普通用户（role=user）。VIP 由管理员在后台将 role 改为 vip
    const body = req.body || {};
    const username = String(body.username || "").trim();
    const password = body.password || "";
    if (username.length < 2 || username.length > 32) {
      return res.json({ ok: false, msg: "用户名需2-32个字符" });
    }
    if (password.length < 6) {
      return res.json({ ok: false, msg: "密码至少6位" });
    }
    try {
      const backend = getBackend();
      const { ok, msg } = await backend.createAccount(username, password, "user");
      if (ok) res.json({ ok: true, msg: "注册成功", username });
      else res.json({ ok: false, msg });
    } catch (e) {
      res.json({ ok: false, msg: String(e && e.message ? e.message : e) });
    }
  }));

  app.post("/api/account/login", ah(async (req, res) => {
    // 登录。返回 {token, user}
    const body = req.body || {};
    const username = String(body.username || "").trim();
    const password = body.password || "";
    if (!username || !password) {
      return res.json({ ok: false, msg: "用户名和密码不能为空" });
    }
    try {
      const backend = getBackend();
      const { ok, user } = await backend.authenticate(username, password);
      if (!ok) return res.json({ ok: false, msg: "用户名或密码错误" });
      // 生成简单 token（与 Python 相同的构造方式）
      const raw = `${username}|${password}|${nowSec()}|${crypto.randomBytes(8).toString("hex")}`;
      const token = crypto.createHash("sha256").update(raw, "utf-8").digest("hex");
      const created = nowSec();
      sessions.set(token, { username: user.username, role: user.role, created_at: created });
      pruneSessions();
      // 持久化到 MongoDB（Serverless 多实例共享会话）
      try {
        const coll = getSessionsColl();
        if (coll) {
          await coll.insertOne({ token, username: user.username, role: user.role, created_at: created });
        }
      } catch {}
      res.json({ ok: true, token, user: { username: user.username, role: user.role } });
    } catch (e) {
      res.json({ ok: false, msg: String(e && e.message ? e.message : e) });
    }
  }));

  app.post("/api/account/logout", ah(async (req, res) => {
    // 登出（清除 session token：内存 + MongoDB）
    const token = maskAuth(req);
    sessions.delete(token);
    try {
      const coll = getSessionsColl();
      if (coll) await coll.deleteOne({ token });
    } catch {}
    res.json({ ok: true, msg: "已退出" });
  }));

  app.post("/api/account/change", ah(async (req, res) => {
    // 修改密码
    const [authed, user] = await checkAuth(req, res);
    if (!authed) return;
    const body = req.body || {};
    const old_password = body.old_password || "";
    const new_password = body.new_password || "";
    if (String(new_password).length < 6) {
      return res.json({ ok: false, msg: "新密码至少6位" });
    }
    try {
      const { ok, msg } = await getBackend().changePassword(user.username, old_password, new_password);
      res.json({ ok, msg });
    } catch (e) {
      res.json({ ok: false, msg: String(e && e.message ? e.message : e) });
    }
  }));

  // ---------- 主播 CRUD（POST，需登录） ----------
  app.post("/api/add", authMw, ah(async (req, res) => {
    const data = req.body || {};
    const parsed = await resolveInput(data.text || "", client);
    if (!parsed.web_rid && !parsed.sec_uid) {
      return res.json({ ok: false, msg: parsed.error || "无法识别输入" });
    }
    const item_id = parsed.sec_uid || parsed.web_rid;
    const [authed, user] = await checkAuth(req, res, true);
    const username = authed && user ? user.username : "";
    let streamer;
    const existing = findStreamer(item_id);
    if (!existing) {
      // 主播表中无此主播：创建全局唯一主播记录（多个用户添加同一主播时复用）
      streamer = {
        sec_uid: parsed.sec_uid || "",
        web_rid: parsed.web_rid || "",
        room_id: parsed.room_id || "",
        nickname: parsed.nickname || parsed.web_rid || parsed.sec_uid || "",
        unique_id: parsed.unique_id || "",
        avatar: parsed.avatar || "",
        note: String(data.note || ""),
        room: {},
        created_at: nowSec(),
        pinned: 0, // 默认不置顶
      };
      state.streamers.push(streamer);
      if (streamer.web_rid) {
        await monitor._refresh_one(streamer);
      }
      await getBackend().saveStreamers(state.streamers);
    } else {
      streamer = existing;
    }
    // 建立当前用户与主播的关联（多用户可添加同一主播，主播表保持唯一）
    if (username) {
      await getBackend().addUserStreamer(username, streamerId(streamer));
    }
    res.json({ ok: true, streamer });
  }));

  app.post("/api/remove", authMw, ah(async (req, res) => {
    const data = req.body || {};
    const sid = data.id || "";
    const [authed, user] = await checkAuth(req, res, true);
    const username = authed && user ? user.username : "";
    if (!username) return res.status(401).json({ ok: false, msg: "需要登录" });
    const s = findStreamer(sid);
    if (!s) return res.json({ ok: false, msg: "未找到该主播" });
    const rec_id = streamerId(s);
    if (rec_id) {
      await recorder.stop(rec_id);
    }
    // 仅移除当前用户与该主播的关联；主播数据保留供其他用户与定时任务使用
    await getBackend().removeUserStreamer(username, streamerId(s));
    res.json({ ok: true, msg: "已从我的列表移除" });
  }));

  app.post("/api/record", authMw, ah(async (req, res) => {
    const data = req.body || {};
    const sid = data.id || "";
    const action = data.action || "";
    if (action === "stop" && recorder.records.has(sid)) {
      const [ok, msg] = await recorder.stop(sid);
      return res.json({ ok, msg });
    }
    const s = findStreamer(sid);
    if (!s) return res.json({ ok: false, msg: "未找到该主播" });
    const rec_id = streamerId(s);
    if (action === "stop") {
      const [ok, msg] = await recorder.stop(rec_id);
      return res.json({ ok, msg });
    }
    if (action !== "start") {
      return res.json({ ok: false, msg: "未知录制动作" });
    }
    if (s.web_rid) {
      await monitor._refresh_one(s);
    }
    const streams = (s.room || {}).streams || [];
    const q = streams.find((x) => x.flv || x.hls) || null;
    if (!q) return res.json({ ok: false, msg: "当前没有可录制的直播源" });
    const [ok, msg] = await recorder.start(
      rec_id,
      s.nickname || "unknown",
      s.web_rid || "",
      q.flv || q.hls,
      q.label || q.key || "",
    );
    res.json({ ok, msg });
  }));

  app.post("/api/import", authMw, ah(async (req, res) => {
    const data = req.body || {};
    let items;
    try {
      items = JSON.parse(data.content || "[]");
      if (!Array.isArray(items)) throw new Error("JSON 顶层必须是数组");
    } catch (e) {
      return res.json({ ok: false, msg: `导入失败: ${e && e.message ? e.message : e}` });
    }
    const cleaned = [];
    const seen = new Set();
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const web_rid = String(item.web_rid || "");
      const sec_uid = String(item.sec_uid || "");
      const key = sec_uid || web_rid;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      cleaned.push({
        sec_uid,
        web_rid,
        room_id: String(item.room_id || ""),
        nickname: String(item.nickname || key),
        unique_id: String(item.unique_id || ""),
        avatar: String(item.avatar || ""),
        note: String(item.note || ""),
        room: (item.room && typeof item.room === "object") ? item.room : {},
        created_at: Number(item.created_at) || nowSec(),
        pinned: Number(item.pinned ?? 0) || 0,
      });
    }
    state.streamers.splice(0, state.streamers.length, ...cleaned);
    await getBackend().saveStreamers(state.streamers);
    res.json({ ok: true, msg: `已导入 ${cleaned.length} 个主播` });
  }));

  app.post("/api/pin", authMw, ah(async (req, res) => {
    // 切换置顶状态：0 -> 1, 1 -> 0
    const data = req.body || {};
    const s = findStreamer(data.id || "");
    if (!s) return res.json({ ok: false, msg: "未找到该主播" });
    const current = Number(s.pinned) || 0;
    s.pinned = 1 - current;
    await getBackend().saveStreamers(state.streamers);
    res.json({ ok: true, pinned: s.pinned });
  }));

  app.post("/api/update", authMw, ah(async (req, res) => {
    // 更新单个主播设置（如 fudai_enabled）。POST body: {sec_uid, fudai_enabled: 0|1, note?}
    const data = req.body || {};
    const sid = String(data.sec_uid || data.id || "").trim();
    if (!sid) return res.json({ ok: false, msg: "缺少 sec_uid 或 id" });
    const s = findStreamer(sid);
    if (!s) return res.json({ ok: false, msg: "未找到该主播" });
    if ("fudai_enabled" in data) {
      s.fudai_enabled = Number(data.fudai_enabled) || 0;
    }
    if ("note" in data) {
      s.note = String(data.note);
    }
    await getBackend().saveStreamers(state.streamers);
    res.json({ ok: true, fudai_enabled: s.fudai_enabled ?? 1 });
  }));

  // ---------- 配置设置（POST，仅 admin） ----------
  app.post("/api/config", authMw, ah(async (req, res) => {
    // 仅管理员可修改系统配置
    const [, user] = await checkAuth(req, res);
    if (!user) return;
    if (user.role !== "admin") {
      return res.status(403).json({ ok: false, msg: "仅管理员可修改配置", code: "forbidden" });
    }
    const data = req.body || {};
    const cfg = state.config;
    // 记录保存前的值，用于判断是否需要触发副作用
    const prev = { ...cfg };

    function _put(key, cast = (v) => String(v), def = "") {
      if (!(key in data)) return;
      try {
        cfg[key] = cast(data[key]);
      } catch {
        cfg[key] = def;
      }
    }

    // ---------- 基础字段 ----------
    if ("interval" in data) {
      try {
        cfg.interval = Math.min(3600, Math.max(10, parseInt(data.interval ?? cfg.interval ?? 60, 10) || 60));
      } catch {
        cfg.interval = 60;
      }
    }
    _put("cookie");
    _put("record_dir", undefined, DEFAULT_RECORD_DIR);
    _put("proxy");
    _put("notify_sound", (v) => Boolean(v), true);
    _put("notify_browser", (v) => Boolean(v), true);

    // ---------- 第三方通知字段 ----------
    _put("tg_bot_token");
    _put("tg_chat_ids");
    _put("tg_proxy");
    _put("email_enabled", (v) => Boolean(v), false);
    _put("email_smtp");
    if ("email_port" in data) {
      try {
        cfg.email_port = String(parseInt(data.email_port || cfg.email_port || "465", 10));
      } catch {
        cfg.email_port = "465";
      }
    }
    _put("email_user");
    _put("email_pass");
    _put("email_from");
    _put("email_to");
    _put("email_subject_prefix", undefined, "抖音直播");
    _put("email_subject_template", undefined, "[{prefix}] {nickname} {action}");
    _put("email_body_template");
    _put("webhook_url");
    _put("notify_events", undefined, "live_start,live_end");

    // ---------- 福袋参数：空值不覆盖已保存的值（避免清空） ----------
    for (const key of ["fudai_ms_token", "fudai_a_bogus", "fudai_cookie"]) {
      if (key in data) {
        const val = String(data[key] || "").trim();
        if (val) cfg[key] = val;
      }
    }

    // ---------- 直播广场搜索参数：空值不覆盖 ----------
    for (const key of ["square_ms_token", "square_a_bogus", "square_cookie", "square_feed_url", "square_search_url"]) {
      if (key in data) {
        const val = String(data[key] || "").trim();
        if (val) cfg[key] = val;
      }
    }

    // ---------- 仅在相关字段变化时才触发副作用 ----------
    if ("cookie" in data && (cfg.cookie || "") !== (prev.cookie || "")) {
      client.cookie = cfg.cookie || "";
      client.refresh_session(true);
      log("info", "Cookie 已更新，已刷新抖音会话");
    }

    // 福袋参数变化时更新客户端
    for (const key of ["fudai_ms_token", "fudai_a_bogus", "fudai_cookie"]) {
      if (key in data && (cfg[key] || "") !== (prev[key] || "")) {
        const new_val = String(cfg[key] || "");
        if (new_val) {
          client[key] = new_val;
          log("info", `福袋参数 ${key} 已更新`);
        }
      }
    }

    // 广场搜索参数变化时更新客户端
    for (const key of ["square_ms_token", "square_a_bogus", "square_cookie", "square_feed_url", "square_search_url"]) {
      if (key in data && (cfg[key] || "") !== (prev[key] || "")) {
        const new_val = String(cfg[key] || "");
        if (new_val) {
          client[key] = new_val;
          log("info", `广场搜索参数 ${key} 已更新`);
        }
      }
    }

    // 只有全局 proxy 变化时才更新全局代理
    if ("proxy" in data && (cfg.proxy || "") !== (prev.proxy || "")) {
      setGlobalProxy(cfg.proxy || "");
      log("info", "全局代理已更新: " + (cfg.proxy || "<清除>"));
    }

    // 存储后端（Node 版固定 MongoDB，仅保留配置键兼容）
    if ("storage_backend" in data) {
      const new_backend = String(data.storage_backend || "").trim();
      if (new_backend === "mongodb") {
        await getBackend().setStorageBackend(new_backend);
        log("info", "存储后端: MongoDB");
        cfg.storage_backend = new_backend;
      }
    }

    // 通知模块：始终更新其内部配置
    if (notifier) notifier.cfg = cfg;

    await getBackend().saveConfig(cfg);
    res.json({ ok: true, config: sanitizeConfig(cfg) });
  }));

  // ---------- 备份（POST，需登录；进程内实现 + 串行锁） ----------
  app.post("/api/backup/create", authMw, ah(async (req, res) => {
    try {
      const data = req.body || {};
      const tag = String(data.tag || "").trim();
      const info = await withBackupLock(() => cmdBackup(tag));
      res.json({
        ok: true,
        msg: `备份已创建: ${info.id || "未知"}`,
        id: info.id || "",
        file_count: info.file_count || 0,
      });
    } catch (e) {
      res.json({ ok: false, msg: String(e && e.message ? e.message : e).slice(0, 200) });
    }
  }));

  app.post("/api/backup/restore", authMw, ah(async (req, res) => {
    const data = req.body || {};
    const bid = String(data.id || "").trim();
    if (!bid) return res.json({ ok: false, msg: "缺少备份 ID" });
    try {
      const info = await withBackupLock(() => cmdRestore(bid));
      res.json({ ok: true, msg: `恢复 ${info.restored} 个文件，跳过 ${info.skipped} 个` });
    } catch (e) {
      res.json({ ok: false, msg: String(e && e.message ? e.message : e).slice(0, 200) });
    }
  }));

  app.post("/api/backup/delete", authMw, ah(async (req, res) => {
    const data = req.body || {};
    const bid = String(data.id || "").trim();
    const delete_all = Boolean(data.all);
    if (!delete_all && !bid) {
      return res.json({ ok: false, msg: "缺少备份 ID 或 --all 标志" });
    }
    try {
      await withBackupLock(() => cmdDelete(bid || null, delete_all));
      res.json({ ok: true, msg: "备份已删除" });
    } catch (e) {
      res.json({ ok: false, msg: String(e && e.message ? e.message : e).slice(0, 200) });
    }
  }));

  // ---------- 存储管理（POST，需登录） ----------
  app.post("/api/storage/test", authMw, ah(async (req, res) => {
    // 测试数据库连接（Node 版为 MongoDB）
    try {
      const { ok, msg } = await getBackend().testConnection();
      res.json({ ok, msg });
    } catch (e) {
      res.json({ ok: false, msg: String(e && e.message ? e.message : e) });
    }
  }));

  app.post("/api/storage/copy", authMw, ah(async (req, res) => {
    // Node 版单一后端：双向复制退化为同库无操作，保持响应形状兼容
    const data = req.body || {};
    const direction = String(data.direction || "").trim();
    let tables = data.tables || null;
    if (tables !== null) {
      if (typeof tables === "string") {
        tables = tables.split(",").map((t) => t.trim()).filter(Boolean);
      } else if (Array.isArray(tables)) {
        tables = tables.map((t) => String(t).trim()).filter(Boolean);
      } else {
        tables = null;
      }
    }
    if (direction !== "sqlite_to_mysql" && direction !== "mysql_to_sqlite") {
      return res.json({ ok: false, msg: "direction 必须为 sqlite_to_mysql 或 mysql_to_sqlite" });
    }
    const backend = getBackend();
    const counts = await backend.getTableCounts().catch(() => ({}));
    try {
      const results = await backend.copyBetween("sqlite", "mysql", tables);
      const ok_all = Object.values(results).every((v) => v.ok);
      res.json({ ok: ok_all, results, direction });
    } catch (e) {
      res.json({ ok: false, msg: String(e && e.message ? e.message : e) });
    }
  }));

  // ---------- 后台管理 API ----------
  app.get("/api/admin/tables", authMw, ah(async (req, res) => {
    // 获取所有表及记录数。backend 参数仅作兼容（全部指向 MongoDB）
    const backend = getBackend();
    const backend_param = (q1(req, "backend") || "current").trim() || "current";
    const counts = await backend.getTableCounts().catch(() => ({}));
    const tables = [];
    for (const [tbl, desc] of Object.entries(TABLE_INFO)) {
      let sc = 0;
      try {
        // 与 Python 一致：sqlite 列的 history 分支缺失，恒为 0
        if (tbl === "config") sc = (await backend.loadConfigAll()).length;
        else if (tbl === "streamers") sc = (await backend.loadStreamers()).length;
        else if (tbl === "recordings") sc = (await backend.getRecordingHistory()).length;
        else if (tbl === "logs") sc = (await backend.getLogs()).length;
        else if (tbl === "notify_logs") sc = (await backend.getNotifyLogs()).length;
        else if (tbl === "fudai") sc = (await backend.getAllFudai()).length;
        else if (tbl === "fudai_history") sc = (await backend.getFudaiHistory()).length;
        else if (tbl === "accounts") sc = await backend.accountCount();
      } catch {
        sc = 0;
      }
      const mc = Number(counts[tbl]) || 0;
      const is_sqlite = backend_param !== "mysql";
      tables.push({ table: tbl, desc, sqlite: sc, mysql: mc, current: is_sqlite ? sc : mc });
    }
    res.json({ ok: true, tables });
  }));

  app.get("/api/stats/overview", authMw, ah(async (req, res) => {
    // 仪表盘聚合统计：表计数、在线状态、开播趋势、日志分布、通知汇总、录制汇总
    try {
      const backend = getBackend();
      const db = await backend._ensure();
      const counts = await backend.getTableCounts();

      // 主播在线状态（内存实时状态）
      const total = state.streamers.length;
      const online = state.streamers.filter((s) => s.room && s.room.live).length;

      const pad2 = (n) => String(n).padStart(2, "0");
      const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      const midnight = (offsetDays = 0) => {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() - offsetDays);
        return Math.floor(d.getTime() / 1000);
      };

      // 近 14 天开播趋势（本地时区按天聚合）
      const DAYS = 14;
      const since14 = midnight(DAYS - 1);
      const histRows = await db.collection("history")
        .find({ start_time: { $gte: since14 } }, { projection: { start_time: 1, duration: 1 } })
        .toArray();
      const dayBuckets = new Map();
      for (let i = DAYS - 1; i >= 0; i--) {
        dayBuckets.set(dayKey(new Date(Date.now() - i * 86400000)), { count: 0, duration: 0 });
      }
      for (const r of histRows) {
        const key = dayKey(new Date(r.start_time * 1000));
        const b = dayBuckets.get(key);
        if (b) { b.count += 1; b.duration += r.duration || 0; }
      }
      const live14d = [...dayBuckets.entries()].map(([day, v]) => ({ day, count: v.count, duration: v.duration }));

      // 近 7 天日志按级别
      const since7 = midnight(6);
      const logRows = await db.collection("logs")
        .find({ ts: { $gte: since7 } }, { projection: { ts: 1, level: 1 } })
        .toArray();
      const logBuckets = new Map();
      for (let i = 6; i >= 0; i--) {
        logBuckets.set(dayKey(new Date(Date.now() - i * 86400000)), { info: 0, warn: 0, error: 0, other: 0 });
      }
      for (const r of logRows) {
        const key = dayKey(new Date(r.ts * 1000));
        const b = logBuckets.get(key);
        if (!b) continue;
        if (r.level === "info") b.info += 1;
        else if (r.level === "warn") b.warn += 1;
        else if (r.level === "error") b.error += 1;
        else b.other += 1;
      }
      const logs7d = [...logBuckets.entries()].map(([day, v]) => ({ day, ...v }));

      // 通知发送汇总（按渠道 × 状态）
      const notifyAgg = await db.collection("notify_logs").aggregate([
        { $group: { _id: { channel: "$channel", status: "$status" }, count: { $sum: 1 } } },
      ]).toArray();
      const notify = notifyAgg.map((x) => ({ channel: x._id.channel || "", status: x._id.status || "", count: x.count }));

      // 录制汇总
      const recAgg = await db.collection("recordings").aggregate([
        { $group: { _id: null, size: { $sum: "$size" }, count: { $sum: 1 } } },
      ]).toArray();
      const recordings = {
        count: recAgg.length ? recAgg[0].count : 0,
        total_size: recAgg.length ? (recAgg[0].size || 0) : 0,
      };

      // 今日开播（本地零点起）
      const today = { live_count: await db.collection("history").countDocuments({ start_time: { $gte: midnight(0) } }) };

      res.json({
        ok: true,
        counts,
        streamers: { total, online, offline: total - online },
        live14d,
        logs7d,
        notify,
        recordings,
        today,
      });
    } catch (e) {
      res.json({ ok: false, msg: String(e && e.message ? e.message : e) });
    }
  }));

  app.get("/api/admin/records", authMw, ah(async (req, res) => {
    // 获取指定表的记录列表。backend 参数仅作兼容
    const table = q1(req, "table").trim();
    if (!table || !TABLE_INFO[table]) {
      return res.json({ ok: false, msg: "未知表: " + table });
    }
    const limit = qint(req, "limit", 20);
    const offset = qint(req, "offset", 0);
    const search = q1(req, "search").trim();
    const sort_by = q1(req, "sort").trim();
    let order = q1(req, "order", "desc").trim().toLowerCase();
    if (order !== "asc" && order !== "desc") order = "desc";

    try {
      const backend = getBackend();
      let records = [], cols = [], total = 0;

      if (table === "config") {
        total = await backend.countConfig();
        records = (await backend.loadConfigAll()).slice(offset, offset + limit);
        cols = ["key", "value"];
      } else if (table === "streamers") {
        total = await backend.countStreamers();
        records = (await backend.loadStreamers()).slice(offset, offset + limit);
        cols = ["sec_uid", "web_rid", "nickname", "unique_id", "note", "pinned", "fudai_enabled"];
      } else if (table === "history") {
        total = await backend.countHistory();
        const rows = await backend.getHistory(limit, offset, order);
        records = rows.map((r) => ({
          sec_uid: r.sec_uid, start_time: r.start_time,
          end_time: r.end_time, duration: r.duration,
        }));
        cols = ["sec_uid", "start_time", "end_time", "duration"];
      } else if (table === "recordings") {
        total = await backend.countRecordings();
        records = await backend.getRecordingHistory(limit, offset);
        cols = ["sec_uid", "nickname", "web_rid", "file_path", "duration", "size"];
      } else if (table === "logs") {
        total = await backend.countLogs();
        records = await backend.getLogs("", limit, offset);
        cols = ["ts", "level", "msg", "sec_uid", "web_rid", "event_type"];
      } else if (table === "notify_logs") {
        total = await backend.countNotifyLogs();
        records = await backend.getNotifyLogs("", "", "", limit, offset);
        cols = ["ts", "streamer_sec_uid", "streamer_nickname", "event_type", "channel", "status"];
      } else if (table === "fudai") {
        total = await backend.countFudai();
        records = await backend.getAllFudai(limit, offset);
        cols = ["sec_uid", "gift_name", "gift_image", "lucky_count", "candidate_num", "remain_seconds", "draw_time", "method"];
      } else if (table === "fudai_history") {
        total = await backend.countFudaiHistory();
        records = await backend.getFudaiHistory("", limit, offset);
        cols = ["sec_uid", "web_rid", "nickname", "gift_name", "lucky_count", "candidate_num", "remain_seconds", "started_at", "ended_at"];
      } else if (table === "accounts") {
        total = await backend.countAccounts();
        records = await backend.listAccounts(limit, offset);
        cols = ["id", "username", "role", "created_at", "updated_at", "login_at"];
      }

      if (search) {
        // 全文搜索：在所有列值中匹配（大小写不敏感）
        const lower = search.toLowerCase();
        records = records.filter((rec) =>
          Object.values(rec).some((v) => String(v ?? "").toLowerCase().includes(lower)));
        total = records.length;
      }
      if (sort_by && cols.includes(sort_by)) {
        records = [...records].sort((a, b) => {
          const va = a[sort_by] ?? 0;
          const vb = b[sort_by] ?? 0;
          if (va < vb) return order === "desc" ? 1 : -1;
          if (va > vb) return order === "desc" ? -1 : 1;
          return 0;
        });
      }

      res.json({ ok: true, table, total, cols, records, offset, limit });
    } catch (e) {
      res.json({ ok: false, msg: String(e && e.message ? e.message : e) });
    }
  }));

  app.post("/api/admin/record/edit", ah(async (req, res) => {
    // 编辑一条记录
    if (!(await requireAuth(req, res))) return;
    const body = req.body || {};
    const table = String(body.table || "").trim();
    const primary_key = String(body.primary_key || "").trim();
    const changes = body.changes || {};
    if (!table || !primary_key || !changes || !Object.keys(changes).length) {
      return res.json({ ok: false, msg: "缺少 table / primary_key / changes" });
    }
    try {
      const backend = getBackend();
      if (table === "config") {
        for (const [k, v] of Object.entries(changes)) {
          await backend.adminUpdateConfig(k, v);
        }
        return res.json({ ok: true, msg: "已更新" });
      } else if (table === "streamers") {
        const records = await backend.loadStreamers();
        let found = false;
        for (const s of records) {
          const sk = s.sec_uid || s.web_rid;
          if (sk === primary_key) {
            for (const [k, v] of Object.entries(changes)) s[k] = v;
            s.updated_at = nowSec();
            found = true;
            break;
          }
        }
        if (!found) return res.json({ ok: false, msg: "记录不存在" });
        await backend.saveStreamers(records);
        return res.json({ ok: true, msg: "已更新" });
      } else if (["history", "recordings", "logs", "notify_logs", "fudai", "fudai_history"].includes(table)) {
        await backend.adminUpdateById(table, primary_key, changes);
        return res.json({ ok: true, msg: "已更新" });
      } else if (table === "accounts") {
        await backend.adminUpdateById("accounts", primary_key, changes);
        return res.json({ ok: true, msg: "已更新" });
      }
      res.json({ ok: false, msg: "未知表: " + table });
    } catch (e) {
      res.json({ ok: false, msg: String(e && e.message ? e.message : e) });
    }
  }));

  app.post("/api/admin/record/delete", ah(async (req, res) => {
    // 删除一条记录
    if (!(await requireAuth(req, res))) return;
    const body = req.body || {};
    const table = String(body.table || "").trim();
    const primary_key = String(body.primary_key || "").trim();
    if (!table || !primary_key) {
      return res.json({ ok: false, msg: "缺少 table 或 primary_key" });
    }
    try {
      const backend = getBackend();
      if (table === "config") {
        await backend.adminDeleteConfig(primary_key);
      } else if (table === "streamers") {
        const records = await backend.loadStreamers();
        const idx = records.findIndex((s) => (s.sec_uid || s.web_rid) === primary_key);
        if (idx >= 0) records.splice(idx, 1);
        await backend.saveStreamers(records);
      } else if (["history", "recordings", "logs", "notify_logs", "fudai", "fudai_history", "accounts"].includes(table)) {
        await backend.adminDeleteById(table, primary_key);
      } else {
        return res.json({ ok: false, msg: "未知表: " + table });
      }
      res.json({ ok: true, msg: "已删除" });
    } catch (e) {
      res.json({ ok: false, msg: String(e && e.message ? e.message : e) });
    }
  }));

  // ---------- 404 与错误处理 ----------
  app.use((req, res) => {
    res.status(404).json({ error: "not found" });
  });
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log("error", `${req.method} ${req.path} 异常: ${err && err.message ? err.message : err}`);
    if (res.headersSent) {
      try { res.destroy(); } catch {}
      return;
    }
    res.status(500).json({ error: String((err && err.message) || err) });
  });

  return app;
}
