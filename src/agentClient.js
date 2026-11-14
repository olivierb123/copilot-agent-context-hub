// Responses SSE client for the local harness backend.

async function* parseSSEStream(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  function parseFrame(frame) {
    const data = frame.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    return data && data !== '[DONE]' ? JSON.parse(data) : null
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n')
      let sepIndex
      while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
        const event = parseFrame(buffer.slice(0, sepIndex))
        buffer = buffer.slice(sepIndex + 2)
        if (event) yield event
      }
      if (done) break
    }
    const event = parseFrame(buffer)
    if (event) yield event
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}

/**
 * Run one streamed turn through the application backend at `proxyPath`.
 *
 * callbacks:
 *   - onText(fullText): streamed assistant text, called with the accumulated
 *     text so far each time new text arrives
 *   - onDone(): called when the run completes successfully
 *   - onError(message): called on failure
 *
 * accessToken: the signed-in user's bearer token. The backend validates it
 * for Foundry access. Native Fabric uses a signed-in-user Foundry connection;
 * native knowledge-base MCP uses its keyless project-identity connection. Explicit local
 * mode uses the developer's Azure credential for Foundry access.
 */
async function runIQQuery(proxyPath, question, callbacks = {}, accessToken = null, options = {}) {
  const { onText = () => {}, onDone = () => {}, onError = () => {}, onEvent = () => {} } = callbacks

  try {
    const headers = { 'Content-Type': 'application/json' }
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`

    const response = await fetch(proxyPath, {
      method: 'POST',
      headers,
      body: JSON.stringify({ input: question, stream: true, ...options.body }),
      signal: options.signal,
    })

    if (!response.ok || !response.body) {
      let message = `Agent request failed: ${response.status} ${response.statusText}`
      if (response.headers.get('content-type')?.includes('application/json')) {
        const result = await response.json().catch(() => null)
        if (typeof result?.error === 'string' && result.error.trim()) message = result.error
      }
      throw new Error(message)
    }

    const textByItemId = new Map()

    for await (const event of parseSSEStream(response)) {
      onEvent(event)
      switch (event.type) {
        case 'response.output_text.delta': {
          const itemId = event.item_id
          const prev = textByItemId.get(itemId) || ''
          const next = prev + event.delta
          textByItemId.set(itemId, next)
          onText([...textByItemId.values()].join('\n\n'))
          break
        }
        case 'response.completed': {
          const finalText = event.response?.output
            ?.filter((item) => item.type === 'message' && item.role === 'assistant')
            .map((item) => item.content.filter((part) => part.type === 'output_text').map((part) => part.text).join(''))
            .join('\n\n')
          if (finalText) onText(finalText)
          onDone(event.response)
          return
        }
        case 'response.incomplete':
          throw new Error(event.response?.incomplete_details?.reason || 'Response incomplete')
        case 'response.failed':
          throw new Error(event.response?.error?.message || 'Response failed')
        default:
          break
      }
    }
    throw new Error('Agent stream ended before completion')
  } catch (err) {
    onError(err.message || String(err))
  }
}

export function runHarnessQuery(question, callbacks = {}, accessToken = null, options = {}) {
  return runIQQuery('/api/harness/responses', question, callbacks, accessToken, options)
}

export async function requestHarness(path, { token, method = 'GET', body, signal } = {}) {
  if (!token) throw new Error('Browser-user sign-in is required for sharing')
  const response = await fetch(`/api/harness${path}`, {
    method, signal, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (response.status === 204) return null
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || `Harness request failed (${response.status})`)
  return result
}
