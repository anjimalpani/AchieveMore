# Day Prep — Live Voice Productivity Assistant

## What This App Does
A voice-first personal assistant that helps users prepare for their day. Users speak tasks and events naturally, the agent responds in real time, and automated morning/evening briefings keep everyone on top of their schedule. No typing required — voice is the primary interface.

## Core User Flows

### 1. Task Capture (anytime)
User taps "Start Conversation" button → speaks a task → agent confirms aloud → user says yes/no/correct → saved to DB and Google Calendar. Zero clicks after the initial button tap.

### 2. Night Before Brief (9pm trigger OR manual button)
"Night Brief" button → agent speaks tomorrow's schedule → flags anything needing prep → user can respond conversationally.

### 3. Morning Brief (7am trigger OR manual button)
"Morning Brief" button → agent speaks today's priorities in order → user asks questions or adds last-minute tasks → session ends naturally.

## Tech Stack

- **Frontend**: Next.js 14 (App Router) + TypeScript
- **Voice in/out**: OpenAI Realtime API (WebSocket, gpt-4o-mini-realtime)
- **WebSocket server**: Node.js + `ws` library on Railway (always-on, NOT Vercel serverless)
- **Auth**: Supabase Auth (Google OAuth)
- **Database**: Supabase Postgres with Row Level Security
- **Calendar**: Google Calendar API v3
- **Deployment**: Railway (WebSocket server) + Vercel (Next.js frontend)
- **Notifications**: Web Push API for 9pm/7am brief triggers

## UX Requirements — CRITICAL

### Main Screen Layout
The main screen must have exactly THREE primary interaction elements, prominent and centred:

```
┌─────────────────────────────────────┐
│                                     │
│   [  🌙  Night Brief  ]            │
│                                     │
│   [  ☀️  Morning Brief ]           │
│                                     │
│   [  🎙  Start Conversation ]      │
│                                     │
│   ── today's tasks listed below ── │
└─────────────────────────────────────┘
```

- "Start Conversation" button: large, prominent, pulsing when active
- "Night Brief" button: visible at all times, not hidden in a menu
- "Morning Brief" button: visible at all times, not hidden in a menu
- When agent is speaking: show an animated waveform/orb visual
- Text override: small "type instead" link below the mic button only
- NO floating mic button. NO always-listening mode. User must explicitly tap to start.

### Voice Session States
The UI must clearly show which state it's in:
- **Idle**: three buttons visible, today's task list shown
- **Listening**: mic button pulses red, waveform animates
- **Agent speaking**: orb animates, waveform on agent side pulses
- **Confirming**: confirmation card shown with task details + Yes/Edit/Cancel
- **Saved**: green check animation, then returns to Idle

### Confirmation Card (appears after agent extracts a task)
```
┌─────────────────────────────────┐
│ Type:    [ Task | Event | Reminder ]  
│ What:    Prep Jordan pitch deck  [edit]
│ When:    Friday Apr 18           [edit]
│ Time:    2:00 PM                 [edit]
│                                  
│ "Should I also block prep time?" 
│ [Yes, 30 min] [Yes, 1 hr] [No]  
│                                  
│ [✓ Save it]  [Try again]  [Cancel]
└─────────────────────────────────┘
```
User can say "yes" into the mic OR tap the button — both work.

## Architecture

### Repository Structure
```
/
├── apps/
│   ├── web/                    # Next.js frontend (Vercel)
│   │   ├── app/
│   │   │   ├── page.tsx        # Main screen (3 buttons + task list)
│   │   │   ├── layout.tsx
│   │   │   └── api/
│   │   │       └── auth/       # Supabase auth callbacks
│   │   ├── components/
│   │   │   ├── MainScreen.tsx  # 3-button layout
│   │   │   ├── VoiceOrb.tsx    # Animated speaking indicator
│   │   │   ├── ConfirmCard.tsx # Task confirmation UI
│   │   │   ├── TaskList.tsx    # Today's tasks grouped by time
│   │   │   ├── NightBrief.tsx  # Night brief trigger + display
│   │   │   └── MorningBrief.tsx# Morning brief trigger + display
│   │   └── lib/
│   │       ├── supabase.ts
│   │       ├── websocket.ts    # Client WebSocket to voice server
│   │       └── calendar.ts
│   └── voice-server/           # Node.js WebSocket server (Railway)
│       ├── index.ts            # WS server + session manager
│       ├── session.ts          # Per-user session state
│       ├── realtime.ts         # OpenAI Realtime API proxy
│       ├── context.ts          # Load user data from Supabase
│       └── actions.ts          # Tool handlers (save task, calendar)
├── supabase/
│   └── migrations/             # DB schema + RLS policies
└── CLAUDE.md                   # This file
```

