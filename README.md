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
2. `vercel.json` 已配置：全部路由走 `api/index.js`（Express → Serverless）、页面/JS 资源随函数打包、每小时 Cron 调用 `/api/cron/refresh` 执行一轮监控刷新。

**Serverless 限制（重要）：**

| 功能 | Vercel 上的状态 |
|---|---|
| 网页 / 全部 API / 广场 / 配置 / 历史查询 | ✅ 正常 |
| 监控轮询 | ⚠️ 无常驻线程，由 Vercel Cron 触发（Hobby 计划仅支持每天一次，需改 `crons` 的 schedule；Pro 才能每小时/每分钟） |
| 录制（ffmpeg 长时间写盘） | ❌ 不可用（无 ffmpeg、执行时限、磁盘临时） |
| 直播流代理 `/api/proxy` | ⚠️ 受 60s 执行时限限制，长播不稳定 |
| 会话登录 | ⚠️ 存内存，实例冷启动后需重新登录 |
| 抖音风控 | ⚠️ Vercel 为海外 IP，直播间接口被风控的概率明显高于本机部署 |

本地长期挂机监控 + 录制仍建议直接 `node index.js` 运行。

## 福袋 / 广场配置

与 Python 版相同：福袋检测需在 设置→福袋 填入 `fudai_cookie`（可选 msToken/a_bogus）；广场推荐直播/搜索需在 设置→广场 粘贴浏览器 Network 里的完整 `webcast/feed` / `live/search` URL。热搜榜、分区列表、categorynew 大类无需配置即可用。
