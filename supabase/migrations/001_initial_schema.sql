-- ============================================================
-- AchieveMore — Initial Schema
-- Run this in the Supabase SQL Editor (supabase.com/dashboard)
-- ============================================================

-- Tasks table
create table if not exists tasks (
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

-- Row Level Security on tasks
alter table tasks enable row level security;

drop policy if exists "users own their tasks" on tasks;
create policy "users own their tasks"
  on tasks for all
  using (auth.uid() = user_id);

-- User preferences table
create table if not exists user_preferences (
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

-- Row Level Security on user_preferences
alter table user_preferences enable row level security;

drop policy if exists "users own their prefs" on user_preferences;
create policy "users own their prefs"
  on user_preferences for all
  using (auth.uid() = user_id);

-- Brief history table
create table if not exists briefs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users not null,
  type        text check (type in ('morning', 'night')),
  content     text,                    -- Full brief text
  triggered_at timestamptz default now()
);

-- Row Level Security on briefs
alter table briefs enable row level security;

drop policy if exists "users own their briefs" on briefs;
create policy "users own their briefs"
  on briefs for all
  using (auth.uid() = user_id);

-- Auto-create user preferences row when a new user signs up
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.user_preferences (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
