/**
 * pi-kkai-provider
 *
 * Registers the KKAI (KKRICH, https://api.kkrich.ltd) OpenAI-compatible API as a
 * first-class pi provider:
 *
 *   1. Login      -> `/login kkai` (or KKRICH_API_KEY / KKAI_API_KEY env var)
 *   2. Discovery  -> models are discovered from `/v1/models`, enriched with live
 *                    pricing from the public `/api/pricing` endpoint, and with
 *                    authoritative context/output limits from pi's own builtin
 *                    catalog, so pi's footer, `/session`, and auto-compaction
 *                    know real limits and per-token cost.
 *
 * Context note: the KKRICH gateway does not publish context windows anywhere
 * (`/api/pricing`, `/v1/models` and the Gemini-compatible `/v1beta/models` all
 * omit them), so limits are taken from pi's builtin catalog first and only fall
 * back to a vendor-family heuristic when a model is unknown.
 *   3. Usage      -> `/kkai-usage` aggregates token/cost usage from the current
 *                    session or every session, plus server-side quota.
 *
 * This extension uses pi's simple provider-config form
 * (`pi.registerProvider(id, config)`), which is the smallest integration that
 * still supports API-key login and dynamic `refreshModels`.
 *
 * Environment:
 *   KKRICH_API_KEY | KKAI_API_KEY   API key (otherwise stored via /login)
 *   KKAI_BASE_URL                   default https://api.kkrich.ltd/v1
 *   KKAI_GROUP                      pricing group, default "default"
 *   KKAI_GROUP_RATIO                override the group ratio from /api/pricing
 *   KKAI_QUOTA_PER_UNIT             new-api quota per USD, default 500000
 *   KKAI_PRICING_URL                override /api/pricing discovery URL
 *   KKAI_NO_BUILTIN_METADATA        set to 1 to skip pi's builtin catalog and
 *                                   always use the vendor-family heuristic
 */

