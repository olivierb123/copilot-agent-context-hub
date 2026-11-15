import assert from 'node:assert/strict'
import { test } from 'node:test'
import { captureCompletedWork, createSnapshotConversation, inheritedIndexWasRead, runHarnessTurn } from '../server/harnessRuntime.js'

test('index-read evidence requires the actual index file and a successful matching native output', () => {
  const output = [
    { type: 'function_call', name: 'view', call_id: 'read', arguments: '{"path":"/workspace/inherited-work-index.txt"}' },
    { type: 'function_call_output', call_id: 'read', output: '{"hash":"actual-hash"}' },
  ]
  assert.equal(inheritedIndexWasRead({ output }, 'actual-hash'), true)
  assert.equal(inheritedIndexWasRead({ output }, 'wrong-hash'), false)
  assert.equal(inheritedIndexWasRead({ output: [output[0], { ...output[1], status: 'failed' }] }, 'actual-hash'), false)
  assert.equal(inheritedIndexWasRead({ output: [output[0], { ...output[1], output: '{"error":"actual-hash"}' }] }, 'actual-hash'), false)
  assert.equal(inheritedIndexWasRead({ output: [{ ...output[0], arguments: '{"path":"/other.txt"}' }, output[1]] }, 'actual-hash'), false)
})

test('credential-like content blocks capture instead of being silently redacted or copied', () => {
  const work = captureCompletedWork({ status: 'completed', output: [
    { type: 'function_call', name: 'task', call_id: 'task' },
    { type: 'function_call_output', call_id: 'task', output: '{"access_token":"PRIVATE"}' },
    { type: 'message', content: [{ annotations: [{ type: 'url_citation', url: 'https://example.test/file?sig=PRIVATE' }] }] },
  ] })
  assert.equal(work.records.length, 0)
  assert.equal(work.omissions.length, 2)
  assert(work.omissions.every((entry) => entry.blocking))
  assert.doesNotMatch(JSON.stringify(work), /PRIVATE/)
})

test('completed work preserves exact source and finding content beyond UI limits, never protected state', () => {
  const text = 'Original data\n'.repeat(10_000)
  const work = captureCompletedWork({ status: 'completed', usage: { input_tokens: 123, output_tokens: 45, total_tokens: 168, secret: 'excluded' }, output: [
    { type: 'mcp_call', id: 'fabric-1', name: 'fabric-sales___DataAgent', status: 'completed', arguments: '{"userQuestion":"Original query","token":"SECRET"}',
      output: JSON.stringify([{ type: 'text', text }]) },
    { type: 'function_call', name: 'task', call_id: 'task-1', arguments: '{}' },
    { type: 'function_call_output', call_id: 'task-1', output: text },
    { type: 'reasoning', encrypted_content: 'SECRET' }, { type: 'mcp_approval_response', approve: true, approval_request_id: 'SECRET' },
    { type: 'message', id: 'msg-1', content: [{ annotations: [{ type: 'url_citation', url: 'https://example.test/source', title: 'Source', start_index: 5, end_index: 12 }] }] },
  ] })
  assert.equal(work.records[0].text, text)
  assert.equal(work.records[1].text, text)
  assert.deepEqual(work.records[2], { kind: 'citation', message_id: 'msg-1', content_index: 0, url: 'https://example.test/source', title: 'Source', start_index: 5, end_index: 12 })
  assert.deepEqual(work.usage, { input_tokens: 123, output_tokens: 45, total_tokens: 168 })
  assert.equal(work.tool_calls, 2)
  assert.doesNotMatch(JSON.stringify(work), /SECRET|approve|encrypted_content/)
})

