# Copilot Agent Context Hub

An isolated copy of the Microsoft Copilot harness research workbench, extended with explicitly shared, independently owned conversation forks between two signed-in users.

The user-approved fork copies exact submitted questions and completed assistant text at a fixed boundary into a new native conversation, plus a frozen package of eligible completed work. It includes returned source content, citation mappings, exposed delegation findings, Markdown readbacks and actual published Markdown bytes. The managed Microsoft Copilot harness remains the execution engine. This is application-controlled import, not a clone of hidden workspace/tool state: credentials, permissions, tool approvals, hidden reasoning and native execution history do not transfer.

## Workbench

Run npm run dev in WSL Ubuntu and open http://127.0.0.1:5184/. Dependencies and the dedicated environment/SPA are configured; no sibling environment file was copied. The new agent is deployed as version 1. A four-turn live exact-message fork proof passed on 2026-11-14; its separate allowance remains exhausted and unchanged. The user subsequently explicitly approved uncapped manual browser testing for the two approved users, with HARNESS_PROOF_ENABLED=false. This removes the app's canary turn-count gate, not authentication, sharing authorization, the per-turn timeout or Azure quotas. There is no app-enforced token or spending cap; model and source charges apply. Automatic retries and assistant-driven paid tests remain unapproved. See [PROJECT_SETUP.md](PROJECT_SETUP.md).

Earlier live gates: the original bounded canary failed because the harness rejects tool_choice; documented limits also reject max_output_tokens. Those unsupported options now fail locally. The first separately approved revised turn returned server_error after 5.8 seconds and its durable allowance stopped at one attempt, zero completions. Historical stopped allowances must not be reset or bypassed.

The completed live proof verified exact shared-message inheritance into a distinct recipient-owned native conversation, original-owner continuity and recall, and observed private-marker exclusion in both directions. It does not certify provider-level confidentiality, production readiness or live source-query routing. See [docs/runtime-validation-report.md](docs/runtime-validation-report.md) for receipts, preceding failures and the separate offline UI checks.

The sidebar lists Chats and Forked chats. New chat retains previous chats in this browser's memory; selecting a chat restores its transcript, draft, activity, evidence and registered downloads. History is not persisted across refresh/sign-out, and backend sessions still expire after 30 minutes of inactivity.

Below the latest completed reply, Share with... opens the approved recipient list and a completed-work preview with omissions. Owner consent binds the current snapshot version and selected recipient. It does not select an arbitrary earlier reply boundary. Readable user IDs come from HARNESS_USER_LABELS; all authorization and share payloads still use approved Entra object IDs. Without a configured label, the UI shows the object ID rather than inventing a user identity.

The recipient refreshes Shared with you, reviews exact messages and completed work, and explicitly accepts the package hash. Acceptance creates a separate recipient-owned chat under Forked chats without deleting the current chat. Activity, Evidence, usage counts and copied file downloads remain labeled historical. Each user continues independently. Shares can be revoked before acceptance and expire within 30 minutes. Accepted invitations disappear from the inbox.

The first recipient question submits supporting files and an index using native input_file attachments; later successful turns do not resend the package. Native staging is best effort. The UI distinguishes submission, observed successful index read and unverified use; an index read does not verify every file or establish savings. Reusing completed research may avoid repeated retrieval/analysis, but inherited input and file reads still cost tokens. No savings comparison has been run.

Completed-work export requires independently reviewed recipient entitlement through HARNESS_CONTEXT_EXPORT_OBJECT_IDS, separate from chat access. This is an application policy attestation, not an automatic source-ACL check or permission transfer. The local demo enables it only for the separately reviewed recipient; the configuration stays ignored and must be independently reviewed for other deployments. Oversized or credential-like packages block sharing without truncation or a text-only fallback; unsupported material is listed as omitted. Detection is not exhaustive DLP, so owner review remains necessary. The user-approved Context Hub-only restart activated this implementation on 2026-11-14. Enriched capture applies to new completed turns under the updated backend, not retrospectively recovered work from older sessions.

Source dates and synthetic-data disclosures remain unchanged. Native web, delegation, workspace, product knowledge and Fabric capabilities are preserved in [harness/azure.yaml](harness/azure.yaml). Tool results, not narration, establish source execution. Fabric is an explicitly approved read-only external dependency, not live CRM.

## Azure

The approved target is rg-copilot-agent-context-hub with separate Foundry account/project/model, Basic Search, Log Analytics and Application Insights. Foundry uses westus and Search uses westus2. [infra/main.bicep](infra/main.bicep) declares keyless identities, new connections and scoped access. The source Fabric agent is reused only through a new signed-in-user connection; its capacity and definition must remain unchanged.

Use direct CLI commands, not Azure Project VS Code helpers. Deployment does not authorize paid inference. Basic Search has an observed retail rate of USD 0.101/hour per unit; model/retrieval/logging charges are additional. [.env.example](.env.example) intentionally has no source project endpoint. Local credentials, receipts and deployment state are ignored.

## Checks

Run npm test, npm run lint and npm run build. Default tests are offline. [docs/runtime-validation-report.md](docs/runtime-validation-report.md) records actual local results and remaining cloud/live gates. Application session ownership is not a claim of provider-level per-conversation isolation. Session state is ephemeral and cloud erasure/retention is not certified.