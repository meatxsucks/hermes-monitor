-- Esquema completo de Hermes Stars.
-- Se ejecuta una sola vez en el SQL Editor de un proyecto Supabase nuevo.
-- Es idempotente: se puede volver a correr sin romper nada.

-- Métricas de la GPU (una fila por muestreo del recolector).
create table if not exists public.gpu_metrics (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  util_pct numeric,
  vram_used_mb numeric,
  vram_total_mb numeric,
  temp_c numeric,
  power_w numeric
);

-- CPU y RAM del equipo.
create table if not exists public.system_metrics (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  cpu_pct numeric,
  ram_used_mb numeric,
  ram_total_mb numeric
);

-- Estado del modelo local servido por llama.cpp.
create table if not exists public.model_metrics (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  tok_s numeric,
  ctx_used integer,
  ctx_total integer,
  status text,
  activity text,
  prompt_progress real,
  gen_tokens integer,
  prompt_done integer,
  prompt_total integer,
  gen_tok_s real,
  prompt_tok_s real,
  task_elapsed_s real,
  last_response_s real,
  compress_threshold integer,
  compress_since timestamptz,
  compress_model text,
  compress_provider text
);

-- Estado de los servicios vigilados (llama.cpp, gateway, canales).
create table if not exists public.service_status (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  service text not null,
  status text not null,
  detail text
);

-- Eventos del registro técnico (mensajes, respuestas, respaldo, compresiones).
create table if not exists public.events (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  kind text not null,
  message text not null,
  severity text not null default 'info'
);

-- Saldo, gasto y uso del respaldo y la compresión en OpenRouter.
create table if not exists public.cloud_metrics (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  balance_usd real,
  spend_day_usd real,
  spend_week_usd real,
  spend_month_usd real,
  key_remaining_usd real,
  fallback_chain text,
  fallback_count_24h integer,
  last_fallback_ts timestamptz,
  last_fallback_model text,
  compression_model text,
  compression_count_24h integer,
  last_compression_ts timestamptz,
  last_compression_model text,
  last_compression_provider text,
  last_compression_s real,
  last_compression_tokens integer
);

-- Un turno = un mensaje recibido y su respuesta, con el desglose por fases.
create table if not exists public.turns (
  id bigint generated always as identity primary key,
  turn_key text not null unique,
  platform text not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  status text not null default 'active',
  phase text,
  total_s real,
  read_s real not null default 0,
  write_s real not null default 0,
  tools_s real not null default 0,
  compress_s real not null default 0,
  api_calls integer not null default 0,
  tokens_in integer,
  tokens_out integer not null default 0,
  cache_pct real,
  tools jsonb not null default '{}'::jsonb,
  tool_errors integer not null default 0,
  compressed boolean not null default false,
  fallback_used boolean not null default false,
  updated_at timestamptz not null default now()
);

create index if not exists gpu_metrics_ts_idx on public.gpu_metrics (ts desc);
create index if not exists system_metrics_ts_idx on public.system_metrics (ts desc);
create index if not exists model_metrics_ts_idx on public.model_metrics (ts desc);
create index if not exists service_status_ts_idx on public.service_status (ts desc);
create index if not exists events_ts_idx on public.events (ts desc);
create index if not exists cloud_metrics_ts_idx on public.cloud_metrics (ts desc);
create index if not exists turns_started_at_idx on public.turns (started_at desc);

-- Seguridad: lectura pública para el panel (clave anon) y escritura solo con service_role.
-- Las tablas no guardan el contenido de los mensajes, solo cifras y nombres de eventos.
alter table public.gpu_metrics enable row level security;
alter table public.system_metrics enable row level security;
alter table public.model_metrics enable row level security;
alter table public.service_status enable row level security;
alter table public.events enable row level security;
alter table public.cloud_metrics enable row level security;
alter table public.turns enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'gpu_metrics', 'system_metrics', 'model_metrics', 'service_status',
    'events', 'cloud_metrics', 'turns'
  ]
  loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t and policyname = 'public read'
    ) then
      execute format(
        'create policy "public read" on public.%I for select to anon, authenticated using (true)', t
      );
    end if;
  end loop;
end $$;

-- Limpieza: métricas 7 días; nube, eventos y turnos 30 días.
create or replace function public.prune_monitor_data()
returns void
language sql
set search_path to ''
as $$
  delete from public.gpu_metrics where ts < now() - interval '7 days';
  delete from public.system_metrics where ts < now() - interval '7 days';
  delete from public.model_metrics where ts < now() - interval '7 days';
  delete from public.service_status where ts < now() - interval '7 days';
  delete from public.cloud_metrics where ts < now() - interval '30 days';
  delete from public.events where ts < now() - interval '30 days';
  delete from public.turns where started_at < now() - interval '30 days';
$$;

-- Programa la limpieza todos los días a las 04:17 (requiere activar la extensión pg_cron
-- en Database > Extensions antes de ejecutar esta parte).
create extension if not exists pg_cron;
select cron.schedule('prune-monitor-data', '17 4 * * *', 'select public.prune_monitor_data()')
where not exists (select 1 from cron.job where jobname = 'prune-monitor-data');
