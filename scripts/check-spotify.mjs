#!/usr/bin/env node
/**
 * DHH Drops — release auto-checker
 * ---------------------------------
 * Run on a schedule (see ../.github/workflows/spotify-check.yml).
 *
 * Uses Apple's iTunes Search API (free, no account or key needed)
 * instead of Spotify's Web API, which now only works when the app
 * owner has an active Spotify Premium subscription. The file keeps its
 * old name so the workflow doesn't need changing.
 *
 * Two jobs, in order:
 *
 *   1. RESOLVE  — look at releases people posted through the site that
 *      haven't been checked yet, search iTunes for each artist name
 *      people typed (every name in "A, B ft. C" is tried), and add any
 *      exact name match to tracked_artists.
 *
 *   2. CHECK    — for every tracked artist, ask iTunes for their most
 *      recent albums/singles, and post any release from the last
 *      LOOKBACK_DAYS days that isn't already in the feed (including
 *      ones a person already posted with a Spotify/YouTube link).
 *
 * Required environment variables (GitHub Actions repo secrets, never
 * committed):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   (NOT the anon key — this one bypasses
 *                                 row-level security, so the script can
 *                                 write even though the public site can't)
 * SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are no longer used and can
 * be left set or removed.
 *
 * Schema note: iTunes ids are stored in the existing spotify_* columns
 * with an "itunes:" prefix (tracked_artists.spotify_artist_id,
 * releases.spotify_id), so no database migration is needed.
 */

import { createClient } from "@supabase/supabase-js";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

const LOOKBACK_DAYS = 10; // ignore anything iTunes reports as older than this
const RESOLVE_BATCH_SIZE = 25; // user posts to try resolving per run
const COUNTRY = "IN"; // storefront to search; DHH artists are best covered here
// iTunes allows roughly 20 requests a minute per IP, so space calls out.
const REQUEST_DELAY_MS = 3200;
const MAX_RETRIES = 4;

