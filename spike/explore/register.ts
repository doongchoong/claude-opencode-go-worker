import type { EngineInterface, Register } from 'claude-code'

// Spike for opencode-go-worker v0.2: can a turn.step hook answer a subagent's model steps itself
// (no `next`), with the engine running the tool calls it yields and looping back with their results?
// Read-only agent; its steps go to OpenCode Go's Anthropic-compatible endpoint, not to Claude.

const AGENT = 'go-explore-spike:explore'
const MODEL = 'glm-5.3-flash'
const URL = 'https://opencode.ai/inference/go/anthropic/v1/messages'

const PROMPT = `You are a read-only explorer working for a higher-level agent (Claude).
Use the Read tool to look at files, then answer briefly with what you found and the file paths.
Never guess file contents; read them. Stop as soon as you can answer.`

// $.tool.list() gives names only, so the schemas are written out here
const TOOLS = [
  {
    name: 'Read',
    description: 'Reads a file from the local filesystem. file_path must be absolute.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The absolute path to the file to read' },
        offset: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['file_path'],
    },
  },
]

async function key($: EngineInterface) {
  const home = (await $.env.get('HOME')) || ''
  return (await $.fs.read(`${home}/.config/opencode-go/api_key`)).trim()
}

async function isOurs($: EngineInterface, agentId: string | undefined) {
  if (!agentId) return false
  const agents = await $.agent.list()
  return agents.some(a => a.id === agentId && a.type === AGENT)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.agent.register({
        name: 'explore',
        description: 'SPIKE ONLY: read-only file explorer whose model is OpenCode Go (glm-5.3-flash), not Claude.',
        prompt: PROMPT,
        tools: ['Read'],
        maxTurns: 8,
      } as Parameters<typeof $.agent.register>[0])
    } catch (err) {
      $.ui.log(`go-explore-spike: register failed: ${(err as Error).message}`)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!(await isOurs($, e.agentId))) return yield* next(e)

    const msgs = await $.session.messages({ agentId: e.agentId!, as: 'api' } as never)
    if (!Array.isArray(msgs)) {
      $.ui.log(`go-explore-spike: messages denied: ${JSON.stringify(msgs).slice(0, 200)}`)
      return yield* next(e)
    }
    // Thinking blocks carry Claude signatures another model can't use; drop them
    const messages = (msgs as { role: string; content: { type: string }[] }[]).map(m => ({
      role: m.role,
      content: m.content.filter(b => b.type !== 'thinking' && b.type !== 'redacted_thinking'),
    }))

    const r = await $.http.fetch(URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await key($)}`,
        'x-opencode-session': `ccgo-spike-${e.agentId}`,
        'User-Agent': 'opencode-go-worker/0.2.0-spike',
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 4096, system: PROMPT, tools: TOOLS, messages }),
    })
    $.ui.log(`go-explore-spike: step ${e.index} → HTTP ${r.status}, ${messages.length} messages`)
    if (!r.ok) {
      yield { kind: 'text', index: 0, text: `[go-explore-spike] OpenCode Go HTTP ${r.status}: ${r.text.slice(0, 300)}` }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
    }
    const res = JSON.parse(r.text) as {
      content: ({ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown } | { type: string })[]
      stop_reason: string
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
    }

    let answer = ''
    const toolUses: { id: string; name: string; input: unknown }[] = []
    let i = 0
    for (const b of res.content) {
      if (b.type === 'text' && 'text' in b) {
        answer += b.text
        yield { kind: 'text', index: i++, text: b.text }
      } else if (b.type === 'tool_use' && 'id' in b) {
        toolUses.push({ id: b.id, name: b.name, input: b.input })
        yield { kind: 'tool', index: i, id: b.id, name: b.name }
        yield { kind: 'input', index: i++, json: JSON.stringify(b.input ?? {}) }
      }
    }
    const usage = {
      input_tokens: res.usage?.input_tokens ?? 0,
      output_tokens: res.usage?.output_tokens ?? 0,
      cache_read_input_tokens: res.usage?.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: res.usage?.cache_creation_input_tokens ?? 0,
      model: MODEL,
    }
    const stopReason = toolUses.length ? 'tool_use' : 'end_turn'
    $.ui.log(`go-explore-spike: step ${e.index}: ${toolUses.map(t => t.name).join(', ') || 'answer'} (stop ${res.stop_reason})`)
    yield { kind: 'stop', stopReason, usage } as never
    return { turnId: e.turnId, index: e.index, answer, toolUses, stopReason, usage } as never
  })
}