### Data Flow
```
User speaks
  → Browser mic (WebRTC/MediaRecorder)
  → WebSocket to voice-server (Railway)
  → voice-server proxies audio to OpenAI Realtime API
  → Realtime API responds with audio + optional function call
  → voice-server plays audio back to browser
  → If function call (save_task): write to Supabase + Google Calendar
  → Confirmation sent to browser UI
```

## Database Schema

```sql
-- Users table (managed by Supabase Auth)
-- auth.users is automatic

-- Tasks table
create table tasks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users not null,
  title       text not null,
  type        text check (type in ('task', 'event', 'reminder')) default 'task',
  due_at      timestamptz,
  status      text check (status in ('pending', 'done', 'cancelled')) default 'pending',
  repeat_rule text,                    -- iCal RRULE string or null
  gcal_id     text,                    -- Google Calendar event ID
  raw_voice   text,                    -- Original transcript
  notes       text,                    -- Claude prep notes
  confirmed_at timestamptz,            -- When user confirmed
  created_at  timestamptz default now()
);

-- Row Level Security
alter table tasks enable row level security;
create policy "users own their tasks"
  on tasks for all
  using (auth.uid() = user_id);

-- User preferences
create table user_preferences (
  user_id         uuid primary key references auth.users,
  wake_time       time default '07:00',
  sleep_time      time default '22:00',
  brief_style     text default 'concise',   -- 'concise' | 'detailed'
  voice_id        text default 'alloy',     -- OpenAI voice
  timezone        text default 'America/New_York',
  gcal_token      text,                     -- Encrypted Google OAuth token
  push_endpoint   text,                     -- Web Push subscription
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

alter table user_preferences enable row level security;
create policy "users own their prefs"
  on user_preferences for all
  using (auth.uid() = user_id);

-- Brief history
create table briefs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users not null,
  type        text check (type in ('morning', 'night')),
  content     text,                    -- Full brief text
  triggered_at timestamptz default now()
);

alter table briefs enable row level security;
create policy "users own their briefs"
  on briefs for all
  using (auth.uid() = user_id);
```

## Voice Server — Key Implementation

### Session Lifecycle
```typescript
// On WebSocket connect:
// 1. Authenticate JWT from query param
// 2. Load user context from Supabase (tasks, calendar, prefs)
// 3. Open Realtime API session with context as system prompt
// 4. Proxy audio bidirectionally
// 5. Handle function calls (save_task, update_task, etc.)
// 6. On disconnect: clean up session, close Realtime API connection

interface UserSession {
  userId: string;
  ws: WebSocket;           // Browser connection
  rtWs: WebSocket;         // OpenAI Realtime API connection
  context: UserContext;    // Tasks, calendar, prefs
  state: 'listening' | 'agent_speaking' | 'idle';
}
```

### System Prompt Template
```typescript
const buildSystemPrompt = (ctx: UserContext): string => `
You are a personal day-prep assistant for ${ctx.name}. You help them manage tasks, 
prepare for their day, and stay organised. You speak in a warm, concise, natural tone 
— like a helpful colleague, not a robot.

TODAY IS: ${ctx.today}
USER TIMEZONE: ${ctx.timezone} (UTC${ctx.utcOffset})
WAKE TIME: ${ctx.wakeTime} | PREFERRED BRIEF STYLE: ${ctx.briefStyle}

