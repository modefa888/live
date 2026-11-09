// MongoDB 存储后端：对应 Python src/app/storage/db.py（HistoryDB）+ db_mysql.py 的少量附加方法
// 方法名与 db.py 保持一致（snake_case），便于逐行对照移植调用方（server/monitor）。
// SQLite 的 AUTOINCREMENT id 用 counters 集合模拟，保证管理后台按 id 编辑/删除的行为一致。
import { MongoClient } from "mongodb";
import crypto from "node:crypto";
import { MONGO_URI, MONGO_DB } from "../utils/constants.js";
import { parseCount } from "../utils/misc.js";

const nowSec = () => Math.floor(Date.now() / 1000);

export class MongoHistoryDB {
  constructor(uri = MONGO_URI, dbName = MONGO_DB) {
    this.uri = uri;
    this.dbName = dbName;
    this.client = null;
    this.db = null;
    this._connectPromise = null;
  }

  /** 建立连接并初始化集合/索引（幂等，多次调用返回同一 Promise） */
  connect() {
    if (!this._connectPromise) {
      this._connectPromise = (async () => {
        this.client = new MongoClient(this.uri, {
          serverSelectionTimeoutMS: 8000,
          connectTimeoutMS: 8000,
        });
        await this.client.connect();
        await this.client.db("admin").command({ ping: 1 });
        this.db = this.client.db(this.dbName);
        await this._initIndexes();
        return this;
      })();
    }
    return this._connectPromise;
  }

  async _ensure() {
    if (!this.db) await this.connect();
    return this.db;
  }

  async _initIndexes() {
    const db = this.db;
    await Promise.all([
      db.collection("config").createIndex({ key: 1 }, { unique: true }),
      db.collection("streamers").createIndex({ key: 1 }, { unique: true }),
      db.collection("streamers").createIndex({ sec_uid: 1 }),
      db.collection("streamers").createIndex({ web_rid: 1 }),
      db.collection("user_streamers").createIndex({ user_id: 1 }),
      db.collection("user_streamers").createIndex({ user_id: 1, streamer_id: 1 }, { unique: true }),
      db.collection("history").createIndex({ sec_uid: 1, start_time: 1 }, { unique: true }),
      db.collection("history").createIndex({ start_time: 1 }),
      // 在线人数采样：同一主播同一分钟只保留一个点；历史数据保留 90 天
      db.collection("online_samples").createIndex({ sec_uid: 1, minute: 1 }, { unique: true }),
      db.collection("online_samples").createIndex({ created_at: 1 }, { expireAfterSeconds: 90 * 86400 }),
      db.collection("recordings").createIndex({ file_path: 1 }, { unique: true }),
      db.collection("recordings").createIndex({ sec_uid: 1 }),
      db.collection("recordings").createIndex({ start_time: 1 }),
      db.collection("logs").createIndex({ ts: 1 }),
      db.collection("logs").createIndex({ sec_uid: 1 }),
      db.collection("notify_logs").createIndex({ ts: 1 }),
      db.collection("notify_logs").createIndex({ event_type: 1 }),
      db.collection("fudai").createIndex({ sec_uid: 1 }, { unique: true }),
      db.collection("fudai_history").createIndex({ sec_uid: 1 }),
      db.collection("fudai_history").createIndex({ started_at: 1 }),
      db.collection("accounts").createIndex({ username: 1 }, { unique: true }),
      // 登录会话持久化（跨实例共享；30 天自动过期）
      db.collection("sessions").createIndex({ token: 1 }, { unique: true }),
      db.collection("sessions").createIndex({ created_at: 1 }, { expireAfterSeconds: 30 * 86400 }),
      // 个人解析 Cookie：按登录账号隔离（不进 config 集合、不出现在后台表）
      db.collection("parse_cookies").createIndex({ username: 1 }, { unique: true }),
      // 解析记录：作品 / 用户主页，按账号隔离、按时间倒序
      db.collection("parse_history").createIndex({ username: 1, type: 1, created_at: -1 }),
    ]);
  }

  /** 获取集合（未连接时返回 null，供调用方降级处理） */
  collection(name) {
    return this.db ? this.db.collection(name) : null;
  }

  /** 模拟 SQLite AUTOINCREMENT（counters 集合原子自增） */
  async _nextId(name) {
    const db = await this._ensure();
    const r = await db.collection("counters").findOneAndUpdate(
      { _id: name },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after" }
    );
    return r ? r.seq : 1;
  }

