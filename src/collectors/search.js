// 主播搜索采集：对应 Python src/app/collectors/search.py
// discover/search 接口按关键词搜索主播用户
import { UA_QQ } from "../utils/constants.js";
import { httpGetText } from "../utils/httputil.js";

export const searchMixin = {
  async search(keyword) {
    const params = new URLSearchParams([
      ["keyword", keyword], ["search_channel", "aweme_user_web"], ["sort_type", "0"],
      ["publish_time", "0"], ["search_source", "normal_search"],
      ["query_correct_type", "1"], ["offset", "0"], ["count", "10"],
      ["device_platform", "webapp"], ["aid", "6383"],
    ]);
    const url = `https://www.douyin.com/aweme/v1/web/discover/search/?${params.toString()}`;
    let data;
    try {
      const body = await httpGetText(url, {
        headers: {
          "User-Agent": UA_QQ, "Accept": "*/*",
          "Accept-Language": "zh-CN,zh;q=0.9", "Referer": "https://www.douyin.com/",
        },
        timeout: 15000,
      });
      data = JSON.parse(body);
    } catch (e) {
      return { ok: false, msg: `搜索失败: ${e && e.message ? e.message : e}(可能被风控, 请直接粘贴直播间链接)` };
    }
    const users = data.user_list || [];
    if (data.status_code !== 0 || !users.length) {
      return { ok: false, msg: "搜索被风控或无结果, 请直接粘贴直播间/分享链接" };
    }
    const out = [];
    for (const u of users.slice(0, 10)) {
      const ui = u.user_info || {};
      out.push({
        sec_uid: ui.sec_uid || "",
        nickname: ui.nickname || "",
        unique_id: ui.unique_id || "",
        avatar: ((ui.avatar_thumb || {}).url_list || [""])[0],
      });
    }
    return { ok: true, users: out };
  },
};