import {
	DynamicBorder,
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ProviderModelConfig,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { ModelCost, RefreshModelsContext, ThinkingLevelMap, Usage } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { Container, Text, matchesKey } from "@earendil-works/pi-tui";

// =============================================================================
// Configuration
// =============================================================================

const PROVIDER_ID = "kkai";
const PROVIDER_NAME = "KKAI";
const DEFAULT_BASE_URL = "https://api.kkrich.ltd/v1";
const DEFAULT_GROUP = "default";
const DEFAULT_QUOTA_PER_UNIT = 500_000; // new-api default: 500,000 quota = $1
const PRICING_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
// Startup blocks at most this long on the public pricing catalog; a failed warmup
// still registers the provider and can be recovered with `/kkai-models`.
const PRICING_WARMUP_TIMEOUT_MS = 3_000;

function envPositiveNumber(name: string, fallback: number): number {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

const BASE_URL = (process.env.KKAI_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
const GROUP = process.env.KKAI_GROUP?.trim() || DEFAULT_GROUP;
const QUOTA_PER_UNIT = envPositiveNumber("KKAI_QUOTA_PER_UNIT", DEFAULT_QUOTA_PER_UNIT);
const GROUP_RATIO_OVERRIDE = process.env.KKAI_GROUP_RATIO ? Number(process.env.KKAI_GROUP_RATIO) : undefined;
// Resolve env keys lazily through pi's config-value syntax when present.
const API_KEY_CONFIG = process.env.KKRICH_API_KEY
	? "$KKRICH_API_KEY"
	: process.env.KKAI_API_KEY
		? "$KKAI_API_KEY"
		: "$KKRICH_API_KEY";

function envApiKey(): string | undefined {
	return process.env.KKRICH_API_KEY?.trim() || process.env.KKAI_API_KEY?.trim() || undefined;
}

function pricingUrl(): string {
	const override = process.env.KKAI_PRICING_URL?.trim();
	if (override) return override;
	try {
		const url = new URL(BASE_URL);
		const root = url.pathname === "/v1" || url.pathname === "/v1/" ? url.origin : BASE_URL.replace(/\/v1$/, "");
		return `${root}/api/pricing`;
	} catch {
		return `${BASE_URL.replace(/\/v1$/, "")}/api/pricing`;
	}
}

/** Abort a fetch when the caller aborts or the timeout elapses. */
function linkedSignal(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
	const controller = new AbortController();
	const onAbort = () => controller.abort(signal?.reason);
	if (signal) {
		if (signal.aborted) controller.abort(signal.reason);
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	const timer = setTimeout(() => controller.abort(new Error("request timed out")), timeoutMs);
	(timer as { unref?: () => void }).unref?.();
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

async function fetchJson(url: string, init: RequestInit, signal: AbortSignal | undefined, timeoutMs = FETCH_TIMEOUT_MS): Promise<unknown> {
	const linked = linkedSignal(signal, timeoutMs);
	try {
		const response = await fetch(url, { ...init, signal: linked.signal });
		if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
		return (await response.json()) as unknown;
	} finally {
		linked.dispose();
	}
}

// =============================================================================
// Pricing (/api/pricing, public)
// =============================================================================

interface PricingEntry {
	modelName: string;
	quotaType: number;
	modelRatio: number;
	completionRatio: number;
	cacheRatio: number;
	createCacheRatio: number;
	endpoints: string[];
	enableGroups: string[];
}

interface PricingCatalog {
	fetchedAt: number;
	groupRatio: Record<string, number>;
	entries: PricingEntry[];
}

let pricingCache: PricingCatalog | undefined;
let pricingInFlight: Promise<PricingCatalog | undefined> | undefined;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asNumber(value: unknown, fallback = 0): number {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(n) ? n : fallback;
}

function parsePricing(payload: unknown): PricingCatalog | undefined {
	const root = asRecord(payload);
	const rows = Array.isArray(root?.data) ? root.data : undefined;
	if (!rows) return undefined;

	const groupRatio: Record<string, number> = {};
	const rawGroupRatio = asRecord(root?.group_ratio);
	if (rawGroupRatio) {
		for (const [key, value] of Object.entries(rawGroupRatio)) groupRatio[key] = asNumber(value, 1);
	}

	const entries: PricingEntry[] = [];
	for (const row of rows) {
		const item = asRecord(row);
		const modelName = typeof item?.model_name === "string" ? item.model_name : undefined;
		if (!item || !modelName) continue;
		const endpoints = Array.isArray(item.supported_endpoint_types)
			? item.supported_endpoint_types.filter((value): value is string => typeof value === "string")
			: [];
		const enableGroups = Array.isArray(item.enable_groups)
			? item.enable_groups.filter((value): value is string => typeof value === "string")
			: [];
		entries.push({
			modelName,
			quotaType: asNumber(item.quota_type, 0),
			modelRatio: asNumber(item.model_ratio, 0),
			completionRatio: asNumber(item.completion_ratio, 1),
			cacheRatio: asNumber(item.cache_ratio, 1),
			createCacheRatio: asNumber(item.create_cache_ratio, 0),
			endpoints,
			enableGroups,
		});
	}

	return { fetchedAt: Date.now(), groupRatio, entries };
}

async function loadPricing(signal: AbortSignal | undefined, force: boolean, timeoutMs = FETCH_TIMEOUT_MS): Promise<PricingCatalog | undefined> {
	if (!force && pricingCache && Date.now() - pricingCache.fetchedAt < PRICING_TTL_MS) return pricingCache;
	if (pricingInFlight) return pricingInFlight;

	pricingInFlight = (async () => {
		try {
			const payload = await fetchJson(pricingUrl(), { headers: { Accept: "application/json" } }, signal, timeoutMs);
			const parsed = parsePricing(payload);
			if (parsed) pricingCache = parsed;
			return parsed ?? pricingCache;
		} catch {
			return pricingCache;
		} finally {
			pricingInFlight = undefined;
		}
	})();

	return pricingInFlight;
}

/**
 * Group ratio for one model. A model enabled in exactly one group can only be
 * called with a key from that group, so its ratio is exact -- `/api/pricing`
 * ratios differ per group (0.4 for `default` vs 1 for a dedicated group), and
 * using the wrong one silently scales every cost.
 */
function groupRatioFor(catalog: PricingCatalog | undefined, entry: PricingEntry): number {
	if (Number.isFinite(GROUP_RATIO_OVERRIDE)) return GROUP_RATIO_OVERRIDE as number;
	if (entry.enableGroups.length === 1) {
		const single = catalog?.groupRatio[entry.enableGroups[0]];
		if (Number.isFinite(single) && (single as number) > 0) return single as number;
	}
	const configured = catalog?.groupRatio[GROUP];
	return Number.isFinite(configured) && (configured as number) > 0 ? (configured as number) : 1;
}

const NON_CHAT_ENDPOINTS = new Set(["image", "image-generation", "openai-video", "video", "audio", "embedding", "rerank"]);
const NON_CHAT_ID = /(^|[-_./])(image|video|seedance|embedding|rerank|tts|whisper|moderation)([-_./]|$)/i;

/** Keep only models that can serve chat completions. */
function isChatEntry(entry: PricingEntry): boolean {
	if (/^sd[_.-]/i.test(entry.modelName)) return false;
	if (NON_CHAT_ID.test(entry.modelName)) return false;
	if (entry.endpoints.some((endpoint) => NON_CHAT_ENDPOINTS.has(endpoint))) return false;
	if (entry.endpoints.length === 0) return true;
	return entry.endpoints.includes("openai") || entry.endpoints.includes("anthropic");
}

function chatEntries(catalog: PricingCatalog | undefined): PricingEntry[] {
	return (catalog?.entries ?? []).filter(isChatEntry);
}

// =============================================================================
// Model capabilities and cost
// =============================================================================

interface Capability {
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: ThinkingLevelMap;
	compat?: NonNullable<ProviderModelConfig["compat"]>;
}

// pi levels -> provider reasoning_effort values (OpenAI-compatible families).
const OPENAI_THINKING_LEVELS: ThinkingLevelMap = {
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: null,
	max: null,
};
// Model emits thinking, but the gateway does not expose a controllable level.
const FIXED_THINKING_LEVELS: ThinkingLevelMap = {
	minimal: null,
	low: null,
	medium: null,
	high: null,
	xhigh: null,
	max: null,
};

// -----------------------------------------------------------------------------
// pi's builtin catalog: authoritative context/output limits
// -----------------------------------------------------------------------------

/**
 * Vendors usually appear in several catalogs (e.g. `glm-5.3` exists under zai,
 * opencode and github-copilot). First-party entries win, so their `compat` and
 * `thinkingLevelMap` are the ones we adopt.
 */
const BUILTIN_PROVIDER_PRIORITY = [
	"anthropic",
	"openai",
	"google",
	"xai",
	"deepseek",
	"zai",
	"moonshotai",
	"moonshotai-cn",
	"kimi-coding",
	"qwen-token-plan",
	"qwen-token-plan-cn",
	"qwen-token-plan-individual",
	"xiaomi",
	"xiaomi-token-plan-cn",
	"xiaomi-token-plan-ams",
	"xiaomi-token-plan-sgp",
	"minimax",
	"minimax-cn",
	"mistral",
	"ant-ling",
];

const USE_BUILTIN_METADATA = process.env.KKAI_NO_BUILTIN_METADATA?.trim() !== "1";

type BuiltinModel = ReturnType<typeof getBuiltinModels>[number];

let builtinCatalog: Map<string, BuiltinModel> | undefined;

/**
 * Gateway aliases vs catalog ids: `glm-5.3-token` -> `glm-5.3`,
 * `claude-haiku-4-5-20251001` -> `claude-haiku-4-5`, `gemini-3-pro-preview`
 * -> `gemini-3-pro`. Returns every candidate id worth trying, best first.
 */
function normalizedIds(id: string): string[] {
	const out: string[] = [];
	const stripDate = (value: string) => value.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-\d{4,8}$/, "");
	const stripVariant = (value: string) =>
		value.replace(/-(preview|experimental|exp|reasoning|non-reasoning|nothinking|thinking)$/, "");

	let base = id;
	for (const suffix of ["-token-plan", "-token"]) {
		if (base.endsWith(suffix)) {
			base = base.slice(0, -suffix.length);
			break;
		}
	}
	for (const value of [base, stripDate(base), stripVariant(base), stripDate(stripVariant(base))]) {
		if (value && value !== id) out.push(value);
	}
	return [...new Set(out)];
}

function builtinModelsById(): Map<string, BuiltinModel> {
	if (builtinCatalog) return builtinCatalog;
	const map = new Map<string, BuiltinModel>();
	try {
		const providers = getBuiltinProviders() as string[];
		const ordered = [
			...BUILTIN_PROVIDER_PRIORITY.filter((id) => providers.includes(id)),
			...providers.filter((id) => !BUILTIN_PROVIDER_PRIORITY.includes(id)),
		];
		for (const provider of ordered) {
			for (const model of getBuiltinModels(provider as Parameters<typeof getBuiltinModels>[0])) {
				for (const key of [model.id, ...normalizedIds(model.id)]) {
					if (!map.has(key)) map.set(key, model);
				}
			}
		}
	} catch {
		// Best effort: an unavailable catalog just means we keep the heuristic.
	}
	builtinCatalog = map;
	return map;
}

function lookupBuiltin(id: string): BuiltinModel | undefined {
	if (!USE_BUILTIN_METADATA) return undefined;
	const map = builtinModelsById();
	for (const candidate of [id, ...normalizedIds(id)]) {
		const hit = map.get(candidate);
		if (hit) return hit;
	}
	return undefined;
}

/**
 * Adopt curated metadata from pi's catalog. Wire-affecting fields (`compat`,
 * `thinkingLevelMap`) are only copied when the upstream model speaks the same
 * `openai-completions` protocol, since KKAI proxies everything through it.
 */
function fromBuiltin(model: BuiltinModel): Capability {
	const contextWindow = model.contextWindow > 0 ? model.contextWindow : 128_000;
	const maxTokens = Math.min(model.maxTokens > 0 ? model.maxTokens : 16_384, contextWindow);
	const sameProtocol = model.api === "openai-completions";
	return {
		reasoning: Boolean(model.reasoning),
		input: (model.input?.length ? model.input : ["text"]) as ("text" | "image")[],
		contextWindow,
		maxTokens,
		...(sameProtocol && model.thinkingLevelMap
			? { thinkingLevelMap: model.thinkingLevelMap as ThinkingLevelMap }
			: {}),
		...(sameProtocol && model.compat ? { compat: model.compat as Capability["compat"] } : {}),
	};
}

/**
 * Best-effort vendor-family fallback for models missing from pi's catalog. The
 * KKRICH gateway publishes no limits, so these are conservative guesses; use
 * `~/.pi/agent/models.json` (`modelOverrides`) to correct individual models.
 */
function inferCapabilities(id: string): Capability {
	const name = id.toLowerCase();

	if (name.includes("gemini")) {
		return {
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			thinkingLevelMap: FIXED_THINKING_LEVELS,
		};
	}
	if (name.includes("claude")) {
		return {
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 200_000,
			maxTokens: 64_000,
			thinkingLevelMap: FIXED_THINKING_LEVELS,
		};
	}
	if (/^(gpt-|o[1-9](-|$))/.test(name) || name.includes("codex")) {
		return {
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 400_000,
			maxTokens: 128_000,
			thinkingLevelMap: OPENAI_THINKING_LEVELS,
			compat: { supportsReasoningEffort: true, maxTokensField: "max_completion_tokens" },
		};
	}
	if (name.includes("grok")) {
		const reasoning = !name.includes("non-reasoning");
		return {
			reasoning,
			input: ["text", "image"],
			contextWindow: 256_000,
			maxTokens: 32_000,
			...(reasoning ? { thinkingLevelMap: OPENAI_THINKING_LEVELS, compat: { supportsReasoningEffort: true } } : {}),
		};
	}
	if (name.includes("deepseek")) {
		return {
			reasoning: true,
			input: /vision|vl/.test(name) ? ["text", "image"] : ["text"],
			contextWindow: 131_072,
			maxTokens: 32_000,
			thinkingLevelMap: FIXED_THINKING_LEVELS,
		};
	}
	if (name.includes("qwen")) {
		return {
			reasoning: true,
			input: /vl/.test(name) ? ["text", "image"] : ["text"],
			contextWindow: 262_144,
			maxTokens: 32_768,
			thinkingLevelMap: FIXED_THINKING_LEVELS,
		};
	}
	if (name.includes("glm")) {
		return {
			reasoning: true,
			input: /vision|v\d/.test(name) ? ["text", "image"] : ["text"],
			contextWindow: 200_000,
			maxTokens: 32_768,
			thinkingLevelMap: FIXED_THINKING_LEVELS,
		};
	}
	if (name.includes("kimi")) {
		return {
			reasoning: true,
			input: ["text"],
			contextWindow: 262_144,
			maxTokens: 32_768,
			thinkingLevelMap: FIXED_THINKING_LEVELS,
		};
	}
	return { reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 16_384 };
}

/**
 * new-api pricing model: quota = tokens * model_ratio * group_ratio, where
 * QUOTA_PER_UNIT quota equals one USD. Price per 1M tokens is therefore
 * `ratio * groupRatio * 1_000_000 / quotaPerUnit`.
 */
function computeCost(entry: PricingEntry, groupRatio: number): ModelCost {
	if (entry.quotaType !== 0) {
		return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	}
	const perUnit = 1_000_000 / QUOTA_PER_UNIT;
	const base = entry.modelRatio * groupRatio;
	const rate = (ratio: number) => Number((ratio * perUnit).toFixed(6));
	return {
		input: rate(base),
		output: rate(base * (entry.completionRatio || 1)),
		cacheRead: rate(base * (entry.cacheRatio ?? 1)),
		cacheWrite: rate(base * (entry.createCacheRatio ?? 0)),
	};
}

function resolveCapabilities(id: string): Capability {
	const builtin = lookupBuiltin(id);
	return builtin ? fromBuiltin(builtin) : inferCapabilities(id);
}

function buildModel(entry: PricingEntry, catalog: PricingCatalog | undefined): ProviderModelConfig {
	const capability = resolveCapabilities(entry.modelName);
	return {
		id: entry.modelName,
		name: entry.modelName,
		reasoning: capability.reasoning,
		input: capability.input,
		cost: computeCost(entry, groupRatioFor(catalog, entry)),
		contextWindow: capability.contextWindow,
		maxTokens: capability.maxTokens,
		...(capability.thinkingLevelMap ? { thinkingLevelMap: capability.thinkingLevelMap } : {}),
		...(capability.compat ? { compat: capability.compat } : {}),
	};
}

function syntheticEntry(id: string): PricingEntry {
	return {
		modelName: id,
		quotaType: 0,
		modelRatio: 0,
		completionRatio: 1,
		cacheRatio: 1,
		createCacheRatio: 0,
		endpoints: ["openai"],
		enableGroups: [],
	};
}

/** Static catalog built from public pricing data, so models exist before login. */
function buildCatalogModels(): ProviderModelConfig[] {
	return chatEntries(pricingCache).map((entry) => buildModel(entry, pricingCache));
}

// =============================================================================
// Model discovery (/v1/models, authenticated)
// =============================================================================

function parseModelIds(payload: unknown): string[] {
	const root = asRecord(payload);
	const rows = Array.isArray(root?.data) ? root.data : Array.isArray(root?.models) ? root.models : undefined;
	if (!rows) return [];
	const ids = new Set<string>();
	for (const row of rows) {
		if (typeof row === "string") {
			ids.add(row);
			continue;
		}
		const item = asRecord(row);
		const id = typeof item?.id === "string" ? item.id : typeof item?.name === "string" ? item.name : undefined;
		if (id) ids.add(id);
	}
	return [...ids];
}

async function fetchModelIds(apiKey: string, signal: AbortSignal | undefined): Promise<string[]> {
	const payload = await fetchJson(`${BASE_URL}/models`, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } }, signal);
	return parseModelIds(payload);
}

async function discoverModels(context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
	const credentialKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
	const apiKey = credentialKey?.trim() || envApiKey();

	if (context.allowNetwork) {
		await loadPricing(context.signal, true);
		if (apiKey) {
			const ids = await fetchModelIds(apiKey, context.signal).catch(() => []);
			if (ids.length > 0) {
				const byId = new Map((pricingCache?.entries ?? []).map((entry) => [entry.modelName, entry]));
				return ids.map((id) => buildModel(byId.get(id) ?? syntheticEntry(id), pricingCache));
			}
		}
	}

	return buildCatalogModels();
}

// =============================================================================
// Usage aggregation
// =============================================================================

interface Totals {
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	totalTokens: number;
	cost: number;
}

function emptyTotals(): Totals {
	return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0 };
}

function addUsage(totals: Totals, usage: Usage | undefined): void {
	if (!usage) return;
	totals.requests += 1;
	totals.input += usage.input ?? 0;
	totals.output += usage.output ?? 0;
	totals.cacheRead += usage.cacheRead ?? 0;
	totals.cacheWrite += usage.cacheWrite ?? 0;
	totals.reasoning += usage.reasoning ?? 0;
	totals.totalTokens +=
		usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	totals.cost += usage.cost?.total ?? 0;
}

interface UsageReport {
	sessions: number;
	models: Map<string, Totals>;
	days: Map<string, Totals>;
	total: Totals;
}

function newReport(): UsageReport {
	return { sessions: 0, models: new Map(), days: new Map(), total: emptyTotals() };
}

function bucket(map: Map<string, Totals>, key: string): Totals {
	const existing = map.get(key);
	if (existing) return existing;
	const created = emptyTotals();
	map.set(key, created);
	return created;
}

function collectEntries(entries: readonly SessionEntry[], report: UsageReport, byDay: boolean): void {
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!message || message.role !== "assistant") continue;
		if (message.provider !== PROVIDER_ID) continue;
		const usage = message.usage;
		if (!usage) continue;

		const model = message.model || message.responseModel || "unknown";
		addUsage(bucket(report.models, model), usage);
		addUsage(report.total, usage);

		if (byDay) {
			const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp);
			if (Number.isFinite(timestamp)) {
				addUsage(bucket(report.days, new Date(timestamp).toISOString().slice(0, 10)), usage);
			}
		}
	}
}

