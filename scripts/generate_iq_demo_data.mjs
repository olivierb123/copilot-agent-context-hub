import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const DATASET_ID = 'synthetic-iq-sales-v1'
export const SIMULATED_AS_OF = '2026-10-30'
const DISCLOSURE = 'Authored synthetic demonstration data, not live CRM, customer evidence, verified product documentation or a current-market claim.'

const REGIONS = [
  ['West', 'Dana Whitfield', 'Evan Brooks', ['Canyon Crest Contractors', 'Pacific Span Infrastructure', 'Redwood Siteworks'], 89, 80],
  ['Central', 'Marcus Cole', 'Elena Ruiz', ['Prairie Grid Builders', 'Great Lakes Civil Group', 'Heartland Modular'], 104, 108],
  ['South', 'Priya Nandan', 'Jordan Ellis', ['Bayou Bridge Contractors', 'Gulfline Industrial', 'Palmetto Crew Services'], 68, 61],
  ['Northeast', 'Leah Chen', 'Samira Patel', ['Harborstone Construction', 'Atlantic Railworks', 'Granite Field Services'], 96, 93],
  ['Southeast', 'Noah Grant', 'Amara Okafor', ['Piedmont Site Partners', 'Coastal Transit Works', 'Cypress Build Group'], 81, 92],
  ['Northwest', 'Maya Torres', 'Owen Reed', ['Cascade Civil Partners', 'Rainier Energy Build', 'Evergreen Fieldworks'], 92, 101],
]

const CAPABILITIES = [
  ['crew-dispatch', 'Crew dispatch and field handoff', 'simulated-available', '01'],
  ['field-to-crm', 'Field-to-CRM opportunity handoff', 'simulated-available', '02'],
  ['permit-signals', 'Permit-triggered prospect research', 'simulated-limited-preview', '03'],
  ['multisite-rollout', 'Multi-site rollout planning', 'simulated-available', '04'],
  ['integration-security', 'Integration and security discovery', 'simulated-validation-required', '05'],
  ['weather-scheduling', 'Weather-aware scheduling', 'simulated-roadmap-not-available', '06'],
]

