import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyTurnEvent, blockingTurn, closeCommandFor, TurnTransitionError, type TurnState } from '../src/turn-state.js'

const prompt = (turn = 'g1') => applyTurnEvent(undefined, { type: 'prompt', hostTaskKey: 's1', hostTurnKey: turn, question: 'Q', promptCursor: 3 })

test('business turn: start, stop with a completed answer, finish with that answer', () => {
  let s = prompt()
  s = applyTurnEvent(s, { type: 'interaction-started', interactionId: 'int_1', conversationId: 'conv_1' })
  s = applyTurnEvent(s, { type: 'stop', resolution: { kind: 'completed', answer: 'A' } })
  assert.equal(s.phase, 'pending_close')
  assert.deepEqual(closeCommandFor(s), { interactionId: 'int_1', outcome: 'completed', answer: 'A' })
  s = applyTurnEvent(s, { type: 'close-confirmed', outcome: 'completed' })
  assert.equal(s.phase, 'closed')
  assert.equal(closeCommandFor(s), undefined)
})

test('turn without business calls creates no interaction', () => {
  const s = applyTurnEvent(prompt(), { type: 'stop', resolution: { kind: 'completed', answer: 'A' } })
  assert.equal(s.phase, 'no_business')
  assert.equal(closeCommandFor(s), undefined)
})

test('cancelled turn closes as cancelled', () => {
  let s = applyTurnEvent(prompt(), { type: 'interaction-started', interactionId: 'int_1', conversationId: 'conv_1' })
  s = applyTurnEvent(s, { type: 'stop', resolution: { kind: 'cancelled' } })
  assert.equal(closeCommandFor(s)?.outcome, 'cancelled')
})

test('unresolved answer produces no close command; retry can resolve it', () => {
  let s = applyTurnEvent(prompt(), { type: 'interaction-started', interactionId: 'int_1', conversationId: 'conv_1' })
  s = applyTurnEvent(s, { type: 'stop', resolution: { kind: 'unresolved', reason: 'answer-precedes-turn' } })
  assert.equal(closeCommandFor(s), undefined)
  s = applyTurnEvent(s, { type: 'resolution-retried', resolution: { kind: 'completed', answer: 'late' } })
  assert.equal(s.resolveAttempts, 2)
  assert.deepEqual(closeCommandFor(s), { interactionId: 'int_1', outcome: 'completed', answer: 'late' })
})

test('platform-terminated interaction becomes unresolved, not completed', () => {
  let s = applyTurnEvent(prompt(), { type: 'interaction-started', interactionId: 'int_1', conversationId: 'conv_1' })
  s = applyTurnEvent(s, { type: 'platform-terminal', status: 'abandoned' })
  assert.equal(s.phase, 'unresolved')
  assert.equal(s.outcome, undefined)
})

test('invalid transitions are rejected', () => {
  assert.throws(() => applyTurnEvent(undefined, { type: 'stop', resolution: { kind: 'cancelled' } }), TurnTransitionError)
  assert.throws(() => applyTurnEvent(prompt(), { type: 'close-confirmed', outcome: 'completed' }), TurnTransitionError)
  const started = applyTurnEvent(prompt(), { type: 'interaction-started', interactionId: 'i', conversationId: 'c' })
  assert.throws(() => applyTurnEvent(started, { type: 'interaction-started', interactionId: 'j', conversationId: 'c' }), TurnTransitionError)
  assert.throws(() => applyTurnEvent(prompt(), { type: 'prompt', hostTaskKey: 's1', hostTurnKey: 'g1', question: 'Q', promptCursor: 0 }), TurnTransitionError)
})

test('an open earlier turn blocks a new interaction in the same task only', () => {
  const open: TurnState = applyTurnEvent(prompt('g1'), { type: 'interaction-started', interactionId: 'i', conversationId: 'c' })
  const other: TurnState = { ...open, hostTaskKey: 's2' }
  assert.equal(blockingTurn([open, other], 's1', 'g2'), open)
  assert.equal(blockingTurn([open], 's1', 'g1'), undefined)
  assert.equal(blockingTurn([other], 's1', 'g2'), undefined)
})
