import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, ArrowDownLeft, Database, Download, FileText, GitFork, Globe, Menu, MessageSquare, Plus, Search, Send, Share2, Square, X } from 'lucide-react'
import { runHarnessQuery } from './agentClient.js'
import { getAccessToken, isSignInConfigured } from './auth.js'
import SessionSharing, { SharingDialog } from './SessionSharing.jsx'

const TOOL_LABELS = { task: 'Delegate research', create: 'Write workspace file', view: 'Read workspace file',
  str_replace: 'Revise workspace file', web_fetch: 'Fetch web page', web_search_call: 'Web search',
  azure_ai_search_call: 'Product documents (native)',
  'product-knowledge': 'Knowledge base (native)',
  'fabric-sales': 'Fabric sales (native)', upload_file_from_workspace_to_foundry_project: 'Publish file to Foundry' }
const CONNECTOR_LABELS = { 'Foundry IQ': 'Product documents', 'Fabric IQ': 'Sales data', 'Web IQ': 'Legacy web connector' }
const LOCAL_MODE = import.meta.env.VITE_HARNESS_LOCAL_MODE === 'true'

const PROMPT_CAPABILITIES = {
  sales: { label: 'Fabric', Icon: Database },
  knowledge: { label: 'Knowledge base', Icon: FileText },
  webSearch: { label: 'Web search', Icon: Search },
  webFetch: { label: 'Web fetch', Icon: Globe },
  workspace: { label: 'Workspace files', Icon: FileText },
  publish: { label: 'Publish if supported', Icon: Download },
}

const SUGGESTED_PROMPTS = [
  { title: 'Quota performance', level: 'Simple', capabilities: ['sales'], subagents: 0, question: 'In original FieldForge FY26/Q1, which territory is furthest below quota in dollars, and which has the lowest attainment?' },
  { title: 'Roadmap evidence', level: 'Simple', capabilities: ['knowledge'], subagents: 0, question: 'According to our product documentation, does FieldForge support weather-risk planning today, or is it still on the roadmap? Include the returned source passages, citations and original source dates; flag unknown dates.' },
  { title: 'External research', level: 'Intermediate', capabilities: ['webSearch', 'webFetch'], subagents: 0, question: 'What does OSHA say about preventing heat illness on construction sites, and what are employers required to do?' },
  { title: 'Pipeline and definitions', level: 'Intermediate', capabilities: ['sales', 'knowledge'], subagents: 0, question: 'How many opportunities are open in the expanded synthetic demo, what is their total and probability-weighted value, and how do our internal forecasting definitions explain those numbers? Preserve returned evidence, citations, source dates and the synthetic-data disclosure; distinguish missing evidence from conclusions.' },
  { title: 'Web-informed opportunities', level: 'Advanced', capabilities: ['sales', 'webSearch', 'webFetch'], subagents: 1, question: 'Which South opportunities in the expanded synthetic demo should we prioritize? Delegate official OSHA heat-exposure research to one subagent if supported, and combine its completed findings with the returned sales evidence to recommend discovery questions. Include citations, original source dates and missing evidence. Do not treat synthetic data as live CRM.' },
  { title: 'Reusable territory brief', level: 'Advanced', capabilities: ['sales', 'knowledge', 'webSearch', 'webFetch', 'workspace', 'publish'], subagents: 2, question: 'Prepare a reusable Markdown brief for South using the expanded synthetic sales data, FieldForge product documentation and official OSHA heat-exposure guidance. If supported, delegate product-document and OSHA research to separate subagents, then retain their completed findings. Cover performance, priority opportunities, capabilities, limitations and next actions. Include returned source passages, citations, original source dates and synthetic-data disclosures; flag unknown dates and missing evidence. Read back the completed Markdown and publish a downloadable file if supported. Do not claim publication without a successful tool result.' },
]

