import { google } from 'googleapis'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

interface StoredTokens {
  access_token: string
  refresh_token: string
  expiry_date: number
  scope?: string          // space-separated granted scopes, stored on auth-code exchange
}

const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks'

export interface CalendarEvent {
  id: string
  title: string
  start: string   // ISO datetime or date
  end: string
  allDay: boolean
}

export interface GoogleTask {
  id: string
  title: string
  due: string | null    // ISO date string (date portion only)
  notes: string | null
  status: 'needsAction' | 'completed'
}

// ── OAuth client factory ──────────────────────────────────────────────────────
function makeOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  )
}

// ── Load stored tokens for a user ─────────────────────────────────────────────
async function loadTokens(userId: string): Promise<StoredTokens | null> {
  const { data, error } = await supabase
    .from('user_preferences')
    .select('gcal_token')
    .eq('user_id', userId)
    .single()

  if (error || !data?.gcal_token) return null

  try {
    return JSON.parse(data.gcal_token) as StoredTokens
  } catch {
    return null
  }
}

// ── Persist refreshed tokens back to DB ───────────────────────────────────────
async function saveTokens(userId: string, tokens: StoredTokens): Promise<void> {
  await supabase
    .from('user_preferences')
    .upsert(
      { user_id: userId, gcal_token: JSON.stringify(tokens), updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    )
}

// ── Build an authenticated OAuth2 client, auto-refreshing if needed ───────────
async function getAuthClient(userId: string): Promise<InstanceType<typeof google.auth.OAuth2> | null> {
  const tokens = await loadTokens(userId)
  if (!tokens) return null

  const oauth2 = makeOAuthClient()
  oauth2.setCredentials(tokens)

  if (tokens.expiry_date && tokens.expiry_date - Date.now() < 60_000) {
    try {
      const { credentials } = await oauth2.refreshAccessToken()
      const refreshed: StoredTokens = {
        access_token:  credentials.access_token!,
        refresh_token: credentials.refresh_token ?? tokens.refresh_token,
        expiry_date:   credentials.expiry_date ?? Date.now() + 3_600_000,
      }
      await saveTokens(userId, refreshed)
      oauth2.setCredentials(refreshed)
    } catch (err) {
      console.error(`[calendar] Token refresh failed for ${userId}:`, err)
      return null
    }
  }

  return oauth2
}

// ── Calendar client ───────────────────────────────────────────────────────────
async function getCalendarClient(userId: string) {
  const auth = await getAuthClient(userId)
  return auth ? google.calendar({ version: 'v3', auth }) : null
}

// ── Tasks client ──────────────────────────────────────────────────────────────
async function getTasksClient(userId: string) {
  const auth = await getAuthClient(userId)
  return auth ? google.tasks({ version: 'v1', auth }) : null
}

// ── Read today + tomorrow's calendar events ───────────────────────────────────
export async function getUpcomingEvents(userId: string): Promise<CalendarEvent[]> {
  const cal = await getCalendarClient(userId)
  if (!cal) return []

  const now = new Date()
  const twoDaysLater = new Date(now.getTime() + 2 * 86_400_000)

  try {
    const res = await cal.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: twoDaysLater.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 20,
    })

    return (res.data.items ?? []).map(e => ({
      id:     e.id ?? '',
      title:  e.summary ?? '(no title)',
      start:  e.start?.dateTime ?? e.start?.date ?? '',
      end:    e.end?.dateTime ?? e.end?.date ?? '',
      allDay: !e.start?.dateTime,
    }))
  } catch (err) {
    console.error(`[calendar] Failed to list events for ${userId}:`, err)
    return []
  }
}

