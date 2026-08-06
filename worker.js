/**
 * cline2api - Cloudflare Workers 版
 *
 * 逆向自 https://github.com/luawei1/cline2api (Go 版反向代理)
 *
 * 核心逻辑：
 *  1. 每次请求用 refreshToken 换 accessToken（缓存到内存，过期自动刷新）
 *  2. 把 OpenAI / Anthropic 请求转发到 https://api.cline.bot/api/v1/chat/completions
 *  3. SSE 流式响应剥掉上游 {data:{...}} 包装，透传给客户端
 *
 * 环境变量：
 *  - CLINE_REFRESH_TOKEN (必需)  Cline 账号的 refreshToken
 *  - API_KEY                (可选) 自定义访问 key；不设置则每次部署随机生成并打印到日志
 *
 * 用法（OpenAI 兼容）：
 *   curl https://你的worker/v1/chat/completions \
 *     -H "Authorization: Bearer <API_KEY>" \
 *     -H "Content-Type: application/json" \
 *     -d '{"model":"cline-free/glm-5.2","messages":[{"role":"user","content":"hi"}]}'
 */

const CLINE_API_BASE = "https://api.cline.bot/api/v1";

// 账号池：支持多个 Cline 账号，每个账号独立缓存 accessToken
// CLINE_REFRESH_TOKEN 环境变量可包含多行，每行一个 refreshToken，
// 额度用尽(空响应)时自动轮换下一个账号。
// 结构：{ refreshToken, accessToken, expiry, cooldownUntil }
let accounts = [];
let accountIndex = 0;          // round-robin 游标
let currentAccount = null;     // 当前正在使用的账号（串行队列下安全）

// 模型列表（实测可用性见 README）
// 注意：cline-pass/* 需付费订阅，
//       deepseek/deepseek-v4-flash 和 cline-free/glm-5.2 需完整 Cline 客户端头 + 强制 stream（见 handleChat），
//       poolside/*:free 免费可用（非流式也通）。
const MODELS = [
  { id: "deepseek/deepseek-v4-flash", provider: "deepseek", cost: "free" },
  { id: "poolside/laguna-s-2.1:free", provider: "poolside", cost: "free" },
  { id: "cline-free/glm-5.2", provider: "zai", cost: "free" },
  { id: "cline-pass/glm-5.2", provider: "zai", cost: "pass" },
  { id: "cline-pass/deepseek-v4-flash", provider: "deepseek", cost: "pass" },
  { id: "cline-pass/qwen3.7-max", provider: "qwen", cost: "pass" },
];

// 默认模型：deepseek 免费通道（完整头 + 强制 stream 已修复）
const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS 预检
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // 健康诊断端点（无需鉴权，用于排查环境变量是否生效）
    if (request.method === "GET" && url.pathname === "/v1/health") {
      const poolN = parseAccounts(env).length;
      return jsonResponse({
        ok: true,
        api_key_configured: !!(env.API_KEY),
        api_key_prefix: env.API_KEY ? env.API_KEY.slice(0, 6) + "..." : "(未配置，用默认 cline2api-default-key)",
        refresh_token_configured: poolN > 0,
        account_count: poolN,
        model: DEFAULT_MODEL,
      }, 200);
    }

    // 全局鉴权：所有端点都需要 API Key（除 OPTIONS 预检）
    // 若未配置 API_KEY，则使用内置默认 key "cline2api-default-key"
    // (可选) 设 API_KEY="" 表示完全关闭鉴权
    // GET /v1/models
    if (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      const key = getApiKey(request, env);
      if (!key) {
        return jsonResponse({ error: { message: "Invalid API key", type: "auth_error" } }, 401);
      }
      return handleModels();
    }

    // POST 聊天端点
    if (request.method === "POST") {
      if (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") {
        return handleChat(request, env);
      }
      if (url.pathname === "/v1/messages" || url.pathname === "/messages") {
        return handleAnthropic(request, env);
      }
    }

    return jsonResponse({ error: { message: "Not found", type: "not_found" } }, 404);
  },
};

// ---------------------------------------------------------------------------
// Token 管理
// ---------------------------------------------------------------------------