async function collectAllSessions(report: UsageReport, onProgress?: (loaded: number, total: number) => void): Promise<void> {
	const sessions = await SessionManager.listAll((loaded, total) => onProgress?.(loaded, total));
	report.sessions = 0;
	for (const info of sessions) {
		try {
			const manager = SessionManager.open(info.path);
			collectEntries(manager.getBranch(), report, true);
			report.sessions += 1;
		} catch {
			// Ignore unreadable/corrupt session files.
		}
	}
}

// =============================================================================
// Server-side quota (new-api billing endpoints)
// =============================================================================

interface ServerUsage {
	usedUsd?: number;
	remainingUsd?: number;
	systemLimitUsd?: number;
	period: string;
	error?: string;
}

function asUsd(value: unknown): number | undefined {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(n) ? n : undefined;
}

async function fetchServerUsage(apiKey: string, signal: AbortSignal | undefined, days: number): Promise<ServerUsage> {
	const end = new Date();
	const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
	const period = `${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}`;
	const params = `start_date=${start.toISOString().slice(0, 10)}&end_date=${end.toISOString().slice(0, 10)}`;
	const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };

	const [subscription, usage] = await Promise.all([
		fetchJson(`${BASE_URL}/dashboard/billing/subscription`, { headers }, signal).catch(() => undefined),
		fetchJson(`${BASE_URL}/dashboard/billing/usage?${params}`, { headers }, signal).catch(() => undefined),
	]);

	const subscriptionRecord = asRecord(subscription);
	const usageRecord = asRecord(usage);
	if (!subscriptionRecord && !usageRecord) {
		return { period, error: "billing endpoints unavailable" };
	}

	const usedUsd = asUsd(usageRecord?.total_usage_usd) ?? (() => {
		const cents = asUsd(usageRecord?.total_usage);
		return cents === undefined ? undefined : cents / 100;
	})();

	return {
		usedUsd,
		remainingUsd: asUsd(subscriptionRecord?.hard_limit_usd) ?? asUsd(subscriptionRecord?.hard_limit),
		systemLimitUsd: asUsd(subscriptionRecord?.system_hard_limit_usd) ?? asUsd(subscriptionRecord?.system_hard_limit),
		period,
	};
}

