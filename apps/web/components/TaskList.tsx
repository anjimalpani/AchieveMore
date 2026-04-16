'use client'

export interface Task {
  id: string
  title: string
  type: 'task' | 'event' | 'reminder'
  due_at: string | null
  status: 'pending' | 'done' | 'cancelled'
}

interface TaskListProps {
  tasks: Task[]
  timezone?: string
  onDelete?: (id: string) => void
  /** callIds of tasks currently awaiting confirmation — shown with a "not saved yet" note */
  pendingCallIds?: string[]
}

const TYPE_ICON: Record<Task['type'], string> = {
  task: '✅',
  event: '📅',
  reminder: '🔔',
}

function formatTime(iso: string | null, tz?: string): string {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Deduplicate tasks: keep only the first occurrence of each title+day pair */
function deduplicate(tasks: Task[], tz?: string): Task[] {
  const seen = new Set<string>()
  return tasks.filter(t => {
    const dayKey = t.due_at
      ? new Date(t.due_at).toLocaleDateString('en-CA', { timeZone: tz })
      : 'nodate'
    const key = `${t.title.trim().toLowerCase()}|${dayKey}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export default function TaskList({ tasks, timezone, onDelete, pendingCallIds }: TaskListProps) {
  const pending = deduplicate(
    tasks.filter(t => t.status === 'pending'),
    timezone,
  )

  const hasPendingConfirmations = (pendingCallIds?.length ?? 0) > 0

  if (pending.length === 0) {
    return (
      <div className="rounded-xl bg-black/20 border border-white/10 px-4 py-5 text-center">
        <p className="text-white/40 text-xs leading-relaxed">
          Tasks and events appear here as you speak.<br />
          Review below and tap <span className="font-semibold text-white/60">Confirm</span> to save them.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <ul className="space-y-2" role="list" aria-label="Captured tasks and events">
        {pending.map(task => (
          <li
            key={task.id}
            className="group flex items-center gap-3 rounded-xl bg-black/30 backdrop-blur-sm px-3 py-2.5 border border-white/10"
          >
            <span className="text-base shrink-0">{TYPE_ICON[task.type]}</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-white/90 truncate">{task.title}</p>
              {task.due_at && (
                <p className="text-xs text-white/40 mt-0.5">{formatTime(task.due_at, timezone)}</p>
              )}
            </div>
            {onDelete && (
              <button
                onClick={() => onDelete(task.id)}
                className="shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 text-white/30 hover:text-red-400 transition-all rounded-lg p-1"
                aria-label={`Delete ${task.title}`}
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                  <path fillRule="evenodd" d="M5 3.25V4H2.75a.75.75 0 0 0 0 1.5h.3l.815 8.15A1.5 1.5 0 0 0 5.357 15h5.285a1.5 1.5 0 0 0 1.493-1.35l.815-8.15h.3a.75.75 0 0 0 0-1.5H11v-.75A2.25 2.25 0 0 0 8.75 1h-1.5A2.25 2.25 0 0 0 5 3.25Zm2.25-.75a.75.75 0 0 0-.75.75V4h3v-.75a.75.75 0 0 0-.75-.75h-1.5ZM6.05 6a.75.75 0 0 1 .787.713l.275 5.5a.75.75 0 0 1-1.498.075l-.275-5.5A.75.75 0 0 1 6.05 6Zm3.9 0a.75.75 0 0 1 .712.787l-.275 5.5a.75.75 0 0 1-1.498-.075l.275-5.5a.75.75 0 0 1 .786-.711Z" clipRule="evenodd" />
                </svg>
              </button>
            )}
          </li>
        ))}
      </ul>
      {hasPendingConfirmations && (
        <p className="text-[11px] text-amber-400/60 text-center px-2 leading-snug">
          Not saved yet &mdash; confirm below to add to your list.
        </p>
      )}
    </div>
  )
}