// ── Create a calendar event ───────────────────────────────────────────────────
export async function createCalendarEvent(
  userId: string,
  title: string,
  dueAt: string,
  notes?: string
): Promise<string | null> {
  const cal = await getCalendarClient(userId)
  if (!cal) return null

  const start = new Date(dueAt)
  const end   = new Date(start.getTime() + 60 * 60_000) // 1 hour default

  try {
    const res = await cal.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: title,
        description: notes,
        start: { dateTime: start.toISOString() },
        end:   { dateTime: end.toISOString() },
      },
    })
    return res.data.id ?? null
  } catch (err) {
    console.error(`[calendar] Failed to create event for ${userId}:`, err)
    return null
  }
}

// ── Fetch Google Tasks (default list, incomplete tasks, next 7 days) ──────────
export async function getGoogleTasks(userId: string): Promise<GoogleTask[]> {
  if (!await hasTasksScope(userId)) return []   // skip API call if scope not granted
  const tasks = await getTasksClient(userId)
  if (!tasks) return []

  try {
    const now = new Date()
    const sevenDaysLater = new Date(now.getTime() + 7 * 86_400_000)

    const res = await tasks.tasks.list({
      tasklist: '@default',
      showCompleted: false,
      showHidden: false,
      dueMax: sevenDaysLater.toISOString(),
      maxResults: 30,
    })

    return (res.data.items ?? [])
      .filter(t => t.status !== 'completed')
      .map(t => ({
        id:     t.id ?? '',
        title:  t.title ?? '(no title)',
        due:    t.due ?? null,
        notes:  t.notes ?? null,
        status: (t.status ?? 'needsAction') as 'needsAction' | 'completed',
      }))
  } catch (err) {
    // Scope not granted yet — fail silently so existing sessions still work
    console.warn(`[tasks] Could not fetch Google Tasks for ${userId} (may need re-auth):`, (err as Error).message)
    return []
  }
}

// ── Create a Google Task in the default list ──────────────────────────────────
export async function createGoogleTask(
  userId: string,
  title: string,
  dueAt?: string,   // ISO datetime — we extract the date portion
  notes?: string
): Promise<string | null> {
  if (!await hasTasksScope(userId)) return null   // scope not granted yet
  const tasks = await getTasksClient(userId)
  if (!tasks) return null

  // Google Tasks API requires due as an RFC 3339 timestamp (date portion only, midnight UTC)
  let dueDate: string | undefined
  if (dueAt) {
    const d = new Date(dueAt)
    dueDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T00:00:00.000Z`
  }

  try {
    const res = await tasks.tasks.insert({
      tasklist: '@default',
      requestBody: {
        title,
        notes,
        ...(dueDate ? { due: dueDate } : {}),
      },
    })
    console.log(`[tasks] Created Google Task "${title}" (id: ${res.data.id}) for user ${userId}`)
    return res.data.id ?? null
  } catch (err) {
    console.error(`[tasks] Failed to create task for ${userId}:`, err)
    return null
  }
}

// ── Exchange auth code for tokens and store ───────────────────────────────────
export async function exchangeAndStoreTokens(userId: string, code: string): Promise<void> {
  const oauth2 = makeOAuthClient()
  const { tokens } = await oauth2.getToken(code)

  const stored: StoredTokens = {
    access_token:  tokens.access_token!,
    refresh_token: tokens.refresh_token!,
    expiry_date:   tokens.expiry_date ?? Date.now() + 3_600_000,
    scope:         tokens.scope ?? undefined,   // persist granted scopes
  }

  await saveTokens(userId, stored)
  console.log(`[calendar] Stored tokens for ${userId}, scopes: ${stored.scope ?? 'unknown'}`)
}

// ── Check whether the stored token includes the Tasks scope ──────────────────
export async function hasTasksScope(userId: string): Promise<boolean> {
  const tokens = await loadTokens(userId)
  if (!tokens) return false
  // Old tokens (before scope was stored) have no scope field → needs reauth
  if (!tokens.scope) return false
  return tokens.scope.includes(TASKS_SCOPE)
}

// ── Generate the OAuth consent URL (Calendar + Tasks scopes) ─────────────────
export function getOAuthUrl(): string {
  const oauth2 = makeOAuthClient()
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',   // always get refresh_token
    scope: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/tasks',
    ],
  })
}