  // ================= config =================

  /** 读取配置并按 defaults 的类型强制转换（未知 key 跳过） */
  async loadConfig(defaults) {
    const db = await this._ensure();
    const cfg = { ...defaults };
    const rows = await db.collection("config").find({}).toArray();
    for (const row of rows) {
      const { key, value } = row;
      if (!(key in defaults)) continue;
      const def = defaults[key];
      if (typeof def === "boolean") {
        cfg[key] = ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
      } else if (Number.isInteger(def)) {
        const n = parseInt(value, 10);
        cfg[key] = Number.isNaN(n) ? def : n;
      } else {
        cfg[key] = value ?? "";
      }
    }
    return cfg;
  }

  /** 直接读取 config 表所有行（管理后台用，不经 defaults 过滤） */
  async loadConfigAll() {
    const db = await this._ensure();
    const rows = await db.collection("config").find({}).sort({ key: 1 }).toArray();
    return rows.map((r) => ({ key: r.key, value: r.value ?? "" }));
  }

  async saveConfig(cfg) {
    const db = await this._ensure();
    const ops = [];
    for (const [key, value] of Object.entries(cfg)) {
      const stored = (value !== null && typeof value === "object")
        ? JSON.stringify(value)
        : String(value);
      ops.push({ replaceOne: { filter: { key }, replacement: { key, value: stored }, upsert: true } });
    }
    if (ops.length) await db.collection("config").bulkWrite(ops, { ordered: false });
  }

  async hasConfig() {
    const db = await this._ensure();
    const row = await db.collection("config").findOne({}, { projection: { _id: 1 } });
    return !!row;
  }

  /** 存储后端选择（兼容键；Node 版实际固定为 MongoDB） */
  async getStorageBackend() {
    const db = await this._ensure();
    const row = await db.collection("config").findOne({ key: "storage_backend" });
    return row ? row.value : null;
  }

  async setStorageBackend(backend) {
    const db = await this._ensure();
    await db.collection("config").updateOne(
      { key: "storage_backend" },
      { $set: { value: backend } },
      { upsert: true }
    );
  }

  // ================= streamers =================

  async loadStreamers() {
    const db = await this._ensure();
    const rows = await db.collection("streamers")
      .find({}).sort({ created_at: 1, id: 1 }).toArray();
    return rows.map((r) => ({
      sec_uid: r.sec_uid || "",
      web_rid: r.web_rid || "",
      room_id: r.room_id || "",
      nickname: r.nickname || "",
      unique_id: r.unique_id || "",
      avatar: r.avatar || "",
      note: r.note || "",
      room: (r.room && typeof r.room === "object") ? r.room : {},
      created_at: Number(r.created_at) || nowSec(),
      pinned: Number(r.pinned) || 0,
      fudai_enabled: (r.fudai_enabled === undefined || r.fudai_enabled === null) ? 1 : (Number(r.fudai_enabled) || 0),
    }));
  }

  async saveStreamers(streamers) {
    const db = await this._ensure();
    const coll = db.collection("streamers");
    const keys = [];
    const ops = [];
    const ts = nowSec();
    for (const s of streamers || []) {
      const key = s.sec_uid || s.web_rid;
      if (!key) continue;
      keys.push(key);
      ops.push({
        replaceOne: {
          filter: { key },
          replacement: {
            key,
            sec_uid: s.sec_uid ?? "",
            web_rid: s.web_rid ?? "",
            room_id: s.room_id ?? "",
            nickname: s.nickname ?? "",
            unique_id: s.unique_id ?? "",
            avatar: s.avatar ?? "",
            note: s.note ?? "",
            room: (s.room && typeof s.room === "object") ? s.room : {},
            created_at: Number(s.created_at) || ts,
            updated_at: ts,
            pinned: Number(s.pinned ?? 0) || 0,
            fudai_enabled: Number(s.fudai_enabled ?? 1) || 0,
          },
          upsert: true,
        },
      });
    }
    // 删除已不在列表中的主播（对应 Python 的 DELETE 全表后重插）
    if (keys.length) {
      await coll.deleteMany({ key: { $nin: keys } });
    } else {
      await coll.deleteMany({});
    }
    if (ops.length) await coll.bulkWrite(ops, { ordered: false });
  }

  async hasStreamers() {
    const db = await this._ensure();
    const row = await db.collection("streamers").findOne({}, { projection: { _id: 1 } });
    return !!row;
  }