test('completed work reports oversized outputs without truncation and sanitizes failures', () => {
  const work = captureCompletedWork({ status: 'completed', output: [
    { type: 'function_call', name: 'task', call_id: 'huge' },
    { type: 'function_call_output', call_id: 'huge', output: 'x'.repeat(1_048_577) },
    { type: 'mcp_call', id: 'failed', name: 'fabric-sales___DataAgent', status: 'failed', error: 'PRIVATE', output: 'PRIVATE' },
    { type: 'function_call', name: 'shell', call_id: 'shell' },
    { type: 'function_call_output', call_id: 'shell', output: 'PRIVATE' },
  ] })
  assert.equal(work.records.length, 1)
  assert.equal(work.records[0].status, 'failed')
  assert.deepEqual(work.omissions, [{ call_id: 'huge', reason: 'capture_limit', blocking: true }, { call_id: 'shell', reason: 'unsupported_tool_output' }])
  assert.doesNotMatch(JSON.stringify(work), /PRIVATE/)
  assert.throws(() => captureCompletedWork({ status: 'incomplete', output: [] }), /Only completed/)
})

test('snapshot creation copies exact visible text in bounded native item batches without inference', async () => {
  const messages = Array.from({ length: 22 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `Exact text ${index}\nSource date: unknown.` }))
  const requests = []
  const client = { conversations: {
    create: async (body) => { requests.push(body.items); return { id: 'conv-new' } },
    items: { create: async (id, body) => { assert.equal(id, 'conv-new'); requests.push(body.items) } },
  } }
  assert.deepEqual(await createSnapshotConversation({ client, messages }), { id: 'conv-new' })
  assert.deepEqual(requests.map((items) => items.length), [20, 2])
  assert.deepEqual(requests.flat(), messages.map((message) => ({ type: 'message', ...message })))
})

test('failed or cancelled snapshot imports clean up the new conversation and never create a response', async () => {
  const deleted = []
  const client = { conversations: {
    create: async () => ({ id: 'conv-partial' }),
    items: { create: async () => { throw new Error('Import denied') } },
    delete: async (id) => { deleted.push(id) },
  } }
  const messages = Array.from({ length: 22 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `Text ${index}` }))
  await assert.rejects(createSnapshotConversation({ client, messages }), /Import denied/)
  assert.deepEqual(deleted, ['conv-partial'])
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(createSnapshotConversation({ client: {}, messages, signal: controller.signal }), { name: 'AbortError' })
  for (const invalid of [[], [{ role: 'system', content: 'Do not import policies' }],
    [{ role: 'user', content: 'Question' }, { role: 'assistant', content: '' }]]) {
    await assert.rejects(createSnapshotConversation({ client: {}, messages: invalid }), /Expected a bounded snapshot/)
  }
})

test('completion is recorded before publishing success to the browser', async () => {
  const client = clientFor([[]])
  const events = []
  await assert.rejects(runHarnessTurn({ client, conversation: 'conv-completion', input: 'Question',
    onCompleted: () => { throw new Error('Snapshot not recorded') }, emit: (event) => events.push(event) }), /Snapshot not recorded/)
  assert.equal(events.some((event) => event.type === 'response.completed'), false)
})

test('unsupported canary controls fail before any provider request rather than being forwarded or silently dropped', async () => {
  const client = clientFor([[]])
  for (const options of [{ maxOutputTokens: 4096 }, { disableTools: true }, { maxOutputTokens: 4096, disableTools: true }]) {
    await assert.rejects(runHarnessTurn({ client, conversation: 'canary', input: 'Acknowledge', emit: () => {}, ...options }),
      { status: 503, code: 'HARNESS_UNSUPPORTED_PROOF_CONTRACT' })
  }
  assert.equal(client.requests.length, 0)
})

test('service failures retain correlation metadata without exposing raw provider messages or retrying', async () => {
  let requests = 0
  const client = { responses: { async *create() {
    requests += 1
    yield { type: 'response.failed', request_id: 'request-safe', response: {
      id: 'resp-safe', error: { code: 'server_error', message: 'Do not expose private provider text' },
    } }
  } } }
  await assert.rejects(runHarnessTurn({ client, conversation: 'conv-safe', input: 'Canary', emit: () => {} }),
    (error) => error.code === 'server_error' && error.responseId === 'resp-safe'
      && error.requestID === 'request-safe' && !error.message.includes('private provider text'))
  assert.equal(requests, 1)
})

