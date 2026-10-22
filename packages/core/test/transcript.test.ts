import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTranscript, resolveTurnAnswer } from '../src/transcript.js'

// Synthetic records shaped like WorkBuddy 5.6.2 transcripts (R0b-2): no real content.
const line = (o: Record<string, unknown>) => JSON.stringify(o) + '\n'
const user = (id: string, parentId: string | undefined, text: string) => line({ type: 'message', role: 'user', id, ...(parentId ? { parentId } : {}), content: [{ type: 'input_text', text: `<wrapped>${text}</wrapped>` }] })
const assistant = (id: string, parentId: string, status: string, text: string) => line({ type: 'message', role: 'assistant', status, id, parentId, content: [{ type: 'output_text', text }] })
const meta = (id: string) => line({ type: 'session-meta', id })
const reasoning = (id: string, parentId: string) => line({ type: 'reasoning', id, parentId, content: [] })
const call = (id: string, parentId: string) => line({ type: 'function_call', id, parentId, callId: `c-${id}`, name: 'DeferExecuteTool' })
const result = (id: string, parentId: string) => line({ type: 'function_call_result', id, parentId, callId: `c-${parentId}`, status: 'completed' })

const turn1 = meta('m1') + meta('m2') + user('u1', undefined, 'Q1') + reasoning('r1', 'u1') + call('f1', 'r1') + result('f1r', 'f1') + assistant('a1', 'f1r', 'completed', 'ANSWER-1')

test('completed turn: answer found through the parent chain and matched with Stop', () => {
  const r = resolveTurnAnswer({ transcript: parseTranscript(turn1), promptCursor: 2, lastAssistantMessage: 'ANSWER-1' })
  assert.deepEqual(r, { kind: 'completed', answer: 'ANSWER-1', assistantRecordId: 'a1' })
})

test('cancelled turn: incomplete assistant record is a cancellation, never completed', () => {
  const text = turn1 + user('u2', 'a1', 'Q2') + reasoning('r2', 'u2') + call('f2', 'r2') + assistant('a2', 'f2', 'incomplete', 'placeholder-19-chars')
  const r = resolveTurnAnswer({ transcript: parseTranscript(text), promptCursor: 7, lastAssistantMessage: 'placeholder-19-chars' })
  assert.equal(r.kind, 'cancelled')
})

test('Stop before the new answer is written: the last answer belongs to an earlier turn', () => {
  const text = turn1 + user('u2', 'a1', 'Q2')
  const r = resolveTurnAnswer({ transcript: parseTranscript(text), promptCursor: 7 })
  assert.deepEqual(r, { kind: 'unresolved', reason: 'answer-precedes-turn' })
})

test('edited resend: the answer on the new branch is attributed to the new turn', () => {
  const branchA = turn1 + user('u2', 'a1', 'Q2') + assistant('a2', 'u2', 'completed', 'ANSWER-2')
  const fork = line({ type: 'resend-fork-notice', id: 'fk', parentId: 'a1', editedUserItemId: 'u2' })
  const text = branchA + meta('m3') + fork + user('u2e', 'a1', 'Q2 edited') + assistant('a2e', 'u2e', 'completed', 'ANSWER-2E')
  const cursor = parseTranscript(branchA + meta('m3') + fork).records.length
  const r = resolveTurnAnswer({ transcript: parseTranscript(text), promptCursor: cursor, lastAssistantMessage: 'ANSWER-2E' })
  assert.deepEqual(r, { kind: 'completed', answer: 'ANSWER-2E', assistantRecordId: 'a2e' })
})

test('trailing line still being written is skipped and reported', () => {
  const text = turn1 + '{"type":"message","role":"assistant","status":"compl'
  const parsed = parseTranscript(text)
  assert.equal(parsed.trailingPartial, true)
  assert.equal(parsed.records.length, 7)
})

test('mismatch with Stop.last_assistant_message stays unresolved', () => {
  const r = resolveTurnAnswer({ transcript: parseTranscript(turn1), promptCursor: 2, lastAssistantMessage: 'something else' })
  assert.deepEqual(r, { kind: 'unresolved', reason: 'stop-message-mismatch' })
})

test('broken parent chain and unknown status stay unresolved', () => {
  const orphan = meta('m1') + user('u1', undefined, 'Q') + assistant('a1', 'missing', 'completed', 'X')
  assert.deepEqual(resolveTurnAnswer({ transcript: parseTranscript(orphan), promptCursor: 1 }), { kind: 'unresolved', reason: 'broken-parent-chain' })
  const odd = meta('m1') + user('u1', undefined, 'Q') + assistant('a1', 'u1', 'streaming', 'X')
  assert.deepEqual(resolveTurnAnswer({ transcript: parseTranscript(odd), promptCursor: 1 }), { kind: 'unresolved', reason: 'unknown-status' })
})

test('empty completed answer is not accepted as a final answer', () => {
  const text = meta('m1') + user('u1', undefined, 'Q') + assistant('a1', 'u1', 'completed', '   ')
  assert.deepEqual(resolveTurnAnswer({ transcript: parseTranscript(text), promptCursor: 1 }), { kind: 'unresolved', reason: 'empty-answer' })
})

test('parent cycles terminate', () => {
  const text = meta('m1') + line({ type: 'reasoning', id: 'x', parentId: 'y' }) + line({ type: 'reasoning', id: 'y', parentId: 'x' }) + assistant('a', 'x', 'completed', 'X')
  assert.deepEqual(resolveTurnAnswer({ transcript: parseTranscript(text), promptCursor: 0 }), { kind: 'unresolved', reason: 'broken-parent-chain' })
})
