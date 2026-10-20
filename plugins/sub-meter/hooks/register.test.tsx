// Mod tests, run against the engine itself: `claude plugin test .`
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionRateLimit } from 'claude-code'

const NOW = Date.parse('2026-10-12T10:00:00Z')
const at = (ms: number) => new Date(NOW + ms).toISOString()
const HOUR = 3_600_000
const LIMITS: SessionRateLimit[] = [
  { kind: 'five_hour', percentUsed: 58, resetsAt: at(2 * HOUR + 10 * 60_000) },
  { kind: 'seven_day', percentUsed: 23.5, resetsAt: at(76 * HOUR) }
]

/** Everything beneath the mod: the clock, the store, the session's usage and what the engine draws. */
function world (on: On, rateLimits: SessionRateLimit[] = LIMITS) {
  const clock = mock.clock(on, { now: NOW })
  const store: Record<string, unknown> = {}
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits } as never }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  // The engine's own node, as core answers it; with mode labels, a Box the tests find.
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    if ('hint' in e.props) return <Text>{e.props.hint}</Text>
    return e.props.modes.length > 0 ? <Box key="engine" /> : ({ type: 'engine', ref: 0 } as const)
  })
  return { clock, store }
}

const startSession = ($: Engine) => $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
const footer = ($: Engine, modes: string[] = []) =>
  $.ui.mount({ plugin: 'sub-meter', surface: 'terminal', component: 'SessionMode', props: { modes } })
const hint = ($: Engine, text: string) =>
  $.ui.mount({ plugin: 'sub-meter', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: text } })

test('shows the 5-hour window first, as a bar with the time until it resets', async ($, on) => {
  world(on)
  await startSession($)
  const ui = await footer($)
  expect(await ui.find({ type: 'Text', text: '5h ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '━━━━━━' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '────' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 58%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' ↻ 2h 10m' })).toBeDefined()
})

test('takes turns with the weekly window', async ($, on) => {
  const w = world(on)
  await startSession($)
  await w.clock.advance(8000)
  const ui = await footer($)
  expect(await ui.find({ type: 'Text', text: 'week ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 24%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' ↻ 3d 4h' })).toBeDefined()
})

test('takes turns as often as rotateSeconds says', { options: { rotateSeconds: 30 } }, async ($, on) => {
  const w = world(on)
  await startSession($)
  await w.clock.advance(8000)
  expect(await (await footer($)).find({ type: 'Text', text: '5h ' })).toBeDefined()
  await w.clock.advance(22_000)
  expect(await (await footer($)).find({ type: 'Text', text: 'week ' })).toBeDefined()
})

test('alone, with no mode labels, the meter ends the footer', async ($, on) => {
  world(on)
  await startSession($)
  const ui = await footer($)
  expect((await ui.findAll({ type: 'Text' })).at(-1)?.text).toBe(' ↻ 2h 10m')
})

test("keeps the engine's mode labels after the meter", async ($, on) => {
  world(on)
  await startSession($)
  const ui = await footer($, ['focus'])
  const row = await ui.drawn()
  expect(row.children?.at(-1)).toMatchObject({ props: { key: 'engine' } })
  expect((await ui.findAll({ type: 'Text' })).map(text => text.text)).toEqual(['5h ', '━━━━━━', '────', ' 58%', ' ↻ 2h 10m', ' · '])
})

test("keeps another plugin's drawing there after the meter, so it stays last", async ($, on) => {
  // Beneath the meter: another plugin's switch, where the engine has no labels to draw.
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{'⏵ narrator on'}</Text>
  })
  world(on)
  await startSession($)
  const ui = await footer($)
  expect((await ui.findAll({ type: 'Text' })).map(text => text.text).slice(-3)).toEqual([' ↻ 2h 10m', ' · ', '⏵ narrator on'])
})

test('off a subscription the engine draws its own footer', async ($, on) => {
  world(on, [])
  await startSession($)
  const ui = await footer($, ['focus'])
  expect(await ui.find({ key: 'engine' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '5h ' })).toBeUndefined()
})

test('a new measurement shows at once and is kept for the next session', async ($, on) => {
  const w = world(on, [])
  await startSession($)
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [{ ...LIMITS[0], percentUsed: 91 }], changed: ['rateLimits'] } as never)
  const ui = await footer($)
  const used = await ui.find({ type: 'Text', text: '━━━━━━━━━' })
  expect(used?.props.color).toBe('error')
  expect(w.store.limits).toEqual([{ ...LIMITS[0], percentUsed: 91 }])
})

test('a window past its reset shows as empty', async ($, on) => {
  const w = world(on)
  await startSession($)
  await w.clock.set(NOW + 3 * HOUR)
  const ui = await footer($)
  expect(await ui.find({ type: 'Text', text: ' 0%' })).toBeDefined()
})

test('drops the cycle hint from the line after the mode', async ($, on) => {
  world(on)
  const ui = await hint($, '(shift+tab to cycle) · ← for agents')
  expect(await ui.find({ type: 'Text', text: '← for agents' })).toBeDefined()
})

test('keeps what is around the cycle hint, without empty parts', async ($, on) => {
  world(on)
  const ui = await hint($, 'esc to interrupt (shift+tab to cycle) ·  · ctrl+t to hide tasks')
  expect(await ui.find({ type: 'Text', text: 'esc to interrupt · ctrl+t to hide tasks' })).toBeDefined()
})

test('leaves every other hint as it is', async ($, on) => {
  world(on)
  const ui = await hint($, '? for shortcuts')
  expect(await ui.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
})
