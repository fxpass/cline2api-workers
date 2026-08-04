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
// 注意：cline-free/* 被官方客户端锁定（403），cline-pass/* 需付费订阅，
//       免费可用的白嫖模型是 deepseek/deepseek-v4-flash 和 poolside/*:free
const MODELS = [
  { id: "deepseek/deepseek-v4-flash", provider: "deepseek", cost: "free" },
  { id: "poolside/laguna-s-2.1:free", provider: "poolside", cost: "free" },
  { id: "cline-free/glm-5.2", provider: "zai", cost: "locked" },
  { id: "cline-pass/glm-5.2", provider: "zai", cost: "pass" },
  { id: "cline-pass/deepseek-v4-flash", provider: "deepseek", cost: "pass" },
  { id: "cline-pass/qwen3.7-max", provider: "qwen", cost: "pass" },
];

// 默认模型：用实测可用的白嫖模型
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

async function clineFetch(env, path, bodyObj, sessionId, retried = false) {
  const acc = currentAccount || null;
  const token = await getAccessToken(env);
  const headers = {
    Authorization: "Bearer workos:" + token,
    "Content-Type": "application/json",
    "X-Task-ID": sessionId,
  };
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

// 带重试的 clineFetch：空响应/5xx 自动切换账号 + 指数退避重试
// 空响应(额度用完)会冷却当前账号，下次自动轮换到下一个号
// isStream=true 时跳过 body 空响应检测（SSE 流不能整体 read，交给调用方处理）
async function clineFetchWithRetry(env, path, bodyObj, sessionId, isStream = false, maxRetries = 4) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 通过队列串行执行，避免并发空响应
    const resp = await enqueue(() => clineFetch(env, path, bodyObj, sessionId));
    let hitEmpty = false;

    if (resp.ok && !isStream) {
      // 非流式：额外检测上游 200 但 body 是空响应包装
      const text = await resp.clone().text();
      if (!text.includes("empty response content")) {
        return resp;
      }
      hitEmpty = true;
      console.log(`[retry] empty response content (attempt ${attempt + 1}/${maxRetries})`);
    } else if (isStream) {
      // 流式：只要 HTTP 200 就直接转发，空流/错误由流式处理器判断
      return resp;
    } else if (resp.status !== 500 && resp.status !== 502 && resp.status !== 503 && resp.status !== 504) {
      // 非 5xx 错误（如 403/400）不重试，直接返回
      return resp;
    } else {
      const errText = await resp.clone().text();
      if (!errText.includes("empty response content")) {
        return resp; // 其他 5xx，不盲目重试
      }
      hitEmpty = true;
      console.log(`[retry] 5xx empty (attempt ${attempt + 1}/${maxRetries})`);
    }

    if (hitEmpty) {
      // 额度用完：冷却当前账号，下一轮自动切到下个号
      if (currentAccount) {
        currentAccount.cooldownUntil = Date.now() + 60 * 1000;
        currentAccount.accessToken = null;
        currentAccount.expiry = 0;
        console.log(`[account-switch] 账号额度用完，标记冷却，切换到下一个`);
      }
      // 切号后短退避，避免全部同时冷却
      const short = 500 + Math.floor(Math.random() * 500);
      await sleep(short);
      continue;
    }

    // 指数退避：约 1.5s, 3s, 6s, 12s（免费通道拥挤时空响应可持续数秒）
    const backoff = Math.min(1500 * Math.pow(2, attempt), 12000);
    console.log(`[retry] waiting ${backoff}ms...`);
    await sleep(backoff);
  }
  // 全部重试失败，返回最后一次响应
  return enqueue(() => clineFetch(env, path, bodyObj, sessionId));
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

  // 构造上游 body（与原版 buildUpstreamBody 一致）
  const body = {
    model: params.model || DEFAULT_MODEL,
    max_tokens: params.max_tokens || params.max_completion_tokens || 128000,
    session_id: sessionId,
    reasoning_effort: params.reasoning_effort || params.reasoningEffort || "high",
    messages: params.messages || [],
  };
  if (isStream) body.stream = true;
  // 透传可选参数
  for (const k of ["temperature", "top_p", "tools", "tool_choice", "stop", "presence_penalty", "frequency_penalty", "response_format", "user", "n", "seed"]) {
    if (params[k] !== undefined) body[k] = params[k];
  }

  try {
    const resp = await clineFetchWithRetry(env, "/chat/completions", body, sessionId, isStream);
    if (!resp.ok) {
      const errText = await resp.text();
      return jsonResponse({ error: { message: "upstream error: " + errText.slice(0, 300), type: "api_error" } }, resp.status);
    }
    if (isStream) {
      return streamResponse(resp);
    }
    // 非流式：剥掉 {data:{...}} 包装
    const raw = await resp.json();
    const normalized = unwrapData(raw);
    return jsonResponse(normalized, 200);
  } catch (e) {
    return jsonResponse({ error: { message: e.message, type: "api_error" } }, 500);
  }
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

  // Anthropic → OpenAI 消息转换
  const messages = [];
  if (req.system) {
    const sysContent = typeof req.system === "string" ? req.system : JSON.stringify(req.system);
    messages.push({ role: "system", content: sysContent });
  }
  for (const m of req.messages || []) {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    messages.push({ role: m.role, content });
  }

  const body = {
    model: req.model || DEFAULT_MODEL,
    max_tokens: req.max_tokens || 128000,
    session_id: sessionId,
    reasoning_effort: "high",
    messages,
  };
  if (isStream) body.stream = true;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.top_p !== undefined) body.top_p = req.top_p;
  if (req.tools) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description || "", parameters: t.input_schema || {} },
    }));
  }

  try {
    const resp = await clineFetchWithRetry(env, "/chat/completions", body, sessionId, isStream);
    if (!resp.ok) {
      const errText = await resp.text();
      return jsonResponse({ error: { message: "upstream error: " + errText.slice(0, 300), type: "api_error" } }, resp.status);
    }
    if (isStream) {
      // 上游是 OpenAI SSE，转成 Anthropic SSE 格式
      return streamResponseAnthropic(resp);
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
async function streamResponseAnthropic(upstream) {
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
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (payload === "" || payload === "[DONE]") continue;
            try {
              const obj = JSON.parse(payload);
              const normalized = unwrapData(obj);
              const choice = normalized?.choices?.[0];
              if (!choice) continue;
              const delta = choice.delta || {};
              if (delta.content) {
                await writer.write(encoder.encode("event: content_block_delta\ndata: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta.content } }) + "\n\n"));
              }
              if (delta.tool_calls && delta.tool_calls.length > 0) {
                for (const tc of delta.tool_calls) {
                  await writer.write(encoder.encode("event: content_block_delta\ndata: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(tc.function?.arguments || "") } }) + "\n\n"));
                }
              }
            } catch {}
          }
        }
      }
      // 结束事件
      await writer.write(encoder.encode("event: message_delta\ndata: " + JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } }) + "\n\n"));
      await writer.write(encoder.encode("event: message_stop\ndata: " + JSON.stringify({ type: "message_stop" }) + "\n\n"));
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
function openAItoAnthropic(openAI) {
  const choice = openAI?.choices?.[0];
  const content = choice?.message?.content || "";
  return {
    id: openAI?.id || "msg_" + Date.now(),
    type: "message",
    role: "assistant",
    model: openAI?.model || "",
    content: [{ type: "text", text: content }],
    stop_reason: "end_turn",
    usage: {
      input_tokens: openAI?.usage?.prompt_tokens || 0,
      output_tokens: openAI?.usage?.completion_tokens || 0,
    },
  };
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
