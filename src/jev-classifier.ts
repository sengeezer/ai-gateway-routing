/**
 * OFF-BY-DEFAULT Jev shadow classifier adapter.
 *
 * A drop-in, side-effect-free shadow of the regex/semantic classifiers: it asks
 * TypeSafe's Jev System One model to pick one of `fast | reasoning | coding |
 * abstain` for a request, and returns a fully validated, typed judgment. It never
 * routes, never generates, and never silently falls back to the regex classifier —
 * every failure is reported as an explicit `abstain` result with a recorded error
 * (or thrown when the caller asks for it).
 *
 * Transports (selected by `JEV_TRANSPORT`, default `direct`):
 *   - `direct`  → TypeSafe's own API, pinned to `jev-1.13.0`, key `TYPESAFE_API_KEY`,
 *                 base URL `https://api.typesafe.ai`.
 *   - `gateway` → the Vercel AI Gateway's TypeSafe-compatible route, model
 *                 `typesafe-ai/jev`, key `AI_GATEWAY_API_KEY`, base URL
 *                 `https://ai-gateway.vercel.sh/typesafe`.
 *
 * Both transports speak the TypeSafe v1 `POST /v1/systemone` shape documented at
 * https://docs.typesafe.ai/api — the gateway path is a compatibility surface, so
 * the response validator below is applied identically to both and any deviation is
 * recorded as a schema error rather than trusted.
 *
 * Scope: text only. `forceTier` and image inputs are deterministic pre-route
 * overrides; they resolve locally (no remote call) and are marked as such.
 *
 * Reference: TypeSafe JS SDK v0.6.0 (@typesafe-ai/sdk), which targets the v1 API.
 */

import { TypeSafeClient } from '@typesafe-ai/sdk';
import type { RouteInput, TaskTier } from './router';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Tier labels the model may choose from, in canonical probability order. */
export const JEV_TIERS = ['fast', 'reasoning', 'coding', 'abstain'] as const;

/** Model tiers plus the explicit "model declined to decide" outcome. */
export type JevTier = TaskTier | 'abstain';

/** Probability distribution over the choice options. Always all four keys. */
export type JevProbabilities = Record<(typeof JEV_TIERS)[number], number>;

/** Model pinned for the direct TypeSafe transport. */
export const JEV_MODEL_DIRECT = 'jev-1.13.0';

/** Model ID for the Gateway-compatible TypeSafe route. */
export const JEV_MODEL_GATEWAY = 'typesafe-ai/jev';

export const JEV_BASE_URL_DIRECT = 'https://api.typesafe.ai';
export const JEV_BASE_URL_GATEWAY = 'https://ai-gateway.vercel.sh/typesafe';

/** The question key used in the `questions` map (keys are ours; not sent to the model). */
export const JEV_CHOICE_KEY = 'tier';

/** Criteria: the routing decision Jev is asked to make, one narrow question. */
export const JEV_INSTRUCTIONS =
  'Which model tier should handle this request? Choose "fast" for short, simple, ' +
  'low-stakes requests that need speed or low cost. Choose "reasoning" for analysis, ' +
  'planning, math, proofs, or other requests that need deliberate thinking. Choose ' +
  '"coding" for requests that are primarily about writing, reading, debugging, or ' +
  'reviewing code. Choose "abstain" when the request is too ambiguous, empty, or ' +
  'does not clearly fit any tier.';

export const JEV_CRITERIA: Record<(typeof JEV_TIERS)[number], string | null> = {
  fast: 'Short, simple, low-stakes; speed or cost matters more than depth.',
  reasoning: 'Analysis, planning, math, proofs, or multi-step deliberation.',
  coding: 'Primarily about writing, reading, debugging, or reviewing code.',
  abstain: 'Too ambiguous, empty, or clearly outside every tier.',
};

// ---------------------------------------------------------------------------
// Budgets — bounded so a shadow classifier can never stall a request path
// ---------------------------------------------------------------------------

