# Project TODO

## Requested (next up)

- [ ] **App-level API-key gating for the endpoint.** Add an optional shared-secret /
      per-consumer key check inside `api/classify.ts` (header `x-api-key`), as a second
      layer alongside Vercel's Protection Bypass for Automation. Support multiple keys +
      revocation via an env list; return 401 when absent/invalid. Rationale: finer-grained,
      app-owned authorization independent of the Vercel platform toggle.
- [ ] **Fix the `reason-2` misroute** ("prove √2 is irrational" → classified `coding`).
      The embeddings classifier pulls math proofs toward the coding centroid. Options:
      add math-proof reference utterances to the `reasoning` route (careful: keep them
      DISJOINT from the eval set to avoid leakage), or add a small tie-break rule. Re-run
      `npm run eval:compare` and confirm overall stays ≥ 96.7% without breaking others.

## Backlog (from the cost analysis + local Qwen work)

- [ ] **Route more tiers to local Qwen.** `fast` already supports `FAST_TIER_PROVIDER=local`.
      Qwen3.6-35B-A3B has a vision projector (mmproj) and 262k context — evaluate it for the
      `vision` tier (free multimodal) and as a cheap `reasoning`/`coding` fallback.
- [ ] **Stop hardcoding the local endpoint.** Hermes's internal llama-server uses a rotating
      port + API key. Point `LOCAL_LLM_BASE_URL`/`LOCAL_LLM_API_KEY` at a stable endpoint —
      a dedicated llama.cpp instance, or the local OmniRoute gateway (`:20128`) fronting Qwen.
- [ ] **Downtier the `reasoning` default.** `anthropic/claude-opus-4.8` is top-of-market
      priced. Reserve it for genuinely hard cases; default most reasoning to a cheaper strong
      model (e.g. `google/gemini-2.5-pro` or `anthropic/claude-sonnet-4`) with opus as an
      opt-in escalation. Consider a confidence/length-based reasoning sub-split.
- [ ] **Per-request cost instrumentation.** Detailed Vercel spend reports are a paid feature
      (`getSpendReport()` → 402/"requires a paid plan"). Capture `providerMetadata.gateway`
      generationId + token usage per call and log estimated cost, so spend is attributable
      without the paid dashboard. Feed this back into tier tuning.
- [ ] **Optional: semantic-eval in CI on a cheaper embedding model** to cut the (already tiny)
      per-run cost, or cache reference embeddings as a committed fixture.
