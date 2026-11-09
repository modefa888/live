// 监控轮询模块：对应 Python src/app/monitor/monitor.py
import { log } from "../utils/logging.js";
import { getBackend } from "../db/mongo.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);

export class Monitor {
  constructor(client, streamers, config, recorder, broadcast, notifier = null) {
    this.client = client;
    this.streamers = streamers;   // 共享的主播列表引用（与 state.streamers 同一数组）
    this.config = config;
    this.recorder = recorder;
    this.broadcast = broadcast;    // 兼容保留（SSE 已移除，实际不再推送）
    this.notifier = notifier;      // 第三方通知调度器（可选）
    this.stop_flag = false;
    this.last_refresh = 0;
    this.refreshing = false;
    this._runPromise = null;
    this.current_interval = 0;   // 本轮实际生效的间隔（供状态接口展示）
  }

  stop() {
    this.stop_flag = true;
  }

  /** 下一轮间隔：关闭随机时用固定值；开启时在 [min,max] 内随机取整（含端点） */
  nextInterval() {
    const cfg = this.config || {};
    const base = Math.max(10, parseInt(cfg.interval ?? 60, 10) || 60);
    if (!cfg.interval_random) return base;
    let lo = Math.max(10, parseInt(cfg.interval_min ?? base, 10) || base);
    let hi = Math.max(10, parseInt(cfg.interval_max ?? base, 10) || base);
    if (lo > hi) [lo, hi] = [hi, lo];
    return Math.min(3600, Math.max(10, lo + Math.floor(Math.random() * (hi - lo + 1))));
  }

  async run() {
    while (!this.stop_flag) {
      const t0 = Date.now() / 1000;
      try {
        await this.refresh_all(false);
      } catch (e) {
        log("error", `自动刷新异常: ${e && e.message ? e.message : e}`);
      }
      const interval = this.nextInterval();
      this.current_interval = interval;
      const wait = Math.max(5, interval - (Date.now() / 1000 - t0));
      await this._waitOrStop(wait);
    }
  }

  start() {
    if (!this._runPromise) {
      this._runPromise = this.run();
    }
  }

