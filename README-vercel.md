# Cline2API · Vercel 分支版

> 这是 `vercel` 分支：把 Cline（https://cline.bot）的白嫖模型能力转成 OpenAI 兼容 API，**部署在 Vercel Edge Function** 上。
>
> 与 `main` 分支（Cloudflare Workers 版）逻辑完全一致，仅入口适配 Vercel Edge Runtime。

## 为什么用 Vercel？

- Workers 免费档容易触发限流/被风控，Vercel Edge Function 免费档（Hobby）同样免费
- 代码几乎不用改：Vercel Edge Runtime 原生支持 `fetch` / `Request` / `Response` / `TextEncoder`
- 唯一差异：环境变量从 `process.env` 读取（`api/index.js` 顶部已适配）

## 文件结构

```
├── api/index.js   # Vercel Edge Function 入口（完整逻辑，独立自包含）
├── vercel.json    # 路由重写：/v1/* → /api/index
├── worker.js      # 保留的 Cloudflare 版（参考，Vercel 部署用不到）
└── cline_oauth.py # 获取 Cline refreshToken 的脚本（两分支通用）
```

## 部署到 Vercel

### 方式①：Vercel Dashboard（推荐，图形界面）

1. 打开 [vercel.com/new](https://vercel.com/new)
2. Import 仓库 `pingmike2/cline2api-workers`，选择 **vercel** 分支
3. Framework Preset 选 **Other**
4. 添加环境变量：
   - `CLINE_REFRESH_TOKEN`：Cline 账号 refreshToken（多账号用换行分隔）
   - `API_KEY`（可选）：自定义访问 key
5. Deploy

### 方式②：Vercel CLI

```bash
npm i -g vercel
vercel --prod \
  --env CLINE_REFRESH_TOKEN="你的refreshToken" \
  --env API_KEY="你的key"
```

## 获取 refreshToken

与 main 分支相同，见 [README.md](./README.md) 的「准备工作」章节，用仓库自带的 `cline_oauth.py` 或 GitHub Actions 工作流获取。

## 测试

```bash
# 健康检查
curl https://你的域名/v1/health

# OpenAI 兼容
curl https://你的域名/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"cline/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

## 与 main 分支的差异

| 项 | main（Cloudflare） | vercel（本分支） |
|---|---|---|
| 运行环境 | Workers | Edge Function |
| 环境变量 | `wrangler secret` | Vercel Env Variables |
| 入口 | `export default { fetch(request, env) }` | `export default async function handler(request)` |
| 路由 | Worker 内置路由 | `vercel.json` rewrites |
| 部署 | `wrangler deploy` | Vercel Dashboard / CLI |

> ⚠️ 两个分支代码同步维护：改逻辑时记得 `git merge main` 或手动同步 `api/index.js`。
