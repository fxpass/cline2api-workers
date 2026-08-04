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

// 内存缓存：accessToken + 过期时间
let cachedAccessToken = null;
let cachedExpiry = 0; // unix ms

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

async function getAccessToken(env) {
  const refreshToken = env.CLINE_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error("缺少 CLINE_REFRESH_TOKEN 环境变量");
  }
  if (cachedAccessToken && Date.now() < cachedExpiry) {
    return cachedAccessToken;
  }

  const resp = await fetch(CLINE_API_BASE + "/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      refreshToken: refreshToken,
      grantType: "refresh_token",
    }),
  });
  if (!resp.ok) {
    throw new Error("刷新 token 失败: " + resp.status + " " + (await resp.text()).slice(0, 200));
  }
  const data = await resp.json();
  const accessToken = data?.data?.accessToken;
  if (!accessToken) {
    throw new Error("刷新 token 响应缺少 accessToken");
  }
  cachedAccessToken = accessToken;
  // 过期时间：优先用服务端返回，兜底 10 分钟
  const expiresAt = data?.data?.expiresAt;
  let expiry = Date.now() + 10 * 60 * 1000;
  if (typeof expiresAt === "number") {
    expiry = expiresAt;
  } else if (typeof expiresAt === "string") {
    const t = Date.parse(expiresAt);
    if (!isNaN(t)) expiry = t;
  }
  // 留 60s 余量
  cachedExpiry = expiry - 60000;
  return accessToken;
}

async function clineFetch(env, path, bodyObj, sessionId, retried = false) {
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
    // 强制刷新 token 重试一次
    cachedAccessToken = null;
    cachedExpiry = 0;
    return clineFetch(env, path, bodyObj, sessionId, true);
  }
  return resp;
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
    const resp = await clineFetch(env, "/chat/completions", body, sessionId);
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
    const resp = await clineFetch(env, "/chat/completions", body, sessionId);
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
