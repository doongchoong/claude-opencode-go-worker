import { expect, test } from 'claude-code/testing'

const CHAT = 'mcp__opencode-go-worker__go_chat'
const MODELS = 'mcp__opencode-go-worker__go_models'

type Reply = { content: string; finish?: string; usage?: Record<string, unknown>; status?: number; error?: string; cut?: boolean; streamError?: unknown; thinking?: number; idle?: 'before' | 'after' }

type WorldOptions = {
  // runs mid-stream, after the reasoning chunks and before any text (to look at the band then)
  midStream?: () => Promise<void>
  disabled?: boolean
  keyFile?: boolean
  limitsStatus?: number
  rolling?: number
  // the 5-hour percent the usage endpoint gives on each lookup, in order (then `rolling`)
  rollingSeq?: number[]
  files?: Record<string, string>
  env?: Record<string, string>
  // The answer in the question dialog (undefined = dismissed)
  answer?: string
  // explore: what Go's Anthropic endpoint streams per step, and the agent's conversation
  steps?: ExploreStep[]
  agentMessages?: unknown[]
  agentSteps?: AgentStep[]
  // what a command prints and its exit code (default: exit 0, "ok")
  run?: (command: string) => { stdout?: string; stderr?: string; exitCode?: number }
  // Claude Code's permission rules for a shell command (default: ask)
  bashRule?: (command: string) => 'allow' | 'deny' | 'ask'
  // the console Go page's HTML (undefined: the page answers 404)
  consoleHtml?: string
  // macOS languages: what `defaults read com.anthropic.claudefordesktop AppleLanguages` and
  // `defaults read -g AppleLanguages` print; when either is set, /usr/bin/defaults exists
  appLanguages?: string
  systemLanguages?: string
  // awaited before each command runs (to look at the band mid-run)
  onRun?: () => Promise<void>
}

// go_agent: Go's message per turn (non-streaming requests), in order: tool calls and/or text
type AgentStep = { calls?: [string, Record<string, unknown>][]; content?: string; status?: number }

type ExploreStep = { text?: string; tool?: { id: string; name: string; input: unknown }; thinking?: string; status?: number; error?: string; streamError?: unknown }

const MODEL_LIST = {
  object: 'list',
  data: [
    {
      id: 'glm-5.3-flash',
      name: 'GLM-5.3-Flash',
      family: 'glm-flash',
      capabilities: { tools: { supported: true }, reasoning: { supported: true, effort: ['low', 'high', 'max'] } },
      limit: { context: 1000000, output: 131072 },
      cost: { text: { input: { price: 0.15 }, output: { price: 0.5 } } },
      go: { monthly_usage: { go: 60, 'go-plus': 180, 'go-teams': 65 }, training: false, zdr: true, featured: true },
    },
    {
      id: 'deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash 1017',
      family: 'deepseek-flash',
      capabilities: { tools: { supported: true }, reasoning: { supported: true, effort: ['low', 'high', 'max'] } },
      limit: { context: 1000000, output: 384000 },
      cost: {
        multipliers: [{ when: { utc_days: { in: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] } }, factor: 2 }],
      },
      go: { monthly_usage: { go: 100, 'go-plus': 200 }, featured: true },
    },
    {
      id: 'kimi-k2.7-code',
      name: 'Kimi K2.7 Code',
      capabilities: { tools: { supported: true } },
      limit: { context: 262144, output: 262144 },
      go: { monthly_usage: { go: 60, 'go-plus': 180 }, training: true, zdr: false },
    },
    { id: 'beam-free', capabilities: {}, go: { monthly_usage: null } },
  ],
}

const OC_USAGE = {
  prompt_tokens: 4015,
  completion_tokens: 3,
  prompt_tokens_details: { cached_tokens: 3264 },
  cost: 0,
  opencode: {
    billing_source: 'go',
    list_cost: 0.00021207,
    allowance: 0.00021207,
    tokens: { input: 751, output: 3, reasoning: 0, cache_read: 3264, cache_write_5m: 0, cache_write_1h: 0 },
  },
}