  // ---------- 用户-主播关联 ----------

  async addUserStreamer(userId, streamerId) {
    const db = await this._ensure();
    await db.collection("user_streamers").updateOne(
      { user_id: userId, streamer_id: streamerId },
      { $setOnInsert: { user_id: userId, streamer_id: streamerId, created_at: nowSec() } },
      { upsert: true }
    );
  }

  async removeUserStreamer(userId, streamerId) {
    const db = await this._ensure();
    await db.collection("user_streamers").deleteMany({ user_id: userId, streamer_id: streamerId });
  }

  async loadUserStreamerIds(userId) {
    const db = await this._ensure();
    const rows = await db.collection("user_streamers")
      .find({ user_id: userId }, { projection: { streamer_id: 1 } }).toArray();
    return rows.map((r) => r.streamer_id);
  }

  // ================= 开播历史（history） =================

  async addSession(secUid, startTime, createTime = null) {
    const db = await this._ensure();
    await db.collection("history").updateOne(
      { sec_uid: secUid, start_time: Number(startTime) },
      { $setOnInsert: { id: await this._nextId("history"), sec_uid: secUid, start_time: Number(startTime), end_time: null, create_time: createTime ? Number(createTime) : null, duration: 0 } },
      { upsert: true }
    );
  }

  async endSession(secUid, startTime, endTime) {
    const db = await this._ensure();
    const end = Number(endTime);
    await db.collection("history").updateMany(
      { sec_uid: secUid, start_time: Number(startTime), end_time: null },
      { $set: { end_time: end, duration: end - Number(startTime) } }
    );
  }

  async getStatsToday(secUid) {
    const db = await this._ensure();
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    const todayStart = Math.floor(d.getTime() / 1000);
    const coll = db.collection("history");
    const agg = await coll.aggregate([
      { $match: { sec_uid: secUid, start_time: { $gte: todayStart }, end_time: { $ne: null } } },
      { $group: { _id: null, count: { $sum: 1 }, total: { $sum: "$duration" } } },
    ]).toArray();
    let count = agg.length ? agg[0].count : 0;
    let total = agg.length ? (agg[0].total || 0) : 0;
    const open = await coll.findOne(
      { sec_uid: secUid, end_time: null, start_time: { $gte: todayStart } },
      { projection: { start_time: 1 } }
    );
    if (open) {
      count += 1;
      total += nowSec() - open.start_time;
    }
    return { today_count: count, today_duration: total };
  }

  async getLastStart(secUid) {
    const db = await this._ensure();
    const row = await db.collection("history")
      .find({ sec_uid: secUid }).sort({ start_time: -1 }).limit(1).toArray();
    return row.length ? row[0].start_time : null;
  }

  async getHistory(limit = 200, offset = 0, order = "desc") {
    const db = await this._ensure();
    const dir = order && String(order).toLowerCase() === "desc" ? -1 : 1;
    const rows = await db.collection("history")
      .find({}).sort({ start_time: dir }).skip(offset).limit(limit).toArray();
    return rows.map((r) => ({
      id: r.id, sec_uid: r.sec_uid, start_time: r.start_time,
      end_time: r.end_time, create_time: r.create_time, duration: r.duration || 0,
    }));
  }

  // ================= 在线人数采样（online_samples） =================

  /** 写入采样点；同一主播同一分钟只保留最后一次（详情页刷新不会刷出一堆重复点） */
  async saveOnlineSample({ sec_uid = "", web_rid = "", user_count = "", user_count_exact = null, like_count = 0, ts = 0 } = {}) {
    // 优先用未分档的精确人数；取不到时才解析 "400+" / "1.2万" 这类展示值，并标记为近似
    const exact = parseCount(user_count_exact);
    const count = exact ?? parseCount(user_count);
    if (count === null) return false;
    const db = await this._ensure();
    const t = Number(ts) || nowSec();
    const minute = Math.floor(t / 60);
    await db.collection("online_samples").updateOne(
      { sec_uid: String(sec_uid), minute },
      {
        $set: {
          web_rid: String(web_rid || ""),
          ts: t,
          count,
          exact: exact !== null ? 1 : 0,
          like_count: parseCount(like_count) ?? 0,
        },
        $setOnInsert: { created_at: new Date(t * 1000) },
      },
      { upsert: true }
    );
    return true;
  }

