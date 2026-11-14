import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { buildFabricModelDefinition, buildIqDemoData, DATASET_ID, exportIqDemoData, SIMULATED_AS_OF, toCsv } from '../scripts/generate_iq_demo_data.mjs'
import { appendFabricModel, publishSearchDocuments, restrictFabricDocumentEvidence } from '../scripts/load_iq_demo_data.mjs'

test('expanded IQ fixtures are deterministic, synthetic and correctly linked', () => {
  const data = buildIqDemoData()
  assert.deepEqual(data, buildIqDemoData())
  assert.deepEqual(data.manifest.counts, { territories: 6, capabilities: 6, accounts: 18, salesPerformance: 72, opportunities: 36, documents: 12 })
  for (const table of [data.territories, data.capabilities, data.accounts, data.salesPerformance, data.opportunities]) {
    for (const row of table) {
      assert.equal(row.datasetId, DATASET_ID)
      assert.equal(row.classification, 'synthetic-demo')
      assert.equal(row.simulatedAsOf, SIMULATED_AS_OF)
    }
  }
  const territoryIds = new Set(data.territories.map((row) => row.territoryId))
  const accountIds = new Set(data.accounts.map((row) => row.accountId))
  const capabilityIds = new Set(data.capabilities.map((row) => row.capabilityId))
  const docIds = new Set(data.documents.map((row) => row.docId))
  assert.equal(accountIds.size, 18)
  assert.equal(new Set(data.opportunities.map((row) => row.opportunityId)).size, 36)
  assert.equal(new Set(data.salesPerformance.map((row) => row.salesRowId)).size, 72)
  for (const row of [...data.accounts, ...data.salesPerformance]) assert.ok(territoryIds.has(row.territoryId))
  for (const row of data.opportunities) {
    assert.ok(accountIds.has(row.accountId))
    assert.ok(capabilityIds.has(row.capabilityId))
    assert.ok(docIds.has(row.supportingDocId))
    assert.ok(row.amount > 0 && row.probability >= 0 && row.probability <= 1)
    assert.ok(row.lastActivityDate <= SIMULATED_AS_OF)
    assert.equal(row.stage.startsWith('Closed '), row.closeDate <= SIMULATED_AS_OF)
    if (row.capabilityId === 'weather-scheduling') assert.match(row.blocker, /roadmap-only/)
  }
  for (const row of data.documents) {
    assert.equal(row.id, row.docId)
    assert.match(row.title, /Synthetic demo/)
    assert.match(row.content, /not live CRM/)
    assert.match(row.content, /not verified publication freshness/)
  }
})

test('sales have unique monthly grain, closed periods and meaningful independent territory trends', () => {
  const { salesPerformance, territories } = buildIqDemoData()
  assert.equal(new Set(salesPerformance.map((row) => [row.month, row.territoryId, row.segment].join('|'))).size, 72)
  const totals = (territoryId, fiscalYear) => salesPerformance.filter((row) => row.territoryId === territoryId && row.fiscalYear === fiscalYear)
    .reduce((sum, row) => ({ revenue: sum.revenue + row.revenue, quota: sum.quota + row.quota }), { revenue: 0, quota: 0 })
  for (const row of salesPerformance) {
    assert.ok(Number.isInteger(row.revenue) && row.revenue >= 0)
    assert.ok(Number.isInteger(row.quota) && row.quota > 0)
    assert.ok(row.month < SIMULATED_AS_OF.slice(0, 7))
    assert.equal(row.fiscalQuarter, row.month < '2026-07' ? 'Q4' : 'Q1')
  }
  const byTerritory = Object.fromEntries(territories.map((territory) => [territory.territory, totals(territory.territoryId, 'FY27')]))
  assert.ok(byTerritory.South.revenue / byTerritory.South.quota < byTerritory.West.revenue / byTerritory.West.quota)
  assert.ok(byTerritory.Central.revenue > byTerritory.Central.quota)
  const southeast = territories.find((row) => row.territory === 'Southeast').territoryId
  assert.ok(totals(southeast, 'FY27').revenue / totals(southeast, 'FY27').quota > totals(southeast, 'FY26').revenue / totals(southeast, 'FY26').quota)
})