// -----------------------------------------------------------------------------
// Per-request logs (/api/log/token, readable with the API key alone)
// -----------------------------------------------------------------------------

/**
 * The gateway keeps a per-request log at `GET {origin}/api/log/token?key=<key>`
 * that needs no browser session. Every row carries the tokens the upstream
 * actually reported -- including cache reads (`other.cache_tokens`) -- and the
 * exact quota charged, which makes it the authoritative source for cost and
 * cache hit rate (the response-level usage only covers turns pi stored).
 */
interface TokenLogRow {
	createdAt: number;
	model: string;
	promptTokens: number;
	completionTokens: number;
	cacheTokens: number;
	costUsd: number;
	upstreamModel?: string;
}

function logsOrigin(): string {
	return BASE_URL.replace(/\/v1\/?$/, "");
}

function parseTokenLogs(payload: unknown): TokenLogRow[] | undefined {
	const root = asRecord(payload);
	const rows = Array.isArray(root?.data) ? root.data : undefined;
	if (!rows) return undefined;

	const out: TokenLogRow[] = [];
	for (const raw of rows) {
		const row = asRecord(raw);
		if (!row) continue;
		let other: Record<string, unknown> = {};
		if (typeof row.other === "string") {
			try {
				other = asRecord(JSON.parse(row.other)) ?? {};
			} catch {
				other = {};
			}
		} else {
			other = asRecord(row.other) ?? {};
		}
		out.push({
			createdAt: asNumber(row.created_at, 0),
			model: typeof row.model_name === "string" ? row.model_name : "unknown",
			promptTokens: asNumber(row.prompt_tokens, 0),
			completionTokens: asNumber(row.completion_tokens, 0),
			cacheTokens: asNumber(other.cache_tokens, 0),
			costUsd: asNumber(row.quota, 0) / QUOTA_PER_UNIT,
			...(typeof other.upstream_model_name === "string" ? { upstreamModel: other.upstream_model_name } : {}),
		});
	}
	return out;
}

