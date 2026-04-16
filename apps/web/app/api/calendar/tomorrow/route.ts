import { createServerSupabaseClient } from '@/lib/supabase-server'
import { NextResponse } from 'next/server'
import { google } from 'googleapis'
import OpenAI from 'openai'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

function getTomorrowRange(tz: string): { start: string; end: string; label: string } {
  const now = new Date()
  // Get today's date in the user's timezone
  const localDate = now.toLocaleDateString('en-CA', { timeZone: tz }) // "YYYY-MM-DD"
  const [y, m, d] = localDate.split('-').map(Number)

  // Tomorrow midnight → 23:59:59 in the user's tz expressed as UTC
  const noon = new Date(Date.UTC(y, m - 1, d + 1, 12, 0, 0))
  const fp = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(noon)
  const tzHour = parseInt(fp.find(p => p.type === 'hour')!.value)
  const tzMin  = parseInt(fp.find(p => p.type === 'minute')!.value)
  const offsetMs = ((tzHour - 12) * 60 + tzMin) * 60_000

  const startUTC = new Date(noon.getTime() - (12 * 60) * 60_000 - offsetMs)
  const endUTC   = new Date(startUTC.getTime() + 24 * 60 * 60_000 - 1000)

  const label = startUTC.toLocaleDateString('en-US', {
    timeZone: tz, weekday: 'long', month: 'long', day: 'numeric',
  })

  return { start: startUTC.toISOString(), end: endUTC.toISOString(), label }
}

export async function GET(request: Request) {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // ── Get stored tokens ────────────────────────────────────────────────────────
  const { data: prefs } = await supabase
    .from('user_preferences')
    .select('gcal_token, timezone')
    .eq('user_id', user.id)
    .single()

  if (!prefs?.gcal_token) {
    return NextResponse.json({ error: 'No calendar connected' }, { status: 404 })
  }

  // ── Determine timezone ───────────────────────────────────────────────────────
  const url = new URL(request.url)
  const tz = url.searchParams.get('tz') || prefs.timezone || 'America/New_York'

  // ── Build Google Calendar client ─────────────────────────────────────────────
  let tokenData: Record<string, string>
  try {
    tokenData = JSON.parse(prefs.gcal_token)
  } catch {
    return NextResponse.json({ error: 'Invalid token format' }, { status: 500 })
  }

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  )
  auth.setCredentials(tokenData)

  // ── Fetch tomorrow's events ──────────────────────────────────────────────────
  const { start, end, label: tomorrowLabel } = getTomorrowRange(tz)

  let events: { title: string; start: string; end: string; allDay: boolean }[] = []
  try {
    const calendar = google.calendar({ version: 'v3', auth })
    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: start,
      timeMax: end,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 20,
    })

    events = (res.data.items ?? []).map(ev => ({
      title: ev.summary ?? '(No title)',
      start: ev.start?.dateTime ?? ev.start?.date ?? start,
      end:   ev.end?.dateTime   ?? ev.end?.date   ?? end,
      allDay: !ev.start?.dateTime,
    }))
  } catch (err) {
    console.error('[/api/calendar/tomorrow] Google Calendar error:', err)
    return NextResponse.json({ error: 'Calendar fetch failed' }, { status: 502 })
  }

  // ── Generate summary with OpenAI ─────────────────────────────────────────────
  let summary: string | null = null

  if (events.length > 0) {
    const eventList = events.map(ev => {
      if (ev.allDay) return `- ${ev.title} (all day)`
      const startLocal = new Date(ev.start).toLocaleTimeString('en-US', {
        timeZone: tz, hour: 'numeric', minute: '2-digit',
      })
      return `- ${ev.title} at ${startLocal}`
    }).join('\n')

    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a warm, concise personal assistant. Write a 2-3 sentence summary of the user's schedule for ${tomorrowLabel}. Mention specific event names and times. Keep it friendly and natural — like a helpful colleague giving a quick heads-up. Do not use bullet points.`,
          },
          {
            role: 'user',
            content: `My schedule for ${tomorrowLabel}:\n${eventList}`,
          },
        ],
        max_tokens: 120,
        temperature: 0.7,
      })
      summary = completion.choices[0]?.message?.content ?? null
    } catch (err) {
      console.error('[/api/calendar/tomorrow] OpenAI error:', err)
      // Return events without summary rather than failing
    }
  }

  return NextResponse.json({ summary, tomorrowLabel, events })
}
