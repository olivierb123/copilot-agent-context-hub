import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { AIProjectClient } from '@azure/ai-projects'
import { DefaultAzureCredential } from '@azure/identity'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { assertHarnessTurnOptions, createSnapshotConversation, runHarnessTurn } from './harnessRuntime.js'

function failure(status, message) {
  return Object.assign(new Error(message), { status })
}

export function getTurnTimeoutMs(env) {
  const timeout = Number(env.HARNESS_TURN_TIMEOUT_MS ?? 600_000)
  if (!Number.isInteger(timeout) || timeout < 60_000 || timeout > 900_000) {
    throw new Error('HARNESS_TURN_TIMEOUT_MS must be an integer from 60000 to 900000')
  }
  return timeout
}

export function createProofBudget(env, { approvalPath = env.HARNESS_PROOF_APPROVAL_PATH || '.state/live-proof/revised-approval.json' } = {}) {
  const enabled = env.HARNESS_PROOF_ENABLED === 'true'
  const observed = env.HARNESS_PROOF_MODE === 'observed_canary'
  const turns = Number(env.HARNESS_PROOF_MAX_TURNS ?? 4)
  const tokens = Number(env.HARNESS_PROOF_MAX_OUTPUT_TOKENS ?? 4096)
  if (enabled && (!Number.isInteger(turns) || turns < 1 || turns > 4
    || !Number.isInteger(tokens) || tokens < 1 || tokens > 4096)) throw new Error('Invalid bounded canary proof limits')
  let remaining = turns
  let stopped = false
  function readApproval() {
    const approval = JSON.parse(readFileSync(approvalPath, 'utf8'))
    if (approval.mode !== 'observed_canary' || approval.hardOutputTokenCap !== null || approval.toolsAvailable !== true
      || approval.maxResponses !== turns || !Array.isArray(approval.attempts)
      || approval.attemptedResponses !== approval.attempts.length) throw failure(503, 'Invalid revised canary approval')
    return approval
  }
  function saveApproval(approval) {
    writeFileSync(approvalPath, JSON.stringify(approval, null, 2), { mode: 0o600 })
  }
  return {
    take(principal) {
      if (!enabled) return {}
      if (observed) {
        const approval = readApproval()
        if (approval.principal && approval.principal !== principal) throw failure(403, 'This canary allowance belongs to a different caller')
        if (stopped || approval.stopped || approval.attemptedResponses >= approval.maxResponses
          || approval.attempts.some((attempt) => attempt.state !== 'completed')) throw failure(409, 'Canary proof stopped, pending or consumed; no retry is authorized')
        approval.attemptedResponses += 1
        approval.attempts.push({ ordinal: approval.attemptedResponses, principal, state: 'reserved', reservedAt: new Date().toISOString() })
        saveApproval(approval)
        return { rejectToolActivity: true }
      }
      if (stopped || remaining === 0) throw failure(409, 'Canary proof stopped or allowance consumed; no retry is authorized')
      assertHarnessTurnOptions({ maxOutputTokens: tokens, disableTools: true })
      remaining -= 1
      return { maxOutputTokens: tokens, disableTools: true }
    },
    recordConversation(sessionId, conversationId) {
      if (!enabled || !observed) return
      const approval = readApproval()
      const attempt = approval.attempts.at(-1)
      if (approval.stopped || attempt?.state !== 'reserved') throw failure(409, 'No pending canary attempt')
      Object.assign(attempt, { sessionId, conversationId })
      saveApproval(approval)
    },
    complete(evidence) {
      if (!enabled || !observed) return
      const approval = readApproval()
      const attempt = approval.attempts.at(-1)
      if (approval.stopped || attempt?.state !== 'reserved') throw failure(409, 'No pending canary attempt')
      Object.assign(attempt, evidence, { state: 'completed', completedAt: new Date().toISOString() })
      saveApproval(approval)
    },
    stop(error = {}) {
      stopped = true
      if (!enabled || !observed) return
      try {
        const approval = readApproval()
        approval.stopped = true
        const requestId = error.requestID || error.request_id || error.headers?.get?.('apim-request-id') || error.headers?.['apim-request-id']
        const metadata = Object.fromEntries([['code', error.code], ['responseId', error.responseId], ['requestId', requestId]]
          .filter(([, value]) => typeof value === 'string' && /^[a-z\d_.-]{1,160}$/i.test(value)))
        if (Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) metadata.status = error.status
        approval.stopFailure ??= metadata
        if (approval.attempts.at(-1)?.state === 'reserved') {
          Object.assign(approval.attempts.at(-1), { state: 'failed', failure: metadata })
        }
        saveApproval(approval)
      } catch {}
    },
  }
}

