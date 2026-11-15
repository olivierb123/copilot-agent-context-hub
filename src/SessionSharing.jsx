import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { GitFork, RefreshCw, Share2, X } from 'lucide-react'
import { getAccessToken } from './auth.js'
import { requestHarness } from './agentClient.js'

export function SharingDialog({ title, busy, onClose, children, opener }) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    const dialog = ref.current
    const returnFocus = opener || document.activeElement
    dialog.showModal()
    return () => {
      dialog.close()
      if (returnFocus?.isConnected) returnFocus.focus()
    }
  }, [opener])
  return <dialog ref={ref} aria-label={title} className="sharing-dialog" onCancel={(event) => {
    event.preventDefault()
    if (!busy) onClose()
  }} onKeyDown={(event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    if (!busy) onClose()
  }} onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <header className="sharing-dialog-header"><h2>{title}</h2>
      <button type="button" title="Close dialog" aria-label="Close dialog" disabled={busy} onClick={onClose}><X size={18} /></button>
    </header>
    <div className="sharing-dialog-body">{children}</div>
  </dialog>
}

function ContextContents({ context, expanded = false }) {
  if (!context) return null
  const items = context.items || context.work?.flatMap((turn) => turn.records.map((record) => ({
    kind: record.kind, title: record.filename || record.title || record.tool || record.kind, status: record.status || 'returned',
  }))) || []
  const omissions = context.omissions || context.work?.flatMap((turn) => turn.omissions) || []
  return <div className="min-w-0 space-y-2 text-xs text-slate-400">
    <p>Completed work · {items.length} records{context.files ? ` · ${context.files.length} published files` : ''}</p>
    <ul className="space-y-1">{items.map((item, index) => <li key={index} className="break-words">{item.title} · {item.kind} · {item.status}</li>)}</ul>
    {context.files?.map((file) => <p key={file.filename} className="break-all">{file.filename} · {file.bytes} bytes</p>)}
    {omissions.length > 0 && <div role="status" className="text-amber-200"><p>Not included</p>
      <ul>{omissions.map((entry, index) => <li key={index}>{entry.reason.replaceAll('_', ' ')}{entry.blocking ? ' · fork blocked' : ''}</li>)}</ul></div>}
    {context.messages && <details open={expanded} className="min-w-0"><summary className="cursor-pointer">Conversation messages · {context.messages.length}</summary>
      <div className="mt-2 max-h-64 space-y-4 overflow-auto">{context.messages.map((message, index) => <div key={index} className="min-w-0">
        <p className="font-semibold">{message.role}</p><p className="whitespace-pre-wrap break-words">{message.content}</p>
      </div>)}</div></details>}
    {context.work?.map((turn, index) => <details key={index} open={expanded} className="min-w-0">
      <summary className="cursor-pointer">Turn {turn.turn} · captured {turn.captured_at ? new Date(turn.captured_at).toLocaleString() : 'unknown'}</summary>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(turn.records, null, 2)}</pre>
    </details>)}
  </div>
}

