# Project Instructions

This is Copilot Agent Context Hub, a new isolated copy of the Microsoft Copilot harness research workbench. Its goal is explicit sharing and independent session forks between two genuinely authenticated users while preserving the original workbench experience.

Keep all changes here. The source microsoftiq-copilot-harness-demo and all other sibling demos are read-only references. Never copy their credentials, private documents, local sessions, environment files or cloud deployment state. Never restart, reload or redeploy a sibling demo or its agents.

Read the vscode-microsoft-foundry skill first in VS Code, then microsoft-foundry. Preserve the source's Microsoft Copilot managed harness; do not silently substitute a standard model-only Responses implementation or a different harness type. The user explicitly approved an exact-message snapshot into a new managed conversation. Copy submitted questions and displayed completed assistant text without summary or truncation. This is application-controlled message import, not a native full-harness clone. Do not copy workspace files, tool history, credentials, permissions or tool approvals, or claim they were cloned. Other fallback mechanisms require separate agreement.

Use Node.js ESM, React and the existing workbench conventions. No Python application runtime. Preserve source dates, synthetic-data disclosures and unknown dates. Actual provider/tool results establish evidence, not narration.

The source-copy and local implementation are requested. Exact cloud resource names, regions, model allocations, Search/Fabric dependencies, Entra registration, permission changes and costs must be reviewed before provisioning. Use direct CLI commands, not Azure Project VS Code helpers. New resources belong to a separate resource group and Foundry account/project; do not reuse existing connections, Fabric capacity or Search services implicitly. Paid inference requires a finite approval separate from deployment.

Require verified identities for the two-user workflow. Sharing must name the recipient and require explicit consent; tokens, permissions and tool approvals are never transferred. Keep branch heads and later private turns independent. Provider IDs alone are not authorization. Never weaken policy or authentication to make a demonstration pass.

Run npm test, npm run lint and npm run build for relevant code changes. Keep live tests opt-in. Record current outcomes and remaining limitations in docs/runtime-validation-report.md. Historical source-demo results are not validation of this copy. Do not commit or push.