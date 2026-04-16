import { createServerSupabaseClient } from '@/lib/supabase-server'
import { NextResponse } from 'next/server'

export async function GET() {
  const supabase = await createServerSupabaseClient()
  const { data: { session } } = await supabase.auth.getSession()

  if (!session?.access_token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const voiceServerUrl = process.env.NEXT_PUBLIC_VOICE_SERVER_URL
    ?.replace('wss://', 'https://')
    .replace('ws://', 'http://')

  if (!voiceServerUrl) {
    return NextResponse.json({ error: 'Voice server not configured' }, { status: 500 })
  }

  // Redirect to voice server which initiates the Google OAuth flow
  const connectUrl = `${voiceServerUrl}/calendar/connect?token=${encodeURIComponent(session.access_token)}`
  return NextResponse.redirect(connectUrl)
}
