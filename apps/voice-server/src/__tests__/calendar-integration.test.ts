/**
 * Tests for the save_task / save_calendar_event mutual exclusion (mutex).
 *
 * The mutex ensures the agent can never create both a Supabase task AND a
 * Google Calendar event for the same user utterance in the same response turn.
 * This is enforced server-side via saveCallsByResponse (keyed by response_id).
 */

import { WebSocket } from 'ws'
import { handleFunctionCall } from '../actions'
import type { UserSession } from '../session'

// ── Mock dependencies ─────────────────────────────────────────────────────────
// NOTE: jest.mock factories are hoisted — cannot reference variables defined
// in module scope. Use jest.fn() directly inside the factory.

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => ({
      update: jest.fn(() => ({ eq: jest.fn(() => ({ eq: jest.fn(() => Promise.resolve({ error: null })) })) })),
    })),
  })),
}))

jest.mock('../realtime', () => ({ sendFunctionResult: jest.fn() }))

jest.mock('../calendar', () => ({
  createCalendarEvent: jest.fn(),
  createGoogleTask: jest.fn(),
}))

const { sendFunctionResult } = jest.requireMock('../realtime') as { sendFunctionResult: jest.Mock }
const mockCreateCalendarEvent = jest.requireMock('../calendar').createCalendarEvent as jest.Mock

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSession(hasCalendar = true): UserSession {
  const ws = { readyState: WebSocket.OPEN, send: jest.fn() } as unknown as WebSocket
  return {
    sessionId: 'test-session',
    userId: 'user-123',
    ws,
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
      today: 'Monday',
      todayEvents: [],
      upcomingTasks: [],
      calendarEvents: [],
      googleTasks: [],
      hasCalendar,
      hasGoogleTasks: false,
      needsTasksReauth: false,
    },
    state: 'idle',
    startedAt: Date.now(),
    silenceTimer: null,
    saveCallsByResponse: new Map(),
  }
}

function makeRt(): WebSocket {
  return { readyState: WebSocket.OPEN, send: jest.fn() } as unknown as WebSocket
}

// ── Mutex tests ───────────────────────────────────────────────────────────────

