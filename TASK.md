## Redis 기반 임베딩 큐 도입 계획

### 1. 적합성 검토
- 기존 Node.js 임베딩 API는 유지하면서도 Redis 큐를 사이에 두면 Spring Boot → Node.js 간의 느슨한 결합과 재시도를 확보할 수 있음.
- Spring Boot 프로듀서는 이미 Redis LPUSH 로직을 보유하고 있어 추가 개발 부담이 낮음.
- Node.js 컨슈머는 BRPOP 기반 무한 루프로 구현 가능하며, 현재 OpenAI 임베딩 호출 흐름과 자연스럽게 연결됨.
- Redis 리스트는 선입선출 특성을 제공하고, 장애 시 실패 큐(`embedding:failed`)로 분리하여 운영팀이 모니터링/재처리하기 용이함.
- 고가용성 Redis 인프라가 전제돼야 하며, 큐 적체/중복 처리에 대한 모니터링과 알람 체계가 필요함.

### 2. 아키텍처 개요
```
[Spring Boot] → LPUSH → [Redis List embedding:queue] → BRPOP → [Node.js Consumer] → OpenAI 임베딩 → DB 저장
                                                              ↘ 실패 시 LPUSH embedding:failed
```

### 3. 구현 계획
1. **컨슈머 워커 초안 작성**
   - `services/embedding.service.ts` 를 호출하는 `processEmbeddingQueue` 모듈 작성.
   - Graceful shutdown, Concurrency(동시 워커 수) 옵션, 로깅(성공/실패/처리시간)을 포함.
2. **큐 메시지 스키마 확정**
   - `post_id`, `title`, `content`, `retryCount` 등을 포함하는 JSON 구조 정의 및 문서화.
   - 추후 schema 변경 대비 버전 필드 도입 검토.
3. **실패 처리 및 재시도 정책**
   - 실패 시 `embedding:failed` 로 이동 후 경고 로그 기록.
   - 재시도 워커(주기적 RPOP → LPUSH) 또는 Ops 수동 트리거 전략 결정.
4. **운영 모니터링**
   - `LLEN embedding:queue`, `embedding:failed` 메트릭을 Prometheus/Grafana 또는 기존 모니터링에 연동.
   - 알람 기준: 큐 길이 임계치, 실패 큐 누적, 워커 미응답.
5. **배포 전략**
   - Node.js 컨슈머를 기존 서버 프로세스와 분리( Docker 컨테이너)하여 독립 운영.
   - Spring Boot 측은 이미 구현된 LPUSH 로직을 활성화하고, 기존 REST 임베딩 호출은 점진적으로 감축.

### 4. 추가 고려사항
- 멱등성 확보를 위해 컨슈머 처리 완료 후 Redis 측에서 메시지를 제거했는지(이미 BRPOP 로 제거) 확인하고, 실패 재처리 시 중복 삽입 방지 로직 검토.
- OpenAI API 호출 실패 시 exponential backoff 적용 여부.
- 긴 콘텐츠 임베딩 시 chunking 로직(`chunkText`)과 큐 메시지 크기 제한 검토.
- 보안: Redis 접근 제어, TLS 필요 여부 확인.

### 5. 다음 단계
- [x] Node.js 컨슈머 초안 코드 작성 및 환경 변수(`REDIS_URL`, `EMBEDDING_QUEUE_KEY`) 정리.
- [ ] 개발 환경에서 Redis 로컬 인스턴스와 통합 테스트 진행.
- [ ] 모니터링/알람 구성 논의.

### 6. 컨테이너/배포 설계
- **기본 이미지 재사용**: 기존 `Dockerfile` 로 빌드한 동일 이미지를 `api`(Express)와 `worker`(컨슈머)가 공유, 각 컨테이너는 `command` 만 다르게 지정.
- **엔트리포인트 분리**: `src/worker/queue-consumer.ts` 추가 → `tsc` 결과가 `dist/worker/queue-consumer.js` 로 생성되도록 빌드 경로 확인. `package.json` 에 `worker` 스크립트(`node dist/worker/queue-consumer.js`) 등록.
- **Docker Compose 초안**
  ```yaml
  services:
    api:
      build: .
      command: ["node", "dist/server.js"]
      ports: ["3000:3000"]
      env_file: .env
      depends_on: [redis]

    worker:
      build: .
      command: ["node", "dist/worker/queue-consumer.js"]
      env_file: .env
      depends_on: [redis]

    redis:
      image: redis:7-alpine
  ```
- **환경 변수 공유**: `.env` 에 Redis 접속 정보(`REDIS_HOST`, `REDIS_PORT`, `REDIS_URL` 등)와 큐 이름, 실패 큐 이름 등을 명시하고 두 서비스 모두 로드.
- **운영 고려**: `worker` 컨테이너 스케일 아웃(예: `docker compose up --scale worker=3`)에 대비해 작업 멱등성 확인. 장애 시 개별 컨테이너 재시작 전략, 로그 수집 경로(예: stdout→EFK) 정의.
