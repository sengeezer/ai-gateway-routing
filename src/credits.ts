/**
 * Credit-balance monitoring for both routing backends.
 *
 * Philosophy: quality-first. We never cap or downgrade a request to save money —
 * instead we surface a reliable WARNING when a provider's remaining credit falls
 * below a threshold, so the account can be topped up before it runs dry.
 *
 *   - Vercel AI Gateway: `gateway.getCredits()` -> { balance, totalUsed } (USD).
 *   - OpenRouter:        GET /api/v1/credits    -> { total_credits, total_usage }
 *     (remaining = total_credits - total_usage), all USD.
 *
 * Env:
 *   AI_GATEWAY_API_KEY / OPENROUTER_API_KEY — required to query each provider.
 *   CREDIT_WARN_THRESHOLD_USD — warn at/under this balance (default 5).
 *   CREDIT_CRITICAL_THRESHOLD_USD — critical at/under this balance (default 1).
 */

import { gateway } from 'ai';

export type CreditProvider = 'gateway' | 'openrouter';
export type CreditLevel = 'ok' | 'low' | 'critical' | 'unknown';

export interface CreditStatus {
  provider: CreditProvider;
  /** Remaining balance in USD, or null if it couldn't be determined. */
  balanceUsd: number | null;
  /** Lifetime spend in USD, if the provider reports it. */
  usedUsd: number | null;
  level: CreditLevel;
  /** Human-readable one-liner, ready to log or surface. */
  message: string;
  /** Present when the check itself failed (network/auth). */
  error?: string;
}

export interface CreditThresholds {
  warnUsd: number;
  criticalUsd: number;
}

function thresholds(overrides?: Partial<CreditThresholds>): CreditThresholds {
  const warnUsd =
    overrides?.warnUsd ?? Number(process.env.CREDIT_WARN_THRESHOLD_USD ?? 5);
  const criticalUsd =
    overrides?.criticalUsd ?? Number(process.env.CREDIT_CRITICAL_THRESHOLD_USD ?? 1);
  return { warnUsd, criticalUsd };
}

function levelFor(balance: number, t: CreditThresholds): CreditLevel {
  if (balance <= t.criticalUsd) return 'critical';
  if (balance <= t.warnUsd) return 'low';
  return 'ok';
}

function fmt(n: number | null): string {
  return n === null ? 'unknown' : `$${n.toFixed(2)}`;
}

/** Check the Vercel AI Gateway credit balance via the AI SDK. */
export async function checkGatewayCredits(
  overrides?: Partial<CreditThresholds>,
): Promise<CreditStatus> {
  const t = thresholds(overrides);
  try {
    const c = await gateway.getCredits();
    const balanceUsd = Number(c.balance);
    const usedUsd = c.totalUsed === undefined ? null : Number(c.totalUsed);
    const level = Number.isFinite(balanceUsd) ? levelFor(balanceUsd, t) : 'unknown';
    return {
      provider: 'gateway',
      balanceUsd: Number.isFinite(balanceUsd) ? balanceUsd : null,
      usedUsd: usedUsd !== null && Number.isFinite(usedUsd) ? usedUsd : null,
      level,
      message: `Vercel gateway: ${fmt(balanceUsd)} remaining (used ${fmt(usedUsd)})`,
    };
  } catch (e) {
    return {
      provider: 'gateway',
      balanceUsd: null,
      usedUsd: null,
      level: 'unknown',
      message: 'Vercel gateway: credit balance unavailable',
      error: (e as Error).message,
    };
  }
}

/** Check the OpenRouter credit balance via its REST API. */
export async function checkOpenRouterCredits(
  overrides?: Partial<CreditThresholds>,
): Promise<CreditStatus> {
  const t = thresholds(overrides);
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    return {
      provider: 'openrouter',
      balanceUsd: null,
      usedUsd: null,
      level: 'unknown',
      message: 'OpenRouter: OPENROUTER_API_KEY not set',
      error: 'missing OPENROUTER_API_KEY',
    };
  }
  try {
    const res = await fetch('https://openrouter.ai/api/v1/credits', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      data?: { total_credits?: number; total_usage?: number };
    };
    const total = body.data?.total_credits;
    const used = body.data?.total_usage;
    if (typeof total !== 'number' || typeof used !== 'number') {
      throw new Error('unexpected response shape');
    }
    const balanceUsd = total - used;
    const level = levelFor(balanceUsd, t);
    return {
      provider: 'openrouter',
      balanceUsd,
      usedUsd: used,
      level,
      message: `OpenRouter: ${fmt(balanceUsd)} remaining (used ${fmt(used)} of ${fmt(total)})`,
    };
  } catch (e) {
    return {
      provider: 'openrouter',
      balanceUsd: null,
      usedUsd: null,
      level: 'unknown',
      message: 'OpenRouter: credit balance unavailable',
      error: (e as Error).message,
    };
  }
}

/** Check both providers. Order: gateway, openrouter. */
export async function checkAllCredits(
  overrides?: Partial<CreditThresholds>,
): Promise<CreditStatus[]> {
  return Promise.all([checkGatewayCredits(overrides), checkOpenRouterCredits(overrides)]);
}

const LEVEL_ICON: Record<CreditLevel, string> = {
  ok: '✅',
  low: '⚠️',
  critical: '🚨',
  unknown: '❔',
};

/** Format a status as a single log line, prefixed by a severity icon. */
export function formatCreditWarning(s: CreditStatus): string {
  const prefix =
    s.level === 'critical'
      ? 'CRITICAL — credits nearly exhausted'
      : s.level === 'low'
        ? 'LOW credits'
        : s.level === 'unknown'
          ? 'could not check credits'
          : 'credits OK';
  return `${LEVEL_ICON[s.level]} ${prefix}: ${s.message}`;
}

/**
 * Convenience for callers that want to emit warnings and know whether any
 * provider is in a warn/critical state. Logs each non-OK provider to `sink`
 * (defaults to console.warn) and returns the statuses.
 */
export async function warnOnLowCredits(
  opts: { thresholds?: Partial<CreditThresholds>; sink?: (line: string) => void } = {},
): Promise<{ statuses: CreditStatus[]; anyLow: boolean; anyCritical: boolean }> {
  const sink = opts.sink ?? ((line: string) => console.warn(line));
  const statuses = await checkAllCredits(opts.thresholds);
  let anyLow = false;
  let anyCritical = false;
  for (const s of statuses) {
    if (s.level === 'low') anyLow = true;
    if (s.level === 'critical') anyCritical = true;
    if (s.level !== 'ok') sink(formatCreditWarning(s));
  }
  return { statuses, anyLow, anyCritical };
}
