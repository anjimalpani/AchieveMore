import { createClient } from '@supabase/supabase-js'

// Use the admin client to verify tokens — this handles algorithm and
// secret format automatically, and confirms the user exists in the DB.
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

export interface AuthPayload {
  sub: string
  email?: string
}

/**
 * Verify a Supabase access token by calling auth.getUser().
 * Throws if the token is invalid, expired, or the user doesn't exist.
 */
export async function verifyToken(token: string): Promise<AuthPayload> {
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) {
    throw new Error(error?.message ?? 'Invalid or expired token')
  }
  return { sub: user.id, email: user.email }
}