function clientFor(outputs) {
  const requests = []
  return {
    requests,
    responses: {
      async *create(body) {
        requests.push(body)
        yield { type: 'response.completed', response: {
          status: 'completed', output: outputs.shift() ?? [],
        } }
      },
    },
  }
}

test('native source diagnostics distinguish provider errors from evidence rejection without exposing messages', async () => {
  const output = [
    { type: 'mcp_call', id: 'fabric-timeout', name: 'fabric-sales___DataAgent', status: 'failed',
      error: { code: 'upstream_timeout', status: 504, message: 'PRIVATE bearer credentials' }, output: 'PRIVATE' },
    { type: 'mcp_call', id: 'product-auth', name: 'product-knowledge___knowledge_base_retrieve', status: 'failed',
      error: JSON.stringify({ code: 'unauthorized', status_code: 401, message: 'PRIVATE' }), output: 'PRIVATE' },
    { type: 'mcp_call', id: 'product-format', name: 'product-knowledge___knowledge_base_retrieve', status: 'completed', output: 'unrecognized' },
    { type: 'mcp_call', id: 'product-empty', name: 'product-knowledge___knowledge_base_retrieve', status: 'completed', output: '[]' },
    { type: 'mcp_call', id: 'fabric-unknown', name: 'fabric-sales___DataAgent', status: 'failed',
      error: { code: 'PRIVATE', message: 'PRIVATE' }, output: '[]' },
  ]
  const events = []
  await runHarnessTurn({ client: clientFor([output]), conversation: 'diagnostic-test', input: 'Research', emit: (event) => events.push(event) })
  const diagnostics = events.filter((event) => event.type === 'harness.source').map((event) => event.result.diagnostic)
  assert.deepEqual(diagnostics[0], { native_status: 'failed', reason: 'provider_error', provider_code: 'upstream_timeout', http_status: 504 })
  assert.deepEqual(diagnostics[1], { native_status: 'failed', reason: 'provider_error', provider_code: 'unauthorized', http_status: 401 })
  assert.equal(diagnostics[2].reason, 'unrecognized_output_format')
  assert.equal(diagnostics[3].reason, 'no_verifiable_document_references')
  assert.deepEqual(diagnostics[4], { native_status: 'failed', reason: 'provider_error' })
  assert.doesNotMatch(JSON.stringify(events.filter((event) => event.type.startsWith('harness.'))), /PRIVATE/)
  const work = captureCompletedWork({ status: 'completed', output })
  assert.deepEqual(work.records.map((record) => record.diagnostic), diagnostics)
  assert.doesNotMatch(JSON.stringify(work), /PRIVATE/)
})

test('revised canaries use supported request fields and stop on observed tool activity without continuation', async () => {
  const client = clientFor([[]])
  await runHarnessTurn({ client, conversation: 'canary', input: 'Acknowledge', emit: () => {}, rejectToolActivity: true })
  assert.deepEqual(Object.keys(client.requests[0]).sort(), ['conversation', 'input', 'stream'])
  const unexpected = clientFor([[{ type: 'web_search_call', status: 'completed' }]])
  let completed = false
  await assert.rejects(runHarnessTurn({ client: unexpected, conversation: 'canary', input: 'Acknowledge',
    emit: () => {}, rejectToolActivity: true, onCompleted: () => { completed = true } }), /Unexpected tool call/)
  assert.equal(unexpected.requests.length, 1)
  assert.equal(completed, false)
})

const functionCall = (name = 'search_climate_risk', args = { question: 'Miami-Dade hurricane preparedness?' }) => ({
  type: 'function_call', name, arguments: JSON.stringify(args), call_id: 'call-1',
})

