// api/backfill-fotis-statusint.js
//
// One-shot endpoint that walks every card in D1 for a given tournament
// and pushes its current state to Fotis tblPlayerEventSC, populating
// statusint and pdflink for every player on every card.
//
// POST /api/backfill-fotis-statusint
//   body: { tournament: "26riga", dryRun?: true, repairD1?: true }
//
// What it does:
//   1. Reads R2 config to find tournament's groupName + fotisBaseUrl
//   2. (repairD1, on by default) Repairs D1 statuses from the R2 admin
//      files. Until the admin-validate.js fix, a refusal reached D1 as an
//      object and the D1 update failed, so refused cards are still
//      'pending' in D1 while R2 (<tournament>/admin/<event>.json ->
//      validationStatus) has the real decision. This copies that
//      decision (and the refusal reason) into D1 where they differ.
//   3. Loads every non-hidden card from D1 for that tournament (across
//      sub-events), oldest upload first so the newest version is pushed
//      last and wins for its players
//   4. For each card: emits an upsert with an explicit statusint
//      (1 = accepted/validated, 2 = refused, 0 = anything else) to Fotis.
//      Refused cards are no longer sent as "remove": the row is kept.
//   5. Returns a per-card summary (plus the D1 repairs)
//
// dryRun: nothing is written to D1 or Fotis; the summary shows what
// would happen (using the repaired statuses).
//
// Auth: requires a Bearer token matching BACKFILL_TOKEN env var
//       (separate from FOTIS_SC_TOKEN to avoid accidental triggers)

import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { d1, publicUrl } from './db.js';
import { syncToFotis, normalizeStatusText, statusToStatusInt } from './fotis-sync.js';

