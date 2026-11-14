import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { runHarnessQuery } from '../src/agentClient.js'

test('real harness native research, optional connectors, artifacts, and workspace continuity', {
  skip: process.env.RUN_LIVE_HARNESS !== '1', timeout: 600_000,
}, async (context) => {
  const base = process.env.HARNESS_TEST_URL || 'http://127.0.0.1:5177'
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname))
  const originalFetch = globalThis.fetch
  const sessions = new Set()
  globalThis.fetch = (path, options) => originalFetch(new URL(path, base), options)

  async function turn(question, session) {
    const result = { answer: '', sources: [], activity: [], evidence: [], artifacts: [], errors: [], completed: false }
    await runHarnessQuery(question, {
      onText: (text) => { result.answer = text },
      onEvent: (event) => {
        if (event.type === 'harness.session') {
          result.session = event.session_id
          sessions.add(event.session_id)
        }
        if (event.type === 'harness.source' && event.status !== 'running') result.sources.push(event)
        if (event.type === 'harness.activity') result.activity.push(event)
        if (event.type === 'harness.evidence') result.evidence.push(event)
        if (event.type === 'harness.brief') result.brief = event
        if (event.type === 'harness.artifact') result.artifacts.push(event)
      },
      onDone: (response) => { result.completed = true; result.response = response },
      onError: (message) => { result.errors.push(message) },
    }, process.env.HARNESS_TEST_TOKEN || null, { body: session ? { session_id: session } : {} })
    if (result.errors.length || result.sources.some((source) => source.status === 'error')) console.log(JSON.stringify({ errors: result.errors,
      connectors: result.sources.map(({ source, status }) => ({ source, status })),
      activity: result.activity.map(({ tool, status }) => ({ tool, status })).slice(-30) }))
    assert.deepEqual(result.errors, [])
    assert.equal(result.completed, true)
    return result
  }

  try {
    let first
    const marker = randomUUID()
    await context.test('native knowledge-base retrieval returns original document evidence without an app wrapper', async () => {
      first = await turn(`Compare FieldForge with Procore using only the native product-knowledge knowledge base. Give the comparison itself with document IDs and original source dates. Do not query Fabric, public web, subagents or workspace files. Remember this conversation marker: ${marker}.`)
      assert.ok(first.sources.length > 0)
      assert.ok(first.sources.every((source) => source.source === 'Foundry IQ' && source.status === 'done' && source.execution === 'native'))
      const output = first.response.output
      const knowledge = output.find((item) => item.type === 'mcp_call'
        && item.name === 'product-knowledge___knowledge_base_retrieve' && item.status === 'completed')
      assert.ok(knowledge, 'Native knowledge-base MCP retrieval did not complete successfully')
      assert.match(knowledge.output, /DOC-2/, 'Original document ID must be present in actual tool evidence')
      assert.match(knowledge.output, /2026-08-20/, 'Original source date must be present in actual tool evidence')
      assert.ok(first.sources.some((source) => source.result.documents.some((document) => document.docId === 'DOC-2' && document.lastUpdated === '2026-08-20')))
      assert.ok(first.activity.some((item) => item.tool === 'product-knowledge' && item.status === 'returned'))
      assert.equal(output.some((item) => item.type === 'azure_ai_search_call'), false)
      assert.equal(output.some((item) => item.type === 'function_call' && item.name === 'search_product_docs'), false)
      assert.equal(first.activity.some((item) => item.tool === 'fabric-sales' || item.tool === 'web_search_call'), false)
      assert.match(first.answer, /DOC-2/)
      assert.match(first.answer, /2026-08-20/)
    })

    await context.test('follow-up reuses the conversation and remembers its unique marker', async () => {
      assert.ok(first?.session)
      const followUp = await turn('What conversation marker did I ask you to remember? Return only that marker.', first.session)
      assert.equal(followUp.session, first.session)
      assert.ok(followUp.answer.includes(marker))
      assert.equal(followUp.sources.length, 0)
    })

    await context.test('source-free quota question queries native sales data instead of asking for uploads', async () => {
      const result = await turn('Which territories are furthest below quota in FY26/Q1?')
      assert.deepEqual(new Set(result.sources.map((source) => source.source)), new Set(['Fabric IQ']))
      const fabricCall = result.sources.find((source) => source.source === 'Fabric IQ')
      assert.equal(fabricCall.status, 'done')
      assert.equal(fabricCall.execution, 'native')
      assert.match(fabricCall.result.identity, /Signed-in user/)
      assert.match(fabricCall.result.provenance, /import/i)
      assert.ok(result.response.output.some((item) => item.type === 'mcp_call'
        && item.name === 'fabric-sales___DataAgent_microsoftiq_copilot_sales' && item.status === 'completed'))
      assert.ok(result.activity.some((item) => item.tool === 'fabric-sales' && item.status === 'returned'))
      for (const text of [fabricCall.result.text, result.answer]) {
        assert.match(text, /West/i)
        assert.match(text, /South/i)
        const figures = text.replaceAll(',', '')
        for (const expected of ['320000', '350000', '30000', '61000', '90000', '29000']) assert.ok(figures.includes(expected), `Missing imported sales figure ${expected}`)
      }
      assert.doesNotMatch(result.answer, /```(?:python|sql)|pd\.read_csv|upload (?:a |an |the )?(?:CSV|Excel)/i)
      assert.doesNotMatch(result.answer.replaceAll('*', ''),
        /(?:largest|greatest|biggest)\s+(?:(?:absolute|dollar|monetary)\s+)?(?:shortfall|deficit)\s*[:=]\s*Central\b/i,
        'An over-quota surplus must not be reported as the largest below-quota deficit')
    })

    await context.test('source-free sales positioning combines original documents and imported sales aggregates without wrappers', async () => {
      const result = await turn('Where should we focus sales attention in FY26/Q1, and which FieldForge capabilities would strengthen our pitch against Procore? Include territory revenue, quota and shortfall, plus supporting product-document IDs and original update dates.')
      assert.deepEqual(new Set(result.sources.map((source) => source.source)), new Set(['Fabric IQ', 'Foundry IQ']))
      assert.ok(result.sources.every((source) => source.status === 'done' && source.execution === 'native'),
        JSON.stringify(result.sources.map(({ source, status, execution }) => ({ source, status, execution }))))
      assert.ok(result.sources.some((source) => source.result.documents?.some((document) => document.docId === 'DOC-2' && document.lastUpdated === '2026-08-20')))
      assert.match(result.answer, /DOC-2/)
      assert.match(result.answer, /2026-08-20/)
      const fabricCall = result.sources.find((source) => source.source === 'Fabric IQ')
      assert.equal(fabricCall.status, 'done')
      assert.equal(fabricCall.execution, 'native')
      assert.match(fabricCall.result.identity, /Signed-in user/)
      assert.match(fabricCall.result.provenance, /import/i)
      assert.ok(result.activity.some((item) => item.tool === 'fabric-sales' && item.status === 'returned'))
      for (const text of [fabricCall.result.text, result.answer]) {
        const figures = text.replaceAll(',', '')
        for (const expected of ['320000', '350000', '30000', '61000', '90000', '29000']) assert.ok(figures.includes(expected), `Missing imported sales figure ${expected}`)
      }
    })

    let research
    await context.test('native research publishes an actual downloadable brief', async () => {
      const result = await turn('Research Miami-Dade construction-site hurricane preparedness. Use native web_search to discover official guidance, then call harness web_fetch yourself on https://www.weather.gov/safety/hurricane and use its returned content. Do not delegate or query business connectors. Write a concise 150-word Markdown brief to /home/session/workspace/research-brief.md, read the saved file back, and upload that exact absolute workspace path to Foundry Files. Include evidence URLs and missing dates as unknown; preparedness advice is not an active warning.')
      research = result
      console.log(JSON.stringify({ nativeActivity: result.activity.map(({ tool, status }) => ({ tool, status })).slice(-30),
        publishedArtifacts: result.artifacts.length, citations: result.evidence.length }))
      assert.equal(result.sources.length, 0)
      assert.ok(result.activity.some((item) => item.tool === 'web_search_call' && item.status === 'completed'))
      assert.ok(result.activity.some((item) => item.tool === 'web_fetch' && item.status === 'returned'))
      assert.ok(result.evidence.length > 0)
      assert.ok(result.evidence.every((item) => /^https?:\/\//.test(item.url)))
      assert.ok(result.brief?.text.length > 100)
      assert.ok(result.artifacts.length > 0, 'No genuine Foundry upload result')
      const artifact = result.artifacts.at(-1)
      const headers = process.env.HARNESS_TEST_TOKEN ? { Authorization: `Bearer ${process.env.HARNESS_TEST_TOKEN}` } : {}
      const path = `/api/harness/sessions/${result.session}/files/${artifact.file_id}`
      const download = await originalFetch(new URL(path, base), { headers })
      assert.equal(download.status, 200)
      assert.equal(download.headers.get('cache-control'), 'no-store')
      assert.match(download.headers.get('content-type'), /text\/markdown/)
      assert.ok((await download.text()).length > 100)
      const invalid = await originalFetch(new URL(`/api/harness/sessions/${result.session}/files/assistant-not-registered`, base), { headers })
      assert.equal(invalid.status, 404)
      if (process.env.HARNESS_TEST_TOKEN) {
        const anonymous = await originalFetch(new URL(path, base))
        assert.equal(anonymous.status, 401)
      }
      console.log(JSON.stringify({ connectors: result.sources.map(({ source, status }) => ({ source, status })),
        nativeTools: [...new Set(result.activity.map((item) => item.tool))], publishedArtifacts: result.artifacts.length, download: download.status }))
    })

    await context.test('follow-up revises and reads the same workspace brief before republishing', async () => {
      assert.ok(research?.session)
      const revision = await turn(`Read the existing research brief from our workspace, revise it to add the exact review marker ${marker}, save the revision, read the final revised file back, and upload it to Foundry Files. Do not query connectors or web sources again. Return the revised brief and actual file ID.`, research.session)
      assert.equal(revision.session, research.session)
      assert.equal(revision.sources.length, 0)
      assert.ok(revision.activity.some((item) => item.tool === 'view' && item.status === 'returned'))
      assert.ok(revision.brief?.text.includes(marker))
      assert.ok(revision.artifacts.length > 0)
    })
  } finally {
    globalThis.fetch = originalFetch
    for (const session of sessions) {
      const response = await originalFetch(new URL(`/api/harness/sessions/${session}`, base), {
        method: 'DELETE',
        headers: process.env.HARNESS_TEST_TOKEN ? { Authorization: `Bearer ${process.env.HARNESS_TEST_TOKEN}` } : {},
      })
      assert.ok(response.ok || response.status === 404, 'Could not clean up the test conversation')
    }
  }
})

test('expanded synthetic opportunities and forecast documentation are retrieved natively', {
  skip: process.env.RUN_LIVE_IQ_DATA !== '1', timeout: 300_000,
}, async () => {
  const base = process.env.HARNESS_TEST_URL || 'http://127.0.0.1:5177'
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname))
  const originalFetch = globalThis.fetch
  globalThis.fetch = (path, options) => originalFetch(new URL(path, base), options)
  const result = { answer: '', sources: [], activity: [], errors: [], completed: false }
  const headers = process.env.HARNESS_TEST_TOKEN ? { Authorization: `Bearer ${process.env.HARNESS_TEST_TOKEN}` } : {}
  try {
    await runHarnessQuery('Using the expanded synthetic demo, how many open opportunities are there, what are the total and probability-weighted open pipeline in full USD amounts, and which published internal document explains the opportunity stage and forecasting definitions? Include dataset provenance, the simulated as-of date, document ID and its stored date. Do not query public web or save files.', {
      onText: (text) => { result.answer = text },
      onEvent: (event) => {
        if (event.type === 'harness.session') result.session = event.session_id
        if (event.type === 'harness.source' && event.status !== 'running') result.sources.push(event)
        if (event.type === 'harness.activity') result.activity.push(event)
      },
      onDone: (response) => { result.completed = true; result.response = response },
      onError: (message) => { result.errors.push(message) },
    }, process.env.HARNESS_TEST_TOKEN || null)
    console.log(JSON.stringify({ connectors: result.sources.map(({ source, status, execution }) => ({ source, status, execution })), activity: result.activity.map(({ tool, status }) => ({ tool, status })), errors: result.errors, answer: result.answer }))
    assert.deepEqual(result.errors, [])
    assert.equal(result.completed, true)
    assert.deepEqual(new Set(result.sources.map((source) => source.source)), new Set(['Fabric IQ', 'Foundry IQ']))
    assert.ok(result.sources.every((source) => source.status === 'done' && source.execution === 'native'))
    const fabric = result.sources.find((source) => source.source === 'Fabric IQ')
    const knowledge = result.response.output.find((item) => item.type === 'mcp_call' && item.name === 'product-knowledge___knowledge_base_retrieve' && item.status === 'completed')
    assert.ok(knowledge)
    for (const text of [fabric.result.text, result.answer]) {
      const amounts = text.replaceAll(',', '')
      assert.match(amounts, /2190000/)
      assert.match(amounts, /880500/)
      assert.match(text, /\b24\b/)
    }
    assert.match(knowledge.output, /SYN-IQ-V1-DOC-08/)
    assert.ok(result.sources.some((source) => source.result.documents?.some((document) => document.docId === 'SYN-IQ-V1-DOC-08' && document.lastUpdated === '2026-10-30')))
    assert.match(result.answer, /SYN-IQ-V1-DOC-08/)
    assert.match(result.answer, /2026-10-30/)
    assert.match(result.answer, /synthetic/i)
    assert.ok(!result.activity.some((event) => event.tool === 'web_search_call'))
  } finally {
    globalThis.fetch = originalFetch
    if (result.session) {
      const response = await originalFetch(new URL(`/api/harness/sessions/${result.session}`, base), { method: 'DELETE', headers })
      assert.ok(response.ok || response.status === 404, 'Could not clean up the synthetic-data test conversation')
    }
  }
})