// 从环境变量解析账号池：CLINE_REFRESH_TOKEN 每行一个
function parseAccounts(env) {
  const raw = env.CLINE_REFRESH_TOKEN || "";
  const tokens = raw.split("\n").map((s) => s.trim()).filter((s) => s.length > 8);
  if (tokens.length === 0) return [];

  // 若 token 列表变化（增删账号），重建账号池
  const changed =
    accounts.length !== tokens.length ||
    accounts.some((a, i) => a.refreshToken !== tokens[i]);
  if (changed) {
    accounts = tokens.map((rt) => ({
      refreshToken: rt,
      accessToken: null,
      expiry: 0,
      cooldownUntil: 0,
    }));
  }
  return accounts;
}

// 取得当前账号的 accessToken（独立缓存，失效/冷却则刷新）
async function getAccountToken(account) {
  const now = Date.now();
  // 冷却期内不可用
  if (account.cooldownUntil > now) {
    throw new Error("account_cooldown");
  }
  if (account.accessToken && now < account.expiry) {
    return account.accessToken;
  }
  const resp = await fetch(CLINE_API_BASE + "/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      refreshToken: account.refreshToken,
      grantType: "refresh_token",
    }),
  });
  if (!resp.ok) {
    // 刷新失败：冷却 60s，交给上层切号
    account.cooldownUntil = now + 60 * 1000;
    throw new Error("refresh_failed");
  }
  const data = await resp.json();
  const accessToken = data?.data?.accessToken;
  if (!accessToken) {
    account.cooldownUntil = now + 60 * 1000;
    throw new Error("refresh_no_token");
  }
  account.accessToken = accessToken;
  // ⚠️ 2026-08-06 移除：上游可能轮换 refreshToken，但 CF Worker 内存无法持久化，
  //    只存内存会在实例重启后拿旧 env rt 刷新失败 → OpenAI 对端全挂（线上故障实证）。
  //    保持每次都用 env 里的 CLINE_REFRESH_TOKEN，旧 rt 持续有效反而稳定。
  // 过期时间：优先服务端，兜底 10 分钟，留 60s 余量
  const expiresAt = data?.data?.expiresAt;
  let expiry = now + 10 * 60 * 1000;
  if (typeof expiresAt === "number") {
    expiry = expiresAt;
  } else if (typeof expiresAt === "string") {
    const t = Date.parse(expiresAt);
    if (!isNaN(t)) expiry = t;
  }
  account.expiry = expiry - 60000;
  return accessToken;
}

// 轮询选择一个可用账号，返回该账号对象（并设置 currentAccount）
function pickAccount(pool) {
  for (let k = 0; k < pool.length; k++) {
    const acc = pool[accountIndex % pool.length];
    accountIndex = (accountIndex + 1) % pool.length;
    if (!acc.cooldownUntil || acc.cooldownUntil <= Date.now()) {
      currentAccount = acc;
      return acc;
    }
  }
  return null; // 全部冷却中
}

async function getAccessToken(env) {
  const pool = parseAccounts(env);
  if (pool.length === 0) {
    throw new Error("缺少 CLINE_REFRESH_TOKEN 环境变量");
  }
  // 最多尝试 pool.length 个账号（跳过冷却/刷新失败的）
  for (let attempt = 0; attempt < pool.length; attempt++) {
    const acc = pool[attempt % pool.length]; // 逐个尝试
    if (acc.cooldownUntil && acc.cooldownUntil > Date.now()) continue;
    currentAccount = acc;
    try {
      return await getAccountToken(acc);
    } catch (e) {
      if (e.message === "account_cooldown") continue;
      continue; // 刷新失败也切下个号
    }
  }
  // 全部失败，清冷却重试一次最早的
  const acc = pool[0];
  currentAccount = acc;
  acc.cooldownUntil = 0;
  try {
    return await getAccountToken(acc);
  } catch (e) {
    throw new Error("所有账号刷新 token 均失败");
  }
}