/** Retries after the initial attempt (SDK default is 2; Jev is a cheap, fast call). */
export const JEV_MAX_RETRIES = 1;
/** Timeout per attempt, in milliseconds. */
export const JEV_TIMEOUT_MS = 8_000;
/** Total wall-clock budget for the whole call, including retries. */
export const JEV_DEADLINE_MS = 15_000;
/** Absolute tolerance for "the distribution sums to 1". */
const JEV_PROB_SUM_TOLERANCE = 1e-6;
/**
 * Absolute tolerance for "the chosen option's probability equals the maximum".
 * A Choice answer must pick an argmax of its own distribution: `choice` is valid
 * only if its probability is within this tolerance of the largest probability.
 * Ties count as argmaxes, so any option tied (within tolerance) for the maximum
 * may be chosen. Same order as `JEV_PROB_SUM_TOLERANCE` so float rounding of a
 * genuine tie (e.g. 0.3333333 vs 0.3333334) is not misreported as a mismatch.
 */
export const JEV_ARGMAX_TOLERANCE = 1e-6;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type JevErrorKind =
  | 'missing-key'
  | 'transport'
  | 'schema'
  | 'timeout'
  | 'aborted'
  | 'unknown';

export interface JevErrorInfo {
  kind: JevErrorKind;
  message: string;
}

/** Token usage, normalized from the API's snake_case fields. */
export interface JevUsage {
  inputTokens: number;
  outputTokens: number;
}

export type JevShortCircuit = 'forceTier' | 'images';

export interface JevClassification {
  /** The decided tier, or `abstain` when the model declined / the call failed. */
  tier: JevTier;
  /** Always `jev` — distinguishes this from the regex/semantic classifiers. */
  method: 'jev';
  /** Model-reported confidence in the choice (0..1); 0 for failures, 1 for overrides. */
  confidence: number;
  /** Full distribution over `fast | reasoning | coding | abstain`. */
  probabilities: JevProbabilities;
  /** Pinned model that answered, or `short-circuit` / `unavailable`. */
  modelVersion: string;
  latencyMs: number;
  usage?: JevUsage;
  /** Set only when the tier was decided locally, without a remote call. */
  shortCircuit?: JevShortCircuit;
  /** Set only on failure. Presence means "did not decide" — never a regex fallback. */
  error?: JevErrorInfo;
}

export interface JevClassifyOptions {
  /** Override the model for this call (defaults to the transport's pinned model). */
  model?: string;
  /** Total wall-clock budget in milliseconds (default `JEV_DEADLINE_MS`). */
  deadlineMs?: number;
  /** Per-attempt timeout in milliseconds (default `JEV_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Retries after the initial attempt (default `JEV_MAX_RETRIES`). */
  maxRetries?: number;
  /** Caller cancellation. */
  signal?: AbortSignal;
  /** Reject instead of returning a recorded `abstain` result. */
  throwOnError?: boolean;
}

// ---------------------------------------------------------------------------
// Transport configuration
// ---------------------------------------------------------------------------

export type JevTransport = 'direct' | 'gateway';

export interface JevConfig {
  transport: JevTransport;
  model: string;
  baseURL: string;
  /** Which environment variable must hold the credential for this transport. */
  apiKeyEnv: 'TYPESAFE_API_KEY' | 'AI_GATEWAY_API_KEY';
  /** Whether that variable is currently set (the value itself is never exposed). */
  hasKey: boolean;
}

function readTrimmed(name: string): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the transport, model, base URL, and credential source from the
 * environment. `JEV_TRANSPORT` defaults to `direct`; unknown values fall back to
 * `direct`. Never returns the key itself — only where to find it and whether it exists.
 */
export function resolveJevConfig(): JevConfig {
  const transport: JevTransport =
    readTrimmed('JEV_TRANSPORT')?.toLowerCase() === 'gateway' ? 'gateway' : 'direct';

  if (transport === 'gateway') {
    return {
      transport,
      model: JEV_MODEL_GATEWAY,
      baseURL: JEV_BASE_URL_GATEWAY,
      apiKeyEnv: 'AI_GATEWAY_API_KEY',
      hasKey: readTrimmed('AI_GATEWAY_API_KEY') !== undefined,
    };
  }

  return {
    transport,
    model: JEV_MODEL_DIRECT,
    baseURL: readTrimmed('TYPESAFE_BASE_URL') ?? JEV_BASE_URL_DIRECT,
    apiKeyEnv: 'TYPESAFE_API_KEY',
    hasKey: readTrimmed('TYPESAFE_API_KEY') !== undefined,
  };
}

