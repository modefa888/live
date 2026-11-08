// HTTP 工具：对应 Python utils.py 的 http_get / http_get_text / fetch_ttwid / set_global_proxy
// 使用 undici：Agent 关闭证书校验（对齐 Python CERT_NONE），ProxyAgent 支持全局代理
import { Agent, ProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from "undici";
import { UA_DESKTOP } from "./constants.js";
import { log, logRequest } from "./logging.js";

let _globalProxy = null;
let _dispatcher = null;

// SSL 证书校验关闭的 Agent（对齐 Python get_opener 的行为）
const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

function buildDispatcher(proxy) {
  if (!proxy) return insecureAgent;
  try {
    return new ProxyAgent({
      uri: proxy,
      requestTls: { rejectUnauthorized: false },
      proxyTls: { rejectUnauthorized: false },
    });
  } catch {
    return insecureAgent;
  }
}

export function setGlobalProxy(proxyUrl) {
  _globalProxy = proxyUrl && String(proxyUrl).trim() ? String(proxyUrl).trim() : null;
  _dispatcher = buildDispatcher(_globalProxy);
  setGlobalDispatcher(_dispatcher);
  if (_globalProxy) {
    log("info", `全局代理已设置: ${_globalProxy}`);
  } else {
    log("info", "全局代理已清除");
  }
}

export function getDispatcher() {
  if (!_dispatcher) _dispatcher = buildDispatcher(_globalProxy);
  return _dispatcher;
}

export function getGlobalProxy() {
  return _globalProxy;
}

/**
 * 发起 GET 请求，返回 { status, body(Buffer) }。
 * 每次请求都会记录日志（URL/状态/耗时/大小），与 Python http_get 一致。
 * options: { headers, timeout=15000, dispatcher, secUid, webRid, eventType }
 */
export async function httpGet(url, options = {}) {
  const { headers = null, timeout = 15000, dispatcher = null, secUid = "", webRid = "", eventType = "" } = options;
  const start = Date.now();
  try {
    const res = await undiciFetch(url, {
      method: "GET",
      headers: headers || {},
      dispatcher: dispatcher || getDispatcher(),
      signal: AbortSignal.timeout(timeout),
      redirect: "follow",
    });
    const buf = Buffer.from(await res.arrayBuffer());
    logRequest(url, {
      status: res.status,
      duration: (Date.now() - start) / 1000,
      size: buf.length,
      secUid, webRid, eventType,
    });
    return { status: res.status, body: buf };
  } catch (e) {
    logRequest(url, {
      duration: (Date.now() - start) / 1000,
      error: e && e.message ? String(e.message) : String(e),
      secUid, webRid, eventType,
    });
    throw e;
  }
}

/** http_get_text：非 200 抛错，返回 utf-8 文本 */
export async function httpGetText(url, options = {}) {
  const { status, body } = await httpGet(url, options);
  if (status !== 200) {
    throw new Error(`HTTP ${status}: ${url.slice(0, 80)}`);
  }
  return body.toString("utf-8");
}

/** 用 UA_DESKTOP 访问 live.douyin.com 抓取 ttwid cookie */
export async function fetchTtwid() {
  try {
    const res = await undiciFetch("https://live.douyin.com/", {
      headers: { "User-Agent": UA_DESKTOP },
      dispatcher: getDispatcher(),
      signal: AbortSignal.timeout(15000),
      redirect: "follow",
    });
    // 消费响应体避免连接泄漏
    try { await res.arrayBuffer(); } catch {}
    const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const c of setCookies) {
      const m = c.match(/^\s*ttwid=([^;]+)/);
      if (m) return m[1];
    }
  } catch {}
  return "";
}

/** 解析 Cookie 字符串为对象 */
export function parseCookieHeader(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) {
      out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
  }
  return out;
}
