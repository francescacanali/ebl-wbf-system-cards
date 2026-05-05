// api/sync-fotis.js
//
// Reconciles the SC platform's D1 with Fotis's tblPlayerEventSC for
// one championship. Triggered by a button on the Fotis console.
//
// POST /api/sync-fotis
//   body: { groupName: "Riga 2026 Pairs", dryRun?: true }
//
// What it does:
//   1. Find tournament code in R2 config by groupName
//   2. Fetch Fotis's current state via GET system_cards_state.asp
//   3. Read all visible cards from D1 for this tournament (across
//      all sub-events) and the players on each
//   4. For each sub-event, compute what `tblPlayerEventSC` SHOULD
//      contain (one row per player who has at least one non-hidden
//      card for that sub-event) and diff against what it DOES contain
//   5. POST inserts and removes back to Fotis via system_cards.asp
//   6. Return per-sub-event summary
//
// Auth: this endpoint is hit by a browser (the Fotis console), not by
// a server. The reconcile is gated by Fotis having entered an event
// password already (the secretariat session). Vercel itself doesn't
// know the user is authenticated, so we trust the request — the actual
// power to write to Fotis's DB lives in the X-SC-Token, which is held
// server-side here and never exposed to the browser.

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { d1 } from './db.js';

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
const TOKEN      = process.env.FOTIS_SC_TOKEN || '';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST required' });

  if (!TOKEN) {
    return res.status(500).json({ error: 'FOTIS_SC_TOKEN not configured on Vercel' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  const groupName = body?.groupName;
  const dryRun    = !!body?.dryRun;

  if (!groupName) {
    return res.status(400).json({ error: 'Missing groupName' });
  }

  try {
    // 1. Find tournament code by groupName
    const cfg = await getConfig();
    if (!cfg) return res.status(500).json({ error: 'Could not load config from R2' });

    const code = Object.keys(cfg.tournaments || {}).find(c =>
      (cfg.tournaments[c].groupName || '').toLowerCase() === groupName.toLowerCase()
    );
    if (!code) {
      return res.status(404).json({ error: `No tournament with groupName "${groupName}" in R2 config` });
    }
    const tournamentCfg = cfg.tournaments[code];
    if (!tournamentCfg.fotisBaseUrl) {
      return res.status(404).json({ error: `Tournament "${code}" has no fotisBaseUrl` });
    }
    const fotisBase = tournamentCfg.fotisBaseUrl.replace(/\/+$/, '');

    // 2. Fetch Fotis's current state
    const stateUrl = `${fotisBase}/system_cards_state.asp?groupName=${encodeURIComponent(groupName)}`;
    const stateResp = await fetch(stateUrl, {
      method: 'GET',
      headers: { 'X-SC-Token': TOKEN },
    });
    if (!stateResp.ok) {
      const text = await stateResp.text().catch(() => '');
      return res.status(502).json({
        error: `Fotis state endpoint returned ${stateResp.status}`,
        body: text.slice(0, 300),
      });
    }
    const fotisState = await stateResp.json();
    // Map: subEvent name -> Set of contactinfoids currently in Fotis
    const fotisBySubEvent = {};
    for (const se of (fotisState.subEvents || [])) {
      fotisBySubEvent[normalizeSubEvent(se.subEvent)] = {
        original: se.subEvent,
        cids: new Set(se.contactinfoids || []),
      };
    }

    // 3. Hidden list for this tournament
    let hidden = new Set();
    try {
      const r = await R2.send(new GetObjectCommand({
        Bucket: BUCKET, Key: `${code}/hidden.json`
      }));
      const arr = JSON.parse(await r.Body.transformToString());
      hidden = new Set((arr || []).map(h => h.fileName));
    } catch { /* no hidden list yet */ }

    // 4. Pull all cards in D1 for this tournament, with players
    const cardsRes = await d1(
      `SELECT id, file_name, sub_event FROM system_cards WHERE tournament=?`,
      [code]
    );
    const allCards = (cardsRes.results || [])
      .filter(c => !hidden.has(c.file_name) && c.sub_event);

    // For each card, attach its players
    const cardsWithPlayers = await Promise.all(allCards.map(async c => {
      const p = await d1(
        `SELECT player_id, player_name FROM system_card_players WHERE card_id=?`,
        [c.id]
      );
      return { ...c, players: p.results || [] };
    }));

    // Group: subEvent -> { Set of player_ids who should have a row, Map id->name }
    const d1BySubEvent = {};
    for (const c of cardsWithPlayers) {
      const key = normalizeSubEvent(c.sub_event);
      if (!d1BySubEvent[key]) {
        d1BySubEvent[key] = { original: c.sub_event, cids: new Set(), names: new Map() };
      }
      for (const p of c.players) {
        const pid = parseInt(p.player_id, 10);
        if (!Number.isFinite(pid) || pid <= 0) continue;
        d1BySubEvent[key].cids.add(pid);
        if (p.player_name) d1BySubEvent[key].names.set(pid, p.player_name);
      }
    }

    // 5. Compute diff per sub-event
    const allSubEventKeys = new Set([
      ...Object.keys(fotisBySubEvent),
      ...Object.keys(d1BySubEvent),
    ]);

    const perSubEvent = [];
    let totalInserts = 0;
    let totalRemoves = 0;
    const callsToFotis = [];

    for (const key of allSubEventKeys) {
      const wanted = d1BySubEvent[key]?.cids || new Set();
      const have   = fotisBySubEvent[key]?.cids || new Set();
      // Insert what's in wanted but not in have
      const toInsert = [...wanted].filter(c => !have.has(c));
      // Remove what's in have but not in wanted
      const toRemove = [...have].filter(c => !wanted.has(c));

      // The sub-event name we send back to Fotis must match TournName.
      // Prefer D1's value (might come from upload form, may include
      // "#NNNNN " prefix); strip that prefix.
      const sourceName = d1BySubEvent[key]?.original || fotisBySubEvent[key]?.original || key;
      const cleanName  = sourceName.replace(/^#\d+\s*/, '').trim();

      perSubEvent.push({
        subEvent: cleanName,
        toInsertCount: toInsert.length,
        toRemoveCount: toRemove.length,
        toInsert: toInsert.slice(0, 50),
        toRemove: toRemove.slice(0, 50),
      });

      totalInserts += toInsert.length;
      totalRemoves += toRemove.length;

      if (!dryRun && toInsert.length) {
        callsToFotis.push({
          subEvent: cleanName, action: 'upsert',
          players: toInsert.map(c => ({
            contactinfoid: c,
            fullName: d1BySubEvent[key]?.names.get(c) || null,
          })),
        });
      }
      if (!dryRun && toRemove.length) {
        callsToFotis.push({
          subEvent: cleanName, action: 'remove',
          players: toRemove.map(c => ({ contactinfoid: c })),
        });
      }
    }

    // 6. Apply
    let applied = [];
    if (!dryRun) {
      const url = `${fotisBase}/system_cards.asp`;
      for (const call of callsToFotis) {
        const body = JSON.stringify({
          tournamentName: groupName,
          subEvent: call.subEvent,
          action: call.action,
          players: call.players,
        });
        try {
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-SC-Token': TOKEN },
            body,
          });
          const txt = await r.text();
          let parsed = null;
          try { parsed = JSON.parse(txt); } catch {}
          applied.push({
            subEvent: call.subEvent, action: call.action,
            players: call.players.length,
            status: r.status, ok: r.ok,
            response: parsed || txt.slice(0, 200),
          });
        } catch (err) {
          applied.push({
            subEvent: call.subEvent, action: call.action,
            players: call.players.length,
            status: 'NETWORK_ERROR', ok: false,
            response: err.message,
          });
        }
      }
    }

    return res.status(200).json({
      groupName,
      tournamentCode: code,
      dryRun,
      totalInserts,
      totalRemoves,
      perSubEvent,
      applied,
    });

  } catch (err) {
    console.error('sync-fotis error:', err);
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

// Two sub-event strings refer to the same sub-event if they match
// after lowercasing and stripping the EBL/WBF "#NNNNN " event-code
// prefix. This is the same prefix the upload form leaves in D1's
// sub_event column.
function normalizeSubEvent(s) {
  return String(s || '').replace(/^#\d+\s*/, '').trim().toLowerCase();
}
