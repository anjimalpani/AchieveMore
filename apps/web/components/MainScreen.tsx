'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase'
import VoiceOrb from './VoiceOrb'
import TaskList, { type Task } from './TaskList'
import TomorrowSummary from './TomorrowSummary'
import { useVoiceSession } from '@/hooks/useVoiceSession'

// ── Quotes ────────────────────────────────────────────────────────────────────
const QUOTES = [
  { text: "The secret of getting ahead is getting started.", author: "Mark Twain" },
  { text: "You don't have to be great to start, but you have to start to be great.", author: "Zig Ziglar" },
  { text: "Small steps every day lead to big changes over time.", author: "Anonymous" },
  { text: "Today is full of possibilities. Make the most of it.", author: "Anonymous" },
  { text: "Believe you can and you're halfway there.", author: "Theodore Roosevelt" },
  { text: "Every morning is a fresh beginning.", author: "Todd Stocker" },
  { text: "Do something today that your future self will thank you for.", author: "Sean Patrick Flanery" },
  { text: "The only way to do great work is to love what you do.", author: "Steve Jobs" },
  { text: "You are capable of more than you know.", author: "E.O. Wilson" },
  { text: "Progress, not perfection.", author: "Anonymous" },
  { text: "A little progress each day adds up to big results.", author: "Satya Namburu" },
  { text: "Your potential is endless.", author: "Anonymous" },
  { text: "Make today count.", author: "Anonymous" },
  { text: "The future depends on what you do today.", author: "Mahatma Gandhi" },
]

function getDailyQuote() {
  const day = new Date().getDate() + new Date().getMonth() * 31
  return QUOTES[day % QUOTES.length]
}

// ── Timezone helpers ──────────────────────────────────────────────────────────
/**
 * Returns the UTC ISO string for midnight on (today + daysOffset) in the given timezone.
 * Uses noon UTC on the target day as a reference to handle DST safely.
 */
function startOfDayUTC(tz: string, daysOffset = 0): string {
  const now = new Date()
  const localDate = now.toLocaleDateString('en-CA', { timeZone: tz }) // "YYYY-MM-DD"
  const [y, m, d] = localDate.split('-').map(Number)
  const noon = new Date(Date.UTC(y, m - 1, d + daysOffset, 12, 0, 0))
  const fp = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(noon)
  const tzHour = parseInt(fp.find(p => p.type === 'hour')!.value)
  const tzMin  = parseInt(fp.find(p => p.type === 'minute')!.value)
  const offsetMin = (tzHour - 12) * 60 + tzMin
  return new Date(noon.getTime() - (12 * 60 + offsetMin) * 60_000).toISOString()
}

