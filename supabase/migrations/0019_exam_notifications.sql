-- ---------------------------------------------------------------------------
-- 0019 — Multi-Source Rajasthan Government Exam Notification Monitoring System
--
-- Provides centralized storage, versioning, audit history, and durable multi-channel
-- outbox delivery (FCM Push + Telegram Channels + future destinations) for official
-- announcements from Rajasthan examination authorities (RPSC, RSSB, etc.).
-- ---------------------------------------------------------------------------

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- 1. Notification Sources Registry
create table if not exists public.notification_sources (
  id                          text primary key, -- 'rpsc', 'rssb'
  name                        text not null,
  short_name                  text not null,
  base_url                    text not null,
  monitored_url               text not null,
  adapter_type                text not null, -- 'rpsc_html', 'rssb_html'
  is_enabled                  boolean not null default true,
  polling_interval_seconds    int not null default 300,
  fetch_timeout_ms            int not null default 15000,
  request_headers             jsonb not null default '{}'::jsonb,
  pagination_config           jsonb not null default '{"max_pages": 3}'::jsonb,
  parser_config               jsonb not null default '{}'::jsonb,
  identity_strategy           text not null default 'composite',
  baseline_status             text not null default 'pending', -- 'pending', 'initializing', 'initialized', 'failed'
  baseline_completed_at       timestamptz,
  last_attempted_poll_at      timestamptz,
  last_successful_poll_at     timestamptz,
  last_error                  text,
  consecutive_failure_count   int not null default 0,
  circuit_breaker_open_until  timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

-- 2. Unified Exam Notices
create table if not exists public.exam_notices (
  id                          uuid primary key default gen_random_uuid(),
  source_id                   text not null references public.notification_sources(id) on delete cascade,
  source_notice_id            text not null,
  canonical_url               text not null,
  title                       text not null,
  publication_date            date,
  first_detected_at           timestamptz not null default now(),
  last_observed_at            timestamptz not null default now(),
  last_modified_at            timestamptz,
  notice_type                 text not null default 'general', 
  -- 'advertisement', 'exam_date', 'admit_card', 'answer_key', 'result', 'syllabus', 'corrigendum', 'press_note', 'general'
  exam_category               text, 
  -- 'RAS', 'SI', 'CET_GRADUATE', 'CET_SENIOR_SECONDARY', 'LDC', 'REET', 'PATWAR', 'OTHER'
  exam_name                   text,
  description                 text,
  attachment_urls             jsonb not null default '[]'::jsonb,
  content_fingerprint         text not null,
  is_active                   boolean not null default true,
  status                      text not null default 'published', -- 'published', 'updated', 'withdrawn', 'archived'
  classification_confidence   numeric(3,2) not null default 0.00,
  raw_metadata                jsonb not null default '{}'::jsonb,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint uq_source_notice unique (source_id, source_notice_id)
);

create index if not exists idx_notices_source_pubdate on public.exam_notices(source_id, publication_date desc nulls last);
create index if not exists idx_notices_first_detected on public.exam_notices(first_detected_at desc);
create index if not exists idx_notices_exam_category on public.exam_notices(exam_category) where exam_category is not null;
create index if not exists idx_notices_notice_type on public.exam_notices(notice_type);
create index if not exists idx_notices_attachments on public.exam_notices using gin(attachment_urls);

-- 3. Notice Version & Mutation History
create table if not exists public.exam_notice_history (
  id                          uuid primary key default gen_random_uuid(),
  notice_id                   uuid not null references public.exam_notices(id) on delete cascade,
  previous_fingerprint        text not null,
  new_fingerprint             text not null,
  diff_summary                jsonb not null default '{}'::jsonb,
  detected_at                 timestamptz not null default now()
);

create index if not exists idx_history_notice_id on public.exam_notice_history(notice_id, detected_at desc);

-- 3b. AI Enrichment Cache (Gemini API Structured Summaries)
create table if not exists public.exam_notice_ai_enrichments (
  id                          uuid primary key default gen_random_uuid(),
  notice_id                   uuid not null references public.exam_notices(id) on delete cascade,
  content_fingerprint         text not null,
  model                       text not null default 'gemini-2.5-flash',
  exam_name                   text,
  exam_category               text,
  notice_type                 text,
  summary_hi                  text,
  summary_en                  text,
  key_points                  jsonb not null default '[]'::jsonb,
  important_dates             jsonb not null default '{}'::jsonb,
  vacancies_count             int,
  confidence_score            numeric(3,2) not null default 0.00,
  raw_gemini_response         jsonb not null default '{}'::jsonb,
  latency_ms                  int,
  created_at                  timestamptz not null default now(),
  constraint uq_notice_ai_fingerprint unique (notice_id, content_fingerprint)
);

create index if not exists idx_ai_enrichments_notice on public.exam_notice_ai_enrichments(notice_id);

-- 4. Polling Run Telemetry & Logs
create table if not exists public.polling_runs (
  id                          uuid primary key default gen_random_uuid(),
  source_id                   text not null references public.notification_sources(id) on delete cascade,
  status                      text not null, -- 'running', 'success', 'partial_success', 'failed', 'circuit_broken'
  started_at                  timestamptz not null default now(),
  finished_at                 timestamptz,
  duration_ms                 int,
  http_status_code            int,
  items_scanned               int not null default 0,
  new_items_count             int not null default 0,
  updated_items_count         int not null default 0,
  error_message               text,
  error_stack                 text,
  response_bytes              int
);

create index if not exists idx_polling_runs_source_time on public.polling_runs(source_id, started_at desc);

-- 5. Telegram Channels Registry
create table if not exists public.telegram_channels (
  id                          text primary key, -- 'tg_main', 'tg_rpsc', 'tg_rssb', 'tg_staging'
  name                        text not null,
  chat_id                     text not null, -- '@channel_username' or '-100xxxxxxxxxx'
  is_enabled                  boolean not null default true,
  filter_source_ids           text[] default null, -- null = all sources, or array['rpsc']
  filter_categories           text[] default null, -- null = all, or array['RAS', 'SI']
  filter_notice_types         text[] default null, -- null = all, or array['admit_card', 'result']
  message_template            text, -- custom template override or null for standard
  parse_mode                  text not null default 'HTML', -- 'HTML' or 'MarkdownV2'
  disable_web_page_preview    boolean not null default false,
  rate_limit_seconds          int not null default 3, -- minimum spacing between messages
  last_posted_at              timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

-- 6. Unified Durable Notification Outbox (Destination Agnostic)
create table if not exists public.notification_outbox (
  id                          uuid primary key default gen_random_uuid(),
  notice_id                   uuid not null references public.exam_notices(id) on delete cascade,
  destination_type            text not null, -- 'fcm_topic', 'fcm_token', 'telegram_channel'
  destination_target          text not null, -- topic name ('board_rpsc'), channel ID ('tg_main'), or token
  idempotency_key             text not null unique, -- hash(notice_id + destination_type + destination_target + fingerprint)
  title                       text not null,
  body                        text not null,
  payload                     jsonb not null default '{}'::jsonb, -- contains deep links, HTML content, attachments
  status                      text not null default 'pending', -- 'pending', 'processing', 'delivered', 'failed', 'skipped'
  attempt_count               int not null default 0,
  max_attempts                int not null default 5,
  next_attempt_at             timestamptz not null default now(),
  delivered_at                timestamptz,
  provider_message_id         text, -- Telegram message_id (int) or FCM message ID
  last_error                  text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index if not exists idx_outbox_queue on public.notification_outbox(status, next_attempt_at)
where status in ('pending', 'processing');

create index if not exists idx_outbox_dest on public.notification_outbox(destination_type, status);

-- 7. Notification Delivery Audit Log
create table if not exists public.notification_delivery_attempts (
  id                          uuid primary key default gen_random_uuid(),
  outbox_id                   uuid not null references public.notification_outbox(id) on delete cascade,
  destination_type            text not null,
  destination_target          text not null,
  attempted_at                timestamptz not null default now(),
  status                      text not null, -- 'success', 'failure'
  response_code               int,
  response_body               text,
  error_message               text
);

-- 8. User Custom Notification Subscriptions (Mobile App)
create table if not exists public.user_notification_subscriptions (
  user_id                     text not null references public.users(id) on delete cascade,
  source_id                   text not null references public.notification_sources(id) on delete cascade,
  is_subscribed               boolean not null default true,
  subscribed_categories       text[] not null default '{}',
  subscribed_notice_types     text[] not null default '{}',
  updated_at                  timestamptz not null default now(),
  primary key (user_id, source_id)
);

create index if not exists idx_user_subs_source on public.user_notification_subscriptions(source_id)
where is_subscribed = true;

-- 9. Stored Procedures & Queue Helpers

/**
 * Atomically claims pending jobs from notification_outbox by destination_type using FOR UPDATE SKIP LOCKED.
 * Only callable by service_role.
 */
create or replace function public.claim_outbox_jobs(
  p_destination_type text default null,
  batch_size int default 20
)
returns setof public.notification_outbox
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return query
  with claimed as (
    select id 
    from public.notification_outbox
    where status = 'pending'
      and next_attempt_at <= now()
      and (p_destination_type is null or destination_type = p_destination_type)
    order by next_attempt_at asc
    limit batch_size
    for update skip locked
  )
  update public.notification_outbox
  set status = 'processing',
      updated_at = now()
  where id in (select id from claimed)
  returning *;
end;
$$;

revoke execute on function public.claim_outbox_jobs(text, int) from public, anon, authenticated;

/**
 * Resets a source baseline safely so an archive rescan can be performed without notification spam.
 */
create or replace function public.reset_source_baseline(p_source_id text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  update public.notification_sources
  set baseline_status = 'pending',
      baseline_completed_at = null,
      last_error = null,
      consecutive_failure_count = 0,
      circuit_breaker_open_until = null,
      updated_at = now()
  where id = p_source_id;
end;
$$;

revoke execute on function public.reset_source_baseline(text) from public, anon, authenticated;

-- 10. Row Level Security
alter table public.notification_sources enable row level security;
alter table public.exam_notices enable row level security;
alter table public.exam_notice_history enable row level security;
alter table public.exam_notice_ai_enrichments enable row level security;
alter table public.polling_runs enable row level security;
alter table public.telegram_channels enable row level security;
alter table public.notification_outbox enable row level security;
alter table public.notification_delivery_attempts enable row level security;
alter table public.user_notification_subscriptions enable row level security;

-- Client RLS Policies: Public read of active sources, notices, and public channels
drop policy if exists "Allow public read of active sources" on public.notification_sources;
create policy "Allow public read of active sources"
  on public.notification_sources for select
  using (is_enabled = true);

drop policy if exists "Allow public read of active notices" on public.exam_notices;
create policy "Allow public read of active notices"
  on public.exam_notices for select
  using (is_active = true);

drop policy if exists "Allow public read of ai enrichments" on public.exam_notice_ai_enrichments;
create policy "Allow public read of ai enrichments"
  on public.exam_notice_ai_enrichments for select
  using (true);

drop policy if exists "Allow authenticated users to manage own subscriptions" on public.user_notification_subscriptions;
create policy "Allow authenticated users to manage own subscriptions"
  on public.user_notification_subscriptions for all
  using (auth.uid()::text = user_id)
  with check (auth.uid()::text = user_id);

-- 11. Seed Initial Official Sources & Default Telegram Channels
insert into public.notification_sources (
  id, name, short_name, base_url, monitored_url, adapter_type,
  is_enabled, polling_interval_seconds, fetch_timeout_ms, baseline_status
) values
(
  'rpsc',
  'Rajasthan Public Service Commission',
  'RPSC',
  'https://rpsc.rajasthan.gov.in',
  'https://rpsc.rajasthan.gov.in/news',
  'rpsc_html',
  true,
  300,
  15000,
  'pending'
),
(
  'rssb',
  'Rajasthan Staff Selection Board',
  'RSSB',
  'https://rssb.rajasthan.gov.in',
  'https://rssb.rajasthan.gov.in/news',
  'rssb_html',
  true,
  300,
  15000,
  'pending'
)
on conflict (id) do update set
  name = excluded.name,
  short_name = excluded.short_name,
  base_url = excluded.base_url,
  monitored_url = excluded.monitored_url,
  adapter_type = excluded.adapter_type;

insert into public.telegram_channels (
  id, name, chat_id, is_enabled, filter_source_ids, parse_mode
) values
(
  'tg_main',
  'Pyqbox Announcements',
  '@pyqboxannouncements',
  true,
  null, -- all sources
  'HTML'
),
(
  'tg_rpsc',
  'Pyqbox RPSC Official Alerts',
  '@pyqbox_rpsc_alerts',
  false, -- disabled by default until channel created
  array['rpsc'],
  'HTML'
),
(
  'tg_rssb',
  'Pyqbox RSSB Official Alerts',
  '@pyqbox_rssb_alerts',
  false,
  array['rssb'],
  'HTML'
),
(
  'tg_staging',
  'Pyqbox Alerts Staging Channel',
  '@pyqbox_alerts_staging',
  false,
  null,
  'HTML'
)
on conflict (id) do nothing;