test('completes a native turn in the stored conversation without app continuation', async () => {
  const client = clientFor([[{ type: 'web_search_call', id: 'web-1', status: 'completed' }]])
  const events = []
  await runHarnessTurn({ client, conversation: 'conv-1', input: 'Compare products',
    execute: async () => { assert.fail('Native tools must not execute in the app') }, emit: (event) => events.push(event) })
  assert.equal(client.requests.length, 1)
  assert.equal(client.requests[0].conversation, 'conv-1')
  assert.equal(client.requests[0].input, 'Compare products')
  assert.equal(events.filter((event) => event.type === 'response.completed').length, 1)
  assert.ok(events.some((event) => event.type === 'harness.activity' && event.tool === 'web_search_call'))
  for (const request of client.requests) {
    assert.equal(request.previous_response_id, undefined)
    assert.notEqual(request.store, false)
    assert.equal(request.tool_choice, undefined)
  }
})

test('processes a terminal response without waiting for transport EOF', async () => {
  const requests = []
  let closed = 0
  const client = { responses: { async *create(body) {
    requests.push(body)
    try {
      yield { type: 'response.completed', response: {
        status: 'completed', output: [],
      } }
      assert.fail('Must not request another stream event after the terminal response')
    } finally { closed += 1 }
  } } }
  const events = []
  await runHarnessTurn({ client, conversation: 'conv-terminal', input: 'Compare products',
    emit: (event) => events.push(event) })
  assert.equal(requests.length, 1)
  assert.equal(closed, 1)
  assert.equal(events.filter((event) => event.type === 'response.completed').length, 1)
})

test('rejects unknown functions without executing them', async () => {
  const client = clientFor([[functionCall('shell')]])
  let executed = false
  await assert.rejects(runHarnessTurn({ client, conversation: 'conv-1', input: 'Hello',
    execute: async () => { executed = true }, emit() {} }), /unapproved/)
  assert.equal(executed, false)
})

test('rejects the retired Web IQ wrapper without executing a credentialed fallback', async () => {
  const client = clientFor([[functionCall()]])
  const events = []
  await assert.rejects(runHarnessTurn({ client, conversation: 'conv-1', input: 'Hello', emit: (event) => events.push(event),
    execute: async () => { assert.fail('private credential must never be acquired') } }), /unapproved/)
  assert.equal(client.requests.length, 1)
  assert.equal(events.some((event) => event.type === 'harness.source'), false)
  assert.doesNotMatch(JSON.stringify(events), /private credential/)
})

test('rejects unmatched functions regardless of argument validity', async () => {
  const client = clientFor([[functionCall('search_climate_risk', { question: 42 })], []])
  let executed = false
  await assert.rejects(runHarnessTurn({ client, conversation: 'conv-1', input: 'Hello', emit() {},
    execute: async () => { executed = true } }), /unapproved/)
  assert.equal(executed, false)
})

test('never auto-approves an MCP approval request', async () => {
  const client = clientFor([[{ type: 'mcp_approval_request' }]])
  await assert.rejects(runHarnessTurn({ client, conversation: 'conv-1', input: 'Hello', emit() {} }), /approval/)
})

test('rejects multiple app-owned calls without continuation or false completion', async () => {
  const client = clientFor([[functionCall(), functionCall('search_product_docs')]])
  const events = []
  await assert.rejects(runHarnessTurn({ client, conversation: 'conv-1', input: 'Hello',
    execute: async () => { assert.fail('Retired functions must not execute') }, emit: (event) => events.push(event) }), /unapproved/)
  assert.equal(client.requests.length, 1)
  assert.equal(events.some((event) => event.type === 'response.completed'), false)
})

