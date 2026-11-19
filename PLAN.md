# opencode-go-worker 플랜

[claude-deepseek-worker](https://github.com/doongchoong/claude-deepseek-worker)의 컨셉을 이어받는다:
**워커는 철저히 도구이고, 언제·무엇을·어떻게 맡길지와 결과 검토는 전부 Claude가 판단한다.**
별도 MCP 서버, 프록시, opencode CLI 의존성은 두지 않는다. Claude Code 플러그인(`hooks/register.ts`) 하나로 끝낸다.

## 1. 범위

### 본체 (v0.1)
| 도구 | 역할 |
|---|---|
| `go_chat` | 한 번 요청, 도구 없음. `prompt`, `files`, `output_path`, `model`, `reasoning_effort` |
| `go_models` | 모델 목록과 모델별 월 한도, tools 지원 여부 |

- 상태줄: 세션 토큰 · 캐시 적중 · 5시간/주간 한도 %
- `/go-usage` 명령, `~/.config/opencode-go/disabled` 스위치
- GUIDE (Claude 시스템 프롬프트 섹션)

### 넣지 않는 것
- **batch**: Claude가 `go_chat`을 병렬로 부르면 된다.
- **agent / research**: 판단과 탐색은 Claude 몫. 웹 조사는 deepseek_research나 Claude의 WebSearch.
- **opencode v2 headless, Console Hosted Web Search(MCP)**: 외부 프로세스/서버 의존이라 컨셉과 맞지 않는다.

### 선택 기능 (v0.2, 실험): 읽기 전용 explore 서브에이전트
Haiku 대신 Go 모델(GLM 등)로 넓은 탐색을 시키는 서브에이전트. userConfig `explore_agent`로 켠다.
- `$.agent.register({ name: 'explore', tools: ['Read', 'Grep', 'Glob'], ... })` → 타입 `opencode-go-worker:explore`
- `turn.step` 훅에서 그 에이전트(`e.agentId`)의 스텝만 가로채 `next` 없이 직접 답한다
  ("An answer without `next` sends no request").
  - `$.session.messages({ agentId, as: 'api' })` → Anthropic Messages 형식 대화
  - system prompt는 등록한 것, tools는 `$.tool.list()`에서 이름으로 `inputSchema`를 찾아 붙인다
  - Go의 Anthropic 호환 엔드포인트로 보내고, SSE를 `text` / `tool` / `input` / `stop` 청크로 yield
- 도구 실행은 엔진이 한다 → Claude Code 권한 체계를 그대로 탄다. Claude는 언제 띄울지 정하고 결과를 검토한다.
- 내장 `Explore`를 바꿔치기(`agent.spawn`)하는 건 나중 옵션.

## 2. OpenCode Go API (1단계 스파이크로 확정, 상세는 [spike/FINDINGS.md](spike/FINDINGS.md))

- Base: `https://opencode.ai/inference/go`
  - **`go_chat`은 `POST /openai/v1/chat/completions` 하나만 쓴다.** messages 모델·responses 모델도 이 경로로 200 (교차 확인).
  - `/anthropic/v1/messages`도 모든 모델을 받는다 → v0.2 explore용.
- 모델 목록: `GET /inference/go/v1/models` — **인증 불필요**. `go.monthly_usage{go,go-plus,go-teams}`, `go.training/zdr`,
  `capabilities.reasoning.effort`(모델별 허용값), `limit`, `cost.multipliers`(일부 모델 평일 피크 2배), `recommended_api`
- 인증: Console 키 `oc_sk_...`, **`Authorization: Bearer`로 통일** (chat/completions는 x-api-key 거부, messages는 둘 다 허용)
- 필수/권장 헤더
  - `x-opencode-session`: 없으면 400 `MissingSessionID` (인증보다 먼저 검사). 프롬프트 캐시도 이 기준 (확인됨)
  - `User-Agent`: 자체 이름 (`opencode-go-worker/<version>`). 범용 SDK 이름 쓰지 말 것
- usage: `usage.opencode = { billing_source, list_cost, allowance, tokens{input,output,reasoning,cache_read,cache_write_5m,cache_write_1h} }`.
  최상위 `usage.cost`는 Go 한도 처리 시 0. `allowance` = list_cost × 모델 배수(USD). `tokens.input`은 캐시 제외분.
  스트림은 `stream_options.include_usage`로 마지막 청크에 실림. 추론은 `delta.reasoning_content` (저장 시 제외).
- 한도: 월 한도 기준 5시간 창 20%, 주간 50% (월요일 00:00 UTC 리셋). 초과 시 429 또는 Extra Usage(잔액 차감).
- 남은 한도: `GET https://opencode.ai/zen/go/v1/usage` (Bearer) → `usage.{rolling,weekly,monthly}.{status,percent,resetsAt}`.
  percent는 정수. 5시간 창은 첫 요청부터 시작. **비공식** (opencode PR #32913). 실패하면 상태줄에서 그 부분만 숨긴다.
- 약관: Claude Code 등 외부 클라이언트 사용 허용. 무료 모델은 OpenCode 전용(외부는 403). 남용 트래픽 모니터링.

출처: opencode.ai/docs/go, /docs/console/harnesses, /docs/console/api/inference, /docs/console/api/models

## 3. 설계 메모

- **비용 모델이 DeepSeek과 다르다.** 월정액이라 한도 안에서는 한계비용 ≈ 0.
  GUIDE: "출력이 길고 명세가 분명하며 검증 가능한 작업은 Go에 먼저 맡긴다. 5시간 창이 80%를 넘으면 DeepSeek 또는 직접 작성."
  deepseek-worker와 같이 설치됐을 때 두 GUIDE가 충돌하지 않게 우선순위를 한 줄로 둔다.
- **기본 모델은 코드에 박지 않는다.** 라인업이 자주 바뀐다 → userConfig `default_model`, 비면 `go_models`로 고르라고 안내.
- **429**: 에러에 리셋 시각을 넣어 Claude가 다른 경로로 갈 수 있게.
- **스트리밍**: `$.http.fetch`는 30초 제한 → curl 스트리밍(deepseek-worker의 `streamChat`) 재사용.
- **키**: userConfig(secure storage) → `~/.config/opencode-go/api_key`. 환경변수는 읽지 않음.
- **세션 ID**: Claude Code 세션 ID에서 파생해 `$.state`에 보관.

### deepseek-worker에서 가져올 것
`checkedPath`(파일 권한 체크), `DATA_ID` 펜스(자료와 지시 분리), `FENCE_RE`(코드펜스 벗겨 저장), `streamChat`, `saveOutput`,
언어 감지/UI 문자열, 상태줄 갱신, disabled 스위치, `usage.test.ts`의 구조.

## 4. 단계

1. ~~**스파이크 (curl)**~~ (완료): 실제 키로 chat/completions · messages 스트리밍, usage 필드, `/zen/go/v1/usage`, `/v1/models` 응답 확인. 헤더(인증, 세션) 확정.
2. ~~**v0.1 본체**~~ (완료): 키/설정 로딩, `go_chat`, `go_models`, 상태줄, `/go-usage`, GUIDE.
3. ~~**테스트 + README**~~ (영어/한국어, 완료)
4. ~~**v0.2 스파이크**~~ (완료, spike/FINDINGS.md C절): `turn.step`에서 `next` 없이 만든 응답이 transcript에 tool_use로 남고 실제 실행되는지. 막히면 explore 아이디어 폐기.
5. ~~**v0.2 explore 서브에이전트**~~ (구현, 실제 세션 확인 대기): thinking 블록 제거, 스키마 첨부, usage를 `stop` 청크로 보고.
6. (나중) deepseek-worker 정리: batch/agent 정리, explore 서브에이전트를 DeepSeek에도 적용 검토.

## 5. 리스크
- 비공식 usage 엔드포인트 변경 가능성
- 모델 라인업 변동
- explore: 훅이 만든 응답을 엔진이 받아들이는지, 비-Claude 모델의 Claude Code 도구 인자 품질, thinking 서명 문제
