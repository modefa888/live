// 抖音作品（视频 / 图集 / 动图 / 实况图）分享链接解析
// 流程：提取链接 → 跟随 v.douyin.com 短链重定向 → iesdouyin 分享页 SSR 提取 _ROUTER_DATA
//       → 视频取 play_addr（playwm→play 无水印）并跟随 302 得到 CDN 直链；图集取 images 列表
//       → 图集额外请求 web 详情接口，取回实况图（Live Photo）对应的动态视频直链
import { createHash } from "node:crypto";
import { UA_MOBILE, UA_DESKTOP } from "../utils/constants.js";
import { extractUrl } from "../utils/misc.js";
import { httpGetText, getDispatcher, fetchTtwid, parseCookieHeader } from "../utils/httputil.js";
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

// 从 url_list 中挑一个浏览器可显示的静态图片地址（优先 jpg，过滤 heic）
function pickImageUrl(im) {
  const urls = (im && im.url_list) || [];
  return urls.find((u) => /\.jpe?g/i.test(u))
    || urls.find((u) => !/\.heic/i.test(u))
    || urls[0]
    || "";
}

// 从 url_list / download_url_list 中挑 GIF 动图地址（浏览器用 <img> 即可循环播放）
function pickAnimatedUrl(im) {
  const urls = [...((im && im.url_list) || []), ...((im && im.download_url_list) || [])];
  return urls.find((u) => /\.gif(?:\?|~|$)|[?&](?:format|fm)=gif/i.test(u)) || "";
}

// 过滤掉图集作品 video.play_addr 里常见的音乐 mp3（不是动态视频）
function isVideoUrl(u) {
  return /^https?:\/\//i.test(u) && !/\.mp3|\/audio\/|ies-music/i.test(u);
}

// 从 images[i].video 中收集可播放的 mp4 直链（高码率优先，最后用 play 接口兜底）
function collectVideoUrls(v) {
  const out = [];
  if (!v || typeof v !== "object") return out;
  const push = (o) => {
    for (const u of ((o && o.url_list) || [])) {
      if (isVideoUrl(u) && !out.includes(u)) out.push(u);
    }
  };
  const brs = Array.isArray(v.bit_rate)
    ? [...v.bit_rate].sort((a, b) => (Number(b && b.bit_rate) || 0) - (Number(a && a.bit_rate) || 0))
    : [];
  for (const b of brs) push(b && b.play_addr);
  push(v.play_addr);
  push(v.play_addr_h264);
  push(v.download_addr);
  const uri = ((v.play_addr || {}).uri) || ((brs[0] || {}).play_addr || {}).uri || "";
  if (!out.length && /^[a-z0-9_-]{16,}$/i.test(uri)) {
    out.push(`https://www.douyin.com/aweme/v1/play/?video_id=${encodeURIComponent(uri)}&ratio=default&line=0&watermark=0&improve_bitrate=1`);
  }
  return out;
}

// ---------- 抖音 web 接口（webSign）：作品详情 / 用户资料 / 用户作品列表共用 ----------
const WEB_API_HOST = "https://www.douyin.com";
const DETAIL_PATH = "/aweme/v1/web/aweme/detail/";
const WEB_SIGN_SALT = "A96D855A08C0A9707F8BEF0D9A527E4E";
let _webSession = null; // { at, ttwid, uifid }

async function ensureWebSession() {
  if (_webSession && Date.now() - _webSession.at < 10 * 60 * 1000) return _webSession;
  const res = await undiciFetch("https://live.douyin.com/", {
    headers: { "User-Agent": UA_DESKTOP },
    dispatcher: getDispatcher(),
    signal: AbortSignal.timeout(15000),
    redirect: "follow",
  });
  try { await res.arrayBuffer(); } catch {}
  const cookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const pick = (name) => {
    for (const c of cookies) {
      const m = c.match(new RegExp(`^\\s*${name}=([^;]+)`, "i"));
      if (m) return m[1];
    }
    return "";
  };
  const uifid = pick("UIFID_TEMP") || pick("UIFID");
  if (!uifid) return null;
  _webSession = { at: Date.now(), ttwid: pick("ttwid"), uifid };
  return _webSession;
}