const INHERITED_PROMPTS = [
  { title: 'Recall inherited evidence', level: 'Simple', capabilities: ['workspace'], subagents: 0, question: 'Read inherited-work-index.txt and the relevant inherited supporting files if available. Using only inherited completed work, list three established facts and their sources. Preserve original source dates and synthetic-data disclosures. Do not repeat source retrieval or research. If attachments or evidence are missing, say so rather than reconstructing them.' },
  { title: 'Prioritize inherited findings', level: 'Intermediate', capabilities: ['workspace'], subagents: 0, question: 'Read inherited-work-index.txt and relevant supporting files if available. Turn the inherited South territory findings into a prioritized action list, with the inherited evidence and uncertainty behind each action. Do not repeat retrieval, delegation or research for evidence already included. Identify missing inherited material before proposing any new research; do not execute new research.' },
  { title: 'Adapt the inherited brief', level: 'Advanced', capabilities: ['workspace', 'publish'], subagents: 0, question: 'Read inherited-work-index.txt and the relevant inherited brief, source results and completed findings if available. Adapt that completed work into a downloadable Markdown account-planning brief for South, including priorities, discovery questions, evidence and limitations. Preserve citations, original dates and synthetic-data disclosures. Do not repeat retrieval, delegation or analysis already completed. If essential inherited material is missing, report the gap before proceeding instead of running new research. Read back the revised Markdown and publish it if supported; distinguish an actual published file from a readback. Do not claim token savings.' },
]

function safeUrl(value) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol) ? value : null }
  catch { return null }
}

function SourceResult({ result }) {
  return (
    <div className="space-y-3 break-words text-xs leading-relaxed text-slate-400">
      {result.error && <p className="text-red-300">{result.error}</p>}
      {result.execution && <p>{result.execution}</p>}
      {result.provenance && <p>{result.provenance}</p>}
      {result.identity && <p>{result.identity}</p>}
      {(result.retrievedAt || result.queriedAt) && (
        <p className="text-slate-500">{result.queriedAt ? 'Queried' : 'Retrieved'}: {result.queriedAt || result.retrievedAt}</p>
      )}
      {result.text && <p className="whitespace-pre-wrap text-slate-300">{result.text}</p>}
      {result.documents?.map((document, index) => {
        const url = safeUrl(document.url)
        return (
          <div key={`${document.docId || url || index}`} className="space-y-1 border-t border-slate-800 pt-3">
            <p className="font-medium text-slate-200">
              {url ? <a href={url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{document.title || url}</a>
                : document.title || document.docId || 'Source document'}
            </p>
            {document.docId && <p className="font-mono">{document.docId}</p>}
            {document.content && <details>
              <summary className="cursor-pointer text-slate-400">Source text</summary>
              <p className="mt-2 whitespace-pre-wrap">{document.content}</p>
            </details>}
            <p>Source updated: {document.lastUpdatedAt || document.lastUpdated || 'Unknown'}</p>
            {document.crawledAt && <p>Crawled: {document.crawledAt}</p>}
            {document.sourceQuality && <p>Source quality: {String(document.sourceQuality)}</p>}
          </div>
        )
      })}
      {result.documents?.length === 0 && !result.text && !result.error && <p>No evidence returned.</p>}
    </div>
  )
}

function RunningProgress({ activity, lastActivity, hasText }) {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setFrame(previous => (previous + 1) % 60), 180)
    return () => window.clearInterval(timer)
  }, [])
  const active = activity.filter(item => ['in_progress', 'running', 'searching', 'queued'].includes(item.status))
  const latest = active.find(item => item.id === lastActivity?.id) || active.at(-1) || lastActivity
  const tool = latest && (TOOL_LABELS[latest.tool] || latest.tool.replaceAll('_', ' '))
  const label = active.length ? `${tool} · ${active.length > 1 ? `${active.length} tools active` : latest.status === 'queued' ? 'queued' : 'running'}`
    : hasText ? 'Receiving agent response'
      : latest ? `${tool} · ${['failed', 'interrupted'].includes(latest.status) ? latest.status : latest.status === 'completed' ? 'finished' : 'observed'}; waiting for agent`
        : 'Waiting for agent activity'
  const filled = Math.floor(frame / 3) % 10 + 1
  const spinner = ['/', '-', '|', '\\'][frame % 4]
  return <div className="harness-progress flex h-5 min-w-0 items-center gap-3 text-xs text-emerald-300">
    <span aria-hidden="true" className="w-[14ch] shrink-0 whitespace-pre font-mono text-white">{`[${'■'.repeat(filled)}${' '.repeat(10 - filled)}] ${spinner}`}</span>
    <span role="status" aria-live="polite" aria-atomic="true" title={label} className="min-w-0 truncate">{label}</span>
  </div>
}