// Cline 客户端指纹请求头（官方靠这些头识别"是不是 Cline 客户端"）
// 缺少会被 403: "deepseek/deepseek-v4-flash is only available via Cline product surfaces"
function clineHeaders(sessionId) {
  return {
    Authorization: "Bearer workos:" + currentToken,
    "Content-Type": "application/json",
    "User-Agent": "Cline/3.0.47",
    "HTTP-Referer": "https://cline.bot",
    "X-Title": "Cline",
    "X-IS-MULTIROOT": "false",
    "X-CLIENT-TYPE": "cline-sdk",
    "X-CLIENT-VERSION": "3.0.47",
    "X-PLATFORM": "terminal",
    "X-PLATFORM-VERSION": "3.0.47",
    "X-CORE-VERSION": "0.0.66",
    "X-Task-ID": sessionId,
  };
}

// 当前账号的 accessToken（供 clineHeaders 使用）
let currentToken = "";

async function clineFetch(env, path, bodyObj, sessionId, retried = false) {
  const acc = currentAccount || null;
  const token = await getAccessToken(env);
  currentToken = token;
  const headers = clineHeaders(sessionId);
  headers.Authorization = "Bearer workos:" + token;
  const resp = await fetch(CLINE_API_BASE + path, {
    method: "POST",
    headers,
    body: JSON.stringify(bodyObj),
  });
  if (resp.status === 401 && !retried) {
    // token 失效：标记当前账号冷却，强制重试（会用别的账号/刷新）
    if (currentAccount) {
      currentAccount.cooldownUntil = Date.now() + 60 * 1000;
      currentAccount.accessToken = null;
      currentAccount.expiry = 0;
    }
    return clineFetch(env, path, bodyObj, sessionId, true);
  }
  return resp;
}

// ---------------------------------------------------------------------------
// 并发限流队列：上游免费通道并发超过 1 就返回空响应，这里强制串行 + 间隔
// ---------------------------------------------------------------------------

let queueTail = Promise.resolve(); // 全局串行队列尾巴
const MIN_GAP_MS = 800;            // 两次上游请求最小间隔

