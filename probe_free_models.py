#!/usr/bin/env python3
"""
probe_free_models.py — Cline API 免费模型探测工具

用你的 CLINE_REFRESH_TOKEN 换 accessToken，批量探测候选模型名，
通过解析返回的 cost 字段（cost=N/A 即免费）识别当前可白嫖的免费模型。

用法：
    export CLINE_REFRESH_TOKEN="你的refreshToken"   # 也可用 --token 参数
    python3 probe_free_models.py [--token xxx] [--output result.json]

说明：
    - 免费模型 cost=N/A（不扣费）；付费模型 cost>0（走 usage-billing 记账）
    - 探测是耗额度的吗？免费模型不计费；付费模型会自动记账，谨慎
    - 上游的免费模型是限时轮换的，建议定期重跑本脚本
"""

import argparse
import json
import os
import sys
import time

import httpx

CLINE_API_BASE = "https://api.cline.bot/api/v1"

# 完整 Cline 客户端指纹头（绕开 401/403 "only available via Cline product surfaces"）
def cline_headers(token: str) -> dict:
    return {
        "Authorization": "Bearer workos:" + token,
        "Content-Type": "application/json",
        "User-Agent": "Cline/3.0.47",
        "Accept": "application/json",
        "HTTP-Referer": "https://cline.bot",
        "X-Title": "Cline",
        "X-CLIENT-TYPE": "cline-sdk",
        "X-CLIENT-VERSION": "3.0.47",
        "X-PLATFORM": "terminal",
        "X-PLATFORM-VERSION": "3.0.47",
    }


def get_access_token(refresh_token: str) -> str:
    """refreshToken 换 accessToken（对应原版 auth.go refreshClineToken）"""
    resp = httpx.post(
        f"{CLINE_API_BASE}/auth/refresh",
        json={"refreshToken": refresh_token, "grantType": "refresh_token"},
        timeout=30,
    )
    resp.raise_for_status()
    token = resp.json().get("data", {}).get("accessToken")
    if not token:
        raise RuntimeError("刷新 token 失败：返回中没有 accessToken")
    return token


# 候选模型名池（可自行增删；覆盖主流开源 + 常见免费通道命名）
DEFAULT_CANDIDATES = [
    # ---- 已知免费（基准）----
    "deepseek/deepseek-v4-flash",
    "poolside/laguna-s-2.1:free",
    # ---- deepseek 系 ----
    "depth/deepseek-v4-flash",
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-chat",
    "deepseek/deepseek-v3.1",
    "deepseek/deepseek-v3",
    "deepseek/deepseek-v4-pro:free",
    "deepseek/deepseek-v4-flash:free",
    "deepseek/deepseek-r1:free",
    # ---- GLM / Zai ----
    "zai/glm-5.2",
    "zai/glm-4.6",
    "zai/glm-4.7",
    "zai/glm-4.6:free",
    "zai/glm-5.2:free",
    # ---- Qwen ----
    "qwen/qwen3.7-max",
    "qwen/qwen3.7-plus",
    "qwen/qwen3.7-max:free",
    "qwen/qwen3-235b-a22b:free",
    # ---- Poolside（其它版本）----
    "poolside/laguna-s-2.0:free",
    "poolside/laguna-xs.2:free",
    "poolside/laguna-s-2.1",
    # ---- Kimi / Moonshot ----
    "moonshotai/kimi-k3:free",
    "moonshotai/kimi-k2:free",
    "kimi/kimi-k2:free",
    # ---- 其它开源/免费 ----
    "mistralai/mistral-small-3.2:free",
    "meta-llama/llama-4-scout:free",
    "google/gemini-2.5-flash:free",
    "google/gemma-3-27b:free",
    "minimax/minimax-text-01:free",
    "x-ai/grok-3:free",
    "openai/gpt-5-mini:free",
    "anthropic/claude-sonnet-4",
    "honk/honk-v4:free",
]


def probe_model(token: str, model: str, headers: dict) -> dict:
    body = {
        "model": model,
        "messages": [{"role": "user", "content": "Reply with the two words: hello world"}],
        "max_tokens": 120,
        "stream": False,
        "session_id": "probe_" + model.replace("/", "_").replace(":", "_"),
    }
    try:
        resp = httpx.post(
            f"{CLINE_API_BASE}/chat/completions", headers=headers, json=body, timeout=45
        )
        status = resp.status_code
        if status == 200:
            inner = resp.json().get("data", resp.json())
            msg = inner.get("choices", [{}])[0].get("message", {})
            content = msg.get("content") or ""
            cost = msg.get("provider_metadata", {}).get("gateway", {}).get("cost", "N/A")
            return {"model": model, "status": 200, "cost": cost, "content": content[:60],
                    "free": (cost == "N/A" and len(content) > 0)}
        return {"model": model, "status": status, "cost": None,
                "error": resp.text[:120], "free": False}
    except Exception as e:
        return {"model": model, "status": "ERR", "cost": None,
                "error": str(e)[:120], "free": False}


def main():
    ap = argparse.ArgumentParser(description="Cline API 免费模型探测")
    ap.add_argument("--token", default=os.environ.get("CLINE_REFRESH_TOKEN", ""),
                    help="Cline refreshToken（或用 CLINE_REFRESH_TOKEN 环境变量）")
    ap.add_argument("--output", default="", help="输出结果的 JSON 路径（可选）")
    ap.add_argument("--sample", action="store_true",
                    help="只探测内置候选池；缺省也探测内置池")
    args = ap.parse_args()

    if not args.token:
        print("❌ 缺少 refreshToken。用 --token 或设 CLINE_REFRESH_TOKEN 环境变量")
        sys.exit(1)

    print("🔑 换取 accessToken ...")
    token = get_access_token(args.token)
    print("✅ 已登录 (Cline 账号)")

    headers = cline_headers(token)
    results = []
    for m in DEFAULT_CANDIDATES:
        r = probe_model(token, m, headers)
        results.append(r)
        if r["free"]:
            print(f"  ✨ FREE  {r['model']} :: {r['content']!r}")
        elif r["status"] == 200:
            print(f"  💰 paid  {r['model']} (cost={r['cost']})")
        # 其余 404/500 静默
        time.sleep(0.6)

    free = [r for r in results if r["free"]]
    print("\n" + "=" * 60)
    print("📊 免费模型汇总：")
    if free:
        for r in free:
            print(f"  ✅ {r['model']}")
    else:
        print("  ⚠️  本次未探测到免费模型（可能上游已轮换，或候选池需扩充）")
    print(f"探测 {len(results)} 个模型，其中免费 {len(free)} 个")

    if args.output:
        with open(args.output, "w") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        print(f"📄 完整结果已写入 {args.output}")


if __name__ == "__main__":
    main()
