import { expect, test } from 'claude-code/testing'

const CHAT = 'mcp__opencode-go-worker__go_chat'
const MODELS = 'mcp__opencode-go-worker__go_models'

type Reply = { content: string; finish?: string; usage?: Record<string, unknown>; status?: number; error?: string; cut?: boolean }

type WorldOptions = {
  disabled?: boolean
  keyFile?: boolean
  limitsStatus?: number
  rolling?: number
  files?: Record<string, string>
  env?: Record<string, string>
}

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

  on('command.register', () => ({ value: { command: 'go-usage' } }))
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
          rolling: w(opts.rolling ?? 4, '2026-11-19T21:10:37.000Z'),
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
    const line = e.input.split('\n').find((l: string) => l.startsWith('data-binary = '))
    const body = JSON.parse(JSON.parse(line.slice('data-binary = '.length)))
    sent.push(body)
    const r = replies[(sent.length - 1) % replies.length]!
    if (r.status && r.status >= 400) {
      yield { stream: 'stdout', text: `${r.error ?? '{"error":{"message":"rate limited"}}'}\n[[go-worker-http ${r.status}]]` }
      return { value: { code: 0, signal: null } }
    }
    const chunk = (x: unknown) => `data: ${JSON.stringify(x)}\n\n`
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
  return { sent, configs, argvs, fetched, statuses, written, files }
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
  expect(w.statuses.at(-1)).toBe('1 call 4.0Ktok cache 81% · 5h 4% wk 1%')
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
  expect(w.statuses.at(-1)).toBe('1 call 4.0Ktok cache 81%')
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
  expect(w.statuses.at(-1)).toBe('2 calls 8.0Ktok cache 81% · 5h 4% wk 1%')
  await start($)
  expect(w.statuses.at(-1)).toBe('2 calls 8.0Ktok cache 81% · 5h 4% wk 1%')
})
