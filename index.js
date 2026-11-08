#!/usr/bin/env node
// 程序入口：对应 Python main.py
import fs from "node:fs";
import {
  APP_NAME, DEFAULT_PORT, getLanIp, MONGO_URI, MONGO_DB,
} from "./src/utils/constants.js";
import { getBackend } from "./src/db/mongo.js";
import { loadConfig, saveConfig, migrateLegacy } from "./src/utils/config.js";
import { setLogPersister, log } from "./src/utils/logging.js";
import { setGlobalProxy } from "./src/utils/httputil.js";
import { DouyinClient } from "./src/collectors/client.js";
import { Recorder } from "./src/monitor/recorder.js";
import { Monitor } from "./src/monitor/monitor.js";
import { Notifier } from "./src/monitor/notifier.js";
import { State, createApp } from "./src/web/server.js";

// ---------- 命令行参数 ----------
function parseArgs() {
  const args = { port: DEFAULT_PORT, host: "0.0.0.0", noBrowser: false, dir: "" };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") args.port = parseInt(argv[++i], 10) || DEFAULT_PORT;
    else if (a === "--host") args.host = argv[++i] || "0.0.0.0";
    else if (a === "--no-browser") args.noBrowser = true;
    else if (a === "--dir") args.dir = argv[++i] || "";
  }
  return args;
}

async function main() {
  const args = parseArgs();

  // 连接 MongoDB（对应 Python 端"始终可用的 SQLite"角色）
  const backend = getBackend();
  try {
    await backend.connect();
    console.log(`MongoDB 已连接: 库名 ${MONGO_DB}`);
  } catch (e) {
    console.error(`MongoDB 连接失败: ${e && e.message ? e.message : e}`);
    console.error(`连接串: ${MONGO_URI.replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@")}`);
    console.error("请确认 mongod 已启动且账号密码正确（默认 authSource=admin）");
    process.exit(1);
  }

  // 日志持久化接入 DB
  setLogPersister((level, msg, secUid, webRid, eventType) => {
    backend.saveLog(level, msg, secUid, webRid, eventType).catch(() => {});
  });

  // 迁移旧配置
  await migrateLegacy();

  // 存储后端（Node 版固定 MongoDB）
  await backend.setStorageBackend("mongodb");
  log("info", "存储后端: MongoDB");

  // 加载配置
  const cfg = await loadConfig();
  cfg.storage_backend = "mongodb";
  if (args.dir) {
    cfg.record_dir = args.dir;
    await saveConfig(cfg);
  }
  // 确保录制目录存在
  try { fs.mkdirSync(cfg.record_dir, { recursive: true }); } catch {}

  // 设置全局代理（从配置中读取）
  setGlobalProxy(cfg.proxy || "");

  // 加载主播列表
  const streamers = await backend.loadStreamers();

  // 初始化状态
  const state = new State();
  state.config = cfg;
  state.streamers = streamers;

  // 初始化客户端、录制器、通知
  const client = new DouyinClient(cfg.cookie || "");
  client.load_fudai_config(cfg);
  client.load_square_config(cfg);
  const recorder = new Recorder(cfg);
  const notifier = new Notifier(cfg);

  // 创建监控（broadcast 为兼容空实现，与 Python 版一致）
  const monitor = new Monitor(client, streamers, cfg, recorder, () => {}, notifier);

  // 创建服务器
  const app = createApp(state, { client, recorder, notifier, monitor });
  const server = app.listen(args.port, args.host);

  // 启动监控
  monitor.start();
  // 立即刷新一次
  monitor.refresh_all(true).catch((e) => log("error", `首次刷新异常: ${e && e.message ? e.message : e}`));

  // 本机 / 局域网访问地址
  const lan_ip = getLanIp();
  const is_lan = lan_ip !== "0.0.0.0" && lan_ip !== "127.0.0.1";
  const display_ip = is_lan ? lan_ip : "127.0.0.1";
  const display_url = `http://${display_ip}:${args.port}/`;
  console.log(`\n${APP_NAME} 已启动`);
  console.log(`  本机: ${display_url}`);
  if (!is_lan) {
    console.log(`  浏览器已自动打开（可手动访问以上地址）`);
  }
  console.log();

  if (!args.no_browser) {
    try {
      const { spawn } = await import("node:child_process");
      const child = spawn("xdg-open", [display_url], { detached: true, stdio: "ignore" });
      child.unref();
    } catch {}
  }

  // 退出清理（对应 Python KeyboardInterrupt 分支）
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n正在停止...");
    try {
      monitor.stop();
      for (const sec of [...recorder.records.keys()]) {
        await recorder.stop(sec);
      }
      await getBackend().saveStreamers(state.streamers);
      await saveConfig(cfg);
      server.close();
    } catch {}
    console.log("已保存。");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("启动失败:", e);
  process.exit(1);
});
