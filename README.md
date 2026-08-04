# Cline2API · Cloudflare Workers 版

把 Cline（https://cline.bot）的白嫖模型能力转成 OpenAI 兼容 API，部署在 Cloudflare Workers 上，免费、无服务器、无需本地运行。

> 逆向自 https://github.com/luawei1/cline2api（Go 版代理），重写为纯 JS 的 Worker。

---

## 一、准备工作：获取 Cline 的 refreshToken ⭐（最关键）

要调用 Cline 的 API，需要一个 **refreshToken**（相当于 Cline 账号的"长期钥匙"，用它换每次请求用的 accessToken）。

本仓库提供 **两个获取方式**，任选其一：

### 方式①：命令行脚本（推荐，本仓库自带 `cline_oauth.py`）

脚本会启动 Cline 官方的 **WorkOS 设备授权码流程**，你在浏览器里登录一次即可，剩余全部自动：

```bash
# 1. 运行脚本，生成授权链接
python3 cline_oauth.py

# 2. 脚本会打印一个链接，类似：
#    https://authkit.cline.bot/device?user_code=XXXX-XXXX
#    在浏览器打开，用 Google / GitHub / 邮箱登录授权

# 3. 授权完成后，脚本自动轮询并打印 refreshToken
```

> 脚本内部做的（逆向自 auth.go）：
> 1. `POST api.workos.com/.../authorize/device` → 拿 device_code + 授权链接
> 2. 轮询 `api.workos.com/.../authenticate` → 授权成功后拿 WorkOS access_token
> 3. `POST api.cline.bot/api/v1/auth/register` → 用 WorkOS token 换 Cline 的 refreshToken

### 方式②：在原版 Go 程序里提取（如果你已经用过 cline2api）

1. 下载原版 [cline2api releases](https://github.com/luawei1/cline2api/releases) 的运行文件
2. 运行 `./cline-proxy --login`，浏览器登录 Cline
3. 打开 `~/.cline2api/.cline-accounts.json`，找到 `refreshToken` 字段，复制它

---

## 二、部署到 Cloudflare Workers

### 需要的东西

- 一个 Cloudflare 账号（免费注册：[dash.cloudflare.com](https://dash.cloudflare.com)）
- 上一步拿到的 `CLINE_REFRESH_TOKEN`

### 部署步骤（DASHBOARD 图形界面版，无需命令行）

1. 登录 [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **创建** → **创建 Worker**
2. 名字填 `cline2api`（可自定义）→ **部署**
3. 进入 Worker → **编辑代码** → 把本仓库 `worker.js` 的**全部内容**粘贴进去（覆盖默认代码）→ **部署**
4. **配置机密变量**：
   - Worker → **设置** → **变量和机密** → 添加：
     - **机密**：`CLINE_REFRESH_TOKEN` = 第一步拿到的 refreshToken（⚠️ 必填，值保密）
     - **文本**：`API_KEY` = 给客户端访问用的密钥，例如 `my-secret-key-123`（可选，不设则用内置默认）
5. 完成！你的 API Base URL 就是 `https://cline2api.<你的子域>.workers.dev`

### 命令行版（wrangler，可选）

```bash
npm install -g wrangler
wrangler login                      # 浏览器登录你的 Cloudflare
wrangler deploy                     # 部署 worker.js
echo "你的refreshToken" | wrangler secret put CLINE_REFRESH_TOKEN   # 设置机密
```

### 验证部署

```bash
curl https://cline2api.<你的子域>.workers.dev/v1/models \
  -H "Authorization: Bearer my-secret-key-123"
```
应返回模型列表。再发一次聊天：

```bash
curl https://cline2api.<你的子域>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"你好"}]}'
```

---

## 三、使用

```text
Base URL: https://cline2api.<你的子域>.workers.dev/v1
API Key:  <你设置的 API_KEY>
Model:    deepseek/deepseek-v4-flash   （默认）
```

兼容 OpenAI 客户端（`/v1/chat/completions`）和 Anthropic 客户端（`/v1/messages`，自动转换）。

### 可用模型（实测）

| 模型 ID | 结果 |
|---|---|
| `deepseek/deepseek-v4-flash` | ✅ **免费可用**（默认） |
| `poolside/laguna-s-2.1:free` | ✅ **免费可用** |
| `cline-free/glm-5.2` | ❌ 403，官方锁定为"仅 Cline 客户端" |
| `cline-pass/*` | ❌ 403，需付费 cline-pass 订阅 |

> ⚠️ `cline-free/glm-5.2` 目前被官方限制（2026-08 实测 403），所以默认模型用 `deepseek/deepseek-v4-flash`。

---

## 四、项目结构

```
.
├── worker.js          # 主 Worker 代码（部署核心）
├── cline_oauth.py     # 获取 CLINE_REFRESH_TOKEN 的脚本 ⭐
├── wrangler.toml      # wrangler 配置（命令行部署用）
├── test_request.json  # 测试请求示例
└── README.md          # 本文件
```

## 五、获取 refreshToken 常见问题

**Q: 谁能看到我的 refreshToken？**
→ 只有你。它存在 CF Workers 的**机密变量**里（加密存储，代码里看不到、日志里不显示）。不要把 `wrangler.toml` 里的变量跟真实 refreshToken 混写，机密务必用 `wrangler secret` 或 Dashboard 的"机密"类型。

**Q: refreshToken 会过期吗？**
→ 会，但 Cline 的 refreshToken 有效期较长。如果将来请求返回 401/403 token 失效，重新跑 `cline_oauth.py` 拿新的即可。

**Q: 免费额度够用吗？**
→ `deepseek/deepseek-v4-flash` 属于免费模型，日常够用；如果想用更好的 `cline-pass/*` 需要付费订阅 Cline pass。

---

## 许可

MIT © 2026 pingmike2