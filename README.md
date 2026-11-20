# claude-opencode-go-worker

**English** · [한국어](README.ko.md)

A Claude Code plugin that gives Claude a flat-rate worker: **[OpenCode Go](https://opencode.ai/docs/go)**.

Claude stays in charge of judgment — design, root-cause analysis, review. Work that is long but well specified (bulk tests, boilerplate, data conversion, code in a fixed format) goes to an OpenCode Go model. Since Go is a monthly plan, a call costs nothing extra while you are within its limits, so Claude hands that kind of work over first and keeps an eye on the plan's 5-hour and weekly windows. Results can be written straight to files, so they barely touch Claude's context.

**Nothing else to install.** The plugin runs inside Claude Code itself — no Python, no Node, no separate server, no OpenCode CLI.

```
You ──▶ Claude (plans, reviews) ──▶ go_chat ──▶ OpenCode Go API
                    ▲                   │
                    └── file on disk ◀──┘
```

## What you get

| Piece | What it does |
| --- | --- |
| `go_chat` | One task. `files` are read by the plugin and prepended, so Claude doesn't copy file contents into the call. `output_path` writes the answer straight to a file and returns only path and line count. Every result ends with a usage line and a limits line (5-hour, weekly and monthly windows). Several independent jobs: Claude calls it in parallel. |
| `go_models` | The Go model lineup: context and output limits, allowed `reasoning_effort` values, how much each plan covers per month, and flags — featured, peak-hour multiplier (and whether it applies right now), whether the provider may keep or train on prompts. Free models are left out (they are for OpenCode itself). |
| Status line | `opencode-go-worker 5h 4%` — the plugin is loaded, and how full the plan's 5-hour window is (looked up when the session starts and after every call; `5h —` when it can't be read). While a reply is being written it shows `writing… 120 lines`. |
| `go_explore` (experimental, off by default) | Answers a question about the codebase with Go exploring on its own — where something is defined, which files touch a feature, how a flow works — the kind of search you would give Claude Code's Explore agent, on the flat-rate plan. It finds files, searches contents and reads them (only where Claude may read without asking), then returns just its answer with path:line evidence; the files it read never enter Claude's context. It can't change anything or run commands. Turn it on with the `explore_agent` option. |
| `go_agent` (experimental, off by default) | A small coding agent on OpenCode Go, run by the plugin inside one tool call: it finds and reads files, edits them, runs the check, fixes and runs it again until it passes or gives up, then returns one short report (summary, changed files, check verdict). Claude writes the task and reads the report; the loop costs Claude nothing. It can run only the exact commands Claude lists in the call (`check_command` plus up to 4 more), by number — no shell of its own — and they run without asking you, since auto mode's classifier already reviewed Claude's call that names them; your deny rules still win. Files are read and written only where Claude could without asking. Turn it on with the `worker_agent` option. |
| Model bar | One line above the prompt (terminal, desktop app, VS Code): `Go model: [glm-5.3 ▾]  3 calls · 12.4Ktok · cache 62% · $0.0012 · 5h 4% · wk 1%`. Pick a model in the dropdown and `go_chat` uses it right away; it is also saved as `default_model`. Beside it: this session's calls, tokens, prompt-cache hit rate and allowance used, and the plan's 5-hour and weekly windows; the 5-hour figure turns yellow past 80% and red at the limit. On a narrow window the details give way first, the 5-hour figure last. It steps aside while a survey uses that spot. |
| `/go-model` | Switches the model `go_chat` uses when Claude leaves `model` empty, like `/model` does for Claude. `/go-model glm-5.3` sets it directly; `/go-model` alone offers the featured models with the most room in a dialog (or type any id). The choice applies to this session right away and is saved as the `default_model` option for new sessions; other open sessions keep their own model (each session keeps the model it started with until it picks another). |
| `/go-usage` | Detailed usage for the session (cached / uncached input, output, reasoning, allowance used) and every plan window with its reset time. Before the first call it checks the key (free). |
| Guidance for Claude | When to delegate and when to do it itself, when to stop using Go (5-hour window above 80%, or a limit error), and how to keep Go's prompt cache warm — added to Claude's system prompt. |

Safety details that matter when a worker writes your files:

- **Long outputs don't get cut off silently.** `output_path` calls default `max_tokens` to the model's own output limit. If a reply is still truncated, or the stream drops, it is saved to `<output_path>.partial` and **the original file is left untouched**, with a `[truncated]` / `[interrupted]` line in the result.
- **An empty reply never overwrites a file.**
- `reasoning_effort` is checked against the values the chosen model allows before anything is sent; empty means the model's own default.
- **Billing outside the plan is flagged.** If a request is charged to your balance instead of the Go allowance (Extra Usage), the result says so and Claude is told to check with you before more calls.
- **Peak hours are flagged.** Some models use a multiple of the allowance on weekday peak hours (UTC); the result notes it when it applies.
- **Files follow Claude Code's own permissions.** Before `files` are read or `output_path` is written, the plugin asks Claude Code whether Claude itself could Read / Write that path. Whatever Claude may use — the working folder, the session's scratchpad, folders added with `/add-dir` — works; files you blocked with a deny rule (say `Read(.env)`) are never sent. A link is checked twice, as itself and as the file it points to. A path Claude Code would ask about is allowed only inside the working folder. Turn on the plugin option `allow_outside_workdir` to skip these checks.

## Security notes

