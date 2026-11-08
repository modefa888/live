// 第三方通知模块：对应 Python src/app/monitor/notifier.py
// 支持 Telegram Bot / Email / Webhook；异步发送（并发 2），绝不阻塞监控 / HTTP 主流程
import nodemailer from "nodemailer";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { log } from "../utils/logging.js";
import { getDispatcher } from "../utils/httputil.js";
import { getBackend } from "../db/mongo.js";

const nowSec = () => Math.floor(Date.now() / 1000);

// ========================= 上下文构建 =========================

function _build_ctx(event_type, streamer) {
  // 从 streamer 中提取所有需要的数据，组装为扁平上下文字典
  const room = streamer.room || {};
  const fd = streamer.fudai || {};
  const ctx = {
    event: event_type,
    action: event_type === "live_start" ? "开播" : (event_type === "live_end" ? "下播" : "发福袋"),
    sec_uid: streamer.sec_uid || "",
    web_rid: streamer.web_rid || "",
    unique_id: streamer.unique_id || "",
    nickname: streamer.nickname || streamer.web_rid || streamer.sec_uid || "未知主播",
    avatar: streamer.avatar || "",
    title: room.title || "",
    cover: room.cover || "",
    user_count: room.user_count || room.total_user || "",
    like_count: String(room.like_count || ""),
    live: Boolean(room.live || false),
    first_seen_live: room.first_seen_live,
    created_at: nowSec(),
    ts: nowSec(),
  };
  // 直播间链接
  const rid = ctx.web_rid;
  ctx.link = rid ? `https://live.douyin.com/${rid}` : "";
  // 画质
  const streams = room.streams || [];
  const first = streams.find((s) => s.flv || s.hls) || null;
  ctx.label = first ? (first.label ?? "") : "";
  // 福袋字段
  ctx.gift_name = fd.gift_name || "";
  ctx.gift_image = fd.gift_image || "";
  ctx.lucky_count = Number(fd.lucky_count) || 0;
  ctx.candidate_num = Number(fd.candidate_num) || 0;
  ctx.remain_seconds = Number(fd.remain_seconds) || 0;
  ctx.conditions = fd.conditions || [];
  ctx.draw_id = fd.draw_id || fd.gift_id || "";
  return ctx;
}

// ========================= Telegram 消息 =========================

const TG_LIVE_START_CAPTION =
  "🔴 <b>{nickname}</b> 开播啦！\n\n" +
  "📺 <b>标题</b>：{title}\n" +
  "👁 <b>观看</b>：{user_count}\n" +
  "❤ <b>点赞</b>：{like_count}\n" +
  "{label_line}\n" +
  '🔗 <a href="{link}">进入直播间</a>';

const TG_LIVE_END_MSG =
  "⚪ <b>{nickname}</b> 已下播\n\n" +
  '🔗 <a href="{link}">直播间</a>';

const TG_TEST_MSG = "🔔 <b>这是一条测试通知</b>\n\n{extra}";

const TG_FUDAI_MSG =
  "🎁 <b>{nickname}</b> 发了福袋！\n\n" +
  "🏆 <b>奖品</b>：{gift_name}\n" +
  "{lucky_line}\n" +
  "{candidate_line}\n" +
  "⏱ <b>剩余</b>：{remain_text}\n" +
  "{conds_line}\n" +
  '🔗 <a href="{link}">进入直播间</a>';