test('preserves a safe managed-service failure code for rate-limit diagnosis', async () => {
  const client = { responses: { async *create() {
    yield { type: 'response.failed', response: { error: { code: 'rate_limit_exceeded' } } }
  } } }
  await assert.rejects(runHarnessTurn({ client, conversation: 'conv-1', input: 'Hello', emit() {} }),
    (error) => error.code === 'rate_limit_exceeded')
})

test('rejects the retired Fabric wrapper without an app-only fallback', async () => {
  const client = clientFor([[functionCall('query_sales_performance')]])
  await assert.rejects(runHarnessTurn({ client, conversation: 'conv-1', input: 'Sales', emit() {},
    execute: async () => { assert.fail('Retired Fabric wrapper must not execute') } }), /unapproved/)
})

test('rejects the retired product-document wrapper without an app fallback', async () => {
  const client = clientFor([[functionCall('search_product_docs')]])
  await assert.rejects(runHarnessTurn({ client, conversation: 'conv-1', input: 'Products', emit() {},
    execute: async () => { assert.fail('Retired Search wrapper must not execute') } }), /unapproved/)
})

test('reports observed native Search failure as unavailable evidence without guessing metadata', async () => {
  const client = clientFor([[
    { type: 'azure_ai_search_call', id: 'ais-1', call_id: 'search-1', status: 'failed', arguments: '{"query":"FieldForge Procore"}' },
    { type: 'azure_ai_search_call_output', id: 'aiso-1', call_id: 'search-1', status: 'failed' },
  ]])
  const events = []
  await runHarnessTurn({ client, conversation: 'conv-1', input: 'Products', emit: (event) => events.push(event),
    execute: async () => { assert.fail('Native Search must not execute through an app callback') } })
  const sources = events.filter((event) => event.type === 'harness.source')
  assert.equal(sources.length, 1)
  assert.equal(sources[0].call_id, 'search-1')
  assert.equal(sources[0].execution, 'native')
  assert.equal(sources[0].status, 'error')
  assert.match(sources[0].result.error, /no verified documents.*No app fallback/)
  assert.equal(sources[0].result.documents, undefined)
  assert.equal(sources[0].result.retrievedAt, undefined)
  assert.equal(client.requests.length, 1)
})

test('native knowledge-base references preserve original metadata without app execution or invented dates', async () => {
  for (const metadata of [{ lastUpdated: '2026-08-20' }, {}]) {
    const document = { docId: 'DOC-2', title: 'Competitive Battlecard', content: 'FieldForge versus Procore', ...metadata }
    const client = clientFor([[{ type: 'mcp_call', id: 'knowledge-1', server_label: 'managed_tools',
      name: 'product-knowledge___knowledge_base_retrieve', status: 'completed',
      arguments: JSON.stringify({ query_variants: ['Compare FieldForge and Procore'] }),
      output: JSON.stringify([{ type: 'text', text: '[{"ref_id":0,"title":"Competitive Battlecard"}]\nCitation tokens: ...' },
        { type: 'text', text: JSON.stringify({ kind: 'reference', ref_id: 0, uri: 'https://example.test/authenticated-index-lookup', sourceData: document }) }]) }]])
    const events = []
    await runHarnessTurn({ client, conversation: 'conv-1', input: 'Products', emit: (event) => events.push(event),
      execute: async () => { assert.fail('Knowledge-base retrieval is executed by Foundry') } })
    const source = events.find((event) => event.type === 'harness.source')
    assert.equal(client.requests.length, 1)
    assert.equal(source.execution, 'native')
    assert.equal(source.status, 'done')
    assert.deepEqual(source.result.documents, [document])
    assert.equal(source.result.documents[0].url, undefined)
    assert.equal(source.result.retrievedAt, undefined)
    assert.match(source.result.identity, /not per-user/)
    assert.ok(events.some((event) => event.tool === 'product-knowledge' && event.status === 'returned'))
  }
})

