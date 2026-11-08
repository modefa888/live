// 直播广场采集：对应 Python src/app/collectors/square.py
// 推荐直播（feed 完整 URL）、分区列表/房间、大类房间（categorynew SSR）、直播搜索（live/search 完整 URL）
import {
  UA_DESKTOP, UA_QQ, LIVE_SEARCH_API, PARTITION_API,
  PARTITION_NAMES, CATEGORY_TYPES,
} from "../utils/constants.js";
import { httpGetText, fetchTtwid } from "../utils/httputil.js";
import { log } from "../utils/logging.js";

const nowSec = () => Math.floor(Date.now() / 1000);

/** 从 URL query 中的浏览器参数构建匹配的 UA（a_bogus 是按浏览器 UA 生成的） */
function uaFromQuery(qs) {
  const osName = qs.get("os_name") || "X11";
  const browserName = qs.get("browser_name") || "Chrome";
  const browserVersion = qs.get("browser_version") || "127.0.0.0";
  const platform = osName === "Linux" ? "Linux x86_64" : (osName || "X11");
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) ${browserName}/${browserVersion} Safari/537.36`;
}

export const squareMixin = {
  load_square_config(cfg) {
    // 从保存的配置中加载直播广场搜索参数（重启后恢复用）
    this.square_ms_token = String(cfg.square_ms_token || "");
    this.square_a_bogus = String(cfg.square_a_bogus || "");
    this.square_cookie = String(cfg.square_cookie || "");
    this.square_feed_url = String(cfg.square_feed_url || "");
    this.square_search_url = String(cfg.square_search_url || "");
    if (this.square_a_bogus || this.square_feed_url || this.square_search_url) {
      log("info", "直播广场搜索参数已加载（a_bogus/feed URL 就绪）");
    } else {
      log("warn", "直播广场搜索参数未配置，直播搜索需在 设置→广场 中填写");
    }
  },

  async get_live_feed() {
    // 获取直播广场推荐直播（使用 square_feed_url 完整 URL）
    const url = this.square_feed_url.trim();
    if (!url) {
      return { ok: false, msg: "未配置推荐直播 URL，请在 设置→广场 中粘贴（从浏览器首页 Network 复制 webcast/feed 请求）" };
    }
    if (!url.includes("webcast/feed")) {
      return { ok: false, msg: "推荐直播 URL 不是 webcast/feed 请求，请检查设置" };
    }
    const qs = new URL(url).searchParams;
    const headers = {
      "User-Agent": uaFromQuery(qs), "Accept": "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9", "Referer": "https://live.douyin.com/",
    };
    if (this.square_cookie) {
      headers.Cookie = this.square_cookie;
    } else {
      await this._ensure_square_ttwid();
      if (this.square_ttwid) headers.Cookie = `ttwid=${this.square_ttwid}`;
    }
    let data;
    try {
      const body = await httpGetText(url, { headers, timeout: 15000 });
      data = JSON.parse(body);
    } catch (e) {
      return { ok: false, msg: `推荐直播请求失败: ${e && e.message ? e.message : e}` };
    }
    if (data.status_code !== 0) {
      return { ok: false, msg: "推荐直播被风控或 URL 失效，请从浏览器首页重新复制 feed URL" };
    }
    const items = data.data || [];
    if (!Array.isArray(items)) {
      return { ok: false, msg: "推荐直播响应格式异常，请重新获取 feed URL" };
    }
    const out = [];
    for (const it of items) {
      if (it.is_ad) continue;
      const room = it.data || {};
      const owner = room.owner || {};
      const cover = room.cover || {};
      const coverUrl = (cover && typeof cover === "object")
        ? ((cover.url_list || [""])[0])
        : String(cover || "");
      out.push({
        web_rid: String(it.web_rid || owner.web_rid || ""),
        room_id: String(room.id_str || room.id || ""),
        title: room.title || "",
        nickname: owner.nickname || "",
        sec_uid: owner.sec_uid || "",
        avatar: ((owner.avatar_thumb || {}).url_list || [""])[0],
        cover: coverUrl,
        user_count: String(room.user_count || ""),
        live: true,
      });
    }
    return {
      ok: true, list: out, updated_at: nowSec(),
      has_more: Boolean(((data.extra || {}).has_more) ?? false),
    };
  },

  async _ensure_square_ttwid() {
    // 获取并缓存广场分区请求的 ttwid（分页会话需固定同一 ttwid）
    if (!this.square_ttwid) {
      const ttwid = await fetchTtwid();
      if (ttwid) {
        this.square_ttwid = ttwid;
        log("info", "已获取直播广场 ttwid cookie");
      }
    }
  },

  async get_partition_rooms(partition = "", offset = 0, count = 20) {
    // 获取指定分区的直播间列表（复用 square_feed_url 中的 a_bogus/msToken）
    const base = this.square_feed_url.trim();
    if (!base) {
      return { ok: false, msg: "未配置推荐直播 URL，请在 设置→广场 中粘贴（从浏览器首页 Network 复制 webcast/feed 请求）" };
    }
    if (!base.includes("webcast/feed")) {
      return { ok: false, msg: "推荐直播 URL 不是 webcast/feed 请求，请检查设置" };
    }
    const baseQs = new URL(base).searchParams;
    // 保留原 URL 全部参数（含 a_bogus/msToken），仅覆盖 partition/offset/count
    const params = new URLSearchParams();
    for (const [k, v] of baseQs.entries()) params.append(k, v);
    params.set("count", String(count));
    params.set("offset", String(offset));
    if (partition) {
      params.set("partition", String(partition));
      params.set("partition_type", "1");
    }
    params.set("req_from", "1");
    const url = `${PARTITION_API}?${params.toString()}`;
    const headers = {
      "User-Agent": uaFromQuery(baseQs), "Accept": "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9", "Referer": "https://live.douyin.com/",
    };
    if (this.square_cookie) {
      headers.Cookie = this.square_cookie;
    } else {
      await this._ensure_square_ttwid();
      if (this.square_ttwid) headers.Cookie = `ttwid=${this.square_ttwid}`;
    }
    let data;
    try {
      const body = await httpGetText(url, { headers, timeout: 15000 });
      data = JSON.parse(body);
    } catch (e) {
      return { ok: false, msg: `分区请求失败: ${e && e.message ? e.message : e}` };
    }
    if (data.status_code !== 0) {
      return { ok: false, msg: "分区请求被风控或参数失效，请从浏览器重新复制 feed URL" };
    }
    const items = ((data.data || {}).data) || [];
    const out = [];
    for (const it of items) {
      if (it.is_ad) continue;
      const room = it.room || {};
      const owner = room.owner || {};
      const cover = room.cover || {};
      const coverUrl = (cover && typeof cover === "object")
        ? ((cover.url_list || [""])[0])
        : String(cover || "");
      out.push({
        web_rid: String(it.web_rid || owner.web_rid || ""),
        room_id: String(room.id_str || room.id || ""),
        title: room.title || "",
        nickname: owner.nickname || "",
        sec_uid: owner.sec_uid || "",
        avatar: ((owner.avatar_thumb || {}).url_list || [""])[0],
        cover: coverUrl,
        user_count: room.user_count_str || String(room.user_count || ""),
        live: true,
      });
    }
    return {
      ok: true, list: out, offset: Number(offset) + out.length,
      has_more: out.length >= Number(count), updated_at: nowSec(),
    };
  },

  async get_categorynew_rooms(type_id = 4, cat_id = 0) {
    // 通过 categorynew 分类页 SSR 抓取大类（type=4，如舞蹈 105）直播间
    const headers = {
      "User-Agent": UA_DESKTOP, "Accept": "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9", "Referer": "https://live.douyin.com/",
    };
    if (this.square_cookie) {
      headers.Cookie = this.square_cookie;
    } else {
      await this._ensure_square_ttwid();
      if (this.square_ttwid) headers.Cookie = `ttwid=${this.square_ttwid}`;
    }
    let body;
    try {
      body = await httpGetText(`https://live.douyin.com/categorynew/${type_id}_${cat_id}`, {
        headers, timeout: 15000,
      });
    } catch (e) {
      return { ok: false, msg: `分类页抓取失败: ${e && e.message ? e.message : e}` };
    }
    const marks = [...body.matchAll(/\\"web_rid\\":\\"(\d+)\\"/g)];
    const out = [];
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i];
      const s = m.index;
      // 每个房间取其 web_rid 之前到上一个 web_rid 之后的片段（正好一个房间对象）
      const seg = body.slice(i > 0 ? marks[i - 1].index + marks[i - 1][0].length : Math.max(0, s - 7000), s);

      const f = (pat) => {
        const mm = seg.match(pat);
        return mm ? mm[1] : "";
      };

      out.push({
        web_rid: m[1],
        room_id: f(/\\"id_str\\":\\"(\d+)\\"/),
        title: "",
        nickname: f(/\\"nickname\\":\\"((?:[^\\"]|\\.)*?)\\"/),
        sec_uid: "",
        avatar: f(/\\"avatar_thumb\\":\{\\"url_list\\":\[\\"([^\\"]+)\\"/),
        cover: "",
        user_count: f(/\\"user_count_str\\":\\"([^\\"]*)\\"/),
        live: true,
      });
    }
    if (!out.length) {
      return { ok: false, msg: "分类页暂无直播间（或 SSR 解析失败，可稍后重试）" };
    }
    return { ok: true, list: out, offset: out.length, has_more: false, updated_at: nowSec() };
  },

  async get_partition_list() {
    // 动态获取分区列表（从 live.douyin.com 首页 SSR 解析），1 小时缓存
    const now = Date.now() / 1000;
    if (this._partition_list_cache && now - this._partition_list_cache[0] < 3600) {
      return this._partition_list_cache[1];
    }
    const headers = {
      "User-Agent": UA_DESKTOP, "Accept": "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9", "Referer": "https://live.douyin.com/",
    };
    if (this.square_cookie) {
      headers.Cookie = this.square_cookie;
    } else {
      await this._ensure_square_ttwid();
      if (this.square_ttwid) headers.Cookie = `ttwid=${this.square_ttwid}`;
    }
    const parts = new Map(); // 用 Map 保持插入顺序（等价 Python dict）
    let fallback = false;
    try {
      const body = await httpGetText("https://live.douyin.com/", { headers, timeout: 15000 });
      // SSR 中分区数据为转义 JSON：\"partition\":{\"id_str\":\"1010017\",\"type\":1,\"title\":\"无畏契约\"}
      for (const m of body.matchAll(/\\"partition\\":\{\\"id_str\\":\\"(\d+)\\",\\"type\\":\d+,\\"title\\":\\"([^\\"]+)\\"/g)) {
        if (/^1010\d{3}$/.test(m[1])) {
          parts.set(Number(m[1]), m[2]);
        }
      }
    } catch (e) {
      log("warn", `分区列表 SSR 解析失败: ${e && e.message ? e.message : e}`);
    }
    if (!parts.size) {
      log("warn", "分区列表 SSR 解析为空，回退到内置映射表");
      for (const [k, v] of Object.entries(PARTITION_NAMES)) {
        parts.set(Number(k), v);
      }
      fallback = true;
    }
    let out = [...parts.entries()].map(([k, v]) => ({ id: k, name: v, type: 1 }));
    // 8 大类排在游戏子分区前面，type=4 走 categorynew 抓取
    out = Object.entries(CATEGORY_TYPES).map(([cid, cname]) => ({ id: Number(cid), name: cname, type: 4 })).concat(out);
    const res = { ok: true, partitions: out, dynamic: !fallback, updated_at: Math.floor(now) };
    this._partition_list_cache = [now, res];
    return res;
  },

  async search_live(keyword, limit = 20) {
    // 直播搜索（优先使用 square_search_url 完整 URL；否则用 square_ms_token/a_bogus 拼装）
    let ua = UA_QQ;
    let url = this.square_search_url.trim();
    if (url) {
      if (!url.includes("live/search")) {
        return { ok: false, msg: "直播搜索 URL 不是 live/search 请求，请检查设置" };
      }
      // 保留原 URL 全部参数（含 a_bogus/msToken/verifyFp/fp），仅覆盖 keyword/offset/count
      const u = new URL(url);
      const qs = u.searchParams;
      qs.set("keyword", keyword);
      qs.set("offset", "0");
      qs.set("count", String(limit));
      url = `${u.origin}${u.pathname}?${qs.toString()}`;
      ua = uaFromQuery(qs);
    } else {
      const fms = this.square_ms_token;
      const fbg = this.square_a_bogus;
      if (!(fms && fbg)) {
        return { ok: false, msg: "直播搜索需要 a_bogus/msToken 或完整搜索 URL，请在 设置→广场 中填写（从抖音直播搜索请求抓取）" };
      }
      const params = new URLSearchParams([
        ["aid", "6383"], ["app_name", "douyin_web"], ["live_id", "1"],
        ["device_platform", "web"], ["language", "zh-CN"],
        ["keyword", keyword], ["search_channel", "aweme_live"],
        ["search_source", "normal_search"], ["query_correct_type", "1"],
        ["offset", "0"], ["count", String(limit)], ["msToken", fms], ["a_bogus", fbg],
      ]);
      url = `${LIVE_SEARCH_API}?${params.toString()}`;
    }
    const headers = {
      "User-Agent": ua, "Accept": "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9",
      "Referer": "https://www.douyin.com/search/" + encodeURIComponent(keyword),
    };
    if (this.square_cookie) {
      headers.Cookie = this.square_cookie;
    } else if (this.fudai_cookie) {
      // 直播搜索需登录态，square_cookie 未配置时回退用福袋 Cookie（同域登录态）
      headers.Cookie = this.fudai_cookie;
    }
    let data;
    try {
      const body = await httpGetText(url, { headers, timeout: 15000 });
      data = JSON.parse(body);
    } catch (e) {
      return { ok: false, msg: `直播搜索请求失败: ${e && e.message ? e.message : e}` };
    }
    if (data.status_code !== 0) {
      const msg = (data.status_msg || "").trim();
      return { ok: false, msg: `直播搜索被风控或参数失效（${msg || "status_code=" + data.status_code}），请从直播搜索请求重新抓取 a_bogus/msToken 并在 设置→广场 更新` };
    }
    // 兼容两种响应格式：
    // 旧格式 data.data = [{room/live_room: {...}}, ...]；新格式 data.data = [{lives: {rawdata: "房间JSON"}}, ...] 或 data.data 直接为列表
    let rawItems = data.data || [];
    if (rawItems && typeof rawItems === "object" && !Array.isArray(rawItems)) {
      rawItems = rawItems.data || [];
    }
    if (!Array.isArray(rawItems) || !rawItems.length) {
      return { ok: false, msg: "没有找到相关直播间（或 a_bogus 已失效，请更新）" };
    }
    const out = [];
    for (const it of rawItems) {
      let room = null;
      if (it && typeof it === "object") {
        // 新格式：块内 lives.rawdata 为房间 JSON 字符串
        const lives = it.lives;
        if (lives && typeof lives === "object" && lives.rawdata) {
          try {
            room = JSON.parse(lives.rawdata);
          } catch {
            room = null;
          }
        }
        if (!room) {
          room = it.room || it.live_room || {};
        }
      }
      if (!room || typeof room !== "object") continue;
      const owner = room.owner || {};
      const cover = room.cover || {};
      const coverUrl = (cover && typeof cover === "object")
        ? ((cover.url_list || [""])[0])
        : String(cover || "");
      out.push({
        web_rid: String(owner.web_rid || room.web_rid || ""),
        room_id: String(room.id_str || room.id || ""),
        title: room.title || "",
        nickname: owner.nickname || "",
        sec_uid: owner.sec_uid || "",
        avatar: ((owner.avatar_thumb || {}).url_list || [""])[0],
        cover: coverUrl,
        user_count: room.user_count_str || String(room.user_count || ""),
        live: room.status === 2,
      });
    }
    return { ok: true, list: out, updated_at: nowSec() };
  },
};