// 带 x-secsdk-web-signature（md5 webSign）请求 web 接口；匿名 ttwid 会话即可，配置 Cookie 可提升成功率
// path 形如 /aweme/v1/web/aweme/detail/；返回解析后的 JSON，失败返回 null
export async function fetchDouyinWebApi(path, params = {}, userCookie = "", referer = "https://www.douyin.com/") {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const s = await ensureWebSession();
      if (!s) return null;
      const userCk = parseCookieHeader(userCookie);
      const uifid = userCk.UIFID_TEMP || userCk.UIFID || userCk.uifid || s.uifid;
      const ts = String(Math.floor(Date.now() / 1000));
      const query = new URLSearchParams({ ...params, uifid, timestamp: ts }).toString();
      const sig = createHash("md5")
        .update(`${uifid}_${ts}_${WEB_SIGN_SALT}_${query}`)
        .digest("hex");
      const ck = { ttwid: s.ttwid, ...userCk, UIFID_TEMP: uifid };
      const headers = {
        "User-Agent": UA_DESKTOP,
        "Accept": "application/json",
        "Referer": referer,
        "Cookie": Object.entries(ck).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; "),
        uifid,
        "x-secsdk-web-signature": sig,
        "x-secsdk-web-expire": ts,
      };
      const res = await undiciFetch(`${WEB_API_HOST}${path}?${query}&x-secsdk-web-signature=${sig}`, {
        headers,
        dispatcher: getDispatcher(),
        signal: AbortSignal.timeout(15000),
        redirect: "follow",
      });
      const text = await res.text();
      if (!text.trim()) return null; // 风控时返回空体（如作品列表接口缺 a_bogus），重试无意义
      const data = JSON.parse(text);
      if (!res.ok || (data.status_code !== undefined && data.status_code !== 0)) {
        _webSession = null; // 会话/签名失效，换一个会话重试
        continue;
      }
      return data;
    } catch {
      _webSession = null;
    }
  }
  return null;
}

// 分享页不下发实况图视频，只有详情接口含 images[i].video
async function fetchAwemeDetail(id, userCookie = "") {
  const data = await fetchDouyinWebApi(
    DETAIL_PATH,
    { aweme_id: id, aid: "6383", device_platform: "webapp" },
    userCookie,
  );
  return (data && data.aweme_detail) || null;
}

/**
 * 解析抖音作品分享链接。
 * 支持：视频（无水印 mp4 直链）、图集（图片 + 动图）、短链/口令文案/纯作品 ID。
 * 返回 { ok, type: "video"|"album", desc, author, cover, duration, videos|images|photos, music, ... }
 * options.cookie：站点配置里的抖音 Cookie（可选，提升详情接口成功率）
 */
export async function parseAweme(text, options = {}) {
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
      sec_uid: author.sec_uid || "",
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
    music_title: (item.music || {}).title || "",
    music: (((item.music || {}).play_url || {}).url_list || [""])[0] || "",
  };

  // 6. 图集（静态图片 / GIF 动图 / 实况图 Live Photo）
  //    分享页 reflow 只下发静态图（images[i] 仅 5 个字段），实况图的动态视频在
  //    web 详情接口的 images[i].video 中，需按作品 ID 额外请求一次。
  const shareImages = Array.isArray(item.images) ? item.images : [];
  const playUri = String((((item.video || {}).play_addr || {}).uri) || "");
  const looksLikeAlbum = shareImages.length > 0 || /\.mp3|ies-music/i.test(playUri);
  let detail = null;
  let liveError = "";
  if (looksLikeAlbum) {
    try {
      detail = await fetchAwemeDetail(id, options.cookie || "");
    } catch { /* 详情接口失败不影响静态图集展示 */ }
    if (!detail) liveError = "动态视频详情接口未返回数据（可能被风控）；若该作品是实况图，可稍后重试或在设置中填写抖音 Cookie";
  }
  const detailImages = (detail && Array.isArray(detail.images)) ? detail.images : [];
  const images = shareImages.length ? shareImages : detailImages;
  if (images.length) {
    out.type = "album";
    const byUri = new Map(detailImages.filter((x) => x && x.uri).map((x) => [x.uri, x]));
    out.photos = images.map((im, i) => {
      const d = (detailImages[i] && (!detailImages[i].uri || detailImages[i].uri === im.uri))
        ? detailImages[i]
        : (byUri.get(im && im.uri) || detailImages[i] || {});
      const v = (im && (im.video || im.live_photo)) || d.video || d.live_photo || null;
      const videoUrls = collectVideoUrls(v);
      const animated = pickAnimatedUrl(im) || pickAnimatedUrl(d) || "";
      return {
        image: pickImageUrl(im) || animated,
        animated,
        video: videoUrls[0] || "",
        video_urls: videoUrls,
        duration: (v && v.duration) || 0,
        live: videoUrls.length > 0 || !!(im && im.live_photo_type === 1) || d.live_photo_type === 1,
      };
    });
    out.images = out.photos.map((p) => p.image || p.animated).filter(Boolean);
    out.count = out.photos.length;
    out.live_count = out.photos.filter((p) => p.video).length;
    if (!out.live_count && liveError) out.live_hint = liveError;
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
