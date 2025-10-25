## Hybrid Search Upgrade Plan (Working Doc)

### 1. Current Implementation Snapshot
- `runHybridSearch(question, userId, plan)` (src/services/hybrid-search.service.ts)
  - Embeds `[question, ...plan.rewrites]` and runs `findSimilarChunksV2` per embedding.
  - Executes `textSearchChunksV2` once using the original question + keywords.
  - Merges chunk candidates by `postId:postChunk`, keeps max vector/text score per chunk, min–max normalizes each modality, then fuses via `alpha` blend.
  - Returns top `plan.top_k` chunks (capped 10); `plan.limit` ignored here.
- Semantic-only fallback uses same repository call without text blending (`runSemanticSearch`).
- Planner (`generateSearchPlan`) currently emits rewrites/keywords but keyword quality/quantity varies; schema clamps counts post-hoc.
- Category filters from API are not wired into hybrid search; text rewrites are not reused in lexical search; chunk key uses raw text.

### 2. Pain Points & Gaps
1. **Filtering gaps** – category/time filters partially ignored, final `limit` unused, vector threshold normalization can collapse to zero when max=min.
2. **Keyword quality** – LLM often emits multi-word phrases or duplicates; count not consistently within intended range.
3. **Rewrite redundancy** – All rewrites treated equally; no semantic-distance-aware weighting → aggressive rewrites may be undervalued or noisy ones over-weighted.
4. **Fused scoring sensitivity** – Min–max normalization across union is brittle when modalities have outliers; no similarity-based bonus for high-confidence hits.
5. **Post-level UX** – Current pipeline optimized for RAG chunk retrieval; no reusable API that returns deduplicated post-level hits with pagination.
6. **Observability** – Limited metrics around rewrite effectiveness, keyword usage, or threshold activations.

### 3. Goals & Guiding Principles
- Preserve strong recall via multi-embedding + lexical hybrid while adding stability and transparency.
- Make rewrite/keyword generation purposeful: enforce concise tokens, staged semantic drift, and maintain question coverage.
- Provide a standalone hybrid search endpoint for user-facing search with post-level results.
- Instrument similarity thresholds and modality contributions to support tuning.

### 4. Retrieval Quality Enhancements (Track A)

4.1 **Similarity Threshold Boosting**
- Reuse the existing retrieval bias labels (`lexical`, `balanced`, `semantic`) to derive both `alpha` and default modality thresholds (`sem_boost_threshold`, `lex_boost_threshold`) so planner output stays compact. Defaults (retain current behavior for now):
  - `lexical`: `alpha = 0.30`, `sem_boost_threshold = 0.65`, `lex_boost_threshold = 0.80`
  - `balanced`: `alpha = 0.50`, `sem_boost_threshold = 0.70`, `lex_boost_threshold = 0.75`
  - `semantic`: `alpha = 0.75`, `sem_boost_threshold = 0.80`, `lex_boost_threshold = 0.65`
- Encode the mapping as a single constants table (e.g., `RETRIEVAL_BIAS_PRESETS`) so both planner normalization and hybrid scoring reference identical values.
- Permit optional overrides in `plan.hybrid`, but clamp to sensible bounds (e.g., 0.4–0.85) for consistency.
- When a normalized vector/text score crosses its threshold, apply a bounded boost (e.g., multiply by 1.1–1.3 or add 0.1), log activations, and cap boosts to maintain ranking stability.

4.2 **Rewrite Strategy & Weighting**
- Update planner prompt to generate staged rewrites:
  - `rewrite_1`: conservative paraphrase.
  - `rewrite_2`: adds synonymous term / clarifies entity.
  - `rewrite_3+`: higher semantic drift or alternative framing.
- After plan normalization (`search-plan.service.ts`):
  - Compute embedding-based cosine similarity between original question and each rewrite.
  - Drop rewrites below a floor (e.g., <0.35) or route them to lexical-only usage.
  - Derive per-rewrite weights (e.g., `weight = clamp(similarity, 0.6, 1.2)`) and supply to `runHybridSearch`.
  - Similarity calculations use fresh embedding API calls (no caching) for both the question and rewrites within the request.