  /** 按主播 + 时间窗口读取采样点（升序），用于绘制在线人数曲线 */
  async getOnlineSamples({ secUid = "", webRid = "", since = 0, until = 0, limit = 20000 } = {}) {
    const db = await this._ensure();
    const ids = [...new Set([secUid, webRid].filter(Boolean).map(String))];
    const filter = {};
    // 早期记录可能只有 web_rid（sec_uid 尚未解析出来），两种标识都能命中
    if (ids.length) filter.$or = [{ sec_uid: { $in: ids } }, { web_rid: { $in: ids } }];
    const start = Number(since) || 0;
    const end = Number(until) || 0;
    if (start || end) {
      const range = {};
      if (start) range.$gte = start;
      if (end) range.$lte = end;
      filter.ts = range;
    }
    const max = Math.min(Math.max(1, Number(limit) || 20000), 50000);
    const rows = await db.collection("online_samples")
      .find(filter, { projection: { ts: 1, count: 1, like_count: 1, exact: 1 } })
      .sort({ ts: 1 }).limit(max).toArray();
    return rows.map((r) => ({
      ts: Number(r.ts) || 0,
      count: Number(r.count) || 0,
      like_count: Number(r.like_count) || 0,
      // 旧数据没有 exact 字段，视为 "400+" 式的分档近似值
      exact: r.exact === 1 ? 1 : 0,
    }));
  }

  // ================= 录播记录（recordings） =================

  async addRecording(secUid, nickname, webRid, filePath, startTime, endTime, duration, size, label, method, keep = 0) {
    const db = await this._ensure();
    const doc = {
      id: await this._nextId("recordings"),
      sec_uid: secUid,
      nickname: nickname ?? "",
      web_rid: webRid ?? "",
      file_path: filePath,
      start_time: Number(startTime),
      end_time: Number(endTime),
      duration: Number(duration),
      size: Number(size),
      label: label ?? "",
      method: method ?? "",
      keep: 0, // 与 Python 一致：keep 恒为 0
    };
    await db.collection("recordings").replaceOne({ file_path: filePath }, doc, { upsert: true });
  }

  async getRecordingHistory(limit = 200, offset = 0) {
    const db = await this._ensure();
    const rows = await db.collection("recordings")
      .find({}).sort({ start_time: -1 }).skip(offset).limit(limit).toArray();
    return rows.map((r) => ({
      id: r.id, sec_uid: r.sec_uid, nickname: r.nickname, web_rid: r.web_rid,
      file_path: r.file_path, start_time: r.start_time, end_time: r.end_time,
      duration: r.duration || 0, size: r.size || 0, label: r.label, method: r.method,
    }));
  }

  // ================= logs =================

  async saveLog(level, msg, secUid = "", webRid = "", eventType = "") {
    const db = await this._ensure();
    await db.collection("logs").insertOne({
      id: await this._nextId("logs"),
      ts: nowSec(),
      level: String(level),
      msg: String(msg).slice(0, 2000),
      sec_uid: String(secUid),
      web_rid: String(webRid),
      event_type: String(eventType),
    });
  }

  async getLogs(secUid = "", limit = 200, offset = 0) {
    const db = await this._ensure();
    const filter = secUid ? { sec_uid: secUid } : {};
    const rows = await db.collection("logs")
      .find(filter, { projection: { ts: 1, level: 1, msg: 1, sec_uid: 1, web_rid: 1, event_type: 1 } })
      .sort({ ts: -1 }).skip(offset).limit(limit).toArray();
    return rows.map((r) => ({
      ts: r.ts, level: r.level, msg: r.msg,
      sec_uid: r.sec_uid, web_rid: r.web_rid, event_type: r.event_type,
    }));
  }

  // ================= notify_logs =================

  async saveNotifyLog(ts, streamerSecUid, streamerNickname, eventType, channel, status, message) {
    const db = await this._ensure();
    await db.collection("notify_logs").insertOne({
      id: await this._nextId("notify_logs"),
      ts: ts ? Number(ts) : nowSec(),
      streamer_sec_uid: streamerSecUid || "",
      streamer_nickname: streamerNickname || "",
      event_type: eventType || "",
      channel: channel || "",
      status: status || "",
      message: (message || "").slice(0, 500),
    });
  }

