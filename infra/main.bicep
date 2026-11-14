targetScope = 'resourceGroup'

param foundryLocation string = 'westus'
param searchLocation string = 'westus2'
param accountName string = 'cog-context-hub-${uniqueString(resourceGroup().id)}'
param projectName string = 'copilot-agent-context-hub'
param searchName string = 'srch-context-hub-${uniqueString(resourceGroup().id)}'
param loaderObjectId string = 'ae08b288-5970-45e1-819c-1f49ae80724d'
param allowedObjectIds array = [
  'ae08b288-5970-45e1-819c-1f49ae80724d'
  '728a6776-5905-4aa9-b0d6-41af86f47f64'
]
param grantLoaderAccess bool = false
param fabricUrl string = 'https://api.fabric.microsoft.com/v1/mcp/workspaces/559d86d4-70c6-428a-bd0b-21fef039774b/dataagents/f889fec3-fd15-4a7a-8d2e-c3795e1995b2/agent'

var tags = {
  project: 'copilot-agent-context-hub'
  purpose: 'isolated-managed-harness-message-fork-demo'
}
var foundryUserRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '53ca6127-db72-4b80-b1b0-d745d6d5456d')
var runtimeUserRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '142bfaed-a13f-4c2d-bed2-6db62c4a1009')
var openAIUserRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')
var searchReaderRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '1407120a-92aa-4202-b7e9-c0e197c71c8f')
var searchContributorRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7ca78c08-252a-4471-8644-bb5ff32d4ba0')
var searchDataContributorRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '8ebe5a00-799e-43f5-93ac-243d3dce84a7')
var searchMcpUrl = 'https://${searchName}.search.windows.net/knowledgebases/harness-product-knowledge/mcp?api-version=2026-08-01-preview'

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-copilot-agent-context-hub'
  location: foundryLocation
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    features: { enableLogAccessUsingOnlyResourcePermissions: true }
    workspaceCapping: { dailyQuotaGb: 1 }
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-copilot-agent-context-hub'
  location: foundryLocation
  kind: 'web'
  tags: tags
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
    DisableLocalAuth: true
  }
}

resource account 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: accountName
  location: foundryLocation
  kind: 'AIServices'
  sku: { name: 'S0' }
  identity: { type: 'SystemAssigned' }
  tags: tags
  properties: {
    customSubDomainName: accountName
    allowProjectManagement: true
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

resource model 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: account
  name: 'gpt-5-mini'
  sku: { name: 'GlobalStandard', capacity: 100 }
  properties: {
    model: { format: 'OpenAI', name: 'gpt-5-mini', version: '2025-08-07' }
    raiPolicyName: 'Microsoft.DefaultV2'
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

resource project 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' = {
  parent: account
  name: projectName
  location: foundryLocation
  identity: { type: 'SystemAssigned' }
  tags: tags
  properties: {
    displayName: 'Copilot Agent Context Hub'
    description: 'Isolated Microsoft Copilot harness with explicitly consented conversation-message snapshots.'
  }
  dependsOn: [model]
}

resource search 'Microsoft.Search/searchServices@2025-05-01' = {
  name: searchName
  location: searchLocation
  sku: { name: 'basic' }
  identity: { type: 'SystemAssigned' }
  tags: tags
  properties: {
    replicaCount: 1
    partitionCount: 1
    hostingMode: 'default'
    publicNetworkAccess: 'enabled'
    disableLocalAuth: true
    semanticSearch: 'standard'
  }
}

resource knowledgeConnection 'Microsoft.CognitiveServices/accounts/projects/connections@2025-06-01' = {
  parent: project
  name: 'product-knowledge-base'
  properties: {
    category: 'RemoteTool'
    authType: 'ProjectManagedIdentity'
    audience: 'https://search.azure.com/'
    target: searchMcpUrl
    isSharedToAll: false
    metadata: {}
  }
}

resource fabricConnection 'Microsoft.CognitiveServices/accounts/projects/connections@2025-06-01' = {
  parent: project
  name: 'fabric-sales-user'
  properties: {
    category: 'RemoteTool'
    authType: 'UserEntraToken'
    audience: 'https://analysis.windows.net/powerbi/api'
    target: fabricUrl
    isSharedToAll: false
    metadata: {}
  }
}

resource userAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for objectId in allowedObjectIds: {
  name: guid(project.id, objectId, runtimeUserRole)
  scope: project
  properties: { roleDefinitionId: runtimeUserRole, principalId: objectId, principalType: 'User' }
}]

resource projectSearchAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(search.id, project.id, searchReaderRole)
  scope: search
  properties: { roleDefinitionId: searchReaderRole, principalId: project.identity.principalId, principalType: 'ServicePrincipal' }
}

resource searchModelAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(model.id, search.id, openAIUserRole)
  scope: model
  properties: { roleDefinitionId: openAIUserRole, principalId: search.identity.principalId, principalType: 'ServicePrincipal' }
}

resource projectFileAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(project.id, project.id, foundryUserRole)
  scope: project
  properties: { roleDefinitionId: foundryUserRole, principalId: project.identity.principalId, principalType: 'ServicePrincipal' }
}

resource loaderSchemaAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (grantLoaderAccess) {
  name: guid(search.id, loaderObjectId, searchContributorRole)
  scope: search
  properties: { roleDefinitionId: searchContributorRole, principalId: loaderObjectId, principalType: 'User' }
}

resource loaderDataAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (grantLoaderAccess) {
  name: guid(search.id, loaderObjectId, searchDataContributorRole)
  scope: search
  properties: { roleDefinitionId: searchDataContributorRole, principalId: loaderObjectId, principalType: 'User' }
}

output projectId string = project.id
output projectEndpoint string = 'https://${accountName}.services.ai.azure.com/api/projects/${projectName}'
output accountResourceId string = account.id
output searchResourceId string = search.id
output searchEndpoint string = 'https://${searchName}.search.windows.net'
output modelResourceUri string = 'https://${accountName}.openai.azure.com'
output knowledgeConnectionId string = knowledgeConnection.id
output knowledgeMcpUrl string = searchMcpUrl
output fabricConnectionId string = fabricConnection.id
output fabricMcpUrl string = fabricUrl
output applicationInsightsId string = insights.id
output loaderAssignmentIds array = grantLoaderAccess ? [loaderSchemaAccess!.id, loaderDataAccess!.id] : []
