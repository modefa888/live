// 抖音作品（视频 / 图集 / 动图）分享链接解析
// 流程：提取链接 → 跟随 v.douyin.com 短链重定向 → iesdouyin 分享页 SSR 提取 _ROUTER_DATA
//       → 视频取 play_addr（playwm→play 无水印）并跟随 302 得到 CDN 直链；图集取 images 列表
import { UA_MOBILE } from "../utils/constants.js";
import { extractUrl } from "../utils/misc.js";
import { httpGetText, getDispatcher, fetchTtwid } from "../utils/httputil.js";
import { fetch as undiciFetch } from "undici";

// iesdouyin 分享页需要 ttwid 会话才会内嵌完整作品数据（videoInfoRes），缓存复用
let _ttwid = "";
async function ensureTtwid() {
  if (_ttwid) return _ttwid;
  _ttwid = await fetchTtwid();
  return _ttwid;
}

// 手动跟随重定向，返回最终 CDN 地址（不下载响应体）
async function resolveFinalUrl(url, headers, maxHops = 5) {
  let cur = url;
  for (let i = 0; i < maxHops; i++) {
    const res = await undiciFetch(cur, {
      headers,
      redirect: "manual",
      dispatcher: getDispatcher(),
      signal: AbortSignal.timeout(15000),
    });
    const loc = res.headers.get("location");
    try { res.body && res.body.cancel && res.body.cancel(); } catch {}
    if (res.status >= 300 && res.status < 400 && loc) {
      cur = loc.startsWith("http") ? loc : new URL(loc, cur).href;
      continue;
    }
    return cur;
  }
  return cur;
}

// 从 url_list 中挑一个浏览器可显示的图片地址（优先 jpg，过滤 heic）
function pickImageUrl(im) {
  const urls = (im && im.url_list) || [];
  return urls.find((u) => /\.jpe?g/i.test(u))
    || urls.find((u) => !/\.heic/i.test(u))
    || urls[0]
    || "";
}

/**
 * 解析抖音作品分享链接。
 * 支持：视频（无水印 mp4 直链）、图集（图片 + 动图）、短链/口令文案/纯作品 ID。
 * 返回 { ok, type: "video"|"album", desc, author, cover, duration, videos|images, music, ... }
 */