const R2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET     = process.env.R2_BUCKET_NAME || 'system-cards-01';
const CONFIG_KEY = 'config/tournaments.json';
const TOKEN      = process.env.BACKFILL_TOKEN || '';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST required' });

  // Auth
  if (!TOKEN) {
    return res.status(500).json({ error: 'BACKFILL_TOKEN env var not configured' });
  }
  const auth = req.headers.authorization || '';
  const supplied = auth.replace(/^Bearer\s+/i, '').trim();
  if (supplied !== TOKEN) {
    return res.status(401).json({ error: 'Bad or missing Authorization Bearer token' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  const tournament = body?.tournament;
  const dryRun     = !!body?.dryRun;
  const repairD1   = (body?.repairD1 !== false);   // default: on
  if (!tournament) {
    return res.status(400).json({ error: 'Missing tournament' });
  }

  try {
    // 1. Tournament config
    const cfg = await getConfig();
    if (!cfg) return res.status(500).json({ error: 'Could not load R2 config' });
    const tournamentCfg = cfg.tournaments?.[tournament];
    if (!tournamentCfg) {
      return res.status(404).json({ error: `Tournament "${tournament}" not in config` });
    }
    if (!tournamentCfg.fotisBaseUrl || !tournamentCfg.groupName) {
      return res.status(404).json({ error: `Tournament "${tournament}" missing fotisBaseUrl or groupName` });
    }

    // 2. Hidden list (skip these)
    let hidden = new Set();
    try {
      const r = await R2.send(new GetObjectCommand({
        Bucket: BUCKET, Key: `${tournament}/hidden.json`,
      }));
      const arr = JSON.parse(await r.Body.transformToString());
      hidden = new Set((arr || []).map(h => h.fileName));
    } catch { /* none */ }

    // 3. Load every card for this tournament (active versions only)
    const cardsRes = await d1(
      `SELECT id, file_name, file_url, sub_event, status
         FROM system_cards
        WHERE tournament=?
        ORDER BY uploaded_at ASC`,
      [tournament]
    );
    const cards = (cardsRes.results || [])
      .filter(c => !hidden.has(c.file_name));

    // 3b. Repair D1 statuses from the R2 admin files (see header, step 2)
    //   d1Repairs        - list of { card_id, fileName, from, to } changes
    //   adminDecisions   - Map fileName -> { statusText, reason } from R2
    //   decision         - the R2 decision for one card
    const d1Repairs = [];
    if (repairD1) {
      const adminDecisions = await loadAdminDecisions(tournament);
      for (const card of cards) {
        const decision = adminDecisions.get(card.file_name);
        if (!decision) continue;
        const isDifferent =
          statusToStatusInt(decision.statusText) !== statusToStatusInt(card.status);
        if (!isDifferent) continue;

        d1Repairs.push({
          card_id: card.id, fileName: card.file_name,
          from: card.status, to: decision.statusText,
        });
        if (!dryRun) {
          try {
            await d1(
              `UPDATE system_cards SET status=?, refused_reason=? WHERE id=?`,
              [
                decision.statusText,
                decision.statusText === 'refused' ? decision.reason : null,
                card.id,
              ]
            );
          } catch (repairErr) {
            d1Repairs[d1Repairs.length - 1].error = repairErr.message;
            continue;
          }
        }
        // Use the repaired status for the Fotis push below
        card.status = decision.statusText;
      }
    }

    // For each card, attach players
    const cardsWithPlayers = await Promise.all(cards.map(async c => {
      const p = await d1(
        `SELECT player_id, player_name FROM system_card_players WHERE card_id=?`,
        [c.id]
      );
      return { ...c, players: p.results || [] };
    }));

    // 4. Push each card to Fotis
    const results = [];
    for (const c of cardsWithPlayers) {
      // Always an upsert with an explicit status (0 / 1 / 2).
      const action    = 'upsert';
      const statusint = statusToStatusInt(c.status);

      const players = (c.players || []).map(p => ({
        contactinfoid: p.player_id,
        fullName:      p.player_name || null,
        statusint,
        pdflink:       publicUrl(c.file_url) || '',
      })).filter(p => p.contactinfoid);

      if (!players.length) {
        results.push({
          card_id: c.id, fileName: c.file_name,
          subEvent: c.sub_event, status: c.status,
          skipped: 'No players',
        });
        continue;
      }

      if (dryRun) {
        results.push({
          card_id: c.id, fileName: c.file_name,
          subEvent: c.sub_event, status: c.status,
          action, statusint, pdflink: publicUrl(c.file_url),
          playerCount: players.length,
          dryRun: true,
        });
        continue;
      }

      try {
        const r = await syncToFotis({
          tournament: tournamentCfg,
          subEvent:   c.sub_event,
          action,
          players,
        });
        results.push({
          card_id: c.id, fileName: c.file_name,
          subEvent: c.sub_event, status: c.status,
          action, statusint, playerCount: players.length,
          fotis: r,
        });
      } catch (e) {
        results.push({
          card_id: c.id, fileName: c.file_name,
          error: e.message,
        });
      }
    }

    return res.status(200).json({
      tournament, dryRun, repairD1,
      d1RepairCount: d1Repairs.length,
      d1Repairs,
      cardCount: cardsWithPlayers.length,
      results,
    });

  } catch (err) {
    console.error('backfill error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function getConfig() {
  try {
    const r = await R2.send(new GetObjectCommand({ Bucket: BUCKET, Key: CONFIG_KEY }));
    return JSON.parse(await r.Body.transformToString());
  } catch {
    return null;
  }
}

// Read every R2 admin file of a tournament (<tournament>/admin/*.json)
// and return the admin's decision per file name.
// Uses the same bucket setting as admin-validate.js, which writes them.
//   tournament       - tournament code, e.g. "26riga"
//   adminBucket      - bucket admin-validate.js writes the admin files to
//   adminDecisions   - Map fileName -> { statusText, reason } (returned)
//   continuationToken- paging marker for the R2 listing
//   listing          - one page of the R2 listing
//   adminObject      - one listed admin file
//   adminData        - parsed content of one admin file
//   fileName         - card file name inside validationStatus
//   rawStatus        - stored decision (string, or {status, reason})
async function loadAdminDecisions(tournament) {
  const adminBucket = process.env.R2_BUCKET || 'system-cards-01';
  const adminDecisions = new Map();
  let continuationToken = undefined;

  do {
    const listing = await R2.send(new ListObjectsV2Command({
      Bucket: adminBucket,
      Prefix: `${tournament}/admin/`,
      ContinuationToken: continuationToken,
    }));

    for (const adminObject of (listing.Contents || [])) {
      if (!/\.json$/i.test(adminObject.Key)) continue;
      try {
        const r = await R2.send(new GetObjectCommand({
          Bucket: adminBucket, Key: adminObject.Key,
        }));
        const adminData = JSON.parse(await r.Body.transformToString());
        const statuses  = adminData?.validationStatus || {};
        for (const fileName of Object.keys(statuses)) {
          const rawStatus  = statuses[fileName];
          const statusText = normalizeStatusText(rawStatus);
          if (!statusText) continue;
          adminDecisions.set(fileName, {
            statusText,
            reason: (rawStatus && typeof rawStatus === 'object' && rawStatus.reason)
              ? String(rawStatus.reason)
              : null,
          });
        }
      } catch (readErr) {
        console.warn('Could not read admin file', adminObject.Key, readErr.message);
      }
    }

    continuationToken = listing.IsTruncated ? listing.NextContinuationToken : undefined;
  } while (continuationToken);

  return adminDecisions;
}