function fmt(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

function _safe_html(s) {
  // 转义 HTML 特殊字符，但保留 <b>/<a> 等标签
  if (!s) return "—";
  s = String(s);
  s = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  // 恢复 Telegram 标签（谨慎处理，仅恢复 <b> <i> <a href>）
  s = s.replace(/&lt;b&gt;/g, "<b>").replace(/&lt;\/b&gt;/g, "</b>");
  s = s.replace(/&lt;a href=/g, "<a href=");
  s = s.replace(/&gt;/g, ">");
  return s || "—";
}

function _render_tg_caption(ctx) {
  // 开播：返回 HTML caption 文本
  let title = ctx.title;
  if (title) title = title.slice(0, 60);
  const label_line = ctx.label ? `🎬 <b>画质</b>：${ctx.label}` : "";
  const user_count = ctx.user_count || "—";
  const like_count = ctx.like_count || "0";
  return fmt(TG_LIVE_START_CAPTION, {
    nickname: _safe_html(ctx.nickname),
    title: _safe_html(title),
    user_count: _safe_html(user_count),
    like_count: _safe_html(like_count),
    label_line,
    link: _safe_html(ctx.link),
  });
}

function _render_tg_end(ctx) {
  // 下播：HTML 消息
  return fmt(TG_LIVE_END_MSG, {
    nickname: _safe_html(ctx.nickname),
    link: _safe_html(ctx.link),
  });
}

function _render_tg_test(event_type) {
  const extra = event_type === "live_start" ? "🔴 开播" : "⚪ 下播";
  return fmt(TG_TEST_MSG, { extra });
}

function _render_tg_fudai(ctx) {
  // 福袋：HTML 消息
  const gift_name = _safe_html(ctx.gift_name || "福袋");
  const lucky_count = ctx.lucky_count || 0;
  const candidate_num = ctx.candidate_num || 0;
  const lucky_line = lucky_count ? `🎯 <b>名额</b>：${lucky_count} 个` : "";
  const candidate_line = candidate_num ? `👥 <b>参与</b>：${candidate_num} 人` : "";
  const remain = ctx.remain_seconds || 0;
  const remain_text = fmt_remain(remain);
  const conds = ctx.conditions || [];
  const conds_text = conds.length ? (conds[0] + (conds.length > 1 ? " 等" : "")) : "";
  const conds_line = conds_text ? `📋 <b>条件</b>：${conds_text}` : "";
  return fmt(TG_FUDAI_MSG, {
    nickname: _safe_html(ctx.nickname),
    gift_name,
    lucky_line,
    candidate_line,
    remain_text,
    conds_line,
    link: _safe_html(ctx.link),
  });
}

export function fmt_remain(sec) {
  // 格式化剩余秒数
  if (sec <= 0) return "即将开奖";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m > 0) return `${m}分${String(s).padStart(2, "0")}秒`;
  return `${s}秒`;
}

// ========================= HTTP 发送辅助 =========================

const _proxyDispatchers = new Map();

function dispatcherFor(proxy) {
  if (!proxy) return getDispatcher();
  if (!_proxyDispatchers.has(proxy)) {
    _proxyDispatchers.set(proxy, new ProxyAgent({
      uri: proxy,
      requestTls: { rejectUnauthorized: false },
      proxyTls: { rejectUnauthorized: false },
    }));
  }
  return _proxyDispatchers.get(proxy);
}

async function postJson(url, payload, { proxy = null, timeout = 20000 } = {}) {
  const res = await undiciFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
    dispatcher: dispatcherFor(proxy),
    signal: AbortSignal.timeout(timeout),
  });
  const body = await res.text();
  return [res.status, body];
}

// ========================= Telegram 发送 =========================

export async function send_telegram(bot_token, chat_ids_text, event_type, ctx, { test_mode = false, proxy = null } = {}) {
  // 通过 Telegram Bot API 发送消息
  if (!bot_token || !chat_ids_text) return [false, "Telegram 未配置或消息为空"];
  const token = String(bot_token).trim();
  const chat_ids = String(chat_ids_text).split(",").map((c) => c.trim()).filter(Boolean);
  if (!chat_ids.length) return [false, "Telegram 未配置接收人 chat_id"];

  // 构建消息内容
  let text, has_photo, photo_url;
  if (test_mode) {
    text = _render_tg_test(event_type);
    has_photo = false;
    photo_url = null;
  } else if (event_type === "fudai_start") {
    text = _render_tg_fudai(ctx);
    has_photo = false;
    photo_url = null;
  } else if (event_type === "live_start" && ctx.cover) {
    has_photo = true;
    photo_url = ctx.cover;
    text = _render_tg_caption(ctx);
  } else if (event_type === "live_start") {
    has_photo = false;
    photo_url = null;
    text = _render_tg_caption(ctx);
  } else {
    has_photo = false;
    photo_url = null;
    text = _render_tg_end(ctx);
  }

  const base = `https://api.telegram.org/bot${token}`;
  const successes = [];
  const failures = [];
  for (const chat_id of chat_ids) {
    try {
      let status, body;
      if (has_photo) {
        [status, body] = await postJson(base + "/sendPhoto", {
          chat_id,
          photo: photo_url,
          caption: text.slice(0, 1000),
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }, { proxy });
      } else {
        [status, body] = await postJson(base + "/sendMessage", {
          chat_id,
          text: text.slice(0, 4000),
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }, { proxy });
      }
      if (status === 200) {
        successes.push(chat_id);
      } else {
        failures.push(`${chat_id} -> HTTP ${status}: ${body.slice(0, 120)}`);
      }
    } catch (e) {
      failures.push(`${chat_id} -> ${e && e.message ? e.message : e}`);
    }
  }

  if (failures.length) {
    return [successes.length > 0, `Telegram 部分失败: ${failures.slice(0, 3).join("; ")}`];
  }
  return [true, `Telegram 已发送至 ${successes.join(", ")}`];
}