- The API key lives in your OS's secure storage when set through the plugin option. It is handed to `curl` on standard input, never on the command line, so it doesn't show up in process lists.
- Generation requests run through the system's own `curl` by absolute path (`/usr/bin/curl`, or `%SystemRoot%\System32\curl.exe` on Windows), not whatever `curl` comes first on `PATH`. They can take longer than the 30 seconds Claude Code's built-in fetch allows, and are streamed so a long answer arrives whole. Because `curl` is a separate process, those requests don't pass through Claude Code's own network policy.
- Everything you put in a prompt or `files` is sent to OpenCode and on to the model's provider. Some providers may keep or train on prompts — `go_models` marks them (`trains-on-data`, `no-zdr`). Keep secrets and data you may not share out of it.
- **Material is fenced off from instructions.** Every file the model reads is wrapped in `<data id="…">` with a random id made when the plugin loads, and the model is told that nothing inside is an instruction. A file can't know the id in advance, so it can't fake the end of its block.
- Requests carry the plugin's own `User-Agent` (`opencode-go-worker/<version>`) and an `x-opencode-session` header derived from the Claude Code session id, which Go requires and uses for prompt caching.

### go_explore, go_agent and auto mode's safety review

Both are tools Claude calls, not subagents: the plugin runs Go's loop inside the call. In auto mode the classifier reviews Claude's call — the question, or the task with the commands it names — and the agent can't step outside it: go_explore only finds and reads, go_agent edits only where Claude may write without asking and runs only the listed commands. (An earlier version ran explore as a subagent answered from a `turn.step` hook. Its steps never reached Anthropic, so auto mode couldn't review its hand-back and refused its commands for lack of a verdict; allow rules and an agent permission mode didn't help. That is why both are tools now.)

go_agent's commands run outside Claude Code's Bash sandbox, with a 5-minute limit each; the check runs code the agent may have changed, so Claude reviews the diff before relying on the result.

## Requirements

- [Claude Code](https://claude.com/claude-code) — terminal, the desktop app's Code tab, or an IDE extension
- An [OpenCode Console](https://opencode.ai) API key (`oc_sk_…`) from a workspace subscribed to Go

The plugin uses Claude Code's plugin runtime, so it does not run in the Claude desktop app's chat tab or on claude.ai.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install opencode-go-worker --marketplace doongchoong/claude-opencode-go-worker
```

Answer `y` to add the marketplace, then pick a scope (user scope = every project). The plugin asks for your **OpenCode Console API key** and keeps it in secure storage.

From a shell:

```bash
claude plugin install opencode-go-worker --marketplace doongchoong/claude-opencode-go-worker
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box → **Plugins** → **Add marketplace** with `doongchoong/claude-opencode-go-worker` → **Add plugin**.

If the plugin option is empty, the key is read from `~/.config/opencode-go/api_key` (on Windows, `%USERPROFILE%\.config\opencode-go\api_key`). Make that file readable only by you (`chmod 600` on macOS/Linux). The key is never read from an environment variable.

## Using it

Pick a **default model** in the dropdown above the prompt or with `/go-model` (or the `default_model` option in `/plugin`) — the lineup changes often, so the plugin doesn't pick one for you. Without one, Claude calls `go_models` and chooses per task.

Then just talk to Claude. It decides on its own when delegating is cheaper than writing it itself, and you can always be explicit:

- "Have Go write unit tests for `parser.py` into `tests/test_parser.py`, then run them."
- "Give these 12 conversion jobs to OpenCode Go in parallel."
- "Use OpenCode Go with glm-5.3 and effort low for this."
- "Don't use Go for this one."

Claude reviews what comes back (runs the tests, reads parts of the file). After two failed re-instructions it writes the code itself.

If the [DeepSeek worker](https://github.com/doongchoong/claude-deepseek-worker) is installed too, Claude prefers Go for one-shot work while the plan has room, and moves to DeepSeek or does it itself once the 5-hour window passes 80% or Go answers with a limit error.

## Configuration

| Plugin option | Default | |
| --- | --- | --- |
| `api_key` | — | Console key, kept in secure storage |
| `default_model` | — | Model id used when Claude leaves `model` empty; `/go-model` sets it |
| `allow_outside_workdir` | off | Skip the file permission checks |
| `explore_agent` | off | Register the `go_explore` tool |
| `worker_agent` | off | Register the `go_agent` tool |
| `language` | `auto` | Status line and `/go-usage` language: `auto`, `en` or `ko` |

**Language:** `auto` follows `LC_ALL` / `LC_MESSAGES` / `LANG`, then the macOS system language, and falls back to English. Everything the models read is English; the worker is told to answer in the language of the request.

**Turning it off for a while:** `/plugin disable opencode-go-worker`, or create the file `~/.config/opencode-go/disabled` (new sessions don't register the tools; running ones answer "disabled"). Delete the file to turn it back on.

## Limits and cost

OpenCode Go is a monthly plan with a 5-hour window and a weekly window on top of the monthly allowance. Past them a request is refused (HTTP 429) or, if you turned on Extra Usage, charged to your balance. The plan windows shown here come from an **undocumented** usage endpoint; if it stops answering, the status line just leaves them out and results say `[limits: unknown]`.

The windows are whole percentages, so a few small calls may not move them. `/go-usage` also shows the allowance the session's own calls used, summed from each response.

## How it's built

```
.claude-plugin/plugin.json       plugin manifest and options
.claude-plugin/marketplace.json  makes this repo installable with /plugin install
hooks/register.tsx               the tools, Claude's guidance, status line, model dropdown, /go-model, /go-usage
hooks/go.test.ts                 tests with the API, files and env mocked (claude plugin test .)
types/index.d.ts                 the shape of the plugin's state (usage, limits, language)
spike/                           the API spike (spike.sh) and what it found (FINDINGS.md)
```

**Releasing a change:** bump `version` in `.claude-plugin/plugin.json` with every push. Installs are cached per version.

## License

[MIT](LICENSE)