function enqueue(fn) {
  // 前一个任务结束后，等待间隔，再执行 fn
  const run = queueTail.then(() => sleep(MIN_GAP_MS)).then(fn);
  // 不管成功失败都继续链，避免队列断裂
  queueTail = run.catch(() => {});
  return run;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 解析上游 429/限流响应里的等待时间，返回毫秒
// 支持格式: "Try again in 2h 51m" / "Try again in 30m" / "Try again in 1h" / "Try again in 15s"
function parseCooldown(body, status) {
  const m = (body || "").match(/try again in (?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i);
  if (m) {
    const h = parseInt(m[1] || 0, 10);
    const min = parseInt(m[2] || 0, 10);
    const s = parseInt(m[3] || 0, 10);
    const ms = (h * 3600 + min * 60 + s) * 1000;
    if (ms > 0) return Math.min(ms, 6 * 3600 * 1000); // 上限 6 小时
  }
  // 429 默认 5 分钟；空响应默认 60 秒
  if (status === 429) return 5 * 60 * 1000;
  return 60 * 1000;
}

// 带重试的 clineFetch：429限流/空响应/5xx 自动切换账号 + 指数退避重试
// 一个号额度用完或限流(429 Daily free limit reached)时：
//   - 冷却该账号（冷却时长按上游提示，如 2h51m）
//   - 自动轮换到下一个号重试同一请求
// 所有账号都冷却时，直接返回原始响应（不空转）
async function clineFetchWithRetry(env, path, bodyObj, sessionId, isStream = false, maxRetries = 4) {
  let lastResp = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 通过队列串行执行，避免并发空响应
    const resp = await enqueue(() => clineFetch(env, path, bodyObj, sessionId));
    lastResp = resp;

    // 统一读 body（clone 不消耗流）
    let bodyText = "";
    try {
      bodyText = await resp.clone().text();
    } catch (e) {}

    // 判定"额度/限流"信号（需要切号）：
    // 1. 429（Daily free limit reached / rate limit）
    // 2. 5xx 且含 empty response content
    // 3. 200 非流式但 body 是空响应包装
    const isLimitHit =
      resp.status === 429 ||
      (resp.status >= 500 && bodyText.includes("empty response content")) ||
      (resp.ok && !isStream && bodyText.includes("empty response content"));

    if (isLimitHit) {
      const cooldownMs = parseCooldown(bodyText, resp.status);
      if (currentAccount) {
        currentAccount.cooldownUntil = Date.now() + cooldownMs;
        currentAccount.accessToken = null;
        currentAccount.expiry = 0;
        console.log(`[account-switch] 账号额度/限流，冷却 ${Math.round(cooldownMs / 1000)}s，切换到下一个`);
      }
      // 还有可用账号 → 短退避后重试（会切到下一个号）
      const pool = parseAccounts(env);
      const hasOther = pool.some((a) => !a.cooldownUntil || a.cooldownUntil <= Date.now());
      if (!hasOther) {
        console.log(`[retry] 所有账号均冷却，直接返回上游响应`);
        return resp; // 不空转，把 429/错误返回给客户端
      }
      await sleep(500 + Math.floor(Math.random() * 500));
      continue;
    }

    // 正常响应（200）
    if (resp.ok) {
      if (isStream) return resp; // 流式：直接转发
      return resp;               // 非流式：body 已确认非空响应
    }

    // 其他错误（403/400/401 等）不重试，直接返回
    return resp;
  }
  // 重试次数用完，返回最后一次响应
  return lastResp;
}

// ---------------------------------------------------------------------------
// OpenAI 协议
// ---------------------------------------------------------------------------

async function handleChat(request, env) {
  // API Key 鉴权
  const key = getApiKey(request, env);
  if (!key) {
    return jsonResponse({ error: { message: "Invalid API key", type: "auth_error" } }, 401);
  }

  let params;
  try {
    params = await request.json();
  } catch (e) {
    return jsonResponse({ error: { message: "Invalid JSON body", type: "parse_error" } }, 400);
  }

  const isStream = !!params.stream;
  const sessionId = "sess_" + Date.now();
  const model = params.model || DEFAULT_MODEL;

  // 构造上游 body（与原版 buildUpstreamBody 一致）
  const body = {
    model: model,
    max_tokens: params.max_tokens || params.max_completion_tokens || 128000,
    session_id: sessionId,
    reasoning_effort: params.reasoning_effort || params.reasoningEffort || "high",
    messages: params.messages || [],
  };
  // ⚠️ 免费通道（deepseek + cline-free）：非流式请求被上游限流(500 empty response content)，
  //    流式请求正常。所以客户端要非流式时，强制上游走 stream，再聚合返回。
  const forceStream = !isStream && (model.startsWith("deepseek/") || model.startsWith("cline-free/"));
  if (isStream || forceStream) body.stream = true;
  // 透传可选参数
  for (const k of ["temperature", "top_p", "tools", "tool_choice", "stop", "presence_penalty", "frequency_penalty", "response_format", "user", "n", "seed"]) {
    if (params[k] !== undefined) body[k] = params[k];
  }

  try {
    const resp = await clineFetchWithRetry(env, "/chat/completions", body, sessionId, true);
    if (!resp.ok) {
      const errText = await resp.text();
      return jsonResponse({ error: { message: "upstream error: " + errText.slice(0, 300), type: "api_error" } }, resp.status);
    }
    if (isStream) {
      // 客户端要流式：直接透传 SSE
      return streamResponse(resp);
    }
    if (forceStream) {
      // 客户端要非流式 + 上游是流式：聚合 chunks 再返回
      // ⚠️ 免费通道(deepseek/cline-free)会概率性返回「HTTP200但content全程为空」的流
      //    （100个chunk全是reasoning，无正式content）。这里做内容检测：空则切号重试。
      const retried = await nonStreamWithContentCheck(env, "/chat/completions", body, sessionId, resp);
      if (retried.error) return retried.error;
      return jsonResponse(retried.data, 200);
    }
    // 非流式 + 非 deepseek：原逻辑
    const raw = await resp.json();
    const normalized = unwrapData(raw);
    return jsonResponse(normalized, 200);
  } catch (e) {
    return jsonResponse({ error: { message: e.message, type: "api_error" } }, 500);
  }
}

// 把上游 SSE 流聚合成 OpenAI 非流式响应对象
// 用于"客户端要非流式，但上游只能流式"的情况（deepseek 免费通道）
// 额外处理：上游 200 但 content 全空（只有 reasoning）→ 视为坏响应，切号重试
// 由调用方传入"已获取的上游响应"，这里负责聚合 + content 检测 + 空则重试。
async function nonStreamWithContentCheck(env, path, bodyObj, sessionId, firstResp) {
  const maxAttempts = 3; // 最多试 3 次（覆盖多账号切换）
  let lastData = null;
  let resp = firstResp;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!resp) {
      // 需要重新发起上游请求（空响应重试时）
      resp = await clineFetchWithRetry(env, path, bodyObj, sessionId, true);
    }
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return { error: jsonResponse({ error: { message: "upstream error: " + errText.slice(0, 300), type: "api_error" } }, resp.status) };
    }
    const ct = resp.headers.get("content-type") || "";
    let normalized = null;
    if (ct.includes("text/event-stream")) {
      normalized = await streamToNonStream(resp);
    } else {
      const raw = await resp.json().catch(() => null);
      if (raw) normalized = unwrapData(raw);
    }
    if (!normalized) {
      return { error: jsonResponse({ error: { message: "upstream returned non-SSE body", type: "api_error" } }, 502) };
    }
    lastData = normalized;
    const msg = normalized?.choices?.[0]?.message || {};
    const content = (msg.content || "").trim();
    const reasoning = (msg.reasoning || "").trim();
    // ⚠️ reasoning 兜底标记：content 为空时 streamToNonStream 会把 reasoning 拼进 content，
    //    这里要识别出来，不能把它当成"好响应"。
    const isReasoningFallback = msg.reasoning_used_as_content === true;
    if (content && !isReasoningFallback) {
      return { data: normalized }; // 有正式 content → 好响应
    }
    // content 为空（或只有兜底 reasoning）：如果只有 reasoning，标记当前账号冷却并重试
    if (reasoning || isReasoningFallback) {
      if (currentAccount) {
        currentAccount.cooldownUntil = Date.now() + 30 * 1000; // 短冷却 30s
        currentAccount.accessToken = null;
        currentAccount.expiry = 0;
        console.log(`[empty-content] 账号 ${attempt} 返回空 content，冷却 30s，重试第 ${attempt + 2} 次`);
      }
      await sleep(300 + Math.floor(Math.random() * 300));
      resp = null; // 下次循环重新请求（切到下一个号）
      continue;
    }
    // 完全空（连 reasoning 都没有）→ 也重试
    console.log(`[empty-response] 账号 ${attempt} 完全空响应，重试第 ${attempt + 2} 次`);
    await sleep(300 + Math.floor(Math.random() * 300));
    resp = null;
  }
  // 重试用完仍空：返回最后一次（至少带 reasoning，让客户端看到点东西）
  return { data: lastData };
}