/**
 * Structural seam for an injectable client. The real `TypeSafeClient` from
 * `@typesafe-ai/sdk` satisfies it; tests inject a spy so no network call is made.
 */
export interface JevChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface JevSystemOneRequest {
  state: string;
  questions: Record<string, JevChoiceQuestion>;
  model?: string;
}

export interface JevRequestOptions {
  timeout?: number;
  retry?: { maxRetries?: number };
  signal?: AbortSignal;
}

export interface JevClient {
  systemOne(request: JevSystemOneRequest, options?: JevRequestOptions): PromiseLike<unknown>;
}

/**
 * Construct the real client for a resolved config. Throws `TypeSafeError` when no
 * credential is present; callers should check `config.hasKey` first.
 */
export function createJevClient(config: JevConfig): TypeSafeClient {
  return new TypeSafeClient({
    apiKey: readTrimmed(config.apiKeyEnv),
    baseURL: config.baseURL,
    defaultModel: config.model,
    // Keep the shadow classifier quiet; the adapter owns its own error reporting.
    logLevel: 'off',
    timeout: JEV_TIMEOUT_MS,
    retry: { maxRetries: JEV_MAX_RETRIES },
  });
}

// ---------------------------------------------------------------------------
// Pre-route overrides
// ---------------------------------------------------------------------------

/**
 * The deterministic override that applies before any remote call, if any.
 * `forceTier` wins over images, matching the router's precedence.
 */
export function preRouteOverride(input: RouteInput): JevShortCircuit | null {
  if (input.forceTier) return 'forceTier';
  if ((input.images?.length ?? 0) > 0 || input.hasImages) return 'images';
  return null;
}

// ---------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------