describe('save_task / save_calendar_event mutex', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCreateCalendarEvent.mockResolvedValue('gcal-event-id')
  })

  it('save_calendar_event is BLOCKED when save_task already fired in the same response', async () => {
    const session = makeSession()
    const rt = makeRt()

    // save_task fires first
    await handleFunctionCall(session, rt, 'save_task',
      { title: 'Add gym tomorrow at 7am', type: 'task' }, 'call-task', 'resp-A')

    // save_calendar_event fires second in the same response turn
    await handleFunctionCall(session, rt, 'save_calendar_event',
      { title: 'Add gym tomorrow at 7am', due_at: '2025-04-22T07:00:00-04:00' }, 'call-cal', 'resp-A')

    // Calendar event must NOT have been created
    expect(mockCreateCalendarEvent).not.toHaveBeenCalled()

    // The blocked result must be communicated back to the agent
    expect(sendFunctionResult).toHaveBeenCalledWith(rt, 'call-cal',
      expect.objectContaining({ success: false, message: expect.stringContaining('Blocked') }))
  })

  it('save_task is BLOCKED when save_calendar_event already fired in the same response', async () => {
    const session = makeSession()
    session.saveCallsByResponse.set('resp-B', 'calendar')  // pre-populate: calendar already claimed
    const rt = makeRt()

    await handleFunctionCall(session, rt, 'save_task',
      { title: 'Some task', type: 'task' }, 'call-task2', 'resp-B')

    // Browser should NOT receive a pending_confirmation
    expect((session.ws.send as jest.Mock)).not.toHaveBeenCalled()
    expect(sendFunctionResult).toHaveBeenCalledWith(rt, 'call-task2',
      expect.objectContaining({ success: false }))
  })

  it('save_task and save_calendar_event can both succeed in DIFFERENT response turns', async () => {
    const session = makeSession()
    const rt = makeRt()

    // Different response IDs = different turns
    await handleFunctionCall(session, rt, 'save_task',
      { title: 'Call mum', type: 'task' }, 'call-t', 'resp-turn-1')

    await handleFunctionCall(session, rt, 'save_calendar_event',
      { title: 'Meeting with boss', due_at: '2025-04-22T10:00:00-04:00' }, 'call-c', 'resp-turn-2')

    expect(mockCreateCalendarEvent).toHaveBeenCalledWith('user-123', 'Meeting with boss', '2025-04-22T10:00:00-04:00', undefined)
    expect(sendFunctionResult).toHaveBeenCalledWith(rt, 'call-c', expect.objectContaining({ success: true }))
  })

  it('save_calendar_event returns failure when calendar is not connected', async () => {
    const session = makeSession(false)  // hasCalendar = false
    const rt = makeRt()

    await handleFunctionCall(session, rt, 'save_calendar_event',
      { title: 'Meeting', due_at: '2025-04-22T10:00:00-04:00' }, 'call-nc', 'resp-nc')

    expect(mockCreateCalendarEvent).not.toHaveBeenCalled()
    expect(sendFunctionResult).toHaveBeenCalledWith(rt, 'call-nc',
      expect.objectContaining({ success: false, message: expect.stringContaining('not connected') }))
  })

  it('save_calendar_event requires due_at — returns failure if missing', async () => {
    const session = makeSession()
    const rt = makeRt()

    // due_at is missing
    await handleFunctionCall(session, rt, 'save_calendar_event',
      { title: 'Dentist' }, 'call-nodate', 'resp-nodate')

    expect(mockCreateCalendarEvent).not.toHaveBeenCalled()
    expect(sendFunctionResult).toHaveBeenCalledWith(rt, 'call-nodate',
      expect.objectContaining({ success: false }))
  })

  it('mutex map is not consulted when responseId is empty string', async () => {
    const session = makeSession()
    session.saveCallsByResponse.set('', 'calendar')  // empty string key — should not block
    const rt = makeRt()

    // No responseId provided
    await handleFunctionCall(session, rt, 'save_task',
      { title: 'No response id task', type: 'task' }, 'call-noid')

    // Should succeed because responseId defaults to '' and we skip the mutex
    const sentMsg = JSON.parse((session.ws.send as jest.Mock).mock.calls[0][0])
    expect(sentMsg.type).toBe('task.pending_confirmation')
  })
})

// ── Phrase-routing sanity tests (system prompt level) ─────────────────────────
// These don't test AI behaviour but verify the handler correctly processes
// the two distinct function names so a well-prompted model routes correctly.

describe('handler routes save_task vs save_calendar_event correctly by name', () => {
  beforeEach(() => jest.clearAllMocks())

  const TASK_PHRASES = ['add gym tomorrow at 7am', 'remind me to call mum at 3pm', 'buy milk', 'read chapter 5']
  const CALENDAR_PHRASES = ['schedule a meeting with John', 'book a call with the team', 'add to my calendar', 'set up a video call']

  test.each(TASK_PHRASES)(
    'regular task phrase "%s" → save_task handler fires (NOT save_calendar_event)',
    async (phrase) => {
      const session = makeSession()
      const rt = makeRt()
      mockCreateCalendarEvent.mockClear()

      await handleFunctionCall(session, rt, 'save_task',
        { title: phrase, type: 'task' }, `call-${phrase}`, `resp-${phrase}`)

      expect(mockCreateCalendarEvent).not.toHaveBeenCalled()
      const sentMsg = JSON.parse((session.ws.send as jest.Mock).mock.calls[0][0])
      expect(sentMsg.type).toBe('task.pending_confirmation')
    }
  )

  test.each(CALENDAR_PHRASES)(
    'calendar phrase "%s" → save_calendar_event handler fires (creates GCal event)',
    async (phrase) => {
      const session = makeSession()
      const rt = makeRt()
      mockCreateCalendarEvent.mockResolvedValue('gcal-id')

      await handleFunctionCall(session, rt, 'save_calendar_event',
        { title: phrase, due_at: '2025-04-22T10:00:00-04:00' }, `call-${phrase}`, `resp-${phrase}`)

      expect(mockCreateCalendarEvent).toHaveBeenCalledTimes(1)
    }
  )
})