// ========================= Email 通道 =========================

const EMAIL_SUBJECT_DEFAULT = "[{prefix}] {nickname} {action}";

const EMAIL_BODY_TEMPLATE = `<html>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:16px;background:#f8f9fa;">
<table style="width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px #ccc;">
<tr><td style="background:{banner_bg};color:#fff;padding:20px;text-align:center;font-size:20px;">{banner_emoji} <b>{nickname}</b> {action}</td></tr>
<tr><td style="padding:16px;">
{cover_html}
<h3 style="margin:0 0 10px;color:#222;">{title}</h3>
<table style="width:100%;font-size:14px;border-collapse:collapse;">
<tr><td style="padding:4px 0;color:#666;width:80px;">主播</td><td style="padding:4px 0;"><b>{nickname}</b></td></tr>
<tr><td style="padding:4px 0;color:#666;">开播状态</td><td style="padding:4px 0;"><b style="color:{live_color};">{live_text}</b></td></tr>
{extra_rows}
<tr><td style="padding:4px 0;color:#666;">画质</td><td style="padding:4px 0;">{label}</td></tr>
</table>
<div style="margin-top:12px;padding-top:12px;border-top:1px solid #eee;">
<a href="{link}" style="display:inline-block;background:#ff3b5c;color:#fff;padding:8px 18px;border-radius:6px;text-decoration:none;font-size:14px;">📺 进入直播间</a>
</div>
</td></tr>
</table>
<p style="color:#999;font-size:11px;text-align:center;margin-top:10px;">抖音直播监控 · {ts_str}</p>
</body>
</html>
`;

// 福袋邮件专用模板
const EMAIL_FUDAI_BODY_TEMPLATE = `<html>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:16px;background:#f8f9fa;">
<table style="width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px #ccc;">
<tr><td style="background:{banner_bg};color:#fff;padding:20px;text-align:center;font-size:20px;">{banner_emoji} <b>{nickname}</b> 发了福袋</td></tr>
<tr><td style="padding:16px;">
{cover_html}
<h3 style="margin:0 0 10px;color:#222;">🎁 {gift_name}</h3>
<table style="width:100%;font-size:14px;border-collapse:collapse;">
<tr><td style="padding:4px 0;color:#666;width:80px;">主播</td><td style="padding:4px 0;"><b>{nickname}</b></td></tr>
<tr><td style="padding:4px 0;color:#666;">奖品</td><td style="padding:4px 0;"><b>{gift_name}</b></td></tr>
<tr><td style="padding:4px 0;color:#666;">名额</td><td style="padding:4px 0;">{lucky_text}</td></tr>
<tr><td style="padding:4px 0;color:#666;">参与人数</td><td style="padding:4px 0;">{candidate_text}</td></tr>
<tr><td style="padding:4px 0;color:#666;">剩余时间</td><td style="padding:4px 0;"><b>{remain_text}</b></td></tr>
{conds_html}
</table>
<div style="margin-top:12px;padding-top:12px;border-top:1px solid #eee;">
<a href="{link}" style="display:inline-block;background:#f59e0b;color:#fff;padding:8px 18px;border-radius:6px;text-decoration:none;font-size:14px;">🎁 进入直播间</a>
</div>
</td></tr>
</table>
<p style="color:#999;font-size:11px;text-align:center;margin-top:10px;">抖音直播监控 · {ts_str}</p>
</body>
</html>
`;

function pad2(n) { return String(n).padStart(2, "0"); }

function _render_email_subject(template, ctx) {
  // 渲染邮件主题。支持 {prefix}, {nickname}, {title}, {action} 占位符
  const prefix = ctx._subject_prefix || "抖音直播";
  let title = ctx.title || "抖音直播";
  title = title.slice(0, 30);
  return fmt(template, {
    prefix,
    nickname: ctx.nickname,
    title,
    action: ctx.action,
    live: ctx.live,
    user_count: ctx.user_count,
    like_count: ctx.like_count,
  }).trim();
}

