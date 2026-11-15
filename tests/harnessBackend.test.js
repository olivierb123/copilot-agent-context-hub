import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertLoopbackRequest, authorizeCaller, createProofBudget, createTurnDeadline, getTurnTimeoutMs, inheritedWorkInput, readPublishedMarkdown, recipientDetails, SessionRegistry } from '../server/harnessBackend.js'
import { fixtureDocuments, searchDefinitions } from '../scripts/bootstrap_context_hub.mjs'

test('recipient display user IDs never replace authorization object IDs', () => {
  const env = { HARNESS_USER_LABELS: JSON.stringify({ 'approved-object': 'recipient@example.com' }) }
  assert.deepEqual(recipientDetails(env, 'approved-object'), { object_id: 'approved-object', user_id: 'recipient@example.com' })
  assert.deepEqual(recipientDetails(env, 'unknown-object'), { object_id: 'unknown-object', user_id: 'unknown-object' })
})

test('bounded canary proof fails locally on the unsupported harness contract without changing ordinary turns', () => {
  const env = { HARNESS_PROOF_ENABLED: 'true', HARNESS_PROOF_MAX_TURNS: '4', HARNESS_PROOF_MAX_OUTPUT_TOKENS: '4096' }
  const budget = createProofBudget(env)
  assert.throws(() => budget.take(), { status: 503, code: 'HARNESS_UNSUPPORTED_PROOF_CONTRACT' })
  const stopped = createProofBudget(env)
  stopped.stop()
  assert.throws(() => stopped.take(), /no retry/)
  assert.deepEqual(createProofBudget({}).take(), {})
  assert.throws(() => createProofBudget({ ...env, HARNESS_PROOF_MAX_TURNS: '5' }))
  assert.throws(() => createProofBudget({ ...env, HARNESS_PROOF_MAX_OUTPUT_TOKENS: '4097' }))
})