test('export produces escaped CSV, Search-ready documents and content hashes without overwriting', async () => {
  assert.equal(toCsv([{ name: 'A "quoted", buyer', note: 'Line one\nLine two' }]), '"name","note"\r\n"A ""quoted"", buyer","Line one\nLine two"\r\n')
  const directory = await mkdtemp(join(tmpdir(), 'iq-demo-fixtures-'))
  try {
    const exported = await exportIqDemoData(directory)
    for (const [name, hash] of Object.entries(exported.sha256)) {
      assert.equal(createHash('sha256').update(await readFile(join(directory, name))).digest('hex'), hash)
    }
    const documents = JSON.parse(await readFile(join(directory, 'search-documents.json'), 'utf8'))
    assert.equal(documents.length, 12)
    assert.deepEqual(Object.keys(documents[0]), ['id', 'docId', 'title', 'type', 'audience', 'lastUpdated', 'content'])
    await assert.rejects(exportIqDemoData(directory), { code: 'EEXIST' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('Fabric definition embeds exactly the fixture rows with single-direction relationships and distinct sales/pipeline measures', () => {
  const definition = buildFabricModelDefinition()
  assert.equal(definition.format, 'TMSL')
  const model = JSON.parse(Buffer.from(definition.parts.find((part) => part.path === 'model.bim').payload, 'base64')).model
  const data = buildIqDemoData()
  const expected = { territories: data.territories, capabilities: data.capabilities, accounts: data.accounts, sales_performance: data.salesPerformance, opportunities: data.opportunities }
  assert.equal(model.tables.length, 5)
  for (const table of model.tables) {
    assert.match(table.description, /not live CRM/)
    assert.equal(table.partitions[0].mode, 'import')
    const expression = table.partitions[0].source.expression.join('\n')
    const encoded = expression.match(/Binary.FromText\("([A-Za-z0-9+/=]+)"/)[1]
    assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64')), expected[table.name])
    assert.doesNotMatch(expression, /Web\.Contents|File\.Contents|https:\/\//)
    for (const column of table.columns) assert.equal(column.summarizeBy, 'none')
  }
  assert.equal(model.relationships.length, 4)
  for (const relation of model.relationships) {
    assert.equal(relation.crossFilteringBehavior, 'oneDirection')
    assert.equal(relation.fromCardinality, 'many')
    assert.equal(relation.toCardinality, 'one')
    const from = model.tables.find((table) => table.name === relation.fromTable)
    const to = model.tables.find((table) => table.name === relation.toTable)
    assert.ok(from.columns.some((column) => column.name === relation.fromColumn))
    assert.ok(to.columns.some((column) => column.name === relation.toColumn))
  }
  const sales = model.tables.find((table) => table.name === 'sales_performance')
  assert.equal(sales.measures.find((measure) => measure.name === 'Total Revenue').expression, 'SUM(sales_performance[revenue])')
  assert.equal(sales.measures.find((measure) => measure.name === 'Quota Attainment').expression, 'DIVIDE([Total Revenue], [Total Quota])')
  const opportunities = model.tables.find((table) => table.name === 'opportunities')
  assert.match(opportunities.measures.find((measure) => measure.name === 'Open Pipeline').expression, /Closed Won.*Closed Lost/)
})

test('Search append preserves originals, refuses conflicting documents and removes its grant on every write failure', async () => {
  const original = { id: 'original-1', docId: 'DOC-1', content: 'Unchanged original', lastUpdated: '2026-08-01' }
  const documents = buildIqDemoData().documents
  let indexed = [original]
  const calls = []
  const operations = {
    readDocuments: async () => structuredClone(indexed),
    grantWrite: async () => { calls.push('grant') },
    revokeWrite: async () => { calls.push('revoke') },
    uploadDocuments: async (rows) => { calls.push('upload'); indexed.push(...rows) },
  }
  assert.deepEqual(await publishSearchDocuments(operations), { added: 12, total: 13, preserved: 1, temporaryGrantRemoved: true })
  assert.deepEqual(calls, ['grant', 'upload', 'revoke'])
  calls.length = 0
  assert.equal((await publishSearchDocuments(operations)).added, 0)
  assert.deepEqual(calls, [])
  indexed = [original, { ...documents[0], content: 'Different existing document' }]
  await assert.rejects(publishSearchDocuments(operations), /Refusing to overwrite/)
  assert.deepEqual(calls, [])
  indexed = [original]
  await assert.rejects(publishSearchDocuments({ ...operations, uploadDocuments: async () => { throw new Error('upload failed') } }), /upload failed/)
  assert.deepEqual(calls, ['grant', 'revoke'])
  calls.length = 0
  await assert.rejects(publishSearchDocuments({ ...operations, grantWrite: async () => { throw new Error('ambiguous grant response') } }), /ambiguous grant response/)
  assert.deepEqual(calls, ['revoke'])
})

test('Fabric binding changes only draft routing and appends the new source, preserving all original and published parts', () => {
  const part = (path, value) => ({ path, payload: Buffer.from(JSON.stringify(value)).toString('base64'), payloadType: 'InlineBase64' })
  const original = part('Files/Config/draft/semantic-model-FieldForge/datasource.json', { artifactId: '61b44778-6bd9-456e-a770-a004e09e0fc8' })
  const published = part('Files/Config/published/stage_config.json', { aiInstructions: 'Original published instructions' })
  const definition = { parts: [original, published, part('Files/Config/draft/stage_config.json', { aiInstructions: 'Original draft instructions' })] }
  const before = structuredClone(definition)
  const model = JSON.parse(Buffer.from(buildFabricModelDefinition().parts[0].payload, 'base64')).model
  const updated = appendFabricModel(definition, '11111111-2222-4333-8444-555555555555', model)
  assert.deepEqual(definition, before)
  assert.deepEqual(updated.parts[0], original)
  assert.deepEqual(updated.parts[1], published)
  assert.match(JSON.parse(Buffer.from(updated.parts[2].payload, 'base64')).aiInstructions, /not live CRM/)
  const source = JSON.parse(Buffer.from(updated.parts[3].payload, 'base64'))
  assert.equal(source.artifactId, '11111111-2222-4333-8444-555555555555')
  assert.equal(source.elements.length, 5)
  assert.ok(source.elements.every((table) => table.is_selected && table.children.every((child) => child.is_selected)))
  assert.throws(() => appendFabricModel(updated, source.artifactId, model), /already configured/)
  assert.throws(() => appendFabricModel(definition, '61b44778-6bd9-456e-a770-a004e09e0fc8', model))
})

test('Fabric document boundary changes only draft instructions, preserves existing policy and is idempotent', () => {
  const part = (path, content) => ({ path, payload: Buffer.from(JSON.stringify(content)).toString('base64'), payloadType: 'InlineBase64' })
  const stagePath = 'Files/Config/draft/stage_config.json'
  const definition = { parts: [
    part(stagePath, { $schema: 'stage-schema', aiInstructions: 'Preserve fiscal labels; synthetic data, not live CRM; read-only queries.', retainedSetting: true }),
    part('Files/Config/published/stage_config.json', { aiInstructions: 'Previously published policy' }),
    part('Files/Config/draft/semantic-model-FieldForge/datasource.json', { artifactId: 'original-model' }),
    part('Files/Config/draft/semantic-model-CopilotHarnessSyntheticSalesV1/datasource.json', { artifactId: 'synthetic-model' }),
    part('Files/Config/publish_info.json', { description: 'Existing publication description' }),
  ] }
  const before = structuredClone(definition)
  const updated = restrictFabricDocumentEvidence(definition)
  assert.deepEqual(definition, before)
  assert.deepEqual(updated.parts.slice(1), before.parts.slice(1))
  const content = JSON.parse(Buffer.from(updated.parts[0].payload, 'base64'))
  assert.equal(content.retainedSetting, true)
  assert.equal(content.$schema, 'stage-schema')
  assert.ok(content.aiInstructions.startsWith('Preserve fiscal labels; synthetic data, not live CRM; read-only queries.'))
  assert.match(content.aiInstructions, /document evidence was not retrieved here/)
  assert.match(content.aiInstructions, /never as proof of document content/)
  assert.deepEqual(restrictFabricDocumentEvidence(updated), updated)
  assert.throws(() => restrictFabricDocumentEvidence({ parts: [] }), /draft instructions/)
})