export function createTurnDeadline(timeoutMs, response) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(Object.assign(new Error(
    `Turn timed out after ${Math.ceil(timeoutMs / 1000)} seconds. Research did not finish in time; start a new conversation or narrow the request.`
  ), { code: 'HARNESS_TURN_TIMEOUT' })), timeoutMs)
  const onClose = () => {
    if (!response.writableEnded) controller.abort(Object.assign(new Error(
      'Browser disconnected before the response completed.'
    ), { code: 'HARNESS_CLIENT_DISCONNECTED' }))
  }
  response.on('close', onClose)
  return { controller, dispose() {
    clearTimeout(timer)
    response.off('close', onClose)
  } }
}

export function recipientDetails(env, objectId) {
  const users = JSON.parse(env.HARNESS_USER_LABELS || '{}')
  const label = users[objectId]
  return { object_id: objectId, user_id: typeof label === 'string' && label.trim() ? label.trim() : objectId }
}

export class SessionRegistry {
  constructor({ now = Date.now, ttl = 30 * 60_000, limit = 100 } = {}) {
    this.sessions = new Map()
    this.shares = new Map()
    this.pendingCreates = 0
    this.now = now
    this.ttl = ttl
    this.limit = limit
  }

  find(id, principal) {
    const session = this.sessions.get(id)
    if (!session || session.expires <= this.now()) throw failure(404, 'Session expired; start a new conversation')
    if (session.principal !== principal) throw failure(403, 'Session access denied')
    if (session.busy) throw failure(409, 'A turn is already running in this conversation')
    return session
  }

  async acquire(id, principal, createConversation) {
    for (const [key, session] of this.sessions) {
      if (!session.busy && session.expires <= this.now()) this.sessions.delete(key)
    }
    let session
    if (id) {
      session = this.find(id, principal)
    } else {
      if (this.sessions.size + this.pendingCreates >= this.limit) throw failure(503, 'Local session limit reached')
      this.pendingCreates += 1
      try {
        const conversation = await createConversation()
        session = { id: randomUUID(), conversation: conversation.id, principal,
          expires: this.now() + this.ttl, busy: false, artifacts: new Map(), messages: [] }
        this.sessions.set(session.id, session)
      } finally { this.pendingCreates -= 1 }
    }
    session.busy = true
    return session
  }

  complete(id, input, response) {
    const session = this.sessions.get(id)
    if (!session?.busy || response.status !== 'completed') throw failure(409, 'Only completed turns can be shared')
    const text = response.output.filter((item) => item.type === 'message' && item.role === 'assistant')
      .map((item) => item.content.filter((part) => part.type === 'output_text').map((part) => part.text).join(''))
      .join('\n\n')
    if (!text) throw failure(502, 'The completed response contains no shareable assistant text')
    session.messages.push({ role: 'user', content: input }, { role: 'assistant', content: text })
  }

  createShare(id, principal, recipient) {
    const session = this.find(id, principal)
    if (!recipient || recipient === principal) throw failure(400, 'Choose a different recipient')
    if (!session.messages.length) throw failure(409, 'Complete a conversation turn before sharing')
    for (const [key, share] of this.shares) {
      if (share.expires <= this.now() || !this.sessions.has(share.sessionId)) this.shares.delete(key)
    }
    if (this.shares.size >= this.limit * 2) throw failure(503, 'Local share limit reached')
    if (Buffer.byteLength(JSON.stringify(session.messages)) > 262_144) throw failure(413, 'Conversation exceeds the snapshot limit')
    const share = { id: randomUUID(), sessionId: id, owner: principal, recipient,
      created: this.now(), expires: Math.min(session.expires, this.now() + this.ttl), pending: false,
      messages: Object.freeze(session.messages.map((message) => Object.freeze({ ...message }))) }
    this.shares.set(share.id, share)
    return this.shareDetails(share)
  }

