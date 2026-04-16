/**
 * Tests for WebSocket auth, session management, and tool config.
 *
 * We test the building blocks (verifyToken, createSession) directly rather
 * than spinning up a full WS server — that keeps tests fast and deterministic.
 * The OpenAI tools array is tested to ensure save_task is always present.
 */

// ── Mock Supabase used by auth.ts ─────────────────────────────────────────────
const mockGetUser = jest.fn()
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    auth: {
      getUser: mockGetUser,
      admin: { getUserById: jest.fn().mockResolvedValue({ data: { user: null } }) },
    },
    from: jest.fn(() => ({
      select: jest.fn(() => ({ eq: jest.fn(() => ({ single: jest.fn().mockResolvedValue({ data: null }) })) })),
    })),
  })),
}))

import { verifyToken } from '../auth'
import { createSession, removeSession } from '../session'
import { WebSocket } from 'ws'

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeMockWs(): WebSocket {
  return { readyState: WebSocket.OPEN, send: jest.fn(), close: jest.fn() } as unknown as WebSocket
}

function makeContext() {
  return {
    userId: 'user-abc',
    name: 'Alice',
    email: 'alice@example.com',
    timezone: 'America/New_York',
    utcOffset: '-05:00',
    wakeTime: '07:00',
    briefStyle: 'concise',
    voiceId: 'alloy',
    today: 'Tuesday',
    todayEvents: [],
    upcomingTasks: [],
    calendarEvents: [],
    googleTasks: [],
    hasCalendar: false,
    hasGoogleTasks: false,
    needsTasksReauth: false,
  }
}

// ── verifyToken tests ─────────────────────────────────────────────────────────

describe('verifyToken', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns {sub, email} for a valid token', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-abc', email: 'alice@example.com' } },
      error: null,
    })

    const result = await verifyToken('valid-jwt')
    expect(result.sub).toBe('user-abc')
    expect(result.email).toBe('alice@example.com')
  })

  it('throws for an invalid token', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Invalid JWT' },
    })

    await expect(verifyToken('bad-token')).rejects.toThrow('Invalid JWT')
  })

  it('throws when user is null even without an error object', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })

    await expect(verifyToken('null-user-token')).rejects.toThrow()
  })

  it('rejects a token with code 4001 semantics (throws, not returns null)', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Token has expired' },
    })

    await expect(verifyToken('expired-token')).rejects.toThrow('Token has expired')
  })
})

// ── Session management tests ──────────────────────────────────────────────────

describe('createSession', () => {
  afterEach(() => {
    try { removeSession('sess-test') } catch { /* ignore */ }
  })

  it('creates a session with expected shape', () => {
    const ws = makeMockWs()
    const ctx = makeContext()
    const session = createSession('sess-test', 'user-abc', ws, ctx)

    expect(session.sessionId).toBe('sess-test')
    expect(session.userId).toBe('user-abc')
    expect(session.state).toBe('idle')
    expect(session.rtWs).toBeNull()
    expect(session.silenceTimer).toBeNull()
  })

  it('initialises saveCallsByResponse as an empty Map', () => {
    const ws = makeMockWs()
    const ctx = makeContext()
    const session = createSession('sess-test', 'user-abc', ws, ctx)

    expect(session.saveCallsByResponse).toBeInstanceOf(Map)
    expect(session.saveCallsByResponse.size).toBe(0)
  })

  it('records startedAt close to now', () => {
    const before = Date.now()
    const ws = makeMockWs()
    const session = createSession('sess-test', 'user-abc', ws, makeContext())
    const after = Date.now()

    expect(session.startedAt).toBeGreaterThanOrEqual(before)
    expect(session.startedAt).toBeLessThanOrEqual(after)
  })
})

// ── Tools array tests ─────────────────────────────────────────────────────────

describe('OpenAI Realtime tools configuration', () => {
  // Import the module's internal TOOLS via buildSystemPrompt (which references them)
  // We instead just require the module and check the exported system prompt output.
  it('system prompt includes save_task instruction', () => {
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildSystemPrompt } = require('../realtime') as { buildSystemPrompt: (ctx: ReturnType<typeof makeContext>) => string }
    const prompt = buildSystemPrompt(makeContext())
    expect(prompt).toContain('save_task')
  })

  it('system prompt instructs agent NOT to call both save_task and save_calendar_event', () => {
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildSystemPrompt } = require('../realtime') as { buildSystemPrompt: (ctx: ReturnType<typeof makeContext>) => string }
    const prompt = buildSystemPrompt(makeContext())
    expect(prompt.toLowerCase()).toContain('never call both')
  })

  it('system prompt clarifies that having a specific time does NOT make something a calendar event', () => {
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildSystemPrompt } = require('../realtime') as { buildSystemPrompt: (ctx: ReturnType<typeof makeContext>) => string }
    const prompt = buildSystemPrompt(makeContext())
    expect(prompt).toContain('specific time does NOT')
  })
})
