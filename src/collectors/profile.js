// 主播信息采集：对应 Python src/app/collectors/profile.py
// 从 iesdouyin 分享页 SSR 解析主播昵称/抖音号/头像（1 小时缓存）
import { UA_MOBILE } from "../utils/constants.js";
import { unescapeSSR } from "../utils/misc.js";
import { httpGetText } from "../utils/httputil.js";

export const profileMixin = {
  async get_profile(sec_uid) {
    const cached = this._profile_cache.get(sec_uid);
    if (cached && Date.now() / 1000 - cached[0] < 3600) {
      return { ...cached[1] };
    }
    const result = { nickname: "", unique_id: "", avatar: "", ok: false, error: "" };
    const url = `https://www.iesdouyin.com/share/user/${sec_uid}`;
    for (const cookie of [this.cookie || null, this.ac_cookies, ""]) {
      try {
        const headers = {
          "User-Agent": UA_MOBILE,
          "Accept": "*/*",
          "Accept-Language": "zh-CN,zh;q=0.8",
          "Referer": "https://www.iesdouyin.com/",
        };
        if (cookie) headers.Cookie = cookie;
        const body = await httpGetText(url, { headers, timeout: 15000 });
        if (body.includes("_$jsvmprt") ||
            (body.slice(0, 2000).includes("RENDER_DATA") && body.length < 20000)) {
          continue;
        }
        const nick = body.match(/"nickname":"(.*?)"/);
        const uid = body.match(/"unique_id":"(.*?)"/);
        const av = body.match(/"avatar_thumb":\{[\s\S]*?"url_list":\["([^"]+)"/);
        if (nick || uid) {
          if (nick) result.nickname = unescapeSSR(nick[1]);
          if (uid) result.unique_id = unescapeSSR(uid[1]);
          if (av) result.avatar = av[1].replace(/\\u002F/g, "/");
          result.ok = true;
          this._profile_cache.set(sec_uid, [Date.now() / 1000, result]);
          return result;
        }
      } catch (e) {
        result.error = e && e.message ? e.message : String(e);
      }
    }
    result.error = result.error || "无法获取主播资料(可能被风控, 可在设置中填写 Cookie)";
    return result;
  },
};
