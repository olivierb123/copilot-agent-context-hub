import { useState, useEffect } from 'react'
import { LogIn, LogOut } from 'lucide-react'
import HarnessConsole from './HarnessConsole.jsx'
import { signIn, signOut, getActiveAccount, isSignInConfigured } from './auth.js'

export default function App() {
  const [account, setAccount] = useState(null)

  useEffect(() => {
    getActiveAccount().then(setAccount)
  }, [])

  const handleSignIn = () => {
    signIn()
  }

  const handleSignOut = () => {
    signOut()
  }

  return (
    <div className="app-shell min-h-screen text-slate-100">
      <header className="app-header border-b border-slate-800 px-5 py-3">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-base font-semibold text-slate-100">
              Copilot Agent Context Hub
            </h1>
          </div>
          {account ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="min-w-0 break-all text-[11px] font-mono text-slate-500">
                Signed in: {account.username}
              </span>
              <button
                onClick={handleSignOut}
                className="flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-800 px-3 py-1 text-xs font-mono uppercase tracking-wide text-slate-500 transition-colors hover:border-slate-700 hover:text-slate-300"
              >
                <LogOut size={12} strokeWidth={2.5} />
                Sign out
              </button>
            </div>
          ) : (
            <button
              onClick={handleSignIn}
              disabled={!isSignInConfigured}
              title={isSignInConfigured ? 'Sign in' : 'Browser sign-in is not configured'}
              className="flex shrink-0 items-center gap-1.5 self-start rounded-lg border border-slate-800 px-3 py-1 text-xs font-mono uppercase tracking-wide text-slate-500 transition-colors hover:border-slate-700 hover:text-slate-300"
            >
              <LogIn size={12} strokeWidth={2.5} />
              Sign in
            </button>
          )}
        </div>
      </header>

      <main>
        <HarnessConsole account={account} onSignIn={handleSignIn} />
      </main>
    </div>
  )
}