  async getNotifyLogs(secUid = "", channel = "", eventType = "", limit = 200, offset = 0) {
    const db = await this._ensure();
    const filter = {};
    if (secUid) filter.streamer_sec_uid = secUid;
    if (channel) filter.channel = channel;
    if (eventType) filter.event_type = eventType;
    const rows = await db.collection("notify_logs")
      .find(filter).sort({ ts: -1 }).skip(offset).limit(limit).toArray();
    return rows.map((r) => ({
      id: r.id, ts: r.ts, streamer_sec_uid: r.streamer_sec_uid,
      streamer_nickname: r.streamer_nickname, event_type: r.event_type,
      channel: r.channel, status: r.status, message: r.message,
    }));
  }

  // ================= fudai（当前状态） =================

  async saveFudai(secUid, data) {
    const db = await this._ensure();
    const doc = {
      id: await this._nextId("fudai"),
      sec_uid: secUid,
      gift_name: data.gift_name ?? "",
      gift_image: data.gift_image ?? "",
      lucky_count: Number(data.lucky_count) || 0,
      candidate_num: Number(data.candidate_num) || 0,
      remain_seconds: Number(data.remain_seconds) || 0,
      draw_time: Number(data.draw_time) || 0,
      draw_id: data.draw_id || data.gift_id || "",
      conditions: Array.isArray(data.conditions) ? data.conditions : [],
      method: data.method || "",
      updated_at: Number(data.updated_at) || nowSec(),
    };
    await db.collection("fudai").replaceOne({ sec_uid: secUid }, doc, { upsert: true });
  }

  async getFudai(secUid) {
    const db = await this._ensure();
    const r = await db.collection("fudai").findOne({ sec_uid: secUid });
    if (!r) return null;
    return {
      gift_name: r.gift_name || "",
      gift_image: r.gift_image || "",
      lucky_count: Number(r.lucky_count) || 0,
      candidate_num: Number(r.candidate_num) || 0,
      remain_seconds: Number(r.remain_seconds) || 0,
      draw_time: Number(r.draw_time) || 0,
      draw_id: r.draw_id || "",
      conditions: Array.isArray(r.conditions) ? r.conditions : [],
      method: r.method || "",
      updated_at: Number(r.updated_at) || 0,
    };
  }

  async getAllFudai(limit = 200, offset = 0) {
    const db = await this._ensure();
    const rows = await db.collection("fudai")
      .find({}).sort({ draw_time: -1 }).skip(offset).limit(limit).toArray();
    return rows.map((r) => ({
      sec_uid: r.sec_uid || "",
      gift_name: r.gift_name || "",
      gift_image: r.gift_image || "",
      lucky_count: Number(r.lucky_count) || 0,
      candidate_num: Number(r.candidate_num) || 0,
      remain_seconds: Number(r.remain_seconds) || 0,
      draw_time: Number(r.draw_time) || 0,
      draw_id: r.draw_id || "",
      conditions: Array.isArray(r.conditions) ? r.conditions : [],
      method: r.method || "",
      updated_at: Number(r.updated_at) || 0,
    }));
  }

  // ================= fudai_history =================

  async saveFudaiHistory(data) {
    const db = await this._ensure();
    await db.collection("fudai_history").insertOne({
      id: await this._nextId("fudai_history"),
      sec_uid: data.sec_uid ?? "",
      web_rid: data.web_rid ?? "",
      nickname: data.nickname ?? "",
      gift_name: data.gift_name ?? "",
      gift_image: data.gift_image ?? "",
      lucky_count: Number(data.lucky_count) || 0,
      candidate_num: Number(data.candidate_num) || 0,
      remain_seconds: Number(data.remain_seconds) || 0,
      draw_time: Number(data.draw_time) || 0,
      draw_id: data.draw_id || "",
      conditions: Array.isArray(data.conditions) ? data.conditions : [],
      method: data.method || "",
      started_at: Number(data.started_at || data.ts) || nowSec(),
      ended_at: Number(data.ended_at) || 0,
    });
  }

  async getFudaiHistory(secUid = "", limit = 200, offset = 0) {
    const db = await this._ensure();
    const filter = secUid ? { sec_uid: secUid } : {};
    const rows = await db.collection("fudai_history")
      .find(filter).sort({ started_at: -1 }).skip(offset).limit(limit).toArray();
    return rows.map((r) => ({
      id: r.id, sec_uid: r.sec_uid, web_rid: r.web_rid, nickname: r.nickname,
      gift_name: r.gift_name || "", gift_image: r.gift_image || "",
      lucky_count: Number(r.lucky_count) || 0, candidate_num: Number(r.candidate_num) || 0,
      remain_seconds: Number(r.remain_seconds) || 0, draw_time: Number(r.draw_time) || 0,
      draw_id: r.draw_id || "",
      conditions: Array.isArray(r.conditions) ? r.conditions : [],
      method: r.method || "",
      started_at: Number(r.started_at) || 0, ended_at: Number(r.ended_at) || 0,
    }));
  }