async function fetchTokenLogs(apiKey: string, signal: AbortSignal | undefined): Promise<TokenLogRow[] | undefined> {
	const url = `${logsOrigin()}/api/log/token?key=${encodeURIComponent(apiKey)}`;
	const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
	// This endpoint is occasionally flaky (empty body / non-JSON); one retry smooths it over.
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const rows = parseTokenLogs(await fetchJson(url, { headers }, signal));
			if (rows) return rows;
		} catch {
			// retry
		}
	}
	return undefined;
}

function addLogRow(totals: Totals, row: TokenLogRow): void {
	totals.requests += 1;
	totals.input += Math.max(0, row.promptTokens - row.cacheTokens);
	totals.cacheRead += row.cacheTokens;
	totals.output += row.completionTokens;
	totals.totalTokens += row.promptTokens + row.completionTokens;
	totals.cost += row.costUsd;
}

/** Rebuild a local-shaped report from server-authoritative log rows. */
function reportFromLogs(rows: readonly TokenLogRow[]): UsageReport {
	const report = newReport();
	for (const row of rows) {
		addLogRow(bucket(report.models, row.model), row);
		addLogRow(report.total, row);
		if (row.createdAt > 0) {
			addLogRow(bucket(report.days, new Date(row.createdAt * 1000).toISOString().slice(0, 10)), row);
		}
	}
	return report;
}