  shareDetails(share) {
    return { id: share.id, owner: share.owner, recipient: share.recipient, created: share.created,
      expires: share.expires, turns: share.messages.length / 2, mode: 'message_snapshot' }
  }

  getShare(id, principal, owner = false) {
    const share = this.shares.get(id)
    const source = share && this.sessions.get(share.sessionId)
    if (!share || share.expires <= this.now() || !source || source.expires <= this.now()) throw failure(404, 'Share expired or revoked')
    if ((owner ? share.owner : share.recipient) !== principal) throw failure(403, 'Share access denied')
    return share
  }

  listShares(principal) {
    return [...this.shares.values()].filter((share) => {
      const source = this.sessions.get(share.sessionId)
      return share.expires > this.now() && source?.expires > this.now()
        && (share.owner === principal || share.recipient === principal)
    }).map((share) => this.shareDetails(share))
  }

  revokeShare(id, principal) {
    this.getShare(id, principal, true)
    this.shares.delete(id)
  }

  async acceptShare(id, principal, createConversation, deleteConversation) {
    const share = this.getShare(id, principal)
    if (share.pending) throw failure(409, 'This share is already being accepted')
    share.pending = true
    let fork
    try {
      fork = await this.acquire(null, principal, async () => {
        const conversation = await createConversation(share.messages.map((message) => ({ ...message })))
        if (conversation.id === this.sessions.get(share.sessionId)?.conversation) throw failure(502, 'Fork must use a separate conversation')
        return conversation
      })
      this.getShare(id, principal)
      fork.messages = share.messages.map((message) => ({ ...message }))
      this.release(fork.id, true)
      this.shares.delete(id)
      return fork
    } catch (error) {
      if (fork) {
        this.sessions.delete(fork.id)
        await deleteConversation?.(fork.conversation).catch(() => {})
      }
      throw error
    } finally { share.pending = false }
  }

  artifact(id, principal, fileId) {
    const session = this.find(id, principal)
    const artifact = session.artifacts.get(fileId)
    if (!artifact) throw failure(404, 'File was not published in this conversation')
    return artifact
  }

  release(id, success) {
    const session = this.sessions.get(id)
    if (!session) return
    if (!success) this.sessions.delete(id)
    else {
      session.busy = false
      session.expires = this.now() + this.ttl
    }
  }
}

export function assertLoopbackRequest(req) {
  const peers = ['127.0.0.1', '::1', '::ffff:127.0.0.1']
  const host = new URL(`http://${req.headers.host || 'invalid'}`)
  if (!peers.includes(req.socket.remoteAddress)
    || !['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)) {
    throw failure(403, 'The development backend only accepts loopback requests')
  }
  if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
    throw failure(403, 'Cross-origin requests are not allowed')
  }
}

export function authorizeCaller(payload, env) {
  const allowed = (env.HARNESS_ALLOWED_OBJECT_IDS || '').split(',').map((value) => value.trim())
  if (!env.VITE_MSAL_CLIENT_ID) throw failure(503, 'Browser client is not configured')
  if (payload.tid !== env.AZURE_TENANT_ID || !allowed.includes(payload.oid)
    || (payload.azp || payload.appid) !== env.VITE_MSAL_CLIENT_ID || payload.idtyp === 'app'
    || typeof payload.scp !== 'string' || !payload.scp.split(' ').includes('user_impersonation')) {
    throw failure(403, 'An approved signed-in user and browser client are required')
  }
  return `${payload.tid}:${payload.oid}`
}

function createAuthenticator(env, credential) {
  let keys
  return async (req) => {
    if (env.HARNESS_AUTH_MODE === 'local') return { principal: 'local-developer', credential }
    const token = req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1]
    if (!token) throw failure(401, 'Sign in before calling the harness')
    const tenant = env.AZURE_TENANT_ID
    if (!/^[\da-f-]{36}$/i.test(tenant || '')) throw failure(503, 'Server tenant is not configured')
    keys ??= createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`))
    let payload
    try {
      ;({ payload } = await jwtVerify(token, keys, {
        audience: ['https://ai.azure.com', 'https://ai.azure.com/'],
        issuer: [`https://sts.windows.net/${tenant}/`, `https://login.microsoftonline.com/${tenant}/v2.0`],
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'tid', 'oid'],
      }))
    } catch { throw failure(401, 'Invalid or expired Azure AI access token') }
    const principal = authorizeCaller(payload, env)
    return { principal, delegated: true, credential: {
      getToken: async () => ({ token, expiresOnTimestamp: payload.exp * 1000 }),
    } }
  }
}

