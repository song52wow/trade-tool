/**
 * 写操作的来源校验（v0.5.0）。
 *
 * 为什么需要：控制面**绑 0.0.0.0 且没有鉴权**，而它现在能写交易所密钥。
 * 浏览器里随便一个网页都能对 `http://<你的内网IP>:8787` 发跨站 POST ——
 * 用户只要在同一个浏览器里打开它，恶意脚本就能把密钥换成攻击者的。
 *
 * 判据是 `Origin`，比对的是**完整 origin（协议 + 主机 + 端口）**，
 * 与浏览器自己的同源定义一致。只比 host 是不够的：`https://127.0.0.1:8787`
 * 和 `http://127.0.0.1:8787` 对我们来说是两回事，本服务只提供 http，
 * 因此来自 https 的同主机 Origin 本身就是异常的，不该放行。
 *
 *   * 有 Origin → 必须与本请求同源，否则 403；
 *   * 没有 Origin → 放行（curl、CLI、executor 这类非浏览器调用方）。
 *
 * 这不是完整的 CSRF 防护方案（完整方案要配 token + `SameSite` cookie），
 * 但它是**无 cookie、无鉴权**这个前提下能做到的最强一道：密钥接口本来就不靠
 * cookie 认人，这里挡的正是「别人的页面借用户的浏览器发起请求」这条路。
 */

/** 放行的 HTTP 方法。读操作不校验来源——跨站读在本架构下拿不到响应（CORS）。 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface OriginCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * @param origin     请求头里的 `Origin`，缺失时传 undefined
 * @param requestUrl 本次请求的完整 URL（协议 + 主机 + 端口）
 */
export function checkOrigin(
  method: string,
  origin: string | undefined,
  requestUrl: string,
): OriginCheckResult {
  if (SAFE_METHODS.has(method.toUpperCase())) return { ok: true };
  // 没有 Origin：不是浏览器发起的写操作（curl / CLI / executor），放行。
  if (origin === undefined || origin === '') return { ok: true };
  let originParsed: URL;
  let selfParsed: URL;
  try {
    originParsed = new URL(origin);
    selfParsed = new URL(requestUrl);
  } catch {
    return { ok: false, reason: `Origin 或请求 URL 不是合法 URL：${origin} / ${requestUrl}` };
  }
  if (originParsed.origin === selfParsed.origin) return { ok: true };
  return {
    ok: false,
    reason: `拒绝跨站写请求：Origin ${originParsed.origin} 与本服务 ${selfParsed.origin} 不同源`,
  };
}
