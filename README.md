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

### 方式②：GitHub Actions 工作流（无需本地环境，手机上也能操作）⭐

仓库自带 `.github/workflows/get-token.yml` 工作流，**在手机上也能跑**：你只需在手机浏览器点开 TG 推送的授权链接完成登录，脚本在云端自动轮询，拿到的 refreshToken **只私发到你的 Telegram，绝不进 Actions 日志**。

**第一步：配置 TG 变量（强制，不配不运行）**

在仓库 **Settings → Secrets and variables → Actions** 里添加两个 secret：
- `TG_BOT_TOKEN`：你的 Telegram Bot 的 token
- `TG_CHAT_ID`：接收消息的 chat_id（你自己的 id）

> 缺任一个，工作流都会直接报错退出，不进入授权流程。

**第二步：手动触发**

1. 进入仓库 **Actions** 页 → 点击左侧 **「获取 Cline refreshToken」**
2. 点右边 **Run workflow** → 可选手动填授权等待秒数（默认 300）→ 运行
3. Telegram 会收到**授权链接 + 设备码** → 用手机/电脑浏览器打开，Google/GitHub/邮箱 登录授权
4. 授权成功 → TG 收到 **`refreshToken`**，直接复制填入 CF Worker 机密变量即可

**安全说明：**
- 🔒 `refreshToken` 与账号**邮箱都不会出现在 Actions 日志**（`::add-mask::` 双重打码 + 只推 TG）
- 🔁 工作流运行完自动**清理旧运行记录，只保留最新 1 条**
- ⏱️ 授权链接推送 TG 失败会中止，宁可失败也不把 token 写进日志

### 方式③：在原版 Go 程序里提取（如果你已经用过 cline2api）

