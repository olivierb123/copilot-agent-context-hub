# Project Setup

This is a Node.js ESM / React workbench backed by a separately deployed Microsoft Copilot managed harness. It has no Python application or hosted agent server.

## Dedicated Environment

- Resource group: rg-copilot-agent-context-hub.
- Subscription: b7fdcea6-b30a-43fc-b3a1-7f2e30b31e7e.
- Tenant: f81ccca0-e708-41b0-9ad9-577672515a1a.
- Foundry: cog-context-hub-fbi23v4bydfz2 / copilot-agent-context-hub, westus.
- Model: gpt-5-mini, 2025-08-07, GlobalStandard capacity 100.
- Search: srch-context-hub-fbi23v4bydfz2, Basic, westus2.
- Agent: copilot-agent-context-hub, version 1, microsoft_copilot_preview.
- SPA client: 4fa78b26-9b73-4e8f-bf0f-2252097f3747, single tenant, no client secret.

The separate Search index contains four clearly labeled original fixture summaries and twelve unchanged synthetic documents. It is not a full copy of private cloud documents. Product knowledge uses the new project's managed identity. Fabric uses the approved existing agent through a new UserEntraToken connection, without source writes or capacity resume.

## Local Workbench

From /home/olivi/copilot-agent-context-hub in WSL Ubuntu:

```bash
npm ci
npm run dev
```

Open http://127.0.0.1:5184/ or http://localhost:5184/. Both are registered SPA redirects. The ignored local environment is configured for the new project and exactly the two approved object IDs. Do not replace it with a sibling environment, use a local-persona bypass, or transfer tokens between users. Sign-in and user consent are interactive; no tenant-wide admin consent has been granted.

Use separate browser profiles for the two users. Refresh/restart loses the local session mappings; coordinate before restarting an active conversation. New chat and the Chats/Forked chats lists retain conversations only in the current browser's memory. Each conversation keeps its own Activity and Evidence views. On mobile, Chats opens the sidebar drawer.

Share a completed conversation using Share with... beneath its latest completed response. The recipient refreshes Shared with you in the sidebar, then explicitly accepts the message snapshot into a separate forked chat. An existing chat is retained, not overwritten. Files, tool outputs, credentials, permissions and approvals do not transfer. Later turns remain independent at the application level; provider-level per-conversation confidentiality is not certified.

HARNESS_USER_LABELS is an optional server-side JSON object mapping already-approved Entra object IDs to readable user IDs, such as {"recipient-object-id":"recipient@example.com"}. It changes only display labels, not HARNESS_ALLOWED_OBJECT_IDS, token validation or share authorization. Unmapped identities display their object ID. No directory lookup or additional permission is required.

## Current Live Gate

Current manual-testing configuration: the user explicitly selected Approve uncapped manual testing and restart on 2026-11-14, replacing the finite-only approval requirement for their manual browser tests. HARNESS_PROOF_ENABLED=false disables the canary gate only. Normal configured tools remain available to the two already-approved authenticated users. There is no app-enforced turn-count, output-token or dollar cap; usage incurs model/source charges. Existing request deadlines, Azure limits, token validation, recipient consent and session/download ownership checks still apply. No automatic retries, assistant-driven paid inference, permission changes or deployment were authorized. The private approval is .state/manual-testing-unlimited-2026-11-14/approval.json. Historical proof ledgers below must not be reset or reused. The Context Hub-only restart and loss of local session mappings were explicitly approved.

The following paragraphs retain the earlier bounded-proof history, not the current manual-testing restriction.