function formatDateTimeInTz(iso: string, tz: string) {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: tz,
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

// ── Props ─────────────────────────────────────────────────────────────────────
interface MainScreenProps {
  userName: string
  hasCalendar: boolean
  userTimezone: string
  calendarEmail: string | null
  needsTasksReauth: boolean
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function MainScreen({
  userName, hasCalendar: initialHasCalendar, userTimezone, calendarEmail, needsTasksReauth: initialNeedsTasksReauth,
}: MainScreenProps) {
  const [todayTasks, setTodayTasks] = useState<Task[]>([])
  // hasCalendar starts from the server prop but can be updated reactively after OAuth redirect
  const [hasCalendar, setHasCalendar] = useState(initialHasCalendar)
  const quote = getDailyQuote()
  const tz = userTimezone

  const {
    orbState, errorMessage, pendingTasks, isActive, savedCount,
    needsTasksReauth: sessionNeedsTasksReauth,
    toggle, confirmTask, dismissTask,
  } = useVoiceSession()

  // Show banner if page.tsx detected it OR if the voice server confirmed it mid-session
  const needsTasksReauth = initialNeedsTasksReauth || sessionNeedsTasksReauth

  const loadTasks = useCallback(() => {
    const supabase = createClient()
    const todayStart    = startOfDayUTC(tz, 0)
    const tomorrowStart = startOfDayUTC(tz, 1)

    supabase.from('tasks').select('*')
      .gte('due_at', todayStart).lt('due_at', tomorrowStart)
      .order('due_at', { ascending: true })
      .then(({ data }) => { if (data) setTodayTasks(data as Task[]) })
  }, [tz])

  useEffect(() => { loadTasks() }, [savedCount, loadTasks])

  // After OAuth redirect (?calendar=connected), verify the token was stored
  // and update hasCalendar state reactively — no manual reload required.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (!params.has('calendar')) return

    // Clean the URL param immediately so it doesn't linger on refresh
    const cleanUrl = window.location.pathname
    window.history.replaceState({}, '', cleanUrl)

    // Confirm token is actually in DB (guards against stale redirects)
    const supabase = createClient()
    supabase
      .from('user_preferences')
      .select('gcal_token')
      .single()
      .then(({ data }) => {
        if (data?.gcal_token) {
          setHasCalendar(true)
          console.log('[MainScreen] Calendar connected — banner hidden')
        }
      })
  }, [])

  async function handleDeleteTask(taskId: string) {
    const supabase = createClient()
    await supabase.from('tasks').delete().eq('id', taskId)
    loadTasks()
  }

  async function handleSignOut() {
    const supabase = createClient()
    await supabase.auth.signOut()
    window.location.replace('/login')
  }

  const buttonLabel =
    orbState === 'processing' ? 'Connecting\u2026' :
    orbState === 'listening'  ? 'Listening\u2026' :
    orbState === 'speaking'   ? 'Agent speaking\u2026' :
    'Start Conversation'

  const now = new Date()
  const todayLabel = now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' })

  return (
    <div className="min-h-screen text-white flex flex-col overflow-x-hidden relative">
      <MountainBackground />

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="relative z-10 flex items-center justify-between px-4 sm:px-6 py-3 border-b border-white/10 bg-black/30 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-sm font-bold shrink-0">
            {userName.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="text-xs text-white/40">Good {getGreeting(tz)}</p>
            <p className="text-sm font-semibold text-white/90 leading-tight truncate">{userName}</p>
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {/* Calendar sync badge */}
          {hasCalendar && (
            <div className="hidden sm:flex items-center gap-1.5 text-xs text-green-400/80 bg-green-900/20 border border-green-700/30 rounded-full px-2.5 py-1">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
              <span className="truncate max-w-[120px]">{calendarEmail ?? 'Calendar synced'}</span>
            </div>
          )}
          <button
            onClick={handleSignOut}
            className="text-xs text-white/50 hover:text-white border border-white/20 hover:border-white/50 rounded-lg px-3 py-1.5 transition-all bg-black/20 hover:bg-black/40"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* ── Content layer ──────────────────────────────────────────────────── */}
      <div className="relative z-10 flex flex-col flex-1">

        {/* ── Motivational quote ─────────────────────────────────────────── */}
        <div className="mx-3 sm:mx-4 mt-3 rounded-2xl bg-black/30 backdrop-blur-sm border border-white/10 px-4 sm:px-5 py-3 text-center">
          <p className="text-xs sm:text-sm text-white/90 italic leading-relaxed">&ldquo;{quote.text}&rdquo;</p>
          <p className="text-xs text-orange-300/70 mt-1 font-medium">&mdash; {quote.author}</p>
        </div>

        {/* ── Calendar connection status ──────────────────────────────────── */}
        {hasCalendar ? (
          <div className="mx-3 sm:mx-4 mt-3 flex items-center gap-2 rounded-xl bg-green-900/20 border border-green-700/30 px-3 sm:px-4 py-2.5">
            <span className="w-2 h-2 rounded-full bg-green-400 shrink-0" />
            <p className="text-xs text-green-300/90 font-medium">
              {userName.split(' ')[0]}&apos;s Google Calendar is connected
            </p>
          </div>
        ) : (
          <a
            href="/api/calendar/connect"
            className="mx-3 sm:mx-4 mt-3 flex items-center gap-3 rounded-xl bg-blue-900/40 backdrop-blur-sm border border-blue-400/30 px-3 sm:px-4 py-3 hover:bg-blue-900/60 transition-all"
          >
            <span className="text-xl shrink-0">📅</span>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-blue-100 text-xs sm:text-sm">Connect Google Calendar</p>
              <p className="text-xs text-blue-300/70 mt-0.5 leading-tight">Sync tasks and see your events in the agent context</p>
            </div>
            <span className="text-blue-300 text-lg shrink-0">→</span>
          </a>
        )}

        {/* ── Google Tasks reauth banner ──────────────────────────────────── */}
        {hasCalendar && needsTasksReauth && (
          <a
            href="/api/calendar/connect"
            className="mx-3 sm:mx-4 mt-3 flex items-center gap-3 rounded-xl bg-amber-900/30 backdrop-blur-sm border border-amber-500/40 px-3 sm:px-4 py-3 hover:bg-amber-900/50 transition-all"
          >
            <span className="text-xl shrink-0">☑️</span>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-amber-200 text-xs sm:text-sm">Enable Google Tasks sync</p>
              <p className="text-xs text-amber-300/70 mt-0.5 leading-tight">
                Reconnect Google to let the agent read and create tasks in your Google Tasks app
              </p>
            </div>
            <span className="text-amber-400 text-lg shrink-0">→</span>
          </a>
        )}

        {/* ── Error banner ───────────────────────────────────────────────── */}
        {errorMessage && (
          <div className="mx-3 sm:mx-4 mt-3 rounded-xl bg-red-900/50 backdrop-blur-sm border border-red-400/40 px-4 py-3 text-sm text-red-200">
            {errorMessage}
          </div>
        )}

        {/* ── Two-column layout ──────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col lg:flex-row gap-0 lg:gap-6 px-3 sm:px-4 lg:px-8 pt-4 pb-6 max-w-6xl mx-auto w-full">

          {/* ── LEFT: voice + tasks ──────────────────────────────────────── */}
          <div className="flex flex-col gap-4 lg:w-96 shrink-0">

            {/* Voice assistant — primary CTA */}
            <div>
              <p className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-2 px-1">Voice assistant</p>
              <Tooltip tip="Tap and speak naturally — &ldquo;add a meeting tomorrow at 2pm&rdquo; or &ldquo;remind me to call John on Friday&rdquo;. The agent confirms before saving anything.">
                <button
                  onClick={toggle}
                  className={[
                    'w-full flex items-center gap-3 sm:gap-4 rounded-2xl px-4 sm:px-5 py-4 font-bold shadow-xl transition-all duration-200 active:scale-95',
                    isActive
                      ? 'bg-gradient-to-r from-red-600 to-red-700 border-2 border-red-400 shadow-red-900/40'
                      : 'bg-gradient-to-r from-indigo-600 to-purple-600 border border-indigo-500/50 hover:from-indigo-500 hover:to-purple-500 shadow-indigo-900/40',
                  ].join(' ')}
                  aria-pressed={isActive}
                >
                  <VoiceOrb state={orbState} />
                  <div className="text-left min-w-0">
                    <p className="text-white font-bold text-sm sm:text-base">{buttonLabel}</p>
                    <p className="text-xs font-normal opacity-75 mt-0.5 leading-tight">
                      {isActive ? 'Tap again to end the session' : 'Add tasks, events & reminders by voice'}
                    </p>
                  </div>
                </button>
              </Tooltip>
              <p className="text-center mt-2">
                <a href="#" className="text-xs text-white/25 hover:text-white/60 transition-colors">type instead</a>
              </p>
            </div>

            {/* Pending confirmation cards */}
            {pendingTasks.length > 0 && (
              <div className="space-y-3">
                <p className="text-xs font-semibold text-amber-400/80 uppercase tracking-wider px-1">
                  Confirm before saving ({pendingTasks.length})
                </p>
                {pendingTasks.map(pending => (
                  <ConfirmCard
                    key={pending.callId}
                    pending={pending}
                    timezone={tz}
                    onConfirm={confirmTask}
                    onDismiss={dismissTask}
                  />
                ))}
              </div>
            )}

            {/* Captured tasks & events */}
            <div>
              <div className="flex items-center justify-between mb-2 px-1">
                <p className="text-xs font-semibold text-white/40 uppercase tracking-wider">Captured tasks &amp; events</p>
                <span className="text-xs text-white/25">{todayLabel}</span>
              </div>
              <TaskList tasks={todayTasks} timezone={tz} onDelete={handleDeleteTask} pendingCallIds={pendingTasks.map(p => p.callId)} />
            </div>

            {/* Daily briefs — bottom of left column */}
            <div className="mt-4 lg:mt-auto pt-2">
              <p className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-2 px-1">Daily briefs</p>
              <div className="grid grid-cols-2 gap-3">
                <Tooltip tip="Hear a spoken summary of tomorrow&apos;s schedule and anything you need to prepare tonight.">
                  <button
                    onClick={() => alert('Night Brief \u2014 coming soon')}
                    className="flex flex-col items-start gap-1 rounded-2xl bg-black/40 backdrop-blur-sm border border-white/10 px-4 py-4 h-[88px] hover:bg-black/55 hover:border-white/20 active:scale-95 transition-all duration-150 shadow-md text-left w-full"
                  >
                    <span className="text-2xl leading-none">🌙</span>
                    <span className="text-xs font-semibold text-white mt-1">Night Brief</span>
                    <span className="text-[11px] text-white/50 leading-tight">Preview tomorrow</span>
                  </button>
                </Tooltip>

                <Tooltip tip="Start your day with a spoken run-through of today&apos;s priorities in time order.">
                  <button
                    onClick={() => alert('Morning Brief \u2014 coming soon')}
                    className="flex flex-col items-start gap-1 rounded-2xl bg-black/40 backdrop-blur-sm border border-white/10 px-4 py-4 h-[88px] hover:bg-black/55 hover:border-white/20 active:scale-95 transition-all duration-150 shadow-md text-left w-full"
                  >
                    <span className="text-2xl leading-none">☀️</span>
                    <span className="text-xs font-semibold text-white mt-1">Morning Brief</span>
                    <span className="text-[11px] text-white/50 leading-tight">Review today</span>
                  </button>
                </Tooltip>
              </div>
            </div>

          </div>

          {/* ── RIGHT: AI tomorrow summary ────────────────────────────── */}
          <div className="lg:flex-1 mt-4 lg:mt-0">
            <TomorrowSummary userTimezone={tz} />
          </div>

        </div>
      </div>
    </div>
  )
}

