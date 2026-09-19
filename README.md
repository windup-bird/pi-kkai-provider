# pi-kkai-provider

把 [KKAI / KKRICH](https://api.kkrich.ltd) 的 OpenAI 兼容接口接入 [pi](https://github.com/earendil-works/pi-mono) 的 provider 扩展：登录、模型发现、真实单价。

采用 pi 推荐的**最简集成方式** —— `pi.registerProvider(id, config)`（provider-config 形式），复用内建 `openai-completions`，不写自定义 `streamSimple`，也不添加任何 `/kkai-*` 命令。

因为每个模型都带真实 `cost` 与真实的上下文窗口，pi **内建的 footer、`/session`、自动压缩**天然就是准的，无需额外的用量命令。

## 安装

```bash
git clone https://github.com/windup-bird/pi-kkai-provider.git
pi install ./pi-kkai-provider    # 或在本目录执行 pi install
```

安装后重启 pi（或 `/reload`）。

## 登录

```bash
pi
/login kkai                      # 粘贴 sk-... 密钥，凭据写入 ~/.pi/agent/auth.json

# 或者用环境变量
export KKRICH_API_KEY="sk-..."   # 也支持 KKAI_API_KEY
```

登录后 pi 会自动刷新一次模型列表。

## 模型发现

```bash
pi --list-models                 # 列出全部 kkai 模型（含上下文/输出上限/单价）
/model                           # 在 TUI 中搜索切换
```

1. `GET /api/pricing`（公开，无需密钥）→ 模型名、`model_ratio`、`completion_ratio`、`cache_ratio`、`create_cache_ratio`，生成初始清单与单价。
2. 登录后 `GET /v1/models`（Bearer）→ 收敛为该密钥实际可用的模型。
3. `quota_type != 0`（按次计费）的条目全部排除，因此图片/视频类 SKU 不会混进对话模型列表。

## 上下文与能力

模型名与价格来自网关；**上下文窗口、最大输出、是否思考、是否支持图片来自 pi 自带的模型目录** —— 网关本身不提供这些字段（`/api/pricing`、`/v1/models`、`/v1beta/models` 的 `inputTokenLimit` 全为空）。

网关的模型名是上游的别名，会先归一化再匹配目录：

```
glm-5.3-token                  -> glm-5.3
claude-haiku-4-5-20251001      -> claude-haiku-4-5
deepseek-v4-flash-0731-token   -> deepseek-v4-flash-0731 -> deepseek-v4-flash
gemini-3-pro-preview           -> gemini-3-pro
```

目录未命中的模型使用默认值 **1M 上下文 / 64K 输出**，可用 `~/.pi/agent/models.json` 的 `modelOverrides` 单独修正。

## 费用

new-api 计费：`quota = tokens × ratio × group_ratio`，`KKAI_QUOTA_PER_UNIT` 个 quota = 1 USD，因此

```
$/1M tokens = ratio × group_ratio × 1_000_000 / KKAI_QUOTA_PER_UNIT
input      = model_ratio
output     = model_ratio × completion_ratio
cacheRead  = model_ratio × cache_ratio
cacheWrite = model_ratio × create_cache_ratio
```

分组倍率是**按模型推导**的：某模型只在一个分组可用时（`enable_groups` 长度为 1），只有该分组的密钥调得动它，所以直接用该分组的倍率 —— 这一步很关键，本网关 `default` 是 0.4 而专用分组是 1，用错会让费用差 2.5 倍。跨多分组的模型回落到 `KKAI_GROUP_RATIO`，默认 1。

`billing_expr` 里的分时倍率（如 deepseek 工作日 9–12 / 14–18 翻倍）未计入，属已知偏差。

## 启动与离线

`/api/pricing` 是登录前唯一的模型来源，因此会把原始返回**快照到磁盘**（`~/.pi/agent/kkai-pricing.json`）。启动时先读快照，注册立即可用，联网再刷新价格：

- 有快照 + 离线：约 0.5s 拿到完整模型列表
- 首次运行 + 无网络：最长等 15s 超时后优雅降级，登录后仍可刷新

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `KKRICH_API_KEY` / `KKAI_API_KEY` | — | API Key（优先于已保存凭据） |
| `KKAI_BASE_URL` | `https://api.kkrich.ltd/v1` | 接口地址 |
| `KKAI_QUOTA_PER_UNIT` | `500000` | 1 USD 对应的 quota |
| `KKAI_GROUP_RATIO` | `1` | 跨多分组模型的回落倍率 |
| `KKAI_PRICING_CACHE` | `~/.pi/agent/kkai-pricing.json` | 目录快照路径 |

## 开发

```bash
npm install
npm run check    # tsc --noEmit
```

## 已知限制

- 费用由 new-api 的 ratio 反推；站点若改了 `QuotaPerUnit` 或隐藏倍率，用环境变量校准。
- 未计入 `billing_expr` 的分时上浮。
- 安装本扩展之前记录的历史消息费用为 0（当时没有价格表）。

## License

MIT