const DOCUMENTS = [
  ['01', 'Crew dispatch discovery and evaluation guide', 'crew-dispatch', 'technical',
    'Simulated available capability: assign a crew to a job, record acceptance, and expose an office handoff. Demonstrate using synthetic crew records; do not promise an autonomous dispatcher or external writes. Qualify how dispatchers handle reassignment, missing acknowledgements and offline field updates. A sample evaluation measures unacknowledged assignments before and after a two-week pilot. The pilot target is a proposed success criterion, not a measured improvement. Ask the buyer to supply a baseline; no customer savings or ROI study exists in this dataset.'],
  ['02', 'Field-to-CRM sales handoff playbook', 'field-to-crm', 'sales',
    'Simulated available capability: prepare a reviewable opportunity handoff from field observations. Preserve account, territory, source record and owner; deduplicate before a seller approves a CRM write. This demo agent cannot write to CRM. Discovery should identify the current handoff owner, required fields and duplicate-handling process. For buyers concerned about missed follow-up, propose an acceptance checklist and an owner-reviewed pilot rather than a guaranteed revenue uplift. Never imply that a permit signal proves purchase intent.'],
  ['03', 'Permit-signal coverage and qualification limits', 'permit-signals', 'technical',
    'Simulated limited preview: a permit feed can generate research candidates only after jurisdiction, project type, record age and licensing rights are checked. No live permit feed, county coverage matrix or current permit is included in this pack. Use permit-triggered research as a discovery scenario, not evidence that a specific account has a new project. Roadmap expansion is not released coverage. Ask a buyer which jurisdictions and permitted record types are essential before proposing a preview evaluation.'],
  ['04', 'Multi-site rollout pilot plan', 'multisite-rollout', 'sales',
    'Simulated available capability: define a site-by-site adoption plan with local dispatch owners and a central sponsor. A proposed four-week evaluation uses two synthetic sites, an owner approval gate and a rollback checklist. Compare assignment completeness and handoff timeliness against a buyer-supplied baseline. Enterprise opportunities should identify procurement, a site champion, integration ownership and rollout dependencies. Do not equate territory-level sales performance with an individual account adoption result.'],
  ['05', 'Integration and security discovery checklist', 'integration-security', 'technical',
    'Simulated design guidance, not a security certification or deployed integration. For Dynamics 365 and Microsoft Graph, establish delegated scopes, least privilege, tenant consent, retention, data residency and audit requirements before proposing implementation. The demo has no live CRM, mailbox or Teams access. Ask for the system owner and a test tenant. Do not promise specific compliance certifications, production service levels, automatic provisioning or cross-tenant access. A missing security requirement is a discovery blocker, not evidence of compliance.'],
  ['06', 'Weather-aware scheduling roadmap and limitations', 'weather-scheduling', 'roadmap',
    'SIMULATED ROADMAP ONLY; NOT AVAILABLE. Climate-risk-aware scheduling and additional jurisdiction coverage are exploratory ideas with no committed date. Weather guidance in the harness comes from separately retrieved public sources, not this document. Do not infer a current warning from historical storm records, and never send private opportunity or customer data to public web tools. If an opportunity requires automatic weather scheduling as a condition of purchase, flag a product-fit gap and do not recommend selling an unreleased feature.'],
  ['07', 'Competitive evaluation against Procore: evidence policy', 'crew-dispatch', 'sales',
    'This authored scenario is a discovery guide, not an independently verified competitor benchmark. For opportunities naming Procore, establish whether the buyer wants field dispatch and CRM handoff or a broader project-management suite. Demonstrate the specific FieldForge workflow using this pack and ask the buyer to assess it against its existing workflow. No current Procore pricing, feature gaps, performance results or contract terms are provided. Do not claim that a competitor lacks a capability without separate current evidence. Cite the dispatch, handoff and rollout guides for the proposed FieldForge evaluation.'],
  ['08', 'Pipeline prioritization and forecast definitions', 'field-to-crm', 'operations',
    'Opportunity amounts are synthetic USD potential contract values, not recognized revenue. Stage probabilities are authored planning assumptions: Qualification 10%, Discovery 25%, Proposal 50%, Negotiation 75%, Closed Won 100%, Closed Lost 0%. Weighted pipeline is amount times probability, not a committed forecast. Exclude both closed stages from open-pipeline coverage. Coverage is open pipeline divided by the positive closed-quarter quota gap, a scenario comparison across periods rather than a same-quarter forecast. Do not add pipeline amounts to booked sales. Dates and next steps are authored scenario facts, not actual customer commitments.'],
  ['09', 'Sales performance grain and fiscal-period definitions', 'multisite-rollout', 'operations',
    'Sales grain is one row per month, territory and segment, with one seller per territory/segment. SUM revenue and SUM quota across matching rows, then calculate attainment as revenue divided by quota. Do not average row attainment percentages or sum quota after joining to multiple accounts/opportunities. Fiscal years end in June: April-June 2026 is FY26/Q4; July-September 2026 is FY27/Q1. These labels belong only to synthetic-iq-sales-v1 and do not reinterpret the original five-row imported demo. Sales periods are closed months; future close dates describe pipeline, not future booked revenue.'],
  ['10', 'Buyer objections and next-step qualification', 'integration-security', 'sales',
    'Synthetic opportunity objections include unclear pilot ownership, procurement timing, duplicate CRM entries and unverified integration requirements. A buyer objection is an authored account scenario, not proof of a product defect or competitor weakness. Respond with the relevant discovery checklist, an accountable owner and a measurable proposed evaluation. Avoid generic advice: identify the opportunity ID, stage, amount, recorded need, blocker and next action, then cite the document that supports the proposed capability. Do not infer purchase readiness from a territory shortfall alone.'],
  ['11', 'Synthetic dataset provenance and account relationships', 'field-to-crm', 'governance',
    'All account names, opportunities, recorded objections, product guidance and amounts in synthetic-iq-sales-v1 are authored fictional examples. Any resemblance to real organizations is coincidental. The fixed simulated as-of date is 2026-10-30; it is not a last verified customer contact or source-freshness claim. Join opportunities to accounts using accountId. Join accounts and sales_performance to the territories dimension using territoryId, but aggregate sales before comparing to account pipeline. There is no account-level sales allocation or causal proof that closing an opportunity would repair historical quota performance. Never use these records as live CRM evidence.'],
  ['12', 'Evidence-backed territory brief template', 'multisite-rollout', 'sales',
    'For a synthetic territory brief, state the dataset/version and simulated as-of date. Present revenue, quota, positive deficit and attainment for the explicitly requested closed fiscal period. Separately show current open opportunities with IDs, values, stages, close dates and blockers. Tie recommendations to recorded buyer needs and cited capability documents, distinguish roadmap from available features, and name missing evidence. The harness can save and revise a brief only when requested. A tool failure or absent opportunity table must remain explicit rather than filled with invented account facts.'],
]