- In hybrid service, apply weights when aggregating vector scores (weighted max/avg instead of pure max) so high-quality rewrites contribute proportionally.

4.3 **Keyword Constraints & Quality**
- Modify `planSchema` / prompt: keywords must be single Korean/English tokens (no spaces), trimmed, 1–5 items.
- In normalization, enforce `.slice(0,5)`, drop tokens <2 chars or containing whitespace/punctuation (except hyphen/underscore if needed).
- Extend text search to run over `[question, ...filtered rewrites]` for lexical recall or compute textual similarity per rewrite (optional v2 step).

4.4 **Repository/Data Adjustments**
- Update `findSimilarChunksV2` / `textSearchChunksV2` to return `chunk_index`, `post_created_at`, and optionally `post_tags` for downstream boosts.
  - Tag aggregation via `post_tag` ⇔ `tag` should be added only if such tables exist; otherwise return `[]` and skip joins.
- Switch dedup key to `${postId}:${chunk_index}` to avoid string-heavy keys.
- Filters wiring: Do NOT add `filters.category_ids` to the plan. Keep the plan schema limited to `filters.time`.
  - Use `categoryId` from the controller as a server-side pre-filter only.
  - Derive `from/to` from the normalized plan time window (label → absolute) and apply in repositories.
  - Respect `plan.limit` at the final slicing stage.
- Keep retrieval as exact KNN on `pgvector` (ORDER BY `<=>`); `top_k` stays per-source fetch size while final slicing respects `plan.limit`.

<!-- moved to Backlog: see section 11 -->

### 5. Search API & Post-Level Experience (Track B)
- **Service decomposition** – Extract shared primitive `buildHybridCandidates({ question, rewrites, keywords, plan, userId, categoryId })` returning chunk-level scores + metadata + diagnostic stats.
- **Post aggregation** – Create aggregator to deduplicate by post (max score, optional average of top 2, representative snippet) and apply deterministic `limit/offset` pagination (page size default 10, max 10).
- **Public API** – Add unauthenticated REST endpoint (JSON, no SSE) such as `GET /search/hybrid` accepting question, filters, paging params; reuse the planner or a lightweight variant as UX dictates.
- **QA reuse** – `answerStreamV2` continues calling chunk-level layer; search endpoint uses same embeddings/threshold logic to avoid drift.

### 6. Prompts & Planner Improvements
- Update `buildSearchPlanPrompt` instructions:
  - Require keywords to be single words, explicitly request “1~5 단일 키워드”.
  - Outline staged rewrite roles to nudge LLM output.
  - Remind that temporal expressions stay in `filters.time`.
- Keep the client-facing `planSchema` minimal (no explicit `alpha`/threshold/weight fields). Server derives weights/thresholds internally from the retrieval bias label and does not surface them to the frontend.
- Update schema docs only for keyword bounds (1–5) and any internal validation notes; no additional fields are exposed over the API.
- In normalization, log keyword count, rewrite count, threshold values to support telemetry.

### 7. Observability & Telemetry
- Structured logs/SSE events:
  - For each query: number of rewrites retained, similarity weights, threshold boosts triggered, counts per modality.
  - Emit metrics for search endpoint (total posts returned, pagination info, latency).
- Standardize a log payload (e.g., `type: 'retrieval.boost', bias, alpha, sem_thr, lex_thr, modality, original_score, boosted_score`) to simplify analysis and tuning.
- Add debug flags to inspect per-rewrite vector/text hit lists for evaluation.

### 8. Performance Considerations
- Generate embeddings for `[question, rewrites]` with fresh API calls per request (no caching); accept the additional cost for correctness.
- Cap total vector queries by `plan.hybrid.max_rewrites`; consider batching embeddings via OpenAI API if supported.
- Monitor effect of threshold boosts on latency; adjust SQL to prefetch needed metadata in single round-trip.

### 9. Execution Roadmap (Detailed)

