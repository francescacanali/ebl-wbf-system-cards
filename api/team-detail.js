// api/team-detail.js
//
// Returns the cards-by-team detail block needed by:
//  - the Fotis console (per-event team page, expandable rows)
//  - any other consumer that wants the same view as the platform's
//    own per-team accordion.
//
// GET /api/team-detail?tournament=26riga&subEvent=Open+Teams[&team=FRANCE]
//
// Without `team` → returns ALL teams in the sub-event with their
// cards already grouped, scored, and labelled.
// With `team`    → returns just that team (case-insensitive, exact
// name match against Fotis's Reg page).
//
// The response shape is stable and meant to be rendered by clients;
// every field needed for the screenshots Francesca shared is included.

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { d1, publicUrl } from './db.js';

const R2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME || 'system-cards-01';
const CONFIG_KEY = 'config/tournaments.json';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Always serve fresh data — admin accept/refuse actions must be reflected
  // on the team page immediately, with no caching layer in between.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const { tournament: tournamentParam, groupName, subEvent, team, type } = req.query;
  if ((!tournamentParam && !groupName) || !subEvent) {
    return res.status(400).json({
      error: 'Provide subEvent and either tournament (code) or groupName',
      usage: [
        'GET /api/team-detail?tournament=26riga&subEvent=Open+Teams',
        'GET /api/team-detail?groupName=European+Mixed+Teams+2026&subEvent=Open+Teams',
        'add &team=FRANCE to limit to one team',
        'add &type=pairs to query pair events (uses pairsUrl + pair parser)',
      ]
    });
  }
  const isPairs = (String(type || '').toLowerCase() === 'pairs');

  try {
    // 1. Resolve tournament code: either supplied directly, or looked
    //    up from the R2 config by groupName (matching the field we
    //    added for the Fotis sync).
    const config = await getConfig();
    if (!config) return res.status(500).json({ error: 'Config not loadable' });

    let tournament = tournamentParam;
    if (!tournament && groupName) {
      // Find all entries whose groupName matches.
      const candidates = Object.keys(config.tournaments || {}).filter(code =>
        (config.tournaments[code].groupName || '').toLowerCase()
          === String(groupName).toLowerCase()
      );

      if (candidates.length === 0) {
        return res.status(404).json({
          error: `No tournament with groupName "${groupName}" in R2 config`,
        });
      }

      if (candidates.length === 1) {
        tournament = candidates[0];
      } else {
        // Multiple entries share this groupName (typical when one
        // championship is split into a "teams" code and a "pairs"
        // code in R2). Disambiguate by the subEvent: pick the entry
        // whose `subEvents` array contains it.
        tournament = candidates.find(code => {
          const list = config.tournaments[code].subEvents || [];
          return list.some(se => String(se).toLowerCase() === String(subEvent).toLowerCase());
        });
        if (!tournament) {
          return res.status(404).json({
            error: `Multiple R2 entries share groupName "${groupName}" but none lists subEvent "${subEvent}" in its subEvents array`,
            candidates,
            hint: 'Add a "subEvents": [...] array to each entry so this lookup can disambiguate.'
          });
        }
      }
    }

    const tCfg = config.tournaments?.[tournament];
    const entityUrl = isPairs ? tCfg?.pairsUrl : tCfg?.teamsUrl;
    if (!tCfg || !entityUrl) {
      return res.status(404).json({
        error: `No ${isPairs ? 'pairs' : 'teams'} URL configured for ${tournament}`,
      });
    }

    // 2. Fetch entities (live from Fotis) + filter to this sub-event
    const entitiesHtml = await (await fetch(entityUrl)).text();
    const allEntities  = isPairs
      ? parsePairsHtml(entitiesHtml)
      : parseTeamsHtml(entitiesHtml);
    const inEvent      = allEntities.filter(t =>
      cleanEvent(t.event) === cleanEvent(subEvent)
    );

    if (!inEvent.length) {
      return res.status(404).json({
        error: `No ${isPairs ? 'pairs' : 'teams'} found for that sub-event`,
        availableEvents: [...new Set(allEntities.map(t => t.event))]
      });
    }

    // 3. Fetch cards in this sub-event from D1, in one shot.
    //    The user's `subEvent` comes from Fotis's TournName (e.g. "U16
    //    Teams"). D1's `sub_event` may include the EBL/WBF event-code
    //    prefix the upload form uses (e.g. "#26135 U16 Teams"). We
    //    fetch all cards for the tournament and match in JS using the
    //    same prefix-stripping rule.
    const cardsRes = await d1(
      `SELECT id, file_name, file_url, sub_event, status, refused_reason, uploaded_at
         FROM system_cards
        WHERE tournament=?
        ORDER BY uploaded_at ASC`,
      [tournament]
    );
    const wantedKey = cleanEvent(subEvent).toLowerCase();
    const allCards = (cardsRes.results || []).filter(c =>
      cleanEvent(c.sub_event || '').toLowerCase() === wantedKey
    );

    // Attach players to each card (one query per card; D1 doesn't
    // have IN-array placeholders so this is the cheapest approach
    // for typical sizes — a few hundred cards max per event).
    const cardsWithPlayers = await Promise.all(allCards.map(async c => {
      const pRes = await d1(
        `SELECT player_id, player_name FROM system_card_players WHERE card_id=? ORDER BY id`,
        [c.id]
      );
      return { ...c, players: pRes.results || [] };
    }));

    // 4. Load the hidden list once and treat hidden cards as deleted
    let hidden = new Set();
    try {
      const resp = await R2.send(new GetObjectCommand({
        Bucket: BUCKET,
        Key: `${tournament}/hidden.json`,
      }));
      const arr = JSON.parse(await resp.Body.transformToString());
      hidden = new Set(arr.map(h => h.fileName));
    } catch { /* no hidden list yet */ }

    const visibleCards = cardsWithPlayers.filter(c => !hidden.has(c.file_name));

    // 5. Build the response per team, optionally narrowed to one team
    const wanted = team
      ? inEvent.filter(t => t.name.toUpperCase() === team.toUpperCase()
                         || sanitize(t.name) === sanitize(team))
      : inEvent;

    if (team && !wanted.length) {
      return res.status(404).json({ error: `Team "${team}" not found in ${subEvent}` });
    }

    // Decide once, across ALL teams of the event, which team owns each
    // card, so a card is never shown under two teams and never lost.
    const owners = assignCardOwners(inEvent, visibleCards);
    const result = wanted.map(t => buildTeamBlock(t, visibleCards, owners));

    return res.status(200).json({
      tournament,
      subEvent,
      team: team || null,
      teams: result,
    });

  } catch (err) {
    console.error('team-detail error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ───────────────────────── per-team logic ─────────────────────────

function buildTeamBlock(t, allCards, owners) {

  // Cards belonging to this team.
  //
  // Historically we matched ONLY by filename prefix (TEAMNAME_...), which
  // breaks as soon as the organisers rename a team on Fotis: the cards
  // uploaded under the old name no longer start with the new prefix and
  // the team shows "No System Cards" even though everything is uploaded.
  //
  // Ownership is now decided by assignCardOwners() from the players on
  // the card (see there), which survives renames and roster changes.
  const cardsForTeam = allCards
    .filter(c => c.file_name && owners.get(c) === t)
    .slice()
    .sort((a, b) => {
      // Group by pair (same players), newest first inside each group
      const keyA = versionGroupKey(a);
      const keyB = versionGroupKey(b);
      if (keyA !== keyB) return keyA.localeCompare(keyB);
      return new Date(b.uploaded_at) - new Date(a.uploaded_at);
    });

  // Tag each card with version + replaced flag. Versions are grouped by
  // the set of players (not by filename), so a card re-uploaded after a
  // rename (NEWNAME_...) correctly replaces the one filed as OLDNAME_...
  const groupMap = {};
  for (const c of cardsForTeam) {
    const key = versionGroupKey(c);
    (groupMap[key] = groupMap[key] || []).push(c);
  }
  const cards = cardsForTeam.map(c => {
    const siblings = groupMap[versionGroupKey(c)] || [c];
    const isNewest = siblings.every(s =>
      s === c || new Date(s.uploaded_at) <= new Date(c.uploaded_at)
    );
    const versionMatch = c.file_name.match(/_v(\d+)\.pdf$/i);
    const version      = versionMatch ? parseInt(versionMatch[1], 10) : 1;

    // Friendly display status, matching the player view's vocabulary
    const display = displayStatus(c.status);

    return {
      id:           c.id,
      fileName:     c.file_name,
      fileUrl:      publicUrl(c.file_url),
      version,
      replaced:     siblings.length > 1 && !isNewest,
      hasSiblings:  siblings.length > 1,
      uploadedAt:   c.uploaded_at,
      status:       c.status,                           // raw: pending|accepted|refused
      statusLabel:  display.label,                      // pretty
      statusKind:   display.kind,                       // pending|accepted|refused
      refusedReason: c.refused_reason || null,
      // D1 players, or (when D1 has none) the IDs encoded in the filename,
      // so coverage still works for cards whose D1 write failed.
      players:      (c.players.length
        ? c.players.map(p => ({ id: p.player_id, name: p.player_name }))
        : playerIdsFromFileName(c.file_name).map(id => ({
            id,
            name: ((t.players || []).find(p => String(p.wbfId) === id) || {}).fullName || null,
          }))),
    };
  });

  // Compute team-level summary.
  // Priority: red > yellow > green.
  //   red    = no cards at all, OR at least one card refused, OR at least one
  //            playing member is not covered by any active card
  //   yellow = all playing members covered, no refusals, but at least one
  //            card is still pending review
  //   green  = all playing members covered, all cards accepted, no refusals
  const playingMembers = (t.players || []).filter(p => !isNpc(p));
  const cardCount      = cards.length;

  let summary;
  if (cardCount === 0) {
    summary = { kind: 'red', label: 'No System Cards' };
  } else {
    // Active (non-replaced) cards drive coverage and review checks
    const activeCards = cards.filter(c => !c.replaced);

    const hasRefusal = activeCards.some(c => c.statusKind === 'refused');

    const playersWithCards = new Set();
    for (const c of activeCards) {
      for (const p of c.players) playersWithCards.add(String(p.id));
    }
    const everyoneCovered = playingMembers.length > 0 &&
      playingMembers.every(p => playersWithCards.has(String(p.wbfId)));

    const hasPending = activeCards.some(c => c.statusKind === 'pending');

    if (hasRefusal) {
      summary = { kind: 'red', label: `${cardCount} System Card(s) - File issue` };
    } else if (!everyoneCovered) {
      summary = { kind: 'red', label: `${cardCount} System Card(s) - Missing for some players` };
    } else if (hasPending) {
      summary = { kind: 'yellow', label: `${cardCount} System Card(s) - Pending review` };
    } else {
      summary = { kind: 'green', label: `${cardCount} System Card(s) - Complete` };
    }
  }

  return {
    name:    t.name,
    country: t.country || null,
    summary,
    cards,
    players: (t.players || []).map(p => ({
      id:    p.wbfId,
      name:  p.fullName,
      role:  p.role || null,
      isNpc: isNpc(p),
    })),
  };
}

// ───────────────────────── helpers ─────────────────────────

// WBF IDs attached to a card: D1 players first, otherwise parsed from the
// filename (format TEAM_ID1_SURNAME1_ID2_SURNAME2[_vN].pdf).
function cardPlayerIds(c) {
  const fromDb = (c.players || [])
    .map(p => String(p.player_id ?? '').trim())
    .filter(id => /^\d+$/.test(id));
  if (fromDb.length) return [...new Set(fromDb)];
  return playerIdsFromFileName(c.file_name);
}

function playerIdsFromFileName(fileName) {
  const parts = String(fileName || '')
    .replace(/\.pdf$/i, '')
    .replace(/_v\d+$/i, '')
    .split('_');
  const ids = [];
  for (let i = 1; i < parts.length; i += 2) {
    if (/^\d+$/.test(parts[i])) ids.push(parts[i]);
  }
  return [...new Set(ids)];
}

// Surname-like tokens of a filename (everything after the team prefix
// that is not a number or a _vN suffix), used for legacy files that
// carry no WBF IDs, e.g. FRANCE_BESSIS_COMBESCURE.pdf.
function nameTokensFromFileName(fileName) {
  return String(fileName || '')
    .replace(/\.pdf$/i, '')
    .replace(/_v\d+$/i, '')
    .split('_')
    .slice(1)
    .filter(tok => tok && !/^\d+$/.test(tok))
    .map(tok => sanitize(tok));
}

// Decide which team owns each card. A card goes to the team whose roster
// shares the MOST players with it:
//   - by WBF ID (from D1, or from the filename), which survives renames
//     and also roster changes (a substituted player no longer blocks it);
//   - for legacy files without IDs, by surnames in the filename.
// Ties, and cards matching no roster at all, go to the team whose
// sanitised name is the filename prefix (the old behaviour).
// Returns Map card -> team (cards with no owner are left out).
function assignCardOwners(teams, cards) {
  const info = teams.map(t => {
    const ids = new Set();
    const surnames = new Set();
    for (const p of (t.players || [])) {
      ids.add(String(p.wbfId));
      const words = String(p.fullName || '').trim().split(/\s+/);
      for (const w of words) {
        const san = sanitize(w);
        if (san.length > 1) surnames.add(san);
      }
    }
    return { team: t, san: sanitize(t.name), ids, surnames };
  });

  const owners = new Map();
  for (const c of cards) {
    if (!c.file_name) continue;
    const prefix = String(c.file_name).split('_')[0];
    const ids = cardPlayerIds(c);
    const tokens = ids.length ? [] : nameTokensFromFileName(c.file_name);

    let best = null, bestScore = 0, bestPrefix = false;
    for (const ti of info) {
      const score = ids.length
        ? ids.filter(id => ti.ids.has(id)).length
        : tokens.filter(tok => ti.surnames.has(tok)).length;
      const isPrefix = ti.san === prefix;
      if (score > bestScore || (score === bestScore && score > 0 && isPrefix && !bestPrefix)) {
        best = ti.team; bestScore = score; bestPrefix = isPrefix;
      }
    }
    if (!best) {
      const byPrefix = info.find(ti => ti.san === prefix);
      if (byPrefix) best = byPrefix.team;
    }
    if (best) owners.set(c, best);
  }
  return owners;
}

// Key that identifies "the same card, different version": the sorted set
// of player IDs, falling back to the filename without _vN.
function versionGroupKey(c) {
  const ids = cardPlayerIds(c);
  if (ids.length) return 'P:' + ids.slice().sort().join('-');
  return 'F:' + String(c.file_name).replace(/_v\d+\.pdf$/i, '.pdf');
}

function displayStatus(raw) {
  // Admin UI writes 'validated' when accepting a card; the legacy convention
  // expected here was 'accepted'. Treat both as the same approved state.
  if (raw === 'accepted' || raw === 'validated') {
    return { kind: 'accepted', label: 'File accepted' };
  }
  if (raw === 'refused') {
    return { kind: 'refused', label: 'File issue' };
  }
  // Default (pending or anything else): file uploaded but not yet reviewed
  return { kind: 'pending', label: 'Pending review' };
}

function isNpc(p) {
  const r = (p.role || '').toLowerCase();
  if (r === 'coach' || r === 'captain' || r === 'npc') return true;
  const n = (p.fullName || '').toLowerCase();
  return n.includes('(coach)') || n.includes('(captain)') || n.includes('(npc)');
}

function sanitize(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                  .replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

// "#26100 U26 Online Teams" → "U26 Online Teams"
function cleanEvent(s) {
  return String(s || '').replace(/^#\d+\s*/, '').trim();
}

async function getConfig() {
  try {
    const resp = await R2.send(new GetObjectCommand({ Bucket: BUCKET, Key: CONFIG_KEY }));
    return JSON.parse(await resp.Body.transformToString());
  } catch {
    return null;
  }
}

// Lightweight parser, same shape as teams.js — kept here so
// team-detail can stand alone and avoid a circular import.
function parseTeamsHtml(html) {
  const teams = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;

  const hasIdHeader = /<t[hd][^>]*>\s*ID\s*<\/t[hd]>/i.test(html);
  let hasIdColumn = hasIdHeader;
  if (!hasIdColumn) {
    const firstRow = /<tr[^>]*>(?:[\s\S]*?<td[^>]*>[\s\S]*?<\/td>){2,}/i.exec(html);
    if (firstRow) {
      const cells = [];
      let m, re = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      while ((m = re.exec(firstRow[0])) !== null) cells.push(stripHtml(m[1]));
      if (cells.length >= 2 && /^\d+$/.test(cells[1])) hasIdColumn = true;
    }
  }

  let rowMatch;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const cells = [];
    let cellMatch;
    cellRegex.lastIndex = 0;
    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) cells.push(stripHtml(cellMatch[1]));
    const minCells = hasIdColumn ? 4 : 3;
    if (cells.length < minCells) continue;
    let event, teamName, roster;
    if (hasIdColumn) { event = cells[0]; teamName = cells[2]; roster = cells[3]; }
    else             { event = cells[0]; teamName = cells[1]; roster = cells[2]; }
    if (!teamName || teamName === 'Team Name' || teamName === 'Team' || event === 'Event') continue;

    const players = parseRoster(roster);
    if (players.length >= 2) teams.push({ event, name: teamName, players });
  }
  return teams;
}

function parseRoster(rosterText) {
  const players = [];
  const seen = new Set();
  const re = /([A-Za-zÀ-ÿ\s\-'\.]+)\s*\((\d+)\)\s*(captain|coach|npc)?/gi;
  let m;
  while ((m = re.exec(rosterText)) !== null) {
    const fullName = m[1].trim();
    const wbfId    = m[2];
    const role     = m[3] ? m[3].toLowerCase() : '';
    if (seen.has(wbfId)) continue;
    seen.add(wbfId);
    players.push({ fullName, wbfId, role });
  }
  return players;
}

// Pairs HTML parser (for displaypairsparticipcc.asp).
// Expected columns: Event | ID | Pair | Roster | Submitted by | Email | Code
// (At minimum we need Event, Pair name, Roster.)
// Returns objects with the same shape as parseTeamsHtml:
//   { event, name, players: [{fullName, wbfId, role}] }
function parsePairsHtml(html) {
  const pairs = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;

  let rowMatch;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const cells = [];
    let cellMatch;
    cellRegex.lastIndex = 0;
    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      cells.push(stripHtml(cellMatch[1]));
    }
    // Need at least: Event, ID, Pair, Roster
    if (cells.length < 4) continue;

    const event   = cells[0];
    const pairId  = cells[1];
    const pairName = cells[2];
    const roster  = cells[3];

    if (!event || event === 'Event' || event === 'Pair') continue;
    if (!pairName || pairName === 'Pair' || pairName === 'Pair Name') continue;
    if (!/^\d+$/.test(pairId)) continue; // skip header

    const players = parseRoster(roster);
    if (players.length >= 2) {
      pairs.push({ event, name: pairName, players });
    }
  }
  return pairs;
}

function stripHtml(html) {
  return String(html)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, '')
    .trim();
}