test('native knowledge-base failures and unverified text never become document evidence or fall back', async () => {
  for (const failure of [{ status: 'failed', error: { message: 'private upstream details' } },
    { status: 'completed', output: JSON.stringify({ isError: true }) },
    { status: 'completed', output: 'unrecognized output' },
    { status: 'completed', output: JSON.stringify([{ type: 'error', text: 'private upstream details' }]) },
    { status: 'completed', output: JSON.stringify([{ type: 'text', text: 'DOC-2 lastUpdated 2026-08-20' }]) }]) {
    const client = clientFor([[{ type: 'mcp_call', id: 'knowledge-1',
      name: 'product-knowledge___knowledge_base_retrieve', ...failure }]])
    const events = []
    await runHarnessTurn({ client, conversation: 'conv-1', input: 'Products', emit: (event) => events.push(event),
      execute: async () => { assert.fail('Knowledge-base retrieval must not fall back to app Search') } })
    const source = events.find((event) => event.type === 'harness.source')
    assert.equal(source.status, 'error')
    assert.equal(source.result.documents, undefined)
    assert.match(source.result.error, /No app fallback/)
    assert.doesNotMatch(JSON.stringify(events.filter((event) => event.type.startsWith('harness.'))), /private upstream/)
  }
})

test('reports genuine native Fabric output as user-authorized evidence without app execution', async () => {
  const client = clientFor([[{ type: 'mcp_call', id: 'fabric-1', server_label: 'managed_tools',
    name: 'fabric-sales___DataAgent_microsoftiq_copilot_sales', status: 'completed',
    arguments: JSON.stringify({ userQuestion: 'Sum revenue by territory for FY26 Q1' }),
    output: JSON.stringify([{ type: 'text', text: 'West revenue: 320000' }]) }]])
  const events = []
  await runHarnessTurn({ client, conversation: 'conv-1', input: 'Sales', emit: (event) => events.push(event),
    execute: async () => { assert.fail('Native Fabric is executed by Foundry') } })
  const source = events.find((event) => event.type === 'harness.source')
  assert.equal(client.requests.length, 1)
  assert.equal(source.execution, 'native')
  assert.equal(source.status, 'done')
  assert.equal(source.result.text, 'West revenue: 320000')
  assert.match(source.result.identity, /Signed-in user/)
  assert.match(source.result.provenance, /imported.*not live CRM/)
  assert.ok(events.some((event) => event.tool === 'fabric-sales' && event.status === 'returned'))
})

test('native Fabric failures and missing outputs remain missing evidence with no fallback', async () => {
  for (const failure of [{ status: 'failed', error: { message: 'private upstream details' } },
    { status: 'completed', output: JSON.stringify({ isError: true }) },
    { status: 'completed', output: 'unrecognized output' },
    { status: 'completed', output: JSON.stringify([{ type: 'error', text: 'private upstream details' }]) }]) {
    const client = clientFor([[{ type: 'mcp_call', id: 'fabric-1',
      name: 'fabric-sales___DataAgent_microsoftiq_copilot_sales', ...failure }]])
    const events = []
    await runHarnessTurn({ client, conversation: 'conv-1', input: 'Sales', emit: (event) => events.push(event),
      execute: async () => { assert.fail('Native Fabric must not fall back to app credentials') } })
    const source = events.find((event) => event.type === 'harness.source')
    assert.equal(source.status, 'error')
    assert.equal(source.result.text, undefined)
    assert.match(source.result.error, /no verified sales evidence/)
    assert.doesNotMatch(JSON.stringify(events.filter((event) => event.type.startsWith('harness.'))), /private upstream/)
  }
})