function ConversationTurn({ turn, number, onInspect, onExport, onDownload, downloading, downloadDisabled }) {
  return (
    <article aria-label={`Turn ${number}`} className="space-y-5 border-b border-slate-800 pb-6 last:border-0">
      <div className="space-y-2 border-l-2 border-slate-600 pl-4">
        <h3 className="text-xs font-semibold text-slate-400">{turn.inherited ? 'Shared user message' : 'You'}</h3>
        <p className="break-words whitespace-pre-wrap text-sm leading-7 text-slate-100">{turn.question}</p>
      </div>
      <div className="space-y-3 pl-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-semibold text-emerald-300">Copilot</h3>
          <button type="button" title={`Inspect turn ${number}`} aria-label={`Inspect turn ${number}`} onClick={onInspect}
            className="grid h-8 w-8 shrink-0 place-items-center rounded border border-slate-700 text-slate-400 hover:text-emerald-200"><Activity size={14} /></button>
        </div>
        <div className="break-words whitespace-pre-wrap text-sm leading-7 text-slate-200">{turn.answer || (turn.status === 'running' ? 'Researching…' : 'No response returned.')}</div>
        {turn.error && <p className="text-sm text-red-300">{turn.error}</p>}
        {turn.artifacts?.length > 0 && <section aria-label={`Files for turn ${number}`} className="response-files">
          {turn.artifacts.map((artifact) => <div key={artifact.file_id} className="response-file">
            <FileText size={18} className="shrink-0 text-emerald-200" />
            <div className="min-w-0 flex-1"><p className="break-all text-sm text-slate-200">{artifact.filename}</p>
              <p className="text-xs text-slate-500">{artifact.inherited ? 'Inherited snapshot' : 'Published artifact'} · {artifact.bytes} bytes</p></div>
            <button type="button" title={`Download ${artifact.filename}`} aria-label={`Download ${artifact.filename}`}
              disabled={downloadDisabled || Boolean(downloading)} onClick={() => onDownload(artifact)}
              className="grid h-10 w-10 shrink-0 place-items-center rounded border border-slate-700 text-emerald-200"><Download size={17} /></button>
          </div>)}
        </section>}
        {turn.brief && <details className="border-t border-slate-800 pt-3 text-sm text-slate-400">
          <summary className="cursor-pointer">Workspace read-back</summary>
          <div className="mt-3 flex min-w-0 items-center justify-between gap-3">
            <p className="min-w-0 break-all font-mono text-xs text-slate-500">{turn.brief.path}</p>
            <button type="button" title="Export Markdown copy" aria-label={`Export Markdown copy for turn ${number}`} onClick={() => onExport(turn.brief)}
              className="grid h-9 w-9 shrink-0 place-items-center rounded border border-slate-700 text-slate-200"><Download size={15} /></button>
          </div>
          <p className="mt-3 break-words whitespace-pre-wrap leading-7">{turn.brief.text}</p>
        </details>}
      </div>
    </article>
  )
}

export default function HarnessConsole(props) {
  return <ChatWorkspace key={props.account?.homeAccountId || 'signed-out'} {...props} />
}