async function streamToNonStream(upstream) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoning = "";
  let finishReason = null;
  let model = "";
  let id = "";
  let usage = null;
  // ⚠️ 工具调用累积（按 index 聚合 arguments 分片，参考 go 版 toolAccumulator）
  let toolCallAcc = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      try {
        const obj = JSON.parse(payload);
        const normalized = unwrapData(obj);
        const choice = normalized?.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.content) content += delta.content;
        if (delta.reasoning) reasoning += delta.reasoning;
        // 聚合工具调用分片：arguments 可能是多段字符串，按 index 累积
        if (delta.tool_calls && delta.tool_calls.length > 0) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index || 0;
            toolCallAcc[idx] = toolCallAcc[idx] || { id: "", name: "", arguments: "" };
            if (tc.id) toolCallAcc[idx].id = tc.id;
            if (tc.function?.name) toolCallAcc[idx].name = tc.function.name;
            if (tc.function?.arguments) toolCallAcc[idx].arguments += tc.function.arguments;
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
        if (normalized.id) id = normalized.id;
        if (normalized.model) model = normalized.model;
        if (normalized.usage) usage = normalized.usage;
      } catch {}
    }
  }

  const msg = { role: "assistant", content };
  // 非流式聚合：把累积的 tool_calls 挂回 message（之前这里直接丢掉了）
  if (toolCallAcc.length > 0) {
    msg.tool_calls = toolCallAcc
      .filter((t) => t && (t.id || t.name))
      .map((t) => ({
        id: t.id || "call_" + Date.now() + "_" + toolCallAcc.indexOf(t),
        type: "function",
        function: { name: t.name || "", arguments: t.arguments || "{}" },
      }));
  }
  if (reasoning) msg.reasoning = reasoning;
  // ⚠️ 兜底：免费通道偶尔整个流只有 reasoning 没有 content（HTTP 200 但空）。
  //    聚合后发现 content 仍为空且 reasoning 非空时，把 reasoning 拼进 content，
  //    保证客户端（qwenpaw 等）至少能收到可见内容，不会"静默不回复"。
  if (!content && reasoning) {
    msg.content = reasoning;
    msg.reasoning_used_as_content = true;
  }
  return {
    id: id || "gen_" + Date.now(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || DEFAULT_MODEL,
    choices: [{
      index: 0,
      message: msg,
      finish_reason: finishReason || "stop",
      logprobs: null,
      native_finish_reason: finishReason || "stop",
    }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ---------------------------------------------------------------------------
// Anthropic Messages API → 转 OpenAI 格式再转发
// ---------------------------------------------------------------------------

async function handleAnthropic(request, env) {
  const key = getApiKey(request, env);
  if (!key) {
    return jsonResponse({ error: { message: "Invalid API key", type: "auth_error" } }, 401);
  }

  let req;
  try {
    req = await request.json();
  } catch (e) {
    return jsonResponse({ error: { message: "Invalid JSON body", type: "parse_error" } }, 400);
  }

  const isStream = !!req.stream;
  const sessionId = "sess_" + Date.now();

  // Anthropic → OpenAI 消息转换（参考 go 版 anthropicToOpenAI）
  // 完整处理 content blocks：text / tool_use / tool_result / image(跳过)
  const messages = [];
  if (req.system) {
    const sysContent = typeof req.system === "string" ? req.system : extractTextFromBlocks(req.system);
    messages.push({ role: "system", content: sysContent });
  }
  for (const m of req.messages || []) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) {
      messages.push({ role: m.role, content: m.content ? JSON.stringify(m.content) : "" });
      continue;
    }
    // content blocks → 分三类：文本 / 工具调用 / 工具结果
    const textParts = [];
    const toolCalls = [];
    let toolResult = null;
    for (const block of m.content || []) {
      if (!block || typeof block !== "object") continue;
      switch (block.type) {
        case "text":
          if (block.text) textParts.push(block.text);
          break;
        case "image":
          break; // 跳过图片（上游免费通道不支持）
        case "tool_use": {
          let argsStr = "{}";
          try { argsStr = typeof block.input === "string" ? block.input : JSON.stringify(block.input || {}); } catch {}
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name || "", arguments: argsStr },
          });
          break;
        }
        case "tool_result": {
          let content = block.content;
          if (Array.isArray(content)) {
            content = extractTextFromBlocks(content) || "";
          } else if (typeof content !== "string") {
            content = JSON.stringify(content);
          }
          toolResult = { role: "tool", content: content || "", tool_call_id: block.tool_use_id };
          break;
        }
      }
    }
    if (m.role === "assistant" && toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: textParts.join("\n"),
        tool_calls: toolCalls,
      });
    } else if (toolResult) {
      messages.push(toolResult); // role: "tool"
    } else {
      messages.push({ role: m.role, content: textParts.join("\n") });
    }
  }

  const body = {
    model: req.model || DEFAULT_MODEL,
    max_tokens: req.max_tokens || 128000,
    session_id: sessionId,
    reasoning_effort: "high",
    messages,
  };
  // ⚠️ 免费通道（deepseek + cline-free）：非流式被上游限流，强制上游 stream 再聚合
  const forceStream = !isStream && ((req.model || "").startsWith("deepseek/") || (req.model || "").startsWith("cline-free/"));
  if (isStream || forceStream) body.stream = true;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.top_p !== undefined) body.top_p = req.top_p;
  if (req.tools) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description || "", parameters: t.input_schema || {} },
    }));
  }

  try {
    const resp = await clineFetchWithRetry(env, "/chat/completions", body, sessionId, true);
    if (!resp.ok) {
      const errText = await resp.text();
      return jsonResponse({ error: { message: "upstream error: " + errText.slice(0, 300), type: "api_error" } }, resp.status);
    }
    if (isStream) {
      // 上游是 OpenAI SSE，转成 Anthropic SSE 格式
      return streamResponseAnthropic(resp);
    }
    if (forceStream) {
      // 客户端要非流式 + 上游是流式：聚合后再转 Anthropic
      // ⚠️ 同样做 content 检测：免费通道会概率性返回"200但content全空"的流，空则切号重试
      const retried = await nonStreamWithContentCheck(env, "/chat/completions", body, sessionId, resp);
      if (retried.error) return retried.error;
      return jsonResponse(openAItoAnthropic(retried.data), 200);
    }
    const raw = await resp.json();
    const normalized = unwrapData(raw);
    // OpenAI → Anthropic
    return jsonResponse(openAItoAnthropic(normalized), 200);
  } catch (e) {
    return jsonResponse({ error: { message: e.message, type: "api_error" } }, 500);
  }
}

