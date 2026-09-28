/**
 * Phase-0 generation baseline telemetry.
 *
 * Purpose: measure what the existing router ACTUALLY did for a request —
 * selected vs. served model/provider, in-band billed cost where the provider
 * metadata carries it, token usage, wall latency and classified failures —
 * without ever recording prompt text, model output, headers or keys.
 *
 * Honesty rules (work package 1 of the second-evolution handover):
 *   - A provider fallback is not an answer failure, and it can silently change
 *     the executed model. Fallback attempts and terminal failures are recorded
 *     in SEPARATE fields.
 *   - "Actual" identity/cost comes only from provider metadata that the
 *     installed SDK actually forwards:
 *       * Gateway  -> `providerMetadata.gateway` (`generationId`, `cost`,
 *                     `routing.finalProvider`, `routing.modelAttempts`).
 *                     `result.response.id/modelId` is NEVER authoritative here:
 *                     it may echo the requested alias or an SDK-generated UUID.
 *       * OpenRouter -> `response.modelId` (only when concrete, never an alias),
 *                     `response.id` (generation id),
 *                     `providerMetadata.openrouter.provider` and
 *                     `providerMetadata.openrouter.usage.cost`.
 *     Absent metadata means UNKNOWN: no fabricated generation id, provider,
 *     model or cost — and unknown is never rendered as $0.
 *   - Generation lookup over the REST API (Gateway `/v1/generation`, OpenRouter
 *     `/api/v1/generation`) is deliberately DEFERRED: this baseline is only
 *     "actual where obtainable in band".
 *   - Static estimates come from the dated price table via `cost-estimator`.
 *     After an unresolved fallback the selected alias is NOT priced.
 *
 * This module has no side effects beyond the sink it is handed, and is fully
 * unit-testable offline.
 */

import { createHash, randomUUID } from 'node:crypto';
import { estimateCost, type CostEstimate, type CostProvider } from './cost-estimator';
import type { ClassifierMode, TaskTier } from './router';

/** Schema version of the emitted record. Bump when fields change meaning. */
export const TELEMETRY_VERSION = 'phase0-v1' as const;
/** Identifier of the routing policy family being measured. */
export const POLICY_ID = 'tier-static-policy' as const;
/** Version of that policy's decision rules. */
export const POLICY_VERSION = 'phase0' as const;

export type ClassifierMethod = 'regex' | 'semantic';
export type CostKind = 'actual' | 'estimated' | 'unknown';
/** Where a served-identity observation came from. */
export type ServedSource = 'gateway-metadata' | 'openrouter-metadata' | 'none';
/** Where an in-band billed cost came from. */
export type BilledSource = 'gateway-metadata' | 'openrouter-metadata';
export type AttemptStatus = 'succeeded' | 'failed' | 'cached' | 'unknown';
export type CostSourceKind = BilledSource | 'static-price-table' | 'none';

/** AI SDK provider metadata is an untyped pass-through: validate everything. */
export type ProviderMetadataLike = Record<string, Record<string, unknown>>;

export interface TelemetryPolicy {
  /** Stable policy identifier (e.g. `tier-static-policy`). */
  id: string;
  /** Policy rules version (e.g. `phase0`). */
  version: string;
  /** Deterministic hash of the active model/fallback/shape; no raw model IDs in this field. */
  descriptor: string;
}

export interface TelemetryClassifier {
  /** Classifier mode requested by config/env. */
  requested: ClassifierMode;
  /** Whether an embeddings attempt was planned for that mode. */
  semanticPlanned: boolean;
  /** Classifier that actually produced the tier. */
  effective: ClassifierMethod;
  /** True only when a planned embeddings attempt degraded to regex. */
  fallback: boolean;
  tier: TaskTier;
}

export interface TelemetryModelRef {
  provider: CostProvider;
  /** Selected model id; may be an alias such as `openrouter/auto`. */
  model: string;
}

export interface TelemetryServed {
  /** Actual upstream provider when metadata says so; else null. */
  provider: string | null;
  /** Actual concrete model when metadata says so; else null. */
  model: string | null;
  /** Provider generation id when metadata says so; else null. */
  generationId: string | null;
  source: ServedSource;
  /** Positive evidence that the executed model differs from the selected one. */
  fallback: boolean;
}