  // ================= accounts =================

  _hashPassword(password, salt = null) {
    if (salt === null) salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.createHash("sha256").update(String(password) + salt, "utf-8").digest("hex");
    return [hash, salt];
  }

  /** 创建新账号。返回 { ok, msg } */
  async createAccount(username, password, role = "admin") {
    const db = await this._ensure();
    const existing = await db.collection("accounts").findOne({ username });
    if (existing) return { ok: false, msg: "用户名已存在" };
    const [pwdHash, salt] = this._hashPassword(password);
    const ts = nowSec();
    await db.collection("accounts").insertOne({
      id: await this._nextId("accounts"),
      username, password_hash: pwdHash, role, salt,
      created_at: ts, updated_at: ts, login_at: 0,
    });
    return { ok: true, msg: "创建成功" };
  }

  /** 验证账号密码。返回 { ok, user|null } */
  async authenticate(username, password) {
    const db = await this._ensure();
    const row = await db.collection("accounts").findOne({ username });
    if (!row) return { ok: false, user: null };
    const [testHash] = this._hashPassword(password, row.salt);
    if (testHash !== row.password_hash) return { ok: false, user: null };
    const ts = nowSec();
    await db.collection("accounts").updateOne({ _id: row._id }, { $set: { login_at: ts } });
    return {
      ok: true,
      user: {
        id: row.id, username: row.username,
        role: row.role || "admin", login_at: Number(row.login_at) || 0,
      },
    };
  }

  /** 获取账号信息（不含密码哈希） */
  async getAccount(username) {
    const db = await this._ensure();
    const row = await db.collection("accounts").findOne({ username });
    if (!row) return null;
    return {
      id: row.id, username: row.username, role: row.role || "admin",
      salt: row.salt || "",
      created_at: Number(row.created_at) || 0,
      updated_at: Number(row.updated_at) || 0,
      login_at: Number(row.login_at) || 0,
    };
  }

  /** 修改密码。返回 { ok, msg } */
  async changePassword(username, oldPassword, newPassword) {
    const db = await this._ensure();
    const row = await db.collection("accounts").findOne({ username });
    if (!row) return { ok: false, msg: "用户不存在" };
    const [testHash] = this._hashPassword(oldPassword, row.salt);
    if (testHash !== row.password_hash) return { ok: false, msg: "旧密码不正确" };
    const [newHash, newSalt] = this._hashPassword(newPassword);
    await db.collection("accounts").updateOne(
      { _id: row._id },
      { $set: { password_hash: newHash, salt: newSalt, updated_at: nowSec() } }
    );
    return { ok: true, msg: "密码修改成功" };
  }

  /** 列出所有账号（不含密码哈希） */
  async listAccounts(limit = 200, offset = 0) {
    const db = await this._ensure();
    const rows = await db.collection("accounts")
      .find({}, { projection: { id: 1, username: 1, role: 1, created_at: 1, updated_at: 1, login_at: 1 } })
      .sort({ created_at: 1 }).skip(offset).limit(limit).toArray();
    return rows.map((r) => ({
      id: r.id, username: r.username, role: r.role || "admin",
      created_at: Number(r.created_at) || 0, updated_at: Number(r.updated_at) || 0,
      login_at: Number(r.login_at) || 0,
    }));
  }

  // ================= 个人解析 Cookie（按登录账号隔离，仅供作品/主页解析使用） =================

  /** 保存/覆盖某账号的解析 Cookie；不写入 config、不记日志 */
  async saveParseCookie(username, cookie) {
    const db = await this._ensure();
    await db.collection("parse_cookies").updateOne(
      { username: String(username) },
      { $set: { username: String(username), cookie: String(cookie || ""), updated_at: nowSec() } },
      { upsert: true },
    );
  }

  /** 读取某账号的解析 Cookie（仅服务端内部调用，接口不回传明文） */
  async getParseCookie(username) {
    const db = await this._ensure();
    const row = await db.collection("parse_cookies").findOne({ username: String(username) });
    return row ? String(row.cookie || "") : "";
  }

  async deleteParseCookie(username) {
    const db = await this._ensure();
    await db.collection("parse_cookies").deleteOne({ username: String(username) });
  }