// ---------------------------------------------------------------------------
// 响应处理
// ---------------------------------------------------------------------------

// 剥掉上游 {data:{...}} 包装（上游有时包一层 data）
function unwrapData(obj) {
  if (obj && obj.data && typeof obj.data === "object") {
    const d = obj.data;
    if (d.choices || d.id || d.usage) return d;
  }
  return obj;
}

// OpenAI SSE 流式透传（剥 data 包装）
async function streamResponse(upstream) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buf = "";
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // 按行处理
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (payload === "" || payload === "[DONE]") {
              await writer.write(encoder.encode(line + "\n\n"));
              continue;
            }
            try {
              const obj = JSON.parse(payload);
              const normalized = unwrapData(obj);
              await writer.write(encoder.encode("data: " + JSON.stringify(normalized) + "\n\n"));
            } catch {
              await writer.write(encoder.encode(line + "\n"));
            }
          } else {
            await writer.write(encoder.encode(line + "\n"));
          }
        }
      }
    } catch (e) {
      // ignore
    } finally {
      try { await writer.close(); } catch {}
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(),
    },
  });
}

// Anthropic SSE：把上游 OpenAI chunk 转成 Anthropic 格式
// 参考 go 版 handleAnthropicStream：补全 message_start / content_block_start|stop /
// message_delta / message_stop 完整事件序列，并累积 tool_use（arguments 分片）。
async function streamResponseAnthropic(upstream) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const emit = (event, data) =>
    writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  let buf = "";
  (async () => {
    try {
      const msgID = "msg_" + Date.now().toString(16) + Math.random().toString(16).slice(2, 8);
      let stopReason = "end_turn";
      let textIndex = -1;
      let hasText = false;
      // tool 累积器：index -> {id, name, args, started}
      const toolAccs = new Map();
      let usageOut = 0;

      // 标准 Anthropic 事件序列：message_start 先行
      await emit("message_start", {
        type: "message_start",
        message: {
          id: msgID,
          type: "message",
          role: "assistant",
          content: [],
          model: "",
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "" || payload === "[DONE]") continue;
          try {
            const obj = JSON.parse(payload);
            const normalized = unwrapData(obj);
            if (normalized.usage?.completion_tokens) usageOut = normalized.usage.completion_tokens;
            const choice = normalized?.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta || {};

            // 文本增量：首次出现时先发 content_block_start
            if (delta.content) {
              if (!hasText) {
                hasText = true;
                textIndex++;
                await emit("content_block_start", {
                  type: "content_block_start",
                  index: textIndex,
                  content_block: { type: "text", text: "" },
                });
              }
              await emit("content_block_delta", {
                type: "content_block_delta",
                index: textIndex,
                delta: { type: "text_delta", text: delta.content },
              });
            }

            // 工具调用：累积 arguments 分片，首片时发 start（input 留空，随后用 input_json_delta 流式补全）
            if (delta.tool_calls && delta.tool_calls.length > 0) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index || 0;
                let acc = toolAccs.get(idx);
                if (!acc) {
                  acc = { id: "", name: "", args: "", started: false };
                  toolAccs.set(idx, acc);
                }
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name = tc.function.name;
                if (!acc.started && acc.id && acc.name) {
                  acc.started = true;
                  await emit("content_block_start", {
                    type: "content_block_start",
                    index: idx,
                    content_block: { type: "tool_use", id: acc.id, name: acc.name, input: {} },
                  });
                }
                if (tc.function?.arguments) {
                  acc.args += tc.function.arguments;
                  await emit("content_block_delta", {
                    type: "content_block_delta",
                    index: idx,
                    delta: { type: "input_json_delta", partial_json: tc.function.arguments },
                  });
                }
              }
            }

            if (choice.finish_reason) {
              if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
              else if (choice.finish_reason === "length") stopReason = "max_tokens";
            }
          } catch {}
        }
      }

      // 收尾：关闭文本块 + 所有未关闭的 tool 块
      if (hasText) {
        await emit("content_block_stop", { type: "content_block_stop", index: textIndex });
      }
      for (const [idx, acc] of toolAccs) {
        if (acc.started) {
          await emit("content_block_stop", { type: "content_block_stop", index: idx });
        }
      }

      await emit("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: usageOut },
      });
      await emit("message_stop", { type: "message_stop" });
    } catch (e) {
    } finally {
      try { await writer.close(); } catch {}
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(),
    },
  });
}