function _render_email_body(template, ctx) {
  // 渲染邮件正文 HTML
  const title = _safe_html(ctx.title || "暂无标题");
  const cover = ctx.cover || "";
  let cover_html = "";
  if (cover) {
    cover_html = `<div style="margin-bottom:12px;"><img src="${cover}" style="max-width:100%;border-radius:6px;" alt="封面"></div>`;
  }

  const live_color = ctx.live ? "#22c55e" : "#64748b";
  const live_text = ctx.live ? "🔴 直播中" : "⚪ 未开播";

  const banner_emoji = ctx.event === "live_start" ? "🔴" : "⚪";
  const banner_bg = ctx.event === "live_start" ? "#ff3b5c" : "#475569";

  let extra_rows = "";
  if (ctx.user_count) {
    extra_rows += `<tr><td style="padding:4px 0;color:#666;">观看人数</td><td style="padding:4px 0;">${ctx.user_count}</td></tr>\n`;
  }
  if (ctx.like_count) {
    extra_rows += `<tr><td style="padding:4px 0;color:#666;">点赞数</td><td style="padding:4px 0;">${ctx.like_count}</td></tr>\n`;
  }
  if (ctx.unique_id) {
    extra_rows += `<tr><td style="padding:4px 0;color:#666;">抖音号</td><td style="padding:4px 0;">${ctx.unique_id}</td></tr>\n`;
  }

  const d = new Date(ctx.ts * 1000);
  const ts_str = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

  const label = _safe_html(ctx.label || "—");

  return fmt(template, {
    banner_bg,
    banner_emoji,
    nickname: _safe_html(ctx.nickname),
    action: ctx.action,
    title,
    cover_html,
    live_color,
    live_text,
    extra_rows,
    label,
    link: _safe_html(ctx.link || "#"),
    ts_str,
  });
}

async function send_email(cfg, subject, body_html) {
  // 通过 SMTP 发送邮件（纯 HTML）。端口 465 走 SSL；587 走 STARTTLS；25 明文
  const smtp_host = String(cfg.smtp || "").trim();
  let smtp_port = parseInt(cfg.port, 10);
  if (Number.isNaN(smtp_port)) smtp_port = 465;
  const user = String(cfg.user || "").trim();
  const password = String(cfg.pass || "").trim();
  const from_addr = String(cfg.from_addr || "").trim();
  const to_text = String(cfg.to || "").trim();

  if (!(smtp_host && from_addr && to_text)) {
    return [false, "Email 未完整配置(smtp/from/to)"];
  }
  const recipients = to_text.replace(/;/g, ",").split(",").map((r) => r.trim()).filter(Boolean);
  if (!recipients.length) {
    return [false, "Email 未配置收件人"];
  }

  // 纯文本兜底
  const plain = body_html.replace(/</g, "").replace(/>/g, "").slice(0, 500);

  try {
    const transportOpts = {
      host: smtp_host,
      port: smtp_port,
      secure: smtp_port === 465,
      tls: { rejectUnauthorized: false },
      connectionTimeout: 20000,
    };
    if (smtp_port === 25) transportOpts.ignoreTLS = true; // 对齐 Python：25 端口明文
    if (user && password) transportOpts.auth = { user, pass: password };
    const transporter = nodemailer.createTransport(transportOpts);
    await transporter.sendMail({
      from: from_addr,
      to: recipients.join(", "),
      subject,
      text: plain,
      html: body_html,
    });
    return [true, `Email 已发送至 ${recipients.join(", ")}`];
  } catch (e) {
    return [false, `Email 发送失败: ${e && e.message ? e.message : e}`];
  }
}

// ========================= Webhook 通道 =========================