// =============================================================================
// Report formatting
// =============================================================================

const MODEL_COLUMN = 30;

function pad(value: string, width: number): string {
	return value.length >= width ? `${value.slice(0, width - 1)}…` : value.padEnd(width, " ");
}

function padStart(value: string, width: number): string {
	return value.padStart(width, " ");
}

function formatInt(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}

function formatUsd(value: number): string {
	return `$${value.toFixed(4)}`;
}

function totalsRow(label: string, totals: Totals): string {
	return (
		pad(label, MODEL_COLUMN) +
		padStart(String(totals.requests), 5) +
		padStart(formatInt(totals.input), 12) +
		padStart(formatInt(totals.cacheRead), 12) +
		padStart(formatInt(totals.cacheWrite), 12) +
		padStart(formatInt(totals.output), 12) +
		padStart(formatUsd(totals.cost), 12)
	);
}

function tableHeader(): string {
	return (
		pad("Model", MODEL_COLUMN) +
		padStart("Req", 5) +
		padStart("Input", 12) +
		padStart("Cache-R", 12) +
		padStart("Cache-W", 12) +
		padStart("Output", 12) +
		padStart("Cost", 12)
	);
}

function sortByCost(entries: Iterable<[string, Totals]>): [string, Totals][] {
	return [...entries].sort((a, b) => b[1].cost - a[1].cost || b[1].totalTokens - a[1].totalTokens);
}