function ChatWorkspace({ account, onSignIn }) {
  const [chats, setChats] = useState([{ id: crypto.randomUUID(), title: 'New chat', fork: null }])
  const [activeId, setActiveId] = useState(chats[0].id)
  const [metadata, setMetadata] = useState({})
  const [pending, setPending] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const updateMetadata = useCallback((id, value) => setMetadata(previous => ({ ...previous, [id]: value })), [])
  const busy = pending || Object.values(metadata).some(value => value.busy)
  function addChat(fork = null) {
    const chat = { id: crypto.randomUUID(), title: fork ? 'Forked chat' : 'New chat', fork }
    setChats(previous => [...previous, chat])
    setActiveId(chat.id)
    setSidebarOpen(false)
  }
  return <div className={`chat-workspace${sidebarOpen ? ' sidebar-open' : ''}`} onKeyDown={event => {
    if (event.key === 'Escape') setSidebarOpen(false)
  }}>
    {sidebarOpen && <button className="sidebar-backdrop" aria-label="Dismiss chat navigation" onClick={() => setSidebarOpen(false)} />}
    <aside id="chat-navigation" className="chat-sidebar" aria-label="Chat navigation">
      <div className="sidebar-brand"><MessageSquare size={20} /><span>Context Hub</span>
        <button className="sidebar-close" title="Close chat navigation" aria-label="Close chat navigation" onClick={() => setSidebarOpen(false)}><X size={18} /></button>
      </div>
      <button className="new-chat" disabled={busy} onClick={() => addChat()}><Plus size={18} />New chat</button>
      {[{ label: 'Chats', forked: false }, { label: 'Forked chats', forked: true }].map(group => <section key={group.label} className="chat-list" aria-label={group.label}>
        <h2>{group.label}</h2>
        {chats.filter(chat => Boolean(chat.fork) === group.forked).map(chat => <button key={chat.id} disabled={busy}
          aria-current={activeId === chat.id ? 'page' : undefined} onClick={() => { setActiveId(chat.id); setSidebarOpen(false) }}
          title={metadata[chat.id]?.title || chat.title}>
          {chat.fork ? <GitFork size={15} /> : <MessageSquare size={15} />}<span>{metadata[chat.id]?.title || chat.title}</span>
        </button>)}
      </section>)}
      <SessionSharing account={account} sessionId={null} busy={busy} mode="inbox" onPendingChange={setPending} onFork={addChat} />
    </aside>
    <div className="chat-main">
      <div className="mobile-chat-nav">
        <button title="Show chats" aria-label="Show chats" aria-expanded={sidebarOpen} aria-controls="chat-navigation" onClick={() => setSidebarOpen(value => !value)}><Menu size={18} /><span>Chats</span></button>
      </div>
      {chats.map(chat => <div key={chat.id} hidden={activeId !== chat.id} className="chat-pane">
        <ConversationPane account={account} onSignIn={onSignIn} chatId={chat.id} initialFork={chat.fork} onMetadata={updateMetadata} />
      </div>)}
    </div>
  </div>
}