// ── Mountain sunrise background ───────────────────────────────────────────────
function MountainBackground() {
  return (
    <div
      className="fixed inset-0 -z-10 pointer-events-none"
      aria-hidden="true"
      style={{
        background: 'linear-gradient(to bottom, #0d0720 0%, #1a0a35 18%, #3d1060 32%, #7b1fa2 44%, #c2410c 58%, #ea580c 68%, #fb923c 76%, #fed7aa 86%, #fff1e6 100%)',
      }}
    >
      <div className="absolute w-full" style={{ bottom: '28%', height: '220px', background: 'radial-gradient(ellipse 60% 100% at 50% 100%, rgba(251,146,60,0.55) 0%, rgba(251,146,60,0.2) 45%, transparent 70%)' }} />
      <div className="absolute left-1/2 -translate-x-1/2 rounded-full" style={{ bottom: '29%', width: '70px', height: '70px', background: 'radial-gradient(circle, #fef9c3 0%, #fde047 40%, #fb923c 100%)', boxShadow: '0 0 60px 20px rgba(253,224,71,0.35), 0 0 120px 50px rgba(251,146,60,0.2)' }} />
      <svg className="absolute bottom-0 w-full" viewBox="0 0 1440 320" preserveAspectRatio="none" style={{ height: '40%' }}>
        <path d="M0,320 L0,180 L120,80 L200,140 L320,40 L440,120 L560,60 L680,130 L800,50 L920,110 L1040,65 L1160,140 L1280,90 L1380,150 L1440,110 L1440,320 Z" fill="rgba(60,20,80,0.55)" />
      </svg>
      <svg className="absolute bottom-0 w-full" viewBox="0 0 1440 280" preserveAspectRatio="none" style={{ height: '34%' }}>
        <path d="M0,280 L0,200 L80,110 L180,180 L280,90 L380,160 L500,70 L600,150 L700,80 L820,160 L920,85 L1040,165 L1160,95 L1260,170 L1380,100 L1440,150 L1440,280 Z" fill="rgba(30,10,50,0.75)" />
      </svg>
      <svg className="absolute bottom-0 w-full" viewBox="0 0 1440 240" preserveAspectRatio="none" style={{ height: '26%' }}>
        <path d="M0,240 L0,180 L100,100 L200,170 L300,80 L420,160 L520,90 L620,160 L740,60 L840,140 L960,75 L1080,155 L1200,85 L1320,155 L1440,100 L1440,240 Z" fill="rgba(10,5,20,0.90)" />
      </svg>
      <div className="absolute bottom-0 w-full" style={{ height: '5%', background: 'rgba(5,2,10,0.95)' }} />
    </div>
  )
}

