function emitNativeEvidence(item, emit) {
  if (item.type?.endsWith('_call')) {
    let argumentsValue
    try { argumentsValue = JSON.parse(item.arguments) } catch { argumentsValue = {} }
    const detail = argumentsValue?.description || argumentsValue?.path || argumentsValue?.url || argumentsValue?.userQuestion || argumentsValue?.query_variants?.[0]
    let tool = item.name || item.type
    if (item.type === 'mcp_call' && item.name?.startsWith('fabric-sales___')) tool = 'fabric-sales'
    if (item.type === 'mcp_call' && item.name === 'product-knowledge___knowledge_base_retrieve') tool = 'product-knowledge'
    emit({ type: 'harness.activity', id: item.call_id || item.id,
      tool,
      status: item.type === 'function_call' ? 'in_progress' : item.status || 'observed',
      query: item.type === 'web_search_call' ? item.action?.query : undefined,
      ...(typeof detail === 'string' ? { detail: detail.slice(0, 1000) } : {}) })
  }
  if (item.type === 'message') {
    for (const content of item.content ?? []) {
      for (const annotation of content.annotations ?? []) {
        if (annotation.type === 'url_citation') {
          try {
            const url = new URL(annotation.url)
            if (['http:', 'https:'].includes(url.protocol)) {
              emit({ type: 'harness.evidence', url: url.href, title: annotation.title || url.hostname })
            }
          } catch { continue }
        }
      }
    }
  }
}

export function hasExportSecrets(text) {
  const inspect = (value, depth) => {
    if (depth > 32) return true
    if (value && typeof value === 'object') return Object.entries(value).some(([key, child]) =>
      (/^(?:access_token|refresh_token|client_secret|password|authorization)$/i.test(key)
        && typeof child === 'string' && child.trim()) || inspect(child, depth + 1))
    if (typeof value !== 'string') return false
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|"(?:access_token|refresh_token|client_secret|password|authorization)"\s*:\s*"[^"]+"|Bearer\s+[a-zA-Z0-9._~-]{16,}|eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+|[?&](?:sig|access_token|api_key)=[^\s"&]+/i.test(value)) return true
    try { return inspect(JSON.parse(value), depth + 1) } catch { return false }
  }
  return Boolean(inspect(text, 0))
}

export function inheritedIndexWasRead(response, hash) {
  const reads = new Set((response.output ?? []).filter((item) => {
    if (item.type !== 'function_call' || !['view', 'filesystem_read'].includes(item.name)) return false
    try { return JSON.parse(item.arguments)?.path?.split('/').pop() === 'inherited-work-index.txt' } catch { return false }
  }).map((item) => item.call_id))
  return (response.output ?? []).some((item) => {
    if (item.type !== 'function_call_output' || !reads.has(item.call_id) || item.status === 'failed'
      || typeof item.output !== 'string' || !item.output.includes(hash)) return false
    try { const result = JSON.parse(item.output); return !result?.error && !result?.isError } catch { return true }
  })
}

function nativeSourceDiagnostic(item, content, missingEvidence) {
  let providerError = item.error
  if (typeof providerError === 'string') {
    try { providerError = JSON.parse(providerError) } catch { providerError = null }
  }
  const code = providerError?.code
  const httpStatus = providerError?.status ?? providerError?.status_code ?? providerError?.statusCode
  return {
    native_status: ['completed', 'failed', 'in_progress', 'incomplete'].includes(item.status) ? item.status : 'unknown',
    reason: item.error ? 'provider_error'
      : item.status !== 'completed' ? 'native_call_not_completed'
        : !Array.isArray(content) ? 'unrecognized_output_format'
          : content.some((block) => block.isError || block.type === 'error') ? 'tool_reported_error'
            : missingEvidence,
    ...(typeof code === 'string' && /^(?:unauthorized|forbidden|authentication_error|authorization_error|permission_denied|invalid_token|timeout|upstream_timeout|gateway_timeout|server_error|service_unavailable|rate_limit_exceeded|tool_error|mcp_error)$/i.test(code)
      ? { provider_code: code.toLowerCase() } : {}),
    ...(Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599 ? { http_status: httpStatus } : {}),
  }
}

