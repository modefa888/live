// 抖音 API 客户端：对应 Python src/app/collectors/client.py
// 公共主体，混入各采集模块（room/profile/fudai/search/hot/square）
import { UA_DESKTOP, UA_MOBILE, DEFAULT_AC_COOKIES } from "../utils/constants.js";
import { fetchTtwid } from "../utils/httputil.js";
import { log } from "../utils/logging.js";
import { roomMixin } from "./room.js";
import { profileMixin } from "./profile.js";
import { fudaiMixin } from "./fudai.js";
import { searchMixin } from "./search.js";
import { hotMixin } from "./hot.js";
import { squareMixin } from "./square.js";

export class DouyinClient {
  constructor(cookie = "") {
    this.cookie = cookie || "";
    this.ttwid = "";
    this.ac_cookies = DEFAULT_AC_COOKIES;
    this._profile_cache = new Map();          // sec_uid -> [timestamp, result]
    this._fudai_cache = new Map();            // web_rid -> [timestamp, FudaiInfo]
    // 福袋专用参数（由服务端配置注入，优先于环境变量）
    this.fudai_ms_token = "";
    this.fudai_a_bogus = "";
    this.fudai_cookie = "";
    // 直播广场搜索专用参数（独立于福袋，需从直播搜索请求抓取）
    this.square_ms_token = "";
    this.square_a_bogus = "";
    this.square_cookie = "";
    this.square_ttwid = "";                   // 广场分区请求缓存的 ttwid（分页会话需固定同一 ttwid）
    this._partition_list_cache = null;        // [timestamp, result]，动态分区列表 1h 缓存
    // 直播广场推荐直播完整 URL（从浏览器 live.douyin.com 首页 Network 复制 webcast/feed 请求）
    this.square_feed_url = "";
    // 直播搜索完整 URL（从浏览器 www.douyin.com 搜索页 Network 复制 live/search 请求）
    this.square_search_url = "";
    this._refresh_chain = Promise.resolve();  // 串行化 ttwid 刷新（对应 Python threading.Lock）
    this.refresh_session();
  }

  async refresh_session(force = false) {
    // 串行执行，避免并发重复获取 ttwid
    const run = async () => {
      const ck = this.cookie || this.ttwid;
      if (!force && ck) return;
      const ttwid = await fetchTtwid();
      if (ttwid) {
        this.ttwid = ttwid;
        log("info", "已自动获取 ttwid cookie");
      } else if (!this.ttwid) {
        log("warn", "未能自动获取 ttwid, 若接口被风控请在设置中填写 Cookie");
      }
    };
    const p = this._refresh_chain.then(run, run);
    this._refresh_chain = p.catch(() => {});
    return p;
  }

  headers({ referer = null, mobile = false, extra = null } = {}) {
    const h = {
      "User-Agent": mobile ? UA_MOBILE : UA_DESKTOP,
      "Accept": "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9",
      "Accept-Encoding": "identity",
    };
    if (referer) h.Referer = referer;
    let cookie = this.cookie || this.ttwid;
    if (cookie) {
      if (!/^[A-Za-z_]\w*=/.test(cookie.replace(/^\s+/, ""))) {
        cookie = "ttwid=" + cookie;
      }
      h.Cookie = cookie;
    }
    if (extra) Object.assign(h, extra);
    return h;
  }
}

// 混入各采集模块（对应 Python 的多继承 Mixin）
Object.assign(DouyinClient.prototype,
  roomMixin,
  profileMixin,
  fudaiMixin,
  searchMixin,
  hotMixin,
  squareMixin,
);
