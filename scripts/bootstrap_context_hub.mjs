import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { docs } from '../src/data/raw/productDocs.js'

const subscription = 'b7fdcea6-b30a-43fc-b3a1-7f2e30b31e7e'
const tenant = 'f81ccca0-e708-41b0-9ad9-577672515a1a'
const groupScope = `/subscriptions/${subscription}/resourceGroups/rg-copilot-agent-context-hub/`
const apiVersion = '2026-08-01-preview'
const fieldNames = ['id', 'docId', 'title', 'content', 'type', 'audience', 'lastUpdated']

export function fixtureDocuments(original, synthetic) {
  const documents = [...original.map(({ summary, ...document }) => ({ ...document, id: document.docId,
    content: `Original demonstration fixture summary (not the full source document):\n${summary}` })), ...synthetic]
  assert.equal(new Set(documents.map((document) => document.id)).size, documents.length)
  for (const document of documents) {
    for (const field of fieldNames) assert.equal(typeof document[field], 'string', `Missing ${field}`)
    assert.match(document.lastUpdated, /^\d{4}-\d{2}-\d{2}$/)
  }
  return documents
}

export function searchDefinitions(modelResourceUri) {
  assert.match(modelResourceUri, /^https:\/\/cog-context-hub-[a-z0-9]+\.openai\.azure\.com$/)
  return {
    index: { name: 'product-docs', fields: fieldNames.map((name) => ({ name, type: 'Edm.String', key: name === 'id',
      searchable: true, filterable: true, retrievable: true, sortable: true, facetable: true })),
    semantic: { configurations: [{ name: 'product-docs-semantic-config', rankingOrder: 'BoostedRerankerScore',
      prioritizedFields: { titleField: { fieldName: 'title' }, prioritizedContentFields: [{ fieldName: 'content' }] } }] } },
    source: { name: 'harness-product-docs', kind: 'searchIndex',
      description: 'Public demonstration fixture summaries and unchanged synthetic scenario documents; original source dates, not live product facts.',
      searchIndexParameters: { searchIndexName: 'product-docs', semanticConfigurationName: 'product-docs-semantic-config',
        sourceDataFields: fieldNames.map((name) => ({ name })), searchFields: [{ name: 'title' }, { name: 'content' }] } },
    knowledgeBase: { name: 'harness-product-knowledge',
      description: 'Context Hub demonstration fixtures with preserved dates; original documents are summaries, synthetic documents are authored scenarios.',
      outputMode: 'extractiveData', knowledgeSources: [{ name: 'harness-product-docs' }],
      models: [{ kind: 'azureOpenAI', azureOpenAIParameters: { resourceUri: modelResourceUri, deploymentId: 'gpt-5-mini', modelName: 'gpt-5-mini' } }],
      retrievalReasoningEffort: { kind: 'low' }, retrieveDefaults: { maxRuntimeInSeconds: 45, maxOutputDocuments: 3 } },
  }
}

function az(args) {
  const result = spawnSync('az', [...args, '--output', 'json', '--only-show-errors'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`Azure CLI failed: ${result.stderr.slice(0,2000)}`)
  return result.stdout.trim() ? JSON.parse(result.stdout) : null
}

async function main() {
  assert(process.argv.includes('--apply'), 'Target Search writes require --apply and the approved isolated deployment')
  const deployment = JSON.parse(fs.readFileSync('.state/provisioning/create-auth-options-repair.json', 'utf8'))
  assert.equal(deployment.result.properties.provisioningState, 'Succeeded')
  const outputs = deployment.result.properties.outputs
  const value = (name) => outputs[name].value
  assert(value('searchResourceId').startsWith(groupScope))
  assert(value('accountResourceId').startsWith(groupScope))
  const resource = az(['resource', 'show', '--ids', value('searchResourceId'), '--subscription', subscription, '--api-version', '2025-05-01'])
  assert.equal(resource.properties.disableLocalAuth, true)
  assert.equal(value('searchEndpoint'), `https://${resource.name}.search.windows.net`)
  const documents = fixtureDocuments(docs, JSON.parse(fs.readFileSync('data/synthetic-iq-sales-v1/search-documents.json', 'utf8')))
  const definitions = searchDefinitions(value('modelResourceUri'))
  const token = az(['account', 'get-access-token', '--tenant', tenant, '--resource', 'https://search.azure.com']).accessToken
  const receipt = { started: new Date().toISOString(), operations: [], cleanup: [] }
  async function request(method, path, body) {
    const response = await fetch(`${value('searchEndpoint')}/${path}?api-version=${apiVersion}`, {
      method, signal: AbortSignal.timeout(60_000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    receipt.operations.push({ method, path, status: response.status, at: new Date().toISOString() })
    if (!response.ok) throw new Error(`Target Search ${method} ${path} returned HTTP ${response.status}`)
    return response.json()
  }
  try {
    await request('PUT', 'indexes/product-docs', definitions.index)
    const indexed = await request('POST', 'indexes/product-docs/docs/index', { value: documents.map((document) => ({ ...document, '@search.action': 'upload' })) })
    assert(indexed.value.every((item) => item.status === true), 'One or more fixture uploads failed')
    await request('PUT', 'knowledgesources/harness-product-docs', definitions.source)
    await request('PUT', 'knowledgebases/harness-product-knowledge', definitions.knowledgeBase)
    for (const document of documents) {
      const stored = await request('GET', `indexes/product-docs/docs/${encodeURIComponent(document.id)}`)
      for (const field of fieldNames) assert.equal(stored[field], document[field], `${document.id} ${field} differs`)
    }
    receipt.verifiedDocuments = documents.length
    receipt.success = true
  } catch (error) {
    receipt.success = false
    receipt.error = error.message
    throw error
  } finally {
    for (const id of value('loaderAssignmentIds')) {
      assert(id.startsWith(value('searchResourceId') + '/providers/Microsoft.Authorization/roleAssignments/'))
      try { az(['role', 'assignment', 'delete', '--ids', id, '--subscription', subscription]); receipt.cleanup.push({ id, removed: true }) }
      catch (error) { receipt.cleanup.push({ id, removed: false, error: error.message }) }
    }
    receipt.finished = new Date().toISOString()
    fs.writeFileSync('.state/provisioning/search-bootstrap.json', JSON.stringify(receipt, null, 2), { mode: 0o600 })
    console.log(JSON.stringify(receipt))
  }
  assert(receipt.cleanup.every((item) => item.removed), 'Temporary loader grant cleanup failed')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1 })
}