  // ================= 解析记录（作品 / 主页，按登录账号隔离） =================

  /** 同一账号 + 类型 + 作品/用户 key 只保留一条，写入后超出 50 条的旧记录自动清理 */
  async saveParseHistory(id, doc) {
    const db = await this._ensure();
    await db.collection("parse_history").updateOne({ _id: id }, { $set: doc }, { upsert: true });
    const stale = await db.collection("parse_history")
      .find({ username: doc.username, type: doc.type }, { projection: { _id: 1 } })
      .sort({ created_at: -1 }).skip(50).toArray();
    if (stale.length) {
      await db.collection("parse_history").deleteMany({ _id: { $in: stale.map((x) => x._id) } });
    }
  }

  /** 列表不返回完整解析结果，避免一次拉回大量数据 */
  async listParseHistory(username, type = "") {
    const db = await this._ensure();
    const filter = type ? { username, type } : { username };
    const rows = await db.collection("parse_history")
      .find(filter, { projection: { result: 0 } })
      .sort({ created_at: -1 }).limit(50).toArray();
    return rows.map((r) => ({
      id: String(r._id), type: r.type, key: r.key || "",
      title: r.title || "", subtitle: r.subtitle || "", cover: r.cover || "",
      input: r.input || "", created_at: Number(r.created_at) || 0,
    }));
  }

  /** 读取单条完整结果，强制校验归属账号 */
  async getParseHistory(username, id) {
    const db = await this._ensure();
    const row = await db.collection("parse_history").findOne({ _id: id, username });
    if (!row) return null;
    return {
      id: String(row._id), type: row.type, key: row.key || "",
      title: row.title || "", subtitle: row.subtitle || "", cover: row.cover || "",
      input: row.input || "", created_at: Number(row.created_at) || 0,
      result: row.result || null,
    };
  }

  /** 删除单条；未指定 id 时按类型清空该账号记录 */
  async removeParseHistory(username, id = "", type = "") {
    const db = await this._ensure();
    if (id) {
      await db.collection("parse_history").deleteOne({ _id: id, username });
    } else if (type) {
      await db.collection("parse_history").deleteMany({ username, type });
    } else {
      await db.collection("parse_history").deleteMany({ username });
    }
  }

  // ================= 管理后台计数 =================

  async countLogs(secUid = "") {
    const db = await this._ensure();
    return db.collection("logs").countDocuments(secUid ? { sec_uid: secUid } : {});
  }

  async countHistory() {
    const db = await this._ensure();
    return db.collection("history").countDocuments({});
  }

  async countRecordings() {
    const db = await this._ensure();
    return db.collection("recordings").countDocuments({});
  }

  async countNotifyLogs(secUid = "", channel = "", eventType = "") {
    const db = await this._ensure();
    const filter = {};
    if (secUid) filter.streamer_sec_uid = secUid;
    if (channel) filter.channel = channel;
    if (eventType) filter.event_type = eventType;
    return db.collection("notify_logs").countDocuments(filter);
  }

  async countFudai() {
    const db = await this._ensure();
    return db.collection("fudai").countDocuments({});
  }

  async countFudaiHistory(secUid = "") {
    const db = await this._ensure();
    return db.collection("fudai_history").countDocuments(secUid ? { sec_uid: secUid } : {});
  }

  async countAccounts() {
    const db = await this._ensure();
    return db.collection("accounts").countDocuments({});
  }

  async countConfig() {
    const db = await this._ensure();
    return db.collection("config").countDocuments({});
  }

  async countStreamers() {
    const db = await this._ensure();
    return db.collection("streamers").countDocuments({});
  }

  /** 返回账号总数 */
  async accountCount() {
    const db = await this._ensure();
    return db.collection("accounts").countDocuments({});
  }

  // ================= 附加（对应 db_mysql.py 的兼容方法） =================

  /** 各表计数（Node 版全部指向同一 MongoDB） */
  async getTableCounts() {
    const names = ["config", "streamers", "history", "recordings", "logs", "notify_logs", "fudai", "fudai_history", "accounts"];
    const db = await this._ensure();
    const out = {};
    for (const n of names) {
      out[n] = await db.collection(n).countDocuments({});
    }
    return out;
  }

  /** 测试连接，返回 { ok, msg } */
  async testConnection() {
    try {
      await this.connect();
      let version = "";
      try {
        const info = await this.client.db("admin").command({ buildInfo: 1 });
        version = info.version || "";
      } catch {}
      return { ok: true, msg: `MongoDB ${version} · 数据库 ${this.dbName} 连接正常` };
    } catch (e) {
      return { ok: false, msg: e && e.message ? e.message : String(e) };
    }
  }

