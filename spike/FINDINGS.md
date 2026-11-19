# 1단계 스파이크 결과

## A. 키 없이 확인 (2026-11-20)

### `GET /inference/go/v1/models` — 인증 없이 200
- 최상위는 `{"object":"list","data":[...]}` 뿐. 계정별 정보 없음.
- 모델별 필드: `id, name, canonical_id, family, type, description, knowledge, release_date, last_updated,
  modalities, capabilities, limit, cost, api, recommended_api, go, open_weights, owned_by, created`
- **월 한도는 `go.monthly_usage` = `{go, go-plus, go-teams}`** (플랜별 값). 무료 모델은 `null`.
  - 예: glm-5.3 500/1000/505, deepseek-v4.1-flash 100/200/105, gpt-6-luna 15/60/20
  - 이 숫자의 단위(요청 수? 상대값?)는 키로 확인 필요.
- `go`에 `training`, `zdr`, `limited_regions`, `featured`도 있음 → `go_models`에 `training:true`/`zdr:false` 표시할 가치 있음.
- `capabilities.tools.supported` 전 모델 true. `capabilities.reasoning.effort` = 모델마다 다른 허용값 배열
  (`none/minimal/low/medium/high/xhigh/max` 중 일부, 없을 수도 있음) → `reasoning_effort`는 모델별로 검증해야 함.
- `limit.context`, `limit.output` 있음.
- `cost.multipliers`: 일부 모델(deepseek-v4.1-flash, deepseek-v4-pro, gemini-4-argon)에 평일 UTC 01–04, 06–10시 **2배** 규칙.
  한도 소모가 시간대에 따라 다르다 → GUIDE/`go_models`에 노출 고려.
- **`recommended_api`가 4종**: `chat-completions`(다수), `messages`(qwen*, minimax-m3, claude-haiku-5-5),
  `responses`(gpt-*, grok, muse), `generate-content`(gemini). `api.<kind>.base_url`에 경로가 나옴.
  PLAN의 "어느 경로든 모든 모델을 받는다"는 키로 교차 호출해서 확인 필요 (spike.sh 5번).
- `*-free`, `*-contributor-free` 모델 존재 (monthly_usage null). 약관상 외부 클라이언트는 403 예상.

### 헤더 검증 순서
- `x-opencode-session` 없이 POST → **400** `{"type":"error","error":{"type":"MissingSessionID",...}}`
  (chat/completions, messages 둘 다). 인증보다 먼저 검사됨.
- 세션 헤더 있고 키 없음 → **401** `{"error":{"type":"authentication_error","message":"OpenCode Go requires an API key"}}`
- `GET /zen/go/v1/usage` 키 없음 → 401 `AuthError`. 엔드포인트 자체는 살아 있음.

## B. 키로 확인 (2026-11-19 16:10 UTC, spike.sh 1차 실행)

키 노출 없음 확인(`spike/out/`에 `oc_sk_` 문자열 없음).
GET 세 건(`/zen/go/v1/usage` ×3, 인증 `/v1/models`)은 스크립트 버그(bash 3.2 빈 배열 + `set -u`)로 실행되지 않았다 → 수정함, 재실행 필요.

### 인증 — 확정
| 경로 | `Authorization: Bearer` | `x-api-key` |
|---|---|---|
| `/openai/v1/chat/completions` | 200 | **401** |
| `/anthropic/v1/messages` | 200 | 200 |

