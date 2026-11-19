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

// The language people read, decided once per session for the `language` option it was decided under
export type UiLang = { option: string; lang: 'en' | 'ko' } | null

declare module 'claude-code' {
  interface PluginState {
    'opencode-go-worker': { totals: Shaped<Usage>; limits: Shaped<Limits>; uiLang: Shaped<UiLang>; model: Shaped<string | null> }
  }
}
