#!/usr/bin/env node
/**
 * DHH Drops — Spotify auto-checker
 * ---------------------------------
 * Run on a schedule (see ../.github/workflows/spotify-check.yml).
 * Two jobs, in order:
 *
 *   1. RESOLVE  — look at releases people posted through the site that
 *      haven't been checked yet, figure out which Spotify artist each
 *      one belongs to (straight from the link when it's a Spotify link,
 *      otherwise by searching Spotify for the artist name people typed),
 *      and add that artist to tracked_artists if they're new.
 *
 *   2. CHECK    — for every tracked artist, ask Spotify for their most
 *      recent albums/singles, and post any release from the last
 *      LOOKBACK_DAYS days that isn't already in the feed.
 *
 * Required environment variables (see README.md for where to get
 * each one — all four are GitHub Actions repo secrets, never
 * committed):
 *   SPOTIFY_CLIENT_ID
 *   SPOTIFY_CLIENT_SECRET
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   (NOT the anon key — this one bypasses
 *                                 row-level security, so the script can
 *                                 write even though the public site can't)
 */

import { createClient } from "@supabase/supabase-js";

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

const LOOKBACK_DAYS = 10; // ignore anything Spotify reports as older than this
const RESOLVE_BATCH_SIZE = 25; // user posts to try resolving per run
const REQUEST_DELAY_MS = 120; // be polite to Spotify's API between calls

for (const [name, val] of Object.entries({
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
})) {
  if (!val) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ================= Spotify auth ================= */

async function getSpotifyToken() {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " +
        Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    throw new Error(`Spotify auth failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  return json.access_token;
}

async function spotifyGet(token, path) {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("Retry-After") || "2");
    console.warn(`Rate limited, waiting ${retryAfter}s`);
    await sleep((retryAfter + 1) * 1000);
    return spotifyGet(token, path);
  }
  if (!res.ok) {
    throw new Error(`Spotify GET ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/* ================= step 1: resolve artists from user posts ================= */

function parseSpotifyLink(link) {
  const m = link.match(/open\.spotify\.com\/(track|album|artist)\/([a-zA-Z0-9]+)/);
  if (!m) return null;
  return { type: m[1], id: m[2] };
}

/** Returns [{ id, name }] — the primary artist(s) behind a link or a
 * text search, or [] if nothing could be resolved. */
async function resolveArtists(token, release) {
  const parsed = parseSpotifyLink(release.link);

  if (parsed?.type === "artist") {
    const artist = await spotifyGet(token, `/artists/${parsed.id}`);
    return [{ id: artist.id, name: artist.name }];
  }
  if (parsed?.type === "track") {
    const track = await spotifyGet(token, `/tracks/${parsed.id}`);
    return (track.artists || []).slice(0, 1).map((a) => ({ id: a.id, name: a.name }));
  }
  if (parsed?.type === "album") {
    const album = await spotifyGet(token, `/albums/${parsed.id}`);
    return (album.artists || []).slice(0, 1).map((a) => ({ id: a.id, name: a.name }));
  }

  // Not a Spotify link (YouTube, SoundCloud, Instagram, ...) — fall
  // back to searching Spotify for the artist name the poster typed,
  // so the feed still grows from non-Spotify posts.
  const q = encodeURIComponent(release.artist);
  const search = await spotifyGet(token, `/search?q=${q}&type=artist&limit=1`);
  const hit = search.artists?.items?.[0];
  if (!hit) return [];
  // Only trust a reasonably close name match, to avoid tracking the
  // wrong "John Smith" off a loose search hit.
  const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalize(hit.name) !== normalize(release.artist)) return [];
  return [{ id: hit.id, name: hit.name }];
}

async function resolveStep(token) {
  const { data: pending, error } = await supabase
    .from("releases")
    .select("id, artist, link")
    .eq("source", "user")
    .eq("artist_lookup_done", false)
    .limit(RESOLVE_BATCH_SIZE);

  if (error) throw error;
  if (!pending?.length) {
    console.log("Resolve step: nothing pending.");
    return;
  }
  console.log(`Resolve step: ${pending.length} release(s) to look up.`);

  for (const release of pending) {
    try {
      const artists = await resolveArtists(token, release);
      for (const artist of artists) {
        const { error: upsertErr } = await supabase
          .from("tracked_artists")
          .upsert(
            { spotify_artist_id: artist.id, artist_name: artist.name },
            { onConflict: "spotify_artist_id", ignoreDuplicates: true },
          );
        if (upsertErr) console.error(`  upsert failed for ${artist.name}:`, upsertErr.message);
        else console.log(`  tracking: ${artist.name}`);
      }
    } catch (e) {
      console.error(`  couldn't resolve release ${release.id} (${release.artist}):`, e.message);
      // fall through — still mark it done below so a bad/rate-limited
      // link doesn't get retried forever; it'll just stay untracked.
    }
    await supabase.from("releases").update({ artist_lookup_done: true }).eq("id", release.id);
    await sleep(REQUEST_DELAY_MS);
  }
}

/* ================= step 2: check tracked artists for new releases ================= */

async function checkStep(token) {
  const { data: artists, error } = await supabase.from("tracked_artists").select("*");
  if (error) throw error;
  if (!artists?.length) {
    console.log("Check step: no tracked artists yet.");
    return;
  }
  console.log(`Check step: checking ${artists.length} tracked artist(s).`);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - LOOKBACK_DAYS);

  for (const artist of artists) {
    try {
      const page = await spotifyGet(
        token,
        `/artists/${artist.spotify_artist_id}/albums?include_groups=album,single&limit=10&market=US`,
      );

      for (const album of page.items || []) {
        if (album.release_date_precision !== "day") continue; // too vague to trust as "new"
        const releaseDate = new Date(album.release_date);
        if (releaseDate < cutoff) continue;

        const { data: existing } = await supabase
          .from("releases")
          .select("id")
          .eq("spotify_id", album.id)
          .maybeSingle();
        if (existing) continue;

        const { error: insertErr } = await supabase.from("releases").insert({
          artist: artist.artist_name,
          title: album.name,
          link: album.external_urls?.spotify || `https://open.spotify.com/album/${album.id}`,
          release_date: album.release_date,
          source: "auto",
          spotify_id: album.id,
          artist_lookup_done: true,
        });
        if (insertErr) {
          if (insertErr.code !== "23505") {
            // 23505 = unique violation on spotify_id — another run beat us to it, fine to ignore.
            console.error(`  insert failed for ${artist.artist_name} — ${album.name}:`, insertErr.message);
          }
        } else {
          console.log(`  new: ${artist.artist_name} — ${album.name} (${album.release_date})`);
        }
      }

      await supabase
        .from("tracked_artists")
        .update({ last_checked_at: new Date().toISOString() })
        .eq("id", artist.id);
    } catch (e) {
      console.error(`  couldn't check ${artist.artist_name}:`, e.message);
    }
    await sleep(REQUEST_DELAY_MS);
  }
}

/* ================= main ================= */

async function main() {
  const token = await getSpotifyToken();
  await resolveStep(token);
  await checkStep(token);
  console.log("Done.");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