TODAY'S SCHEDULE:
${ctx.todayEvents.map(e => `- ${e.time}: ${e.title}`).join('\n') || 'No events yet'}

UPCOMING TASKS (AchieveMore):
${ctx.upcomingTasks.map(t => `- ${t.dueAt}: ${t.title} [${t.type}]`).join('\n') || 'No tasks'}

GOOGLE TASKS (existing, from Google Tasks app):
${ctx.googleTasks.length > 0
  ? ctx.googleTasks.map(t => `- ${t.due ? '...' : 'No date'}: ${t.title}`).join('\n')
  : 'None or not connected'}

TIMEZONE RULES — CRITICAL:
- Always generate due_at as ISO 8601 with the correct UTC offset for this timezone.
- NEVER output a bare UTC "Z" timestamp.

BEHAVIOUR RULES:
- Keep responses short (2-3 sentences max) unless doing a full brief
- Always confirm before saving — repeat title, date, and time back to the user
- If date/time is unclear, ask once: "When do you need this done?"
- When saving a task, call save_task AND save_task_to_google after confirmation
- If the user already has a matching Google Task, mention it instead of creating a duplicate
- For morning/night briefs, be structured: list items in time order, flag prep needs
- You can be interrupted — stop speaking immediately if the user starts talking
- Never mention that you're an AI unless directly asked
`;
```

### Realtime API Function Definitions
```typescript
const TOOLS = [
  {
    type: "function",
    name: "save_task",
    description: "Save a confirmed task, event, or reminder after user confirmation",
    parameters: {
      type: "object",
      properties: {
        title:       { type: "string", description: "Task title" },
        type:        { type: "string", enum: ["task", "event", "reminder"] },
        due_at:      { type: "string", description: "ISO 8601 datetime" },
        notes:       { type: "string", description: "Any prep notes or context" },
        repeat_rule: { type: "string", description: "iCal RRULE string if recurring" },
        create_gcal: { type: "boolean", description: "Whether to create a Google Calendar event" }
      },
      required: ["title", "type"]
    }
  },
  {
    type: "function",
    name: "save_task_to_google",
    description: "Create a task in the user's default Google Tasks list. Call alongside save_task after confirmation.",
    parameters: {
      type: "object",
      properties: {
        title:  { type: "string", description: "Task title" },
        due_at: { type: "string", description: "ISO 8601 datetime for the due date" },
        notes:  { type: "string", description: "Optional notes or context" }
      },
      required: ["title"]
    }
  },
  {
    type: "function",
    name: "mark_done",
    description: "Mark a task as completed",
    parameters: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"]
    }
  },
  {
    type: "function",
    name: "generate_brief",
    description: "Generate a morning or night brief from the user's schedule",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["morning", "night"] }
      },
      required: ["type"]
    }
  }
];
```

## Frontend — Key Components

### VoiceOrb Component
```tsx
// Shows animated state during voice conversation
// States: idle | listening | speaking | processing
// Use CSS animations only (transform + opacity) — no canvas/WebGL
// Idle: static circle with subtle pulse
// Listening: rings expand outward (user speaking)
// Speaking: inner orb pulses with audio level data
// Processing: spinner overlay
```

### MainScreen Layout Rules
- Three buttons MUST be visible without scrolling on mobile (375px width)
- Night Brief and Morning Brief buttons: equal width, side by side OR stacked
- Start Conversation button: full width, larger than the brief buttons
- Task list scrolls below the buttons
- Dark mode supported via CSS variables

## Environment Variables

### Voice Server (Railway)
```env
OPENAI_API_KEY=           # OpenAI API key — NEVER expose to frontend
SUPABASE_URL=             # Supabase project URL
SUPABASE_SERVICE_KEY=     # Supabase service role key (full access)
JWT_SECRET=               # Same as Supabase JWT secret
PORT=8080
```