**Phase 0 – Foundations & Bugfixes**
- Task 0.1: Thread request filters (`categoryId`, `limit`) through `qa.v2.service.ts`. Do NOT add `filters.category_ids` to the plan; the server applies `categoryId` as a pre-filter. Derive `from/to` solely from the normalized plan `filters.time` (label → absolute) and use in repositories.
- Task 0.2: Honor `plan.limit` when returning hybrid results, switch dedupe key to `${postId}:${chunk_index}`, and propagate `chunk_index` through types.
- Task 0.3: Expand `findSimilarChunksV2`/`textSearchChunksV2` to select `chunk_index`, `post_created_at`, and optionally aggregated `post_tags` (only if tag tables exist); update SQL joins and DTOs with safe fallbacks.
- Task 0.4: Update hybrid/semantic services to surface new metadata in SSE payloads, keeping backward compatibility for existing clients.

**Phase 1 – Planner & Prompt Hardening**
- Task 1.1: Tighten `planSchema` validation (keywords 1–5 single tokens, rewrites ≤ max_rewrites) and normalize via shared helpers with telemetry hooks.
- Task 1.2: Revise `buildSearchPlanPrompt` instructions to enforce staged rewrites, single-token keywords, and explicit temporal guidance; add regression fixtures for prompt drift.
- Task 1.3: Implement normalization pass that cleans keywords, generates embeddings for rewrites, filters low-similarity variants, and records per-rewrite cosine similarity.
- Task 1.4: Persist summary logs (`rewrites_len`, similarity weights, keyword counts) via structured logger for observability.

**Phase 2 – Retrieval Scoring Upgrades**
- Task 2.1: Introduce `RETRIEVAL_BIAS_PRESETS` mapping (`alpha`, `sem_boost_threshold`, `lex_boost_threshold`) and clamp overrides in normalization.
- Task 2.2: Apply threshold-based boosts in `runHybridSearch`, logging activations and capping final scores for stability.
- Task 2.3: Weight vector scores by rewrite similarity (e.g., weighted max/avg) and expose diagnostics per rewrite.
- Task 2.4: Extend lexical search to iterate across `[question, rewrites]`, merging results while respecting keyword filters and avoiding redundant queries.
- Task 2.5: Enforce post-level diversity (max N chunks/post) before final ranking and respect `plan.limit` after fusion.

**Phase 3 – Search API Delivery**
- Task 3.1: Extract `buildHybridCandidates` service returning chunk-level hits plus diagnostics; retrofit QA flow to consume it.
- Task 3.2: Build post aggregation layer (score fusion, snippet selection, pagination respecting `limit/offset`) with deterministic ordering.
- Task 3.3: Add `GET /search/hybrid` route, request validation, and integration tests covering filters, pagination, and telemetry events.
- Task 3.4: Document API usage and ensure rate-limiting/auth hooks match product requirements.

**Phase 4 – Tuning & Observability**
- Task 4.1: Emit structured SSE/log events for threshold boosts, rewrite weighting, keyword pruning, and modality contributions.
- Task 4.2: Backfill dashboards or log queries (e.g., BigQuery/Redash) to monitor latency, hit counts, and boost frequency.
- Task 4.3: Create evaluation playbook with canonical queries, offline regression scripts, and guidance for tuning boost factors.
- Task 4.4: Investigate alternative fusion strategies (RRF/z-score) gated behind feature flags for safe experimentation.

### 10. Open Questions
- Do we need separate planner settings for public search vs QA (e.g., higher keyword count)?
- Should rewrite weights persist back into plan schema for transparency to the client?
- What default boost factors strike best balance between recall and precision? Requires offline eval.

---
Use this document as the anchor before implementation; update sections as design decisions finalize or metrics inform threshold choices.

### 11. Backlog
- Normalization stability (min–max collapse): evaluate mitigations without immediate implementation. Candidates include constant fallback (e.g., 0.5), epsilon guards, rank-based fusion (RRF), z-score fusion, unimodal fallback, and telemetry for activation frequency.