export function captureCompletedWork(response) {
  const records = []
  const omissions = []
  const outputs = new Map((response.output ?? []).filter((item) => item.type === 'function_call_output')
    .map((item) => [item.call_id, item]))
  let bytes = 0
  const append = (record) => {
    const serialized = JSON.stringify(record)
    if (hasExportSecrets(serialized)) {
      omissions.push({ call_id: record.call_id, reason: 'credential_like_content', blocking: true })
      return
    }
    const size = Buffer.byteLength(serialized)
    if (size > 1_048_576 || bytes + size > 4_194_304) {
      omissions.push({ call_id: record.call_id, reason: 'capture_limit', blocking: true })
      return
    }
    bytes += size
    records.push(record)
  }
  if (response.status !== 'completed') throw new Error('Only completed work can be captured')
  for (const item of response.output ?? []) {
    if (item.type === 'message') {
      for (const [content_index, content] of (item.content ?? []).entries()) {
        for (const annotation of content.annotations ?? []) {
          if (annotation.type !== 'url_citation') continue
          try {
            const url = new URL(annotation.url)
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue
            append({ kind: 'citation', message_id: item.id, content_index, url: url.href,
              title: annotation.title || url.hostname,
              ...(Number.isInteger(annotation.start_index) ? { start_index: annotation.start_index } : {}),
              ...(Number.isInteger(annotation.end_index) ? { end_index: annotation.end_index } : {}) })
          } catch {}
        }
      }
    } else if (item.type === 'mcp_call') {
      const product = item.name === 'product-knowledge___knowledge_base_retrieve'
      const fabric = item.name?.startsWith('fabric-sales___')
      if (!product && !fabric) {
        omissions.push({ reason: 'unsupported_source', call_id: item.id })
        continue
      }
      let blocks
      let args
      try { blocks = JSON.parse(item.output) } catch { blocks = null }
      try { args = JSON.parse(item.arguments) } catch { args = null }
      const failed = item.status !== 'completed' || Boolean(item.error) || !Array.isArray(blocks)
        || blocks.some((block) => block.isError || block.type === 'error')
      const base = { kind: 'source', tool: product ? 'product-knowledge' : 'fabric-sales', call_id: item.id,
        status: failed ? 'failed' : 'returned',
        provenance: product ? 'Original FieldForge demo documents; source dates are not retrieval dates.'
          : 'Published Fabric data agent; imported sales_performance demo model, not live CRM.',
        ...(typeof args?.userQuestion === 'string' ? { query: args.userQuestion } : {}),
        ...(Array.isArray(args?.query_variants) ? { queries: args.query_variants.filter((query) => typeof query === 'string') } : {}) }
      if (failed) { append({ ...base, error: 'Source failed or returned unverified content; no fallback used.',
        diagnostic: nativeSourceDiagnostic(item, blocks, 'missing_source_evidence') }); continue }
      const text = blocks.filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n')
      if (fabric) {
        append(text.trim() ? { ...base, text } : { ...base, status: 'failed', error: 'No usable source text returned.',
          diagnostic: nativeSourceDiagnostic(item, blocks, 'no_usable_source_text') })
      } else {
        const documents = blocks.flatMap((block) => {
          let reference
          try { reference = JSON.parse(block.text) } catch { return [] }
          const document = reference?.sourceData
          if (block.type !== 'text' || reference?.kind !== 'reference'
            || !['docId', 'title', 'content'].every((field) => typeof document?.[field] === 'string' && document[field].trim())) return []
          return [{ ...Object.fromEntries(['docId', 'title', 'content', 'type', 'audience', 'lastUpdated']
            .filter((field) => typeof document[field] === 'string').map((field) => [field, document[field]])),
          ...(typeof reference.ref_id === 'string' || Number.isInteger(reference.ref_id) ? { ref_id: reference.ref_id } : {}) }]
        })
        append(documents.length ? { ...base, documents } : { ...base, status: 'failed', error: 'No verifiable document references returned.',
          diagnostic: nativeSourceDiagnostic(item, blocks, 'no_verifiable_document_references') })
      }
    } else if (item.type === 'function_call') {
      const result = outputs.get(item.call_id)
      if (!['task', 'view'].includes(item.name) || !result || typeof result.output !== 'string') {
        if (item.name !== 'upload_file_from_workspace_to_foundry_project') omissions.push({ call_id: item.call_id, reason: 'unsupported_tool_output' })
        continue
      }
      let parsed
      let args
      try { parsed = JSON.parse(result.output) } catch { parsed = null }
      try { args = JSON.parse(item.arguments) } catch { args = null }
      if (parsed?.error || result.status === 'failed') {
        append({ kind: 'finding', tool: item.name, call_id: item.call_id, status: 'failed', error: 'Native task or file read failed.' })
      } else if (item.name === 'task') {
        append({ kind: 'finding', tool: 'task', call_id: item.call_id, status: 'returned', text: result.output })
      } else if (typeof args?.path === 'string' && args.path.endsWith('.md')) {
        append({ kind: 'file', origin: 'workspace_readback', call_id: item.call_id, status: 'returned',
          filename: args.path.split('/').pop().replace(/[^a-zA-Z0-9_.-]/g, '_'), text: result.output })
      } else omissions.push({ call_id: item.call_id, reason: 'unsupported_file_type' })
    }
  }
  const usage = Object.fromEntries(['input_tokens', 'output_tokens', 'total_tokens']
    .filter((field) => Number.isSafeInteger(response.usage?.[field]) && response.usage[field] >= 0)
    .map((field) => [field, response.usage[field]]))
  return { records, omissions, usage,
    tool_calls: (response.output ?? []).filter((item) => item.type?.endsWith('_call')).length }
}

