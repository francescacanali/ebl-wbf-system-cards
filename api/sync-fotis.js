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
//      card for that sub-event, WITH that player's statusint) and diff
//      against what it DOES contain
//   5. POST upserts (missing rows + rows with a wrong status) and
//      removes back to Fotis via system_cards.asp
//   6. Return per-sub-event summary
//
// statusint per player (0 pending / 1 accepted / 2 refused):
//   Only the player's CURRENT cards count -- a card replaced by a newer
//   version (A.pdf -> A_v2.pdf) is ignored, same rule as team-detail.js.
//   If a player has several current cards, the "worst" one wins:
//     refused (2)  beats  pending (0)  beats  accepted (1)
//   so a player is only "accepted" when ALL their current cards are.
//
// Status correction of EXISTING rows needs system_cards_state.asp to
// return  "cards":[{"contactinfoid":N,"statusint":S}, ...]  per
// sub-event. If it only returns the older "contactinfoids" list,
// missing rows are still inserted with the right status, but the
// status of existing rows is left alone (as before).
//
// Auth: this endpoint is hit by a browser (the Fotis console), not by
// a server. The reconcile is gated by Fotis having entered an event
// password already (the secretariat session). Vercel itself doesn't
// know the user is authenticated, so we trust the request — the actual
// power to write to Fotis's DB lives in the X-SC-Token, which is held
// server-side here and never exposed to the browser.

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { d1 } from './db.js';
import {
  statusToStatusInt,
  STATUSINT_PENDING,
  STATUSINT_ACCEPTED,
  STATUSINT_REFUSED,
} from './fotis-sync.js';

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

    // Map: normalized subEvent name -> {
    //   original:          sub-event name as Fotis spells it
    //   cids:              Set of contactinfoids that have a row in Fotis
    //   statusByCid:       Map contactinfoid -> statusint currently in Fotis
    //   statusKnown:       true when Fotis sent the "cards" array, i.e. we
    //                      can compare statuses and correct wrong ones
    // }
    const fotisBySubEvent = {};
    for (const fotisSubEvent of (fotisState.subEvents || [])) {
      const statusByCid  = new Map();
      const statusKnown  = Array.isArray(fotisSubEvent.cards);
      if (statusKnown) {
        for (const fotisCard of fotisSubEvent.cards) {
          const fotisCid = parseInt(fotisCard.contactinfoid, 10);
          if (Number.isFinite(fotisCid) && fotisCid > 0) {
            statusByCid.set(fotisCid, Number(fotisCard.statusint));
          }
        }
      }
      fotisBySubEvent[normalizeSubEvent(fotisSubEvent.subEvent)] = {
        original:    fotisSubEvent.subEvent,
        cids:        new Set(fotisSubEvent.contactinfoids || [...statusByCid.keys()]),
        statusByCid,
        statusKnown,
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
      `SELECT id, file_name, file_url, sub_event, status, uploaded_at
         FROM system_cards WHERE tournament=?`,
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

    // Mark replaced cards (an older version of the same file in the
    // same sub-event, e.g. A.pdf when A_v2.pdf exists).
    markReplacedCards(cardsWithPlayers);

    // Group: subEvent -> {
    //   original:      sub-event name as stored in D1
    //   cids:          Set of player ids who should have a row
    //   names:         Map player id -> name
    //   currentCards:  Map player id -> [current (non-replaced) cards]
    //   anyCards:      Map player id -> [all visible cards] (fallback)
    // }
    const d1BySubEvent = {};
    for (const c of cardsWithPlayers) {
      const key = normalizeSubEvent(c.sub_event);
      if (!d1BySubEvent[key]) {
        d1BySubEvent[key] = {
          original:     c.sub_event,
          cids:         new Set(),
          names:        new Map(),
          currentCards: new Map(),
          anyCards:     new Map(),
        };
      }
      const subEventGroup = d1BySubEvent[key];
      for (const p of c.players) {
        const pid = parseInt(p.player_id, 10);
        if (!Number.isFinite(pid) || pid <= 0) continue;
        subEventGroup.cids.add(pid);
        if (p.player_name) subEventGroup.names.set(pid, p.player_name);
        addToListInMap(subEventGroup.anyCards, pid, c);
        if (!c.replaced) addToListInMap(subEventGroup.currentCards, pid, c);
      }
    }

    // 5. Compute diff per sub-event
    const allSubEventKeys = new Set([
      ...Object.keys(fotisBySubEvent),
      ...Object.keys(d1BySubEvent),
    ]);

    const perSubEvent = [];
    let totalInserts = 0;
    let totalUpdates = 0;
    let totalRemoves = 0;
    const callsToFotis = [];

    for (const key of allSubEventKeys) {
      const d1Group    = d1BySubEvent[key];
      const fotisGroup = fotisBySubEvent[key];
      const wanted = d1Group?.cids    || new Set();
      const have   = fotisGroup?.cids || new Set();

      // Insert what's in wanted but not in have
      const toInsert = [...wanted].filter(c => !have.has(c));
      // Remove what's in have but not in wanted
      const toRemove = [...have].filter(c => !wanted.has(c));

      // Desired statusint + pdflink for every wanted player
      //   desiredByCid: Map player id -> { statusint, pdflink }
      const desiredByCid = new Map();
      for (const playerId of wanted) {
        const playerCards =
          d1Group.currentCards.get(playerId) ||
          d1Group.anyCards.get(playerId)     || [];
        desiredByCid.set(playerId, computePlayerStatus(playerCards));
      }

      // Update rows that exist in both but carry a different status
      // (only possible when Fotis told us its current statuses)
      let toUpdate = [];
      if (fotisGroup?.statusKnown) {
        toUpdate = [...wanted].filter(playerId =>
          have.has(playerId) &&
          fotisGroup.statusByCid.get(playerId) !== desiredByCid.get(playerId).statusint
        );
      }

      // The sub-event name we send back to Fotis must match TournName.
      // Prefer D1's value (might come from upload form, may include
      // "#NNNNN " prefix); strip that prefix.
      const sourceName = d1Group?.original || fotisGroup?.original || key;
      const cleanName  = sourceName.replace(/^#\d+\s*/, '').trim();

      perSubEvent.push({
        subEvent: cleanName,
        statusCompared: !!fotisGroup?.statusKnown,
        toInsertCount: toInsert.length,
        toUpdateCount: toUpdate.length,
        toRemoveCount: toRemove.length,
        toInsert: toInsert.slice(0, 50),
        toUpdate: toUpdate.slice(0, 50).map(playerId => ({
          contactinfoid: playerId,
          from: fotisGroup.statusByCid.get(playerId),
          to:   desiredByCid.get(playerId).statusint,
        })),
        toRemove: toRemove.slice(0, 50),
      });

      totalInserts += toInsert.length;
      totalUpdates += toUpdate.length;
      totalRemoves += toRemove.length;

      // Inserts and status corrections are both "upsert" for Fotis
      const toUpsert = [...toInsert, ...toUpdate];
      if (!dryRun && toUpsert.length) {
        callsToFotis.push({
          subEvent: cleanName, action: 'upsert',
          players: toUpsert.map(playerId => ({
            contactinfoid: playerId,
            fullName:  d1Group?.names.get(playerId) || null,
            statusint: desiredByCid.get(playerId).statusint,
            pdflink:   desiredByCid.get(playerId).pdflink,
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
      totalUpdates,
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

// Append a value to the list stored under a key in a Map.
//   targetMap  - the Map holding the lists
//   mapKey     - the key (here: a player id)
//   listValue  - the value to append (here: a card)
function addToListInMap(targetMap, mapKey, listValue) {
  if (!targetMap.has(mapKey)) targetMap.set(mapKey, []);
  targetMap.get(mapKey).push(listValue);
}

// Set card.replaced = true on every card that has a newer version of
// the same file in the same sub-event (A.pdf vs A_v2.pdf). Same rule
// as team-detail.js: newest uploaded_at of a base name is current.
//   cards              - array of D1 cards (modified in place)
//   cardsByVersionKey  - Map "subEvent|baseFileName" -> [cards]
//   versionKey         - that key for one card
//   baseFileName       - file name without its _vN suffix
//   siblingCards       - all versions of one file
//   newestTime         - newest upload time among the siblings
function markReplacedCards(cards) {
  const cardsByVersionKey = new Map();
  for (const card of cards) {
    const baseFileName = String(card.file_name || '').replace(/_v\d+\.pdf$/i, '.pdf');
    const versionKey   = normalizeSubEvent(card.sub_event) + '|' + baseFileName;
    addToListInMap(cardsByVersionKey, versionKey, card);
  }
  for (const siblingCards of cardsByVersionKey.values()) {
    const newestTime = Math.max(...siblingCards.map(card => uploadTime(card)));
    for (const card of siblingCards) {
      card.replaced = siblingCards.length > 1 && uploadTime(card) < newestTime;
    }
  }
}

// Upload time of a card as a number (0 when missing/unreadable).
// D1 stores "YYYY-MM-DD HH:MM:SS" (UTC, no zone), so add the "Z".
//   card       - one D1 card row
//   parsedTime - the parsed time in milliseconds
function uploadTime(card) {
  const parsedTime = Date.parse(String(card.uploaded_at || '').replace(' ', 'T') + 'Z');
  return Number.isFinite(parsedTime) ? parsedTime : 0;
}

// The statusint (and the pdflink to store with it) for one player,
// from that player's cards. Worst status wins:
//   refused (2)  >  pending (0)  >  accepted (1)
// pdflink is taken from the newest card that has that worst status.
//   playerCards     - the player's cards in one sub-event
//   severityOf      - ranking of statusint values (higher = worse)
//   chosenCard      - the card that decides the player's status
//   cardStatusInt   - statusint of the card being looked at
//   chosenStatusInt - statusint of chosenCard
function computePlayerStatus(playerCards) {
  const severityOf = {
    [STATUSINT_ACCEPTED]: 1,
    [STATUSINT_PENDING]:  2,
    [STATUSINT_REFUSED]:  3,
  };
  let chosenCard = null;
  let chosenStatusInt = STATUSINT_PENDING;
  for (const card of playerCards) {
    const cardStatusInt = statusToStatusInt(card.status);
    const isWorse = !chosenCard ||
      severityOf[cardStatusInt] > severityOf[chosenStatusInt];
    const isSameButNewer = chosenCard &&
      cardStatusInt === chosenStatusInt &&
      uploadTime(card) > uploadTime(chosenCard);
    if (isWorse || isSameButNewer) {
      chosenCard = card;
      chosenStatusInt = cardStatusInt;
    }
  }
  return {
    statusint: chosenStatusInt,
    pdflink:   chosenCard?.file_url || '',
  };
}