// OpenAI 非流式 → Anthropic 非流式
// 参考 go 版 openAIToAnthropic：tool_calls → tool_use content blocks，finish_reason 映射
function openAItoAnthropic(openAI) {
  const choice = openAI?.choices?.[0];
  const msg = choice?.message || {};
  const content = msg.content || "";
  const contentBlocks = [];
  if (content) contentBlocks.push({ type: "text", text: content });

  let stopReason = "end_turn";
  const toolCalls = msg.tool_calls || [];
  if (toolCalls.length > 0) {
    for (const tc of toolCalls) {
      let input = {};
      try { input = JSON.parse(tc.function?.arguments || "{}"); } catch {}
      contentBlocks.push({
        type: "tool_use",
        id: tc.id || "toolu_" + Date.now().toString(16),
        name: tc.function?.name || "",
        input,
      });
    }
    stopReason = "tool_use";
  } else if (choice?.finish_reason === "length") {
    stopReason = "max_tokens";
  }

  return {
    id: openAI?.id || "msg_" + Date.now(),
    type: "message",
    role: "assistant",
    model: openAI?.model || "",
    content: contentBlocks.length > 0 ? contentBlocks : [{ type: "text", text: "" }],
    stop_reason: stopReason,
    usage: {
      input_tokens: openAI?.usage?.prompt_tokens || 0,
      output_tokens: openAI?.usage?.completion_tokens || 0,
    },
  };
}

// 从 Anthropic content blocks 数组提取纯文本（用于 system / tool_result 等）
function extractTextFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return typeof blocks === "string" ? blocks : "";
  const parts = [];
  for (const b of blocks) {
    if (b && b.type === "text" && b.text) parts.push(b.text);
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function handleModels() {
  const list = MODELS.map((m) => ({
    id: m.id,
    object: "model",
    created: Date.now(),
    owned_by: "cline",
  }));
  return jsonResponse({ object: "list", data: list }, 200);
}

function getApiKey(request, env) {
  const provided = env.API_KEY;
  // 未配置 API_KEY → 使用内置默认 key
  const expected = provided !== undefined && provided !== null && provided !== "" ? provided : "cline2api-default-key";

  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) {
    return auth.slice(7) === expected ? expected : null;
  }
  const xKey = request.headers.get("x-api-key");
  return xKey === expected ? expected : null;
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta",
  };
}