function buildUsageText(
	report: UsageReport,
	scope: string,
	server: ServerUsage | undefined,
	serverLogs: readonly TokenLogRow[] | undefined,
	compareLocally: boolean,
): string {
	const lines: string[] = [];
	lines.push(`Scope: ${scope}`);
	lines.push("");

	if (report.total.requests === 0) {
		lines.push("No KKAI usage recorded.");
	} else {
		lines.push(tableHeader());
		for (const [model, totals] of sortByCost(report.models).slice(0, 20)) {
			lines.push(totalsRow(model, totals));
		}
		lines.push(pad("", MODEL_COLUMN) + padStart("", 5) + padStart("", 12) + padStart("", 12) + padStart("", 12) + padStart("", 12) + padStart("", 12));
		lines.push(totalsRow("TOTAL", report.total));

		const promptTokens = report.total.input + report.total.cacheRead + report.total.cacheWrite;
		const hitRate = promptTokens > 0 ? (report.total.cacheRead / promptTokens) * 100 : 0;
		lines.push("");
		lines.push(
			`Cache hit rate: ${hitRate.toFixed(1)}% of prompt tokens` +
				(report.total.reasoning > 0 ? `   Reasoning: ${formatInt(report.total.reasoning)}` : ""),
		);

		if (report.days.size > 1) {
			lines.push("");
			lines.push("By day");
			lines.push(tableHeader());
			for (const [day, totals] of [...report.days.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 14)) {
				lines.push(totalsRow(day, totals));
			}
		}
	}

	if (serverLogs && serverLogs.length > 0 && compareLocally) {
		const truth = reportFromLogs(serverLogs);
		const promptTokens = truth.total.input + truth.total.cacheRead;
		const hitRate = promptTokens > 0 ? (truth.total.cacheRead / promptTokens) * 100 : 0;
		lines.push("");
		lines.push("Server truth (every request recorded for this API key)");
		lines.push(
			`  Requests:     ${formatInt(truth.total.requests)}      Actual spend: ${formatUsd(truth.total.cost)}`,
		);
		lines.push(
			`  Prompt:       ${formatInt(promptTokens)} tokens, cache read ${formatInt(truth.total.cacheRead)} (${hitRate.toFixed(3)}% hit)`,
		);
		lines.push(
			`  Completion:   ${formatInt(truth.total.output)} tokens` +
				(truth.total.requests > report.total.requests
					? `      (${formatInt(truth.total.requests - report.total.requests)} request(s) not in local sessions)`
					: ""),
		);
	}

	if (server) {
		lines.push("");
		lines.push(`Account quota (${server.period})`);
		if (server.error) {
			lines.push(`  Unavailable: ${server.error}`);
		} else {
			if (server.usedUsd !== undefined) lines.push(`  Used:        ${formatUsd(server.usedUsd)}`);
			if (server.remainingUsd !== undefined) lines.push(`  Hard limit:  ${formatUsd(server.remainingUsd)}`);
			if (server.systemLimitUsd !== undefined) lines.push(`  System cap:  ${formatUsd(server.systemLimitUsd)}`);
		}
	}

	return lines.join("\n");
}

async function showReport(title: string, body: string, ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode === "tui") {
		await ctx.ui.custom((_tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
			container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
			container.addChild(new Text(body, 1, 1));
			container.addChild(new Text(theme.fg("dim", "Press Enter or Esc to close"), 1, 0));
			container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					if (matchesKey(data, "enter") || matchesKey(data, "escape")) done(undefined);
				},
			};
		});
		return;
	}

	if (ctx.hasUI) {
		ctx.ui.notify(`${title}: ${body.replace(/\s+/g, " ").slice(0, 240)}`, "info");
		return;
	}
	process.stdout.write(`${title}\n${body}\n`);
}

// =============================================================================
// Extension
// =============================================================================

