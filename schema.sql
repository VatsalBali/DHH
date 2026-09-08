-- DHH Drops — database schema for Supabase (PostgreSQL)
--
-- HOW TO USE:
--   1. Create a free project at https://supabase.com
--   2. Open your project → SQL Editor → New query
--   3. Paste this whole file in and click "Run"
--   4. That's it — the tables and their access rules are set up.
--
-- This file is safe to re-run — every statement is written to not
-- error out if it's already been applied once.

-- ============================================================
-- releases — one row per posted release, whether a person typed
-- it in or the Spotify auto-checker (scripts/check-spotify.mjs)
-- found it on its own.
-- ============================================================
create table if not exists public.releases (
  id uuid primary key default gen_random_uuid(),
  artist text not null check (char_length(artist) between 1 and 80),
  title text not null check (char_length(title) between 1 and 120),
  link text not null check (link ~* '^https?://'),
  release_date date not null,
  created_at timestamptz not null default now(),
  -- 'user' = someone posted it through the site.
  -- 'auto' = the Spotify auto-checker found it for a tracked artist.
  source text not null default 'user' check (source in ('user', 'auto')),
  -- Spotify album/track id, only set on auto-checker rows — used to
  -- avoid posting the same release twice on a later run.
  spotify_id text unique,
  -- Has the auto-checker already tried to find & track the artist
  -- behind this row? Only meaningful for source = 'user'; auto rows
  -- are marked done immediately, nothing left to resolve.
  artist_lookup_done boolean not null default false
);

-- Backfill for anyone re-running this against an existing table
-- created by an earlier version of this file.
alter table public.releases add column if not exists source text not null default 'user';
alter table public.releases add column if not exists spotify_id text;
alter table public.releases add column if not exists artist_lookup_done boolean not null default false;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'releases_source_check') then
    alter table public.releases add constraint releases_source_check check (source in ('user','auto'));
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'releases_spotify_id_key') then
    alter table public.releases add constraint releases_spotify_id_key unique (spotify_id);
  end if;
end $$;

-- Helpful for the feed's default sort (newest release first) and for
-- the auto-checker's "still needs a lookup" query.
create index if not exists releases_release_date_idx
  on public.releases (release_date desc, created_at desc);
create index if not exists releases_needs_lookup_idx
  on public.releases (artist_lookup_done) where source = 'user' and artist_lookup_done = false;

-- ============================================================
-- tracked_artists — artists the Spotify auto-checker watches.
-- Grows on its own: every time someone posts a release, the
-- checker resolves the artist on Spotify and adds them here, so
-- future releases from that artist get picked up automatically.
-- ============================================================
create table if not exists public.tracked_artists (
  id uuid primary key default gen_random_uuid(),
  spotify_artist_id text not null unique,
  artist_name text not null,
  -- how this artist first got tracked, for your own curiosity.
  added_via text not null default 'resolved_from_release',
  last_checked_at timestamptz,
  created_at timestamptz not null default now()
);

-- ============================================================
-- Row Level Security
-- ============================================================
alter table public.releases enable row level security;

drop policy if exists "Public can read releases" on public.releases;
create policy "Public can read releases"
  on public.releases for select
  to anon
  using (true);

drop policy if exists "Public can post releases" on public.releases;
create policy "Public can post releases"
  on public.releases for insert
  to anon
  with check (true);

-- No update/delete policy for anon on purpose — nobody can edit or
-- remove a release through the public site. Moderate spam from the
-- Supabase dashboard's Table Editor instead. The auto-checker script
-- authenticates with the service_role key (kept as a GitHub secret,
-- never shipped to the browser), which bypasses RLS entirely, so it
-- can still insert auto rows and mark lookups done.

alter table public.tracked_artists enable row level security;

drop policy if exists "Public can read tracked artists" on public.tracked_artists;
create policy "Public can read tracked artists"
  on public.tracked_artists for select
  to anon
  using (true);

-- No public insert/update/delete — only the auto-checker script
-- (service_role, bypasses RLS) manages this table.

-- ============================================================
-- Optional: a real example row so the feed isn't empty right after
-- setup. Safe to delete any time from Table Editor.
-- ============================================================
insert into public.releases (artist, title, link, release_date, source, artist_lookup_done) values
  ('Example Artist', 'Example Track (delete me)', 'https://open.spotify.com', current_date, 'user', true)
on conflict do nothing;
