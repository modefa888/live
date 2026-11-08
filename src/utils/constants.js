// 常量模块：对应 Python src/app/utils/utils.py 中的常量部分
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 本文件位于 live/src/utils/，向上两级 = live/ 项目根
export const BASE_DIR = path.resolve(__dirname, "..", "..");

export const APP_NAME = "抖音直播监控";
export const DEFAULT_PORT = 8010;

export const DATA_DIR = path.join(BASE_DIR, "data");
export const LOG_DIR = path.join(DATA_DIR, "logs");
export const DEFAULT_RECORD_DIR = path.join(BASE_DIR, "recordings");
export const BACKUP_DIR = path.join(BASE_DIR, ".backups");
export const PUBLIC_DIR = path.join(BASE_DIR, "public");

export const UA_DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/116.0.5845.97 Safari/537.36 Core/1.116.567.400 QQBrowser/19.7.6764.400";
export const UA_MOBILE =
  "Mozilla/5.0 (Linux; Android 11; SAMSUNG SM-G973U) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) SamsungBrowser/14.2 Chrome/87.0.4280.141 Mobile Safari/537.36";
export const UA_QQ =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36";

export const DEFAULT_AC_COOKIES =
  "ttwid=1%7C4ejCkU2bKY76IySQENJwvGhg1IQZrgGEupSyTKKfuyk%7C1740470403%7C" +
  "bc9ad2ee341f1a162f9e27f4641778030d1ae91e31f9df6553a8f2efa3bdb7b4; " +
  "__ac_nonce=0683e59f3009cc48fbab0; " +
  "__ac_signature=_02B4Z6wo00f01mG6waQAAIDB9JUCzFb6.TZhmsUAAPBf34; " +
  "__ac_referer=__ac_blank";

export const ENTER_API = "https://live.douyin.com/webcast/room/web/enter/";
export const REFLOW_API = "https://webcast.amemv.com/webcast/room/reflow/info/";
export const LOTTERY_API = "https://live.douyin.com/webcast/lottery/melon/lottery_info/";
export const CHECK_USER_RIGHT_API = "https://live.douyin.com/webcast/lottery/melon/check_user_right/";
export const HOT_API = "https://www.douyin.com/aweme/v1/web/hot/search/list/";
export const LIVE_SEARCH_API = "https://www.douyin.com/aweme/v1/web/live/search/";
export const FEED_API = "https://live.douyin.com/webcast/feed/";
export const PARTITION_API = "https://live.douyin.com/webcast/web/partition/detail/room/v2/";

export const MS_TOKEN = process.env.MS_TOKEN || "";
export const A_BOGUS = process.env.A_BOGUS || "";
export const VERIFY_FP = "verify_lk07kv74_QZYCUApD_xhiB_405x_Ax51_GYO9bUIyZQVf";

export const QUALITY_ORDER = ["ORIGIN", "FULL_HD1", "BD", "UHD", "HD1", "SD1", "SD2", "LD"];
export const QUALITY_LABEL = {
  ORIGIN: "原画", FULL_HD1: "蓝光", BD: "蓝光", UHD: "超清",
  HD1: "高清", SD1: "标清", SD2: "流畅", LD: "极速",
};

export const ALLOWED_STREAM_HOSTS = [
  "douyincdn.com", "douyin.com", "amemv.com", "byteimg.com",
  "douyinpic.com", "douyinstatic.com", "ixigua.com", "bytedance.com",
  "douyinvod.com", "snssdk.com", "zjcdn.com", "iesdouyin.com",
];

// ---------- 默认配置 ----------
export const DEFAULT_CONFIG = {
  interval: 60,
  cookie: "",
  notify_sound: true,
  notify_browser: true,
  record_dir: DEFAULT_RECORD_DIR,
  proxy: "",
  // ---------- 福袋参数 ----------
  fudai_ms_token: "",
  fudai_a_bogus: "",
  fudai_cookie: "",
  // ---------- 直播广场搜索参数 ----------
  square_ms_token: "",
  square_a_bogus: "",
  square_cookie: "",
  square_feed_url: "",
  square_search_url: "",
  // ---------- 第三方通知（Telegram / Email / Webhook）----------
  tg_bot_token: "",
  tg_chat_ids: "",
  tg_proxy: "",
  email_enabled: false,
  email_smtp: "",
  email_port: "465",
  email_user: "",
  email_pass: "",
  email_from: "",
  email_to: "",
  email_subject_prefix: "抖音直播",
  email_subject_template: "[{prefix}] {nickname} {action}",
  email_body_template: "",
  webhook_url: "",
  notify_events: "live_start,live_end,fudai_start",
  storage_backend: "mongodb", // 存储固定为 MongoDB
};

// ---------- MongoDB ----------
// 连接串优先级：环境变量 MONGO_URI > config.local.json（git 忽略，本地开发用）> 本机默认值
// 不要把真实密码提交到仓库！本地开发请在 config.local.json 里配置 mongoUri。
function loadLocalConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(BASE_DIR, "config.local.json"), "utf-8"));
  } catch {
    return {};
  }
}
const LOCAL_CONFIG = loadLocalConfig();

export const MONGO_URI =
  process.env.MONGO_URI ||
  LOCAL_CONFIG.mongoUri ||
  "mongodb://127.0.0.1:27017/?authSource=admin";
export const MONGO_DB = process.env.MONGO_DB || LOCAL_CONFIG.mongoDb || "live";

// ---------- 分区名（分区列表 SSR 解析失败的回退表，与 Python square.py PARTITION_NAMES 一致）----------
export const PARTITION_NAMES = {
  1010001: "三角洲行动", 1010002: "FPS枪战", 1010003: "CSGO", 1010004: "JJ斗地主",
  1010005: "英雄联盟", 1010006: "明日之后", 1010007: "巅峰极速", 1010008: "星际猎人",
  1010009: "三国志战略版", 1010010: "球球大作战", 1010011: "蛋仔派对", 1010012: "乱斗竞技",
  1010013: "二次元手游", 1010014: "金铲铲乱斗", 1010015: "穿越火线CFM", 1010016: "永劫无间",
  1010017: "无畏契约", 1010018: "暗区突围", 1010019: "休闲游戏", 1010020: "崩坏",
  1010021: "率土之滨", 1010022: "我的世界", 1010023: "LOL手游", 1010024: "月圆之夜",
  1010025: "阴阳师", 1010026: "绝地求生PUBG", 1010027: "休闲娱乐", 1010028: "斗地主",
  1010029: "娱乐游戏", 1010030: "实况足球", 1010100: "方舟生存进化", 1010200: "模拟经营",
  1010300: "主机单机",
};

export const CATEGORY_TYPES = {
  101: "聊天", 102: "音乐", 103: "游戏", 104: "二次元",
  105: "舞蹈", 106: "文化", 107: "生活", 108: "运动",
};

// 获取本机局域网 IP（对应 main.py get_lan_ip，用 os.networkInterfaces 实现）
export function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const it of ifaces[name] || []) {
      // Node 18+: family 可能是数字 4/6 或字符串
      const isV4 = it.family === "IPv4" || it.family === 4;
      if (isV4 && !it.internal && it.address && !it.address.startsWith("127.")) {
        return it.address;
      }
    }
  }
  return "0.0.0.0";
}