export interface TelemetryAttempt {
  provider: string | null;
  model: string | null;
  status: AttemptStatus;
}

export interface TelemetryFailure {
  provider: string | null;
  model: string | null;
  /** Sanitized error class name — never a message. */
  type: string;
  /** HTTP status when the error carried one; else null. */
  status: number | null;
  stage: 'generation';
}

export interface TelemetryUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface TelemetryCost {
  kind: CostKind;
  /** In-band billed USD when kind === 'actual'; else null. */
  actualUSD: number | null;
  /** Static-table estimate when kind === 'estimated'; else null. */
  estimatedUSD: number | null;
  source: CostSourceKind;
  /** Model the static estimate was computed for (kind === 'estimated'). */
  estimatedForModel: string | null;
}

export interface TelemetryError {
  /** Sanitized error class name. Never `error.message`. */
  type: string;
  status: number | null;
}

export interface GenerationTelemetryRecord {
  version: string;
  requestId: string;
  status: 'ok' | 'error';
  policy: TelemetryPolicy;
  classifier: TelemetryClassifier;
  selected: TelemetryModelRef;
  served: TelemetryServed;
  /** Provider routing retries observed in metadata (NOT terminal failures). */
  fallbackAttempts: TelemetryAttempt[];
  /** Terminal failures for this request (NOT routing retries). */
  failures: TelemetryFailure[];
  usage: TelemetryUsage;
  /** Wall-clock latency in ms; null when unmeasurable. */
  latencyMs: number | null;
  cost: TelemetryCost;
  error: TelemetryError | null;
}

export type GenerationTelemetrySink = (record: GenerationTelemetryRecord) => void;

// ---------------------------------------------------------------------------
// The injection seam: a minimal structural view of `generateText`, so tests can
// run the whole routing + telemetry path offline with no provider call.
// ---------------------------------------------------------------------------

/** The options the router hands to the generator. */
export interface GenerateTextOptions {
  model: unknown;
  prompt?: string;
  messages?: unknown;
  providerOptions?: unknown;
}

/** The subset of the AI SDK result the router and its telemetry actually read. */
export interface GenerateTextResultLike {
  text: string;
  usage?:
    | {
        inputTokens?: number | null;
        outputTokens?: number | null;
        totalTokens?: number | null;
      }
    | null;
  response?: { id?: string | null; modelId?: string | null } | null;
  providerMetadata?: ProviderMetadataLike | null;
}

/** Injectable generator. The real AI SDK `generateText` satisfies this shape. */
export type GenerateTextFn = (options: GenerateTextOptions) => Promise<GenerateTextResultLike>;

// ---------------------------------------------------------------------------
// Small validation helpers — every value read out of provider metadata passes
// through one of these, so hostile/absent metadata degrades to null.
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Gateway reports `cost` as a USD string; a number is not that field. */
function parseUsdString(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return finiteNonNegative(Number(trimmed));
}

/** `openrouter/auto`, `openrouter/auto-beta`, `vendor/auto`: a model chosen later. */
const ALIAS_MODEL_RE = /(^|\/)auto(-beta)?$/i;

export function isAliasModelId(modelId: string): boolean {
  return ALIAS_MODEL_RE.test(modelId.trim());
}

/** A served model id is usable only if it is concrete (not the asked-for alias). */
function concreteModelId(candidate: unknown, selectedModel: string): string | null {
  const id = nonEmptyString(candidate);
  if (id === null) return null;
  if (id === selectedModel.trim()) return null;
  return isAliasModelId(id) ? null : id;
}

function normalizeAttemptStatus(value: unknown): AttemptStatus {
  // Gateway's documented routing modelAttempts/providerAttempts use booleans.
  if (value === true) return 'succeeded';
  if (value === false) return 'failed';
  const raw = nonEmptyString(value)?.toLowerCase();
  if (raw === 'success' || raw === 'succeeded' || raw === 'ok' || raw === 'completed') {
    return 'succeeded';
  }
  if (raw === 'cached' || raw === 'cache_hit') return 'cached';
  if (raw === 'error' || raw === 'failed' || raw === 'failure') return 'failed';
  return 'unknown';
}