1. 下载原版 [cline2api releases](https://github.com/luawei1/cline2api/releases) 的运行文件
2. 运行 `./cline-proxy --login`，浏览器登录 Cline
3. 打开 `~/.cline2api/.cline-accounts.json`，找到 `refreshToken` 字段，复制它

---

## 二、部署到 Cloudflare Workers

> ⚠️ **推荐方式：复制代码粘贴部署，不要用 Git 关联仓库部署。**
> 实测 GitHub 关联 CF 部署（Git 集成）容易因入口文件/构建环境问题导致部署失败，
> 且改环境变量后不会自动生效。用下方「复制代码」方式最稳、最快。

### 需要的东西

- 一个 Cloudflare 账号（免费注册：[dash.cloudflare.com](https://dash.cloudflare.com)）
- 上一步拿到的 `CLINE_REFRESH_TOKEN`

### 部署步骤（复制代码版，推荐 ✅）

1. 打开本仓库 `worker.js`，**全选复制全部代码**
2. 登录 [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **创建** → **创建 Worker**
3. 名字填 `cline2api`（可自定义）→ **部署**
4. 进入 Worker → **编辑代码** → 删除默认代码，**粘贴**刚才复制的 `worker.js` 全部内容 → **部署**（右上角）
5. **配置环境变量**（重点 ⚠️）：
   - Worker → **设置** → **变量和机密** → **添加**：
     - **机密(Secret)**：`CLINE_REFRESH_TOKEN` = 第一步拿到的 refreshToken（必填）
       - **支持多账号**：一行一个 token，见下文「多账号」章节
     - **机密(Secret)**：`API_KEY` = 你的访问密钥，例如 `sk-cline-xxx`（建议必填，可自定义）
   - ⚠️ **保存后必须再点一次「部署」触发重新编译**，变量才会生效！
6. 完成！你的 API Base URL 就是 `https://cline2api.<你的子域>.workers.dev`

> 💡 验证环境变量是否生效，访问诊断端点：
> ```bash
> curl https://cline2api.<你的子域>.workers.dev/v1/health
> ```
> 返回 `api_key_configured: true` 即表示变量已生效，`account_count` 显示已配置的账号数量。

### 需要的东西&环境变量说明

| 变量名 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `CLINE_REFRESH_TOKEN` | 机密 Secret | ✅ | Cline 账号 refreshToken，**一行一个，支持多账号** |
| `API_KEY` | 机密 Secret | 建议 | 客户端访问密钥；不设则用默认 `cline2api-default-key` |

> 变量名必须**完全一致**（全大写、无空格）。修改后**务必保存并重新部署**才会生效。

### 🔁 多账号（额度用完自动切号）⭐

一个账号的免费额度/限流用完时，想切下一个号？不用改任何东西，**在 `CLINE_REFRESH_TOKEN` 里一行填一个 token 即可**：

```
第一个账号的refreshToken
第二个账号的refreshToken
第三个账号的refreshToken
```

**工作机制：**
- 🔄 **账号池轮询**：请求轮流使用不同账号（round-robin），分散单账号压力
- ⚡ **额度用完自动切号**：某账号触发空响应（额度用完/限流），**自动冷却该账号 60 秒并切到下一个**，同一请求换号重试
- 🚫 **失效自动跳过**：刷新失败的账号会被跳过，不阻塞
- ✅ **独立缓存**：每个账号各自的 accessToken 独立缓存，互不影响
- 单账号时完全兼容，原样工作

**验证：** 部署后访问 `/v1/health`，返回 `account_count` 即当前账号数量。

### 验证部署

```bash
curl https://cline2api.<你的子域>.workers.dev/v1/models \
  -H "Authorization: Bearer <你的API_KEY>"
```
应返回模型列表。再发一次聊天：

```bash
curl https://cline2api.<你的子域>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer <你的API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"你好"}]}'
```

---

## 三、在 AgentScope 平台调用（模型接入）

把该 Worker 当作 OpenAI 兼容 API 接入 **AgentScope（QwenPaw / qwenpaw.agentscope.io）** 时：

### ⚠️ 关键：直接用 Workers 域名，不要用自定义域名

- **用 `https://cline2api.<你的子域>.workers.dev/v1`** 作为模型 **Base URL / API Base**。
- **不要用绑定的自定义域名**（如 `api.llm.xxx.com`）：AgentScope 平台对接时，
  自定义域名可能因证书/路由/鉴权头处理问题导致调用失败或鉴权不过，
  直接用 Workers 官方域名最稳。

### AgentScope 里怎么配（OpenAI 兼容模式）

- **API Base / Base URL**：`https://cline2api.<你的子域>.workers.dev/v1`
  （部分平台要求不带 `/v1` 的填写为 `https://cline2api.<你的子域>.workers.dev`，按平台提示试）
- **API Key**：填你设置的 `API_KEY` 值（如 `sk-cline-xxx`）
- **Model**：`deepseek/deepseek-v4-flash`（或其他可用模型）

> 若 AgentScope 平台走的标准 OpenAI SDK，直接指定上述 base_url + api_key 即可。
> 若测试报 401，请确认 `API_KEY` 变量已在 CF 配置并重新部署过。

---

## 四、使用

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

## 五、项目结构

```
.
├── worker.js          # 主 Worker 代码（部署核心）
├── cline_oauth.py     # 获取 CLINE_REFRESH_TOKEN 的脚本 ⭐
├── .github/workflows/
│   └── get-token.yml  # 手动运行的工作流：在 TG 上获取 refreshToken
├── wrangler.toml      # (可选) wrangler 命令行部署配置，用复制代码方式可忽略
├── test_request.json  # 测试请求示例
└── README.md          # 本文件
```

## 六、获取 refreshToken 常见问题

**Q: 谁能看到我的 refreshToken？**
→ 只有你。它存在 CF Workers 的**机密变量**里（加密存储，代码里看不到、日志里不显示）。不要把 `wrangler.toml` 里的变量跟真实 refreshToken 混写，机密务必用 `wrangler secret` 或 Dashboard 的"机密"类型。

**Q: refreshToken 会过期吗？**
→ 会，但 Cline 的 refreshToken 有效期较长。如果将来请求返回 401/403 token 失效，重新跑 `cline_oauth.py` 拿新的即可。

**Q: 免费额度够用吗？**
→ `deepseek/deepseek-v4-flash` 属于免费模型，日常够用；如果想用更好的 `cline-pass/*` 需要付费订阅 Cline pass。

---

## 许可

MIT © 2026 pingmike2