function fiscalPeriod(monthNumber) {
  return monthNumber <= 6 ? { fiscalYear: 'FY26', fiscalQuarter: 'Q4' } : { fiscalYear: 'FY27', fiscalQuarter: 'Q1' }
}

export function buildIqDemoData() {
  const provenance = { datasetId: DATASET_ID, classification: 'synthetic-demo', simulatedAsOf: SIMULATED_AS_OF, provenance: DISCLOSURE }
  const territories = REGIONS.map(([territory], index) => ({ territoryId: `SYN-TERR-${index + 1}`, territory, ...provenance }))
  const capabilities = CAPABILITIES.map(([capabilityId, capability, availability, documentNumber]) => ({
    capabilityId, capability, availability, docId: `SYN-IQ-V1-DOC-${documentNumber}`, ...provenance,
  }))
  const accounts = REGIONS.flatMap(([, midMarketSeller, enterpriseSeller, names], regionIndex) => names.map((name, accountIndex) => ({
    accountId: `SYN-ACC-${String(regionIndex * 3 + accountIndex + 1).padStart(3, '0')}`,
    name: `${name} (Synthetic)`, territoryId: territories[regionIndex].territoryId,
    segment: accountIndex === 1 ? 'Enterprise' : 'Mid-Market',
    industry: ['Commercial construction', 'Civil infrastructure', 'Specialty contracting'][accountIndex],
    owner: accountIndex === 1 ? enterpriseSeller : midMarketSeller,
    ...provenance,
  })))
  const salesPerformance = REGIONS.flatMap(([, midMarketSeller, enterpriseSeller, , previousRate, recentRate], regionIndex) =>
    [4, 5, 6, 7, 8, 9].flatMap((monthNumber) => ['Mid-Market', 'Enterprise'].map((segment, segmentIndex) => {
      const quota = (90000 + regionIndex * 10000) * (segmentIndex + 1)
      const rate = (monthNumber <= 6 ? previousRate : recentRate) + (monthNumber % 3 - 1) * 2 + segmentIndex * 3
      const revenue = quota * rate / 100
      return {
        salesRowId: `SYN-SALES-${regionIndex + 1}-${monthNumber}-${segmentIndex + 1}`,
        month: `2026-${String(monthNumber).padStart(2, '0')}`, ...fiscalPeriod(monthNumber),
        territoryId: territories[regionIndex].territoryId, segment, seller: segmentIndex ? enterpriseSeller : midMarketSeller,
        revenue, quota, currency: 'USD', periodStatus: 'simulated-closed-month', ...provenance,
      }
    })))
  const stages = [['Qualification', 0.1], ['Discovery', 0.25], ['Proposal', 0.5], ['Negotiation', 0.75], ['Closed Won', 1], ['Closed Lost', 0]]
  const opportunities = accounts.flatMap((account, accountIndex) => [0, 1].map((opportunityIndex) => {
    const position = accountIndex * 2 + opportunityIndex
    const capability = capabilities[(accountIndex + opportunityIndex) % capabilities.length]
    const [stage, probability] = stages[position % stages.length]
    const closed = stage.startsWith('Closed ')
    return {
      opportunityId: `SYN-OPP-${String(position + 1).padStart(3, '0')}`, accountId: account.accountId,
      name: `${account.name} - ${capability.capability}`, owner: account.owner,
      stage, amount: 35000 + (position % 9) * 15000, probability, currency: 'USD',
      closeDate: closed ? '2026-10-15' : `2026-${opportunityIndex ? '12' : '11'}-${String(10 + accountIndex % 15).padStart(2, '0')}`,
      fiscalYear: 'FY27', fiscalQuarter: 'Q2', lastActivityDate: `2026-10-${String(12 + accountIndex % 15).padStart(2, '0')}`,
      capabilityId: capability.capabilityId, supportingDocId: capability.docId,
      competitor: position % 3 === 0 ? 'Procore (authored buyer scenario)' : 'Not specified',
      buyerNeed: `Evaluate ${capability.capability.toLowerCase()} with an accountable site owner.`,
      blocker: capability.availability === 'simulated-roadmap-not-available' ? 'Required feature is roadmap-only; product-fit gap'
        : ['Pilot owner not confirmed', 'Procurement timeline not confirmed', 'CRM duplicate handling unresolved', 'Integration/security requirements unverified'][position % 4],
      nextAction: closed ? 'Record the authored outcome; exclude from open pipeline'
        : capability.availability === 'simulated-roadmap-not-available' ? 'Disclose unavailable feature and reassess fit; do not promise delivery'
          : `Review ${capability.docId} with the buyer and agree a scoped evaluation`,
      ...provenance,
    }
  }))
  const documents = DOCUMENTS.map(([documentNumber, title, capabilityId, type, content]) => ({
    id: `SYN-IQ-V1-DOC-${documentNumber}`, docId: `SYN-IQ-V1-DOC-${documentNumber}`,
    title: `[Synthetic demo] ${title}`, type, audience: 'Demo sellers and technical evaluators',
    lastUpdated: SIMULATED_AS_OF,
    content: `${DISCLOSURE}\nDataset: ${DATASET_ID}. Fixed simulated as-of: ${SIMULATED_AS_OF}. This document date is fixture metadata, not verified publication freshness.\nCapability: ${capabilityId}.\n\n${content}`,
  }))
  const manifest = {
    ...provenance, currency: 'USD', fiscalConvention: 'Fiscal year ends June; FY26/Q4=Apr-Jun 2026; FY27/Q1=Jul-Sep 2026; pipeline FY27/Q2=Oct-Dec 2026.',
    counts: { territories: territories.length, capabilities: capabilities.length, accounts: accounts.length, salesPerformance: salesPerformance.length, opportunities: opportunities.length, documents: documents.length },
    relationships: [
      { from: 'sales_performance.territoryId', to: 'territories.territoryId', cardinality: 'many-to-one' },
      { from: 'accounts.territoryId', to: 'territories.territoryId', cardinality: 'many-to-one' },
      { from: 'opportunities.accountId', to: 'accounts.accountId', cardinality: 'many-to-one' },
      { from: 'opportunities.capabilityId', to: 'capabilities.capabilityId', cardinality: 'many-to-one' },
    ],
    limitations: ['Synthetic, not live CRM or independently verified product claims.', 'No account-level recognized revenue allocation.', 'No live source is changed by local generation.', 'Imported semantic models need a separate explicit load/refresh and data-agent binding.', 'Original source records, dates and fiscal labels are not changed.'],
  }
  return { manifest, territories, capabilities, accounts, salesPerformance, opportunities, documents }
}

