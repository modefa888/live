# 抖音直播监控 · Node.js + MongoDB 版

根目录 Python 版（`main.py` + `src/app`）的完整复刻：功能与前端样式**一模一样**（`public/index.html`、`public/admin.html` 为原文件字节级复制），技术栈替换为 **Node.js + MongoDB**。

## 架构

```
live/
├─ index.js              # 入口（对应 main.py）
├─ public/               # 前端页面（与 Python 版字节一致）
│  ├─ index.html         # 主页面（监控/播放/录制/广场/详情/设置）
│  ├─ admin.html         # 后台管理（仪表盘/表编辑/设置/备份/通知）
│  └─ js/                # flv.min.js / hls.min.js（页面未引用，保留资产）
├─ src/
│  ├─ utils/             # constants / httputil / logging / misc / config / backup
│  ├─ db/mongo.js        # MongoDB 存储层（对应 db.py 全部方法）
│  ├─ collectors/        # 抖音采集（room/profile/fudai/search/hot/square）
│  ├─ monitor/           # monitor(轮询) / recorder(ffmpeg) / notifier(TG/邮件/Webhook)
│  └─ web/server.js      # Express：全部 API 路由 + 鉴权 + 流代理 + 录播下载
├─ data/logs/            # 运行日志（douyin_YYYY-MM-DD.jsonl）
├─ recordings/           # 录制输出
└─ .backups/             # 本地备份
```

## 启动

前置：Node ≥ 18，本机 MongoDB（`mongod --auth`），录制需 ffmpeg（可选）。

```bash
npm install          # 首次
node index.js        # 默认 0.0.0.0:8010，自动开浏览器
node index.js --port 8010 --no-browser
node index.js --dir /path/to/recordings   # 覆盖录制目录
```

首次打开 `http://<IP>:8010/` 会要求创建管理员账号（账号存于 MongoDB `accounts` 集合，密码 sha256+salt，与 Python 版算法一致）。

## MongoDB

连接串（可用环境变量覆盖）：

| 环境变量 | 默认值 |
|---|---|
| `MONGO_URI` | `mongodb://mongodb:***@127.0.0.1:27017/?authSource=admin` |
| `MONGO_DB` | `live` |

集合：`config` / `streamers` / `user_streamers` / `history` / `recordings` / `logs` / `notify_logs` / `fudai` / `fudai_history` / `accounts`（另有 `counters` 模拟自增 id，供后台按 id 编辑/删除）。

> 说明：前端设置里的"存储后端 SQLite/MySQL 切换"界面按原样保留，Node 版统一指向 MongoDB——`/api/storage/status`、`/api/admin/tables` 等接口把 Mongo 计数同时填进两栏（别名兼容），无需改动前端。

## 与 Python 版的对应关系

| Python | Node |
|---|---|
| `main.py` | `index.js` |
| `src/app/web/server.py` | `src/web/server.js`（路由/鉴权/脱敏逐一对齐） |
| `src/app/storage/db.py` + `db_mysql.py` | `src/db/mongo.js` |
| `src/app/collectors/*` | `src/collectors/*`（端点、重试、SSR 正则一致） |
| `src/app/monitor/{monitor,recorder,notifier}.py` | `src/monitor/*.js`（ffmpeg argv、通知模板逐字复刻） |
| `src/app/utils/*` | `src/utils/*` |
| `push_github.py`（本地备份） | `src/utils/backup.js`（进程内实现，响应形状一致） |

细节怪癖也一并保留：`/api/remove` 仅移除用户关联、`/api/fudai` 用 web_rid 而 `/api/fudai/current` 用 sec_uid、tg_bot_token 永久脱敏、"已结束"按正常下播处理（status=4）、会话存内存重启失效等。

## 部署到 Vercel（Serverless）

> 前提：需要一个 **MongoDB Atlas**（或其他云 MongoDB）实例，本机 MongoDB 在 Vercel 上不可达。

```bash
cd live
npx vercel          # 首次会引导登录并关联项目（Root Directory 保持 live/）
```