function world(on: any, replies: Reply[], opts: WorldOptions = {}) {
  const sent: any[] = []
  const configs: string[] = []
  const argvs: string[][] = []
  const fetched: { url: string; headers: Record<string, string> }[] = []
  const statuses: (string | undefined)[] = []
  const written: Record<string, string> = {}
  const files: Record<string, string> = { ...opts.files }
  let limitsLookups = 0

  const commands: string[] = []
  const agents: any[] = []
  const exploreBodies: any[] = []
  const agentRequests: any[] = []
  on('agent.register', (_: unknown, e: any) => {
    agents.push(e)
    return { value: { agent: `opencode-go-worker:${e.name}` } }
  })
  on('agent.list', () => ({
    value: [
      { id: 'ag-explore', type: 'opencode-go-worker:explore', description: 'x', status: 'running' },
      { id: 'ag-other', type: 'Explore', description: 'y', status: 'running' },
      { id: 'ag-worker', type: 'opencode-go-worker:worker', description: 'z', status: 'running' },
    ],
  }))
  on('session.messages', () => ({
    value: opts.agentMessages ?? [
      { role: 'user', content: [{ type: 'text', text: 'Where is DATA_ID defined?' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret', signature: 'sig' }, { type: 'text', text: 'Looking.' }] },
    ],
  }))
  const configSets: { key: string; value: unknown }[] = []
  const questions: { question: string; options: string[] }[] = []
  on('command.register', (_: unknown, e: any) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('config.set', (_: unknown, e: any) => {
    configSets.push({ key: e.key, value: e.value })
    return { value: e.value }
  })
  on('tool.call', (_: unknown, e: any, next: any) => {
    if (e.tool !== 'AskUserQuestion') return next(e)
    const q = e.questions[0]
    questions.push({ question: q.question, options: (q.options ?? []).map((o: any) => o.label ?? o) })
    if (opts.answer === undefined) return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers: { [q.question]: opts.answer } }, text: `answered ${opts.answer}` }
  })
  const registered: string[] = []
  on('tool.register', (_: unknown, e: any) => {
    registered.push(e.name)
    return { value: { tool: `mcp__opencode-go-worker__${e.name}` } }
  })
  const logs: string[] = []
  on('ui.log', (_: unknown, e: any) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  // which session the calls come from; a test may switch it to act as another session of the same app
  const session = { id: 'sess-1' }
  on('session.id', () => ({ value: session.id }))
  on('ui.status', (_: unknown, e: any) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('env.get', (_: unknown, e: any) => ({
    // OPENCODE_API_KEY is set, but the plugin must never read it
    value: ({ HOME: '/home/u', OPENCODE_API_KEY: 'env-key', LANG: 'en_US.UTF-8', ...opts.env } as Record<string, string>)[e.name],
  }))
  const disk = new Set(['/', '/work', '/work/a.py', '/work/.env', '/tmp', '/usr/bin/curl'])
  if (opts.keyFile !== false) disk.add('/home/u/.config/opencode-go/api_key')
  if (opts.appLanguages !== undefined || opts.systemLanguages !== undefined) disk.add('/usr/bin/defaults')
  on('session.cwd', () => ({ value: '/work' }))
  const bashChecks: string[] = []
  on('tool.check', (_: unknown, e: any) => {
    if (e.tool === 'Bash') {
      bashChecks.push(e.input.command)
      const d = opts.bashRule?.(e.input.command) ?? 'ask'
      return d === 'deny' ? { decision: 'deny', reason: 'rule Bash(rm:*)' } : { decision: d }
    }
    // Only file reads and writes are judged here; the question dialog is allowed
    if (e.tool !== 'Read' && e.tool !== 'Write') return { decision: 'allow' }
    const path: string = e.input.file_path ?? ''
    if (path.endsWith('/.env')) return { decision: 'deny', reason: 'rule Read(.env)' }
    if (e.tool === 'Read' && path.startsWith('/work/')) return { decision: 'allow' }
    return { decision: 'ask' }
  })
  on('fs.exists', (_: unknown, e: any) => ({
    value: disk.has(e.path) || e.path in files || (!!opts.disabled && e.path.endsWith('/disabled')),
  }))
  on('fs.stat', (_: unknown, e: any) =>
    disk.has(e.path) || e.path in files ? { value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } } : { deny: 'ENOENT' },
  )
  const runs: { argv: string[]; cwd?: string }[] = []
  on('process.run', async (_: unknown, e: any) => {
    await opts.onRun?.()
    runs.push({ argv: e.argv, cwd: e.cwd ?? e.init?.cwd })
    const r = opts.run?.(e.argv[2]) ?? {}
    return { value: { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? 'ok', stderr: r.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.list', (_: unknown, e: any) => {
    const dir = String(e.path).replace(/\/$/, '')
    const all = [...disk, ...Object.keys(files)]
    const names = new Set(all.filter(p => p.startsWith(`${dir}/`)).map(p => p.slice(dir.length + 1).split('/')[0]!))
    const value = [...names].map(name => {
      const path = `${dir}/${name}`
      const isDir = all.some(p => p.startsWith(`${path}/`))
      return { name, kind: isDir ? 'dir' : 'file', size: (files[path] ?? '').length, mtimeMs: 0, isLink: false }
    })
    return { value }
  })
  on('fs.read', (_: unknown, e: any) => ({
    value: e.path === '/home/u/.config/opencode-go/api_key' ? 'oc_sk_test\n' : (files[e.path] ?? 'FILE BODY'),
  }))
  on('fs.write', (_: unknown, e: any) => {
    files[e.path] = e.text
    written[e.path.split('/').pop()] = e.text
    return { value: undefined }
  })
  on('http.fetch', (_: unknown, e: any) => {
    fetched.push({ url: e.url, headers: e.headers ?? {} })
    if (e.url === 'https://opencode.ai/console/go') {
      return opts.consoleHtml === undefined
        ? { value: { status: 404, ok: false, headers: {}, text: 'not found' } }
        : { value: { status: 200, ok: true, headers: {}, text: opts.consoleHtml } }
    }
    if (e.url.endsWith('/inference/go/v1/models')) return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(MODEL_LIST) } }
    if (e.url.endsWith('/zen/go/v1/usage')) {
      const s = opts.limitsStatus ?? 200
      if (s !== 200) return { value: { status: s, ok: false, headers: {}, text: '{"type":"error","error":{"type":"AuthError"}}' } }
      const w = (percent: number, resetsAt: string) => ({ status: 'ok', percent, resetsAt })
      const v = {
        usage: {
          rolling: w(opts.rollingSeq?.[limitsLookups++] ?? opts.rolling ?? 4, '2026-11-19T21:10:37.000Z'),
          weekly: w(1, '2026-11-23T00:00:00.000Z'),
          monthly: w(0, '2026-12-19T16:01:58.000Z'),
        },
      }
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(v) } }
    }
    return { value: { status: 404, ok: false, headers: {}, text: 'not found' } }
  })
  // Generation goes through curl: read the body from the config on stdin and answer in SSE, then the status mark
  on('process.spawn', async function* (_: unknown, e: any) {
    if (e.argv[0] === '/usr/bin/defaults') {
      const out = e.argv[2] === '-g' ? opts.systemLanguages : opts.appLanguages
      if (out === undefined) {
        yield { stream: 'stderr', text: 'Domain does not exist' }
        return { value: { code: 1, signal: null } }
      }
      yield { stream: 'stdout', text: out }
      return { value: { code: 0, signal: null } }
    }
    if (e.argv[0] !== '/usr/bin/curl') return { value: { code: 1, signal: null } }
    configs.push(e.input)
    argvs.push(e.argv)
    if (e.input.includes('anthropic/v1/messages')) {
      const line = e.input.split('\n').find((l: string) => l.startsWith('data-binary = '))
      exploreBodies.push(JSON.parse(JSON.parse(line.slice('data-binary = '.length))))
      const st = (opts.steps ?? [{ text: 'done' }])[exploreBodies.length - 1] ?? { text: 'done' }
      if (st.status && st.status >= 400) {
        yield { stream: 'stdout', text: `${st.error ?? '{"type":"error"}'}\n[[go-worker-http ${st.status}]]` }
        return { value: { code: 0, signal: null } }
      }
      const ev = (x: unknown) => `event: x\ndata: ${JSON.stringify(x)}\n\n`
      let out = ev({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } })
      if (st.streamError) {
        yield { stream: 'stdout', text: out + ev({ type: 'error', error: st.streamError }) + '\n[[go-worker-http 200]]' }
        return { value: { code: 0, signal: null } }
      }
      let i = 0
      if (st.thinking) {
        out += ev({ type: 'content_block_start', index: i, content_block: { type: 'thinking', thinking: '' } })
        out += ev({ type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: st.thinking } })
        i++
      }
      if (st.text) {
        out += ev({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } })
        out += ev({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: st.text } })
        i++
      }
      if (st.tool) {
        out += ev({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: st.tool.id, name: st.tool.name, input: {} } })
        const json = JSON.stringify(st.tool.input)
        out += ev({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: json.slice(0, 5) } })
        out += ev({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: json.slice(5) } })
      }
      const usage = { input_tokens: 400, output_tokens: 30, cache_read_input_tokens: 100, opencode: { billing_source: 'go', allowance: 0.0001, tokens: { input: 300, output: 30, reasoning: 0, cache_read: 100, cache_write_5m: 0, cache_write_1h: 0 } } }
      out += ev({ type: 'message_delta', delta: { stop_reason: st.tool ? 'tool_use' : 'end_turn' }, usage })
      out += ev({ type: 'message_stop' }) + '\n[[go-worker-http 200]]'
      yield { stream: 'stdout', text: out }
      return { value: { code: 0, signal: null } }
    }
    const line = e.input.split('\n').find((l: string) => l.startsWith('data-binary = '))
    const body = JSON.parse(JSON.parse(line.slice('data-binary = '.length)))
    if (!body.stream) {
      agentRequests.push(body)
      const st = opts.agentSteps?.[agentRequests.length - 1] ?? { content: 'all done' }
      if (st.status && st.status >= 400) {
        yield { stream: 'stdout', text: `{"error":{"message":"limit"}}\n[[go-worker-http ${st.status}]]` }
        return { value: { code: 0, signal: null } }
      }
      const tool_calls = st.calls?.map(([name, args], i) => ({ id: `c${agentRequests.length}-${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }))
      const message = { role: 'assistant', content: st.content ?? '', ...(tool_calls ? { tool_calls } : {}) }
      const usage = { prompt_tokens: 100, completion_tokens: 20, opencode: { billing_source: 'go', allowance: 0.0001, tokens: { input: 80, output: 20, reasoning: 0, cache_read: 20, cache_write_5m: 0, cache_write_1h: 0 } } }
      yield { stream: 'stdout', text: JSON.stringify({ model: body.model, choices: [{ message }], usage }) + '\n[[go-worker-http 200]]' }
      return { value: { code: 0, signal: null } }
    }
    sent.push(body)
    const r = replies[(sent.length - 1) % replies.length]!
    if (r.status && r.status >= 400) {
      yield { stream: 'stdout', text: `${r.error ?? '{"error":{"message":"rate limited"}}'}\n[[go-worker-http ${r.status}]]` }
      return { value: { code: 0, signal: null } }
    }
    const chunk = (x: unknown) => `data: ${JSON.stringify(x)}\n\n`
    if (r.streamError) {
      yield { stream: 'stdout', text: chunk({ error: r.streamError }) + '\n[[go-worker-http 200]]' }
      return { value: { code: 0, signal: null } }
    }
    if (r.idle === 'before') {
      yield { stream: 'stderr', text: 'curl: (28) Operation too slow. Less than 1 bytes/sec transferred the last 300 seconds' }
      return { value: { code: 28, signal: null } }
    }
    const half = Math.ceil(r.content.length / 2)
    yield { stream: 'stdout', text: chunk({ model: body.model, choices: [{ delta: { reasoning_content: 'SECRET THOUGHTS' } }] }) }
    for (let i = 1; i < (r.thinking ?? 0); i++) yield { stream: 'stdout', text: chunk({ model: body.model, choices: [{ delta: { reasoning_content: 'x' } }] }) }
    if (opts.midStream) await opts.midStream()
    for (const piece of [r.content.slice(0, half), r.content.slice(half)]) {
      yield { stream: 'stdout', text: chunk({ model: body.model, choices: [{ delta: { content: piece } }] }) }
    }
    if (r.idle === 'after') {
      yield { stream: 'stderr', text: 'curl: (28) Operation too slow. Less than 1 bytes/sec transferred the last 300 seconds' }
      yield { stream: 'stdout', text: '\n[[go-worker-http 200]]' }
      return { value: { code: 28, signal: null } }
    }
    if (r.cut) {
      // The connection drops: no finish marker, no usage
      yield { stream: 'stderr', text: 'curl: (18) transfer closed with outstanding read data remaining' }
      yield { stream: 'stdout', text: '\n[[go-worker-http 200]]' }
      return { value: { code: 18, signal: null } }
    }
    yield {
      stream: 'stdout',
      text:
        chunk({ model: body.model, choices: [{ delta: {}, finish_reason: r.finish ?? 'stop' }] }) +
        chunk({ model: body.model, choices: [], usage: r.usage ?? OC_USAGE }) +
        'data: [DONE]\n\n\n[[go-worker-http 200]]',
    }
    return { value: { code: 0, signal: null } }
  })
  return { sent, configs, argvs, fetched, statuses, written, files, commands, configSets, questions, agents, exploreBodies, agentRequests, runs, bashChecks, registered, logs, session }
}

const start = ($: any) => $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
const text = (r: any) => String(r.result)
const refusal = (r: any) => String(r.deny ?? r.text)
const goUsage = async ($: any) => (await $.command.run({ command: 'go-usage', args: '' } as any)).text as string

test('chat: Bearer, session header and our User-Agent; reasoning dropped; usage and limits in result and status line', async ($, on) => {
  const w = world(on, [{ content: 'pong' }])
  await start($)
  const r = await ($.tool.call as any)({ tool: CHAT, prompt: 'ping', model: 'glm-5.3-flash' })

  const cfg = w.configs[0]!
  expect(cfg).toContain('url = "https://opencode.ai/inference/go/openai/v1/chat/completions"')
  expect(cfg).toContain('header = "Authorization: Bearer oc_sk_test"')
  expect(cfg).toContain('header = "x-opencode-session: ccgo-sess-1"')
  expect(cfg).toContain('user-agent = "opencode-go-worker/')
  expect(cfg).not.toContain('env-key')
  expect(w.sent[0].stream).toBe(true)
  expect(w.sent[0].stream_options).toEqual({ include_usage: true })
  expect(w.sent[0].reasoning_effort).toBeUndefined()
  expect(w.sent[0].max_tokens).toBeUndefined()
  expect(w.sent[0].messages[0].content).toContain('higher-level agent (Claude)')
  expect(text(r)).not.toContain('SECRET THOUGHTS')
  expect(text(r)).toContain('pong\n\n[usage: glm-5.3-flash, in=751 cache_read=3264 out=3 reasoning=0 allowance=$0.000212]')
  expect(text(r)).toContain('[limits: 5h 4% (resets 2026-11-19 21:10 UTC) · week 1% (resets 2026-11-23 00:00 UTC) · month 0%')
  expect(w.statuses.at(-1)).toBe('5h 4%')
})

test('chat: with no model and no default_model, Claude is asked to pick one', async ($, on) => {
  const w = world(on, [{ content: 'x' }])
  await start($)
  const r: any = await ($.tool.call as any)({ tool: CHAT, prompt: 'x' })
  expect(refusal(r)).toContain('Call go_models')
  expect(w.sent.length).toBe(0)
})

test('chat: reasoning_effort is checked per model; unknown and free models are refused before any request', async ($, on) => {
  const w = world(on, [{ content: 'x' }])
  await start($)
  const bad: any = await ($.tool.call as any)({ tool: CHAT, prompt: 'x', model: 'glm-5.3-flash', reasoning_effort: 'medium' })
  const none: any = await ($.tool.call as any)({ tool: CHAT, prompt: 'x', model: 'kimi-k2.7-code', reasoning_effort: 'low' })
  const unknown: any = await ($.tool.call as any)({ tool: CHAT, prompt: 'x', model: 'nope' })
  const free: any = await ($.tool.call as any)({ tool: CHAT, prompt: 'x', model: 'beam-free' })
  const ok = await ($.tool.call as any)({ tool: CHAT, prompt: 'x', model: 'glm-5.3-flash', reasoning_effort: 'low' })

  expect(refusal(bad)).toContain('must be one of low, high, max')
  expect(refusal(none)).toContain('takes no reasoning_effort')
  expect(refusal(unknown)).toContain('Unknown model "nope"')
  expect(refusal(unknown)).not.toContain('beam-free')
  expect(refusal(free)).toContain('free model')
  expect(w.sent.length).toBe(1)
  expect(w.sent[0].reasoning_effort).toBe('low')
  expect(text(ok)).toContain('[usage:')
})

test('chat: files are fenced before the prompt; output_path strips the fence and caps max_tokens at the model limit', async ($, on) => {
  const w = world(on, [{ content: '```python\nprint(1)\n```' }])
  await start($)
  const r = await ($.tool.call as any)({ tool: CHAT, prompt: 'write it', files: ['a.py'], output_path: 'out.py', model: 'glm-5.3-flash' })

  expect(w.sent[0].max_tokens).toBe(131072)
  expect(w.sent[0].messages[1].content).toMatch(/^<data id="\w{12}" source="file a.py">\nFILE BODY\n<\/data id="\w{12}">/)
  expect(w.written['out.py']).toBe('print(1)\n')
  expect(text(r)).toContain('saved: /work/out.py (1 lines')
})

test('chat: a deny-ruled file is never sent', async ($, on) => {
  const w = world(on, [{ content: 'x' }])
  await start($)
  const r: any = await ($.tool.call as any)({ tool: CHAT, prompt: 'x', files: ['.env'], model: 'glm-5.3-flash' })
  expect(refusal(r)).toContain("Claude Code's permission settings block it")
  expect(w.sent.length).toBe(0)
})

test('chat: a truncated reply goes to .partial and keeps the original file', async ($, on) => {
  const w = world(on, [{ content: 'print(1)\nprint(', finish: 'length' }])
  await start($)
  const r = await ($.tool.call as any)({ tool: CHAT, prompt: 'x', output_path: 'out.py', model: 'glm-5.3-flash' })
  expect(Object.keys(w.written)).toEqual(['out.py.partial'])
  expect(text(r)).toContain('[truncated]')
})

test('chat: a 429 comes back with the reset times so Claude can take another route', async ($, on) => {
  world(on, [{ content: '', status: 429 }], { rolling: 100 })
  await start($)
  const r: any = await ($.tool.call as any)({ tool: CHAT, prompt: 'x', model: 'glm-5.3-flash' })
  expect(refusal(r)).toContain('HTTP 429')
  expect(refusal(r)).toContain('limit reached')
  expect(refusal(r)).toContain('5h 100% (resets 2026-11-19 21:10 UTC)')
})

test('chat: peak multiplier and billing outside the plan are flagged', async ($, on) => {
  const usage = { ...OC_USAGE, opencode: { ...OC_USAGE.opencode, billing_source: 'balance' } }
  world(on, [{ content: 'x', usage }])
  await start($)
  const r = await ($.tool.call as any)({ tool: CHAT, prompt: 'x', model: 'deepseek-v4.1-flash' })
  expect(text(r)).toContain('[peak] deepseek-v4.1-flash uses 2x')
  expect(text(r)).toContain('[billing: balance]')
})

test('chat: when the usage endpoint fails the result says so and the status line leaves the windows out', async ($, on) => {
  const w = world(on, [{ content: 'x' }], { limitsStatus: 500 })
  await start($)
  const r = await ($.tool.call as any)({ tool: CHAT, prompt: 'x', model: 'glm-5.3-flash' })
  expect(text(r)).toContain('[limits: unknown')
  expect(w.statuses.at(-1)).toBe('5h —')
})

test('go_models: works without a key, hides free models, shows effort and flags', async ($, on) => {
  const w = world(on, [{ content: 'x' }], { keyFile: false })
  await start($)
  const r = text(await ($.tool.call as any)({ tool: MODELS }))
  expect(r).toContain('glm-5.3-flash | glm-flash | ctx 1000K out 131K | effort low/high/max | monthly go 60 plus 180 | featured')
  expect(r).toContain('kimi-k2.7-code')
  expect(r).toContain('trains-on-data, no-zdr')
  expect(r).toContain('peak-x2(now)')
  expect(r).not.toContain('beam-free')
  expect(w.fetched.every(f => !f.headers.Authorization)).toBe(true)
})

test('no key: go_chat explains where to put it; the env var is never read', async ($, on) => {
  const w = world(on, [{ content: 'x' }], { keyFile: false })
  await start($)
  const r: any = await ($.tool.call as any)({ tool: CHAT, prompt: 'x', model: 'glm-5.3-flash' })
  expect(refusal(r)).toContain('No OpenCode Go API key')
  expect(refusal(r)).toContain('/home/u/.config/opencode-go/api_key')
  expect(w.sent.length).toBe(0)
})

test('disabled: tools answer [disabled] and nothing is sent', async ($, on) => {
  const w = world(on, [{ content: 'x' }], { disabled: true })
  await start($)
  const r = await ($.tool.call as any)({ tool: CHAT, prompt: 'x', model: 'glm-5.3-flash' })
  expect(text(r)).toContain('[disabled]')
  expect(w.sent.length).toBe(0)
})

test('/go-usage: before any call checks the key and shows the windows; after, the session totals', async ($, on) => {
  world(on, [{ content: 'x' }])
  await start($)
  const before = await goUsage($)
  expect(before).toContain('Key OK')
  expect(before).toContain('5-hour window    4%, resets 2026-11-19 21:10 UTC')
  await ($.tool.call as any)({ tool: CHAT, prompt: 'x', model: 'glm-5.3-flash' })
  const after = await goUsage($)
  expect(after).toContain('Calls            1')
  expect(after).toContain('Cached input     3264')
  expect(after).toContain('Allowance used   $0.0002')
})

test('/go-usage in Korean', async ($, on) => {
  world(on, [{ content: 'x' }], { env: { LANG: 'ko_KR.UTF-8' } })
  await start($)
  expect(await goUsage($)).toContain('키 정상')
})

test('chat: a stream cut off midway keeps what arrived, flags it and saves only a .partial', async ($, on) => {
  const w = world(on, [{ content: 'print(1)\nprint(2)', cut: true }])
  await start($)
  const r = await ($.tool.call as any)({ tool: CHAT, prompt: 'x', output_path: 'out.py', model: 'glm-5.3-flash' })
  expect(text(r)).toContain('[interrupted]')
  expect(text(r)).toContain('transfer closed')
  expect(w.written['out.py.partial']).toBe('print(1)\nprint(2)\n')
  expect(w.written['out.py']).toBeUndefined()
})

test('chat: output_path outside the working folder that Claude Code would ask about is refused before any request', async ($, on) => {
  const w = world(on, [{ content: 'x' }])
  await start($)
  const r: any = await ($.tool.call as any)({ tool: CHAT, prompt: 'x', output_path: '/etc/out.py', model: 'glm-5.3-flash' })
  expect(refusal(r)).toContain('outside the working folder')
  expect(w.sent.length).toBe(0)
})

test('chat: the key goes to curl on stdin only, and the API error text is passed on for other HTTP errors', async ($, on) => {
  const w = world(on, [{ content: '', status: 400, error: '{"type":"error","error":{"type":"MissingSessionID"}}' }])
  await start($)
  const r: any = await ($.tool.call as any)({ tool: CHAT, prompt: 'x', model: 'glm-5.3-flash' })
  expect(w.argvs[0]).toEqual(['/usr/bin/curl', '--config', '-'])
  expect(refusal(r)).toContain('HTTP 400')
  expect(refusal(r)).toContain('MissingSessionID')
  expect(refusal(r)).not.toContain('limit reached')
  expect(w.configs[0]).toContain('oc_sk_test')
})

test('usage adds up across calls and the status line survives a reload of the session state', async ($, on) => {
  const w = world(on, [{ content: 'a' }])
  await start($)
  await ($.tool.call as any)({ tool: CHAT, prompt: 'x', model: 'glm-5.3-flash' })
  await ($.tool.call as any)({ tool: CHAT, prompt: 'y', model: 'glm-5.3-flash' })
  expect(w.statuses.at(-1)).toBe('5h 4%')
  await start($)
  expect(w.statuses.at(-1)).toBe('5h 4%')
})

const goModel = async ($: any, args = '') => (await $.command.run({ command: 'go-model', args } as any)).text as string

test('/go-model <id> switches the model go_chat uses, saves default_model ', async ($, on) => {
  const w = world(on, [{ content: 'x' }])
  await start($)
  expect(w.commands).toContain('go-model')
  expect(await goModel($, 'glm-5.3-flash')).toContain('OpenCode Go model: glm-5.3-flash (saved as default_model')
  expect(w.configSets).toEqual([{ key: 'opencode-go-worker.default_model', value: 'glm-5.3-flash' }])

  await ($.tool.call as any)({ tool: CHAT, prompt: 'x' })
  expect(w.sent[0].model).toBe('glm-5.3-flash')
})

test('/go-model refuses unknown and free models and keeps the current one', async ($, on) => {
  const w = world(on, [{ content: 'x' }])
  await start($)
  expect(await goModel($, 'nope')).toContain('Unknown OpenCode Go model: nope')
  expect(await goModel($, 'beam-free')).toContain('free model')
  expect(w.configSets.length).toBe(0)
})

test('/go-model with no id asks, offering featured models with the most room first; dismissing changes nothing', async ($, on) => {
  const w = world(on, [{ content: 'x' }], { answer: 'deepseek-v4.1-flash' })
  await start($)
  expect(await goModel($)).toContain('OpenCode Go model: deepseek-v4.1-flash')
  expect(w.questions[0]!.options).toEqual(['deepseek-v4.1-flash', 'glm-5.3-flash'])
})

test('/go-model with no answer lists the models instead', async ($, on) => {
  const w = world(on, [{ content: 'x' }])
  await start($)
  const out = await goModel($)
  expect(out).toContain('/go-model <id>')
  expect(out).toContain('kimi-k2.7-code')
  expect(w.configSets.length).toBe(0)
})

test('the default_model option is used when model is empty', { options: { default_model: 'kimi-k2.7-code' } }, async ($, on) => {
  const w = world(on, [{ content: 'x' }])
  await start($)
  await ($.tool.call as any)({ tool: CHAT, prompt: 'x' })
  expect(w.sent[0].model).toBe('kimi-k2.7-code')
})

test('the status line shows only the 5-hour window, from the start; without a key it shows 5h —', async ($, on) => {
  const w = world(on, [{ content: 'x' }])
  await start($)
  expect(w.statuses.at(-1)).toBe('5h 4%')
})

test('without a key the status line still shows the plugin is loaded', async ($, on) => {
  const w = world(on, [{ content: 'x' }], { keyFile: false })
  await start($)
  expect(w.statuses.at(-1)).toBe('5h —')
})

const BAND = (surface: 'terminal' | 'desktop' | 'vscode' | 'mobile', hasSurvey = false) =>
  ({
    plugin: 'opencode-go-worker',
    component: 'AbovePrompt',
    surface,
    props: { hasSurvey, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  }) as any

test('the band above the prompt shows a model dropdown; picking switches the model and saves it', async ($, on) => {
  const w = world(on, [{ content: 'x' }])
  await start($)
  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await ($.ui as any).mount(BAND(surface))
    const select = await ui.find({ type: 'Select' })
    expect(select?.key).toBe('go-model')
    expect(select?.props.label).toBe('Go model')
    // featured first by monthly room, then the rest; free models left out; a "pick" entry while none is set
    expect((select?.props.options as any[]).map(o => o.value)).toEqual(['', 'deepseek-v4.1-flash', 'glm-5.3-flash', 'kimi-k2.7-code'])
    await ui.unmount()
  }
  const ui = await ($.ui as any).mount(BAND('desktop'))
  await ui.select({ key: 'go-model', value: 'glm-5.3-flash' })
  await ui.unmount()
  expect(w.configSets).toEqual([{ key: 'opencode-go-worker.default_model', value: 'glm-5.3-flash' }])

  const again = await ($.ui as any).mount(BAND('desktop'))
  const select = await again.find({ type: 'Select' })
  expect(select?.props.value).toBe('glm-5.3-flash')
  expect((select?.props.options as any[])[0].value).toBe('deepseek-v4.1-flash') // no "pick" entry once set
  await again.unmount()
  await ($.tool.call as any)({ tool: CHAT, prompt: 'x' })
  expect(w.sent[0].model).toBe('glm-5.3-flash')
})

test('the band steps aside for a survey, on mobile, and when the plugin is off', async ($, on) => {
  world(on, [{ content: 'x' }], { disabled: true })
  await start($)
  for (const b of [BAND('desktop', true), BAND('mobile'), BAND('terminal')]) {
    const ui = await ($.ui as any).mount(b)
    expect(await ui.find({ type: 'Select' })).toBeUndefined()
    await ui.unmount()
  }
})

const bandWith = (columns: number) => {
  const b = BAND('desktop')
  return { ...b, props: { ...b.props, bodyColumns: columns } }
}

test('the band shows usage beside the dropdown, dropping details first when narrow', async ($, on) => {
  world(on, [{ content: 'x' }])
  await start($)
  const before = await ($.ui as any).mount(bandWith(120))
  expect((await before.find({ type: 'Text', text: /5h/ }))?.text).toBe('5h 4% · wk 1%')
  await before.unmount()

  await ($.tool.call as any)({ tool: CHAT, prompt: 'x', model: 'glm-5.3-flash' })
  const wide = await ($.ui as any).mount(bandWith(120))
  expect((await wide.find({ type: 'Text', text: /5h/ }))?.text).toBe('1 call · 4.0Ktok · cache 81% · $0.0002 · 5h 4% · wk 1%')
  await wide.unmount()
  const narrow = await ($.ui as any).mount(bandWith(60))
  expect((await narrow.find({ type: 'Text', text: /5h/ }))?.text).toBe('1 call · 5h 4% · wk 1%')
  await narrow.unmount()
  const tight = await ($.ui as any).mount(bandWith(38))
  expect((await tight.find({ type: 'Text', text: /5h/ }))?.text).toBe('5h 4%')
  await tight.unmount()
})

test('the 5-hour window turns yellow past 80% in the band', async ($, on) => {
  world(on, [{ content: 'x' }], { rolling: 85 })
  await start($)
  const ui = await ($.ui as any).mount(bandWith(120))
  const part = await ui.find({ type: 'Text', text: /^5h 85%$/ })
  expect(part?.props.color).toBe('warning')
  await ui.unmount()
})

const EXPLORE_OPTS = { options: { explore_agent: true, default_model: 'glm-5.3-flash' } }

test('chat: a limit reported inside the stream comes back like a 429, with the reset times', async ($, on) => {
  world(on, [{ content: '', streamError: { code: 429, message: 'Rate limit exceeded' } }], { rolling: 100 })
  await start($)
  const r: any = await ($.tool.call as any)({ tool: CHAT, prompt: 'x', model: 'glm-5.3-flash' })
  expect(refusal(r)).toContain('HTTP 429, in the stream')
  expect(refusal(r)).toContain('limit reached')
  expect(refusal(r)).toContain('5h 100%')
})


const AGENT = 'mcp__opencode-go-worker__go_agent'
const AGENT_OPTS = { options: { worker_agent: true, default_model: 'glm-5.3-flash' } }
const CHECK = 'python3 -m unittest -q'

test('go_agent: registered only with its option, with a guide for Claude', AGENT_OPTS, async ($, on) => {
  on('prompt.compose', () => ({ sections: [] }))
  const w = world(on, [{ content: 'x' }])
  await start($)
  expect(w.registered).toContain('go_agent')
  const r: any = await ($ as any).prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] })
  expect(r.sections.find((x: any) => x.id === 'opencode-go-worker:go_agent')?.text).toContain('Always give check_command')
})

test('go_agent: on by default, and gone when its option is turned off', { options: { worker_agent: false } }, async ($, on) => {
  world(on, [{ content: 'x' }])
  await start($)
  const r: any = await ($.tool.call as any)({ tool: AGENT, task: 'x', check_command: CHECK, model: 'glm-5.3-flash' })
  expect(refusal(r)).toContain('Unknown tool')
})

test('go_agent: edits, runs the check by number, fixes and reruns; the plugin trusts an unchanged last run', AGENT_OPTS, async ($, on) => {
  let checks = 0
  const w = world(on, [{ content: 'x' }], {
    files: { '/work/t.py': 'def f():\n    return 1\n' },
    run: c => (c === CHECK ? (++checks === 1 ? { exitCode: 1, stdout: 'FAIL: test_f' } : { stdout: 'OK' }) : {}),
    agentSteps: [
      { calls: [['read_file', { path: 't.py' }]] },
      { calls: [['edit_file', { path: 't.py', old_string: 'return 1', new_string: 'return 3' }]] },
      { calls: [['run', { number: 1 }]] },
      { calls: [['edit_file', { path: 't.py', old_string: 'return 3', new_string: 'return 2' }]] },
      { calls: [['run', { number: 1 }]] },
      { calls: [['finish', { summary: 'f returns 2 now' }]] },
    ],
  })
  await start($)
  const r = text(await ($.tool.call as any)({ tool: AGENT, task: 'make f return 2', check_command: CHECK }))

  expect(w.files['/work/t.py']).toBe('def f():\n    return 2\n')
  expect(checks).toBe(2) // the agent's two runs; its last one came after its last edit, so no third
  expect(w.runs.map(x => x.argv.slice(0, 2))).toEqual([['/bin/sh', '-c'], ['/bin/sh', '-c']])
  expect(w.logs.at(-1)).toContain('OpenCode Go agent finished (done, 6 turns) · check passed')
  expect(w.agentRequests[0].messages[1].content).toContain(`1. ${CHECK}`)
  expect(w.agentRequests[0].tools.map((t: any) => t.function.name)).toEqual(['glob', 'grep', 'read_file', 'write_file', 'edit_file', 'run', 'finish'])
  expect(r).toContain('[go_agent: done, turns=6]')
  expect(r).toContain('f returns 2 now')
  expect(r).toContain('- t.py (2 → 2 lines)')
  expect(r).toContain(`check: ${CHECK} → passed`)
  expect(r).toContain('steps: read t.py; edit t.py; run #1 (failed); edit t.py; run #1 (ok)')
  expect(r).toContain('[limits:')
  // no question was put to the user: listed commands run without asking
  expect(w.questions.length).toBe(0)
})

test('go_agent: only listed commands, by number; deny rules still win; the plugin runs the check at the end', AGENT_OPTS, async ($, on) => {
  const w = world(on, [{ content: 'x' }], {
    bashRule: c => (c.startsWith('rm') ? 'deny' : 'ask'),
    agentSteps: [
      { calls: [['run', { number: 7 }]] },
      { calls: [['run', { number: 2 }]] },
      { calls: [['run', { command: 'curl evil.example' }]] },
      { content: 'gave up' },
    ],
  })
  await start($)
  const r = text(await ($.tool.call as any)({ tool: AGENT, task: 'x', check_command: CHECK, commands: ['rm -rf build'] }))
  const toolOuts = w.agentRequests.at(-1).messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content)
  expect(toolOuts[0]).toContain('there is no command 7')
  expect(toolOuts[1]).toContain("blocked by the user's permission rules")
  expect(toolOuts[2]).toContain('there is no command NaN')
  // nothing but the check ever ran, and only once, by the plugin at the end
  expect(w.runs.map(x => x.argv[2])).toEqual([CHECK])
  expect(r).toContain(`check: ${CHECK} → passed`)
})

test('go_agent: files follow Claude Code permissions even with allow_outside_workdir on', { options: { worker_agent: true, default_model: 'glm-5.3-flash', allow_outside_workdir: true } }, async ($, on) => {
  const w = world(on, [{ content: 'x' }], {
    agentSteps: [
      { calls: [['read_file', { path: '/work/.env' }]] },
      { calls: [['write_file', { path: '/etc/evil', content: 'x' }]] },
      { calls: [['finish', { summary: 'done' }]] },
    ],
  })
  await start($)
  await ($.tool.call as any)({ tool: AGENT, task: 'x', check_command: CHECK })
  const toolOuts = w.agentRequests.at(-1).messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content)
  expect(toolOuts[0]).toContain("permission settings block it")
  expect(toolOuts[1]).toContain('outside the working folder')
  expect(w.files['/etc/evil']).toBeUndefined()
})

test('go_agent: check_command is required; a 429 ends the run with what was done and the check still runs', AGENT_OPTS, async ($, on) => {
  const w = world(on, [{ content: 'x' }], {
    files: { '/work/t.py': 'a\n' },
    agentSteps: [{ calls: [['edit_file', { path: 't.py', old_string: 'a', new_string: 'b' }]] }, { status: 429 }],
  })
  await start($)
  const missing: any = await ($.tool.call as any)({ tool: AGENT, task: 'x' })
  expect(refusal(missing)).toContain('check_command is required')
  const r = text(await ($.tool.call as any)({ tool: AGENT, task: 'x', check_command: CHECK }))
  expect(r).toContain('[go_agent: plan limit, turns=2]')
  expect(r).toContain('HTTP 429')
  expect(r).toContain('- t.py (1 → 1 lines)')
  expect(r).toContain(`check: ${CHECK} → passed`)
  expect(w.files['/work/t.py']).toBe('b\n')
})

test('go_agent: progress shows in the band while it works and clears after', AGENT_OPTS, async ($, on) => {
  let seen: string | undefined
  const w = world(on, [{ content: 'x' }], {
    run: () => ({ stdout: 'OK' }),
    agentSteps: [{ calls: [['glob', { pattern: '*.py' }]] }, { calls: [['finish', { summary: 'ok' }]] }],
    onRun: async () => {
      const ui = await ($.ui as any).mount(bandWith(140))
      seen = (await ui.find({ type: 'Text', text: /5h/ }))?.text
      await ui.unmount()
    },
  })
  await start($)
  await ($.tool.call as any)({ tool: AGENT, task: 'x', check_command: CHECK })
  expect(seen).toBe('go_agent step 2 · checking · 5h 4%')
  const ui = await ($.ui as any).mount(bandWith(140))
  expect((await ui.find({ type: 'Text', text: /5h/ }))?.text).not.toContain('go_agent')
  await ui.unmount()
  expect(w.runs.length).toBe(1)
})

const EXPLORE = 'mcp__opencode-go-worker__go_explore'

test('go_explore: registered, with a guide for Claude', EXPLORE_OPTS, async ($, on) => {
  on('prompt.compose', () => ({ sections: [] }))
  const w = world(on, [{ content: 'x' }])
  await start($)
  expect(w.registered).toContain('go_explore')
  expect(w.registered).toContain('go_agent') // both on by default
  expect(w.agents.length).toBe(0) // no subagent any more
  const r: any = await ($ as any).prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] })
  expect(r.sections.find((x: any) => x.id === 'opencode-go-worker:go_explore')?.text).toContain('Explore agent')
})

test('go_explore: gone when its option is turned off', { options: { explore_agent: false } }, async ($, on) => {
  world(on, [{ content: 'x' }])
  await start($)
  const r: any = await ($.tool.call as any)({ tool: EXPLORE, question: 'x', model: 'glm-5.3-flash' })
  expect(refusal(r)).toContain('Unknown tool')
})

test('go_explore: finds and reads with read-only tools, answers with evidence, runs nothing', EXPLORE_OPTS, async ($, on) => {
  const w = world(on, [{ content: 'x' }], {
    files: { '/work/src/key.py': 'def find_key():\n    return read_file()\n', '/work/README.md': 'docs\n' },
    agentSteps: [
      { calls: [['glob', { pattern: '**/*.py' }]] },
      { calls: [['grep', { pattern: 'def find_key' }]] },
      { calls: [['read_file', { path: 'src/key.py' }]] },
      { calls: [['finish', { summary: 'find_key is defined at src/key.py:1.' }]] },
    ],
  })
  await start($)
  const r = text(await ($.tool.call as any)({ tool: EXPLORE, question: 'Where is find_key defined?' }))
  const req = w.agentRequests[0]
  expect(req.tools.map((t: any) => t.function.name)).toEqual(['glob', 'grep', 'read_file', 'finish'])
  expect(req.messages[0].content).toContain('read-only tools')
  expect(req.messages[1].content).toContain('Question:\nWhere is find_key defined?')
  const outs = w.agentRequests.at(-1).messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content)
  expect(outs[0]).toContain('src/key.py')
  expect(outs[1]).toContain('src/key.py:1:def find_key')
  expect(r).toContain('[go_explore: done, turns=4]')
  expect(r).toContain('answer:\nfind_key is defined at src/key.py:1.')
  expect(r).toContain('steps: glob **/*.py; grep def find_key; read src/key.py')
  expect(r).not.toContain('check:')
  expect(w.runs.length).toBe(0)
  expect(r).toContain('[limits:')
})

test('go_explore: a write or run it was never offered is refused; deny-ruled files stay closed', EXPLORE_OPTS, async ($, on) => {
  const w = world(on, [{ content: 'x' }], {
    agentSteps: [
      { calls: [['write_file', { path: 'x.py', content: 'evil' }]] },
      { calls: [['run', { number: 1 }]] },
      { calls: [['read_file', { path: '.env' }]] },
      { content: 'could not do it' },
    ],
  })
  await start($)
  const r = text(await ($.tool.call as any)({ tool: EXPLORE, question: 'x' }))
  const outs = w.agentRequests.at(-1).messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content)
  expect(outs[0]).toContain('You can only find and read')
  expect(outs[1]).toContain('You can only find and read')
  expect(outs[2]).toContain('permission settings block it')
  expect(w.files['/work/x.py']).toBeUndefined()
  expect(w.runs.length).toBe(0)
  expect(r).toContain('answer:\ncould not do it')
})

test('go_explore: its progress clears from the band after the run', EXPLORE_OPTS, async ($, on) => {
  world(on, [{ content: 'x' }], { agentSteps: [{ calls: [['grep', { pattern: 'x' }]] }, { content: 'done' }] })
  await start($)
  await ($.tool.call as any)({ tool: EXPLORE, question: 'x' })
  const ui = await ($.ui as any).mount(bandWith(140))
  expect((await ui.find({ type: 'Text', text: /5h/ }))?.text).toBe('1 call · 240tok · cache 20% · $0.0002 · 5h 4% · wk 1%')
  await ui.unmount()
})

test('sessions keep their own picked model, usage and band; a pick in one session does not move another', { options: { default_model: 'kimi-k2.7-code' } }, async ($, on) => {
  const w = world(on, [{ content: 'x' }])
  await start($)
  const band = async () => {
    const ui = await ($.ui as any).mount(bandWith(140))
    const select = await ui.find({ type: 'Select' })
    const usage = (await ui.find({ type: 'Text', text: /5h/ }))?.text
    await ui.unmount()
    return { model: select?.props.value, usage }
  }
  // session 1 picks glm and makes a call
  await goModel($, 'glm-5.3-flash')
  await ($.tool.call as any)({ tool: CHAT, prompt: 'x' })
  expect(w.sent[0].model).toBe('glm-5.3-flash')
  expect(await band()).toEqual({ model: 'glm-5.3-flash', usage: '1 call · 4.0Ktok · cache 81% · $0.0002 · 5h 4% · wk 1%' })

  // session 2 never picked: it uses the default and has its own (empty) usage
  w.session.id = 'sess-2'
  await ($.tool.call as any)({ tool: CHAT, prompt: 'y' })
  expect(w.sent[1].model).toBe('kimi-k2.7-code')
  expect((await band()).model).toBe('kimi-k2.7-code')
  // session 2 picks deepseek: session 1 keeps glm
  await goModel($, 'deepseek-v4.1-flash')
  w.session.id = 'sess-1'
  await ($.tool.call as any)({ tool: CHAT, prompt: 'z' })
  expect(w.sent[2].model).toBe('glm-5.3-flash')
  expect((await band()).usage).toBe('2 calls · 8.0Ktok · cache 81% · $0.0004 · 5h 4% · wk 1%')
})


// Rows shaped like the console Go page's model table
const consoleRow = (id: string, go: string, plus: string) =>
  `<tr data-model="${id}" data-layer="model-row"><th scope="row"><span title="x">x</span></th><td aria-hidden="true">bars</td>` +
  `<td data-allowance-type="requests"><div><span>${go}</span></div><span class="sr-only">Go: ${go}; Go Plus: ${plus}</span></td>` +
  `<td data-allowance-type="monthly"><span class="sr-only">Go: $100; Go Plus: $200</span></td></tr>`
const CONSOLE =
  '<table><tbody>' +
  consoleRow('deepseek-v4.1-flash', '43,300', '86,700') +
  consoleRow('glm-5.3-flash', '6,320', '18,900') +
  consoleRow('kimi-k3', '98', '392') +
  consoleRow('gpt-6-luna', '4,230', '16,900') +
  consoleRow('qwen3.8-flash', '5,400', '16,200') +
  consoleRow('beam-free', 'unlimited', 'unlimited') +
  '</tbody></table>'

// A redesign: no data-model ids, no table, other words around the numbers, but the same "Go … Go Plus …" text
const REDESIGNED =
  '<section>' +
  [
    ['DeepSeek V4.1 Flash 1017', '43.3K', '86.7K'],
    ['GLM-5.3-Flash', '6,320', '18,900'],
    ['Kimi K2.7 Code', '994', '2,980'],
    ['GPT-6 Luna', '4,230', '16,900'],
  ]
    .map(([n, g, p]) => `<div class="card"><h3>${n}</h3><p>Est. requests / 5h</p><p>Go&nbsp;${g} · Go Plus&nbsp;${p}</p><p>Go: $60; Go Plus: $120</p></div>`)
    .join('') +
  '</section>'

test('the dropdown labels each model with the console estimate of requests per 5 hours, Go until a response says Plus', async ($, on) => {
  const usage = { ...OC_USAGE, opencode: { ...OC_USAGE.opencode, billing_source: 'go-plus' } }
  world(on, [{ content: 'x', usage }], { consoleHtml: CONSOLE })
  await start($)
  const labels = async () => {
    const ui = await ($.ui as any).mount(bandWith(160))
    const options = (await ui.find({ type: 'Select' }))?.props.options as any[]
    await ui.unmount()
    return Object.fromEntries(options.map(o => [o.value, o.label]))
  }
  const before = await labels()
  expect(before['deepseek-v4.1-flash']).toBe('deepseek-v4.1-flash (~43.3K/5h)')
  expect(before['glm-5.3-flash']).toBe('glm-5.3-flash (~6.3K/5h)')
  expect(before['kimi-k2.7-code']).toBe('kimi-k2.7-code ($60/mo)') // not on the page: its monthly limit instead
  await ($.tool.call as any)({ tool: CHAT, prompt: 'x', model: 'glm-5.3-flash' })
  const after = await labels()
  expect(after['deepseek-v4.1-flash']).toBe('deepseek-v4.1-flash (~86.7K/5h)')
  expect(after['glm-5.3-flash']).toBe('glm-5.3-flash (~18.9K/5h)')
})

test('the estimates survive a redesigned page: no ids, other markup, K numbers, matched by display name', async ($, on) => {
  world(on, [{ content: 'x' }], { consoleHtml: REDESIGNED })
  await start($)
  const ui = await ($.ui as any).mount(bandWith(160))
  const options = (await ui.find({ type: 'Select' }))?.props.options as any[]
  await ui.unmount()
  const label = Object.fromEntries(options.map(o => [o.value, o.label]))
  expect(label['deepseek-v4.1-flash']).toBe('deepseek-v4.1-flash (~43.3K/5h)')
  expect(label['glm-5.3-flash']).toBe('glm-5.3-flash (~6.3K/5h)')
  expect(label['kimi-k2.7-code']).toBe('kimi-k2.7-code (~994/5h)')
})

test('a page with too few readable models is not trusted', async ($, on) => {
  world(on, [{ content: 'x' }], { consoleHtml: `<table>${consoleRow('deepseek-v4.1-flash', '43,300', '86,700')}</table>` })
  await start($)
  const ui = await ($.ui as any).mount(bandWith(160))
  const options = (await ui.find({ type: 'Select' }))?.props.options as any[]
  await ui.unmount()
  // not trusted, so each model falls back to its monthly limit from /v1/models
  expect(Object.fromEntries(options.map(o => [o.value, o.label]))).toEqual({
    '': '— pick a model —',
    'deepseek-v4.1-flash': 'deepseek-v4.1-flash ($100/mo)',
    'glm-5.3-flash': 'glm-5.3-flash ($60/mo)',
    'kimi-k2.7-code': 'kimi-k2.7-code ($60/mo)',
  })
})

test('the settings rows follow the language: Korean labels and descriptions under ko', { options: { language: 'ko' } }, async ($, on) => {
  on('config.describe', (_: unknown, e: any) => ({ label: e.label, description: e.description, isHidden: false }))
  world(on, [{ content: 'x' }])
  await start($)
  const row = async (key: string) =>
    ($ as any).config.describe({ key: `opencode-go-worker.${key}`, label: key, description: 'english', isHidden: false, provider: { plugin: 'opencode-go-worker' } })
  expect(await row('default_model')).toMatchObject({ label: '기본 모델' })
  expect((await row('worker_agent')).description).toContain('호출 한 번 안에서')
  // another plugin's rows are left alone
  const other: any = await ($ as any).config.describe({ key: 'theme', label: 'Theme', description: 'x', isHidden: false, provider: { plugin: 'engine' } })
  expect(other.label).toBe('Theme')
})


test('auto language: the Claude app\'s own language wins over the system\'s', async ($, on) => {
  world(on, [{ content: 'x' }], { env: { LANG: '' }, appLanguages: '(\n    "en-KR",\n    ko\n)\n', systemLanguages: '(\n    "ko-KR"\n)\n' })
  await start($)
  expect(await goUsage($)).toContain('Key OK')
})

test('auto language: without an app setting, the system language is used', async ($, on) => {
  world(on, [{ content: 'x' }], { env: { LANG: '' }, systemLanguages: '(\n    "ko-KR"\n)\n' })
  await start($)
  expect(await goUsage($)).toContain('키 정상')
})

test('chat jobs: run together with shared files and prompt first; results in job order', async ($, on) => {
  const w = world(on, [{ content: 'one' }, { content: 'one' }, { content: 'one' }])
  await start($)
  const r = await ($.tool.call as any)({
    tool: CHAT,
    model: 'glm-5.3-flash',
    prompt: 'Shared rules.',
    files: ['a.py'],
    jobs: [
      { prompt: 'job A', output_path: 'a.out' },
      { prompt: 'job B', output_path: 'b.out', reasoning_effort: 'low' },
      { prompt: 'job C' },
    ],
  })
  expect(w.sent.length).toBe(3)
  for (const b of w.sent) {
    expect(b.messages[1].content).toMatch(/^<data id="\w{12}" source="file a.py">/)
    expect(b.messages[1].content).toContain('Shared rules.\n\njob ')
  }
  expect(w.sent.filter((b: any) => b.reasoning_effort === 'low').length).toBe(1)
  expect(Object.keys(w.written).sort()).toEqual(['a.out', 'b.out'])
  const t = text(r)
  expect(t).toContain('3/3 jobs finished.')
  expect(t.indexOf('## job 1 · a.out')).toBeLessThan(t.indexOf('## job 2 · b.out'))
  expect(t.indexOf('## job 2 · b.out')).toBeLessThan(t.indexOf('## job 3\n'))
  expect(t).toContain('[limits:')
})

test('chat jobs: a failed job does not stop the others; bad batches are refused before any request', async ($, on) => {
  const w = world(on, [{ content: 'fine' }])
  await start($)
  const r = await ($.tool.call as any)({ tool: CHAT, model: 'glm-5.3-flash', jobs: [{ prompt: 'x', files: ['.env'] }, { prompt: 'y' }] })
  expect(text(r)).toContain('1/2 jobs finished, 1 failed.')
  expect(text(r)).toContain("[failed] Cannot read")
  expect(w.sent.length).toBe(1)

  const dup: any = await ($.tool.call as any)({ tool: CHAT, model: 'glm-5.3-flash', jobs: [{ prompt: 'x', output_path: 'o' }, { prompt: 'y', output_path: 'o' }] })
  expect(refusal(dup)).toContain('same output_path')
  const none: any = await ($.tool.call as any)({ tool: CHAT, model: 'glm-5.3-flash', jobs: [{ prompt: ' ' }] })
  expect(refusal(none)).toContain('jobs[0] has no prompt')
  const empty: any = await ($.tool.call as any)({ tool: CHAT, model: 'glm-5.3-flash' })
  expect(refusal(empty)).toContain('Give prompt, or jobs')
  expect(w.sent.length).toBe(1)
})

test('chat: streams cut off after 5 silent minutes; non-streamed agent turns do not', EXPLORE_OPTS, async ($, on) => {
  const w = world(on, [{ content: 'print(1)\n', idle: 'after' }, { content: '', idle: 'before' }], { agentSteps: [{ content: 'done' }] })
  await start($)
  const r = await ($.tool.call as any)({ tool: CHAT, prompt: 'x', output_path: 'out.py', model: 'glm-5.3-flash' })
  expect(w.configs[0]).toContain('speed-limit = 1')
  expect(w.configs[0]).toContain('speed-time = 300')
  expect(Object.keys(w.written)).toEqual(['out.py.partial'])
  expect(text(r)).toContain('[interrupted] The reply was cut off while streaming (no data for 5 minutes, so the call was cut off)')

  const dead: any = await ($.tool.call as any)({ tool: CHAT, prompt: 'x', model: 'glm-5.3-flash' })
  expect(refusal(dead)).toContain('no data for 5 minutes')

  await ($.tool.call as any)({ tool: EXPLORE, question: 'x' })
  expect(w.configs[w.configs.length - 1]).not.toContain('speed-limit')
})

test('chat: the band shows thinking while the model reasons, and clears after; the reasoning never reaches the reply', async ($, on) => {
  let mid: string | undefined
  const w = world(on, [{ content: 'answer', thinking: 1200 }], {
    midStream: async () => {
      const ui = await ($.ui as any).mount(bandWith(140))
      mid = (await ui.find({ type: 'Text', text: /go_chat/ }))?.text
      await ui.unmount()
    },
  })
  await start($)
  const r = await ($.tool.call as any)({ tool: CHAT, prompt: 'x', model: 'glm-5.3-flash' })
  expect(mid).toContain('go_chat · glm-5.3-flash · thinking ~1.2K')
  expect(text(r)).not.toContain('SECRET')
  const ui = await ($.ui as any).mount(bandWith(140))
  expect(await ui.find({ type: 'Text', text: /go_chat/ })).toBeUndefined()
  await ui.unmount()
  expect(w.sent.length).toBe(1)
})