async function readBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw failure(415, 'Expected application/json')
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 16_384) throw failure(413, 'Request is too large')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw failure(400, 'Invalid JSON request') }
}

export function harnessBackendPlugin(env) {
  const turnTimeoutMs = getTurnTimeoutMs(env)
  const proofBudget = createProofBudget(env)
  const credential = new DefaultAzureCredential()
  const authenticate = createAuthenticator(env, credential)
  const sessions = new SessionRegistry()
  return {
    name: 'copilot-harness-backend',
    configureServer(server) {
      server.middlewares.use('/api/harness', async (req, res) => {
        let session
        let success = false
        let heartbeat
        let lastTool = 'none'
        const startedAt = Date.now()
        const { controller, dispose } = createTurnDeadline(turnTimeoutMs, res)
        const emit = (event) => {
          if (event.type === 'harness.activity') lastTool = event.tool
          if (event.type === 'harness.source' && event.status === 'running') lastTool = event.source
          if (event.type === 'harness.artifact' && session) session.artifacts.set(event.file_id, event)
          if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`)
        }
        try {
          assertLoopbackRequest(req)
          const identity = await authenticate(req)
          if (!env.FOUNDRY_PROJECT_ENDPOINT || !env.HARNESS_AGENT_NAME) throw failure(503, 'Harness endpoint is not configured')
          const project = new AIProjectClient(env.FOUNDRY_PROJECT_ENDPOINT, identity.credential)
          const client = project.getOpenAIClient({ azureConfig: {
            allowPreview: true, agentName: env.HARNESS_AGENT_NAME,
          }, timeout: turnTimeoutMs, maxRetries: 0 })
          const path = req.url?.split('?')[0]
          const shareSessionId = path?.match(/^\/sessions\/([\da-f-]{36})\/shares$/i)?.[1]
          const shareMatch = path?.match(/^\/shares\/([\da-f-]{36})(\/fork)?$/i)
          if (path === '/shares' || shareSessionId || shareMatch) {
            if (!identity.delegated || env.HARNESS_AUTH_MODE !== 'bearer') throw failure(403, 'Sharing requires real browser-user sign-in')
            const allowed = (env.HARNESS_ALLOWED_OBJECT_IDS || '').split(',').map((value) => value.trim()).filter(Boolean)
            let result
            res.setHeader('Cache-Control', 'no-store')
            res.setHeader('Content-Type', 'application/json')
            if (req.method === 'GET' && path === '/shares') {
              result = { shares: sessions.listShares(identity.principal), recipients: allowed
                .filter((objectId) => `${env.AZURE_TENANT_ID}:${objectId}` !== identity.principal)
                .map((objectId) => recipientDetails(env, objectId)) }
            } else if (req.method === 'POST' && shareSessionId) {
              const body = await readBody(req)
              if (!allowed.includes(body.recipient_object_id)) throw failure(403, 'Recipient is not an approved user')
              result = sessions.createShare(shareSessionId, identity.principal, `${env.AZURE_TENANT_ID}:${body.recipient_object_id}`)
              res.statusCode = 201
            } else if (req.method === 'DELETE' && shareMatch && !shareMatch[2]) {
              sessions.revokeShare(shareMatch[1], identity.principal)
              res.statusCode = 204
              res.end()
              return
            } else if (req.method === 'POST' && shareMatch?.[2]) {
              const body = await readBody(req)
              if (body.accept_snapshot !== true) throw failure(400, 'Explicit acceptance of a message-only snapshot is required')
              const fork = await sessions.acceptShare(shareMatch[1], identity.principal,
                (messages) => createSnapshotConversation({ client, messages, signal: controller.signal }),
                (conversation) => client.conversations.delete(conversation, { signal: AbortSignal.timeout(5000) }))
              result = { session_id: fork.id, mode: 'message_snapshot', messages: fork.messages }
              res.statusCode = 201
            } else { throw failure(404, 'Unknown sharing route') }
            res.end(JSON.stringify(result))
            return
          }
          const filePath = path?.match(/^\/sessions\/([\da-f-]{36})\/files\/([a-zA-Z0-9_-]{1,160})$/i)
          if (req.method === 'GET' && filePath) {
            const artifact = sessions.artifact(filePath[1], identity.principal, filePath[2])
            const filesClient = project.getOpenAIClient({ azureConfig: { allowPreview: true }, timeout: 30_000, maxRetries: 0 })
            const content = await filesClient.files.content(artifact.file_id, { signal: controller.signal })
            if (!content.body) throw failure(502, 'File content was not returned')
            const reader = content.body.getReader()
            const chunks = []
            let bytes = 0
            try {
              while (true) {
                const next = await reader.read()
                if (next.done) break
                bytes += next.value.byteLength
                if (bytes > 1_048_576) throw failure(413, 'File exceeds the download limit')
                chunks.push(Buffer.from(next.value))
              }
            } finally {
              await reader.cancel()
              reader.releaseLock()
            }
            res.setHeader('Cache-Control', 'no-store')
            res.setHeader('X-Content-Type-Options', 'nosniff')
            res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
            res.setHeader('Content-Disposition', `attachment; filename="${artifact.filename}"`)
            res.end(Buffer.concat(chunks))
            return
          }
          const deleteId = path?.match(/^\/sessions\/([\da-f-]{36})$/i)?.[1]
          if (req.method === 'DELETE' && deleteId) {
            session = sessions.find(deleteId, identity.principal)
            await client.conversations.delete(session.conversation)
            sessions.sessions.delete(deleteId)
            res.statusCode = 204
            res.end()
            return
          }
          if (req.method !== 'POST' || path !== '/responses') throw failure(404, 'Unknown harness route')
          const body = await readBody(req)
          if (typeof body.input !== 'string' || !body.input.trim() || body.input.length > 8000
            || (body.session_id !== undefined && !/^[\da-f-]{36}$/i.test(body.session_id))) {
            throw failure(400, 'Expected a question and an optional valid session ID')
          }
          const requestLimits = proofBudget.take(identity.principal)
          session = await sessions.acquire(body.session_id, identity.principal,
            () => client.conversations.create({}, { signal: controller.signal }))
          proofBudget.recordConversation(session.id, session.conversation)
          res.setHeader('Content-Type', 'text/event-stream')
          res.setHeader('Cache-Control', 'no-store')
          res.setHeader('X-Accel-Buffering', 'no')
          res.flushHeaders()
          emit({ type: 'harness.session', session_id: session.id })
          heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n') }, 15_000)
          await runHarnessTurn({ client, conversation: session.conversation, input: body.input,
            ...requestLimits, emit, signal: controller.signal, onCompleted: (response) => {
              sessions.complete(session.id, body.input, response)
              proofBudget.complete({ sessionId: session.id, conversationId: session.conversation,
                responseId: response.id, responseStatus: response.status, usage: response.usage,
                outputTypes: response.output.map((item) => item.type),
                messages: session.messages.map((message) => ({ ...message })) })
            } })
          success = true
          res.end()
        } catch (error) {
          const cause = controller.signal.aborted ? controller.signal.reason : error
          if (req.method === 'POST') proofBudget.stop(cause)
          const message = controller.signal.aborted ? cause.message
            : error.code === 'rate_limit_exceeded'
            ? 'Foundry model rate limit reached; wait before retrying this question'
            : error.status && error.status < 500 ? error.message
              : 'Harness request failed; check the local backend configuration and Foundry access'
          if (res.headersSent) {
            emit({ type: 'response.failed', response: { error: { message } } })
            res.end()
          } else {
            res.statusCode = error.status || 502
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: message }))
          }
          const code = /^[a-z\d_.-]{1,80}$/i.test(String(cause.code)) ? cause.code : 'unavailable'
          const tool = String(lastTool).replace(/[^a-z\d_.-]/gi, '_').slice(0, 160)
          console.warn(`[harness] ${cause.name}: status ${error.status || 'unavailable'}, code ${code}, elapsed ${Date.now() - startedAt}ms, budget ${turnTimeoutMs}ms, last tool ${tool}`)
        } finally {
          dispose()
          clearInterval(heartbeat)
          if (session && req.method === 'POST') sessions.release(session.id, success)
        }
      })
    },
  }
}