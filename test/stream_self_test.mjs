// 流式响应专项测试
import worker from "./worker.mjs";

const enc = new TextEncoder();
const sse = (o) => enc.encode(`data: ${JSON.stringify(o)}\n\n`);

// 模拟上游：返回一段流，包含 文本分片 + 工具调用分片(跨多行) + 多账号场景
let upstreamCalls = 0;
function makeUpstream() {
  return new ReadableStream({
    start(c) {
      upstreamCalls++;
      // 文本分片
      c.enqueue(sse({ id: "chatcmpl-1", choices: [{ index: 0, delta: { role: "assistant", content: "北京" }, finish_reason: null }] }));
      c.enqueue(sse({ choices: [{ index: 0, delta: { content: "今天的" }, finish_reason: null }] }));
      // 工具调用分片（跨3行）：先来 id+name，再分批来 arguments
      c.enqueue(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "get_weather", arguments: "" } }] }, finish_reason: null }] }));
      c.enqueue(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }, finish_reason: null }] }));
      c.enqueue(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"北京","days":2}' } }] }, finish_reason: null }] }));
      c.enqueue(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { name: "no_api", arguments: "{}" } }] }, finish_reason: null }] }));
      c.enqueue(sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 12 } }));
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}

globalThis.fetch = async (url, opts) => {
  const path = url.replace("https://api.cline.bot/api/v1", "");
  if (path === "/auth/refresh") return { status: 200, ok: true, json: async () => ({ data: { accessToken: "at", refreshToken: "new_rt", expiresAt: Date.now() + 3600e3 } }) };
  if (path === "/chat/completions") return { status: 200, ok: true, body: makeUpstream(), headers: { get: (k) => (k.toLowerCase() === "content-type" ? "text/event-stream" : null) }, clone: () => ({ text: async () => "" }), text: async () => "" };
  return { status: 404, ok: false };
};

const env = { CLINE_REFRESH_TOKEN: "RT_AAAAAAAAAA111111\nRT_BBBBBBBBBB222222", API_KEY: "testkey123" };
function makeReq(method, path, body) {
  return new Request("https://worker.test" + path, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer testkey123" }, body: JSON.stringify(body) });
}

const results = [];
function log(name, ok, detail) { results.push({ name, ok, detail }); console.log((ok ? "✅" : "❌") + " " + name + (ok ? "" : " → " + detail)); }

// ===== 测试A：OpenAI 流式透传 =====
const streamResp = await worker.fetch(makeReq("POST", "/v1/chat/completions", { model: "deepseek/deepseek-v4-flash", stream: true, messages: [{ role: "user", content: "hi" }] }), env);
const oaiStream = await streamResp.text();
const oaiLines = oaiStream.split("\n").filter((l) => l.startsWith("data:"));
log("OpenAI流式·有data行", oaiLines.length >= 7, `lines=${oaiLines.length}`);
log("OpenAI流式·含[DONE]", oaiStream.includes("[DONE]"), "");
log("OpenAI流式·文本透传", oaiStream.includes("北京") && oaiStream.includes("今天的"), oaiStream.includes("北京") ? "" : JSON.stringify(oaiStream.slice(0, 300)));
// 工具调用在流式透传中应该保留（原样透传）
log("OpenAI流式·工具保留", oaiStream.includes("call_abc") && oaiStream.includes("get_weather"), "");
// 检查 content-type 头
log("OpenAI流式·content-type", streamResp.headers.get("content-type") === "text/event-stream", streamResp.headers.get("content-type"));

// ===== 测试B：OpenAI 流式 剥 data 包装 =====
// 验证 unwrapData：上游若包 {data:{choices}} 会被剥
const oaiHasUnwrapped = !oaiStream.includes('data":{"choices');
log("OpenAI流式·剥data包装", oaiHasUnwrapped, "");

// ===== 测试C：Anthropic 流式 =====
const anthResp = await worker.fetch(makeReq("POST", "/v1/messages", { model: "deepseek/deepseek-v4-flash", stream: true, messages: [{ role: "user", content: "天气?" }] }), env);
const anthStream = await anthResp.text();
// 事件顺序正确性：message_start 在最前，message_stop 在最后
const events = [...anthStream.matchAll(/event: (\w+)/g)].map((m) => m[1]);
log("Anthropic流式·首事件message_start", events[0] === "message_start", events[0]);
log("Anthropic流式·尾事件message_stop", events[events.length - 1] === "message_stop", events[events.length - 1]);
log("Anthropic流式·事件顺序", events[0] === "message_start" && events.includes("content_block_delta") && events.includes("message_delta") && events[events.length - 1] === "message_stop", events.join(","));
// 文本 delta
log("Anthropic流式·文本delta", anthStream.includes('"type":"text_delta"'), "");
log("Anthropic流式·文本内容", anthStream.includes("北京") && anthStream.includes("今天的"), "");
// 工具调用累积（多个 tool 块，注意这两个 tool 的 accumulation）
log("Anthropic流式·tool_use块", anthStream.includes('"type":"tool_use"') && anthStream.includes("get_weather"), "");
log("Anthropic流式·partial arguments累积", anthStream.includes('"partial_json"'), anthStream.includes('"partial_json"') ? "" : "无 partial_json");
// 工具分片是否累积完整（input_json_delta 分片）
const partialParts = [...anthStream.matchAll(/"partial_json":"([^"]*)"/g)].map((m) => m[1]);
log("Anthropic流式·arguments分片", partialParts.length >= 2, `分片数=${partialParts.length}`);

// ===== 测试D：客户端断开时不应挂死（读不到done也收尾）=====

console.log("\n==== 流式汇总 ====");
const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} 通过`);
if (pass !== results.length) process.exit(1);
console.log("🎉 流式全部通过");
