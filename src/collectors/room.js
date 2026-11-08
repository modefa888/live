// 直播间信息采集：对应 Python src/app/collectors/room.py
// enter 接口（按 web_rid 查询）与 reflow 接口（按 room_id 查询）
import {
  ENTER_API, REFLOW_API, VERIFY_FP,
  QUALITY_ORDER, QUALITY_LABEL,
} from "../utils/constants.js";
import { RoomInfo } from "../utils/misc.js";
import { httpGetText } from "../utils/httputil.js";

const nowSec = () => Math.floor(Date.now() / 1000);

/** 去重保序：等价于 Python list(dict.fromkeys([...])) */
function dedupeKeepOrder(arr) {
  return [...new Set(arr)];
}

export const roomMixin = {
  async get_room(web_rid) {
    const info = new RoomInfo();
    info.web_rid = String(web_rid).trim();
    await this.refresh_session();
    const params = new URLSearchParams([
      ["aid", "6383"], ["app_name", "douyin_web"], ["live_id", "1"],
      ["device_platform", "web"], ["language", "zh-CN"],
      ["browser_language", "zh-CN"], ["browser_platform", "Win32"],
      ["browser_name", "Chrome"], ["browser_version", "116.0.0.0"],
      ["web_rid", info.web_rid], ["room_id_str", info.web_rid],
    ]);
    const url = `${ENTER_API}?${params.toString()}`;
    let data = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const body = await httpGetText(url, {
          headers: this.headers({ referer: `https://live.douyin.com/${info.web_rid}` }),
          timeout: 15000,
          secUid: "",
          webRid: info.web_rid,
        });
        data = JSON.parse(body);
        break;
      } catch (e) {
        if (attempt === 1) {
          info.error = `请求直播间接口失败: ${e && e.message ? e.message : e}`;
          return info;
        }
        await this.refresh_session(true);
      }
    }
    try {
      const sc = data.status_code;
      const rooms = ((data.data || {}).data) || [];
      if (sc !== 0 || !rooms.length) {
        const d = data.data || {};
        const detail = d.message || d.prompts || "";
        const detailS = String(detail);
        // room has finished / 已结束 表示直播间已下播，属于正常业务状态，按"已结束"处理
        if (detailS.includes("has finished") || detailS.includes("已结束")) {
          info.status = 4;
        } else if (detailS.includes("服务繁忙") || detailS.includes("参数") || !(sc === 0 || sc === null || sc === undefined)) {
          info.error = `接口返回异常(status_code=${sc}): ${detail}`;
        } else {
          info.status = 0;
        }
        return info;
      }
      const room = rooms[0];
      this._parse_room(room, info);
      return info;
    } catch (e) {
      info.error = `解析直播间信息失败: ${e && e.message ? e.message : e}`;
      return info;
    }
  },

  _parse_room(room, info) {
    info.status = room.status;
    info.live = info.status === 2;
    info.title = room.title || "";
    info.id_str = room.id_str || "";
    const cover = room.cover || {};
    const urls = cover.url_list || [];
    info.cover = urls.length ? urls[0] : "";
    info.user_count = room.user_count_str || "";
    info.like_count = room.like_count || 0;
    const stats = room.stats || {};
    info.total_user = stats.total_user_str || "";
    if (!info.user_count) {
      info.user_count = String(stats.user_count_str || "");
    }
    const owner = room.owner || {};
    info.owner_nickname = owner.nickname || "";
    info.owner_sec_uid = owner.sec_uid || "";
    info.owner_id = owner.id_str || "";
    const av = owner.avatar_thumb || {};
    const avu = av.url_list || [];
    info.owner_avatar = avu.length ? avu[0] : "";
    const su = room.stream_url || {};
    let flvMap = su.flv_pull_url || {};
    let hlsMap = su.hls_pull_url_map || {};
    if (typeof flvMap === "string") flvMap = { [info.web_rid]: flvMap };
    if (typeof hlsMap === "string") hlsMap = { [info.web_rid]: hlsMap };
    const keys = dedupeKeepOrder([...QUALITY_ORDER, ...Object.keys(flvMap), ...Object.keys(hlsMap)]);
    info.streams = [];
    for (const k of keys) {
      const flv = typeof flvMap === "object" ? flvMap[k] : null;
      const hls = typeof hlsMap === "object" ? hlsMap[k] : null;
      if (!flv && !hls) continue;
      info.streams.push({
        key: k,
        label: QUALITY_LABEL[k] || k,
        flv: flv || "",
        hls: hls || "",
      });
    }
    // 提取福袋数据（API 返回时可能携带）
    const gd = room.gift_draw || room.giftDraw || room.lucky_money || room.luckyMoney;
    if (gd) {
      info.gift_draw = (gd && typeof gd === "object" && !Array.isArray(gd)) ? gd : { data: gd };
    }
  },

  async reflow(room_id, sec_user_id) {
    const info = new RoomInfo();
    const params = new URLSearchParams([
      ["verifyFp", VERIFY_FP], ["type_id", "0"], ["live_id", "1"],
      ["room_id", String(room_id)], ["sec_user_id", sec_user_id], ["app_id", "1128"],
    ]);
    const url = `${REFLOW_API}?${params.toString()}`;
    let data = null;
    try {
      const body = await httpGetText(url, {
        headers: this.headers({ referer: "https://www.iesdouyin.com/", mobile: true }),
        timeout: 15000,
        secUid: sec_user_id,
        webRid: "",
      });
      data = JSON.parse(body);
    } catch (e) {
      info.error = `reflow 请求失败: ${e && e.message ? e.message : e}`;
      return [info, ""];
    }
    let room;
    try {
      room = data.data.room;
      if (!room) throw new Error("no room");
    } catch {
      info.error = `reflow 未返回房间: ${String((data.data || "")).slice(0, 100)}`;
      return [info, ""];
    }
    info.status = room.status;
    info.live = info.status === 2;
    info.title = room.title || "";
    info.id_str = room.id_str || String(room.id || "");
    info.user_count = String(room.user_count || "");
    info.create_time = room.create_time;
    const cover = room.cover || {};
    if (typeof cover === "object" && cover !== null) {
      const list = cover.url_list || [""];
      info.cover = list[0] || "";
    } else if (typeof cover === "string") {
      info.cover = cover;
    }
    const owner = room.owner || {};
    info.owner_nickname = owner.nickname || "";
    info.owner_sec_uid = owner.sec_uid || "";
    info.owner_id = owner.id_str || "";
    const av = owner.avatar_thumb || {};
    const avu = av.url_list || [];
    info.owner_avatar = avu.length ? avu[0] : "";
    info.web_rid = String(owner.web_rid || "");
    const su = room.stream_url || {};
    if (typeof su === "object" && su !== null) {
      let flvMap = su.flv_pull_url || {};
      let hlsMap = su.hls_pull_url_map || {};
      if (typeof flvMap === "string") flvMap = { [info.web_rid || "FULL_HD1"]: flvMap };
      if (typeof hlsMap === "string") hlsMap = { [info.web_rid || "FULL_HD1"]: hlsMap };
      const keys = dedupeKeepOrder([...QUALITY_ORDER, ...Object.keys(flvMap), ...Object.keys(hlsMap)]);
      info.streams = [];
      for (const k of keys) {
        const flv = typeof flvMap === "object" ? flvMap[k] : null;
        const hls = typeof hlsMap === "object" ? hlsMap[k] : null;
        if (!flv && !hls) continue;
        info.streams.push({
          key: k, label: QUALITY_LABEL[k] || k,
          flv: flv || "", hls: hls || "",
        });
      }
    }
    // 提取福袋数据（reflow API 特有字段）
    const lmNum = Number(room.luckymoney_num) || 0;
    const lft = Number(room.lottery_finish_time) || 0;
    if (lmNum > 0) {
      info.gift_draw = {
        has_fudai: true,
        gift_count: lmNum,
        lottery_finish_time: lft,
        remain_seconds: lft > 0 ? Math.max(0, lft - nowSec()) : 0,
      };
    }
    return [info, info.web_rid];
  },
};