test('revised canary reservations survive reload, reject overlap, stop on failure and cannot exceed four attempts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'context-hub-proof-'))
  const approvalPath = join(directory, 'approval.json')
  const env = { HARNESS_PROOF_ENABLED: 'true', HARNESS_PROOF_MODE: 'observed_canary' }
  const initial = { mode: 'observed_canary', hardOutputTokenCap: null, toolsAvailable: true,
    maxResponses: 4, attemptedResponses: 0, attempts: [], stopped: false }
  const create = () => createProofBudget(env, { approvalPath })
  try {
    writeFileSync(approvalPath, JSON.stringify(initial))
    for (let index = 0; index < 4; index += 1) {
      const budget = create()
      assert.deepEqual(budget.take('tenant:owner'), { rejectToolActivity: true })
      budget.recordConversation('local-session', 'conv-canary')
      assert.equal(JSON.parse(readFileSync(approvalPath, 'utf8')).attempts[index].conversationId, 'conv-canary')
      assert.throws(() => create().take('tenant:recipient'), /pending or consumed/)
      create().complete({ responseId: `response-${index}` })
      const saved = JSON.parse(readFileSync(approvalPath, 'utf8'))
      assert.equal(saved.attemptedResponses, index + 1)
      assert.equal(saved.attempts[index].principal, 'tenant:owner')
      assert.equal(saved.attempts[index].state, 'completed')
    }
    assert.throws(() => create().take(), /consumed/)
    writeFileSync(approvalPath, JSON.stringify(initial))
    const failed = create()
    failed.take('tenant:owner')
    failed.stop(Object.assign(new Error('Do not log this secret'), { status: 500, code: 'server_error', requestID: 'request-safe', responseId: 'resp-safe' }))
    const failure = JSON.parse(readFileSync(approvalPath, 'utf8'))
    assert.equal(failure.stopped, true)
    assert.deepEqual(failure.attempts[0].failure, { code: 'server_error', requestId: 'request-safe', responseId: 'resp-safe', status: 500 })
    assert.equal(JSON.stringify(failure).includes('Do not log this secret'), false)
    assert.throws(() => create().take(), /no retry/)
    writeFileSync(approvalPath, JSON.stringify({ ...initial, maxResponses: 5 }))
    assert.throws(() => create().take(), /Invalid revised/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('a separate two-turn baseline allowance cannot reopen the stopped original allowance or permit a third turn', () => {
  const directory = mkdtempSync(join(tmpdir(), 'context-hub-baseline-'))
  const approvalPath = join(directory, 'baseline.json')
  const oldPath = join(directory, 'stopped.json')
  const approval = { mode: 'observed_canary', hardOutputTokenCap: null, toolsAvailable: true,
    maxResponses: 2, attemptedResponses: 0, attempts: [], stopped: false, principal: 'tenant:owner' }
  const env = { HARNESS_PROOF_ENABLED: 'true', HARNESS_PROOF_MODE: 'observed_canary',
    HARNESS_PROOF_MAX_TURNS: '2', HARNESS_PROOF_APPROVAL_PATH: approvalPath }
  try {
    writeFileSync(oldPath, JSON.stringify({ ...approval, stopped: true }))
    const oldContents = readFileSync(oldPath, 'utf8')
    writeFileSync(approvalPath, JSON.stringify(approval))
    assert.throws(() => createProofBudget({ ...env, HARNESS_PROOF_MAX_TURNS: '4' }).take(), /Invalid revised/)
    assert.throws(() => createProofBudget(env).take('tenant:recipient'), { status: 403 })
    assert.equal(JSON.parse(readFileSync(approvalPath, 'utf8')).attemptedResponses, 0)
    for (let index = 0; index < 2; index += 1) {
      assert.deepEqual(createProofBudget(env).take('tenant:owner'), { rejectToolActivity: true })
      createProofBudget(env).complete({ responseId: `baseline-${index}` })
    }
    assert.throws(() => createProofBudget(env).take('tenant:owner'), /consumed/)
    assert.equal(readFileSync(oldPath, 'utf8'), oldContents)
    assert.throws(() => createProofBudget(env, { approvalPath: oldPath }).take('tenant:owner'), /stopped/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('target Search fixtures preserve dates and disclose original summaries without inventing full documents', () => {
  const original = { docId: 'DOC-1', title: 'Original', summary: 'Supplied summary', type: 'technical', audience: 'Demo', lastUpdated: '2026-08-01' }
  const synthetic = { id: 'SYN-1', docId: 'SYN-1', title: '[Synthetic demo]', content: 'Authored scenario', type: 'technical', audience: 'Demo', lastUpdated: '2026-10-30' }
  const result = fixtureDocuments([original], [synthetic])
  assert.match(result[0].content, /not the full source document/)
  assert.equal(result[0].lastUpdated, original.lastUpdated)
  assert.deepEqual(result[1], synthetic)
  assert.throws(() => fixtureDocuments([original], [{ ...synthetic, id: 'DOC-1' }]))
})

test('native Search definitions reject source model endpoints and retain keyless target planning', () => {
  assert.throws(() => searchDefinitions('https://cog-gqyhnzt244atk.openai.azure.com'))
  const definitions = searchDefinitions('https://cog-context-hub-example.openai.azure.com')
  assert.equal(definitions.index.fields.filter((field) => field.key).length, 1)
  assert.equal(definitions.index.fields.find((field) => field.key).name, 'id')
  assert.equal(definitions.knowledgeBase.models[0].azureOpenAIParameters.apiKey, undefined)
  assert.equal(definitions.knowledgeBase.outputMode, 'extractiveData')
})

test('turn budget defaults to ten minutes with a bounded explicit override', () => {
  assert.equal(getTurnTimeoutMs({}), 600_000)
  assert.equal(getTurnTimeoutMs({ HARNESS_TURN_TIMEOUT_MS: '240000' }), 240_000)
  assert.equal(getTurnTimeoutMs({ HARNESS_TURN_TIMEOUT_MS: '900000' }), 900_000)
  for (const value of ['', 'invalid', '59999', '900001', '60000.5', 'Infinity']) {
    assert.throws(() => getTurnTimeoutMs({ HARNESS_TURN_TIMEOUT_MS: value }), /HARNESS_TURN_TIMEOUT_MS/)
  }
})

test('multi-source turns survive four minutes but abort at their configured deadline', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const response = new EventEmitter()
  const deadline = createTurnDeadline(getTurnTimeoutMs({}), response)
  context.mock.timers.tick(240_001)
  assert.equal(deadline.controller.signal.aborted, false)
  context.mock.timers.tick(359_999)
  assert.equal(deadline.controller.signal.aborted, true)
  assert.equal(deadline.controller.signal.reason.code, 'HARNESS_TURN_TIMEOUT')
  assert.match(deadline.controller.signal.reason.message, /timed out after 600 seconds/)
  deadline.dispose()
  assert.equal(response.listenerCount('close'), 0)
})

test('disconnect is distinct from timeout and normal completion does not cancel', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const disconnected = new EventEmitter()
  const first = createTurnDeadline(60_000, disconnected)
  disconnected.emit('close')
  assert.equal(first.controller.signal.reason.code, 'HARNESS_CLIENT_DISCONNECTED')
  context.mock.timers.tick(60_000)
  assert.equal(first.controller.signal.reason.code, 'HARNESS_CLIENT_DISCONNECTED')
  first.dispose()
  const completed = new EventEmitter()
  completed.writableEnded = true
  const second = createTurnDeadline(60_000, completed)
  completed.emit('close')
  assert.equal(second.controller.signal.aborted, false)
  second.dispose()
  context.mock.timers.tick(60_000)
  assert.equal(second.controller.signal.aborted, false)
})

test('conversation ownership cannot be transferred between principals', async () => {
  const registry = new SessionRegistry()
  const session = await registry.acquire(null, 'alice', async () => ({ id: 'conv-private' }))
  registry.release(session.id, true)
  await assert.rejects(registry.acquire(session.id, 'bob', () => {}), { status: 403 })
  assert.notEqual(session.id, session.conversation)
})

test('rejects concurrent turns, but allows the owner to continue after release', async () => {
  const registry = new SessionRegistry()
  const session = await registry.acquire(null, 'alice', async () => ({ id: 'conv-1' }))
  await assert.rejects(registry.acquire(session.id, 'alice', () => {}), { status: 409 })
  registry.release(session.id, true)
  const continued = await registry.acquire(session.id, 'alice', () => { throw new Error('Must reuse conversation') })
  assert.equal(continued.conversation, 'conv-1')
})

test('expires idle sessions and invalidates incomplete turns', async () => {
  let now = 0
  const registry = new SessionRegistry({ now: () => now, ttl: 100 })
  const session = await registry.acquire(null, 'alice', async () => ({ id: 'conv-1' }))
  registry.release(session.id, true)
  now = 101
  await assert.rejects(registry.acquire(session.id, 'alice', () => {}), { status: 404 })
  const next = await registry.acquire(null, 'alice', async () => ({ id: 'conv-2' }))
  registry.release(next.id, false)
  await assert.rejects(registry.acquire(next.id, 'alice', () => {}), { status: 404 })
})

test('rejects remote peers, DNS rebinding and cross-origin requests', () => {
  const request = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:5177' } }
  assert.doesNotThrow(() => assertLoopbackRequest(request))
  assert.throws(() => assertLoopbackRequest({ ...request, socket: { remoteAddress: '192.0.2.1' } }), { status: 403 })
  assert.throws(() => assertLoopbackRequest({ ...request, headers: { host: 'evil.example' } }), { status: 403 })
  assert.throws(() => assertLoopbackRequest({ ...request,
    headers: { ...request.headers, origin: 'https://evil.example' } }), { status: 403 })
})

test('artifact downloads require the session owner and an actually registered file', async () => {
  const registry = new SessionRegistry()
  const session = await registry.acquire(null, 'alice', async () => ({ id: 'conv-files' }))
  const artifact = { file_id: 'assistant-owned-file', filename: 'brief.md', bytes: 42 }
  session.artifacts.set(artifact.file_id, artifact)
  registry.release(session.id, true)
  assert.deepEqual(registry.artifact(session.id, 'alice', artifact.file_id), artifact)
  assert.throws(() => registry.artifact(session.id, 'bob', artifact.file_id), { status: 403 })
  assert.throws(() => registry.artifact(session.id, 'alice', 'assistant-other-file'), { status: 404 })
  registry.release(session.id, false)
  assert.throws(() => registry.artifact(session.id, 'alice', artifact.file_id), { status: 404 })
})

async function completedSession(registry, principal = 'alice', conversation = 'conv-owner') {
  const session = await registry.acquire(null, principal, async () => ({ id: conversation }))
  registry.complete(session.id, 'Original question with source date unknown', { status: 'completed', output: [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Original answer. Source date: unknown.' }] },
    { type: 'mcp_approval_response', approval_request_id: 'never-copy', approve: true },
  ] })
  registry.release(session.id, true)
  return session
}

test('message snapshots fix the completed boundary and never transfer files or tool approvals', async () => {
  const registry = new SessionRegistry()
  const source = await completedSession(registry)
  source.artifacts.set('file-private', { file_id: 'file-private' })
  const share = registry.createShare(source.id, 'alice', 'bob')
  await registry.acquire(source.id, 'alice', () => {})
  registry.complete(source.id, 'Private later question', { status: 'completed', output: [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Private later answer' }] },
  ] })
  registry.release(source.id, true)
  let copied
  const fork = await registry.acceptShare(share.id, 'bob', async (messages) => { copied = messages; return { id: 'conv-recipient' } })
  assert.deepEqual(copied, source.messages.slice(0, 2))
  assert.equal(share.turns, 1)
  assert.equal(fork.messages.length, 2)
  assert.equal(fork.artifacts.size, 0)
  assert.notEqual(fork.id, source.id)
  assert.notEqual(fork.conversation, source.conversation)
  assert.throws(() => registry.find(fork.id, 'alice'), { status: 403 })
  assert.throws(() => registry.find(source.id, 'bob'), { status: 403 })
  await registry.acquire(fork.id, 'bob', () => {})
  registry.complete(fork.id, 'Recipient-only question', { status: 'completed', output: [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Recipient-only answer' }] },
  ] })
  assert.equal(source.messages.length, 4)
  assert(!JSON.stringify(source.messages).includes('Recipient-only'))
  assert(!JSON.stringify(copied).includes('never-copy'))
  await assert.rejects(registry.acceptShare(share.id, 'bob', () => {}), { status: 404 })
})

test('completed-work forks freeze source results, files and usage without transferring tool execution or owner IDs', async () => {
  const registry = new SessionRegistry({ contextRecipients: ['bob'] })
  const source = await completedSession(registry)
  await registry.acquire(source.id, 'alice', () => {})
  registry.complete(source.id, 'Research', { id: 'resp-work', status: 'completed', usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 }, output: [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Finished' }] },
    { type: 'mcp_call', id: 'fabric', name: 'fabric-sales___DataAgent', status: 'completed', output: '[{"type":"text","text":"Exact original dataset"}]' },
    { type: 'function_call', name: 'view', call_id: 'read', arguments: '{"path":"/private/brief.md"}' },
    { type: 'function_call_output', call_id: 'read', output: '# Exact draft\n' },
  ] })
  registry.release(source.id, true)
  const share = registry.createShare(source.id, 'alice', 'bob')
  assert.equal(share.mode, 'completed_work_snapshot')
  assert.equal(share.context.records, 2)
  assert.throws(() => { registry.getShare(share.id, 'bob').context.work[1].records[0].text = 'Changed' }, TypeError)
  source.work.push({ turn: 3, records: [{ text: 'Later private work' }], omissions: [] })
  const fork = await registry.acceptShare(share.id, 'bob', async () => ({ id: 'conv-new' }))
  const request = inheritedWorkInput('Follow-up', fork.inheritedContext)
  assert.equal(request[0].content[0].text, 'Follow-up')
  const files = request[0].content.slice(1)
  assert.deepEqual(files.map((file) => file.filename), ['inherited-work-index.txt', 'inherited-2-0.txt', 'inherited-2-1.md'])
  const texts = files.map((file) => Buffer.from(file.file_data.split(',')[1], 'base64').toString())
  assert.match(texts[0], /historical|missing attachments/)
  assert.match(texts[1], /Exact original dataset/)
  assert.equal(texts[2], '# Exact draft\n')
  assert.doesNotMatch(texts.join(''), /Later private work|\/private\/|never-copy/)
  assert.equal(fork.artifacts.size, 0)
  assert.equal(fork.contextPending, true)
  assert.deepEqual(fork.work[1].usage, { input_tokens: 12, output_tokens: 3, total_tokens: 15 })
})

test('source entitlement is independent of chat ownership and oversized work cannot fall back to text-only', async () => {
  const registry = new SessionRegistry()
  const source = await completedSession(registry)
  source.work.push({ records: [{ kind: 'source', text: 'Private source' }], omissions: [] })
  assert.throws(() => registry.createShare(source.id, 'alice', 'bob'), { status: 403 })
  registry.contextRecipients.add('bob')
  source.work.push({ records: [], omissions: [{ reason: 'capture_limit', blocking: true }] })
  assert.throws(() => registry.createShare(source.id, 'alice', 'bob'), { status: 413 })
  assert.equal(registry.shares.size, 0)
  assert.equal(inheritedWorkInput('Exact question', { work: [] }), 'Exact question')
})

test('attachment limits reject whole packages rather than dropping supporting records', () => {
  assert.throws(() => inheritedWorkInput('Question', { work: [{ turn: 1, records: Array.from({ length: 128 }, () => ({ kind: 'finding', text: 'result' })) }] }), { status: 413 })
  assert.throws(() => inheritedWorkInput('Question', { work: [{ turn: 1, records: [{ kind: 'file', text: 'x'.repeat(10_000_000) }] }] }), { status: 413 })
})

test('published files are exact byte snapshots with new recipient download IDs and independent copies', async () => {
  const registry = new SessionRegistry({ contextRecipients: ['bob'] })
  const source = await completedSession(registry)
  const bytes = Buffer.from('\uFEFF# Exact published bytes\n')
  const artifact = { file_id: 'assistant-owner', filename: 'brief.md', bytes: bytes.length }
  source.artifacts.set(artifact.file_id, artifact)
  let reads = 0
  const client = { files: { content: async (id) => { reads += 1; assert.equal(id, artifact.file_id); return new Response(bytes) } } }
  assert.deepEqual(await readPublishedMarkdown(client, artifact), bytes)
  await assert.rejects(readPublishedMarkdown(client, { ...artifact, bytes: 1 }), { status: 409 })
  assert.throws(() => registry.createShare(source.id, 'alice', 'bob'), { status: 409 })
  const preview = registry.contextPreview(source.id, 'alice')
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  assert.deepEqual(Buffer.from(text), bytes)
  const file = { source_id: artifact.file_id, filename: 'brief.md', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), text }
  assert.throws(() => registry.createShare(source.id, 'alice', 'bob', [{ ...file, sha256: 'incorrect' }]), { status: 409 })
  const share = registry.createShare(source.id, 'alice', 'bob', [file])
  source.artifacts.set('assistant-later', { ...artifact, file_id: 'assistant-later', filename: 'later.md' })
  assert.notEqual(registry.contextPreview(source.id, 'alice').version, preview.version)
  const fork = await registry.acceptShare(share.id, 'bob', async () => ({ id: 'conv-files-copy' }))
  const copied = [...fork.artifacts.values()][0]
  assert.notEqual(copied.file_id, artifact.file_id)
  assert.equal(copied.inherited, true)
  assert.deepEqual(await readPublishedMarkdown({}, copied), bytes)
  assert.equal(reads, 2)
  assert.throws(() => registry.artifact(fork.id, 'alice', copied.file_id), { status: 403 })
  assert.throws(() => registry.artifact(fork.id, 'bob', artifact.file_id), { status: 404 })
  assert.equal(fork.artifacts.size, 1)
})

test('revoking source-export policy blocks acceptance without importing a conversation', async () => {
  const registry = new SessionRegistry({ contextRecipients: ['bob'] })
  const source = await completedSession(registry)
  source.work.push({ records: [{ kind: 'finding', text: 'Completed work' }], omissions: [] })
  const share = registry.createShare(source.id, 'alice', 'bob')
  registry.contextRecipients.delete('bob')
  await assert.rejects(registry.acceptShare(share.id, 'bob', () => assert.fail('Must not import')), { status: 403 })
  assert.equal(registry.shares.size, 1)
})

test('shares require the owner, a distinct recipient, and a completed idle turn', async () => {
  const registry = new SessionRegistry()
  const source = await registry.acquire(null, 'alice', async () => ({ id: 'conv-owner' }))
  assert.throws(() => registry.createShare(source.id, 'alice', 'bob'), { status: 409 })
  registry.release(source.id, true)
  assert.throws(() => registry.createShare(source.id, 'alice', 'bob'), { status: 409 })
  assert.throws(() => registry.createShare(source.id, 'bob', 'alice'), { status: 403 })
  assert.throws(() => registry.createShare(source.id, 'alice', 'alice'), { status: 400 })
})

test('sharing is recipient-bound, revocable and expires; provider IDs grant no access', async () => {
  let now = 0
  const registry = new SessionRegistry({ now: () => now, ttl: 100 })
  const source = await completedSession(registry)
  const share = registry.createShare(source.id, 'alice', 'bob')
  assert.deepEqual(registry.listShares('mallory'), [])
  await assert.rejects(registry.acceptShare(share.id, 'mallory', () => {}), { status: 403 })
  await assert.rejects(registry.acceptShare(source.conversation, 'bob', () => {}), { status: 404 })
  assert.throws(() => registry.revokeShare(share.id, 'bob'), { status: 403 })
  registry.revokeShare(share.id, 'alice')
  await assert.rejects(registry.acceptShare(share.id, 'bob', () => {}), { status: 404 })
  const expiring = registry.createShare(source.id, 'alice', 'bob')
  now = 101
  assert.deepEqual(registry.listShares('bob'), [])
  await assert.rejects(registry.acceptShare(expiring.id, 'bob', () => {}), { status: 404 })
})

test('acceptance is atomic against concurrency and owner revocation', async () => {
  const registry = new SessionRegistry()
  const source = await completedSession(registry)
  const share = registry.createShare(source.id, 'alice', 'bob')
  let finish
  const deleted = []
  const pending = registry.acceptShare(share.id, 'bob', () => new Promise((resolve) => { finish = resolve }),
    async (conversation) => { deleted.push(conversation) })
  await assert.rejects(registry.acceptShare(share.id, 'bob', () => {}), { status: 409 })
  registry.revokeShare(share.id, 'alice')
  finish({ id: 'conv-cancelled-fork' })
  await assert.rejects(pending, { status: 404 })
  assert.deepEqual(deleted, ['conv-cancelled-fork'])
  assert.equal(registry.sessions.size, 1)
})

test('failed creation permits explicit retry without transferring ownership or consuming the share', async () => {
  const registry = new SessionRegistry()
  const source = await completedSession(registry)
  const share = registry.createShare(source.id, 'alice', 'bob')
  await assert.rejects(registry.acceptShare(share.id, 'bob', async () => { throw new Error('Provider unavailable') }), /Provider unavailable/)
  assert.equal(registry.getShare(share.id, 'bob').pending, false)
  assert.equal(registry.pendingCreates, 0)
  const fork = await registry.acceptShare(share.id, 'bob', async () => ({ id: 'conv-retry' }))
  assert.equal(fork.principal, 'bob')
  assert.equal(source.principal, 'alice')
})

test('concurrent conversation creation cannot bypass the registry capacity', async () => {
  const registry = new SessionRegistry({ limit: 1 })
  let finish
  const pending = registry.acquire(null, 'alice', () => new Promise((resolve) => { finish = resolve }))
  await assert.rejects(registry.acquire(null, 'bob', () => {}), { status: 503 })
  finish({ id: 'conv-first' })
  await pending
  assert.equal(registry.sessions.size, 1)
  assert.equal(registry.pendingCreates, 0)
})

test('sharing callers must be delegated allowed users from the approved tenant and browser client', () => {
  const env = { AZURE_TENANT_ID: 'tenant', VITE_MSAL_CLIENT_ID: 'browser', HARNESS_ALLOWED_OBJECT_IDS: 'alice,bob' }
  const payload = { tid: 'tenant', oid: 'alice', azp: 'browser', scp: 'user_impersonation' }
  assert.equal(authorizeCaller(payload, env), 'tenant:alice')
  assert.equal(authorizeCaller({ ...payload, oid: 'bob', azp: undefined, appid: 'browser' }, env), 'tenant:bob')
  for (const change of [{ tid: 'other' }, { oid: 'mallory' }, { azp: 'other-client' },
    { scp: undefined }, { scp: 'other_scope' }, { idtyp: 'app' }]) {
    assert.throws(() => authorizeCaller({ ...payload, ...change }, env), { status: 403 })
  }
  assert.throws(() => authorizeCaller(payload, { ...env, VITE_MSAL_CLIENT_ID: '' }), { status: 503 })
  assert.throws(() => authorizeCaller(payload, { ...env, HARNESS_ALLOWED_OBJECT_IDS: '' }), { status: 403 })
})