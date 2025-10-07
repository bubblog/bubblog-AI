## 하이브리드 서치 확장(질문 재작성 + 키워드)

목표
- 리콜 향상: 질문을 LLM이 재작성(rewrites)하고, 핵심 키워드를 생성하여 벡터+텍스트 양쪽에서 검색.
- 정밀/비용 제어: 재작성/키워드 개수를 제한하고, 융합 가중치로 결과를 안정적으로 선별.

Plan JSON 확장(초안)
```json
{
  "rewrites": ["..."],
  "keywords": ["..."],
  "hybrid": { "enabled": true, "alpha": 0.7, "max_rewrites": 4, "max_keywords": 8 }
}
```
- 기존 필드(`top_k`, `threshold`, `weights`, `filters.time`, `sort`, `limit`)와 공존.
- 서버에서 상한 강제(rewrites<=4, keywords<=8), 품질이 낮거나 중복인 항목 제거.

프롬프트 가이드(확장)
- 역할: ‘검색 계획 + 재작성/키워드 생성’
- 출력: 기존 계획 JSON + `rewrites[]`, `keywords[]`, `hybrid{}`
- 규칙:
  - 불용/범용 단어(예: "글", "포스트", "블로그") 지양
  - 과도한 시기/주제 확장 금지(사용자 블로그 컨텍스트 벗어나지 않기)
  - 중복/동의어 반복 최소화(문장 유사도 과다 시 제거)

하이브리드 검색 파이프라인
1) 멀티 벡터 검색: 원 질문 + rewrites 각각 임베딩 → pgvector Top-K 검색(합집합)
2) 텍스트 검색: keywords로 `post_chunks.content`/`blog_post.title` 텍스트 매칭 → Top-K 추출
3) 랭킹 융합: 점수 정규화 후 `score = α·vec + (1-α)·text` 또는 RRF로 병합 → 상위 N 청크 선택
4) 컨텍스트 구성: v1과 동일 프롬프트로 최종 LLM 호출

저장소/인덱스(제안)
- PostgreSQL 확장: `pg_trgm`(간단/범용) 또는 `tsvector`(정교)
- 1차안(pg_trgm)
  - DDL: 
    - `CREATE EXTENSION IF NOT EXISTS pg_trgm;`
    - `CREATE INDEX IF NOT EXISTS idx_pc_content_trgm ON post_chunks USING gin (content gin_trgm_ops);`
    - `CREATE INDEX IF NOT EXISTS idx_bp_title_trgm ON blog_post USING gin (title gin_trgm_ops);`
  - 질의: `similarity(content, $q) > $min OR content ILIKE ANY($patterns)` 등으로 text_score 계산

SSE 확장(선택)
- `event: rewrite` / `data: ["..."]`
- `event: keywords` / `data: ["..."]`
- `event: hybrid_result` / `data: [{ postId, postTitle }]`

보안/안전
- 재작성/키워드 출력 스키마 강제(JSON), 길이/개수 상한
- 금칙어/민감어 필터(선택), 카테고리/기간 필터는 서버가 최종 결정

세부 구현 계획(하이브리드 서치)
1) 스키마/프롬프트
  - [ ] `src/types/ai.v2.types.ts`: Plan 스키마에 `rewrites[]`, `keywords[]`, `hybrid{enabled,alpha,max_rewrites,max_keywords}` 추가
  - [ ] `src/prompts/qa.v2.prompts.ts`: 프롬프트/JSON Schema에 확장 필드 반영 + few-shot 보강
2) 플래너 서비스
  - [ ] `search-plan.service.ts`: 확장 필드 파싱/검증, 중복/불용어 필터링, 상한 강제
3) 텍스트 검색 저장소
  - [ ] `post.repository.ts`: `textSearchChunksV2({ userId, query, keywords[], from?, to?, topK })`
  - [ ] (옵션) DDL 문서화: pg_trgm 인덱스 생성 스크립트 추가
4) 하이브리드 서비스
  - [ ] `hybrid-search.service.ts` 구현: 멀티 임베딩, 텍스트 검색, 정규화, α 융합/RRF, 상위 N 반환
5) 오케스트레이션/이벤트
  - [ ] `qa.v2.service.ts`: plan.hybrid.enabled 시 하이브리드 경로 분기, (선택) `rewrite`/`keywords`/`hybrid_result` 송신
6) 테스트/튜닝
  - [ ] 통합 테스트: 재작성/키워드 포함 질의에서 리콜↑ 확인
  - [ ] 가중치 α, Top-K 상수, 불용어/중복 필터 기준 튜닝
  - [ ] 0건/오류 폴백(v1 RAG) 검증

권장 단계적 도입
- Phase 1: 스키마/프롬프트/하이브리드 파이프라인 구현(기본 α=0.7, rewrites<=3, keywords<=6)
- Phase 2: SSE 관측성 이벤트 추가, 품질 튜닝
- Phase 3: 인덱스/성능 최적화, 불용어 사전/NER 보정