// ── Confirmation card ─────────────────────────────────────────────────────────
interface ConfirmCardProps {
  pending: import('@/hooks/useVoiceSession').PendingTask
  timezone: string
  onConfirm: (callId: string) => Promise<void>
  onDismiss: (callId: string) => void
}

function ConfirmCard({ pending, timezone, onConfirm, onDismiss }: ConfirmCardProps) {
  const [saving, setSaving] = useState(false)
  const { task, callId } = pending
  const TYPE_ICON: Record<string, string> = { task: '✅', event: '📅', reminder: '🔔' }
  const icon = TYPE_ICON[task.type ?? 'task'] ?? '✅'

  async function handleConfirm() {
    setSaving(true)
    await onConfirm(callId)
  }

  return (
    <div className="rounded-2xl bg-black/60 backdrop-blur-md border-2 border-amber-400/60 p-4 shadow-xl shadow-amber-900/20">
      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <span>{icon}</span>
        <p className="text-xs font-bold text-amber-400 uppercase tracking-wider">
          Confirm {task.type ?? 'task'}
        </p>
      </div>
      <p className="text-[11px] text-white/40 mb-3">
        Please verify the details below before saving.
      </p>

      {/* Details */}
      <div className="space-y-2 mb-4">
        <DetailRow label="What" value={task.title} />
        {task.due_at && (
          <DetailRow
            label="When"
            value={formatDateTimeInTz(task.due_at, timezone)}
            highlight
          />
        )}
        {task.notes && <DetailRow label="Notes" value={task.notes} />}
        {task.due_at && (
          <p className="text-[10px] text-white/30 pt-1">
            Timezone: {timezone}
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={handleConfirm}
          disabled={saving}
          className="flex-1 rounded-xl bg-amber-500 hover:bg-amber-400 py-2.5 text-sm font-bold text-black disabled:opacity-50 active:scale-95 transition-all"
        >
          {saving ? 'Saving\u2026' : '✓ Yes, save it'}
        </button>
        <button
          onClick={() => onDismiss(callId)}
          disabled={saving}
          className="rounded-xl bg-white/10 px-4 py-2.5 text-sm font-semibold text-white/70 hover:bg-white/20 disabled:opacity-50 active:scale-95 transition-all"
        >
          No
        </button>
      </div>
    </div>
  )
}

// ── Tooltip wrapper ───────────────────────────────────────────────────────────
function Tooltip({ children, tip }: { children: React.ReactNode; tip: string }) {
  return (
    <div className="group relative w-full">
      {children}
      <div
        className="pointer-events-none absolute left-0 top-full mt-2 z-50 w-64 rounded-xl bg-black/80 backdrop-blur-sm border border-white/20 px-3 py-2 text-xs text-white/90 shadow-xl opacity-0 group-hover:opacity-100 transition-opacity duration-150"
        dangerouslySetInnerHTML={{ __html: tip }}
      />
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function DetailRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex gap-2 text-sm">
      <span className="text-white/40 w-10 shrink-0 text-xs mt-0.5">{label}</span>
      <span className={highlight ? 'text-amber-200 font-semibold' : 'text-white/90'}>{value}</span>
    </div>
  )
}

function getGreeting(tz: string): string {
  const h = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date())
  )
  if (h < 12) return 'morning'
  if (h < 17) return 'afternoon'
  return 'evening'
}
