// 配置管理模块：对应 Python src/app/utils/config.py
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_CONFIG, BASE_DIR } from "./constants.js";
import { log } from "./logging.js";
import { getBackend } from "../db/mongo.js";

export async function loadConfig() {
  // 从数据库加载配置，若无则返回默认值
  const backend = getBackend();
  return backend.loadConfig(DEFAULT_CONFIG);
}

export async function saveConfig(cfg) {
  const backend = getBackend();
  await backend.saveConfig(cfg);
}

function loadLegacyJson(filePath, defaultValue) {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return defaultValue;
  }
}

/** 将旧版 JSON 配置和监控列表迁移到当前后端（对应 migrate_legacy） */
export async function migrateLegacy() {
  const legacyConfigFile = path.join(BASE_DIR, "douyin_config.json");
  const legacyWatchlistFile = path.join(BASE_DIR, "douyin_watchlist.json");
  const backend = getBackend();

  if (!(await backend.hasConfig()) && existsSync(legacyConfigFile)) {
    const legacyCfg = loadLegacyJson(legacyConfigFile, {});
    if (legacyCfg && typeof legacyCfg === "object" && !Array.isArray(legacyCfg)) {
      const cfgToMigrate = { ...DEFAULT_CONFIG, ...legacyCfg };
      await saveConfig(cfgToMigrate);
      log("info", "已将旧版 douyin_config.json 迁移到后端");
    }
  }

  if (!(await backend.hasStreamers()) && existsSync(legacyWatchlistFile)) {
    const legacyStreamers = loadLegacyJson(legacyWatchlistFile, []);
    if (Array.isArray(legacyStreamers)) {
      await backend.saveStreamers(legacyStreamers);
      log("info", "已将旧版 douyin_watchlist.json 迁移到后端");
    }
  }
}
