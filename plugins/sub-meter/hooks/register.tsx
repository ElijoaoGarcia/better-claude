import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderNode, SessionRateLimit } from 'claude-code'

import type { Limit } from '../types'

const limits = atom({ plugin: 'sub-meter', key: 'limits' } as const, [] as Limit[])
const view = atom({ plugin: 'sub-meter', key: 'view' } as const, 0)

const WINDOWS = ['five_hour', 'seven_day']
const LABELS: Record<string, string> = { five_hour: '5h', seven_day: 'week' }
const ROTATE_SECONDS = 8
const CELLS = 10
const CYCLE_HINT = /\s*\([^()]+ to cycle\)/

/** The subscription windows the meter shows, in order, from what the engine measured. */
const windowsOf = (rateLimits: readonly SessionRateLimit[]): Limit[] =>
  WINDOWS.flatMap(kind => {
    const found = rateLimits.find(limit => limit.kind === kind)
    return found ? [{ kind, percentUsed: found.percentUsed, resetsAt: found.resetsAt }] : []
  })

/** Whether a drawing beneath shows nothing: no text, no control (the engine's own node draws `modes`, counted apart). */
function isBlank (node: RenderNode | undefined): boolean {
  if (node === undefined || node === null) return true
  if (typeof node === 'string') return node.trim() === ''
  if (node.type === 'engine') return true
  return (node.type === 'Box' || node.type === 'Text') && (node.children ?? []).every(isBlank)
}

const colorFor = (percent: number) => (percent >= 90 ? 'error' : percent >= 75 ? 'warning' : 'claude')

/** "42m", "3h 5m", "2d 4h": how long until the window resets. */
function until (ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** Keeps the latest reading for the meter, and for the next session until a response reports again. */
async function remember ($: EngineInterface, found: Limit[]) {
  if (found.length === 0) return
  await update($, limits, () => found)
  await $.store.set('limits', found)
}

export const register: Register = (on, options) => {
  const hideCycleHint = options.hideCycleHint !== false
  const rotateSeconds = Number(options.rotateSeconds)
  const rotateMs = (rotateSeconds > 0 ? rotateSeconds : ROTATE_SECONDS) * 1000

  on('session.start', async ($, e, next) => {
    const saved = await $.store.get('limits')
    if (Array.isArray(saved)) await update($, limits, () => saved as Limit[])

    const usage = await $.session.usage()
    await remember($, windowsOf(usage.rateLimits))

    $.clock.every(rotateMs, () => { void update($, view, n => n + 1) })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await remember($, windowsOf(e.rateLimits))
    return next(e)
  })

  // Bottom right of the prompt footer: the meter, then what is beneath it (the engine's mode labels,
  // another plugin's switch), so a plugin that draws itself last stays last whichever wraps the other.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const all = await read($, limits)
    if (all.length === 0) return next(e)

    const now = await $.clock.now()
    const shown = all[(await read($, view)) % all.length]
    const resetsIn = shown.resetsAt === undefined ? undefined : Date.parse(shown.resetsAt) - now
    const hasReset = resetsIn !== undefined && resetsIn <= 0
    const percent = hasReset ? 0 : shown.percentUsed
    const filled = Math.round((Math.min(Math.max(percent, 0), 100) / 100) * CELLS)
    const beneath = await next(e)
    const hasBeneath = e.props.modes.length > 0 || !isBlank(beneath)
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row">
        <Text dimColor>{LABELS[shown.kind] ?? shown.kind} </Text>
        <Text color={colorFor(percent)}>{'━'.repeat(filled)}</Text>
        <Text dimColor>{'─'.repeat(CELLS - filled)}</Text>
        <Text> {Math.round(percent)}%</Text>
        {resetsIn !== undefined && !hasReset ? <Text dimColor> ↻ {until(resetsIn)}</Text> : null}
        {hasBeneath ? <Text dimColor> · </Text> : null}
        {beneath}
      </Box>
    )
  })

  // The engine draws the mode label itself; the hint line after it starts with "(shift+tab to cycle)".
  if (hideCycleHint) {
    on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
      if (!CYCLE_HINT.test(e.props.hint)) return next(e)

      const hint = e.props.hint
        .replace(CYCLE_HINT, ' · ')
        .split('·')
        .map(part => part.trim())
        .filter(Boolean)
        .join(' · ')
      return next({ ...e, props: { ...e.props, hint } })
    })
  }
}