  // 对应 Python stop_flag.wait(wait)：等待指定秒数，若期间 stop 被触发则提前返回
  async _waitOrStop(seconds) {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline && !this.stop_flag) {
      await sleep(Math.min(300, deadline - Date.now()));
    }
  }

  async refresh_all(manual = false, force_fudai = false, opts = null) {
    if (manual) {
      while (this.refreshing && !this.stop_flag) {
        await sleep(500);
      }
      if (this.stop_flag) return;
    }
    if (this.refreshing) return;
    this.refreshing = true;
    this.last_refresh = nowSec();
    try {
      const items = [...this.streamers];
      // 单请求间隔（秒）：主播越多间隔越大，防风控
      // 10 主播 → 0.3s/个 总~3s；50 主播 → 0.5s/个 总~25s；100 主播 → 0.8s/个 总~80s
      const delay = Math.min(1.5, Math.max(0.2, items.length / 150.0 + 0.1));
      const jitter = 0.15; // ±15% 随机抖动
      // opts.deadlineMs：软截止时间（Serverless Cron 调用时限制单轮耗时），到点提前收尾并保存
      const deadline = (opts && opts.deadlineMs) ? Date.now() + opts.deadlineMs : null;
      let refreshed = 0;
      for (let i = 0; i < items.length; i++) {
        if (this.stop_flag) break;
        if (deadline && i > 0 && Date.now() >= deadline) {
          log("info", `刷新达到时间上限，本轮提前结束（已刷新 ${i}/${items.length} 个）`);
          break;
        }
        const s = items[i];
        await this._refresh_one(s, force_fudai);
        refreshed += 1;
        // 每个主播间随机延迟，模拟人工操作节奏
        if (i < items.length - 1) {
          const j = Math.random() * 2 * jitter - jitter;
          await sleep(Math.max(0.2, delay * (1 + j)) * 1000);
        }
      }
      const backend = getBackend();
      await backend.saveStreamers(this.streamers);
      if (manual) {
        this.broadcast({ type: "refresh_done", ts: this.last_refresh, refreshed });
      }
    } finally {
      this.refreshing = false;
    }
  }

  async _refresh_one(s, force_fudai = false) {
    const web_rid = s.web_rid || "";
    if (!s.room || typeof s.room !== "object") s.room = {};
    const room = s.room;
    let sec_uid = s.sec_uid;
    if (!web_rid) {
      const now = Date.now() / 1000;
      if (now - (room.updated_at || 0) > 300) {
        const prof = await this.client.get_profile(sec_uid || "");
        if (prof.ok) {
          s.nickname = prof.nickname || s.nickname || "";
          s.unique_id = prof.unique_id || s.unique_id || "";
          s.avatar = prof.avatar || s.avatar || "";
          room.updated_at = Math.floor(now);
        }
      }
      return;
    }
    let info;
    try {
      info = await this.client.get_room(web_rid);
    } catch (e) {
      room.error = `请求失败: ${e && e.message ? e.message : e}`;
      room.updated_at = nowSec();
      return;
    }
    const d = info.toDict();
    const prev_live = room.live || false;
    if (info.owner_nickname) s.nickname = info.owner_nickname;
    if (info.owner_sec_uid && !s.sec_uid) s.sec_uid = info.owner_sec_uid;
    if (info.owner_avatar) s.avatar = info.owner_avatar;
    sec_uid = s.sec_uid || web_rid;

    if (info.live) {
      if (!prev_live) {
        d.first_seen_live = Date.now() / 1000;
        getBackend().addSession(sec_uid, nowSec(), info.create_time)
          .catch(() => {});
        log("info", `开播: ${info.owner_nickname || web_rid} - 「${info.title}」`, sec_uid, web_rid, "live_start");
        this.broadcast({
          type: "live_start",
          sec_uid,
          web_rid,
          nickname: info.owner_nickname || s.nickname || "",
          title: info.title,
          avatar: info.owner_avatar || s.avatar || "",
        });
        if (this.notifier !== null) {
          this.notifier.notify("live_start", s);
        }
      } else {
        d.first_seen_live = room.first_seen_live ?? Date.now() / 1000;
      }
    } else if (prev_live) {
      const current_start = room.first_seen_live;
      if (current_start) {
        getBackend().endSession(sec_uid, Math.floor(current_start), nowSec())
          .catch(() => {});
        log("info", `下播: ${info.owner_nickname || web_rid} - 「${info.title}」`, sec_uid, web_rid, "live_end");
        if (this.notifier !== null) {
          this.notifier.notify("live_end", s);
        }
      }
    }
    if (info.error) {
      room.error = info.error;
    } else {
      delete room.error;
    }
    Object.assign(room, d);
    room.updated_at = nowSec();

    // ---- 在线人数采样：供详情页曲线图使用（按分钟分桶，重复刷新不会产生重复点）----
    if (info.live && !info.error && d.user_count) {
      getBackend().saveOnlineSample({
        sec_uid,
        web_rid,
        user_count: d.user_count,
        user_count_exact: d.user_count_exact,
        like_count: d.like_count,
        ts: nowSec(),
      }).catch(() => {});
    }

    // ---- 福袋检测（仅直播中 + 主播启用福袋监测）----
    if (info.live && Number(s.fudai_enabled ?? 1)) {
      if (!s.fudai || typeof s.fudai !== "object") s.fudai = { has_fudai: false };
      const prev_fd = s.fudai;
      const has_fudai = prev_fd.has_fudai ?? false;
      const draw_time = Number(prev_fd.draw_time) || 0;
      const now = Date.now() / 1000;

      // 当前福袋还没开奖：只在 draw_time 已到或稍过后重新检测一次（用于确认开奖后是否有新福袋）
      if (has_fudai && draw_time > 0 && now < draw_time + 5) {
        // 福袋进行中，跳过检测直到开奖
      } else {
        // 没有福袋 / 福袋已开奖：每 2 次刷新检测一次新福袋
        let fc = s._fudai_counter;
        if (fc === undefined || fc === null) fc = 2;
        s._fudai_counter = fc + 1;
        if (fc >= 2) {
          s._fudai_counter = 0;
          try {
            const fd = await this.client.get_room_fudai(web_rid, {
              room_id: info.id_str, sec_uid: info.owner_sec_uid,
              anchor_id: info.owner_id, force: force_fudai,
            });
            if (fd.has_fudai) {
              await this._update_fudai(s, sec_uid, web_rid, info, fd.toDict());
            } else if (has_fudai) {
              await this._end_fudai(s, sec_uid, web_rid, info);
            }
          } catch (e) {
            log("warn", `福袋检测失败: ${info.owner_nickname || web_rid} - ${e && e.message ? e.message : e}`, sec_uid, web_rid, "fudai");
          }
        }
      }
    } else {
      delete s._fudai_counter;
      s.fudai = { has_fudai: false, updated_at: nowSec() };
    }
  }

  async _update_fudai(s, sec_uid, web_rid, info, fd_data) {
    if (!s.fudai || typeof s.fudai !== "object") s.fudai = { has_fudai: false };
    const prev_fd = s.fudai;
    const has = Boolean(fd_data.has_fudai ?? true);
    // 持久化福袋状态到数据库
    let backend = null;
    try {
      backend = getBackend();
      fd_data.updated_at = nowSec();
      fd_data.sec_uid = sec_uid;
      await backend.saveFudai(sec_uid, fd_data);
    } catch (e) {
      log("warn", `保存福袋数据失败: ${e && e.message ? e.message : e}`, sec_uid, web_rid, "fudai");
    }
    if (!has) {
      if (prev_fd.has_fudai) {
        await this._end_fudai(s, sec_uid, web_rid, info);
      }
      return;
    }
    if (!prev_fd.has_fudai) {
      // 新福袋出现 → 创建历史记录 + 触发通知
      const draw_id = fd_data.draw_id || fd_data.gift_id || String(fd_data.draw_time ?? "");
      const notified_id = prev_fd.notified_id;
      if (notified_id !== draw_id) {
        prev_fd.notified_id = draw_id;
        if (this.notifier !== null) {
          this.notifier.notify("fudai_start", s);
        }
      }
      // 写入福袋历史记录
      try {
        const backend2 = getBackend();
        await backend2.saveFudaiHistory({
          sec_uid,
          web_rid,
          nickname: info.owner_nickname || s.nickname || "",
          gift_name: fd_data.gift_name || "",
          gift_image: fd_data.gift_image || "",
          lucky_count: fd_data.lucky_count ?? 0,
          candidate_num: fd_data.candidate_num ?? 0,
          remain_seconds: fd_data.remain_seconds ?? 0,
          draw_time: fd_data.draw_time ?? 0,
          draw_id,
          conditions: fd_data.conditions || [],
          method: fd_data.method || "",
          started_at: nowSec(),
        });
      } catch (e) {
        log("warn", `保存福袋历史记录失败: ${e && e.message ? e.message : e}`, sec_uid, web_rid, "fudai");
      }
      const mtd = fd_data.method || "?";
      log("info", `福袋: ${info.owner_nickname || web_rid} → ${fd_data.gift_name || "未知"}，剩余${fd_data.remain_seconds ?? "?"}s[${mtd}]`, sec_uid, web_rid, "fudai");
      this.broadcast({
        type: "fudai_start",
        sec_uid,
        web_rid,
        nickname: info.owner_nickname || s.nickname || "",
        fudai: fd_data,
      });
    }
    Object.assign(prev_fd, fd_data);
    prev_fd.has_fudai = true;
    prev_fd.updated_at = nowSec();
  }

  async _end_fudai(s, sec_uid, web_rid, info) {
    const nickname = s.nickname || web_rid;
    // 更新福袋历史记录的 ended_at（与 Python 一致：此处为简化占位处理）
    try {
      const backend = getBackend();
      // 通过 fudai 表获取 draw_id（原版未实现直接更新，仅做查询）
      const fudai_data = await backend.getFudai(sec_uid);
      const _draw_id = fudai_data ? (fudai_data.draw_id || "") : "";
    } catch (e) {
      log("warn", `更新福袋历史记录失败: ${e && e.message ? e.message : e}`, sec_uid, web_rid, "fudai");
    }
    log("info", `福袋结束: ${info.owner_nickname || nickname}(${web_rid})`, sec_uid, web_rid, "fudai_end");
    this.broadcast({
      type: "fudai_end",
      sec_uid,
      web_rid,
      nickname,
    });
    s.fudai = { has_fudai: false, updated_at: nowSec() };
  }

  async history_stats(s) {
    const sec_uid = s.sec_uid || (s.web_rid || "");
    if (!sec_uid) {
      return { today_count: 0, today_duration: 0, last_start: null };
    }
    const backend = getBackend();
    const stats = await backend.getStatsToday(sec_uid);
    stats.last_start = await backend.getLastStart(sec_uid);
    return stats;
  }
}