for (const [name, val] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY })) {
  if (!val) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Lowercase letters/digits only, for loose name and title comparisons.
 * Falls back to the trimmed lowercase string for names with no Latin
 * letters (e.g. written in Devanagari), which would otherwise be "". */
function normalize(s) {
  const lower = String(s).toLowerCase();
  return lower.replace(/[^a-z0-9]/g, "") || lower.replace(/\s+/g, "");
}

/* ================= iTunes API ================= */

/** GET an iTunes endpoint. 403/429 there mean "slow down", so back off
 * and retry; if it still won't answer, the error is fatal for the run. */
async function itunesGet(path, attempt = 0) {
  await sleep(REQUEST_DELAY_MS);
  const res = await fetch(`https://itunes.apple.com${path}`);
  if ((res.status === 403 || res.status === 429) && attempt < MAX_RETRIES) {
    const waitS = 30 * (attempt + 1);
    console.warn(`  iTunes rate limited (${res.status}), waiting ${waitS}s`);
    await sleep(waitS * 1000);
    return itunesGet(path, attempt + 1);
  }
  if (!res.ok) {
    const err = new Error(`iTunes GET ${path} failed: ${res.status} ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** Still rate limited after every retry — later calls will fail the
 * same way, so the run should stop and go red instead of quietly
 * skipping. */
function isFatalItunesError(e) {
  return e.status === 403 || e.status === 429;
}

/* ================= step 1: resolve artists from user posts ================= */

/** "Emiway Bantai, MEMAX" / "Raga X Panther" / "KhullarG ft. ISHH" →
 * individual names. */
function splitArtistNames(artist) {
  return artist
    .split(/\s*(?:,|&|\+|\/|\bx\b|\bft\.?|\bfeat\.?|\bfeaturing\b|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Returns { id, name } for an exact (normalized) name match, or null.
 * Only an exact match is trusted, to avoid tracking the wrong
 * "John Smith" off a loose search hit; among several exact matches a
 * hip-hop artist wins (e.g. the Delhi "Hurricane", not the Serbian one). */
async function findArtist(name) {
  const q = encodeURIComponent(name);
  const json = await itunesGet(`/search?term=${q}&entity=musicArtist&country=${COUNTRY}&limit=10`);
  const matches = (json.results || []).filter((a) => normalize(a.artistName) === normalize(name));
  if (!matches.length) return null;
  const best = matches.find((a) => /hip-hop|rap/i.test(a.primaryGenreName || "")) || matches[0];
  return { id: String(best.artistId), name: best.artistName };
}

async function resolveStep() {
  const { data: pending, error } = await supabase
    .from("releases")
    .select("id, artist")
    .eq("source", "user")
    .eq("artist_lookup_done", false)
    .order("created_at", { ascending: true })
    .limit(RESOLVE_BATCH_SIZE);

  if (error) throw error;
  if (!pending?.length) {
    console.log("Resolve step: nothing pending.");
    return;
  }
  console.log(`Resolve step: ${pending.length} release(s) to look up.`);

  for (const release of pending) {
    let done = true;
    try {
      for (const name of splitArtistNames(release.artist)) {
        const artist = await findArtist(name);
        if (!artist) {
          console.log(`  no exact iTunes match for "${name}"`);
          continue;
        }
        const { error: upsertErr } = await supabase
          .from("tracked_artists")
          .upsert(
            { spotify_artist_id: `itunes:${artist.id}`, artist_name: artist.name },
            { onConflict: "spotify_artist_id", ignoreDuplicates: true },
          );
        if (upsertErr) {
          console.error(`  upsert failed for ${artist.name}:`, upsertErr.message);
          done = false; // retry next run
        } else {
          console.log(`  tracking: ${artist.name}`);
        }
      }
    } catch (e) {
      console.error(`  couldn't resolve release ${release.id} (${release.artist}):`, e.message);
      // Fatal (still rate limited): stop now, leaving this and the rest pending.
      if (isFatalItunesError(e)) throw e;
      done = false; // 5xx / network — retry next run
    }
    if (done) {
      await supabase.from("releases").update({ artist_lookup_done: true }).eq("id", release.id);
    }
  }
}

/* ================= step 2: check tracked artists for new releases ================= */

/** "Gyaara - Single" → "Gyaara". */
function cleanTitle(name) {
  return name.replace(/\s+-\s+(Single|EP)$/i, "").trim();
}

async function checkStep() {
  const { data: artists, error } = await supabase
    .from("tracked_artists")
    .select("*")
    .like("spotify_artist_id", "itunes:%");
  if (error) throw error;
  if (!artists?.length) {
    console.log("Check step: no tracked artists yet.");
    return;
  }
  console.log(`Check step: checking ${artists.length} tracked artist(s).`);

  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - LOOKBACK_DAYS);
  const cutoffDay = cutoff.toISOString().slice(0, 10);

  // Everything already in the feed from the lookback window, so a
  // release someone posted by hand (Spotify/YouTube link) isn't posted
  // a second time with an Apple Music link.
  const { data: recent, error: recentErr } = await supabase
    .from("releases")
    .select("title, spotify_id")
    .gte("release_date", cutoffDay);
  if (recentErr) throw recentErr;
  const seenIds = new Set(recent.map((r) => r.spotify_id).filter(Boolean));
  const seenTitles = new Set(recent.map((r) => normalize(cleanTitle(r.title))));

  for (const artist of artists) {
    const artistId = artist.spotify_artist_id.slice("itunes:".length);
    try {
      const json = await itunesGet(
        `/lookup?id=${artistId}&entity=album&country=${COUNTRY}&sort=recent&limit=50`,
      );

      for (const album of json.results || []) {
        if (album.wrapperType !== "collection" || !album.releaseDate) continue;
        const releaseDate = new Date(album.releaseDate);
        if (releaseDate < cutoff || releaseDate > now) continue; // too old, or a pre-order

        const itunesId = `itunes:${album.collectionId}`;
        const title = cleanTitle(album.collectionName);
        if (seenIds.has(itunesId) || seenTitles.has(normalize(title))) continue;

        const { error: insertErr } = await supabase.from("releases").insert({
          artist: (album.artistName || artist.artist_name).slice(0, 80),
          title: title.slice(0, 120),
          link: (album.collectionViewUrl || "").replace(/\?.*$/, ""),
          release_date: album.releaseDate.slice(0, 10),
          source: "auto",
          spotify_id: itunesId,
          artist_lookup_done: true,
        });
        seenIds.add(itunesId);
        seenTitles.add(normalize(title));
        if (insertErr) {
          if (insertErr.code !== "23505") {
            // 23505 = unique violation on spotify_id — another run beat us to it, fine to ignore.
            console.error(`  insert failed for ${artist.artist_name} — ${title}:`, insertErr.message);
          }
        } else {
          console.log(`  new: ${album.artistName} — ${title} (${album.releaseDate.slice(0, 10)})`);
        }
      }

      await supabase
        .from("tracked_artists")
        .update({ last_checked_at: new Date().toISOString() })
        .eq("id", artist.id);
    } catch (e) {
      console.error(`  couldn't check ${artist.artist_name}:`, e.message);
      if (isFatalItunesError(e)) throw e;
    }
  }
}

/* ================= main ================= */

async function main() {
  await resolveStep();
  await checkStep();
  console.log("Done.");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