async function send_webhook(webhook_url, payload) {
  // 通用 Webhook：POST JSON 到目标地址
  const url = (webhook_url || "").trim();
  if (!url) return [false, "Webhook URL 未配置"];
  if (!/^https?:\/\//.test(url)) return [false, `Webhook URL 非法: ${url.slice(0, 40)}`];
  try {
    const [status, body] = await postJson(url, payload, {});
    if (status >= 200 && status < 300) return [true, `Webhook OK(${status})`];
    return [false, `Webhook HTTP ${status}: ${body.slice(0, 200)}`];
  } catch (e) {
    return [false, `Webhook 请求失败: ${e && e.message ? e.message : e}`];
  }
}

// ========================= 调度器 =========================

const _COOLED = new Map();
const _COOL_SEC = 60 * 5; // 5 分钟

function _should_send(event_type, sec_uid) {
  const key = `${event_type}|${sec_uid || ""}`;
  const now = Date.now() / 1000;
  const last = _COOLED.get(key);
  if (last !== undefined && now - last < _COOL_SEC) return false;
  _COOLED.set(key, now);
  if (_COOLED.size > 2000) {
    const entries = [..._COOLED.entries()].sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < Math.floor(entries.length / 2); i++) {
      _COOLED.delete(entries[i][0]);
    }
  }
  return true;
}

export async function send_event(cfg, event_type, streamer, { timeout = 25, test_mode = false } = {}) {
  // 同步发送事件到所有启用的通道。返回 [ok_any, detail_text]
  const enabled_events = String(cfg.notify_events || "live_start,live_end")
    .split(",").map((e) => e.trim()).filter(Boolean);
  if (!enabled_events.includes(event_type) && !test_mode) {
    return [false, `事件 ${event_type} 未在通知事件中启用`];
  }

  const ctx = _build_ctx(event_type, streamer);
  ctx._subject_prefix = cfg.email_subject_prefix || "抖音直播";
  const results = [];

  // 构建消息文本（用于 Telegram 和 Webhook）
  let msg_text;
  if (event_type === "fudai_start") {
    msg_text = _render_tg_fudai(ctx);
  } else if (event_type === "live_start") {
    msg_text = _render_tg_caption(ctx);
  } else {
    msg_text = _render_tg_end(ctx);
  }

  const ident = streamer.sec_uid || streamer.web_rid || "";

  // Telegram
  const tg_token = String(cfg.tg_bot_token || "").trim();
  const tg_chats = String(cfg.tg_chat_ids || "").trim();
  const tg_proxy = String(cfg.tg_proxy || "").trim();
  if (tg_token && tg_chats) {
    if (_should_send(event_type, ident) || test_mode) {
      const [ok, msg] = await send_telegram(tg_token, tg_chats, event_type, ctx, {
        test_mode, proxy: tg_proxy || null,
      });
      results.push(["Telegram", ok, msg]);
    }
  }

  // Email
  if (Boolean(cfg.email_enabled)) {
    if (_should_send(event_type, ident) || test_mode) {
      let subj_tpl, body_tpl;
      if (event_type === "fudai_start") {
        subj_tpl = String(cfg.email_subject_template || "[{prefix}] {nickname} 发了福袋 🎁");
        body_tpl = EMAIL_FUDAI_BODY_TEMPLATE;
      } else {
        subj_tpl = String(cfg.email_subject_template || EMAIL_SUBJECT_DEFAULT);
        body_tpl = EMAIL_BODY_TEMPLATE;
      }
      const subject = _render_email_subject(subj_tpl, ctx);
      const body = _render_email_body(body_tpl, ctx);
      const [ok, msg] = await send_email({
        smtp: cfg.email_smtp || "",
        port: cfg.email_port || "465",
        user: cfg.email_user || "",
        pass: cfg.email_pass || "",
        from_addr: cfg.email_from || "",
        to: cfg.email_to || "",
      }, subject, body);
      results.push(["Email", ok, msg]);
    }
  }

  // Webhook
  const wh = String(cfg.webhook_url || "").trim();
  if (wh) {
    if (_should_send(event_type, ident) || test_mode) {
      const payload = {
        event: event_type,
        event_type,
        streamer: {
          sec_uid: ctx.sec_uid,
          web_rid: ctx.web_rid,
          nickname: ctx.nickname,
          unique_id: ctx.unique_id,
          avatar: ctx.avatar,
        },
        room: {
          title: ctx.title,
          cover: ctx.cover,
          user_count: ctx.user_count,
          like_count: ctx.like_count,
          label: ctx.label,
        },
        text: msg_text,
        link: ctx.link,
        ts: ctx.ts,
      };
      if (event_type === "fudai_start") {
        payload.fudai = {
          gift_name: ctx.gift_name,
          gift_image: ctx.gift_image,
          lucky_count: ctx.lucky_count,
          candidate_num: ctx.candidate_num,
          remain_seconds: ctx.remain_seconds,
          conditions: ctx.conditions,
          draw_id: ctx.draw_id,
        };
      }
      const [ok, msg] = await send_webhook(wh, payload);
      results.push(["Webhook", ok, msg]);
    }
  }

  if (!results.length) {
    return [false, "未配置任何通知通道"];
  }

  const ok_any = results.some(([, ok]) => ok);
  const detail = results
    .map(([ch, ok, m]) => `${ch}: ${ok ? "OK" : "FAIL"}${(!ok || ch !== results[0][0]) ? ("- " + m) : ""}`)
    .join(" | ");

  // 记录通知日志到数据库
  try {
    const sec_uid = ctx.sec_uid || streamer.sec_uid || "";
    const web_rid = ctx.web_rid || streamer.web_rid || "";
    const nickname = ctx.nickname || streamer.nickname || "";
    const backend = getBackend();
    for (const [ch_name, ok, msg] of results) {
      backend.saveNotifyLog(
        ctx.ts ?? nowSec(),
        sec_uid || web_rid,
        nickname,
        event_type,
        ch_name,
        ok ? "success" : "failed",
        msg ? String(msg).slice(0, 400) : "",
      ).catch(() => {});
    }
  } catch {}

  return [ok_any, detail];
}

