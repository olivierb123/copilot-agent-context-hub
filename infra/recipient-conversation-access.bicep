targetScope = 'resourceGroup'

var recipientObjectId = '728a6776-5905-4aa9-b0d6-41af86f47f64'
var conversationWriteAction = 'Microsoft.CognitiveServices/accounts/AIServices/agents/write'

resource account 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: 'cog-context-hub-fbi23v4bydfz2'
}

resource project 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' existing = {
  parent: account
  name: 'copilot-agent-context-hub'
}

resource recipientWriterRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, 'context-hub-recipient-conversation-writer')
  properties: {
    roleName: 'Context Hub Recipient Conversation Writer'
    description: 'Approved recipient-only agent-data write permission for native message-snapshot conversation creation. Assign only at the dedicated Context Hub project.'
    type: 'CustomRole'
    permissions: [
      {
        actions: []
        notActions: []
        dataActions: [conversationWriteAction]
        notDataActions: []
      }
    ]
    assignableScopes: [resourceGroup().id]
  }
}

resource recipientWriteAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(project.id, recipientObjectId, recipientWriterRole.id)
  scope: project
  properties: {
    roleDefinitionId: recipientWriterRole.id
    principalId: recipientObjectId
    principalType: 'User'
  }
}

output projectScope string = project.id
output recipientObject string = recipientObjectId
output roleDefinitionId string = recipientWriterRole.id
output assignmentId string = recipientWriteAccess.id
output approvedDataAction string = conversationWriteAction
