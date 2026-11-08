// 本地备份 / 回档工具：对应 Python src/app/utils/push_github.py（进程内实现，不走子进程）
// 备份布局：.backups/<YYYYMMDD_HHMMSS>/ + .backups/<id>.meta（JSON 元数据）
import fs from "node:fs";
import path from "node:path";
import { BASE_DIR, BACKUP_DIR } from "./constants.js";

// 备份时排除的文件/目录
const EXCLUDE = new Set([
  "__pycache__", ".backups",
  "data",
  "douyin_history.db",
  "recordings",
  "venv", "node_modules",   // node_modules 对应 Python 版的 venv（虚拟环境不备份）
  "push_github.py", "backup.js",
  "douyin_config.json", "douyin_watchlist.json",
  ".DS_Store", ".git",
]);

// 回档时跳过覆盖的文件
const SKIP_FILES_ON_RESTORE = new Set([
  "douyin_history.db",
  "douyin_config.json",
  "douyin_watchlist.json",
]);

function pad(n) { return String(n).padStart(2, "0"); }

function collectFiles() {
  // 收集所有待备份文件（相对路径列表），排除目录不递归
  const files = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (EXCLUDE.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const relPath = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        walk(abs, relPath);
      } else if (e.isFile()) {
        files.push(relPath);
      }
    }
  };
  walk(BASE_DIR, "");
  return files.sort();
}

function genBackupId() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const backupPath = (bid) => path.join(BACKUP_DIR, bid);
const backupManifestPath = (bid) => path.join(BACKUP_DIR, `${bid}.meta`);

function loadManifest(bid) {
  try {
    return JSON.parse(fs.readFileSync(backupManifestPath(bid), "utf-8"));
  } catch {
    return {};
  }
}

function saveManifest(bid, meta) {
  fs.writeFileSync(backupManifestPath(bid), JSON.stringify(meta, null, 2), "utf-8");
}

/** 创建备份，返回 { id, file_count, tag } */
export function cmdBackup(tag = "") {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const bid = genBackupId();
  const bp = backupPath(bid);
  fs.mkdirSync(bp, { recursive: true });

  const files = collectFiles();
  let copied = 0;
  for (const rel of files) {
    const src = path.join(BASE_DIR, rel);
    const dst = path.join(bp, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    copied += 1;
  }

  const now = new Date();
  const meta = {
    id: bid,
    created_at: Math.floor(now.getTime() / 1000),
    created_str: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    file_count: copied,
    tag: tag || "",
    files,
  };
  saveManifest(bid, meta);
  return { id: bid, file_count: copied, tag: tag || "" };
}

/** 列出所有备份，返回 { backups: [{id, created_str, file_count, tag}] } */
export function cmdList() {
  if (!fs.existsSync(BACKUP_DIR) || !fs.statSync(BACKUP_DIR).isDirectory()) {
    return { backups: [] };
  }
  const result = [];
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    if (!f.endsWith(".meta")) continue;
    const bid = f.slice(0, -5);
    const bp = backupPath(bid);
    if (!fs.existsSync(bp) || !fs.statSync(bp).isDirectory()) continue;
    const meta = loadManifest(bid);
    result.push({
      id: bid,
      created_str: meta.created_str || bid,
      file_count: meta.file_count || 0,
      tag: meta.tag || "",
    });
  }
  result.sort((a, b) => (a.id < b.id ? 1 : -1));
  return { backups: result };
}

/** 从指定备份回档，返回 { id, restored, skipped }；备份不存在抛错 */
export function cmdRestore(bid) {
  const bp = backupPath(bid);
  if (!fs.existsSync(bp) || !fs.statSync(bp).isDirectory()) {
    throw new Error(`备份不存在: ${bid}`);
  }
  const meta = loadManifest(bid);
  const files = meta.files || [];
  if (!files.length) {
    throw new Error("备份无文件，请手动检查");
  }
  let restored = 0;
  let skipped = 0;
  for (const rel of files) {
    const src = path.join(bp, rel);
    const dst = path.join(BASE_DIR, rel);
    if (!fs.existsSync(src)) { skipped += 1; continue; }
    const base = path.basename(rel);
    if (SKIP_FILES_ON_RESTORE.has(base)) { skipped += 1; continue; }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    restored += 1;
  }
  return { id: bid, restored, skipped };
}

/** 删除备份；deleteAll=true 清空 .backups；返回 {ok, msg} 语义由调用方处理 */
export function cmdDelete(bid = null, deleteAll = false) {
  if (deleteAll) {
    if (!fs.existsSync(BACKUP_DIR)) {
      throw new Error("无备份可删除");
    }
    fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
    return;
  }
  if (!bid) {
    throw new Error("请指定备份 ID 或使用 --all");
  }
  const bp = backupPath(bid);
  const mp = backupManifestPath(bid);
  if (!fs.existsSync(bp) && !fs.existsSync(mp)) {
    throw new Error(`备份不存在: ${bid}`);
  }
  fs.rmSync(bp, { recursive: true, force: true });
  if (fs.existsSync(mp)) fs.rmSync(mp);
}