export async function parseAweme(text) {
  text = String(text || "").trim();
  if (!text) return { ok: false, msg: "请先粘贴分享链接或文案" };

  // 1. 提取链接
  const url = extractUrl(text);
  if (!url || !/douyin\.com|iesdouyin\.com|douyin\.cn/i.test(url)) {
    return { ok: false, msg: "未识别到抖音链接，请粘贴分享文案或视频链接" };
  }

  // 2. 跟随短链重定向（v.douyin.com；带 ttwid，失败可重试一次）
  let finalUrl = url;
  if (/v\.douyin\.com/i.test(url)) {
    const ttwid = await ensureTtwid();
    const slHeaders = { "User-Agent": UA_MOBILE };
    if (ttwid) slHeaders.Cookie = `ttwid=${ttwid}`;
    const follow = async () => {
      const res = await undiciFetch(url, {
        headers: slHeaders,
        redirect: "follow",
        dispatcher: getDispatcher(),
        signal: AbortSignal.timeout(15000),
      });
      try { res.body && res.body.cancel && res.body.cancel(); } catch {}
      return res.url || "";
    };
    try {
      finalUrl = (await follow()) || finalUrl;
      // 被踢回首页 = 短链被限流，稍作间隔重试一次
      if (/^https:\/\/www\.douyin\.com\/?$/.test(finalUrl)) {
        await new Promise((r) => setTimeout(r, 800));
        finalUrl = (await follow()) || finalUrl;
      }
    } catch (e) {
      return { ok: false, msg: `短链解析失败: ${e && e.message ? e.message : e}` };
    }
  }

  // 3. 提取作品 ID：/video/{id}、/note/{id}、/slides/{id}、modal_id 参数、纯 ID
  const kind = /\/note\//.test(finalUrl) ? "note" : "video";
  let m = finalUrl.match(/\/(?:video|note|slides)\/(\d+)/);
  if (!m) m = finalUrl.match(/[?&](?:modal_id|aweme_id)=(\d+)/);
  if (!m && /^\d{15,21}$/.test(url)) m = [url, url];
  if (!m) {
    if (/^https:\/\/www\.douyin\.com\/?$/.test(finalUrl)) {
      return { ok: false, msg: "短链未能展开（可能被抖音限流），请稍后重试，或粘贴长链接（www.douyin.com/video/作品ID）" };
    }
    return { ok: false, msg: "未能从链接中识别出作品 ID（直播链接请用「添加主播」，仅支持视频/图集作品）" };
  }
  const id = m[1];

  // 4. 请求 iesdouyin 分享页（SSR 内嵌 _ROUTER_DATA；需 ttwid Cookie 才有完整数据）
  const pageUrl = `https://www.iesdouyin.com/share/${kind}/${id}/`;
  let body;
  try {
    const ttwid = await ensureTtwid();
    const headers = {
      "User-Agent": UA_MOBILE,
      "Accept": "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9",
      "Referer": "https://www.douyin.com/",
    };
    if (ttwid) headers.Cookie = `ttwid=${ttwid}`;
    body = await httpGetText(pageUrl, { headers, timeout: 15000 });
  } catch (e) {
    return { ok: false, msg: `分享页请求失败: ${e && e.message ? e.message : e}` };
  }
  if (body.includes("_$jsvmprt")) {
    return { ok: false, msg: "被抖音风控，请稍后重试或在设置中填写 Cookie" };
  }

  // 5. 提取 _ROUTER_DATA JSON
  const m2 = body.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
  if (!m2) return { ok: false, msg: "分享页数据解析失败（页面结构变化或被风控）" };
  let data;
  try {
    data = JSON.parse(m2[1]);
  } catch {
    return { ok: false, msg: "分享页 JSON 解析失败" };
  }
  const loader = data.loaderData || {};
  const keys = Object.keys(loader);
  const key = keys.find((k) => k.includes(id) && k.endsWith("/page")) || keys.find((k) => k.endsWith("/page")) || keys[0];
  const info = key ? loader[key] : null;
  const items = (info && info.videoInfoRes && info.videoInfoRes.item_list) || [];
  const item = items[0];
  if (!item) {
    const reason = (info && info.videoInfoRes && info.videoInfoRes.filter_reason) || "";
    return { ok: false, msg: reason ? `未取到作品数据：${reason}` : "未取到作品数据（作品可能已删除或被风控）" };
  }

  const author = item.author || {};
  const out = {
    ok: true,
    id,
    kind,
    type: "unknown",
    desc: item.desc || "",
    author: {
      nickname: author.nickname || "",
      avatar: ((author.avatar_thumb || {}).url_list || [""])[0] || "",
    },
    stats: {
      digg: (item.statistics || {}).digg_count ?? "",
      comment: (item.statistics || {}).comment_count ?? "",
      share: (item.statistics || {}).share_count ?? "",
    },
    create_time: item.create_time || 0,
    cover: ((item.video || {}).cover || {}).url_list
      ? (item.video.cover.url_list)[0] || ""
      : "",
    duration: (item.video || {}).duration || 0, // 毫秒
    music: (((item.music || {}).play_url || {}).url_list || [""])[0] || "",
  };

  // 6. 图集（图片/动图/实况）：images 数组
  if (Array.isArray(item.images) && item.images.length) {
    out.type = "album";
    out.images = item.images.map(pickImageUrl).filter(Boolean);
    out.count = out.images.length;
    return out;
  }

  // 7. 视频：play_addr（playwm→play 去水印），跟随 302 得到可直连播放的 CDN 地址
  out.type = "video";
  const playUrls = (((item.video || {}).play_addr || {}).url_list) || [];
  let play = playUrls[0] || "";
  if (!play && item.video && item.video.play_addr && item.video.play_addr.uri) {
    play = `https://www.iesdouyin.com/aweme/v1/play/?video_id=${item.video.play_addr.uri}&ratio=1080p&line=0`;
  }
  if (!play) return { ok: false, msg: "未取到视频播放地址（可能被风控）" };

  const noWm = play.replace("playwm", "play");
  const headers = { "User-Agent": UA_MOBILE };
  const videos = [];
  try {
    const final = await resolveFinalUrl(noWm, headers);
    if (final) videos.push({ label: noWm !== play ? "无水印视频" : "视频", url: final });
  } catch {}
  if (noWm !== play) {
    try {
      const finalWm = await resolveFinalUrl(play, headers);
      if (finalWm) videos.push({ label: "原视频（含水印）", url: finalWm });
    } catch {}
  }
  if (!videos.length) return { ok: false, msg: "视频地址解析失败（未获得可用直链）" };
  out.videos = videos;
  out.play_url = videos[0].url;
  return out;
}
