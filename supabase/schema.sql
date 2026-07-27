-- Clipper OS — schema v1 (sectie 4 van het bouwdocument)
-- Draaien in de Supabase SQL editor, of via `psql < supabase/schema.sql`.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- campagnes
create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  platform_rules jsonb not null default '{}'::jsonb,
  cpm_eur numeric not null default 0.5,
  budget_eur numeric,
  status text not null default 'active' check (status in ('active', 'paused', 'ended')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- bronvideos
create table if not exists videos (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references campaigns(id) on delete cascade,
  title text not null,
  source_url text,
  duration_seconds int,
  transcript jsonb,               -- [{start_seconds, end_seconds, text}]
  transcript_raw text,            -- ruwe bron zoals binnengekomen
  transcript_source text check (transcript_source in ('youtube_captions', 'whisper', 'manual')),
  character_map jsonb,            -- output planner stap 1
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------- clip-plannen
create table if not exists clip_plans (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references videos(id) on delete cascade,
  prompt_version text not null,
  schema_version text not null,
  vault_snapshot jsonb not null,  -- gewichten waarmee dit plan gemaakt is
  plan jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists clip_plans_video_idx on clip_plans (video_id, created_at desc);

-- --------------------------------------------------------------- de vault
create table if not exists vault_structures (
  slug text primary key,
  name text not null,
  description text not null,
  template jsonb not null default '[]'::jsonb,  -- de beats
  weight numeric not null default 0.5 check (weight >= 0 and weight <= 1),
  evidence jsonb not null default '{}'::jsonb,
  version int not null default 1,
  updated_at timestamptz not null default now()
);

create table if not exists vault_hooks (
  slug text primary key,
  formula text not null,
  example text,
  weight numeric not null default 0.5 check (weight >= 0 and weight <= 1),
  evidence jsonb not null default '{}'::jsonb,
  version int not null default 1,
  updated_at timestamptz not null default now()
);

create table if not exists vault_heuristics (
  id uuid primary key default gen_random_uuid(),
  rule text not null,
  source text not null check (source in ('own_data', 'scout_agent', 'manual')),
  status text not null default 'candidate' check (status in ('candidate', 'active', 'rejected')),
  evidence_score numeric not null default 0,
  platform text,
  created_at timestamptz not null default now()
);

create table if not exists vault_changelog (
  id uuid primary key default gen_random_uuid(),
  entity text not null,           -- 'structure' | 'hook' | 'heuristic'
  entity_key text not null,
  field text not null,
  old_value jsonb,
  new_value jsonb,
  reason text,
  evidence jsonb,
  agent_run_id uuid,
  decided_by text,
  created_at timestamptz not null default now()
);
create index if not exists vault_changelog_entity_idx on vault_changelog (entity, entity_key, created_at desc);

-- ------------------------------------------------------------------- clips
create table if not exists clips (
  id uuid primary key default gen_random_uuid(),
  clip_plan_id uuid not null references clip_plans(id) on delete cascade,
  plan_index int not null,
  titel_intern text,
  structure_type text references vault_structures(slug),
  hook_type text references vault_hooks(slug),
  hook_text text,
  status text not null default 'planned' check (status in ('planned', 'edited', 'posted', 'rejected')),
  post_url text,
  platform text check (platform in ('tiktok', 'reels', 'shorts')),
  posted_at timestamptz,
  variant_of uuid references clips(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists clips_plan_idx on clips (clip_plan_id, plan_index);
create index if not exists clips_tracking_idx on clips (status, posted_at);

-- ------------------------------------------------------------- metingen
create table if not exists metrics_snapshots (
  id uuid primary key default gen_random_uuid(),
  clip_id uuid not null references clips(id) on delete cascade,
  captured_at timestamptz not null default now(),
  views bigint,
  likes int,
  comments int,
  shares int,
  raw jsonb
);
create index if not exists metrics_clip_idx on metrics_snapshots (clip_id, captured_at);

create table if not exists clip_performance (
  clip_id uuid primary key references clips(id) on delete cascade,
  views_6h bigint,
  views_24h bigint,
  views_48h bigint,
  views_7d bigint,
  velocity_score numeric,
  outlier_score numeric,
  updated_at timestamptz not null default now()
);

create table if not exists tracked_accounts (
  id uuid primary key default gen_random_uuid(),
  handle text not null,
  platform text not null check (platform in ('tiktok', 'reels', 'shorts')),
  our_own boolean not null default false,
  median_views_24h bigint,
  median_views_7d bigint,
  updated_at timestamptz not null default now(),
  unique (handle, platform)
);

-- --------------------------------------------------------------- agents
create table if not exists agent_runs (
  id uuid primary key default gen_random_uuid(),
  agent text not null check (agent in ('retro', 'scout', 'eval')),
  input_summary jsonb,
  proposal jsonb,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'auto', 'failed')),
  decided_by text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists agent_runs_status_idx on agent_runs (status, created_at desc);

-- ------------------------------------------------------------------ evals
create table if not exists eval_cases (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  input_transcript jsonb not null,
  duration_seconds int,
  campaign_rules jsonb not null default '{}'::jsonb,
  expected_properties jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists eval_runs (
  id uuid primary key default gen_random_uuid(),
  prompt_version text not null,
  passed boolean not null,
  results jsonb not null,
  created_at timestamptz not null default now()
);

-- --------------------------------------------------------- kostenbewaking
create table if not exists provider_usage (
  id uuid primary key default gen_random_uuid(),
  provider text not null,          -- 'scrapecreators' | 'apify' | 'anthropic'
  operation text not null,
  units numeric not null default 1,
  cost_eur numeric not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists provider_usage_month_idx on provider_usage (created_at);