→ **Bearer 하나로 통일.** (cc-switch PR #6196의 "messages는 x-api-key만"은 현재 사실 아님.)

### 교차 경로 — 확정
chat/completions로 messages 모델(qwen3.8-flash)·responses 모델(gpt-6-luna), messages로 chat-completions 모델(glm-5.3-flash) 모두 200.
→ **`go_chat`은 chat/completions 한 경로만 쓴다.** `recommended_api`는 참고용. (generate-content 모델 gemini는 미확인.)

### usage 모양 — 확정
```
usage.opencode = {
  billing_source: "go",
  list_cost:  <USD, 정가>,
  allowance:  <USD, 이번 요청이 깎은 월 한도>,
  tokens: { input, output, reasoning, cache_read, cache_write_5m, cache_write_1h }
}
usage.cost = 0   (Go 한도로 처리되면 0; 잔액 차감 시 값이 생길 것으로 추정)
```
- PLAN의 `cost` 위치가 다르다: 최상위 `usage.cost`는 0이고, 정가는 `opencode.list_cost`.
- **`allowance` = `list_cost` × 모델 배수.** glm-5.3-flash ×1, qwen3.8-flash ×2, gpt-6-luna ×4.
  `go.monthly_usage`(glm-5.3 500, gpt-6-luna 15 …)는 이 배수의 역수 관계로 보임 = "월 한도로 이 모델을 몇 단위 쓸 수 있나"의 상대값.
  상태줄/`go_models`는 `allowance`(USD)를 합산하면 되고 monthly_usage 해석은 필요 없다.
- `opencode.tokens.input`은 **캐시 제외 입력**(cache_2: prompt_tokens 4015 = input 751 + cache_read 3264). 상태줄 합산 시 이중계산 주의.
- 표준 필드도 같이 옴: chat/completions `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens`;
  messages `cache_read_input_tokens` 등.

### 스트리밍 — 확정
- chat/completions: `stream_options.include_usage:true`면 `choices:[]` + `usage`(opencode 포함) 청크 뒤 `[DONE]`. deepseek-worker `streamChat` 그대로 재사용 가능.
- 추론 텍스트는 `delta.reasoning_content`. 저장 시 버려야 함.
- messages: `event: ping` 먼저, `message_delta.usage`에 opencode 포함. thinking 블록의 `signature`가 **빈 문자열** → v0.2 explore에서 Claude Code로 넘길 때 thinking 블록 제거 필요(PLAN 5단계 리스크 실재).

### 프롬프트 캐시 — 확정
같은 `x-opencode-session`, ~4k 토큰 같은 접두사 두 번째 요청에서 `cache_read` 3264. `cache_write_*`는 0으로 보고됨(자동 캐시).
allowance 0.00060675 → 0.00021207 (약 1/3).

### 기타
- `reasoning_effort:"low"`(chat/completions) 200, 에러 없음. 효과 크기는 미확인.
- 응답 헤더: `x-zen-model`(실제 처리 모델), `x-opencode-log-id`(문의용), `server-timing`. 레이트리밋 헤더는 없음 → 남은 한도는 usage 엔드포인트로만.
- 지연: 단문 1.5–2.5s, gpt-6-luna 교차 5.3s.

### usage 엔드포인트 — 2차 실행 (2026-11-19 16:15 UTC)
- `GET https://opencode.ai/zen/go/v1/usage`: **Bearer 200, x-api-key 401.**
```json
{"usage":{
  "rolling":{"status":"ok","percent":0,"resetsAt":"2026-11-19T21:10:37.000Z"},
  "weekly": {"status":"ok","percent":0,"resetsAt":"2026-11-23T00:00:00.000Z"},
  "monthly":{"status":"ok","percent":0,"resetsAt":"2026-12-19T16:01:58.000Z"}}}
```
- `rolling.resetsAt` = 첫 요청(16:10:37) + 5h → 5시간 창은 첫 사용 시점부터 시작. `weekly`는 월요일 00:00 UTC. `monthly`는 구독일 기준.
- 스파이크 전후 `percent` 모두 0 (allowance 합 ≈ $0.003). **정수 퍼센트로 반올림/절삭**되는 것으로 보임 → 상태줄의 세밀한 값은 응답 `allowance` 합산으로 보완.
- `status`는 `ok` 외 값(한도 초과 시)을 아직 못 봄 → 본체에서 `ok`가 아니면 그대로 표시.
- 인증 `/v1/models`는 익명 응답과 동일(31개, `created` 제외 diff 없음) → **`go_models`는 키 없이 호출**.
- 429 모양은 미확인 — 본체에서 상태코드·본문을 그대로 전하고 usage 엔드포인트의 `resetsAt`을 붙여 방어적으로 처리.

1단계 완료.
