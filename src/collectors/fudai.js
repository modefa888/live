// 福袋采集：对应 Python src/app/collectors/fudai.py
// SSR 页面解析 → lottery_info API（带 msToken/a_bogus）→ reflow API 回退检测
import {
  LOTTERY_API, CHECK_USER_RIGHT_API, MS_TOKEN, A_BOGUS, VERIFY_FP,
} from "../utils/constants.js";
import { FudaiInfo } from "../utils/misc.js";
import { httpGetText } from "../utils/httputil.js";
import { log } from "../utils/logging.js";

const nowSec = () => Math.floor(Date.now() / 1000);

export const fudaiMixin = {
  load_fudai_config(cfg) {
    // 从保存的配置中加载福袋参数（重启后恢复用）
    this.fudai_ms_token = String(cfg.fudai_ms_token || process.env.MS_TOKEN || "");
    this.fudai_a_bogus = String(cfg.fudai_a_bogus || process.env.A_BOGUS || "");
    this.fudai_cookie = String(cfg.fudai_cookie || "");
    if (this.fudai_cookie) {
      log("info", `福袋 Cookie 已加载（${this.fudai_cookie.length} 字符）`);
    } else {
      log("warn", "福袋 Cookie 未配置，福袋检测可能失败");
    }
  },

  _fudai_headers(web_rid = null) {
    // 福袋 lottery_info API 专用 Headers（与用户提供的 curl 一致）
    const h = {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9",
      "Accept-Encoding": "identity",
      "Priority": "u=1, i",
      "Sec-Ch-Ua": '"Chromium";v="127", "Not)A;Brand";v="99"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Linux"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    };
    if (web_rid) {
      h.Referer = `https://live.douyin.com/${web_rid}?from_search=true`;
    }
    // Cookie：优先使用福袋专用 cookie，否则用主 cookie
    let cookie = this.fudai_cookie || this.cookie || this.ttwid;
    if (cookie) {
      if (!/^[A-Za-z_]\w*=/.test(cookie.replace(/^\s+/, ""))) {
        cookie = "ttwid=" + cookie;
      }
      h.Cookie = cookie;
    }
    return h;
  },

  async get_room_fudai(web_rid, { room_id = null, sec_uid = null, anchor_id = null, force = false } = {}) {
    // 通过 SSR 页面→lottery_info API 检测福袋信息，60s 缓存
    const info = new FudaiInfo();
    const now = Date.now() / 1000;
    // 0. 检查缓存（60s 有效）
    if (!force && this._fudai_cache.has(web_rid)) {
      const [ts, cached] = this._fudai_cache.get(web_rid);
      if (now - ts < 60) return cached;
    }

    // 1. 获取 room_id 和 sec_uid（从 SSR 页面一次解析）
    // 注意：与 Python 源码一致，这里无条件重置 anchor_id（保留原怪癖）
    anchor_id = null;
    if (!room_id || !sec_uid) {
      const [ssrRoomId, ssrSecUid, ssrAnchorId] = await this._parse_ssr(web_rid);
      if (!room_id) room_id = ssrRoomId;
      if (!sec_uid) sec_uid = ssrSecUid;
      if (!anchor_id) anchor_id = ssrAnchorId;
      if (!room_id) return info;
    }

    // 2. 调用 lottery_info API（默认参数来自用户提供的 curl）
    let lottery_data = null;
    let lottery_method = ""; // "tokens" / "no-token"
    // 优先使用实例属性（来自服务端配置），其次环境变量
    const fms = this.fudai_ms_token || MS_TOKEN;
    const fbg = this.fudai_a_bogus || A_BOGUS;
    const useTokensList = [Boolean(fms && fbg), false];
    for (const use_tokens of useTokensList) {
      if (!use_tokens && lottery_data !== null) break;
      const params = new URLSearchParams([
        ["aid", "6383"], ["app_name", "douyin_web"], ["live_id", "1"],
        ["device_platform", "web"], ["language", "zh-CN"],
        ["enter_from", "web_search"],
        ["cookie_enabled", "true"],
        ["screen_width", "1920"], ["screen_height", "1080"],
        ["browser_language", "zh-CN"], ["browser_platform", "Linux+x86_64"],
        ["browser_name", "Chrome"], ["browser_version", "127.0.0.0"],
        ["os_name", "Linux"], ["os_version", "x86_64"],
        ["room_id", String(room_id)], ["query_from", "1"],
      ]);
      if (use_tokens) {
        params.append("msToken", fms);
        params.append("a_bogus", fbg);
      }
      const url = `${LOTTERY_API}?${params.toString()}`;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const body = await httpGetText(url, {
            headers: this._fudai_headers(web_rid),
            timeout: 15000,
            secUid: sec_uid || "",
            webRid: web_rid,
          });
          if (body) {
            lottery_data = JSON.parse(body);
            lottery_method = use_tokens ? "tokens" : "no-token";
            break;
          }
          // 返回空 = 无福袋，正常行为，不输出
          break;
        } catch (e) {
          if (attempt === 1) {
            log("warn", `福袋检测 ${web_rid}: lottery 请求失败 ${e && e.message ? e.message : e}`);
          } else {
            await this.refresh_session(true);
          }
        }
      }
    }

    // 3. 解析 lottery 响应
    if (lottery_data) {
      const respData = lottery_data.data || {};
      const li = (respData && typeof respData === "object") ? respData.lottery_info : null;
      if (li && typeof li === "object" && (Number(li.status) || 0) === 1) {
        info.has_fudai = true;
        info.draw_id = String(li.lottery_id || li.lottery_id_str || "");
        const prize = li.prize_info || {};
        info.gift_name = String(prize.name || "福袋");
        info.gift_image = String(prize.image || "");
        info.gift_count = Number(li.prize_count) || 0;
        info.lucky_count = Number(li.lucky_count) || 0;
        info.candidate_num = Number(li.candidate_num) || 0;
        info.draw_time = Number(li.draw_time) || 0;
        info.conditions = (li.conditions || []).map((c) => String((c && c.description) ?? ""));
        const cd = Number(li.count_down) || 0;
        if (cd > 0) {
          info.remain_seconds = cd;
        } else {
          const dt = Number(li.draw_time) || 0;
          const ct = Number(li.current_time) || 0;
          if (dt > ct) info.remain_seconds = dt - ct;
        }
        info.updated_at = Math.floor(now);
        info.method = `lottery+${lottery_method}`;
        // 补充：查询当前账号参与福袋资格（尽力而为，不影响主流程）
        if (anchor_id && info.draw_id) {
          try {
            const rightData = await this.check_fudai_right(info.draw_id, room_id, anchor_id, web_rid);
            if (rightData) {
              info.user_right = rightData.user_condition || {};
              info.right_detail = rightData;
            }
          } catch (e) {
            log("warn", `福袋参与资格查询失败 ${web_rid}: ${e && e.message ? e.message : e}`);
          }
        }
        log("info", `福袋检测成功 ${web_rid}[${info.method}]: ${info.gift_name}，剩余${info.remain_seconds}s`);
        this._fudai_cache.set(web_rid, [now, info]);
        return info;
      }
    }

    // 4. 回退：reflow API 检测
    if (sec_uid) {
      const reflowFd = await this._get_fudai_from_reflow(web_rid, room_id, sec_uid);
      if (reflowFd.has_fudai) {
        reflowFd.gift_name = "福袋";
        if (reflowFd.remain_seconds <= 0) reflowFd.remain_seconds = 120;
        reflowFd.updated_at = Math.floor(now);
        reflowFd.method = "reflow";
        log("info", `福袋检测成功 ${web_rid}[${reflowFd.method}]: 剩余${reflowFd.remain_seconds}s`);
        this._fudai_cache.set(web_rid, [now, reflowFd]);
        return reflowFd;
      }
    }

    this._fudai_cache.set(web_rid, [now, info]);
    return info;
  },

  async check_fudai_right(lottery_id, room_id, anchor_id, web_rid = null) {
    // 调用 check_user_right API 查询当前账号参与福袋的资格与福袋详情
    const params = new URLSearchParams([
      ["aid", "6383"], ["app_name", "douyin_web"], ["live_id", "1"],
      ["device_platform", "web"], ["language", "zh-CN"],
      ["enter_from", "web_homepage_hot"],
      ["cookie_enabled", "true"],
      ["screen_width", "1920"], ["screen_height", "1080"],
      ["browser_language", "zh-CN"], ["browser_platform", "Linux+x86_64"],
      ["browser_name", "Chrome"], ["browser_version", "127.0.0.0"],
      ["os_name", "Linux"], ["os_version", "x86_64"],
      ["lottery_id", String(lottery_id)],
      ["room_id", String(room_id)],
      ["anchor_id", String(anchor_id)],
      ["verifyFp", VERIFY_FP], ["fp", VERIFY_FP],
    ]);
    const fms = this.fudai_ms_token || MS_TOKEN;
    const fbg = this.fudai_a_bogus || A_BOGUS;
    if (fms && fbg) {
      params.append("msToken", fms);
      params.append("a_bogus", fbg);
    }
    const url = `${CHECK_USER_RIGHT_API}?${params.toString()}`;
    try {
      const body = await httpGetText(url, { headers: this._fudai_headers(web_rid), timeout: 15000 });
      if (!body) return null;
      const data = JSON.parse(body);
      const respData = data.data || {};
      if (!respData || typeof respData !== "object") return null;
      const li = respData.lottery_info || {};
      return {
        user_condition: respData.user_condition || {},
        lottery_info: (li && typeof li === "object") ? li : {},
        hit_black_list: respData.hit_black_list,
        candidate_user_num: respData.candidate_user_num,
        raw: respData,
      };
    } catch (e) {
      log("warn", `福袋参与资格查询异常: ${e && e.message ? e.message : e}`);
      return null;
    }
  },

  async _parse_ssr(web_rid) {
    // 从 SSR 页面一次解析 room_id、sec_uid 和 anchor_id
    const url = `https://live.douyin.com/${web_rid}`;
    try {
      const body = await httpGetText(url, {
        headers: this.headers({ referer: "https://live.douyin.com/" }),
        timeout: 15000,
        webRid: web_rid,
      });
      const text = body.split('\\"').join('"');
      let room_id = null;
      let sec_uid = null;
      let anchor_id = null;
      const m = text.match(/"roomInfo":\{"room":\{"id_str":"(\d+)"/);
      if (m) {
        room_id = m[1];
        log("info", `SSR页面解析room_id成功 ${web_rid}: ${room_id}`);
      }
      const m2 = text.match(/"anchor":\{"id_str":"(\d+)","sec_uid":"([^"]+)"/);
      if (m2) {
        anchor_id = m2[1];
        sec_uid = m2[2];
      }
      return [room_id, sec_uid, anchor_id];
    } catch (e) {
      log("warn", `SSR页面请求失败 ${web_rid}: ${e && e.message ? e.message : e}`);
      return [null, null, null];
    }
  },

  async _get_fudai_from_reflow(web_rid, room_id, sec_uid) {
    // 通过 reflow API 回退检测福袋
    const info = new FudaiInfo();
    try {
      const [reflowInfo] = await this.reflow(room_id, sec_uid);
      const gd = reflowInfo.gift_draw;
      if (gd && gd.has_fudai) {
        info.has_fudai = true;
        info.gift_count = Number(gd.gift_count) || 0;
        info.remain_seconds = Number(gd.remain_seconds) || 0;
      }
    } catch (e) {
      log("warn", `福袋reflow回退失败 ${web_rid}: ${e && e.message ? e.message : e}`);
    }
    return info;
  },
};
