// 通用工具：对应 Python utils.py 的 RoomInfo / FudaiInfo / status_label / 输入解析等
import { UA_MOBILE } from "./constants.js";
import { fetch as undiciFetch } from "undici";

/**
 * 把抖音返回的「在线人数」转成数值，供曲线图统计/绘制使用。
 * 支持："1.2万" → 12000、"3,456" → 3456、"2.3w" → 23000、"1.5亿" → 150000000、纯数字。
 * 无法识别时返回 null（调用方跳过该采样点）。
 */
export function parseCount(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
  const s = String(v).trim().replace(/[,，\s]/g, "");
  const m = s.match(/^(\d+(?:\.\d+)?)([万wW千kK亿]?)/);
  if (!m) return null;
  const unit = m[2].toLowerCase();
  const factor = { "万": 1e4, w: 1e4, "千": 1e3, k: 1e3, "亿": 1e8 }[unit] || 1;
  const n = parseFloat(m[1]) * factor;
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

// ---------- RoomInfo ----------
export class RoomInfo {
  constructor() {
    this.live = false;
    this.status = null;
    this.title = "";
    this.cover = "";
    this.user_count = "";
    this.user_count_exact = null;  // 未经分档的精确在线人数（number），取不到时为 null
    this.total_user = "";
    this.like_count = 0;
    this.streams = [];
    this.owner_nickname = "";
    this.owner_sec_uid = "";
    this.owner_id = "";          // 主播数字 UID（anchor_id）
    this.owner_avatar = "";
    this.web_rid = "";
    this.id_str = "";
    this.create_time = null;
    this.error = null;
    this.updated_at = Math.floor(Date.now() / 1000);
    this.gift_draw = null;       // 福袋数据（原始，由 API 返回时携带）
  }

  toDict() {
    return {
      live: this.live,
      status: this.status,
      status_label: statusLabel(this.status, this.live),
      title: this.title,
      cover: this.cover,
      user_count: this.user_count,
      user_count_exact: this.user_count_exact,
      total_user: this.total_user,
      like_count: this.like_count,
      streams: this.streams,
      owner_nickname: this.owner_nickname,
      owner_sec_uid: this.owner_sec_uid,
      owner_id: this.owner_id,
      owner_avatar: this.owner_avatar,
      web_rid: this.web_rid,
      id_str: this.id_str,
      create_time: this.create_time,
      error: this.error,
      updated_at: this.updated_at,
      gift_draw: this.gift_draw,
    };
  }
}

// ---------- FudaiInfo ----------
export class FudaiInfo {
  constructor() {
    this.has_fudai = false;
    this.draw_id = "";
    this.gift_id = "";
    this.gift_name = "";
    this.gift_image = "";
    this.gift_count = 0;
    this.lucky_count = 0;       // 中奖名额
    this.candidate_num = 0;     // 参与人数
    this.remain_seconds = 0;
    this.total_seconds = 0;
    this.draw_time = 0;         // 开奖时间戳
    this.status = 0;
    this.conditions = [];       // 参与条件列表
    this.updated_at = 0;
    this.method = "";           // lottery+tokens / lottery+no-token / reflow / check_user_right
    this.user_right = null;
    this.right_detail = null;
  }

  toDict() {
    return {
      has_fudai: this.has_fudai,
      draw_id: this.draw_id,
      gift_id: this.gift_id,
      gift_name: this.gift_name,
      gift_image: this.gift_image,
      gift_count: this.gift_count,
      lucky_count: this.lucky_count,
      candidate_num: this.candidate_num,
      remain_seconds: this.remain_seconds,
      total_seconds: this.total_seconds,
      draw_time: this.draw_time,
      status: this.status,
      conditions: this.conditions,
      updated_at: this.updated_at,
      method: this.method,
      user_right: this.user_right,
      right_detail: this.right_detail,
    };
  }
}

export function statusLabel(status, live = null) {
  if (live || status === 2) return "直播中";
  if (status === 4) return "已结束";
  if (status === 0) return "未开播";
  return "未知";
}

// ---------- 输入解析 ----------
export const SEC_UID_RE = /MS4wLjAB[A-Za-z0-9_-]+/;

// 对应 Python unescape_ssr（\uXXXX 转义还原）
export function unescapeSSR(s) {
  if (typeof s === "string" && s.includes("\\u")) {
    try {
      return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    } catch {}
  }
  return s;
}

export function extractUrl(text) {
  const m = String(text || "").match(/https?:\/\/[^\s"'<>]+/);
  return m ? m[0] : String(text || "").trim();
}

/**
 * 解析用户输入，返回 { type, web_rid, sec_uid, room_id, nickname, unique_id, avatar, error }
 * client 用于 API 调用。对应 Python resolve_input。
 */
export async function resolveInput(text, client) {
  text = (text || "").trim();
  const out = { type: "unknown", web_rid: "", sec_uid: "", room_id: "",
                nickname: "", unique_id: "", avatar: "", error: "" };
  if (!text) {
    out.error = "输入为空";
    return out;
  }
  const raw = extractUrl(text);
  const lowered = raw.toLowerCase();

  // ① 直播间链接 / 纯直播间号路径
  let m = lowered.match(/(?:live\.douyin\.com|douyin\.com\/follow\/live|douyin\.com\/root\/live)\/(\d{6,})/);
  if (m) {
    out.type = "room";
    out.web_rid = m[1];
    try {
      const info = await client.get_room(out.web_rid);
      if (info && info.owner_nickname) {
        out.nickname = info.owner_nickname;
        out.avatar = info.owner_avatar;
        out.sec_uid = info.owner_sec_uid;
      }
    } catch {}
    return out;
  }

  // ② reflow 回放链接
  m = lowered.match(/reflow\/(\d{8,})/);
  const sec1 = raw.match(SEC_UID_RE);
  if (m) {
    out.type = "reflow";
    out.room_id = m[1];
    out.sec_uid = sec1 ? sec1[0] : "";
    if (out.sec_uid) {
      try {
        const [info, webRid] = await client.reflow(out.room_id, out.sec_uid);
        if (info) {
          out.web_rid = webRid;
          out.nickname = info.owner_nickname;
          out.avatar = info.owner_avatar;
        }
      } catch {}
    }
    if (!out.web_rid) {
      out.error = "reflow 未能解析出直播间号";
    }
    return out;
  }

  // ③ v.douyin.com 短链：跟随重定向后递归解析
  if (lowered.includes("v.douyin.com/")) {
    try {
      const res = await undiciFetch(raw, {
        headers: { "User-Agent": UA_MOBILE },
        redirect: "follow",
        signal: AbortSignal.timeout(15000),
      });
      try { await res.arrayBuffer(); } catch {}
      return resolveInput(res.url, client);
    } catch (e) {
      out.type = "shortlink";
      out.error = `短链解析失败: ${e && e.message ? e.message : e}`;
      return out;
    }
  }

  // ④ sec_uid / 主页链接
  const sec2 = raw.match(SEC_UID_RE);
  if (sec2 || lowered.includes("douyin.com/user/")) {
    let secUid = sec2 ? sec2[0] : "";
    if (!secUid) {
      const m2 = lowered.match(/douyin\.com\/user\/([^/?]+)/);
      if (m2) secUid = m2[1];
    }
    if (secUid) {
      out.type = "user";
      out.sec_uid = secUid;
      const prof = await client.get_profile(secUid);
      if (prof.ok) {
        out.nickname = prof.nickname;
        out.unique_id = prof.unique_id;
        out.avatar = prof.avatar;
      } else {
        out.error = prof.error;
      }
      const m3 = raw.match(/[?&]room_id=(\d+)/);
      if (m3) {
        try {
          const [, webRid] = await client.reflow(m3[1], secUid);
          if (webRid) out.web_rid = webRid;
        } catch {}
      }
      return out;
    }
  }

  // ⑤ 纯 6-14 位数字
  if (/^\d{6,14}$/.test(raw)) {
    out.type = "room";
    out.web_rid = raw;
    return out;
  }

  out.error = `无法识别「${text.slice(0, 20)}」, 请粘贴直播间链接、分享链接或主播主页链接`;
  return out;
}