### Frontend (Vercel)
```env
NEXT_PUBLIC_SUPABASE_URL=         # Supabase project URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=    # Supabase anon key (safe to expose)
NEXT_PUBLIC_VOICE_SERVER_URL=     # wss://your-app.railway.app
GOOGLE_CLIENT_ID=                 # Google OAuth client ID
GOOGLE_CLIENT_SECRET=             # Google OAuth client secret
```

## Build Order for Claude Code

Build in this exact order — each phase should be testable before moving to the next:

### Phase 1 — Auth + DB (Day 1)
1. Set up Supabase project with schema above
2. Enable Google OAuth in Supabase Auth
3. Next.js app with login page → redirect to main screen
4. Main screen shows 3 buttons (non-functional) + empty task list
5. Row level security verified: two test users can't see each other's data

### Phase 2 — Voice Server skeleton (Day 1-2)
1. Node.js WebSocket server on Railway
2. JWT auth on connect
3. Echo test: browser sends audio chunks → server logs receipt
4. Deploy to Railway, test connection from browser

### Phase 3 — Realtime API integration (Day 2-3)
1. Voice server proxies audio to OpenAI Realtime API
2. Agent responds with audio → plays in browser
3. System prompt loads user context from Supabase
4. VoiceOrb UI shows correct states

### Phase 4 — Task saving (Day 3-4)
1. save_task function call handler
2. Writes to Supabase tasks table
3. Confirmation card UI appears after agent confirms
4. Yes/edit/cancel voice + tap both work
5. Task appears in task list on main screen

### Phase 5 — Google Calendar (Day 4-5)
1. Google Calendar OAuth flow
2. Read today's events on session start
3. Create events when save_task has create_gcal: true
4. Calendar events appear in agent context

### Phase 6 — Briefs (Day 5-6)
1. Night brief button triggers generate_brief("night")
2. Morning brief button triggers generate_brief("morning")
3. 9pm/7am automated triggers via cron on Railway
4. Web Push notifications to wake the app
5. Brief saved to briefs table

### Phase 7 — Polish (Day 6-7)
1. VAD (voice activity detection) — stop streaming during silence
2. Interruption handling — stop agent audio when user speaks
3. Multi-device: session reconnects cleanly
4. Error states: mic denied, network lost, API errors

## Cost Controls

Implement these to keep API costs predictable:

```typescript
// 1. Max session length: 15 minutes per conversation
// 2. VAD: only stream audio when voice detected (saves ~40% audio cost)
// 3. Context pruning: load only last 7 days of tasks into system prompt
// 4. Rate limit: max 3 sessions per user per hour
// 5. Silence detection: auto-end session after 30s of silence
```

## Key Rules — Never Break These

1. **OPENAI_API_KEY never touches the frontend** — all Realtime API calls go through voice server
2. **Row Level Security always on** — every table has RLS, every policy uses `auth.uid() = user_id`
3. **Voice requires explicit button tap** — no always-listening, no wake word in v1
4. **Night Brief and Morning Brief are always visible** — never hidden in menus or modals
5. **Confirmation before saving** — agent always confirms task details before calling save_task
6. **Graceful degradation** — if voice fails, text input fallback is always available
7. **Mobile first** — design for 375px width, test on iPhone before desktop

## Testing Checklist

Before each phase is "done":
- [ ] Works on mobile Chrome (375px)
- [ ] Works on desktop Chrome
- [ ] Works with slow network (throttle to 3G in DevTools)
- [ ] Two users' data is fully isolated (test with two browser profiles)
- [ ] Error state shown if mic permission denied
- [ ] Error state shown if voice server disconnects mid-session
- [ ] Night Brief button works at any time of day (not just 9pm)
- [ ] Morning Brief button works at any time of day (not just 7am)

## Useful Commands

```bash
# Local development
npm run dev              # Start Next.js frontend
cd apps/voice-server && npm run dev   # Start voice server locally

# Database
npx supabase db push     # Push schema migrations
npx supabase db reset    # Reset local DB for testing

# Deploy
git push origin main     # Triggers Vercel deploy (frontend)
railway up               # Deploy voice server to Railway

# Test WebSocket connection
wscat -c "ws://localhost:8080?token=YOUR_JWT"
```
