import { expect, test } from 'claude-code/testing'

const CHAT = 'mcp__opencode-go-worker__go_chat'
const MODELS = 'mcp__opencode-go-worker__go_models'

type Reply = { content: string; finish?: string; usage?: Record<string, unknown>; status?: number; error?: string; cut?: boolean; streamError?: unknown }

type WorldOptions = {
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
}

type ExploreStep = { text?: string; tool?: { id: string; name: string; input: unknown }; thinking?: string; status?: number; error?: string; streamError?: unknown }

const MODEL_LIST = {
  object: 'list',
  data: [
    {
      id: 'glm-5.3-flash',
      family: 'glm-flash',
      capabilities: { tools: { supported: true }, reasoning: { supported: true, effort: ['low', 'high', 'max'] } },
      limit: { context: 1000000, output: 131072 },
      cost: { text: { input: { price: 0.15 }, output: { price: 0.5 } } },
      go: { monthly_usage: { go: 60, 'go-plus': 180, 'go-teams': 65 }, training: false, zdr: true, featured: true },
    },
    {
      id: 'deepseek-v4.1-flash',
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
  on('tool.register', (_: unknown, e: any) => ({ value: { tool: `mcp__opencode-go-worker__${e.name}` } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
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
  on('session.cwd', () => ({ value: '/work' }))
  on('tool.check', (_: unknown, e: any) => {
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
    const half = Math.ceil(r.content.length / 2)
    yield { stream: 'stdout', text: chunk({ model: body.model, choices: [{ delta: { reasoning_content: 'SECRET THOUGHTS' } }] }) }
    for (const piece of [r.content.slice(0, half), r.content.slice(half)]) {
      yield { stream: 'stdout', text: chunk({ model: body.model, choices: [{ delta: { content: piece } }] }) }
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
  return { sent, configs, argvs, fetched, statuses, written, files, commands, configSets, questions, agents, exploreBodies }
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
  const tight = await ($.ui as any).mount(bandWith(45))
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

// Runs one model step of a loop and collects what streamed
async function step($: any, agentId: string | undefined, index = 0) {
  const chunks: any[] = []
  const s = $.turn.step({ turnId: 't1', index, model: 'claude-opus-5-5', messageCount: 2, ...(agentId ? { agentId } : {}) })
  let r = await s.next()
  while (!r.done) {
    chunks.push(r.value)
    r = await s.next()
  }
  return { chunks, result: r.value }
}

test('explore: registered only when the option is on, read-only tools, with a guide for Claude', EXPLORE_OPTS, async ($, on) => {
  on('prompt.compose', () => ({ sections: [] }))
  const w = world(on, [{ content: 'x' }])
  await start($)
  expect(w.agents.length).toBe(1)
  expect(w.agents[0].name).toBe('explore')
  expect(w.agents[0].tools).toEqual(['Read', 'Bash'])
  expect(w.agents[0].prompt).toContain('Never create, change, move or delete')
  const r: any = await ($ as any).prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] })
  expect(r.sections.map((x: any) => x.id)).toContain('opencode-go-worker:explore')
})

test('explore: off by default', async ($, on) => {
  const w = world(on, [{ content: 'x' }])
  await start($)
  expect(w.agents.length).toBe(0)
})

test('explore: a step is answered from Go (thinking dropped, tool call streamed whole) and never reaches Claude', EXPLORE_OPTS, async ($, on) => {
  let claudeAsked = 0
  on('turn.step', async function* () {
    claudeAsked++
    yield { kind: 'text', index: 0, text: 'from claude' }
    return { turnId: 't1', index: 0, answer: 'from claude', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  const w = world(on, [{ content: 'x' }], {
    steps: [{ thinking: 'hmm', text: 'Searching.', tool: { id: 'tool-1', name: 'Bash', input: { command: 'rg -n DATA_ID', description: 'find it' } } }],
  })
  await start($)
  const { chunks, result } = await step($, 'ag-explore')

  expect(claudeAsked).toBe(0)
  const body = w.exploreBodies[0]
  expect(body.model).toBe('glm-5.3-flash')
  expect(body.system).toContain('read-only codebase explorer')
  expect(body.tools.map((t: any) => t.name)).toEqual(['Read', 'Bash'])
  // thinking blocks (Claude's signatures) are dropped from the history sent to Go
  expect(JSON.stringify(body.messages)).not.toContain('signature')
  expect(w.configs.at(-1)).toContain('header = "anthropic-version: 2023-06-01"')
  expect(w.configs.at(-1)).toContain('header = "x-opencode-session: ccgo-sess-1"')

  expect(chunks.filter(c => c.kind === 'text').map(c => c.text).join('')).toBe('Searching.')
  expect(chunks.some(c => c.kind === 'thinking')).toBe(false)
  expect(chunks.find(c => c.kind === 'tool')).toMatchObject({ id: 'tool-1', name: 'Bash' })
  expect(chunks.filter(c => c.kind === 'input').map(c => c.json).join('')).toBe('{"command":"rg -n DATA_ID","description":"find it"}')
  expect(chunks.at(-1)).toMatchObject({ kind: 'stop', stopReason: 'tool_use' })
  expect(result.toolUses).toEqual([{ id: 'tool-1', name: 'Bash', input: { command: 'rg -n DATA_ID', description: 'find it' } }])
  expect(result.stopReason).toBe('tool_use')
  // the step counts toward the session's usage in the band
  expect(w.statuses.at(-1)).toBe('5h 4%')
})

test('explore: other loops pass through to Claude', EXPLORE_OPTS, async ($, on) => {
  on('turn.step', async function* () {
    yield { kind: 'text', index: 0, text: 'from claude' }
    return { turnId: 't1', index: 0, answer: 'from claude', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  const w = world(on, [{ content: 'x' }])
  await start($)
  for (const id of [undefined, 'ag-other']) {
    const { result } = await step($, id)
    expect(result.answer).toBe('from claude')
  }
  expect(w.exploreBodies.length).toBe(0)
})

test('explore: SubagentHandback is offered only when the conversation asks for it', EXPLORE_OPTS, async ($, on) => {
  const w = world(on, [{ content: 'x' }], {
    agentMessages: [{ role: 'user', content: [{ type: 'text', text: 'Find X. <system-reminder>call SubagentHandback({message})</system-reminder>' }] }],
  })
  await start($)
  await step($, 'ag-explore')
  expect(w.exploreBodies[0].tools.map((t: any) => t.name)).toEqual(['Read', 'Bash', 'SubagentHandback'])
})

test('explore: a 429 ends the agent with the reset times instead of falling back to Claude', EXPLORE_OPTS, async ($, on) => {
  let claudeAsked = 0
  on('turn.step', async function* () {
    claudeAsked++
    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  world(on, [{ content: 'x' }], { steps: [{ status: 429, error: '{"error":"limit"}' }], rolling: 100 })
  await start($)
  const { chunks, result } = await step($, 'ag-explore')
  expect(claudeAsked).toBe(0)
  const text = chunks.filter(c => c.kind === 'text').map(c => c.text).join('')
  expect(text).toContain('HTTP 429')
  expect(text).toContain('5h 100%')
  expect(result.stopReason).toBe('end_turn')
})

test('explore: with no Go model set the agent says so and stops', { options: { explore_agent: true } }, async ($, on) => {
  const w = world(on, [{ content: 'x' }])
  await start($)
  const { chunks } = await step($, 'ag-explore')
  expect(chunks.find(c => c.kind === 'text')?.text).toContain('No OpenCode Go model is set')
  expect(w.exploreBodies.length).toBe(0)
})

test('explore: the band shows the run\'s progress while it works, then goes back to usage', EXPLORE_OPTS, async ($, on) => {
  on('turn.complete', (_: unknown, e: any) => ({ text: '', ...(e.usage ? { usage: e.usage } : {}) }))
  world(on, [{ content: 'x' }], {
    steps: [{ tool: { id: 't1', name: 'Bash', input: { command: 'rg -n "x-opencode-session"  hooks', description: 'search' } } }, { text: 'Found it.' }],
  })
  await start($)
  const bandText = async () => {
    const ui = await ($.ui as any).mount(bandWith(140))
    const t = (await ui.find({ type: 'Text', text: /5h/ }))?.text
    await ui.unmount()
    return t
  }
  await step($, 'ag-explore', 0)
  expect(await bandText()).toBe('explore step 1 · rg -n "x-opencode-session" hooks · 5h 4%')
  await step($, 'ag-explore', 1)
  // the final answer ends the run: usage is back (2 Go calls from this agent)
  expect(await bandText()).toBe('2 calls · 860tok · cache 25% · $0.0002 · 5h 4% · wk 1%')
})

test('explore: a run that ends early (turn.complete) leaves the band', EXPLORE_OPTS, async ($, on) => {
  on('turn.complete', () => ({ text: '' }))
  world(on, [{ content: 'x' }], { steps: [{ tool: { id: 't1', name: 'Read', input: { file_path: '/work/a/b/register.tsx' } } }] })
  await start($)
  await step($, 'ag-explore', 0)
  const ui = await ($.ui as any).mount(bandWith(140))
  expect((await ui.find({ type: 'Text', text: /5h/ }))?.text).toBe('explore step 1 · Read register.tsx · 5h 4%')
  await ui.unmount()
  await ($ as any).turn.complete({ turnId: 't1', agentId: 'ag-explore', reason: 'aborted', answer: '', durationMs: 1, isAborted: true })
  const after = await ($.ui as any).mount(bandWith(140))
  expect((await after.find({ type: 'Text', text: /5h/ }))?.text).not.toContain('explore')
  await after.unmount()
})

test('explore: a 429 refreshes the windows the status line shows', EXPLORE_OPTS, async ($, on) => {
  const w = world(on, [{ content: 'x' }], { steps: [{ status: 429, error: '{"error":"limit"}' }], rollingSeq: [40, 100] })
  await start($)
  expect(w.statuses.at(-1)).toBe('5h 40%')
  await step($, 'ag-explore')
  expect(w.statuses.at(-1)).toBe('5h 100%')
})

test('explore: a limit Go reports inside the stream is handled like a 429', EXPLORE_OPTS, async ($, on) => {
  world(on, [{ content: 'x' }], { steps: [{ streamError: { type: 'rate_limit_error', message: 'slow down' } }], rolling: 100 })
  await start($)
  const { chunks, result } = await step($, 'ag-explore')
  const text = chunks.filter(c => c.kind === 'text').map(c => c.text).join('')
  expect(text).toContain('HTTP 429')
  expect(text).toContain('rate_limit_error')
  expect(text).toContain('5h 100%')
  expect(text).not.toContain('cut off')
  expect(result.stopReason).toBe('end_turn')
})

test('chat: a limit reported inside the stream comes back like a 429, with the reset times', async ($, on) => {
  world(on, [{ content: '', streamError: { code: 429, message: 'Rate limit exceeded' } }], { rolling: 100 })
  await start($)
  const r: any = await ($.tool.call as any)({ tool: CHAT, prompt: 'x', model: 'glm-5.3-flash' })
  expect(refusal(r)).toContain('HTTP 429, in the stream')
  expect(refusal(r)).toContain('limit reached')
  expect(refusal(r)).toContain('5h 100%')
})

const WORKER_OPTS = { options: { worker_agent: true, default_model: 'glm-5.3-flash' } }

test('worker: registered only with its option, with edit tools and a review-it-yourself guide', WORKER_OPTS, async ($, on) => {
  on('prompt.compose', () => ({ sections: [] }))
  const w = world(on, [{ content: 'x' }])
  await start($)
  expect(w.agents.map(a => a.name)).toEqual(['worker'])
  expect(w.agents[0].tools).toEqual(['Read', 'Edit', 'Write', 'Bash'])
  expect(w.agents[0].prompt).toContain('Never git commit')
  const r: any = await ($ as any).prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] })
  const guide = r.sections.find((x: any) => x.id === 'opencode-go-worker:worker')?.text
  expect(guide).toContain('git diff --stat')
  expect(guide).toContain('server-side safety review')
  expect(r.sections.map((x: any) => x.id)).not.toContain('opencode-go-worker:explore')
})

test('worker: its steps go to Go with the worker prompt and edit schemas; the band names it', WORKER_OPTS, async ($, on) => {
  on('turn.step', async function* () {
    throw new Error('Claude must not be asked')
  })
  const w = world(on, [{ content: 'x' }], {
    steps: [{ tool: { id: 'e1', name: 'Edit', input: { file_path: '/work/src/register.tsx', old_string: 'a', new_string: 'b' } } }],
  })
  await start($)
  const { chunks, result } = await step($, 'ag-worker')
  const body = w.exploreBodies[0]
  expect(body.system).toContain('coding worker')
  expect(body.max_tokens).toBe(32000)
  expect(body.tools.map((t: any) => t.name)).toEqual(['Read', 'Edit', 'Write', 'Bash'])
  expect(body.tools.find((t: any) => t.name === 'Bash').input_schema.properties.timeout).toBeDefined()
  expect(body.tools.find((t: any) => t.name === 'Edit').input_schema.required).toEqual(['file_path', 'old_string', 'new_string'])
  expect(result.toolUses[0]).toEqual({ id: 'e1', name: 'Edit', input: { file_path: '/work/src/register.tsx', old_string: 'a', new_string: 'b' } })
  expect(chunks.at(-1)).toMatchObject({ kind: 'stop', stopReason: 'tool_use' })
  const ui = await ($.ui as any).mount(bandWith(140))
  expect((await ui.find({ type: 'Text', text: /5h/ }))?.text).toBe('worker step 1 · Edit register.tsx · 5h 4%')
  await ui.unmount()
})

test('worker: with only explore on, a worker-type agent is left to Claude', EXPLORE_OPTS, async ($, on) => {
  on('turn.step', async function* () {
    yield { kind: 'text', index: 0, text: 'from claude' }
    return { turnId: 't1', index: 0, answer: 'from claude', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  const w = world(on, [{ content: 'x' }])
  await start($)
  const { result } = await step($, 'ag-worker')
  expect(result.answer).toBe('from claude')
  expect(w.exploreBodies.length).toBe(0)
})

test('explore: its Bash schema stays the read-only one', EXPLORE_OPTS, async ($, on) => {
  const w = world(on, [{ content: 'x' }])
  await start($)
  await step($, 'ag-explore')
  const bash = w.exploreBodies[0].tools.find((t: any) => t.name === 'Bash')
  expect(bash.description).toContain('read-only')
  expect(bash.input_schema.properties.timeout).toBeUndefined()
})