// ========================= Notifier 调度器 =========================

export class Notifier {
  /** 后台通知调度器：接收事件后在并发 2 的队列里推送 */
  constructor(cfg) {
    this.cfg = cfg;
    this._queue = [];
    this._active = 0;
    this._maxWorkers = 2; // 对应 ThreadPoolExecutor(max_workers=2)
  }

  notify(event_type, streamer) {
    // 非阻塞：提交后台发送任务
    this._queue.push([event_type, streamer]);
    this._drain();
  }

  _drain() {
    while (this._active < this._maxWorkers && this._queue.length) {
      const [event_type, streamer] = this._queue.shift();
      this._active += 1;
      this._send(event_type, streamer).finally(() => {
        this._active -= 1;
        this._drain();
      });
    }
  }

  async _send(event_type, streamer) {
    try {
      const [ok, msg] = await send_event(this.cfg, event_type, streamer);
      const summary = _streamer_summary(streamer, event_type);
      const sec = streamer.sec_uid || "";
      const rid = streamer.web_rid || "";
      log(ok ? "info" : "warn", `通知[${event_type}]: ${msg} → ${summary}`, sec, rid, "notify_" + event_type);
    } catch (e) {
      const summary = _streamer_summary(streamer, event_type);
      const sec = streamer.sec_uid || "";
      const rid = streamer.web_rid || "";
      log("error", `通知异常[${event_type}]: ${e && e.message ? e.message : e} → ${summary}`, sec, rid, "notify_" + event_type);
    }
  }

  async notify_sync(event_type, streamer) {
    // 同步发送（测试 / API 用）
    const [ok, msg] = await send_event(this.cfg, event_type, streamer);
    const summary = _streamer_summary(streamer, event_type);
    const rid = streamer.web_rid || "";
    log(ok ? "info" : "warn", `通知测试[${event_type}]: ${msg} → ${summary}`, rid, rid, "notify_test");
    return [ok, msg];
  }

  async notify_test(event_type) {
    // 同步发送测试通知（使用内置示例数据）
    const sample = {
      sec_uid: "test_sec_uid",
      web_rid: "1234567890",
      nickname: "测试主播",
      unique_id: "test_user",
      avatar: "",
      room: {
        title: "这是一条测试直播",
        cover: "https://p3.douyinpic.com/aweme/100x100/test.jpeg",
        user_count: "1.2万",
        like_count: "9999",
        streams: [{ key: "HD1", label: "高清", flv: "", hls: "" }],
        live: true,
      },
    };
    return send_event(this.cfg, event_type, sample, { test_mode: true });
  }
}

function _streamer_summary(streamer, event_type) {
  // 生成主播摘要日志片段
  const nickname = streamer.nickname || streamer.web_rid || streamer.sec_uid || "未知";
  const rid = streamer.web_rid || "";
  const room = streamer.room || {};
  const action = event_type === "live_start" ? "开播" : "下播";
  const parts = [`${action}: ${nickname}(${rid})`];
  if (event_type === "live_start") {
    const title = room.title || "";
    if (title) parts.push(`「${title}」`);
  }
  return parts.join(" - ");
}