export function assertHarnessTurnOptions({ maxOutputTokens, disableTools = false }) {
  if (maxOutputTokens !== undefined || disableTools) {
    throw Object.assign(new Error('Canary proof is blocked: Microsoft Copilot harness does not support tool_choice or max_output_tokens. The approved no-tools and hard output-token limits cannot be enforced per turn.'),
      { status: 503, code: 'HARNESS_UNSUPPORTED_PROOF_CONTRACT' })
  }
}

export async function runHarnessTurn({ client, conversation, input, emit, signal, onCompleted, maxOutputTokens, disableTools = false, rejectToolActivity = false }) {
  signal?.throwIfAborted()
  assertHarnessTurnOptions({ maxOutputTokens, disableTools })
  const stream = await client.responses.create({
    conversation,
    input,
    stream: true,
  }, { signal })
  let response
  for await (const event of stream) {
    signal?.throwIfAborted()
    if (rejectToolActivity && event.item?.type?.endsWith('_call')) throw new Error('Unexpected tool call during canary proof')
    if (event.type === 'response.completed') {
      response = event.response
      break
    } else if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) {
      const failure = new Error('Foundry could not complete this response')
      failure.code = event.response?.error?.code || event.response?.incomplete_details?.reason || event.error?.code || event.type
      failure.responseId = event.response?.id
      failure.requestID = event.request_id || event.error?.request_id
      throw failure
    } else if (event.type === 'response.output_item.done' && event.item?.type === 'mcp_approval_request') {
      throw new Error('This tool requires approval and was not executed')
    } else {
      if (['response.output_item.added', 'response.output_item.done'].includes(event.type) && event.item) {
        emitNativeEvidence(event.item, emit)
      }
      emit(event)
    }
  }
  if (!response || response.status !== 'completed') {
    throw new Error('Foundry stream ended before completion')
  }
  if (rejectToolActivity && response.output.some((item) => item.type?.endsWith('_call'))) throw new Error('Unexpected tool call during canary proof')
  if (response.output.some((item) => item.type === 'mcp_approval_request')) {
    throw new Error('This tool requires approval and was not executed')
  }
  const returnedCalls = new Map(response.output.filter((item) => item.type === 'function_call_output')
    .map((item) => [item.call_id, item]))
  for (const item of response.output) {
    emitNativeEvidence(item, emit)
    if (item.type === 'azure_ai_search_call' && item.status !== 'completed') {
      const result = { source: 'Foundry IQ', execution: 'Native Azure AI Search tool',
        error: 'Native product-document Search failed; no verified documents or source dates returned. No app fallback was used.' }
      emit({ type: 'harness.source', source: 'Foundry IQ', execution: 'native',
        call_id: item.call_id || item.id, status: 'error', result })
    }
    if (item.type === 'mcp_call' && item.name === 'product-knowledge___knowledge_base_retrieve') {
      let content
      try { content = JSON.parse(item.output) } catch { content = null }
      const documents = Array.isArray(content) ? content.flatMap((block) => {
        if (block.type !== 'text' || typeof block.text !== 'string') return []
        let reference
        try { reference = JSON.parse(block.text) } catch { return [] }
        const document = reference?.sourceData
        if (reference?.kind !== 'reference' || !document
          || !['docId', 'title', 'content'].every((field) => typeof document[field] === 'string' && document[field].trim())) return []
        return [Object.fromEntries(['docId', 'title', 'content', 'type', 'audience', 'lastUpdated']
          .filter((field) => typeof document[field] === 'string').map((field) => [field, document[field]]))]
      }) : []
      const failed = item.status !== 'completed' || Boolean(item.error) || Boolean(content?.isError)
        || (Array.isArray(content) && content.some((block) => block.isError || block.type === 'error')) || !documents.length
      const result = { source: 'Foundry IQ', execution: 'Native Foundry IQ knowledge-base MCP',
        identity: 'Foundry project managed identity; not per-user document authorization',
        provenance: 'Original FieldForge demo documents and source dates. Citation links are authenticated index lookups, not original publication URLs.',
        ...(failed ? { error: 'Knowledge-base retrieval failed or returned no verifiable document references. No app fallback was used.',
          diagnostic: nativeSourceDiagnostic(item, content, 'no_verifiable_document_references') }
          : { documents }) }
      emit({ type: 'harness.activity', id: item.id, tool: 'product-knowledge',
        status: failed ? 'failed' : 'returned', output: failed ? `${result.error}\n${JSON.stringify(result.diagnostic)}` : JSON.stringify(documents).slice(0, 16_000) })
      emit({ type: 'harness.source', source: 'Foundry IQ', execution: 'native', call_id: item.id,
        status: failed ? 'error' : 'done', result })
    }
    if (item.type === 'mcp_call' && item.name?.startsWith('fabric-sales___')) {
      let content
      try { content = JSON.parse(item.output) } catch { content = null }
      const text = Array.isArray(content)
        ? content.filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n')
        : ''
      const failed = item.status !== 'completed' || Boolean(item.error) || Boolean(content?.isError)
        || (Array.isArray(content) && content.some((block) => block.isError || block.type === 'error')) || !text.trim()
      const result = { source: 'Fabric IQ', execution: 'Native Foundry Fabric IQ tool',
        identity: 'Signed-in user through Foundry UserEntraToken connection',
        provenance: 'Published Fabric data agent; imported sales_performance demo semantic model, not live CRM',
        ...(failed ? { error: 'Native Fabric query failed or returned no usable text; no verified sales evidence returned.',
          diagnostic: nativeSourceDiagnostic(item, content, 'no_usable_source_text') }
          : { text: text.slice(0, 100_000), documents: [] }) }
      emit({ type: 'harness.activity', id: item.id, tool: 'fabric-sales',
        status: failed ? 'failed' : 'returned', output: failed ? `${result.error}\n${JSON.stringify(result.diagnostic)}` : text.slice(0, 16_000) })
      emit({ type: 'harness.source', source: 'Fabric IQ', execution: 'native', call_id: item.id,
        status: failed ? 'error' : 'done', result })
    }
    if (item.type === 'function_call' && returnedCalls.has(item.call_id)) {
      const output = returnedCalls.get(item.call_id).output
      let parsed
      let args
      try { parsed = JSON.parse(output) } catch { parsed = null }
      try { args = JSON.parse(item.arguments) || {} } catch { args = {} }
      emit({ type: 'harness.activity', id: item.call_id, tool: item.name,
        status: parsed?.error ? 'failed' : 'returned',
        output: typeof output === 'string' ? output.slice(0, 16_000) : undefined })
      if (item.name === 'view' && !parsed?.error && typeof args.path === 'string'
        && args.path.endsWith('.md') && typeof output === 'string' && output.length <= 100_000) {
        emit({ type: 'harness.brief', path: args.path, text: output })
      }
      if (item.name === 'upload_file_from_workspace_to_foundry_project' && !parsed?.error
        && /^(assistant-|file-)[a-zA-Z0-9_-]{1,140}$/.test(parsed?.file_id || '')
        && typeof parsed.filename === 'string' && parsed.filename.endsWith('.md')
        && Number.isInteger(parsed.bytes) && parsed.bytes > 0 && parsed.bytes <= 1_048_576) {
        emit({ type: 'harness.artifact', file_id: parsed.file_id,
          filename: parsed.filename.split('/').pop().replace(/[^a-zA-Z0-9_.-]/g, '_'), bytes: parsed.bytes })
      }
    }
  }
  const calls = response.output.filter((item) => item.type === 'function_call' && !returnedCalls.has(item.call_id))
  if (calls.length) throw new Error('Foundry requested an unapproved function')
  await onCompleted?.(response)
  emit({ type: 'response.completed', response })
  return response
}

export async function createSnapshotConversation({ client, messages, signal }) {
  if (!Array.isArray(messages) || !messages.length || messages.length % 2
    || messages.some((message, index) => message.role !== (index % 2 ? 'assistant' : 'user')
      || typeof message.content !== 'string' || !message.content.trim())
    || Buffer.byteLength(JSON.stringify(messages)) > 262_144) {
    throw new Error('Expected a bounded snapshot of completed user/assistant text pairs')
  }
  const items = messages.map(({ role, content }) => ({ type: 'message', role, content }))
  let conversation
  try {
    signal?.throwIfAborted()
    conversation = await client.conversations.create({ items: items.slice(0, 20) }, { signal })
    for (let offset = 20; offset < items.length; offset += 20) {
      signal?.throwIfAborted()
      await client.conversations.items.create(conversation.id, { items: items.slice(offset, offset + 20) }, { signal })
    }
    signal?.throwIfAborted()
    return conversation
  } catch (error) {
    if (conversation) {
      try { await client.conversations.delete(conversation.id, { signal: AbortSignal.timeout(5000) }) }
      catch {}
    }
    throw error
  }
}