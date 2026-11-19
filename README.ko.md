# claude-opencode-go-worker

[English](README.md) · **한국어**

Claude에게 월정액 워커 **[OpenCode Go](https://opencode.ai/docs/go)** 를 붙여 주는 Claude Code 플러그인이에요.

설계, 원인 분석, 검토 같은 판단은 계속 Claude가 맡아요. 길지만 명세가 분명한 작업(테스트 대량 작성, 보일러플레이트, 데이터 변환, 정해진 형식의 코드)은 OpenCode Go 모델에 넘겨요. Go는 월정액이라 한도 안에서는 호출해도 추가 비용이 없어요. 그래서 Claude는 이런 작업을 먼저 Go에 맡기고, 플랜의 5시간 창과 주간 창을 지켜봐요. 결과는 파일에 바로 쓸 수 있어서 Claude의 컨텍스트를 거의 차지하지 않아요.

**따로 설치할 것이 없어요.** 플러그인이 Claude Code 안에서 돌아가요. Python, Node, 별도 서버, OpenCode CLI 모두 필요 없어요.

```
나 ──▶ Claude (계획, 검토) ──▶ go_chat ──▶ OpenCode Go API
                ▲                  │
                └── 디스크의 파일 ◀──┘
```

## 들어 있는 것

| 구성 | 하는 일 |
| --- | --- |
| `go_chat` | 작업 하나를 맡겨요. `files`는 플러그인이 직접 읽어 프롬프트 앞에 붙이므로 Claude가 파일 내용을 인자로 복사하지 않아요. `output_path`를 주면 답을 그 파일에 바로 쓰고 경로와 줄 수만 돌려줘요. 결과 끝에는 사용량 줄과 한도 줄(5시간·주간·월간 창)이 붙어요. 서로 독립된 작업이 여러 개면 Claude가 병렬로 불러요. |
| `go_models` | Go 모델 목록이에요. 컨텍스트·출력 한도, 허용되는 `reasoning_effort` 값, 플랜별 월간 사용량, 플래그(추천 모델, 피크 시간 배수와 지금 적용 중인지, 제공자가 프롬프트를 보관하거나 학습에 쓸 수 있는지)를 보여 줘요. 무료 모델은 OpenCode 전용이라 뺐어요. |
| 상태줄 | `opencode-go-worker 5h 4%`. 플러그인이 로드됐다는 것과 플랜의 5시간 창을 얼마나 채웠는지만 보여 줘요(세션 시작 때와 호출할 때마다 확인하고, 읽지 못하면 `5h —`). 답을 쓰는 동안에는 `작성 중… 120줄`이 떠요. |
| `opencode-go-worker:explore` (실험, 기본 꺼짐) | Claude의 Agent 도구로 띄우는 읽기 전용 탐색 서브에이전트예요. 모델 호출만 Claude 대신 OpenCode Go로 가요. Claude Code의 Explore 에이전트를 월정액 플랜으로 돌린다고 보면 돼요. 파일을 읽고 읽기 전용 셸 명령(`ls`, `find`, `rg`, `git log` 등)을 실행해요. 도구는 엔진이 실행하므로 Claude Code 권한 확인을 그대로 거쳐요. 모델은 `/go-model`로 고른 것을 써요. `explore_agent` 옵션으로 켜요. 도는 동안에는 모델 바에 사용량 대신 진행 상황(`explore 3단계 · rg -n "session" hooks`)이 떠요. 결과는 Claude가 아닌 모델이 쓴 것이라, Claude가 중요한 사실은 직접 확인하도록 안내해요. |
| `opencode-go-worker:worker` (실험, 기본 꺼짐) | 명령으로 검증할 수 있는 작은 코딩 작업(실패하는 테스트 통과시키기, 명세가 분명한 몇 파일짜리 변경)을 OpenCode Go로 하는 서브에이전트예요. 파일을 읽고 고치고 쓰고 명령을 실행해요. 도구는 엔진이 실행하므로 Claude Code 권한 확인을 그대로 거쳐요. 커밋은 하지 않아요. Claude가 목표, 파일, 범위 밖인 것, 확인 명령을 주고, 끝나면 diff를 보고 확인 명령을 직접 다시 돌려요. `worker_agent` 옵션으로 켜요. |
| 모델 바 | 프롬프트 바로 위 한 줄이에요(터미널, 데스크톱 앱, VS Code): `Go 모델: [glm-5.3 ▾]  3회 · 12.4Ktok · 캐시 62% · $0.0012 · 5h 4% · 주 1%`. 드롭다운에서 고르면 `go_chat`이 바로 그 모델을 쓰고, `default_model`에도 저장돼요. 옆에는 이 세션의 호출 수, 토큰, 프롬프트 캐시 적중률, 쓴 한도와 플랜의 5시간·주간 창이 나와요. 5시간 창은 80%를 넘으면 노란색, 한도에 닿으면 빨간색이에요. 창이 좁으면 덜 중요한 것부터 빠지고 5시간 창은 끝까지 남아요. 설문이 그 자리를 쓰는 동안에는 비켜 줘요. |
| `/go-model` | Claude가 `model`을 비웠을 때 `go_chat`이 쓸 모델을 바꿔요. Claude의 `/model`과 같은 역할이에요. `/go-model glm-5.3`처럼 바로 정할 수도 있고, `/go-model`만 입력하면 여유가 큰 추천 모델을 대화상자로 보여 줘요(id를 직접 입력해도 돼요). 바로 적용되고, 새 세션을 위해 `default_model` 옵션에도 저장돼요. |
| `/go-usage` | 이 세션의 자세한 사용량(캐시된·캐시 안 된 입력, 출력, 추론, 쓴 월 한도)과 플랜 창별 리셋 시각이에요. 첫 호출 전에는 키가 맞는지 확인해 줘요(무료). |
| Claude용 안내 | 언제 맡기고 언제 직접 할지, 언제 Go를 그만 쓸지(5시간 창 80% 초과, 한도 에러), Go의 프롬프트 캐시를 살리는 법을 Claude의 시스템 프롬프트에 넣어요. |

워커가 파일을 쓸 때 중요한 안전장치예요.

- **긴 출력이 몰래 잘리지 않아요.** `output_path` 호출의 `max_tokens` 기본값은 모델 자체의 출력 한도예요. 그래도 잘리거나 스트림이 끊기면 `<output_path>.partial`에 저장하고 **원래 파일은 건드리지 않아요.** 결과에는 `[truncated]` 또는 `[interrupted]` 줄이 붙어요.
- **빈 답으로 파일을 덮어쓰지 않아요.**
- `reasoning_effort`는 보내기 전에 그 모델이 허용하는 값인지 확인해요. 비워 두면 모델 기본값을 써요.
- **플랜 밖 과금을 알려요.** 요청이 Go 한도가 아니라 잔액(Extra Usage)에서 빠져나가면 결과에 표시하고, Claude가 더 부르기 전에 확인하게 해요.
- **피크 시간을 알려요.** 일부 모델은 평일 피크 시간(UTC)에 한도를 몇 배로 써요. 해당되면 결과에 적어요.
- **파일 접근은 Claude Code 권한을 그대로 따라요.** `files`를 읽거나 `output_path`에 쓰기 전에, Claude 자신이 그 경로를 Read·Write할 수 있는지 Claude Code에 물어봐요. 작업 폴더, 세션 스크래치패드, `/add-dir`로 추가한 폴더처럼 Claude가 쓸 수 있는 곳은 다 돼요. deny 규칙으로 막은 파일(예: `Read(.env)`)은 절대 보내지 않아요. 링크는 링크 자신과 가리키는 파일을 둘 다 확인해요. Claude Code가 물어볼 경로는 작업 폴더 안일 때만 허용해요. 플러그인 옵션 `allow_outside_workdir`를 켜면 이 확인을 건너뛰어요.

## 보안 메모

- 플러그인 옵션으로 넣은 API 키는 OS 보안 저장소에 들어가요. `curl`에는 명령줄이 아니라 표준 입력으로 넘기므로 프로세스 목록에 보이지 않아요.
- 생성 요청은 `PATH`에서 먼저 잡히는 `curl`이 아니라 시스템 `curl`을 절대 경로(`/usr/bin/curl`, Windows는 `%SystemRoot%\System32\curl.exe`)로 불러요. Claude Code 내장 fetch의 30초 제한보다 오래 걸릴 수 있어 스트리밍으로 받아요. `curl`은 별도 프로세스라 Claude Code 자체 네트워크 정책을 거치지 않아요.
- 프롬프트와 `files`에 넣은 내용은 OpenCode를 거쳐 모델 제공자에게 가요. 일부 제공자는 프롬프트를 보관하거나 학습에 쓸 수 있고, `go_models`가 그런 모델을 표시해요(`trains-on-data`, `no-zdr`). 비밀이나 공유하면 안 되는 데이터는 넣지 마세요.
- **자료와 지시를 분리해요.** 모델이 읽는 파일은 플러그인이 로드될 때 만든 무작위 id로 `<data id="…">` 블록에 감싸고, 그 안의 내용은 지시가 아니라고 모델에 알려요. 파일은 id를 미리 알 수 없어서 블록 끝을 흉내 낼 수 없어요.
- 요청에는 플러그인 자체 `User-Agent`(`opencode-go-worker/<버전>`)와 Claude Code 세션 ID에서 만든 `x-opencode-session` 헤더가 붙어요. Go가 요구하는 헤더이고 프롬프트 캐시도 이 기준이에요.

### explore·worker 에이전트와 auto 모드의 안전 검토

auto 모드에서는 서브에이전트가 결과를 넘길 때 서버 쪽 안전 분류기가 그 작업을 검토해요. Go 에이전트의 단계는 플러그인이 답하고 Anthropic으로 보내지 않기 때문에 검토할 내용이 없고, Claude Code가 *서버 측 auto 모드 분류기가 이 서브에이전트의 작업을 검토하지 못했다*는 경고를 띄워요. 사실 그대로인 경고라 플러그인은 이걸 숨기지 않아요. 대신 에이전트의 모든 도구 호출은 Claude Code 권한 확인을 거치고, explore는 파일을 바꾸지 않으며, Claude는 결과의 근거를 확인하고 worker의 diff를 검토하도록 안내받아요.

같은 이유로 명령 실행에도 제약이 있어요. auto 모드에서는 명령을 실행해도 되는지도 이 분류기가 판단하는데, 본 적 없는 단계에는 판정을 주지 않아요. 그래서 Go 에이전트는 Claude Code가 스스로 통과시키는 단순한 읽기 전용 명령(`ls`, `rg`, `git status` 등)만 실행할 수 있어요. 파일 읽기와 수정은 되지만 `python3 -m unittest` 같은 확인 명령은 거절되고, 허용 규칙을 넣어도 마찬가지예요(직접 확인했어요). worker는 확인을 NOT RUN으로 보고하고 Claude가 대신 돌려요. 그래서 worker는 세션 모드와 상관없이 자기 권한 모드 `acceptEdits`로 등록돼요. 파일 수정은 그대로 진행되고, 명령은 분류기 대신 평소처럼 사용자에게 허용 여부를 묻거나("항상 허용"을 고르면 기억해요) 허용 규칙을 따라요. 예: `.claude/settings.local.json`에 `"permissions": { "allow": ["Bash(npm test *)"] }`. 사용자가 거절한 명령은 거절된 채로 돌아오고, worker는 확인을 NOT RUN으로 보고하며 Claude가 대신 돌려요. explore는 세션 모드를 그대로 따르므로 단순한 읽기 전용 명령만 실행해요.

## 필요한 것

- [Claude Code](https://claude.com/claude-code): 터미널, 데스크톱 앱의 Code 탭, IDE 확장 중 하나
- Go를 구독한 워크스페이스의 [OpenCode Console](https://opencode.ai) API 키(`oc_sk_…`)

Claude Code 플러그인 런타임을 쓰기 때문에 Claude 데스크톱 앱의 채팅 탭이나 claude.ai에서는 돌아가지 않아요.

## 설치

Claude Code 터미널 세션 프롬프트에서:

```
/plugin install opencode-go-worker --marketplace doongchoong/claude-opencode-go-worker
```

마켓플레이스를 추가할지 물으면 `y`, 그다음 범위를 고르세요(user 범위 = 모든 프로젝트). 플러그인이 **OpenCode Console API 키**를 물어보고 보안 저장소에 보관해요.

셸에서:

```bash
claude plugin install opencode-go-worker --marketplace doongchoong/claude-opencode-go-worker
```

`/plugin`이 동작하지 않는 데스크톱 앱에서는 프롬프트 옆 **+** → **Plugins** → **Add marketplace**에 `doongchoong/claude-opencode-go-worker` → **Add plugin** 순서로 하면 돼요.

플러그인 옵션이 비어 있으면 `~/.config/opencode-go/api_key`(Windows는 `%USERPROFILE%\.config\opencode-go\api_key`)에서 키를 읽어요. 본인만 읽을 수 있게 해 두세요(macOS/Linux는 `chmod 600`). 환경 변수에서는 키를 읽지 않아요.

## 쓰는 법

프롬프트 위 드롭다운이나 `/go-model`(또는 `/plugin`의 `default_model` 옵션)로 **기본 모델**을 정해 두세요. 모델 라인업이 자주 바뀌어서 플러그인이 대신 고르지 않아요. 정하지 않으면 Claude가 `go_models`를 보고 작업마다 골라요.

그다음은 Claude에게 말하면 돼요. 직접 쓰는 것보다 맡기는 게 나을 때는 Claude가 알아서 맡기고, 명시적으로 시킬 수도 있어요.

- "Go한테 `parser.py` 단위 테스트를 `tests/test_parser.py`에 쓰게 하고 돌려 봐."
- "이 변환 작업 12개 OpenCode Go에 병렬로 맡겨."
- "이건 glm-5.3, effort low로 Go에 맡겨."
- "이번 건 Go 쓰지 마."

돌아온 결과는 Claude가 검토해요(테스트 실행, 파일 일부 읽기). 두 번 다시 시켜도 안 되면 Claude가 직접 써요.

[DeepSeek 워커](https://github.com/doongchoong/claude-deepseek-worker)도 같이 깔려 있으면, 플랜에 여유가 있는 동안 한 번에 끝나는 작업은 Go를 먼저 써요. 5시간 창이 80%를 넘거나 Go가 한도 에러를 내면 DeepSeek에 맡기거나 직접 해요.

## 설정

| 플러그인 옵션 | 기본값 | |
| --- | --- | --- |
| `api_key` | — | Console 키, 보안 저장소에 보관 |
| `default_model` | — | Claude가 `model`을 비웠을 때 쓸 모델 id, `/go-model`이 바꿔요 |
| `allow_outside_workdir` | 꺼짐 | 파일 권한 확인을 건너뜀 |
| `explore_agent` | 꺼짐 | `opencode-go-worker:explore` 서브에이전트 등록 |
| `worker_agent` | 꺼짐 | `opencode-go-worker:worker` 서브에이전트 등록 |
| `language` | `auto` | 상태줄과 `/go-usage` 언어: `auto`, `en`, `ko` |

**언어:** `auto`는 `LC_ALL` / `LC_MESSAGES` / `LANG`, 그다음 macOS 시스템 언어를 따르고, 알 수 없으면 영어예요. 모델이 읽는 글은 모두 영어이고, 워커는 요청한 언어로 답하게 돼 있어요.

**잠시 끄기:** `/plugin disable opencode-go-worker` 하거나 `~/.config/opencode-go/disabled` 파일을 만드세요. 새 세션은 도구를 등록하지 않고, 이미 열린 세션은 "disabled"라고 답해요. 파일을 지우면 다시 켜져요.

## 한도와 비용

OpenCode Go는 월정액이고, 월 한도 위에 5시간 창과 주간 창이 따로 있어요. 넘으면 요청이 거절(HTTP 429)되거나, Extra Usage를 켜 두었다면 잔액에서 빠져나가요. 여기서 보여 주는 플랜 창은 **문서화되지 않은** 사용량 엔드포인트에서 가져와요. 그 엔드포인트가 응답하지 않으면 상태줄에서 그 부분만 빠지고 결과에는 `[limits: unknown]`이라고 나와요.

창 사용률은 정수 퍼센트라 작은 호출 몇 번으로는 안 움직일 수 있어요. `/go-usage`는 각 응답에서 받은 값을 더해 이 세션이 쓴 한도도 따로 보여 줘요.

## 구조

```
.claude-plugin/plugin.json       플러그인 매니페스트와 옵션
.claude-plugin/marketplace.json  /plugin install로 이 저장소를 설치하게 해 줌
hooks/register.tsx               도구, Claude용 안내, 상태줄, 모델 드롭다운, /go-model, /go-usage
hooks/go.test.ts                 API·파일·환경을 흉내 낸 테스트 (claude plugin test .)
types/index.d.ts                 플러그인 상태의 모양(사용량, 한도, 언어)
spike/                           API 스파이크(spike.sh)와 결과(FINDINGS.md)
```

**변경을 배포할 때:** 푸시할 때마다 `.claude-plugin/plugin.json`의 `version`을 올리세요. 설치본은 버전별로 캐시돼요.

## 라이선스

[MIT](LICENSE)
