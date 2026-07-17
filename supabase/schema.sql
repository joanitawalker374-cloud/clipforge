-- Schéma ClipForge — à coller dans Supabase (SQL Editor) puis "Run".

create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('tiktok','caption','uniquify')),
  status text not null default 'queued'
    check (status in ('queued','processing','done','error')),
  params jsonb not null default '{}'::jsonb,
  input_key text,          -- clé du fichier source dans le bucket (upload)
  output_key text,         -- clé du résultat dans le bucket
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists jobs_status_idx on jobs(status);
create index if not exists jobs_created_idx on jobs(created_at desc);

-- Bucket de stockage (à créer aussi via l'UI Storage, nom : clipforge, privé).
-- insert into storage.buckets (id, name, public) values ('clipforge','clipforge', false)
--   on conflict do nothing;