test('reports native search activity and real citation annotations without executing an app function', async () => {
  const client = clientFor([[
    { type: 'web_search_call', id: 'search-1', status: 'completed', action: { type: 'search', query: 'NOAA Miami-Dade' } },
    { type: 'message', content: [{ type: 'output_text', text: 'Research brief', annotations: [
      { type: 'url_citation', url: 'https://www.noaa.gov/', title: 'NOAA' },
      { type: 'url_citation', url: 'javascript:alert(1)', title: 'Unsafe' },
    ] }] },
  ]])
  const events = []
  await runHarnessTurn({ client, conversation: 'conv-1', input: 'Research Miami-Dade',
    execute: async () => { assert.fail('Native tools must not execute through the app function dispatcher') },
    emit: (event) => events.push(event) })
  assert.deepEqual(events.find((event) => event.type === 'harness.activity'), {
    type: 'harness.activity', id: 'search-1', tool: 'web_search_call', status: 'completed', query: 'NOAA Miami-Dade',
  })
  assert.deepEqual(events.filter((event) => event.type === 'harness.evidence'), [
    { type: 'harness.evidence', url: 'https://www.noaa.gov/', title: 'NOAA' },
  ])
  assert.equal(events.filter((event) => event.type === 'response.completed').length, 1)
})

test('does not re-execute native function calls that already have matching service outputs', async () => {
  const client = clientFor([[
    { type: 'function_call', name: 'task', call_id: 'native-task', arguments: '{}', status: 'completed' },
    { type: 'function_call_output', call_id: 'native-task', output: 'Research completed', status: 'completed' },
    { type: 'function_call', name: 'create', call_id: 'native-file', arguments: '{}', status: 'completed' },
    { type: 'function_call_output', call_id: 'native-file', output: 'Created workspace brief', status: 'completed' },
  ]])
  const events = []
  await runHarnessTurn({ client, conversation: 'conv-1', input: 'Research and save',
    execute: async () => { assert.fail('The harness already executed this call') },
    emit: (event) => events.push(event) })
  assert.equal(client.requests.length, 1)
  assert.deepEqual(events.filter((event) => event.type === 'harness.activity' && event.status === 'returned')
    .map(({ tool }) => tool), ['task', 'create'])
  assert.equal(events.filter((event) => event.type === 'response.completed').length, 1)
})

test('exposes actual Markdown read-back and preserves a failed native tool result', async () => {
  const client = clientFor([[
    { type: 'function_call', name: 'view', call_id: 'read-1', arguments: JSON.stringify({ path: '/home/session/workspace/brief.md' }) },
    { type: 'function_call_output', call_id: 'read-1', output: '# Verified workspace text' },
    { type: 'function_call', name: 'task', call_id: 'task-1', arguments: '{}' },
    { type: 'function_call_output', call_id: 'task-1', output: JSON.stringify({ error: { message: 'No response' } }) },
  ]])
  const events = []
  await runHarnessTurn({ client, conversation: 'conv-1', input: 'Read brief', emit: (event) => events.push(event) })
  assert.deepEqual(events.find((event) => event.type === 'harness.brief'), {
    type: 'harness.brief', path: '/home/session/workspace/brief.md', text: '# Verified workspace text',
  })
  assert.equal(events.find((event) => event.id === 'task-1' && event.output).status, 'failed')
})

test('registers only real successful Markdown upload results, never a file ID in prose', async () => {
  const uploaded = { file_id: 'assistant-tested-file', filename: 'brief.md', bytes: 42 }
  const client = clientFor([[
    { type: 'function_call', name: 'upload_file_from_workspace_to_foundry_project', call_id: 'upload-1', arguments: '{}' },
    { type: 'function_call_output', call_id: 'upload-1', output: JSON.stringify(uploaded) },
    { type: 'message', content: [{ type: 'output_text', text: 'assistant-invented-file', annotations: [] }] },
  ]])
  const events = []
  await runHarnessTurn({ client, conversation: 'conv-1', input: 'Publish', emit: (event) => events.push(event) })
  assert.deepEqual(events.filter((event) => event.type === 'harness.artifact'), [{ type: 'harness.artifact', ...uploaded }])
})