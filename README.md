# pi-kkai-provider

把 [KKAI / KKRICH](https://api.kkrich.ltd) 的 OpenAI 兼容接口接入 [pi](https://github.com/earendil-works/pi-mono) 的 provider 扩展，提供：

- **登录** — `/login kkai`（API Key 登录），支持 `KKRICH_API_KEY` / `KKAI_API_KEY` 环境变量
- **模型发现** — 从公开的 `/api/pricing` 与鉴权后的 `/v1/models` 动态发现模型，并把真实价格换算成 pi 的 `cost`，让 footer / `/session` 直接显示成本
- **Token 用量统计** — `/kkai-usage` 汇总当前会话或全部历史会话的输入 / 缓存读 / 缓存写 / 输出 token 与费用；`--server` 直接读网关逐条请求日志，给出**实收费用**与**真实缓存命中率**

采用 pi 推荐的**最简集成方式**：`pi.registerProvider(id, config)`（provider-config 形式），无需自定义 `streamSimple`，复用内建 `openai-completions` 实现。

## 安装

作为 pi 包安装：

```bash
git clone https://github.com/windup-bird/pi-kkai-provider.git
cd pi-kkai-provider
pi install
```

安装后重启（或 `/reload`）。

## 1. 登录

```bash
# 方式 A：交互式登录，凭据写入 ~/.pi/agent/auth.json
pi
/login kkai          # 粘贴 sk-... 密钥

# 方式 B：环境变量
export KKRICH_API_KEY="sk-..."
# 或 export KKAI_API_KEY="sk-..."
```

登录成功后扩展会自动刷新一次模型列表。

## 2. 模型发现

```bash
pi --list-models            # 查看包含 kkai 的全部可用模型
/model                      # 在 TUI 中搜索并切换
/kkai-models                # 强制刷新并列出 KKAI 模型、上下文、输出上限与单价
```

发现逻辑：

1. `GET /api/pricing`（公开，无需密钥）→ 拿到模型名、`model_ratio`、`completion_ratio`、`cache_ratio`、`create_cache_ratio`，据此生成初始模型清单与价格。
2. 登录后 `GET /v1/models`（Bearer 鉴权）→ 收敛为该密钥实际可用的模型集合。
3. 按模型名推断能力（上下文窗口、最大输出、是否思考、是否支持图片），仅保留对话类模型（自动排除 seedance / 图片 / 视频模型）。

> 能力推断是启发式的（KKRICH 不提供上下文/输出上限字段）。可用 `~/.pi/agent/models.json` 的 `modelOverrides` 覆盖任意字段。

## 3. Token 用量统计

```bash
/kkai-usage          # 当前会话（从本地 session 记录聚合）
/kkai-usage --all    # 汇总所有已保存会话（按模型、按天）
/kkai-usage --server # 直接读网关自己的请求日志（权威值：实收费用 + 真实 cache 命中）
```

输出包含：请求数、input / cache-read / cache-write / output token、费用、缓存命中率。

### 服务端权威数据

网关有一个**只用 API Key 即可读**的逐条请求日志：

```
GET {origin}/api/log/token?key=<apiKey>
Authorization: Bearer <apiKey>
```

每行含 `prompt_tokens` / `completion_tokens` / `quota`（**实收**额度）、`model_name`、`group`、`created_at`，以及 `other` JSON 里的
`cache_tokens`（真实缓存命中）、`upstream_model_name`、`group_ratio`、`billing_expr`、`request_rules`（分时倍率是否命中）。

因此：

- `--server` 给出**实收费用**与**真实缓存命中率**，不依赖 pi 的本地记录。
- 默认/`--all` 报告底部会附一段 `Server truth`，把本地估算与网关实收并排显示；两者不一致时说明有请求没进本地 session（如自动标题/压缩等内部调用）或历史费用是用旧单价记录的。
- `/v1/dashboard/billing/usage?start_date=&end_date=` 的 `total_usage` 单位是**美分**，与服务端日志求和一致（不带日期参数时该接口返回不完整，勿用）。

> 缓存命中取决于上游（如 DeepSeek 的 context caching 需要前缀复用）。本网关实测命中率通常接近 0，属正常现象。

同时，因为扩展为每个模型写入了真实单价，pi **内建 footer 和 `/session`** 也会实时显示 KKAI 的 token 与费用。

## 费用计算

new-api 计费公式：

```
quota = tokens × model_ratio × group_ratio        （1 USD = KKAI_QUOTA_PER_UNIT quota）
价格($/1M tokens) = ratio × group_ratio × 1_000_000 / KKAI_QUOTA_PER_UNIT
```

- `input` = `model_ratio`
- `output` = `model_ratio × completion_ratio`
- `cacheRead` = `model_ratio × cache_ratio`
- `cacheWrite` = `model_ratio × create_cache_ratio`

默认取分组 `default` 的倍率。**若某模型只在一个分组可用，则直接使用该分组的倍率**（因为只有该分组的 key 调得动它）；否则使用 `KKAI_GROUP` 指定的分组。如与面板实际倍率不符，可用 `KKAI_GROUP_RATIO` 直接覆盖。

部分模型（如 deepseek 系列）使用 `billing_expr`，含**分时倍率**（工作日 9–12、14–18（Asia/Shanghai）翻倍）。当前实现按基础倍率估算，未计入分时上浮。

## 模型清单与上下文长度

模型名与价格来自公开的 `GET /api/pricing`，上下文/输出上限来自 **pi 自带的模型目录**（按 `-token` / `-日期` / `-preview` 等别名归一化后匹配，优先取厂商一方目录）。

网关本身**不提供**上下文长度（`/api/pricing`、`/v1/models`、`/v1beta/models` 的 `inputTokenLimit` 均为空），因此无法从 KKAI 直接获取；目录未命中的模型才回落到按厂商族猜测，可用 `~/.pi/agent/models.json` 的 `modelOverrides` 单独修正。

发现的模型目录会**快照到磁盘**（`~/.pi/agent/kkai-pricing.json`，可用 `KKAI_PRICING_CACHE` 改路径），因此冷启动/离线也能拿到完整模型列表，启动时间不依赖网络；联网时后台静默刷新价格。`KKAI_NO_BUILTIN_METADATA=1` 可关闭目录匹配。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `KKRICH_API_KEY` / `KKAI_API_KEY` | — | API Key（优先于已保存凭据） |
| `KKAI_BASE_URL` | `https://api.kkrich.ltd/v1` | 接口地址 |
| `KKAI_GROUP` | `default` | 计费分组名 |
| `KKAI_GROUP_RATIO` | — | 直接覆盖分组倍率 |
| `KKAI_QUOTA_PER_UNIT` | `500000` | 1 USD 对应的 quota（new-api 默认 50 万） |
| `KKAI_PRICING_URL` | `<origin>/api/pricing` | 价格接口地址 |
| `KKAI_PRICING_CACHE` | `~/.pi/agent/kkai-pricing.json` | 模型目录快照路径 |
| `KKAI_NO_BUILTIN_METADATA` | — | 设为 `1` 禁用 pi 目录，改用启发式 |

## 开发

```bash
npm install       # 安装 peer/dev 依赖
npm run check     # tsc 类型检查
```

## 已知限制

- 费用基于 new-api 的 ratio 反推；若站点使用自定义 `QuotaPerUnit` 或隐藏倍率，请用环境变量校准。
- 历史会话里在安装本扩展之前记录的 KKAI 消息费用为 0（当时没有价格表）。
- 服务端额度接口失败时，只显示本地统计，不影响使用。

## License

MIT
