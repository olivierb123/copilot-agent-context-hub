import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, ArrowDownLeft, Database, Download, FileText, GitFork, Globe, Menu, MessageSquare, Plus, Search, Send, Share2, Square, X } from 'lucide-react'
import { runHarnessQuery } from './agentClient.js'
import { getAccessToken, isSignInConfigured } from './auth.js'
import SessionSharing from './SessionSharing.jsx'

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
  { title: 'Roadmap evidence', level: 'Simple', capabilities: ['knowledge'], subagents: 0, question: 'According to our product documentation, does FieldForge support weather-risk planning today, or is it still on the roadmap?' },
  { title: 'External research', level: 'Intermediate', capabilities: ['webSearch', 'webFetch'], subagents: 0, question: 'What does OSHA say about preventing heat illness on construction sites, and what are employers required to do?' },
  { title: 'Pipeline and definitions', level: 'Intermediate', capabilities: ['sales', 'knowledge'], subagents: 0, question: 'How many opportunities are open in the expanded synthetic demo, what is their total and probability-weighted value, and how do our internal forecasting definitions explain those numbers?' },
  { title: 'Web-informed opportunities', level: 'Advanced', capabilities: ['sales', 'webSearch', 'webFetch'], subagents: 0, question: 'Which South opportunities in the expanded synthetic demo should we prioritize, and what discovery questions would official OSHA heat-exposure guidance suggest for those conversations?' },
  { title: 'Complete territory brief', level: 'Advanced', capabilities: ['sales', 'knowledge', 'webSearch', 'webFetch', 'workspace', 'publish'], subagents: 0, question: 'Prepare a downloadable Markdown brief for South using the expanded synthetic demo. Cover sales performance, priority opportunities, relevant FieldForge capabilities and limitations, and official construction heat-exposure guidance. Recommend next actions and flag missing evidence.' },
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

