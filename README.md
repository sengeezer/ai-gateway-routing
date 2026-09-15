# AI Gateway Routing — "Best Model for Task Type"

Application-level, **task-type** model routing for the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) with an optional OpenRouter hybrid. Classify each request into a tier, then hand the request to the best model for that tier — deterministically and auditably.

| Tier | When | Backend (default) |
|------|------|-------------------|
| `fast` | short / simple text | **OpenRouter** `openrouter/auto` (togglable → gateway) |
| `reasoning` | hard analysis, long prompts | Vercel gateway → `anthropic/claude-opus-4.8` |
| `vision` | image inputs | Vercel gateway → `openai/gpt-4o` |
| `coding` | code in the prompt | Vercel gateway → `anthropic/claude-sonnet-4` |

Non-`fast` tiers get an explicit model ID **plus a fallback chain** (`providerOptions.gateway.models`). The `fast` tier defaults to OpenRouter's Auto Router but is switchable (see toggle below).

> **Why not just use the gateway's auto-router?** It doesn't have one. The Vercel AI Gateway is a provider/reliability layer (fallbacks, cost sorting, provider ordering) — it does **not** classify a request and pick a model. Task-type routing has to be done at the application level, which is what this does.

## Install

```bash
npm install
cp .env.example .env   # then fill in your keys
```

Required env: `AI_GATEWAY_API_KEY` (gateway tiers) and, for the default fast tier, `OPENROUTER_API_KEY`.

## Use

```ts
import { routedGenerate } from './src/router';

const r = await routedGenerate({ prompt: 'Write a SQL query for top customers by revenue.' });
console.log(r.tier, r.provider, r.text); // -> coding gateway ...

// Images route to the vision tier automatically:
await routedGenerate({ prompt: 'What is in this image?', images: [bytesOrUrl] });
```

### Fast-tier toggle (human or machine)

Precedence, highest first:

1. per-call: `routedGenerate({ prompt, fastProvider: 'gateway' })`
2. programmatic: `setFastTierProvider('gateway')`
3. environment: `FAST_TIER_PROVIDER=gateway|openrouter`
4. built-in default: `openrouter`

### Credit warnings (not caps)

`src/credits.ts` checks both providers' balances and **warns** when they run low — it never caps or downgrades a request (quality-first). Thresholds via `CREDIT_WARN_THRESHOLD_USD` / `CREDIT_CRITICAL_THRESHOLD_USD`.

```ts
import { warnOnLowCredits } from './src/credits';
await warnOnLowCredits(); // logs ⚠️/🚨 lines; returns { anyLow, anyCritical }
```

## Scripts

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | vitest unit tests (offline; network mocked) |
| `npm run eval` | scores the classifier against the labeled set |
| `npm run check` | typecheck + test + eval (the CI gate) |
| `npm run demo` | dry-run routing table (no API calls) |
| `npm run e2e` | live generation across all tiers (needs keys) |

## Classifier accuracy — measured, not assumed

The classifier is a regex + prompt-length heuristic. It is **evaluated**, and the current numbers are deliberately honest:

- **Overall: ~73%** on the labeled set (`eval/dataset.ts`).
- **Adversarial subset: ~14%** — prose containing code/reasoning keywords, or reasoning/coding asks phrased in plain English, get mis-routed.
- **Vision: 100%** (image presence is an unambiguous signal).

`npm run eval` prints per-tier precision/recall, a confusion matrix, and every misroute, and fails below `MIN_ACCURACY` (default 0.70) so CI catches regressions. **The heuristic is a baseline, not the finished classifier** — see the eval output for exactly where it fails.

## License

MIT
