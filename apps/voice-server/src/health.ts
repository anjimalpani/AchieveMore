import { getSessionCount } from './session'

export const VERSION = '1.0.0'

// Captured at module load time so uptime is accurate
const SERVER_START = Date.now()

export function buildHealthResponse(): {
  status: 'ok' | 'degraded'
  sessions: number
  uptime: number
  env: { openai: boolean; supabase: boolean; supabaseKey: boolean }
  version: string
} {
  const env = {
    openai:      !!process.env.OPENAI_API_KEY,
    supabase:    !!process.env.SUPABASE_URL,
    supabaseKey: !!process.env.SUPABASE_SERVICE_KEY,
  }
  const allEnvPresent = Object.values(env).every(Boolean)
  return {
    status:   allEnvPresent ? 'ok' : 'degraded',
    sessions: getSessionCount(),
    uptime:   Math.floor((Date.now() - SERVER_START) / 1000),
    env,
    version:  VERSION,
  }
}
