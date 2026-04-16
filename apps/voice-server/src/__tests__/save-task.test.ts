/**
 * Tests for the save_task function call handler.
 *
 * Architecture note: save_task in the voice server does NOT directly write to
 * Supabase. It queues a pending confirmation card in the browser UI. The
 * actual DB insert happens in useVoiceSession.ts (confirmTask) on the frontend
 * when the user taps "Yes, save it". These tests verify the voice server's
 * half of that contract.
 */

import { WebSocket } from 'ws'
import { handleFunctionCall } from '../actions'
import type { UserSession } from '../session'

// ── Mock external dependencies ────────────────────────────────────────────────
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => ({
      update: jest.fn(() => ({ eq: jest.fn(() => ({ eq: jest.fn(() => Promise.resolve({ error: null })) })) })),
    })),
  })),
}))

jest.mock('../realtime', () => ({
  sendFunctionResult: jest.fn(),
}))

jest.mock('../calendar', () => ({
  createCalendarEvent: jest.fn(),
  createGoogleTask: jest.fn(),
}))

const { sendFunctionResult } = jest.requireMock('../realtime') as { sendFunctionResult: jest.Mock }

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSession(overrides?: Partial<UserSession>): UserSession {
  const wsMock = { readyState: WebSocket.OPEN, send: jest.fn() } as unknown as WebSocket
  return {
    sessionId: 'test-session',
    userId: 'user-123',
    ws: wsMock,
    rtWs: null,
    context: {
      userId: 'user-123',
      name: 'Test User',
      email: 'test@example.com',
      timezone: 'America/New_York',
      utcOffset: '-05:00',
      wakeTime: '07:00',
      briefStyle: 'concise',
      voiceId: 'alloy',
      today: 'Monday, April 21, 2025',
      todayEvents: [],
      upcomingTasks: [],
      calendarEvents: [],
      googleTasks: [],
      hasCalendar: false,
      hasGoogleTasks: false,
      needsTasksReauth: false,
    },
    state: 'idle',
    startedAt: Date.now(),
    silenceTimer: null,
    saveCallsByResponse: new Map(),
    ...overrides,
  }
}

function makeRt(): WebSocket {
  return { readyState: WebSocket.OPEN, send: jest.fn() } as unknown as WebSocket
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('save_task handler', () => {
  beforeEach(() => jest.clearAllMocks())

  it('sends task.pending_confirmation to browser with correct fields', async () => {
    const session = makeSession()
    const rt = makeRt()

    await handleFunctionCall(session, rt, 'save_task', {
      title: 'Prep Jordan pitch deck',
      type: 'task',
      due_at: '2025-04-18T14:00:00-04:00',
      notes: 'Include Q1 financials',
    }, 'call-1', 'resp-1')

    const sentMsg = JSON.parse((session.ws.send as jest.Mock).mock.calls[0][0])
    expect(sentMsg.type).toBe('task.pending_confirmation')
    expect(sentMsg.task.title).toBe('Prep Jordan pitch deck')
    expect(sentMsg.task.due_at).toBe('2025-04-18T14:00:00-04:00')
    expect(sentMsg.callId).toBe('call-1')
  })

  it('sends success function result to the Realtime API', async () => {
    const session = makeSession()
    const rt = makeRt()

    await handleFunctionCall(session, rt, 'save_task', {
      title: 'Call dentist',
      type: 'task',
    }, 'call-2', 'resp-2')

    expect(sendFunctionResult).toHaveBeenCalledWith(rt, 'call-2', expect.objectContaining({ success: true }))
  })

  it('task type defaults to "task" when not provided', async () => {
    const session = makeSession()
    const rt = makeRt()

    await handleFunctionCall(session, rt, 'save_task', { title: 'Buy milk' }, 'call-3', 'resp-3')

    const sentMsg = JSON.parse((session.ws.send as jest.Mock).mock.calls[0][0])
    expect(sentMsg.task.type).toBe('task')
  })

  it('does NOT write to Supabase (save is deferred to user confirmation)', async () => {
    const { createClient } = jest.requireMock('@supabase/supabase-js') as { createClient: jest.Mock }
    const session = makeSession()
    const rt = makeRt()

    await handleFunctionCall(session, rt, 'save_task', { title: 'Go for a run', type: 'task' }, 'call-4', 'resp-4')

    // The module-level supabase client in actions.ts is created at import time,
    // not via createClient() during the call — so createClient mock calls = 0.
    expect(createClient).not.toHaveBeenCalled()
  })

  it('records this response_id in saveCallsByResponse mutex map', async () => {
    const session = makeSession()
    const rt = makeRt()

    await handleFunctionCall(session, rt, 'save_task', { title: 'Test task', type: 'task' }, 'call-5', 'resp-mutex')

    expect(session.saveCallsByResponse.get('resp-mutex')).toBe('task')
  })

  it('is blocked when save_calendar_event already fired for the same response', async () => {
    const session = makeSession()
    session.saveCallsByResponse.set('resp-x', 'calendar')  // calendar already claimed
    const rt = makeRt()

    await handleFunctionCall(session, rt, 'save_task', { title: 'Test task', type: 'task' }, 'call-6', 'resp-x')

    // Browser should NOT receive a pending_confirmation
    expect((session.ws.send as jest.Mock)).not.toHaveBeenCalled()
    // Agent should get a blocked result
    expect(sendFunctionResult).toHaveBeenCalledWith(rt, 'call-6', expect.objectContaining({ success: false }))
  })

  it('handles missing due_at gracefully (no date task)', async () => {
    const session = makeSession()
    const rt = makeRt()

    await handleFunctionCall(session, rt, 'save_task', { title: 'Vague task', type: 'task' }, 'call-7', 'resp-7')

    const sentMsg = JSON.parse((session.ws.send as jest.Mock).mock.calls[0][0])
    expect(sentMsg.task.due_at ?? null).toBeNull()
    expect(sendFunctionResult).toHaveBeenCalledWith(rt, 'call-7', expect.objectContaining({ success: true }))
  })
})
