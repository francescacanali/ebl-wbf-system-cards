// api/backfill-fotis-statusint.js
//
// One-shot endpoint that walks every card in D1 for a given tournament
// and pushes its current state to Fotis tblPlayerEventSC, populating
// statusint and pdflink for every player on every card.
//
// POST /api/backfill-fotis-statusint
//   body: { tournament: "26riga", dryRun?: true }
//
// What it does:
//   1. Reads R2 config to find tournament's groupName + fotisBaseUrl
//   2. Loads every card from D1 for that tournament (across sub-events),
//      excluding those marked as replaced (older versions)
//   3. For each card: emits an upsert (statusint=1 if accepted/validated,
//      else 0) OR a remove (if status='refused') to Fotis
//   4. Returns a per-card summary
//
// Auth: requires a Bearer token matching BACKFILL_TOKEN env var
//       (separate from FOTIS_SC_TOKEN to avoid accidental triggers)

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { d1 } from './db.js';
import { syncToFotis } from './fotis-sync.js';

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
      const isAccepted = (c.status === 'accepted' || c.status === 'validated');
      const isRefused  = (c.status === 'refused');
      const action     = isRefused ? 'remove' : 'upsert';
      const statusint  = isAccepted ? 1 : 0;

      const players = (c.players || []).map(p => ({
        contactinfoid: p.player_id,
        fullName:      p.player_name || null,
        ...(action === 'upsert' ? {
          statusint,
          pdflink: c.file_url || '',
        } : {}),
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
          action, statusint, pdflink: c.file_url,
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
      tournament, dryRun,
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
