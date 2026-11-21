// Tokens spent on the OpenCode Go worker in this session
export type Usage = {
  calls: number
  // Uncached input (opencode.tokens.input already leaves out cache reads)
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  // Sum of opencode.allowance reported per request (USD of the plan's monthly allowance)
  allowance: number
  lastIn: number
  lastOut: number
  model: string
}

// Plan windows from the (undocumented) usage endpoint: percent used and reset time
export type Window = { status: string; percent: number; resetsAt: string }
export type Limits = { rolling?: Window; weekly?: Window; monthly?: Window; checkedAt: number } | null

// Go agents at work (explore, worker), by agent id: which one, the step it is on and what it is doing
// `who`: the model, for go_chat, whose step is 0
export type Exploring = Record<string, { name?: string; step: number; doing: string; who?: string }>

// The language people read, decided once per session for the `language` option it was decided under
export type UiLang = { option: string; lang: 'en' | 'ko' } | null

declare module 'claude-code' {
  interface PluginState {
    'opencode-go-worker': {
      // Shared by every session
      limits: Shaped<Limits>
      uiLang: Shaped<UiLang>
      plan: Shaped<string | null>
      // One per session id: the session's own usage, picked model and agents at work
      totalsBySession: StateFamily<Usage>
      modelBySession: StateFamily<string>
      exploringBySession: StateFamily<Exploring>
    }
  }
}
