/**
 * KK AI provider for pi.
 *
 * KK AI (https://api.kkai.win) is an OpenAI-compatible gateway, so request
 * building, tool calls and streaming are left to pi's built-in
 * "openai-completions" implementation. This extension only supplies the
 * endpoint, the API key and the model catalog.
 */

import { readFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import { getAgentDir, type ExtensionAPI, type ProviderConfig } from "@earendil-works/pi-coding-agent"

export const PROVIDER_ID = "kkai"
export const DEFAULT_API_BASE = "https://api.kkai.win"

const AGENT_DIR = getAgentDir()
const CATALOG_PATH = join(AGENT_DIR, "kkai-models.json")
const AUTH_PATH = join(AGENT_DIR, "auth.json")
const FETCH_TIMEOUT_MS = 10_000

/** Every KK AI model is a Claude model with a 1M-token window. */
const CONTEXT_WINDOW = 1_000_000
const MAX_TOKENS = 65_536

/** Used when neither the cache nor the network has a catalog to offer. */
const FALLBACK_MODEL_IDS = [
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
  "claude-fable-5-2",
  "claude-fable-5-1",
  "claude-fable-5.1",
  "claude-fable-5",
]

type ModelConfig = NonNullable<ProviderConfig["models"]>[number]

interface ModelListResponse {
  data?: Array<{ id?: unknown }>
}

function apiBase(): string {
  const configured = process.env.KKAI_API_BASE?.trim()
  return configured ? configured.replace(/\/+$/, "") : DEFAULT_API_BASE
}

/**
 * The key pi itself would use: `KKRICH_API_KEY` (the name the gateway's docs
 * use), then `KKAI_API_KEY`, then the stored kkai credential.
 */
export function resolveApiKey(): string | undefined {
  for (const name of ["KKRICH_API_KEY", "KKAI_API_KEY"]) {
    const fromEnv = process.env[name]?.trim()
    if (fromEnv) return fromEnv
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(AUTH_PATH, "utf8"))
    if (typeof parsed !== "object" || parsed === null) return undefined
    const entry = (parsed as Record<string, unknown>)[PROVIDER_ID]
    if (typeof entry === "string") return entry || undefined
    if (typeof entry !== "object" || entry === null) return undefined
    const record = entry as Record<string, unknown>
    for (const field of ["key", "access"]) {
      const value = record[field]
      if (typeof value === "string" && value) return value
    }
  } catch {
    // No readable credential file; the caller reports the missing key.
  }
  return undefined
}

/**
 * `$KKRICH_API_KEY` keeps pi's own auth handling in charge when nothing is
 * configured, so `--api-key` and stored credentials still apply.
 */
function apiKeyForConfig(): string {
  return resolveApiKey() ?? "$KKRICH_API_KEY"
}

export function displayName(modelId: string): string {
  const tokens = modelId.replace(/^claude-/, "").split("-")
  const tail: string[] = []
  while (tokens.length > 1 && /^\d+$/.test(tokens[tokens.length - 1] ?? "")) {
    tail.unshift(tokens.pop() ?? "")
  }
  const base = tokens
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ")
  const version = tail.filter((token) => token.length < 8)
  const date = tail.find((token) => token.length >= 8)
  const named = version.length > 0 ? `${base} ${version.join(".")}` : base
  return `Claude ${named}${date ? ` (${date})` : ""}`
}

export function modelConfig(modelId: string): ModelConfig {
  return {
    id: modelId,
    name: displayName(modelId),
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: CONTEXT_WINDOW,
    maxTokens: MAX_TOKENS,
    compat: {
      maxTokensField: "max_tokens",
      supportsStore: false,
      supportsDeveloperRole: false,
    },
  }
}

function cachedModelIds(): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(CATALOG_PATH, "utf8"))
    if (typeof parsed !== "object" || parsed === null) return undefined
    const ids = (parsed as { ids?: unknown }).ids
    if (!Array.isArray(ids)) return undefined
    const valid = ids.filter((id): id is string => typeof id === "string" && id.length > 0)
    return valid.length > 0 ? valid : undefined
  } catch {
    return undefined
  }
}

async function saveCachedModelIds(ids: readonly string[]): Promise<void> {
  try {
    await writeFile(CATALOG_PATH, `${JSON.stringify({ ids }, null, 2)}\n`, "utf8")
  } catch {
    // A read-only agent directory only costs the next startup a network fetch.
  }
}

function abortAfter(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${ms}ms`)), ms)
  const forward = () => controller.abort(signal?.reason)
  if (signal?.aborted) forward()
  else signal?.addEventListener("abort", forward, { once: true })
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true })
  return controller.signal
}

async function fetchModelIds(signal?: AbortSignal): Promise<string[]> {
  const headers: Record<string, string> = { Accept: "application/json" }
  const apiKey = resolveApiKey()
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const response = await fetch(`${apiBase()}/models`, {
    headers,
    signal: abortAfter(signal, FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`GET /models returned HTTP ${response.status}`)

  const body = (await response.json()) as ModelListResponse
  const ids = (body.data ?? [])
    .map((entry) => entry?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
  if (ids.length === 0) throw new Error("GET /models returned no models")
  return [...new Set(ids)]
}

export default function kkaiProvider(pi: ExtensionAPI): void {
  let modelIds = cachedModelIds() ?? FALLBACK_MODEL_IDS

  pi.registerProvider(PROVIDER_ID, {
    name: "KK AI",
    baseUrl: apiBase(),
    api: "openai-completions",
    apiKey: apiKeyForConfig(),
    models: modelIds.map(modelConfig),
    async refreshModels(context) {
      if (!context.allowNetwork) return modelIds.map(modelConfig)
      try {
        modelIds = await fetchModelIds(context.signal)
        await saveCachedModelIds(modelIds)
      } catch {
        // Keep the cached catalog; the next refresh tries again.
      }
      return modelIds.map(modelConfig)
    },
  })
}
