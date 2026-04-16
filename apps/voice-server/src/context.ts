import { createClient } from '@supabase/supabase-js'
import { getUpcomingEvents, getGoogleTasks, hasTasksScope, type CalendarEvent, type GoogleTask } from './calendar'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

export interface UserContext {
  userId: string
  name: string
  email: string
  timezone: string
  utcOffset: string        // e.g. "-05:00" for EST
  wakeTime: string
  briefStyle: string
  voiceId: string
  today: string
  todayEvents: { time: string; title: string }[]
  upcomingTasks: { dueAt: string; title: string; type: string }[]
  calendarEvents: CalendarEvent[]
  googleTasks: GoogleTask[]
  hasCalendar: boolean
  hasGoogleTasks: boolean
  needsTasksReauth: boolean   // true when Calendar is connected but Tasks scope missing
}

/** Returns the UTC offset string for a timezone at a given moment, e.g. "-05:00" */
function getUtcOffsetString(tz: string, date: Date): string {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'shortOffset',
    // need at least one date field for formatToParts to work
    year: 'numeric',
  })
  const parts = f.formatToParts(date)
  const offsetPart = parts.find(p => p.type === 'timeZoneName')?.value ?? 'GMT+0'
  // offsetPart looks like "GMT-5" or "GMT+5:30"
  const match = offsetPart.match(/GMT([+-])(\d+)(?::(\d+))?/)
  if (!match) return '+00:00'
  const sign  = match[1]
  const hours = match[2].padStart(2, '0')
  const mins  = (match[3] ?? '00').padStart(2, '0')
  return `${sign}${hours}:${mins}`
}

/**
 * Returns the UTC moment that is midnight on (today + daysOffset) in the given timezone.
 * Uses noon UTC on the target day as a reference to handle DST safely.
 */
function startOfDayUTC(tz: string, daysOffset = 0): string {
  const now = new Date()
  // Get today as YYYY-MM-DD in user's tz
  const localDate = now.toLocaleDateString('en-CA', { timeZone: tz }) // "2024-01-15"
  const [y, m, d] = localDate.split('-').map(Number)
  // Noon UTC on the target date
  const noon = new Date(Date.UTC(y, m - 1, d + daysOffset, 12, 0, 0))
  // What hour+minute does noon UTC show as in user's tz?
  const fp = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(noon)
  const tzHour = parseInt(fp.find(p => p.type === 'hour')!.value)
  const tzMin  = parseInt(fp.find(p => p.type === 'minute')!.value)
  // UTC offset in minutes  (positive = ahead of UTC)
  const offsetMin = (tzHour - 12) * 60 + tzMin
  // Midnight in user's tz = noon UTC shifted back by (12h + offset)
  return new Date(noon.getTime() - (12 * 60 + offsetMin) * 60_000).toISOString()
}

export async function loadUserContext(userId: string, browserTz?: string): Promise<UserContext> {
  const [prefsResult, tasksResult, calendarEvents, googleTasks, tasksScope] = await Promise.all([
    supabase.from('user_preferences').select('*').eq('user_id', userId).single(),
    supabase
      .from('tasks').select('title, type, due_at')
      .eq('user_id', userId).eq('status', 'pending')
      .gte('due_at', new Date(Date.now() - 86400000).toISOString())
      .order('due_at', { ascending: true }).limit(20),
    getUpcomingEvents(userId),
    getGoogleTasks(userId),
    hasTasksScope(userId),
  ])

  const prefs = prefsResult.data ?? {}
  const tasks = tasksResult.data ?? []

  const tz: string = browserTz || prefs.timezone || 'America/New_York'
  const now = new Date()

  const todayStart    = startOfDayUTC(tz, 0)
  const tomorrowStart = startOfDayUTC(tz, 1)
  const utcOffset     = getUtcOffsetString(tz, now)

  // "Today is ..." label entirely in user's timezone
  const todayLabel = now.toLocaleDateString('en-US', {
    timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  })

  // Merge DB tasks + Google Calendar events for today
  const todayTaskEvents = tasks
    .filter(t => t.due_at && t.due_at >= todayStart && t.due_at < tomorrowStart)
    .map(t => ({
      time: new Date(t.due_at!).toLocaleTimeString('en-US', {
        timeZone: tz, hour: '2-digit', minute: '2-digit',
      }),
      title: t.title,
    }))

  const todayCalEvents = calendarEvents
    .filter(e => !e.allDay && e.start >= todayStart && e.start < tomorrowStart)
    .map(e => ({
      time: new Date(e.start).toLocaleTimeString('en-US', {
        timeZone: tz, hour: '2-digit', minute: '2-digit',
      }),
      title: `[Cal] ${e.title}`,
    }))

  const todayEvents = [...todayCalEvents, ...todayTaskEvents]
    .sort((a, b) => a.time.localeCompare(b.time))

  const upcomingTasks = tasks
    .filter(t => !t.due_at || t.due_at >= tomorrowStart)
    .map(t => ({
      dueAt: t.due_at
        ? new Date(t.due_at).toLocaleDateString('en-US', {
            timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
          })
        : 'No date',
      title: t.title,
      type:  t.type,
    }))

  const { data: userData } = await supabase.auth.admin.getUserById(userId)
  const name  = userData?.user?.user_metadata?.full_name ?? userData?.user?.email ?? 'there'
  const email = userData?.user?.email ?? ''

  return {
    userId, name, email,
    timezone: tz,
    utcOffset,
    wakeTime:   prefs.wake_time   ?? '07:00',
    briefStyle: prefs.brief_style ?? 'concise',
    voiceId:    prefs.voice_id    ?? 'alloy',
    today: `${todayLabel}`,
    todayEvents,
    upcomingTasks,
    calendarEvents,
    googleTasks,
    hasCalendar:      calendarEvents.length > 0 || !!prefs.gcal_token,
    hasGoogleTasks:   googleTasks.length > 0,
    needsTasksReauth: !!prefs.gcal_token && !tasksScope,
  }
}
