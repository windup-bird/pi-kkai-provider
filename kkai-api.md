# KKRICH API 文档

KKRICH / KKAI New API 提供 OpenAI 兼容的调用方式，适合已有 OpenAI SDK、HTTP 客户端和自动化脚本迁移接入。

---

## Base URL

接入 KKRICH / KKAI New API 时，请把 OpenAI 兼容客户端的 Base URL 配置为 KKRICH 的 `/v1` 地址。

```
https://api.kkrich.ltd/v1
```

| 场景 | 正确地址 |
|------|----------|
| Base URL | `https://api.kkrich.ltd/v1` |
| 模型列表 | `https://api.kkrich.ltd/v1/models` |
| 对话补全 | `https://api.kkrich.ltd/v1/chat/completions` |
| Responses | `https://api.kkrich.ltd/v1/responses` |

---

## 认证

KKRICH API 使用 OpenAI 兼容的 Bearer Token 认证方式。

```
Authorization: Bearer $KKRICH_API_KEY
Content-Type: application/json
```

建议通过环境变量读取密钥：`export KKRICH_API_KEY="sk-..."`

---

## 接口端点

| 功能 | 方法 | 完整地址 |
|------|------|----------|
| 模型列表 | `GET` | `https://api.kkrich.ltd/v1/models` |
| 对话补全 | `POST` | `https://api.kkrich.ltd/v1/chat/completions` |
| Responses | `POST` | `https://api.kkrich.ltd/v1/responses` |
| 创建视频 | `POST` | `https://api.kkrich.ltd/v1/video/generations` |
| 查询视频 | `GET` | `https://api.kkrich.ltd/v1/video/generations/{task_id}` |
| OpenAI 格式创建视频 | `POST` | `https://api.kkrich.ltd/v1/videos` |
| OpenAI 格式查询视频 | `GET` | `https://api.kkrich.ltd/v1/videos/{task_id}` |
| 下载视频 | `GET` | `https://api.kkrich.ltd/v1/videos/{task_id}/content` |

---

## 额度与限速

价格、模型、额度、并发、频率限制和统计口径均以控制面板实时显示为准。

对 429 做指数退避：

```javascript
async function withRetry(run, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (error.status !== 429 || attempt === retries) throw error;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}
```

---

## 错误处理

| 状态 | 常见原因 | 建议处理 |
|------|----------|----------|
| `400` | JSON 不合法、缺少必填字段 | 用最小请求复现 |
| `401` | 未提供 API Key、Key 无效 | 重新复制密钥 |
| `403` | 账号、密钥、权限、余额不满足 | 查看控制面板 |
| `404` | 路径错误、模型名称不可用 | 检查 Base URL 和模型名 |
| `429` | 超出频率、并发、额度限制 | 降低请求速率 |
| `5xx` | 服务端临时异常 | 稍后重试或联系支持 |

---

## Seedance 视频生成 API

视频生成是异步任务：创建任务后保存任务 ID，轮询查询，完成后下载。

### Seedance 2.5 模型

| 客户模型名 | 时长 | 分辨率 | 参考方式 |
|------------|------|--------|----------|
| `seedance-2.5` | 4-30 秒 | 720p | 文生或单图参考 |
| `sd_2.5_special_720p` | 4-30 秒 | 720p | 文生或单图参考 |
| `sd_2.5_special_1080p` | 4-30 秒 | 1080p | 文生或单图参考 |
| `sd_2.5_special_720p_with_video_ref` | 4-30 秒 | 720p | 必须视频参考 |
| `sd_2.5_special_1080p_with_video_ref` | 4-30 秒 | 1080p | 必须视频参考 |

### Seedance 2.0 模型

| 客户模型名 | 分辨率 | 参考方式 |
|------------|--------|----------|
| `sd_2.0_fast_special_720p` | 720p | 文生 / 单图 |
| `sd_2.0_special_720p` | 720p | 文生 / 单图 |
| `sd_2.0_special_1080p` | 1080p | 文生 / 单图 |
| `sd_2.0_special_2k` | 2k | 文生 / 单图 |
| `sd_2.0_special_4k` | 4k | 文生 / 单图 |

### 视频请求字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | 是 | 模型名称 |
| `prompt` | string | 是 | 提示词，最多 8192 字节 |
| `duration` | integer | 否 | 2.0: 4-15秒，2.5: 4-30秒 |
| `ratio` | string | 否 | `16:9`、`9:16`、`1:1`、`4:3`、`3:4`、`21:9`、`adaptive` |
| `resolution` | string | 否 | 必须与模型名匹配 |
| `reference_image` | string | 否 | 公开 HTTPS URL |
| `reference_video` | string | 条件 | `_with_video_ref` 模型必填 |
| `generate_audio` | boolean | 否 | 显式传 `true` 或 `false` |

---

## Chat Completions

```
POST https://api.kkrich.ltd/v1/chat/completions
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | 是 | 模型名称 |
| `messages` | array | 是 | 对话消息数组 |
| `stream` | boolean | 否 | 是否流式输出 |
| `temperature` | number | 否 | 采样温度 |
| `max_tokens` | number | 否 | 输出 token 上限 |

```bash
curl https://api.kkrich.ltd/v1/chat/completions \
  -H "Authorization: Bearer $KKRICH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<model-from-panel>",
    "messages": [
      {"role": "system", "content": "你是简洁可靠的技术助手。"},
      {"role": "user", "content": "给我一个 KKRICH API 的最小调用示例。"}
    ],
    "temperature": 0.3
  }'
```

---

## Responses

```
POST https://api.kkrich.ltd/v1/responses
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | 是 | 模型名称 |
| `input` | string/array | 是 | 用户输入 |
| `instructions` | string | 否 | 任务指令 |
| `stream` | boolean | 否 | 是否流式返回 |
| `temperature` | number | 否 | 采样温度 |
| `max_output_tokens` | number | 否 | 输出 token 上限 |

---

## 调用示例

### cURL

```bash
curl https://api.kkrich.ltd/v1/chat/completions \
  -H "Authorization: Bearer $KKRICH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"<model-from-panel>","messages":[{"role":"user","content":"Hello"}]}'
```

### Node.js

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.KKRICH_API_KEY,
  baseURL: "https://api.kkrich.ltd/v1",
});

const completion = await client.chat.completions.create({
  model: "<model-from-panel>",
  messages: [
    { role: "system", content: "你是简洁可靠的技术助手。" },
    { role: "user", content: "用 Node.js 调用 KKRICH API。" },
  ],
});

console.log(completion.choices[0].message.content);
```

### Python

```python
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["KKRICH_API_KEY"],
    base_url="https://api.kkrich.ltd/v1",
)

completion = client.chat.completions.create(
    model="<model-from-panel>",
    messages=[
        {"role": "system", "content": "你是简洁可靠的技术助手。"},
        {"role": "user", "content": "用 Python 调用 KKRICH API。"},
    ],
)

print(completion.choices[0].message.content)
```

---

## 计费说明

价格、可用模型、上下文能力、额度、频率限制和账单统计均以控制面板实时显示为准。

---

*文档来源：https://api.kkrich.ltd/docs/api/*
