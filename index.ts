/**
 * pi-kkai-provider
 *
 * Registers KKAI (KKRICH, https://api.kkrich.ltd) -- an OpenAI-compatible
 * new-api gateway -- as a pi provider:
 *
 *   login      `/login kkai`, or the KKRICH_API_KEY / KKAI_API_KEY env vars
 *   discovery  the public `/api/pricing` catalog (available before login),
 *              narrowed by the authenticated `/v1/models` list
 *   metadata   context/output limits, modalities and thinking support come from
 *              pi's own builtin catalog; unknown models get a 1M default
 *   cost       real per-token rates derived from the gateway's own ratios
 *
 * Token usage needs no extra command: because every model carries real `cost`
 * rates, pi's footer, `/session` and auto-compaction are already accurate.
 *
 * Environment:
 *   KKRICH_API_KEY | KKAI_API_KEY  API key (otherwise stored via /login)
 *   KKAI_BASE_URL                  default https://api.kkrich.ltd/v1
 *   KKAI_QUOTA_PER_UNIT            1 USD expressed in new-api quota (500000)
 *   KKAI_GROUP_RATIO               fallback group ratio when a model spans
 *                                  several groups; otherwise derived per model
 *   KKAI_PRICING_CACHE             catalog snapshot path
 */

import { type ExtensionAPI, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ModelCost, RefreshModelsContext, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// =============================================================================
// Configuration
// =============================================================================

const PROVIDER_ID = "kkai";
const PROVIDER_NAME = "KKAI";
const BASE_URL = (process.env.KKAI_BASE_URL?.trim() || "https://api.kkrich.ltd/v1").replace(/\/+$/, "");
const PRICING_URL = `${BASE_URL.replace(/\/v1$/, "")}/api/pricing`;
const QUOTA_PER_UNIT = Number(process.env.KKAI_QUOTA_PER_UNIT) || 500_000;
const GROUP_RATIO = Number(process.env.KKAI_GROUP_RATIO) || undefined;
const CACHE_FILE =
	process.env.KKAI_PRICING_CACHE?.trim() || join(homedir(), ".pi", "agent", "kkai-pricing.json");
const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
// Only the first-ever run (no snapshot yet) waits on the network, and only this
// long, so a cold offline start degrades instead of hanging.
const STARTUP_TIMEOUT_MS = 5_000;

// Used only for models pi's builtin catalog does not know. Everything this
// gateway serves today is 1M+, so guessing small would trigger needless
// auto-compaction, which is the expensive failure mode.
const FALLBACK_CONTEXT_WINDOW = 1_048_576;
const FALLBACK_MAX_TOKENS = 65_536;

/** pi resolves `$NAME` against the environment, so pass that through unchanged. */
const API_KEY_CONFIG = process.env.KKAI_API_KEY ? "$KKAI_API_KEY" : "$KKRICH_API_KEY";

// =============================================================================
// HTTP helpers
// =============================================================================

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function num(value: unknown, fallback: number): number {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : fallback;
}

async function fetchJson(
	url: string,
	signal: AbortSignal | undefined,
	init: RequestInit = {},
	timeoutMs = FETCH_TIMEOUT_MS,
): Promise<unknown> {
	const timeout = AbortSignal.timeout(timeoutMs);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const response = await fetch(url, { ...init, signal: combined });
	if (!response.ok) throw new Error(`${response.status} from ${url}`);
	return (await response.json()) as unknown;
}

// =============================================================================
// Pricing (/api/pricing, public)
// =============================================================================

interface PricingEntry {
	model: string;
	/** Per-token price multipliers; see `cost()`. */
	ratio: number;
	completion: number;
	cacheRead: number;
	cacheWrite: number;
	/** Groups this model is enabled in, used to resolve the group ratio. */
	groups: string[];
}

interface PricingCatalog {
	fetchedAt: number;
	groupRatio: Record<string, number>;
	entries: PricingEntry[];
}

function parsePricing(payload: unknown): PricingCatalog | undefined {
	const root = asRecord(payload);
	const rows = Array.isArray(root?.data) ? root.data : undefined;
	if (!rows) return undefined;

	const groupRatio: Record<string, number> = {};
	for (const [name, value] of Object.entries(asRecord(root?.group_ratio) ?? {})) {
		groupRatio[name] = num(value, 1);
	}

	const entries: PricingEntry[] = [];
	for (const raw of rows) {
		const row = asRecord(raw);
		if (!row || typeof row.model_name !== "string") continue;
		// quota_type 0 means billed per token. Non-zero entries are per-call
		// image/video SKUs, which must never be offered as chat models.
		if (num(row.quota_type, 1) !== 0) continue;
		entries.push({
			model: row.model_name,
			ratio: num(row.model_ratio, 0),
			completion: num(row.completion_ratio, 1),
			cacheRead: num(row.cache_ratio, 1),
			cacheWrite: num(row.create_cache_ratio, 0),
			groups: Array.isArray(row.enable_groups)
				? row.enable_groups.filter((group): group is string => typeof group === "string")
				: [],
		});
	}
	return { fetchedAt: Date.now(), groupRatio, entries };
}

let catalog: PricingCatalog | undefined;
let inFlight: Promise<PricingCatalog | undefined> | undefined;

function readSnapshot(): PricingCatalog | undefined {
	try {
		const wrapper = asRecord(JSON.parse(readFileSync(CACHE_FILE, "utf8")) as unknown);
		const parsed = parsePricing(wrapper?.payload);
		return parsed?.entries.length ? { ...parsed, fetchedAt: num(wrapper?.savedAt, 0) } : undefined;
	} catch {
		return undefined;
	}
}

function writeSnapshot(payload: unknown): void {
	try {
		mkdirSync(dirname(CACHE_FILE), { recursive: true });
		writeFileSync(CACHE_FILE, JSON.stringify({ savedAt: Date.now(), payload }));
	} catch {
		// Best effort: a read-only home must not break discovery.
	}
}

// Read the snapshot eagerly, before the provider is registered: this is what
// keeps startup off the network entirely, including when it is unreachable.
catalog = readSnapshot();

/**
 * The catalog is the only source of model names before login, so a disk snapshot
 * keeps cold and offline starts working instead of registering zero models.
 */
async function loadPricing(
	signal: AbortSignal | undefined,
	timeoutMs = FETCH_TIMEOUT_MS,
): Promise<PricingCatalog | undefined> {
	if (catalog && Date.now() - catalog.fetchedAt < CACHE_TTL_MS) return catalog;
	if (inFlight) return inFlight;

	const attempt = (async () => {
		try {
			const payload = await fetchJson(PRICING_URL, signal, { headers: { Accept: "application/json" } }, timeoutMs);
			const parsed = parsePricing(payload);
			if (parsed?.entries.length) {
				writeSnapshot(payload);
				return (catalog = parsed);
			}
		} catch {
			// Fall through to the snapshot below.
		}
		return (catalog ??= readSnapshot());
	})();

	inFlight = attempt;
	try {
		return await attempt;
	} finally {
		if (inFlight === attempt) inFlight = undefined;
	}
}

// =============================================================================
// Cost
// =============================================================================

/**
 * new-api charges `quota = tokens * ratio * group_ratio`, with QUOTA_PER_UNIT
 * quota per USD, so a ratio maps to `ratio * group_ratio * 1e6 / QUOTA_PER_UNIT`
 * dollars per million tokens. Group ratios differ per group (0.4 vs 1), and a
 * model enabled in exactly one group can only be reached by a key from that
 * group -- so that ratio is exact rather than a guess.
 */
function cost(entry: PricingEntry, from: PricingCatalog | undefined): ModelCost {
	const only = entry.groups.length === 1 ? from?.groupRatio[entry.groups[0]] : undefined;
	const perMillion = (1_000_000 / QUOTA_PER_UNIT) * (only ?? GROUP_RATIO ?? 1);
	const rate = (ratio: number) => Number((ratio * perMillion).toFixed(6));
	return {
		input: rate(entry.ratio),
		output: rate(entry.ratio * entry.completion),
		cacheRead: rate(entry.ratio * entry.cacheRead),
		cacheWrite: rate(entry.ratio * entry.cacheWrite),
	};
}

// =============================================================================
// Capabilities (pi's builtin catalog)
// =============================================================================

type BuiltinModel = ReturnType<typeof getBuiltinModels>[number];

/**
 * Gateway ids alias the upstream ones: `glm-5.3-token`,
 * `claude-haiku-4-5-20251001` and `gemini-3-pro-preview` all resolve to a plain
 * catalog id once the marketing suffixes are peeled off.
 */
function aliases(id: string): string[] {
	const found: string[] = [];
	let current = id;
	const suffixes = [
		/-token-plan$/,
		/-token$/,
		/-\d{4}-\d{2}-\d{2}$/,
		/-\d{4,8}$/,
		/-(preview|experimental|exp|reasoning|non-reasoning|nothinking|thinking)$/,
	];
	for (const suffix of suffixes) {
		const next = current.replace(suffix, "");
		if (next !== current) found.push((current = next));
	}
	return found;
}

let builtinById: Map<string, BuiltinModel> | undefined;

/** Model id -> catalog entry, preferring entries that speak our API and know the widest window. */
function builtinModels(): Map<string, BuiltinModel> {
	if (builtinById) return builtinById;
	const better = (candidate: BuiltinModel, current: BuiltinModel) => {
		const [a, b] = [candidate.api === "openai-completions", current.api === "openai-completions"];
		return a === b ? candidate.contextWindow > current.contextWindow : a;
	};

	const map = new Map<string, BuiltinModel>();
	for (const provider of getBuiltinProviders()) {
		for (const model of getBuiltinModels(provider)) {
			for (const id of [model.id, ...aliases(model.id)]) {
				const current = map.get(id);
				if (!current || better(model, current)) map.set(id, model);
			}
		}
	}
	return (builtinById = map);
}

function buildModel(entry: PricingEntry, from: PricingCatalog | undefined): ProviderModelConfig {
	const index = builtinModels();
	const known = [entry.model, ...aliases(entry.model)].map((id) => index.get(id)).find((m) => m !== undefined);
	// Wire-affecting fields are only copied when the upstream speaks the same
	// protocol, since this gateway proxies everything through openai-completions.
	const sameApi = known?.api === "openai-completions";
	const contextWindow = known?.contextWindow ?? FALLBACK_CONTEXT_WINDOW;

	return {
		id: entry.model,
		name: entry.model,
		reasoning: known?.reasoning ?? true,
		input: known?.input?.length ? [...known.input] : ["text", "image"],
		cost: cost(entry, from),
		contextWindow,
		maxTokens: Math.min(known?.maxTokens || FALLBACK_MAX_TOKENS, contextWindow),
		...(sameApi && known?.thinkingLevelMap
			? { thinkingLevelMap: known.thinkingLevelMap as ThinkingLevelMap }
			: {}),
		...(sameApi && known?.compat ? { compat: known.compat as ProviderModelConfig["compat"] } : {}),
	};
}

/** Catalog entry for a model the gateway exposes but does not price. */
function unpriced(id: string): PricingEntry {
	return { model: id, ratio: 0, completion: 1, cacheRead: 1, cacheWrite: 0, groups: [] };
}

function catalogModels(from: PricingCatalog | undefined): ProviderModelConfig[] {
	return (from?.entries ?? []).map((entry) => buildModel(entry, from));
}

// =============================================================================
// Discovery
// =============================================================================

async function usableModelIds(key: string, signal: AbortSignal): Promise<string[]> {
	try {
		const payload = await fetchJson(`${BASE_URL}/models`, signal, {
			headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
		});
		const rows = asRecord(payload)?.data;
		if (!Array.isArray(rows)) return [];
		return rows.map((row) => asRecord(row)?.id).filter((id): id is string => typeof id === "string");
	} catch {
		return [];
	}
}

async function refreshModels(context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
	// pi calls this with `allowNetwork: false` while loading extensions and right
	// after login, and it awaits the result -- so an offline phase must never touch
	// the network. Use the in-memory/on-disk catalog instead.
	if (!context.allowNetwork) return catalogModels(catalog ?? readSnapshot());

	const key = context.credential?.type === "api_key" ? context.credential.key : undefined;
	if (!key) return catalogModels(catalog ?? readSnapshot());

	// Independent, so run them together rather than paying both latencies in turn.
	const [pricing, ids] = await Promise.all([
		loadPricing(context.signal),
		usableModelIds(key, context.signal),
	]);
	if (ids.length === 0) return catalogModels(pricing);

	const byId = new Map((pricing?.entries ?? []).map((entry) => [entry.model, entry]));
	return ids.map((id) => buildModel(byId.get(id) ?? unpriced(id), pricing));
}

// =============================================================================
// Extension
// =============================================================================

export default async function (pi: ExtensionAPI) {
	// The snapshot (read at module load) is enough to register instantly; pi's own
	// model refresh then calls refreshModels, which reloads pricing after the TTL.
	// Only a first-ever run without a snapshot has to wait, and only briefly.
	if (!catalog) await loadPricing(undefined, STARTUP_TIMEOUT_MS);

	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: BASE_URL,
		apiKey: API_KEY_CONFIG,
		api: "openai-completions",
		models: catalogModels(catalog),
		refreshModels,
	});
}