export function buildFabricModelDefinition() {
  const data = buildIqDemoData()
  const sourceTables = { territories: data.territories, capabilities: data.capabilities, accounts: data.accounts, sales_performance: data.salesPerformance, opportunities: data.opportunities }
  const descriptions = {
    territories: 'Shared territory dimension. Filter sales and accounts through this dimension; never multiply quota by joining sales rows to opportunities.',
    capabilities: 'Authored capability scenarios, availability and supporting Search docId. Roadmap-only is not an available feature.',
    accounts: '18 fictional accounts. No account-level recognized revenue exists. Opportunities link by accountId.',
    sales_performance: '72 synthetic closed-month rows, grain month/territoryId/segment. Fiscal year ends June: Apr-Jun2026 FY26/Q4, Jul-Sep2026 FY27/Q1. Use SUM revenue and SUM quota, then divide. Not the original FY26/Q1 model.',
    opportunities: '36 synthetic potential USD contracts in FY27/Q2, Oct-Dec2026. Amount is pipeline, not recognized revenue. Exclude Closed Won and Closed Lost from open pipeline. Stage probabilities are authored assumptions, not calibrated forecasts.',
  }
  const tables = Object.entries(sourceTables).map(([name, rows]) => {
    const columns = Object.keys(rows[0]).map((column) => ({
      name: column, sourceColumn: column,
      dataType: typeof rows[0][column] === 'number' ? column === 'probability' ? 'double' : 'int64' : 'string',
      summarizeBy: 'none',
      description: ['datasetId', 'classification', 'simulatedAsOf', 'provenance'].includes(column)
        ? 'Synthetic fixture provenance, not live CRM or verified source freshness.' : `${name}.${column}`,
    }))
    const encoded = Buffer.from(JSON.stringify(rows)).toString('base64')
    const types = columns.map((column) => `{${JSON.stringify(column.name)}, ${column.dataType === 'int64' ? 'Int64.Type' : column.dataType === 'double' ? 'type number' : 'type text'}}`).join(', ')
    return {
      name, description: `${DISCLOSURE} ${descriptions[name]}`, columns,
      partitions: [{ name, mode: 'import', source: { type: 'm', expression: [
        'let', `  Source = Table.FromRecords(Json.Document(Binary.FromText("${encoded}", BinaryEncoding.Base64))),`,
        `  Typed = Table.TransformColumnTypes(Source, {${types}})`, 'in', '  Typed',
      ] } }],
    }
  })
  tables.find((table) => table.name === 'sales_performance').measures = [
    { name: 'Total Revenue', expression: 'SUM(sales_performance[revenue])', formatString: '$#,##0', description: 'Recognized synthetic closed-month sales, not pipeline.' },
    { name: 'Total Quota', expression: 'SUM(sales_performance[quota])', formatString: '$#,##0' },
    { name: 'Positive Quota Deficit', expression: 'MAX(0, [Total Quota] - [Total Revenue])', formatString: '$#,##0', description: 'Positive under-quota shortfall for the selected period. Over-quota territories have zero deficit, never use ABS.' },
    { name: 'Quota Attainment', expression: 'DIVIDE([Total Revenue], [Total Quota])', formatString: '0.00%' },
  ]
  tables.find((table) => table.name === 'opportunities').measures = [
    { name: 'Open Pipeline', expression: 'CALCULATE(SUM(opportunities[amount]), FILTER(opportunities, NOT(opportunities[stage] IN {"Closed Won", "Closed Lost"})))', formatString: '$#,##0', description: 'Potential contract value excluding both closed stages; never add to historical revenue.' },
    { name: 'Weighted Open Pipeline', expression: 'SUMX(FILTER(opportunities, NOT(opportunities[stage] IN {"Closed Won", "Closed Lost"})), opportunities[amount] * opportunities[probability])', formatString: '$#,##0', description: 'Authored planning weights, not a committed or calibrated forecast.' },
    { name: 'Open Opportunities', expression: 'COUNTROWS(FILTER(opportunities, NOT(opportunities[stage] IN {"Closed Won", "Closed Lost"})))', formatString: '0' },
  ]
  const relationships = data.manifest.relationships.map((relation) => {
    const [fromTable, fromColumn] = relation.from.split('.')
    const [toTable, toColumn] = relation.to.split('.')
    return { name: `${fromTable}_${toTable}`, fromTable, fromColumn, toTable, toColumn, fromCardinality: 'many', toCardinality: 'one', crossFilteringBehavior: 'oneDirection', isActive: true }
  })
  const model = { compatibilityLevel: 1600, model: { culture: 'en-US', sourceQueryCulture: 'en-US', defaultPowerBIDataSourceVersion: 'powerBI_V3', discourageImplicitMeasures: true, tables, relationships } }
  const part = (path, value) => ({ path, payload: Buffer.from(JSON.stringify(value)).toString('base64'), payloadType: 'InlineBase64' })
  return { format: 'TMSL', parts: [
    part('model.bim', model),
    part('definition.pbism', { $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json', version: '4.0', settings: { qnaEnabled: true } }),
  ] }
}

export function toCsv(rows) {
  if (!rows.length) return ''
  const columns = Object.keys(rows[0])
  const cell = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`
  return `${[columns.map(cell).join(','), ...rows.map((row) => columns.map((column) => cell(row[column])).join(','))].join('\r\n')}\r\n`
}

export async function exportIqDemoData(outputDirectory) {
  const data = buildIqDemoData()
  const directory = resolve(outputDirectory)
  const tables = { territories: data.territories, capabilities: data.capabilities, accounts: data.accounts, sales_performance: data.salesPerformance, opportunities: data.opportunities }
  const files = { 'dataset.json': JSON.stringify(data, null, 2) + '\n', 'search-documents.json': JSON.stringify(data.documents, null, 2) + '\n' }
  for (const [name, rows] of Object.entries(tables)) files[`${name}.csv`] = toCsv(rows)
  const hashes = Object.fromEntries(Object.entries(files).map(([name, content]) => [name, createHash('sha256').update(content).digest('hex')]))
  files['manifest.json'] = JSON.stringify({ ...data.manifest, sha256: hashes }, null, 2) + '\n'
  await mkdir(directory, { recursive: true })
  for (const [name, content] of Object.entries(files)) await writeFile(resolve(directory, name), content, { flag: 'wx' })
  return { directory, counts: data.manifest.counts, sha256: hashes }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = process.argv[2] || `data/${DATASET_ID}`
  console.log(JSON.stringify(await exportIqDemoData(output), null, 2))
}