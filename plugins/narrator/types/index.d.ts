declare module 'claude-code' {
  interface PluginState {
    narrator: {
      /** Whether Claude tells, out loud, what it did after each turn. */
      isEnabled: boolean
      /** What this session is saying, null when it is not: `waiting`, how many narrations wait their turn behind it. */
      speech: { waiting: number } | null
      /** How far the sweep across the switch has gone while it speaks, a step a tenth of a second. */
      sweepStep: number
    }
  }
}