export default function SessionSharing({ account, sessionId, busy, onFork, onPendingChange, mode = 'share' }) {
  const [shares, setShares] = useState([])
  const [recipients, setRecipients] = useState([])
  const [recipient, setRecipient] = useState('')
  const [consent, setConsent] = useState(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [snapshot, setSnapshot] = useState(null)
  const [ownerConsent, setOwnerConsent] = useState(false)
  const [preview, setPreview] = useState(null)
  const [reviewShare, setReviewShare] = useState(null)
  const reviewOpener = useRef(null)
  const request = useRef(null)
  const generation = useRef(0)
  const principal = account ? `${account.tenantId}:${account.localAccountId}` : null
  const disabled = busy || pending || !account

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => { if (!cancelled && account) refresh() })
    return () => { cancelled = true }
  }, [account?.homeAccountId, sessionId])

  useEffect(() => () => {
    generation.current += 1
    request.current?.abort()
    onPendingChange(false)
  }, [onPendingChange])

  async function act(method, path, body, complete) {
    if (disabled || request.current) return
    const current = generation.current
    const controller = new AbortController()
    request.current = controller
    setPending(true)
    onPendingChange(true)
    setError('')
    try {
      const token = await getAccessToken()
      if (current !== generation.current) return
      const result = await requestHarness(path, { token, method, body, signal: controller.signal })
      if (current === generation.current) complete(result)
    } catch (failure) {
      if (current === generation.current) setError(failure.message)
    } finally {
      if (current === generation.current) {
        setPending(false)
        request.current = null
        onPendingChange(false)
      }
    }
  }

  function refresh() {
    act('GET', `/shares${sessionId ? `?session_id=${sessionId}` : ''}`, undefined, (result) => {
      setShares(result.shares)
      setRecipients(result.recipients)
      setRecipient((previous) => previous || result.recipients[0]?.object_id || '')
      setSnapshot(result.context ? { ...result.context, principal } : null)
      setOwnerConsent(false)
      setPreview(null)
      setConsent(null)
      setReviewShare(null)
    })
  }

  return <section aria-label="Session sharing" className="space-y-5">
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-sm font-semibold text-slate-200">{mode === 'inbox' ? 'Shared with you' : 'Snapshot'}</h3>
      <button type="button" title="Refresh shared conversations and recipients" aria-label="Refresh shares" onClick={refresh} disabled={disabled}
        className="grid h-10 w-10 shrink-0 place-items-center rounded border border-slate-700 text-emerald-200 disabled:opacity-40"><RefreshCw size={17} /></button>
    </div>
    {error && <p role="alert" className="break-words text-sm text-red-300">{error}</p>}
    {pending && <p role="status" className="text-xs text-emerald-300">Updating shares...</p>}
    {mode === 'share' && <form aria-label="Share completed work" className="flex min-w-0 flex-wrap items-end gap-3 border-y border-slate-800 py-4"
      onSubmit={(event) => {
        event.preventDefault()
        act('POST', `/sessions/${sessionId}/shares`, { recipient_object_id: recipient, consent_completed_work: ownerConsent,
          context_version: snapshot?.version }, (share) => { setShares((previous) => [...previous, share]); setOwnerConsent(false) })
      }}>
      <label className="min-w-0 flex-1 space-y-2 text-xs text-slate-400">Recipient
        <select aria-label="Share recipient" value={recipient} onChange={(event) => { setRecipient(event.target.value); setOwnerConsent(false) }} disabled={disabled || !recipients.length}
          className="block w-full min-w-0 rounded border border-slate-700 bg-slate-900 p-3 text-xs text-slate-200">
          <option value="">Select recipient</option>
          {recipients.map((entry) => <option key={entry.object_id} value={entry.object_id}>{entry.user_id || entry.object_id}</option>)}
        </select>
      </label>
      <button type="submit" disabled={disabled || !sessionId || !recipient || !ownerConsent || snapshot?.principal !== principal || snapshot?.omissions?.some((entry) => entry.blocking)} title="Share the reviewed conversation and completed work"
        className="flex min-h-10 items-center gap-2 rounded border border-slate-700 px-3 text-sm text-emerald-200 disabled:opacity-40"><Share2 size={16} />Share conversation</button>
      {snapshot?.principal === principal && <div className="w-full min-w-0 space-y-3"><ContextContents context={snapshot} />
        <label className="flex items-start gap-2 text-xs leading-5 text-slate-400"><input type="checkbox" aria-label="Consent to share completed work" checked={ownerConsent}
          onChange={(event) => setOwnerConsent(event.target.checked)} disabled={disabled} className="mt-1 shrink-0" />
          I consent to sharing these messages, source results, completed findings and files with the selected recipient. Credentials, permissions, tool approvals and hidden reasoning are excluded.
        </label></div>}
    </form>}
    <ul className="divide-y divide-slate-800">
      {shares.map((share) => {
        const outgoing = share.owner === principal
        if (mode === 'inbox' ? outgoing : !outgoing) return null
        const otherId = (outgoing ? share.recipient : share.owner).split(':').pop()
        const userLabel = recipients.find(entry => entry.object_id === otherId)?.user_id || otherId
        return <li key={share.id} className="space-y-3 py-4">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <p className="text-sm text-slate-200">{outgoing ? 'Shared by you' : 'Shared with you'} · {share.turns} {share.turns === 1 ? 'turn' : 'turns'}</p>
              <p className="break-all text-xs text-slate-400">{userLabel}</p>
              <p className="text-xs text-slate-500">Expires {new Date(share.expires).toLocaleTimeString()}</p>
            </div>
            {outgoing && <button type="button" title="Revoke this share" aria-label="Revoke share" disabled={disabled}
              onClick={() => act('DELETE', `/shares/${share.id}`, undefined, () => setShares((previous) => previous.filter((entry) => entry.id !== share.id)))}
              className="grid h-10 w-10 shrink-0 place-items-center rounded border border-slate-700 text-slate-300 disabled:opacity-40"><X size={17} /></button>}
          </div>
          {!outgoing && <>
            <button type="button" disabled={disabled} title="Review the exact completed-work snapshot"
              onClick={(event) => {
                reviewOpener.current = event.currentTarget
                setReviewShare(share)
                setPreview(null)
                setConsent(null)
                act('GET', `/shares/${share.id}`, undefined, (result) => setPreview(result))
              }}
              className="flex min-h-10 items-center gap-2 text-xs text-emerald-200"><GitFork size={16} />Open shared conversation</button>
          </>}
        </li>
      })}
    </ul>
    {reviewShare && <SharingDialog title="Review shared snapshot" opener={reviewOpener.current} busy={pending || busy} onClose={() => {
      setReviewShare(null)
      setPreview(null)
      setConsent(null)
    }}>
      <div className="space-y-5">
        <p className="break-all text-xs text-slate-400">From {recipients.find((entry) => entry.object_id === reviewShare.owner.split(':').pop())?.user_id || reviewShare.owner.split(':').pop()} · {reviewShare.turns} {reviewShare.turns === 1 ? 'turn' : 'turns'}</p>
        {pending && <p role="status" className="text-sm text-emerald-200">Loading snapshot...</p>}
        {error && <p role="alert" className="break-words text-sm text-red-300">{error}</p>}
        {preview?.id === reviewShare.id && preview.recipient === principal && <>
          <ContextContents expanded context={{ ...preview.context, messages: preview.messages }} />
          <label className="flex items-start gap-2 text-xs leading-5 text-slate-400">
            <input type="checkbox" aria-label="Accept reviewed completed work" checked={consent === reviewShare.id}
              onChange={(event) => setConsent(event.target.checked ? reviewShare.id : null)} disabled={disabled} className="mt-1 shrink-0" />
            I accept the reviewed messages and completed work as historical material. Credentials, permissions, tool approvals and hidden reasoning are excluded.
          </label>
          <button type="button" disabled={disabled || Boolean(sessionId) || consent !== reviewShare.id || !preview.context?.hash}
            title={sessionId ? 'Start a new conversation before accepting a share' : 'Accept this completed-work snapshot into your own conversation'}
            onClick={() => act('POST', `/shares/${reviewShare.id}/fork`, { accept_completed_work: true, context_hash: preview.context.hash }, (result) => {
              setShares(previous => previous.filter(entry => entry.id !== reviewShare.id))
              setConsent(null)
              setPreview(null)
              setReviewShare(null)
              onFork(result)
            })}
            className="flex min-h-10 items-center gap-2 rounded border border-emerald-700 px-3 text-sm text-emerald-200 disabled:opacity-40"><GitFork size={16} />Accept and fork</button>
        </>}
      </div>
    </SharingDialog>}
    {!shares.length && <p className="text-sm text-slate-500">No shared conversations loaded.</p>}
  </section>
}