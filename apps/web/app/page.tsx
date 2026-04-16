import { redirect } from 'next/navigation'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import MainScreen from '@/components/MainScreen'

export default async function HomePage() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const userName = user.user_metadata?.full_name ?? user.email ?? 'there'

  // Check if the user has connected Google Calendar
  const { data: prefs } = await supabase
    .from('user_preferences')
    .select('gcal_token, timezone, gcal_email')
    .eq('user_id', user.id)
    .single()

  const hasCalendar   = !!prefs?.gcal_token
  const userTimezone  = prefs?.timezone  ?? 'America/New_York'
  const calendarEmail = prefs?.gcal_email ?? null

  // Detect whether the stored token includes the Tasks scope.
  // Old tokens (stored before Tasks scope was added) won't have a `scope` field.
  let needsTasksReauth = false
  if (hasCalendar && prefs?.gcal_token) {
    try {
      const stored = JSON.parse(prefs.gcal_token) as { scope?: string }
      needsTasksReauth = !stored.scope?.includes('https://www.googleapis.com/auth/tasks')
    } catch {
      needsTasksReauth = true   // malformed token → prompt reauth
    }
  }

  return (
    <MainScreen
      userName={userName}
      hasCalendar={hasCalendar}
      userTimezone={userTimezone}
      calendarEmail={calendarEmail}
      needsTasksReauth={needsTasksReauth}
    />
  )
}
