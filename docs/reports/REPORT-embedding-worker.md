# 보고서: Redis 큐 기반 임베딩 워커 도입 및 배포 구성

## 1. 개요
- 목적: Spring Boot → Redis → Node.js 파이프라인으로 임베딩 생성을 비동기 처리하고, Express API와 분리된 워커를 운영한다.
- 상태: 워커 엔트리포인트·환경 변수 스키마·도커 컴포즈·GitHub Actions 배포 흐름까지 반영 완료.
- 범위: 기존 API 서버 코드는 유지하면서 Redis 큐 소비 로직을 추가하고, 단일 Docker 이미지로 API/워커 컨테이너를 분리 운용한다.

## 2. 워커 구조
- 파일: `src/worker/queue-consumer.ts`
  - Redis 연결: `REDIS_URL`(우선) 또는 `REDIS_HOST`/`REDIS_PORT`.
  - 작업 형식: `{ postId, title, content, attempt? }` (`title`/`content`는 boolean 플래그).
  - 처리 순서
    1. `BRPOP` 으로 `EMBEDDING_QUEUE_KEY` 대기.
    2. 플래그 기준으로 DB에서 게시글을 조회(`findPostById`)하고, 제목(`storeTitleEmbedding`)과 본문(`chunkText` → `createEmbeddings` → `storeContentEmbeddings`)을 필요 시 처리.
    3. 오류 시 재시도: `attempt` 증가, `EMBEDDING_WORKER_MAX_RETRIES`, `EMBEDDING_WORKER_BACKOFF_MS` 기반 backoff, 한계를 넘으면 `EMBEDDING_FAILED_QUEUE_KEY` 로 이동.
  - 기타: Graceful shutdown(SIGINT/SIGTERM), 콘솔 로그로 주요 이벤트 기록.

## 3. 환경 변수 (추가 항목)
| 키 | 용도 | 기본값 |
| --- | --- | --- |
| `REDIS_URL` | 외부 Redis 접속 URL (우선 사용) | 없음 |
| `REDIS_HOST` / `REDIS_PORT` | URL 미지정 시 호스트/포트 | `127.0.0.1` / `6379` |
| `EMBEDDING_QUEUE_KEY` | 작업 큐 이름 | `embedding:queue` |
| `EMBEDDING_FAILED_QUEUE_KEY` | 실패 큐 이름 | `embedding:failed` |
| `EMBEDDING_WORKER_MAX_RETRIES` | 최대 재시도 횟수 | `3` |
| `EMBEDDING_WORKER_BACKOFF_MS` | 재시도 간 대기(ms) | `5000` |

## 4. 도커 이미지 & 실행
- Dockerfile 기본 CMD: `node dist/server.js` (Express API).
- 동일 이미지를 재사용하되 `docker run ... node dist/worker/queue-consumer.js` 로 커맨드를 오버라이드하면 워커가 실행된다.
- pm2 불필요: 컨테이너 단일 프로세스 가정 + Docker `restart` 정책으로 복구.

## 5. docker-compose (개발용)
```yaml
services:
  api:
    build: .
    command: ["node", "dist/server.js"]
    env_file: [.env]
    ports: ["3000:3000"]
    restart: unless-stopped

  worker:
    build: .
    command: ["node", "dist/worker/queue-consumer.js"]
    env_file: [.env]
    restart: unless-stopped
```
- 외부 Redis 사용이 기본 전제. 필요 시 개발 환경에서만 Redis 서비스를 추가해 `.env` 를 해당 컨테이너로 지정.

## 6. GitHub Actions 배포 (main.yml)
- 이미지: `${{ secrets.DOCKER_USERNAME }}/bubblog-ai:latest` 빌드/푸시.
- EC2 배포 단계:
  1. 기존 `bubblog-ai`, `bubblog-ai-worker` 컨테이너 정지/삭제.
  2. 최신 이미지 pull.
  3. API 컨테이너 실행(기본 CMD).
  4. 워커 컨테이너 실행(`node dist/worker/queue-consumer.js` 명령).
- 두 컨테이너 모두 Redis 및 재시도 관련 Secrets를 전달하여 구성 누락을 방지.
- Secrets(예시): `REDIS_URL`, `REDIS_HOST`, `REDIS_PORT`, `EMBEDDING_QUEUE_KEY`, `EMBEDDING_FAILED_QUEUE_KEY`, `EMBEDDING_WORKER_MAX_RETRIES`, `EMBEDDING_WORKER_BACKOFF_MS` 등.

## 7. 운영 참고 사항
- Spring Boot 프로듀서는 LPUSH 로 작업을 큐에 적재하며, `title`/`content` 변경 여부를 boolean 값으로 전달한다(이미 구현됨).
- Redis 는 외부 서버/매니지드 환경을 사용; 본 프로젝트 컨테이너에서는 Consumer 역할만 수행.
- 실패 큐(`embedding:failed`) 모니터링 및 재처리(예: RPOP → LPUSH → 재시도 스케줄러) 전략 필요.
- API 컨테이너에서 Redis 변수가 필요하지는 않지만, 비상시 커맨드 오버라이드를 대비해 공통으로 주입해 둔 상태.

## 8. 향후 체크리스트
- [ ] 스테이징 환경에서 Redis/DB 연결 및 임베딩 저장 성공 여부 검증.
- [ ] 실패 큐 모니터링/알림 구성.
- [ ] 워커 스케일 아웃 전략 정의 (컨테이너 수 확장 시 처리 충돌 없는지 확인).
- [ ] Redis 접근 제어/TLS 여부 점검.