  /** 存储状态（供 /api/storage/status）：连接信息 + 各集合计数 */
  async getStatus() {
    try {
      await this.connect();
      let version = "";
      try {
        const info = await this.client.db("admin").command({ buildInfo: 1 });
        version = info.version || "";
      } catch {}
      const counts = await this.getTableCounts();
      let addr = "127.0.0.1:27017";
      try {
        const masked = this.uri.replace(/\/\/([^:/]+):([^@]+)@/, "//$1:***@");
        addr = new URL(masked.replace("mongodb://", "http://")).host;
      } catch {}
      return {
        ok: true,
        msg: `MongoDB ${version}`.trim(),
        db: this.dbName,
        addr: `${addr} / ${this.dbName}`,
        counts,
      };
    } catch (e) {
      return {
        ok: false,
        msg: e && e.message ? e.message : String(e),
        db: this.dbName,
        addr: "",
        counts: {},
      };
    }
  }

  /**
   * 兼容 /api/storage/copy：Node 版只有单一 MongoDB 后端，
   * sqlite/mysql 双向复制退化为同库复制（无操作），返回与 Python 相同形状的结果。
   */
  async copyBetween(_source, _target, tables = null) {
    const counts = await this.getTableCounts();
    const names = tables && tables.length ? tables : Object.keys(counts);
    const results = {};
    for (const t of names) {
      results[t] = { ok: true, count: counts[t] || 0 };
    }
    return results;
  }

  /** 兼容旧切换流程（切到 mysql 时先迁移数据）——Node 版为空操作 */
  async migrateFromSqlite() {
    return { ok: true };
  }

  // ================= 管理后台记录编辑/删除（对应 server.py 的直接 SQL 操作） =================

  async adminUpdateConfig(key, value) {
    const db = await this._ensure();
    await db.collection("config").updateOne({ key }, { $set: { value: String(value) } });
  }

  async adminDeleteConfig(key) {
    const db = await this._ensure();
    await db.collection("config").deleteOne({ key });
  }

  /** 按 id 更新记录（history/recordings/logs/notify_logs/fudai/fudai_history/accounts） */
  async adminUpdateById(table, id, changes) {
    const db = await this._ensure();
    const set = {};
    for (const [k, v] of Object.entries(changes)) {
      if (table === "accounts" && (k === "password_hash" || k === "salt")) continue; // 与 Python 一致：跳过密码字段
      let val = v;
      if (k === "conditions" && typeof val === "string") {
        try {
          const p = JSON.parse(val);
          if (Array.isArray(p)) val = p;
        } catch {}
      }
      set[k] = val;
    }
    const numId = parseInt(id, 10);
    if (Number.isNaN(numId)) throw new Error("无效的记录 ID");
    await db.collection(table).updateOne({ id: numId }, { $set: set });
  }

  /** 按 id 删除记录 */
  async adminDeleteById(table, id) {
    const db = await this._ensure();
    const numId = parseInt(id, 10);
    if (Number.isNaN(numId)) throw new Error("无效的记录 ID");
    await db.collection(table).deleteOne({ id: numId });
  }

  async close() {
    if (this.client) {
      try { await this.client.close(); } catch {}
      this.client = null;
      this.db = null;
      this._connectPromise = null;
    }
  }
}

// ---------- 后端工厂（对应 db.py 底部的 get_backend / set_current_backend） ----------
// Node 版只有一种后端；sqlite/mysql 名称作为别名统一指向 MongoDB 实例。

let HISTORY_DB = null;
const STORAGE_BACKENDS = {};
let CURRENT_BACKEND = "sqlite";

export function getBackend(name = null) {
  if (name === null) name = CURRENT_BACKEND;
  if (!STORAGE_BACKENDS[name]) {
    // 所有名称（sqlite/mysql/mongo）共享同一个 MongoDB 实例
    if (!HISTORY_DB) HISTORY_DB = new MongoHistoryDB();
    STORAGE_BACKENDS[name] = HISTORY_DB;
  }
  return STORAGE_BACKENDS[name];
}

export function setCurrentBackend(name) {
  getBackend(name); // 确保实例存在
  CURRENT_BACKEND = name;
}

export function getCurrentBackendName() {
  return CURRENT_BACKEND;
}
