// 抖音用户主页解析：用户资料 + 作品列表
// 资料：web user/profile/other（webSign，匿名会话可用）→ iesdouyin/share/user SSR 回退
// 作品：web aweme/post（需登录态 Cookie / a_bogus，取不到时给出提示，不影响资料展示）
import { UA_MOBILE, DEFAULT_AC_COOKIES } from "../utils/constants.js";
import { extractUrl, SEC_UID_RE } from "../utils/misc.js";
import { httpGetText, getDispatcher, fetchTtwid } from "../utils/httputil.js";
import { fetch as undiciFetch } from "undici";
import { fetchDouyinWebApi } from "./aweme.js";

const SHARE_USER = "https://www.iesdouyin.com/share/user/";

// 短链展开：v.douyin.com 用户分享链接 → www.douyin.com/user/{sec_uid}
async function expandShortLink(url, userCookie = "") {
  try {
    const ttwid = await fetchTtwid();
    const headers = { "User-Agent": UA_MOBILE };
    const ck = [ttwid ? `ttwid=${ttwid}` : "", userCookie].filter(Boolean).join("; ");
    if (ck) headers.Cookie = ck;
    const res = await undiciFetch(url, {
      headers,
      redirect: "follow",
      dispatcher: getDispatcher(),
      signal: AbortSignal.timeout(15000),
    });
    try { await res.arrayBuffer(); } catch {}
    return res.url || url;
  } catch {
    return url;
  }
}

function extractSecUid(text) {
  const m = String(text || "").match(SEC_UID_RE);
  if (m) return m[0];
  const m2 = String(text || "").match(/(?:douyin\.com|iesdouyin\.com)\/user\/([^/?#]+)/i);
  if (m2) {
    try { return decodeURIComponent(m2[1]); } catch { return m2[1]; }
  }
  return "";
}

function pickAvatar(u) {
  const o = u.avatar_larger || u.avatar_medium || u.avatar_thumb || {};
  return (o.url_list || [])[0] || "";
}

function normalizeUser(u) {
  const followers = u.follower_count ?? u.mplatform_followers_count ?? "";
  return {
    sec_uid: u.sec_uid || "",
    nickname: u.nickname || "",
    unique_id: u.unique_id || u.short_id || "",
    short_id: u.short_id || "",
    avatar: pickAvatar(u),
    signature: u.signature || "",
    follower_count: followers,
    following_count: u.following_count ?? "",
    total_favorited: u.total_favorited ?? "",
    aweme_count: u.aweme_count ?? "",
    custom_verify: u.custom_verify || "",
    enterprise_verify_reason: u.enterprise_verify_reason || "",
    ip_location: u.ip_location || "",
    room_id: u.room_id || "",
  };
}

// 回退：用户分享主页 SSR（优先个人 Cookie，再用 __ac_nonce 会话绕过 jsvmprt 风控）
async function fetchUserFromShare(secUid, userCookie = "") {
  const candidates = userCookie ? [userCookie, DEFAULT_AC_COOKIES, ""] : [DEFAULT_AC_COOKIES, ""];
  for (const cookie of candidates) {
    try {
      const headers = {
        "User-Agent": UA_MOBILE,
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.8",
        "Referer": "https://www.iesdouyin.com/",
      };
      if (cookie) headers.Cookie = cookie;
      const body = await httpGetText(`${SHARE_USER}${secUid}`, { headers, timeout: 15000 });
      if (body.includes("_$jsvmprt")) continue;
      const m = body.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
      if (!m) continue;
      const data = JSON.parse(m[1]);
      const page = Object.values(data.loaderData || {}).find((v) => v && v.userInfoRes);
      const u = page && page.userInfoRes.user_info;
      if (u) return normalizeUser(u);
    } catch {}
  }
  return null;
}

function mapPosts(list) {
  return (list || []).map((a) => {
    const v = a.video || {};
    const firstImage = (Array.isArray(a.images) && a.images[0]) || {};
    const cover = ((v.cover || {}).url_list || [])[0]
      || (firstImage.url_list || [])[0]
      || "";
    const st = a.statistics || {};
    const isAlbum = Array.isArray(a.images) && a.images.length > 0;
    return {
      id: String(a.aweme_id || ""),
      desc: a.desc || "",
      cover,
      create_time: a.create_time || 0,
      digg: st.digg_count ?? "",
      comment: st.comment_count ?? "",
      play: st.play_count ?? "",
      duration: v.duration || 0,
      type: isAlbum ? "album" : "video",
      live: a.is_live_photo === 1 || (isAlbum && a.images.some((x) => x && x.video)),
    };
  }).filter((p) => p.id);
}

/**
 * 解析用户主页分享文案 / 短链 / 长链 / 纯 sec_uid。
 * options: { cookie, cursor }；返回 { ok, user, posts, has_more, cursor, posts_hint }
 */
export async function parseUser(text, options = {}) {
  text = String(text || "").trim();
  if (!text) return { ok: false, msg: "请先粘贴用户主页链接或分享文案" };
  const cookie = options.cookie || "";

  let raw = extractUrl(text);
  if (/v\.douyin\.com/i.test(raw)) {
    raw = await expandShortLink(raw, cookie);
    if (/^https:\/\/www\.douyin\.com\/?$/i.test(raw)) {
      return { ok: false, msg: "短链未能展开（可能被抖音限流），请粘贴用户主页长链接或 sec_uid" };
    }
  }
  const secUid = extractSecUid(raw) || extractSecUid(text);
  if (!secUid) {
    return { ok: false, msg: "未识别到用户 sec_uid，请粘贴主页链接（www.douyin.com/user/MS4wLjAB...）或主页分享文案" };
  }

  const cursor = String(options.cursor || "0");
  const referer = `https://www.douyin.com/user/${secUid}`;
  const out = {
    ok: true, sec_uid: secUid, user: null, posts: [],
    has_more: false, cursor: "0", posts_hint: "",
  };

  const profile = await fetchDouyinWebApi(
    "/aweme/v1/web/user/profile/other/",
    { sec_user_id: secUid, aid: "6383", device_platform: "webapp" },
    cookie, referer,
  );
  out.user = (profile && profile.user)
    ? normalizeUser(profile.user)
    : await fetchUserFromShare(secUid, cookie);
  if (!out.user) {
    return { ok: false, msg: "未取到用户资料（可能被风控），请稍后重试或在设置中填写抖音 Cookie" };
  }
  out.user.sec_uid = out.user.sec_uid || secUid;

  const post = await fetchDouyinWebApi(
    "/aweme/v1/web/aweme/post/",
    {
      sec_user_id: secUid, count: "18", max_cursor: cursor, aid: "6383",
      device_platform: "webapp", publish_video_strategy_type: "2",
    },
    cookie, referer,
  );
  if (post && Array.isArray(post.aweme_list) && post.aweme_list.length) {
    out.posts = mapPosts(post.aweme_list);
    out.has_more = !!post.has_more;
    out.cursor = String(post.max_cursor || "0");
  } else {
    out.posts_hint = "作品列表接口需要登录态 Cookie / a_bogus 签名，当前未取到；可点右上角「🔑 Cookie」保存个人 Cookie 后重试，或用下方「批量解析作品链接」";
  }
  return out;
}