function ConversationTurn({ turn, number, onInspect, onExport }) {
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
  const controller = useRef(null)
  const generation = useRef(0)
  const transcript = useRef(null)
  const composer = useRef(null)
  const followLatest = useRef(true)
  const authenticated = Boolean(account) || LOCAL_MODE
  const busy = status === 'running' || status === 'resetting' || sharingPending
  const conversationEnded = Boolean(submitted) && status === 'error' && !sessionId
  const inspected = inspectedTurn === null ? { activity, evidence, calls } : turns[inspectedTurn]

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
    for (let index = 0; index < (initialFork?.messages.length || 0); index += 2) imported.push({ question: initialFork.messages[index].content,
      answer: initialFork.messages[index + 1].content, inherited: true, status: 'done', activity: [], evidence: [], calls: [] })
    setTurns(imported)
    setInspectedTurn(null)
    setSubmitted('')
    setQuestion('')
    setError('')
    setView('Conversation')
    setAnswer('')
    setCalls([])
    setActivity([])
    setEvidence([])
    setBrief(null)
    setArtifacts([])
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
    if (submitted) setTurns((previous) => [...previous, { question: submitted, answer, brief, status, error, activity, evidence, calls, inherited }])
    setInherited(false)
    setQuestion('')
    setInspectedTurn(null)
    setView('Conversation')
    followLatest.current = true
    setSubmitted(input)
    setAnswer('')
    setBrief(null)
    setCalls([])
    setActivity([])
    setEvidence([])
    setError('')
    setStatus('running')
    try {
      const token = LOCAL_MODE ? null : await getAccessToken()
      if (!LOCAL_MODE && !token) throw new Error('Sign-in is required')
      await runHarnessQuery(input, {
        onEvent: (entry) => {
          if (!active()) return
          if (entry.type === 'harness.session') setSessionId(entry.session_id)
          if (entry.type === 'harness.source') {
            setCalls((previous) => [...previous.filter((call) => call.call_id !== entry.call_id), entry])
          }
          if (entry.type === 'harness.activity') {
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
    <section aria-label="Copilot Harness" className="conversation-surface flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-100">{initialFork ? 'Forked conversation' : 'Conversation'}</h2>
        <div className="flex min-w-0 items-center gap-3">
          <span className="min-w-0 break-all text-xs text-slate-500">{LOCAL_MODE ? 'Local developer identity' : account?.username || 'Signed out'} · Preview</span>
        </div>
      </div>
      {status === 'running' && <p role="status" className="text-xs text-emerald-300">Researching…</p>}
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      {artifacts.length > 0 && <section aria-label="Published files" className="divide-y divide-slate-800 border-y border-slate-800">
        {artifacts.map((artifact) => <div key={artifact.file_id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-3">
          <div className="min-w-0"><p className="break-all text-sm text-slate-200">{artifact.filename}</p>
            <p className="text-xs text-slate-500">Published artifact · {artifact.bytes} bytes</p></div>
          <button type="button" title={`Download ${artifact.filename}`} aria-label={`Download ${artifact.filename}`}
            disabled={busy || Boolean(downloading)} onClick={() => downloadArtifact(artifact)}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-slate-700 text-emerald-200 disabled:opacity-40"><Download size={17} /></button>
        </div>)}
      </section>}
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
          {!submitted && !turns.length && <section aria-label="Suggested prompts" className="chat-welcome">
            <h3>Hi, how can I help?</h3>
            <ul className="mt-6 grid gap-x-6 md:grid-cols-2">
              {SUGGESTED_PROMPTS.slice(0, 4).map((prompt) => <li key={prompt.title} className="min-w-0">
                <button type="button" title={`Use prompt: ${prompt.title}`} aria-label={`Use prompt: ${prompt.title}`}
                  disabled={busy || !authenticated}
                  onClick={() => { setQuestion(prompt.question); composer.current?.focus() }}
                  className="flex w-full min-w-0 items-start gap-3 py-4 text-left text-slate-400 hover:text-emerald-200 focus-visible:outline focus-visible:outline-emerald-400 disabled:cursor-not-allowed">
                  <span className="min-w-0 flex-1 break-words">
                    <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <span className="text-sm font-medium text-slate-200">{prompt.title}</span>
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
          </section>}
          {turns.map((turn, index) => <ConversationTurn key={index} turn={turn} number={index + 1} onExport={exportBrief}
            onInspect={() => { setInspectedTurn(index); setView('Activity') }} />)}
          {submitted && <ConversationTurn turn={{ question: submitted, answer, brief, status, inherited }} number={turns.length + 1} onExport={exportBrief}
            onInspect={() => { setInspectedTurn(null); setView('Activity') }} />}
          {sessionId && (status === 'done' || (!submitted && turns.length > 0)) && <div className="response-share">
            <button type="button" disabled={busy} onClick={() => setShareOpen(previous => !previous)} aria-expanded={shareOpen}
              title="Share completed conversation" className="share-action"><Share2 size={16} />Share with...</button>
            {shareOpen && <div className="inline-sharing"><div className="flex justify-end"><button aria-label="Close sharing" title="Close sharing" onClick={() => setShareOpen(false)} disabled={sharingPending}><X size={16} /></button></div>
              <SessionSharing account={account} sessionId={sessionId} busy={status === 'running'} mode="share" onPendingChange={setSharingPending} />
            </div>}
          </div>}
        </>}
        {view === 'Activity' && <section aria-label="Harness activity">
          <p className="mb-3 text-xs text-slate-500">{submitted ? `Turn ${inspectedTurn === null ? turns.length + 1 : inspectedTurn + 1}` : 'Current conversation'}</p>
          {!inspected.activity.length && <p className="text-sm text-slate-500">No native tool activity recorded.</p>}
          <ol className="divide-y divide-slate-800">{inspected.activity.map((item) => <li key={item.id} className="space-y-2 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="font-medium text-slate-200">{TOOL_LABELS[item.tool] || item.tool.replaceAll('_', ' ')}</span>
              <span className={item.status === 'failed' || item.status === 'interrupted' ? 'text-red-300' : 'text-slate-500'}>{item.status.replaceAll('_', ' ')}</span>
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
  )
}