1. 在 Vercel 项目 → Settings → Environment Variables 添加：
   - `MONGO_URI`：Atlas 连接串（`mongodb+srv://用户:密码@xxx.mongodb.net/?retryWrites=true&w=majority`）
   - `MONGO_DB`：库名（如 `live`）
   - `CRON_SECRET`：任意随机串（保护定时刷新接口；设置后 Vercel Cron 自动附带 Bearer 头）
2. `vercel.json` 已配置：全部路由走 `api/index.js`（Express → Serverless）、页面/JS 资源随函数打包、**每天一次** Cron 调用 `/api/cron/refresh` 执行监控刷新（`"0 1 * * *"` = 北京时间每天 09:00；Hobby 免费版仅支持每天一次，Pro 才能改每小时/每分钟）。

**Serverless 限制（重要）：**

| 功能 | Vercel 上的状态 |
|---|---|
| 网页 / 全部 API / 广场 / 配置 / 历史查询 | ✅ 正常 |
| 监控轮询 | ⚠️ 无常驻线程，由 Vercel Cron 触发（Hobby 计划仅支持每天一次，需改 `crons` 的 schedule；Pro 才能每小时/每分钟） |
| 录制（ffmpeg 长时间写盘） | ❌ 不可用（无 ffmpeg、执行时限、磁盘临时） |
| 直播流代理 `/api/proxy` | ⚠️ 受 60s 执行时限限制，长播不稳定 |
| 会话登录 | ✅ 已持久化到 MongoDB（sessions 集合，30 天 TTL），多实例/冷启动共享，重启不丢 |
| 抖音风控 | ⚠️ Vercel 为海外 IP，直播间接口被风控的概率明显高于本机部署 |

本地长期挂机监控 + 录制仍建议直接 `node index.js` 运行。

## 在线人数曲线

主播详情弹窗 →「在线人数」标签：展示在线人数随时间变化的曲线、当前/峰值/均值/最低/采样点数，支持 1 小时 / 6 小时 / 24 小时 / 7 天 / 30 天 / 全部 范围切换，悬浮可查看每个采样点的时间与人数。

- 采集：`monitor._refresh_one()` 每次刷新且直播中时写入一个采样点（默认每 60 秒，跟随刷新间隔），未开播或接口异常不写，曲线在这些空档处断开。人数取抖音 `room_view_stats.display_value` / `stats.user_count_str` 的**未分档精确值**（如 482）；顶层 `user_count_str` 只是 `"400+"` / `"1.2万"` 这样的展示分档值，仅在取不到精确值时兜底。
- 存储：MongoDB `online_samples` 集合；`{sec_uid, minute}` 唯一索引按分钟去重（详情页刷新不会产生重复点），`created_at` TTL 保留 90 天。每个点带 `exact` 标记（1=精确 / 0=分档近似），升级前的旧数据无此字段，会在曲线中标注为分档值（无法还原，重启后的新采样即为精确值）。
- 接口：`GET /api/online/stats?id=<sec_uid|web_rid>&range=1h|6h|24h|7d|30d|all`（需登录）。最多返回 720 个绘图点，超出时分片取平均；均值保留 1 位小数，人数按完整数字（千分位）显示，不缩写为「万」。
- 点赞：统计卡显示「当前点赞」（实时 `room.like_count`，完整数字）及所选区间内的点赞新增量，悬浮提示也会显示该采样点的点赞数。
- Vercel Serverless 下 Cron 每天只刷新一次，曲线点会很稀疏；本地 `node index.js` 常驻监控效果最佳。

## 最近日志

详情弹窗 →「最近日志」：顶部可按 全部 / 开播下播 / 福袋 / 通知 / HTTP 请求 / 其它 / 警告错误 切换日志类型，勾选「全部主播」可查看系统与其它主播的日志（默认只看当前主播）。长 HTTP URL 默认折叠成一行，点击展开完整地址；列表固定高度、内部滚动，不会被长日志撑开。

## 福袋 / 广场配置

与 Python 版相同：福袋检测需在 设置→福袋 填入 `fudai_cookie`（可选 msToken/a_bogus）；广场推荐直播/搜索需在 设置→广场 粘贴浏览器 Network 里的完整 `webcast/feed` / `live/search` URL。热搜榜、分区列表、categorynew 大类无需配置即可用。
