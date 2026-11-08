// Vercel Serverless 入口：把 Express 应用导出为 Serverless Function
// - MongoDB 连接与运行时在实例生命周期内缓存（热实例复用，冷启动重建）
// - 不启动常驻监控线程；定时刷新由 Vercel Cron 调用 /api/cron/refresh 完成
// - 本地磁盘不可持久化：录制 / 本地备份在 Vercel 上不可用
import { getBackend } from "../src/db/mongo.js";
import { loadConfig } from "../src/utils/config.js";
import { setLogPersister } from "../src/utils/logging.js";
import { setGlobalProxy } from "../src/utils/httputil.js";
import { DouyinClient } from "../src/collectors/client.js";
import { Recorder } from "../src/monitor/recorder.js";
import { Monitor } from "../src/monitor/monitor.js";
import { Notifier } from "../src/monitor/notifier.js";
import { State, createApp } from "../src/web/server.js";

let cached = null;

async function getRuntime() {
  if (cached) return cached;
  const backend = getBackend();
  await backend.connect();
  setLogPersister((level, msg, secUid, webRid, eventType) => {
    backend.saveLog(level, msg, secUid, webRid, eventType).catch(() => {});
  });
  const cfg = await loadConfig();
  cfg.storage_backend = "mongodb";
  setGlobalProxy(cfg.proxy || "");
  const streamers = await backend.loadStreamers();
  const state = new State();
  state.config = cfg;
  state.streamers = streamers;
  const client = new DouyinClient(cfg.cookie || "");
  client.load_fudai_config(cfg);
  client.load_square_config(cfg);
  const recorder = new Recorder(cfg); // Vercel 无 ffmpeg，录制接口会返回失败
  const notifier = new Notifier(cfg);
  const monitor = new Monitor(client, state.streamers, cfg, recorder, () => {}, notifier);
  const app = createApp(state, { client, recorder, notifier, monitor });
  cached = { app };
  return cached;
}

export default async function handler(req, res) {
  try {
    const { app } = await getRuntime();
    return app(req, res);
  } catch (e) {
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
}
