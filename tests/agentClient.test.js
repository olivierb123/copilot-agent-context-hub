import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runHarnessQuery } from '../src/agentClient.js'

test('preserves the backend explanation for a stopped proof allowance', async () => {
  const originalFetch = globalThis.fetch
  const errors = []
  const message = 'Canary proof stopped, pending or consumed; no retry is authorized'
  globalThis.fetch = async () => new Response(JSON.stringify({ error: message }), {
    status: 409, headers: { 'Content-Type': 'application/json' },
  })
  try {
    await runHarnessQuery('Question', { onError: (error) => errors.push(error) })
    assert.deepEqual(errors, [message])
  } finally { globalThis.fetch = originalFetch }
})

test('uses an HTTP fallback when an error body is not valid JSON', async () => {
  const originalFetch = globalThis.fetch
  const errors = []
  globalThis.fetch = async () => new Response('Not JSON', {
    status: 502, statusText: 'Bad Gateway', headers: { 'Content-Type': 'application/json' },
  })
  try {
    await runHarnessQuery('Question', { onError: (error) => errors.push(error) })
    assert.deepEqual(errors, ['Agent request failed: 502 Bad Gateway'])
  } finally { globalThis.fetch = originalFetch }
})

async function receive(events, separator = '\n\n', terminate = true) {
  const observations = { text: '', completed: 0, errors: [] }
  const originalFetch = globalThis.fetch
  const body = events.map((event) => `data: ${JSON.stringify(event)}`).join(separator)
    + (terminate ? separator : '')
  globalThis.fetch = async () => new Response(body, {
    headers: { 'Content-Type': 'text/event-stream' },
  })
  try {
    await runHarnessQuery('Question', {
      onText: (text) => { observations.text = text },
      onDone: () => { observations.completed += 1 },
      onError: (message) => { observations.errors.push(message) },
    })
  } finally {
    globalThis.fetch = originalFetch
  }
  return observations
}

test('preserves assistant text from multiple response items', async () => {
  const result = await receive([
    { type: 'response.output_text.delta', item_id: 'first', delta: 'First answer.' },
    { type: 'response.output_text.delta', item_id: 'second', delta: 'Second answer.' },
    { type: 'response.completed' },
  ])
  assert.equal(result.text, 'First answer.\n\nSecond answer.')
  assert.equal(result.completed, 1)
  assert.deepEqual(result.errors, [])
})

test('accepts CRLF SSE frames and an unterminated final frame', async () => {
  const result = await receive([
    { type: 'response.output_text.delta', item_id: 'first', delta: 'Answer' },
    { type: 'response.completed' },
  ], '\r\n\r\n', false)
  assert.equal(result.text, 'Answer')
  assert.equal(result.completed, 1)
  assert.deepEqual(result.errors, [])
})

test('reports a truncated stream instead of silently succeeding', async () => {
  const result = await receive([
    { type: 'response.output_text.delta', item_id: 'first', delta: 'Partial' },
  ])
  assert.equal(result.completed, 0)
  assert.match(result.errors[0], /before completion/i)
})

test('reports an agent failure exactly once', async () => {
  const result = await receive([
    { type: 'response.failed', response: { error: { message: 'Tool denied' } } },
  ])
  assert.equal(result.completed, 0)
  assert.deepEqual(result.errors, ['Tool denied'])
})

test('uses completed response text instead of retaining intermediate progress narration', async () => {
  const result = await receive([
    { type: 'response.output_text.delta', item_id: 'progress', delta: 'Retrieving documents...' },
    { type: 'response.completed', response: { output: [{ type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'FieldForge comparison [DOC-2, updated 2026-08-20].' }],
    }] } },
  ])
  assert.equal(result.text, 'FieldForge comparison [DOC-2, updated 2026-08-20].')
  assert.equal(result.completed, 1)
})