function toAttempt(raw: unknown): TelemetryAttempt {
  const entry = isPlainObject(raw) ? raw : {};
  return {
    provider: nonEmptyString(entry.provider),
    model: nonEmptyString(entry.model),
    status: normalizeAttemptStatus(entry.success ?? entry.status),
  };
}

// ---------------------------------------------------------------------------
// Policy descriptor
// ---------------------------------------------------------------------------

/** The static policy shape being measured: profile + model map + fallback chains. */
export interface PolicyShape {
  profile: string;
  models: Record<string, string>;
  fallbacks: Record<string, string[]>;
  fastTierDefault: string;
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(record).sort().map((k) => [k, record[k]]));
}

/**
 * Deterministic, privacy-safe descriptor of the active policy: a short hash of
 * the profile, model map, fallback chains and fast-tier default. Identical
 * configuration always hashes identically; a changed model map does not.
 */
export function policyDescriptor(shape: PolicyShape): string {
  const canonical = JSON.stringify({
    profile: shape.profile,
    fastTierDefault: shape.fastTierDefault,
    models: sortedRecord(shape.models),
    fallbacks: sortedRecord(shape.fallbacks),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

export function buildPolicy(shape: PolicyShape): TelemetryPolicy {
  return { id: POLICY_ID, version: POLICY_VERSION, descriptor: policyDescriptor(shape) };
}

/** A v4 request UUID, so every record is correlatable without being identifying. */
export function newRequestId(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// Classifier description
// ---------------------------------------------------------------------------

export interface ClassifierObservation {
  requested: ClassifierMode;
  semanticPlanned: boolean;
  effective: ClassifierMethod;
  tier: TaskTier;
}

export function describeClassifier(observation: ClassifierObservation): TelemetryClassifier {
  const { requested, semanticPlanned, effective, tier } = observation;
  return {
    requested,
    semanticPlanned,
    effective,
    // Only a planned embeddings attempt that degraded to regex is a fallback;
    // 'auto' without a key running regex is the designed path, not a fallback.
    fallback: semanticPlanned && effective === 'regex',
    tier,
  };
}

// ---------------------------------------------------------------------------
// Served identity + in-band billed cost
// ---------------------------------------------------------------------------

export interface ServedObservation {
  selectedProvider: CostProvider;
  /** Selected model id (may be an alias). */
  selectedModel: string;
  /** AI SDK `result.response` — NOT authoritative for the gateway path. */
  response?: { id?: string | null; modelId?: string | null } | null;
  /** AI SDK `result.providerMetadata`. */
  providerMetadata?: ProviderMetadataLike | null;
}

export interface ServedIdentity {
  served: TelemetryServed;
  fallbackAttempts: TelemetryAttempt[];
  /** In-band billed USD, only when the metadata carried a usable figure. */
  billedUSD: number | null;
  billedSource: BilledSource | null;
}

const UNKNOWN_SERVED: ServedIdentity = {
  served: { provider: null, model: null, generationId: null, source: 'none', fallback: false },
  fallbackAttempts: [],
  billedUSD: null,
  billedSource: null,
};

/**
 * Read the actually-served identity + billed cost out of provider metadata.
 * Only the metadata belonging to the selected provider is consulted, and
 * anything missing stays null (unknown), never guessed.
 */
export function extractServedIdentity(observation: ServedObservation): ServedIdentity {
  const metadata = observation.providerMetadata ?? undefined;

  if (observation.selectedProvider === 'gateway') {
    const gatewayMeta = isPlainObject(metadata?.gateway) ? metadata.gateway : undefined;
    return gatewayMeta ? fromGatewayMetadata(gatewayMeta, observation.selectedModel) : UNKNOWN_SERVED;
  }

  if (observation.selectedProvider === 'openrouter') {
    const openrouterMeta = isPlainObject(metadata?.openrouter) ? metadata.openrouter : undefined;
    return openrouterMeta
      ? fromOpenRouterMetadata(openrouterMeta, observation)
      : UNKNOWN_SERVED;
  }

  return UNKNOWN_SERVED;
}

/**
 * Gateway: identity comes from `routing.finalProvider` and the last successful
 * `routing.modelAttempts` entry (`canonicalSlug` preferred over `model`).
 * `result.response.id/modelId` is ignored on purpose — it may be the requested
 * alias or an SDK UUID, not the executed model.
 */
function fromGatewayMetadata(meta: Record<string, unknown>, selectedModel: string): ServedIdentity {
  const routing = isPlainObject(meta.routing) ? meta.routing : undefined;
  const rawAttempts = Array.isArray(routing?.modelAttempts) ? routing.modelAttempts : [];
  const attempts = rawAttempts.map((raw) => {
    const entry = isPlainObject(raw) ? raw : {};
    const model = nonEmptyString(entry.canonicalSlug) ?? nonEmptyString(entry.model);
    const providerAttempts = Array.isArray(entry.providerAttempts) ? entry.providerAttempts : [];
    const provider = toAttempt(entry).provider ??
      (isPlainObject(providerAttempts[0]) ? nonEmptyString(providerAttempts[0].provider) : null);
    return { ...toAttempt(entry), model, provider };
  });

  let successIndex = -1;
  for (let i = 0; i < attempts.length; i += 1) {
    const status = attempts[i].status;
    if (status === 'succeeded' || status === 'cached') successIndex = i;
  }

  let servedModel: string | null = null;
  let servedProvider = nonEmptyString(routing?.finalProvider);
  let fallbackAttempts: TelemetryAttempt[] = [];
  let providerRetried = false;

  if (successIndex >= 0) {
    const rawSuccess = isPlainObject(rawAttempts[successIndex])
      ? (rawAttempts[successIndex] as Record<string, unknown>)
      : {};
    servedModel =
      nonEmptyString(rawSuccess.canonicalSlug) ?? nonEmptyString(rawSuccess.model);
    fallbackAttempts = attempts.slice(0, successIndex).flatMap((attempt, index) => {
      const previous = isPlainObject(rawAttempts[index]) ? rawAttempts[index] : {};
      const providerAttempts = Array.isArray(previous.providerAttempts)
        ? previous.providerAttempts.map(toAttempt)
        : [];
      const failed = providerAttempts.filter((item) => item.status === 'failed');
      return failed.length > 0
        ? failed.map((item) => ({ ...item, model: attempt.model }))
        : [attempt];
    });
    // A successful model can itself have failed provider/credential attempts.
    // These are routing retries, not terminal request failures. Drop error
    // text, credential details and timings; retain only provider/model/status.
    const providerAttempts = Array.isArray(rawSuccess.providerAttempts)
      ? rawSuccess.providerAttempts.map(toAttempt)
      : [];
    const winningProvider = [...providerAttempts].reverse().find((attempt) => attempt.status === 'succeeded' || attempt.status === 'cached')?.provider;
    servedProvider = servedProvider ?? winningProvider ?? attempts[successIndex].provider;
    const failedProviderAttempts = providerAttempts.filter((attempt) => attempt.status === 'failed');
    fallbackAttempts.push(...failedProviderAttempts.map((attempt) => ({ ...attempt, model: servedModel })));
    providerRetried = failedProviderAttempts.length > 0;
  } else {
    // No attempt is attributable as the winner: record the tries, claim no model.
    fallbackAttempts = attempts;
  }

  const fallback =
    attempts.length > 1 || providerRetried || (servedModel !== null && servedModel !== selectedModel);

  const billedUSD = parseUsdString(meta.cost);

  return {
    served: {
      provider: servedProvider,
      model: servedModel,
      generationId: nonEmptyString(meta.generationId),
      source: 'gateway-metadata',
      fallback,
    },
    fallbackAttempts,
    billedUSD,
    billedSource: billedUSD === null ? null : 'gateway-metadata',
  };
}

/**
 * OpenRouter: the concrete served model is `response.modelId` (refused when it
 * is an alias), the generation id is `response.id`, the upstream provider is
 * `providerMetadata.openrouter.provider`, and — only when usage accounting was
 * requested and the API returned it — the billed cost is
 * `providerMetadata.openrouter.usage.cost`.
 */
function fromOpenRouterMetadata(
  meta: Record<string, unknown>,
  observation: ServedObservation,
): ServedIdentity {
  const usage = isPlainObject(meta.usage) ? meta.usage : undefined;
  const billedUSD = finiteNonNegative(usage?.cost);
  const servedModel = concreteModelId(observation.response?.modelId, observation.selectedModel);

  return {
    served: {
      provider: nonEmptyString(meta.provider),
      model: servedModel,
      generationId: nonEmptyString(observation.response?.id),
      source: 'openrouter-metadata',
      // OpenRouter exposes no attempt chain; a rewrite is not observable here.
      fallback: false,
    },
    fallbackAttempts: [],
    billedUSD,
    billedSource: billedUSD === null ? null : 'openrouter-metadata',
  };
}

// ---------------------------------------------------------------------------
// Cost resolution
// ---------------------------------------------------------------------------

export interface CostResolutionInput {
  provider: CostProvider;
  selectedModel: string;
  served: TelemetryServed;
  tokens: { inputTokens: number; outputTokens: number };
  billedUSD: number | null;
  billedSource: BilledSource | null;
}

export interface CostResolution {
  cost: TelemetryCost;
  /**
   * The static-table estimate carried by the legacy `GenerateOutput.cost`
   * field. Never a billed figure — in-band actual cost lives in `cost`.
   */
  estimate: CostEstimate;
}

function unknownEstimate(
  model: string,
  provider: CostProvider,
  tokens: { inputTokens: number; outputTokens: number },
  note: string,
): CostEstimate {
  return {
    model,
    provider,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    estimatedUSD: null,
    inputCostUSD: null,
    outputCostUSD: null,
    status: 'unknown',
    source: 'none',
    note,
  };
}

/**
 * Resolve the record's cost kind, plus the static estimate for the legacy
 * output field.
 *
 *   - In-band billed cost present            -> kind 'actual'.
 *   - Else a priceable model is known        -> kind 'estimated'.
 *   - Else (no price, or an unresolved fallback where the executed model is
 *     unknown)                              -> kind 'unknown'; the selected
 *     alias/model is deliberately NOT priced, because the request may have
 *     been served by a different model.
 */
export function resolveGenerationCost(input: CostResolutionInput): CostResolution {
  const { served } = input;
  const estimateModel = served.model ?? (served.fallback ? null : input.selectedModel);

  const estimate =
    estimateModel === null
      ? unknownEstimate(
          input.selectedModel,
          input.provider,
          input.tokens,
          'A provider fallback changed the executed model and metadata did not identify it, so no static price can be attributed to this request. Cost unknown — not zero.',
        )
      : estimateCost(estimateModel, input.provider, input.tokens.inputTokens, input.tokens.outputTokens);

  if (input.billedUSD !== null) {
    return {
      cost: {
        kind: 'actual',
        actualUSD: input.billedUSD,
        estimatedUSD: null,
        source: input.billedSource ?? 'none',
        estimatedForModel: null,
      },
      estimate,
    };
  }

  if (estimate.status === 'estimated' && estimate.estimatedUSD !== null) {
    return {
      cost: {
        kind: 'estimated',
        actualUSD: null,
        estimatedUSD: estimate.estimatedUSD,
        source: 'static-price-table',
        estimatedForModel: estimate.model,
      },
      estimate,
    };
  }

  return {
    cost: {
      kind: 'unknown',
      actualUSD: null,
      estimatedUSD: null,
      source: 'none',
      estimatedForModel: null,
    },
    estimate,
  };
}

// ---------------------------------------------------------------------------
// Error sanitization
// ---------------------------------------------------------------------------

const ERROR_NAME_RE = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;

function readHttpStatus(error: unknown): number | null {
  if (!isPlainObject(error)) return null;
  const raw = error.statusCode ?? error.status;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 100 && raw <= 599) return raw;
  return null;
}

/**
 * Reduce a thrown error to its class name plus an optional HTTP status.
 * The message, response body, request body, headers and keys are dropped —
 * an error message can embed prompt or provider content.
 */
export function sanitizeError(error: unknown): TelemetryError {
  const rawName = isPlainObject(error) ? (error as { name?: unknown }).name : undefined;
  const type = typeof rawName === 'string' && ERROR_NAME_RE.test(rawName) ? rawName : 'Error';
  return { type, status: readHttpStatus(error) };
}

// ---------------------------------------------------------------------------
// Record assembly
// ---------------------------------------------------------------------------

export interface GenerationRecordInput {
  requestId: string;
  policy: TelemetryPolicy;
  classifier: TelemetryClassifier;
  selected: TelemetryModelRef;
  identity: ServedIdentity;
  latencyMs: number;
  /** Token usage; null when the call failed before usage was known. */
  tokens?: Partial<TelemetryUsage> | null;
  status?: 'ok' | 'error';
  error?: TelemetryError | null;
  failureStage?: 'generation';
}

function normalizeTokens(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeUsage(tokens: Partial<TelemetryUsage> | null | undefined): TelemetryUsage {
  return {
    inputTokens: normalizeTokens(tokens?.inputTokens),
    outputTokens: normalizeTokens(tokens?.outputTokens),
    totalTokens: normalizeTokens(tokens?.totalTokens),
  };
}

/**
 * Assemble the emitted record. Fields are picked explicitly (never spread from
 * the input), so nothing the caller passes alongside — prompt, text, messages,
 * headers — can reach the record.
 */
export function buildGenerationRecord(input: GenerationRecordInput): GenerationTelemetryRecord {
  const error = input.error ?? null;
  const inputTokens = normalizeTokens(input.tokens?.inputTokens);
  const outputTokens = normalizeTokens(input.tokens?.outputTokens);
  const hasMeasuredUsage = inputTokens !== null && outputTokens !== null;
  const { cost: calculatedCost } = resolveGenerationCost({
    provider: input.selected.provider,
    selectedModel: input.selected.model,
    served: input.identity.served,
    tokens: { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 },
    billedUSD: input.identity.billedUSD,
    billedSource: input.identity.billedSource,
  });
  // A missing usage record (or failed request) is not a measured zero-token
  // request. Preserve an in-band provider cost if given; otherwise do not
  // turn fabricated zeros into a static free/estimated result.
  const cost: TelemetryCost = calculatedCost.kind === 'actual' ||
    ((input.status ?? 'ok') === 'ok' && hasMeasuredUsage)
    ? calculatedCost
    : { kind: 'unknown', actualUSD: null, estimatedUSD: null, source: 'none', estimatedForModel: null };

  return {
    version: TELEMETRY_VERSION,
    requestId: input.requestId,
    status: input.status ?? 'ok',
    policy: input.policy,
    classifier: input.classifier,
    selected: { provider: input.selected.provider, model: input.selected.model },
    served: input.identity.served,
    fallbackAttempts: input.identity.fallbackAttempts,
    failures:
      error === null
        ? []
        : [
            {
              provider: null,
              model: null,
              type: error.type,
              status: error.status,
              stage: input.failureStage ?? 'generation',
            },
          ],
    usage: normalizeUsage(input.tokens),
    latencyMs: normalizeTokens(input.latencyMs),
    cost,
    error,
  };
}

// ---------------------------------------------------------------------------
// Default (opt-out) sink: one metadata-only console line.
// ---------------------------------------------------------------------------

/** USD display for the console line; mirrors cost-estimator's formatCost. */
function formatUsd(usd: number): string {
  if (usd === 0) return '~$0.0000 (static estimate)';
  if (usd < 0.0001) return `~$${usd.toExponential(2)}`;
  return `~$${usd.toFixed(4)}`;
}

function costText(cost: TelemetryCost): string {
  if (cost.kind === 'actual') return `actual $${(cost.actualUSD ?? 0).toFixed(6)}`;
  if (cost.kind === 'estimated' && cost.estimatedUSD !== null) return formatUsd(cost.estimatedUSD);
  return 'unknown';
}

/**
 * Metadata-only console sink, used when no sink is injected. Emits tier,
 * provider, selected model, token counts, cost kind and — when a fallback
 * changed it — the served model. Never prompt or output text.
 */
export function consoleTelemetrySink(record: GenerationTelemetryRecord): void {
  const { selected, served, classifier, usage } = record;
  const servedSuffix =
    served.model !== null && served.model !== selected.model
      ? ` (served ${served.provider ?? '?'}/${served.model})`
      : '';
  const errorSuffix =
    record.status === 'error' ? ` [error ${record.error?.type ?? 'Error'}]` : '';

  console.log(
    `[${classifier.tier}/${selected.provider}] ${selected.model} — ${usage.inputTokens ?? '?'}+${usage.outputTokens ?? '?'} tokens, cost ${costText(record.cost)}${servedSuffix}${errorSuffix}`,
  );
}