/** Thrown when a response deviates from the documented v1 shape. */
export class JevSchemaError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid TypeSafe response: ${issues.join('; ')}`);
    this.name = 'JevSchemaError';
    this.issues = issues;
  }
}

export interface JevChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
  /** Canonicalized: exactly the accepted options, in the order supplied. */
  probabilities: Record<string, number>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Validate one Choice answer against the options we sent. Enforces:
 *   - the answer is an object with `type: "choice"`;
 *   - `choice` is a string drawn from the options (choice/criteria alignment);
 *   - `probabilities` keys are exactly the options — no missing, no extras;
 *   - every probability is finite and within [0, 1];
 *   - the distribution sums to 1 within tolerance;
 *   - `choice` is an argmax of the distribution: its probability equals the
 *     maximum within `JEV_ARGMAX_TOLERANCE` (ties, i.e. any option within the
 *     tolerance of the maximum, are all acceptable); mismatches are schema errors;
 *   - `confidence` is a finite number within [0, 1].
 */
export function validateJevChoice(
  answer: unknown,
  options: readonly string[],
): JevChoiceAnswer {
  const issues: string[] = [];

  if (!isPlainObject(answer)) {
    throw new JevSchemaError(['answer is not an object']);
  }
  if (answer.type !== 'choice') {
    throw new JevSchemaError([`answer.type is ${JSON.stringify(answer.type)}, expected "choice"`]);
  }

  const choice = answer.choice;
  if (typeof choice !== 'string' || !options.includes(choice)) {
    issues.push(
      `answer.choice ${JSON.stringify(choice)} is not one of the provided options [${options.join(', ')}]`,
    );
  }

  const probabilities = answer.probabilities;
  let sum = 0;
  let probMap: Record<string, number> | undefined;
  if (!isPlainObject(probabilities)) {
    issues.push('answer.probabilities is not an object');
  } else {
    probMap = probabilities as Record<string, number>;
    const actual = Object.keys(probabilities);
    const actualSet = new Set(actual);
    const missing = options.filter((option) => !actualSet.has(option));
    const extra = actual.filter((option) => !options.includes(option));
    if (missing.length > 0) issues.push(`answer.probabilities is missing [${missing.join(', ')}]`);
    if (extra.length > 0) issues.push(`answer.probabilities has unexpected keys [${extra.join(', ')}]`);

    for (const option of options) {
      const p = probMap[option];
      if (typeof p !== 'number' || !Number.isFinite(p)) {
        issues.push(`probability for "${option}" is not a finite number`);
        continue;
      }
      if (p < 0 || p > 1) issues.push(`probability for "${option}" is out of range (${p})`);
      sum += p;
    }
    if (missing.length === 0 && extra.length === 0 && Math.abs(sum - 1) > JEV_PROB_SUM_TOLERANCE) {
      issues.push(`probabilities sum to ${sum}, expected 1`);
    }

    // Argmax agreement: only checked when the choice and every probability are
    // individually well-formed, so structural issues are not drowned out — and
    // so non-finite values never distort the maximum.
    const probs = probMap;
    if (
      typeof choice === 'string' &&
      options.includes(choice) &&
      probs !== undefined &&
      options.every((option) => {
        const p = probs[option];
        return typeof p === 'number' && Number.isFinite(p);
      })
    ) {
      const chosenProbability = probs[choice];
      const maxProbability = Math.max(...options.map((option) => probs[option]));
      if (chosenProbability < maxProbability - JEV_ARGMAX_TOLERANCE) {
        issues.push(
          `answer.choice ${JSON.stringify(choice)} does not match the maximum probability (chosen ${chosenProbability} < max ${maxProbability})`,
        );
      }
    }
  }

  const confidence = answer.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    issues.push('answer.confidence is not a finite number');
  } else if (confidence < 0 || confidence > 1) {
    issues.push(`answer.confidence is out of range (${confidence})`);
  }

  if (issues.length > 0) throw new JevSchemaError(issues);

  const canonical: Record<string, number> = {};
  for (const option of options) canonical[option] = probMap![option];

  return {
    type: 'choice',
    choice: choice as string,
    confidence: confidence as number,
    probabilities: canonical,
  };
}

export interface JevEnvelope {
  model: string;
  answer: unknown;
  usage?: JevUsage;
}

/** Validate the top-level v1 response envelope: `model`, `answers`, and optional `usage`. */
export function validateJevEnvelope(payload: unknown, answerKey: string): JevEnvelope {
  if (!isPlainObject(payload)) {
    throw new JevSchemaError(['response is not an object']);
  }

  const issues: string[] = [];

  const model = payload.model;
  if (typeof model !== 'string' || model.trim().length === 0) {
    issues.push('response.model is not a non-empty string');
  }

  const answers = payload.answers;
  if (!isPlainObject(answers)) {
    issues.push('response.answers is not an object');
  } else if (!Object.prototype.hasOwnProperty.call(answers, answerKey)) {
    issues.push(`response.answers is missing the "${answerKey}" answer`);
  }

  let usage: JevUsage | undefined;
  const rawUsage = payload.usage;
  if (rawUsage !== undefined) {
    if (!isPlainObject(rawUsage)) {
      issues.push('response.usage is not an object');
    } else {
      const input = rawUsage.input_tokens;
      const output = rawUsage.output_tokens;
      if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) {
        issues.push('response.usage.input_tokens is not a finite non-negative number');
      } else if (typeof output !== 'number' || !Number.isFinite(output) || output < 0) {
        issues.push('response.usage.output_tokens is not a finite non-negative number');
      } else {
        usage = { inputTokens: input, outputTokens: output };
      }
    }
  }

  if (issues.length > 0) throw new JevSchemaError(issues);

  return {
    model: model as string,
    answer: (answers as Record<string, unknown>)[answerKey],
    ...(usage ? { usage } : {}),
  };
}

// ---------------------------------------------------------------------------
// classifyJev
// ---------------------------------------------------------------------------

const ZERO_PROBABILITIES: JevProbabilities = { fast: 0, reasoning: 0, coding: 0, abstain: 0 };

class JevTimeoutError extends Error {
  constructor(ms: number) {
    super(`exceeded the ${ms}ms budget`);
    this.name = 'JevTimeoutError';
  }
}

function failure(kind: JevErrorKind, message: string): JevClassification {
  return {
    tier: 'abstain',
    method: 'jev',
    confidence: 0,
    probabilities: { fast: 0, reasoning: 0, coding: 0, abstain: 1 },
    modelVersion: 'unavailable',
    latencyMs: 0,
    error: { kind, message },
  };
}

function shortCircuitResult(
  override: JevShortCircuit,
  input: RouteInput,
): JevClassification {
  const tier: JevTier = override === 'forceTier' ? input.forceTier! : 'vision';
  return {
    tier,
    method: 'jev',
    confidence: 1,
    probabilities: { ...ZERO_PROBABILITIES },
    modelVersion: 'short-circuit',
    latencyMs: 0,
    shortCircuit: override,
  };
}

/** Race a promise against a wall-clock deadline, clearing the timer either way. */
async function raceDeadline<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  // Keep a handler on every branch so a late rejection after the timeout is not unhandled.
  void promise.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new JevTimeoutError(ms));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Classify a routing request with Jev.
 *
 * Pass an injectable `client` to skip construction (and credentials entirely) —
 * that is the seam the tests use. Without one, the adapter builds a real client
 * from the resolved transport.
 *
 * Deterministic overrides (`forceTier`, images) return a distinct, locally-decided
 * result (`shortCircuit`) with no remote call; callers wanting to skip those can
 * test `preRouteOverride(input)` first.
 */
export async function classifyJev(
  input: RouteInput,
  client?: JevClient,
  options: JevClassifyOptions = {},
): Promise<JevClassification> {
  const override = preRouteOverride(input);
  if (override) return shortCircuitResult(override, input);

  const config = resolveJevConfig();

  const settle = (result: JevClassification): JevClassification => {
    if (result.error && options.throwOnError) {
      const err = new Error(result.error.message);
      err.name = 'JevClassificationError';
      throw err;
    }
    return result;
  };

  if (options.signal?.aborted) {
    return settle(failure('aborted', 'request aborted by the caller before dispatch'));
  }

  if (!client) {
    if (!config.hasKey) {
      return settle(
        failure(
          'missing-key',
          `No credential in ${config.apiKeyEnv} for the "${config.transport}" Jev transport.`,
        ),
      );
    }
    try {
      client = createJevClient(config);
    } catch (err) {
      return settle(failure('missing-key', messageOf(err)));
    }
  }

  const deadlineMs = options.deadlineMs ?? JEV_DEADLINE_MS;
  const timeoutMs = options.timeoutMs ?? JEV_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? JEV_MAX_RETRIES;

  const request: JevSystemOneRequest = {
    state: input.prompt,
    model: options.model ?? config.model,
    questions: {
      [JEV_CHOICE_KEY]: {
        type: 'choice',
        instructions: JEV_INSTRUCTIONS,
        criteria: { ...JEV_CRITERIA },
      },
    },
  };

  // One controller serves both the external signal and our wall-clock deadline.
  const controller = new AbortController();
  let timedOut = false;
  let abortedExternally = false;
  const onExternalAbort = (): void => {
    abortedExternally = true;
    controller.abort();
  };
  const external = options.signal;
  external?.addEventListener('abort', onExternalAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deadlineMs);

  const started = Date.now();
  let payload: unknown;
  try {
    const pending = Promise.resolve(
      client.systemOne(request, {
        timeout: timeoutMs,
        retry: { maxRetries },
        signal: controller.signal,
      }),
    );
    payload = await raceDeadline(pending, deadlineMs, () => {
      timedOut = true;
      controller.abort();
    });
  } catch (err) {
    if (timedOut) return settle(failure('timeout', `Jev call ${messageOf(err)}`));
    if (abortedExternally) return settle(failure('aborted', `Jev call aborted: ${messageOf(err)}`));
    return settle(failure('transport', messageOf(err)));
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onExternalAbort);
  }

  const latencyMs = Date.now() - started;

  let envelope: JevEnvelope;
  let answer: JevChoiceAnswer;
  try {
    envelope = validateJevEnvelope(payload, JEV_CHOICE_KEY);
    answer = validateJevChoice(envelope.answer, JEV_TIERS);
  } catch (err) {
    return settle(failure('schema', messageOf(err)));
  }

  return {
    tier: answer.choice as JevTier,
    method: 'jev',
    confidence: answer.confidence,
    probabilities: answer.probabilities as JevProbabilities,
    modelVersion: envelope.model,
    latencyMs,
    ...(envelope.usage ? { usage: envelope.usage } : {}),
  };
}