export default async function (pi: ExtensionAPI) {
	// Warm the public pricing catalog so models/cost are available for `--list-models`,
	// `--model kkai/...`, and the post-login model snapshot. Bounded so offline startup
	// only waits briefly.
	await loadPricing(undefined, false, PRICING_WARMUP_TIMEOUT_MS);

	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: BASE_URL,
		apiKey: API_KEY_CONFIG,
		api: "openai-completions",
		models: buildCatalogModels(),
		async refreshModels(context) {
			return discoverModels(context);
		},
	});

	// Refresh the discovered catalog after login/startup so /model matches the key.
	pi.on("session_start", async (_event, ctx) => {
		try {
			const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
			if (!apiKey) return;
		} catch {
			return;
		}
		void ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], force: true }).catch(() => undefined);
	});

	pi.registerCommand("kkai-usage", {
		description: "Show KKAI token usage and cost (current session; --all for every session, --server for gateway-log truth)",
		getArgumentCompletions: (prefix) =>
			[
				{ value: "--all", label: "--all", description: "Aggregate every saved session" },
				{ value: "--server", label: "--server", description: "Use the gateway's own request log (actual spend + cache hits)" },
				{ value: "--session", label: "--session", description: "Current session only (default)" },
			].filter((item) => item.value.startsWith(prefix)),
		handler: async (args, ctx) => {
			const all = /(^|\s)(--all|-a|all)(\s|$)/.test(args);
			const serverMode = /(^|\s)(--server|-s|server)(\s|$)/.test(args);
			const statusKey = `${PROVIDER_ID}-usage`;

			let apiKey: string | undefined;
			try {
				apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
			} catch {
				apiKey = undefined;
			}

			if (ctx.hasUI) ctx.ui.setStatus(statusKey, "Reading gateway usage log…");
			const serverLogs = apiKey ? await fetchTokenLogs(apiKey, undefined) : undefined;
			if (ctx.hasUI) ctx.ui.setStatus(statusKey, undefined);

			let report = newReport();
			let scope: string;

			if (serverMode && serverLogs) {
				report = reportFromLogs(serverLogs);
				scope = `gateway log · ${report.total.requests} request(s) on this key`;
			} else if (serverMode) {
				scope = "gateway log unavailable, showing current session";
				collectEntries(ctx.sessionManager.getBranch(), report, true);
				report.sessions = 1;
			} else if (all) {
				if (ctx.hasUI) ctx.ui.setStatus(statusKey, "Scanning sessions…");
				await collectAllSessions(report, (loaded, total) => {
					if (ctx.hasUI && (loaded === total || loaded % 25 === 0)) {
						ctx.ui.setStatus(statusKey, `Scanning sessions ${loaded}/${total}…`);
					}
				});
				if (ctx.hasUI) ctx.ui.setStatus(statusKey, undefined);
				scope = `all sessions (${report.sessions} scanned)`;
			} else {
				collectEntries(ctx.sessionManager.getBranch(), report, true);
				report.sessions = 1;
				scope = "current session";
			}

			let server: ServerUsage | undefined;
			try {
				if (apiKey && !serverMode) server = await fetchServerUsage(apiKey, undefined, 30);
			} catch {
				// Quota lookup is best-effort.
			}

			const body = buildUsageText(report, scope, server, serverLogs, !serverMode);
			await showReport(`KKAI usage · ${scope}`, body, ctx);
			if (ctx.hasUI) ctx.ui.setStatus(statusKey, undefined);
		},
	});

	pi.registerCommand("kkai-models", {
		description: "Refresh and list the KKAI models available to the configured key",
		handler: async (_args, ctx) => {
			if (ctx.hasUI) ctx.ui.setStatus(`${PROVIDER_ID}-models`, "Refreshing models…");
			await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], force: true }).catch(() => undefined);
			if (ctx.hasUI) ctx.ui.setStatus(`${PROVIDER_ID}-models`, undefined);

			const models = ctx.modelRegistry
				.getAll()
				.filter((model) => model.provider === PROVIDER_ID)
				.sort((a, b) => a.id.localeCompare(b.id));

			const lines = [`Discovered ${models.length} KKAI model(s) for group "${GROUP}".`, ""];
			if (models.length > 0) {
				lines.push(pad("Model", 34) + padStart("Ctx", 10) + padStart("Max out", 10) + padStart("$/M in", 10) + padStart("$/M out", 10));
				for (const model of models) {
					lines.push(
						pad(model.id, 34) +
							padStart(formatInt(model.contextWindow), 10) +
							padStart(formatInt(model.maxTokens), 10) +
							padStart(model.cost.input.toFixed(4), 10) +
							padStart(model.cost.output.toFixed(4), 10),
					);
				}
			}
			await showReport("KKAI models", lines.join("\n"), ctx);
		},
	});
}