function ConversationPane({ account, onSignIn, chatId, initialFork, onMetadata }) {
  const [question, setQuestion] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [sessionId, setSessionId] = useState(null)
  const [answer, setAnswer] = useState('')
  const [status, setStatus] = useState('idle')
  const [calls, setCalls] = useState([])
  const [activity, setActivity] = useState([])
  const [lastActivity, setLastActivity] = useState(null)
  const [evidence, setEvidence] = useState([])
  const [brief, setBrief] = useState(null)
  const [artifacts, setArtifacts] = useState([])
  const [downloading, setDownloading] = useState(null)
  const [view, setView] = useState('Conversation')
  const [turns, setTurns] = useState([])
  const [inspectedTurn, setInspectedTurn] = useState(null)
  const [error, setError] = useState('')
  const [inherited, setInherited] = useState(false)
  const [sharingPending, setSharingPending] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [usage, setUsage] = useState(null)
  const [contextStatus, setContextStatus] = useState(null)
  const controller = useRef(null)
  const generation = useRef(0)
  const transcript = useRef(null)
  const composer = useRef(null)
  const promptCatalogue = useRef(null)
  const followLatest = useRef(true)
  const authenticated = Boolean(account) || LOCAL_MODE
  const busy = status === 'running' || status === 'resetting' || sharingPending
  const conversationEnded = Boolean(submitted) && status === 'error' && !sessionId
  const inspected = inspectedTurn === null ? { activity, evidence, calls, usage } : turns[inspectedTurn]

  useEffect(() => {
    const viewport = window.matchMedia('(min-width: 1101px)')
    const update = () => { if (promptCatalogue.current) promptCatalogue.current.open = viewport.matches }
    update()
    viewport.addEventListener('change', update)
    return () => viewport.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    onMetadata(chatId, { title: (turns[0]?.question || submitted || (initialFork ? 'Forked chat' : 'New chat')).split('\n')[0].slice(0, 72), busy })
  }, [chatId, onMetadata, submitted, turns, initialFork, busy])

  useEffect(() => {
    if (view === 'Conversation' && followLatest.current && transcript.current) {
      transcript.current.scrollTop = submitted ? transcript.current.scrollHeight : 0
    }
  }, [answer, submitted, status, view])

  useEffect(() => {
    setSessionId(initialFork?.session_id || null)
    const imported = []
    for (let index = 0; index < (initialFork?.messages.length || 0); index += 2) {
      const work = initialFork.context?.work?.find((turn) => turn.turn === index / 2 + 1)
      const records = work?.records || []
      imported.push({ question: initialFork.messages[index].content, answer: initialFork.messages[index + 1].content,
        inherited: true, status: 'done', capturedAt: work?.captured_at,
        artifacts: (initialFork.artifacts || []).filter((artifact) => {
          const capturedTurn = initialFork.context?.work?.find((entry) => entry.records.some((record) => record.kind === 'file' && record.filename === artifact.filename))?.turn
          return (capturedTurn || initialFork.messages.length / 2) === index / 2 + 1
        }),
        usage: work ? { ...work.usage, tool_calls: work.tool_calls } : null,
        activity: records.filter((record) => record.kind !== 'citation').map((record, position) => ({
          id: `inherited-${index}-${position}`, tool: record.tool || record.filename || record.kind,
          status: record.status || 'returned', inherited: true, detail: record.query,
          output: record.text || record.error || JSON.stringify(record.documents),
        })),
        evidence: records.filter((record) => record.kind === 'citation' && safeUrl(record.url))
          .filter((record, position, all) => all.findIndex((entry) => entry.url === record.url) === position),
        calls: records.filter((record) => record.kind === 'source').map((record, position) => ({
          call_id: `inherited-source-${index}-${position}`, source: record.tool === 'product-knowledge' ? 'Foundry IQ' : 'Fabric IQ',
          status: record.status === 'failed' ? 'error' : 'done', result: record,
        })),
      })
    }
    setTurns(imported)
    setInspectedTurn(imported.length ? imported.length - 1 : null)
    setSubmitted('')
    setQuestion('')
    setError('')
    setView('Conversation')
    setAnswer('')
    setCalls([])
    setActivity([])
    setLastActivity(null)
    setEvidence([])
    setBrief(null)
    setArtifacts([])
    setUsage(null)
    setContextStatus(initialFork?.context?.work?.some((turn) => turn.records.length) ? 'pending' : null)
    setStatus('idle')
    setInherited(false)
    setSharingPending(false)
    return () => {
      generation.current += 1
      controller.current?.abort()
    }
  }, [account?.homeAccountId, initialFork])

  async function submit(event) {
    event.preventDefault()
    if (busy || conversationEnded || !authenticated || !question.trim()) return
    const request = new AbortController()
    controller.current = request
    const current = ++generation.current
    const input = question.trim()
    const active = () => current === generation.current
    if (submitted) setTurns((previous) => [...previous, { question: submitted, answer, brief, artifacts, status, error, activity, evidence, calls, inherited, usage }])
    setInherited(false)
    setQuestion('')
    setInspectedTurn(null)
    setView('Conversation')
    followLatest.current = true
    setSubmitted(input)
    setAnswer('')
    setBrief(null)
    setArtifacts([])
    setCalls([])
    setActivity([])
    setLastActivity(null)
    setEvidence([])
    setUsage(null)
    setError('')
    setStatus('running')
    try {
      const token = LOCAL_MODE ? null : await getAccessToken()
      if (!LOCAL_MODE && !token) throw new Error('Sign-in is required')
      await runHarnessQuery(input, {
        onEvent: (entry) => {
          if (!active()) return
          if (entry.type === 'harness.session') setSessionId(entry.session_id)
          if (entry.type === 'harness.usage') setUsage({ ...entry.usage, tool_calls: entry.tool_calls })
          if (entry.type === 'harness.context') setContextStatus(entry.status)
          if (entry.type === 'harness.source') {
            setCalls((previous) => [...previous.filter((call) => call.call_id !== entry.call_id), entry])
          }
          if (entry.type === 'harness.activity') {
            setLastActivity(entry)
            setActivity((previous) => {
              const existing = previous.find((item) => item.id === entry.id)
              return existing ? previous.map((item) => item.id === entry.id ? { ...item, ...entry } : item)
                : [...previous, entry]
            })
          }
          if (entry.type === 'harness.evidence' && safeUrl(entry.url)) {
            setEvidence((previous) => previous.some((item) => item.url === entry.url) ? previous : [...previous, entry])
          }
          if (entry.type === 'harness.brief') setBrief(entry)
          if (entry.type === 'harness.artifact') {
            setArtifacts((previous) => previous.some((item) => item.file_id === entry.file_id) ? previous : [...previous, entry])
          }
        },
        onText: (text) => { if (active()) setAnswer(text) },
        onDone: () => {
          if (!active()) return
          setStatus('done')
        },
        onError: (message) => {
          if (!active()) return
          setError(request.signal.aborted ? 'Request cancelled' : message)
          setStatus('error')
          setSessionId(null)
          setArtifacts([])
          setActivity((previous) => previous.map((item) => item.status === 'in_progress'
            ? { ...item, status: 'interrupted' } : item))
          setCalls((previous) => previous.map((call) => call.status === 'running'
            ? { ...call, status: 'error', result: { error: 'Request ended before this source returned verified evidence.' } }
            : call))
        },
      }, token, { signal: request.signal, body: sessionId ? { session_id: sessionId } : {} })
    } catch (failure) {
      if (active()) { setError(failure.message); setStatus('error') }
    } finally {
      if (active()) controller.current = null
    }
  }

  function exportBrief(savedBrief) {
    if (!savedBrief) return
    const url = URL.createObjectURL(new Blob([savedBrief.text], { type: 'text/markdown;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = savedBrief.path.split('/').pop() || 'research-brief.md'
    link.click()
    URL.revokeObjectURL(url)
  }

  async function downloadArtifact(artifact) {
    if (!sessionId || busy || downloading) return
    setDownloading(artifact.file_id)
    setError('')
    try {
      const token = LOCAL_MODE ? null : await getAccessToken()
      const response = await fetch(`/api/harness/sessions/${sessionId}/files/${artifact.file_id}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!response.ok) throw new Error(`File download failed: ${response.status}`)
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = artifact.filename
      link.click()
      URL.revokeObjectURL(url)
    } catch (failure) { setError(failure.message) }
    finally { setDownloading(null) }
  }

  return (
    <div className="conversation-layout">
    <section aria-label="Copilot Harness" className="conversation-surface flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-100">{initialFork ? 'Forked conversation' : 'Conversation'}</h2>
        <div className="flex min-w-0 items-center gap-3">
          <span className="min-w-0 break-all text-xs text-slate-500">{LOCAL_MODE ? 'Local developer identity' : account?.username || 'Signed out'} · Preview</span>
        </div>
      </div>
      {status === 'running' && <RunningProgress activity={activity} lastActivity={lastActivity} hasText={Boolean(answer)} />}
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      {contextStatus && <p role="status" className={`text-xs ${contextStatus === 'index_read' ? 'text-emerald-300' : 'text-amber-200'}`}>
        {contextStatus === 'pending' ? 'Inherited work · attachment pending'
          : contextStatus === 'index_read' ? 'Inherited index read · supporting-file staging not fully verified'
            : contextStatus === 'attached_unverified' ? 'Inherited attachments submitted · staging unverified'
              : 'Inherited work use unverified · no savings established'}
      </p>}
      <div role="tablist" aria-label="Research views" className="flex flex-wrap gap-1 border-b border-slate-800">
        {[{ name: 'Conversation', Icon: MessageSquare }, { name: 'Activity', Icon: Activity }, { name: 'Evidence', Icon: Globe }].map(({ name, Icon }) => (
          <button key={name} type="button" role="tab" id={`tab-${chatId}-${name}`} aria-selected={view === name}
            aria-controls={`panel-${chatId}-${name}`} onClick={() => setView(name)} disabled={sharingPending}
            className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm ${view === name ? 'border-emerald-400 text-emerald-200' : 'border-transparent text-slate-400'}`}>
            <Icon size={15} />{name}{name === 'Activity' && inspected.activity.length > 0 ? ` (${inspected.activity.length})` : ''}
          </button>
        ))}
      </div>
      <section ref={transcript} role="tabpanel" id={`panel-${chatId}-${view}`} aria-labelledby={`tab-${chatId}-${view}`}
        onScroll={(event) => { if (view === 'Conversation') { const panel = event.currentTarget; followLatest.current = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 96 } }}
        className="min-h-32 min-w-0 flex-1 space-y-6 overflow-y-auto overscroll-contain pr-2">
        {view === 'Conversation' && <>
          {!submitted && !turns.length && <div className="chat-welcome"><h3>Hi, how can I help?</h3></div>}
          {turns.map((turn, index) => <ConversationTurn key={index} turn={turn} number={index + 1} onExport={exportBrief}
            onDownload={downloadArtifact} downloading={downloading} downloadDisabled={busy || !sessionId}
            onInspect={() => { setInspectedTurn(index); setView('Activity') }} />)}
          {submitted && <ConversationTurn turn={{ question: submitted, answer, brief, artifacts, status, inherited }} number={turns.length + 1} onExport={exportBrief}
            onDownload={downloadArtifact} downloading={downloading} downloadDisabled={busy || !sessionId}
            onInspect={() => { setInspectedTurn(null); setView('Activity') }} />}
          {sessionId && (status === 'done' || (!submitted && turns.length > 0)) && <div className="response-share">
            <button type="button" disabled={busy} onClick={() => setShareOpen(true)} aria-haspopup="dialog"
              title="Share completed conversation" className="share-action"><Share2 size={16} />Share with...</button>
            {shareOpen && <SharingDialog title="Share conversation" busy={sharingPending} onClose={() => setShareOpen(false)}>
              <SessionSharing account={account} sessionId={sessionId} busy={status === 'running'} mode="share" onPendingChange={setSharingPending} />
            </SharingDialog>}
          </div>}
        </>}
        {view === 'Activity' && <section aria-label="Harness activity">
          {inspected.inherited && <p className="mb-3 text-xs text-amber-200">Inherited historical work · {inspected.capturedAt ? new Date(inspected.capturedAt).toLocaleString() : 'capture time unknown'}</p>}
          {inspected.usage && <p className="mb-3 text-xs text-slate-400">Input {inspected.usage.input_tokens?.toLocaleString() ?? 'unknown'} · Output {inspected.usage.output_tokens?.toLocaleString() ?? 'unknown'} · Tool calls {inspected.usage.tool_calls ?? 'unknown'}</p>}
          <p className="mb-3 text-xs text-slate-500">{submitted ? `Turn ${inspectedTurn === null ? turns.length + 1 : inspectedTurn + 1}` : 'Current conversation'}</p>
          {!inspected.activity.length && <p className="text-sm text-slate-500">No native tool activity recorded.</p>}
          <ol className="divide-y divide-slate-800">{inspected.activity.map((item) => <li key={item.id} className="space-y-2 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="font-medium text-slate-200">{TOOL_LABELS[item.tool] || item.tool.replaceAll('_', ' ')}</span>
              <span className={item.status === 'failed' || item.status === 'interrupted' ? 'text-red-300' : 'text-slate-500'}>{item.status.replaceAll('_', ' ')}{item.inherited ? ' · inherited' : ''}</span>
            </div>
            {(item.detail || item.query) && <p className="break-all text-xs text-slate-400">{item.detail || item.query}</p>}
            {item.output && <details className="text-xs text-slate-400"><summary className="cursor-pointer">Tool result</summary>
              <p className="mt-2 break-words whitespace-pre-wrap leading-6">{item.output}</p></details>}
          </li>)}</ol>
        </section>}
        {view === 'Evidence' && <section aria-label="Research evidence" className="space-y-5">
          <p className="text-xs text-slate-500">{submitted ? `Turn ${inspectedTurn === null ? turns.length + 1 : inspectedTurn + 1}` : 'Current conversation'}</p>
          {!inspected.evidence.length && !inspected.calls.length && <p className="text-sm text-slate-500">No source evidence returned.</p>}
          <ul className="divide-y divide-slate-800">{inspected.evidence.map((item) => <li key={item.url} className="space-y-1 py-3">
            <a href={item.url} target="_blank" rel="noopener noreferrer" className="break-words text-sm text-emerald-300 underline underline-offset-2">{item.title}</a>
            <p className="break-all text-xs text-slate-500">{item.url}</p>
            <p className="text-xs text-slate-500">Publication date: unknown</p>
          </li>)}</ul>
          {inspected.calls.map((call) => <section key={call.call_id} className="space-y-3 border-t border-slate-800 pt-4">
            <div className="flex items-center justify-between gap-3 text-xs"><h3 className="font-semibold text-slate-200">{CONNECTOR_LABELS[call.source] || call.source}</h3>
              <span className="text-slate-500">{call.status}</span></div>
            {call.result && <SourceResult result={call.result} />}
          </section>)}
        </section>}
      </section>
      <form onSubmit={submit} aria-label="Message composer" className="message-composer flex min-w-0 shrink-0 items-end gap-2">
        <textarea ref={composer} aria-label="Question" value={question} onChange={(event) => setQuestion(event.target.value)} rows={3}
          disabled={busy || conversationEnded || !authenticated} maxLength={8000} placeholder={submitted ? 'Ask a follow-up…' : 'Ask a question…'}
          className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 disabled:opacity-60" />
        {status === 'running' ? <button type="button" title="Stop response" aria-label="Stop response" onClick={() => controller.current?.abort()}
          className="grid h-12 w-12 shrink-0 place-items-center rounded-lg border border-slate-700 text-red-300"><Square size={17} /></button>
          : authenticated ? <button type="submit" title="Send question" aria-label="Send question" disabled={busy || conversationEnded || !question.trim()}
            className="grid h-12 w-12 shrink-0 place-items-center rounded-lg border border-emerald-600 bg-emerald-900/40 text-emerald-200 disabled:opacity-40"><Send size={18} /></button>
            : <button type="button" onClick={onSignIn} disabled={!isSignInConfigured}
              title={isSignInConfigured ? 'Sign in' : 'Browser sign-in is not configured'}
              className="px-3 text-sm text-emerald-300 disabled:opacity-40">Sign in</button>}
      </form>
    </section>
    <aside aria-label="Suggested prompts" className="prompt-sidebar">
      <details ref={promptCatalogue} open className="prompt-catalogue">
        <summary>{initialFork ? 'Continue inherited research' : 'Sample prompts'}</summary>
        <ul className="mt-3 divide-y divide-slate-800">
              {(initialFork ? INHERITED_PROMPTS : SUGGESTED_PROMPTS).map((prompt) => <li key={prompt.title} className="min-w-0">
                <button type="button" title={`Use prompt: ${prompt.title}`} aria-label={`Use prompt: ${prompt.title}`}
                  disabled={busy || !authenticated}
                  onClick={() => { setQuestion(prompt.question); composer.current?.focus() }}
                  className="flex w-full min-w-0 items-start gap-3 py-4 text-left text-slate-400 hover:text-emerald-200 focus-visible:outline focus-visible:outline-emerald-400 disabled:cursor-not-allowed">
                  <span className="min-w-0 flex-1 break-words">
                    <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <span className="text-sm font-medium text-slate-200">{prompt.title}</span>
                      <span className="text-[11px] text-slate-500">{prompt.level}</span>
                    </span>
                    <span hidden className="mt-2 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
                      <span>Expected:</span>
                      {prompt.capabilities.map((capability) => {
                        const { label, Icon } = PROMPT_CAPABILITIES[capability]
                        return <span key={capability} title={`Expected tool: ${label}`} className="inline-flex items-center gap-1"><Icon size={12} className="shrink-0" />{label}</span>
                      })}
                    </span>
                    <span hidden className="mt-1 items-center gap-1 text-[11px] text-slate-400"
                      title="The agent chooses whether to delegate unless explicitly requested. Inspect Activity for actual calls.">
                      <GitFork size={12} className="shrink-0" />
                      {prompt.subagents ? `Up to ${prompt.subagents} subagents requested` : 'Subagents: agent decides'}
                    </span>
                    <span className="mt-1 block text-xs leading-5">{prompt.question}</span>
                  </span>
                  <ArrowDownLeft size={16} className="mt-1 shrink-0" />
                </button>
              </li>)}
            </ul>
      </details>
    </aside>
    </div>
  )
}