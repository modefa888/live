// 热搜榜采集：对应 Python src/app/collectors/hot.py
// 抖音热搜榜（含直播间在线人数 room_count），无需签名
import { HOT_API, UA_QQ } from "../utils/constants.js";
import { httpGetText } from "../utils/httputil.js";

const nowSec = () => Math.floor(Date.now() / 1000);

export const hotMixin = {
  async get_hot_list(limit = 30) {
    // 获取抖音热搜榜（含直播间在线人数 room_count），无需签名
    const params = new URLSearchParams([
      ["aid", "6383"], ["channel", "channel_pc_web"], ["source", "6"],
    ]);
    const url = `${HOT_API}?${params.toString()}`;
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
      return { ok: false, msg: `热搜请求失败: ${e && e.message ? e.message : e}` };
    }
    if (data.status_code !== 0) {
      return { ok: false, msg: "热搜接口被风控, 请稍后重试" };
    }
    const words = ((data.data || {}).word_list) || [];
    // 抖音热搜 label 数字编码 → 文本
    const hotLabelMap = { 1: "新", 3: "热", 5: "荐", 6: "沸", 9: "爆" };
    const out = [];
    for (const w of words.slice(0, limit)) {
      out.push({
        word: w.word || "",
        hot_value: Number(w.hot_value) || 0,
        position: Number(w.position) || 0,
        label: hotLabelMap[w.label] ?? "",
        room_count: Number(w.room_count) || 0,
      });
    }
    return { ok: true, list: out, updated_at: nowSec() };
  },
};
