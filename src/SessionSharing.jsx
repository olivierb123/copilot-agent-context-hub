import { useEffect, useRef, useState } from 'react'
import { GitFork, RefreshCw, Share2, X } from 'lucide-react'
import { getAccessToken } from './auth.js'
import { requestHarness } from './agentClient.js'

export default function SessionSharing({ account, sessionId, busy, onFork, onPendingChange, mode = 'share' }) {
  const [shares, setShares] = useState([])
  const [recipients, setRecipients] = useState([])
  const [recipient, setRecipient] = useState('')
  const [consent, setConsent] = useState(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
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
    act('GET', '/shares', undefined, (result) => {
      setShares(result.shares)
      setRecipients(result.recipients)
      setRecipient((previous) => previous || result.recipients[0]?.object_id || '')
    })
  }

  return <section aria-label="Session sharing" className="space-y-5">
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-sm font-semibold text-slate-200">{mode === 'inbox' ? 'Shared with you' : 'Share conversation'}</h3>
      <button type="button" title="Refresh shared conversations and recipients" aria-label="Refresh shares" onClick={refresh} disabled={disabled}
        className="grid h-10 w-10 shrink-0 place-items-center rounded border border-slate-700 text-emerald-200 disabled:opacity-40"><RefreshCw size={17} /></button>
    </div>
    {error && <p role="alert" className="break-words text-sm text-red-300">{error}</p>}
    {pending && <p role="status" className="text-xs text-emerald-300">Updating shares...</p>}
    {mode === 'share' && <form aria-label="Share completed messages" className="flex min-w-0 flex-wrap items-end gap-3 border-y border-slate-800 py-4"
      onSubmit={(event) => {
        event.preventDefault()
        act('POST', `/sessions/${sessionId}/shares`, { recipient_object_id: recipient }, (share) => setShares((previous) => [...previous, share]))
      }}>
      <label className="min-w-0 flex-1 space-y-2 text-xs text-slate-400">Recipient
        <select aria-label="Share recipient" value={recipient} onChange={(event) => setRecipient(event.target.value)} disabled={disabled || !recipients.length}
          className="block w-full min-w-0 rounded border border-slate-700 bg-slate-900 p-3 text-xs text-slate-200">
          <option value="">Select recipient</option>
          {recipients.map((entry) => <option key={entry.object_id} value={entry.object_id}>{entry.user_id || entry.object_id}</option>)}
        </select>
      </label>
      <button type="submit" disabled={disabled || !sessionId || !recipient} title="Share the completed conversation text with this recipient"
        className="flex min-h-10 items-center gap-2 rounded border border-slate-700 px-3 text-sm text-emerald-200 disabled:opacity-40"><Share2 size={16} />Share messages</button>
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
            <label className="flex items-start gap-2 text-xs leading-5 text-slate-400">
              <input type="checkbox" checked={consent === share.id} onChange={(event) => setConsent(event.target.checked ? share.id : null)} disabled={disabled} className="mt-1 shrink-0" />
              I accept the shared conversation text. Files, credentials, permissions and tool approvals are excluded.
            </label>
            <button type="button" disabled={disabled || Boolean(sessionId) || consent !== share.id}
              title={sessionId ? 'Start a new conversation before accepting a share' : 'Accept this message snapshot into your own conversation'}
              onClick={() => act('POST', `/shares/${share.id}/fork`, { accept_snapshot: true }, (result) => {
                setShares(previous => previous.filter(entry => entry.id !== share.id))
                setConsent(null)
                onFork(result)
              })}
              className="flex min-h-10 items-center gap-2 rounded border border-emerald-700 px-3 text-sm text-emerald-200 disabled:opacity-40"><GitFork size={16} />Accept and fork</button>
          </>}
        </li>
      })}
    </ul>
    {!shares.length && <p className="text-sm text-slate-500">No shared conversations loaded.</p>}
  </section>
}