Owner sign-in, delegated application authorization and native conversation creation passed. The first inference request failed with HTTP 400 because tool_choice is unsupported. The [Microsoft Copilot harness limits](https://learn.microsoft.com/azure/foundry/agents/concepts/limits-quotas-regions#microsoft-copilot-harness-preview) also explicitly disallow max_output_tokens. Neither removing the first field nor requesting a short answer establishes the approved hard token cap.

Unsupported bounded-proof options are rejected before any Responses call. The user subsequently approved a separate four-turn run without a hard token/cost cap, with existing tools available, no research requested and a stop on failure or unexpected tool activity. The ignored environment now selects HARNESS_PROOF_MODE=observed_canary with HARNESS_PROOF_ENABLED=true. Its private revised approval ledger reserves attempts before native creation, records conversation IDs before Responses submission, and prevents overlap, retries and allowance reset across process reloads. A client timeout is not a token/cost cap; tool observation is detection, not prevention.

That revised run stopped on its first turn with server_error after 5.8 seconds, with no completed response or usage returned. Both the original and revised allowances remain stopped at one attempt each. No retry was made under either allowance.

On 2026-11-14 a read-only comparison confirmed that original version 11 and copy version 1 have identical deployed instructions and equivalent model, harness, tools and request body. The original instance identity has project-scoped Foundry User; the copy's instance did not. The owner already inherits Foundry User in both projects. The user explicitly approved the missing role for the copy's agent instance only, and a separate two-turn owner baseline check. The single instance assignment was created and read-back verified; caller roles and agent versions were not changed. This post-agent-creation assignment is not declared in infra/main.bicep. It does not authorize broader grants or access to sibling projects.

The historical two-turn baseline selected .state/baseline-owner-2026-11-14/approval.json. Its first turn failed with server_error after 4,256 ms, zero completions and no returned usage; the second turn was not sent. That allowance remains stopped. The documented instance role gap was not a sufficient fix for the ordinary-turn failure.

Stored-response diagnosis then identified missing connection audiences. The copied product-knowledge-base now has audience https://search.azure.com/ and fabric-sales-user has https://analysis.windows.net/powerbi/api, preserving ProjectManagedIdentity and UserEntraToken. Both cloud readbacks and infra/main.bicep include those values. The audience-repair allowance stopped after one failed turn whose remaining initialization error was Fabric MCP transport. The user restarted the shared Fabric capacity; this assistant made no capacity changes.

The historical one-turn baseline selected HARNESS_PROOF_MAX_TURNS=1, observed_canary mode and HARNESS_PROOF_APPROVAL_PATH=.state/post-fabric-restart-owner-2026-11-14/approval.json. Under fresh explicit approval, one owner-only first turn completed with the expected acknowledgement and a durable completed provider receipt. This one-response allowance is consumed. No source query, cross-user fork or production-readiness claim follows from that baseline pass. No linked telemetry was added and no agent was redeployed for the audience repair.

The latest approved automated completion proof used HARNESS_PROOF_MAX_TURNS=4 and HARNESS_PROOF_APPROVAL_PATH=.state/automated-fork-completion-2026-11-14/approval.json, still in observed_canary mode. All four responses completed. It verified a fixed exact-message snapshot, a distinct recipient-owned native conversation, shared-marker recall, owner-private recall and observed later-private-marker exclusion in both directions. The original owner conversation remained available after the fork. This allowance is exhausted. At that point further prompts required separate approval, and the later UI refresh added no inference authorization. The subsequent uncapped manual-testing approval above is distinct; it does not reset or reopen this proof allowance. See [docs/runtime-validation-report.md](docs/runtime-validation-report.md).

## Direct Deployment

The five services were provisioned using [infra/main.bicep](infra/main.bicep) with direct az deployment group commands. A provider rejection of conflicting Search authOptions was repaired without enabling local keys. Two broad caller assignments initially created by the template were removed and replaced with Project Runtime User assignments; inherited and shared roles were unchanged. Recipient creation/import initially failed, then passed after the separately approved project-scoped agents/write custom role in [infra/recipient-conversation-access.bicep](infra/recipient-conversation-access.bicep). No broad recipient Foundry User grant was added. The four-turn completion proof above verifies the observed message-import workflow, not every provider item capability.

The target-only bootstrap is [scripts/bootstrap_context_hub.mjs](scripts/bootstrap_context_hub.mjs). It requires the private successful deployment receipt and --apply, writes only the new Search service, verifies every fixture field and removes its temporary loader grants. Both grants were removed after successful load. Do not rerun provisioning with loader access enabled or regrant writes implicitly. The copied legacy loader refuses --apply and must not be used to modify shared sources.

The ignored harness/.azure/context-hub environment has the exact project ID, endpoint, model and new connection IDs. The installed extension resolves FOUNDRY_PROJECT_ENDPOINT. From the harness directory, use the existing WSL azd binary:

```bash
AZURE_DEV_USER_AGENT=microsoft_foundry_skill \
AZD_ALPHA_ENABLE_AGENTS_MANAGED_HARNESS=true \
/home/olivi/.local/bin/azd-linux-amd64 deploy copilot-agent-context-hub --no-prompt
```

Deployment creates another immutable version. Do not run azd up/provision, Azure Project VS Code helpers, or deploy a sibling agent. Deployment does not authorize inference or evaluation generation. Review actual results in [docs/runtime-validation-report.md](docs/runtime-validation-report.md).