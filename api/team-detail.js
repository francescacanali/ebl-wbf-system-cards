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
import { d1 } from './db.js';

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

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const { tournament: tournamentParam, groupName, subEvent, team } = req.query;
  if ((!tournamentParam && !groupName) || !subEvent) {
    return res.status(400).json({
      error: 'Provide subEvent and either tournament (code) or groupName',
      usage: [
        'GET /api/team-detail?tournament=26riga&subEvent=Open+Teams',
        'GET /api/team-detail?groupName=European+Mixed+Teams+2026&subEvent=Open+Teams',
        'add &team=FRANCE to limit to one team',
      ]
    });
  }

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
    if (!tCfg || !tCfg.teamsUrl) {
      return res.status(404).json({ error: `No teams URL configured for ${tournament}` });
    }

    // 2. Fetch teams (live from Fotis) + filter to this sub-event
    const teamsHtml = await (await fetch(tCfg.teamsUrl)).text();
    const allTeams  = parseTeamsHtml(teamsHtml);
    const inEvent   = allTeams.filter(t =>
      cleanEvent(t.event) === cleanEvent(subEvent)
    );

    if (!inEvent.length) {
      return res.status(404).json({
        error: 'No teams found for that sub-event',
        availableEvents: [...new Set(allTeams.map(t => t.event))]
      });
    }

    // 3. Fetch cards in this sub-event from D1, in one shot
    const cardsRes = await d1(
      `SELECT id, file_name, file_url, sub_event, status, refused_reason, uploaded_at
         FROM system_cards
        WHERE tournament=? AND sub_event=?
        ORDER BY uploaded_at ASC`,
      [tournament, subEvent]
    );
    const allCards = cardsRes.results || [];

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
      ? inEvent.filter(t => t.name.toUpperCase() === team.toUpperCase())
      : inEvent;

    if (team && !wanted.length) {
      return res.status(404).json({ error: `Team "${team}" not found in ${subEvent}` });
    }

    const result = wanted.map(t => buildTeamBlock(t, visibleCards));

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

function buildTeamBlock(t, allCards) {
  const teamSan = sanitize(t.name);

  // Cards belonging to this team — match by filename prefix
  const cardsForTeam = allCards
    .filter(c => c.file_name && c.file_name.startsWith(teamSan + '_'))
    .slice()
    .sort((a, b) => {
      // Same grouping logic as the player view: group by base, newest first
      const baseA = a.file_name.replace(/_v\d+\.pdf$/i, '.pdf');
      const baseB = b.file_name.replace(/_v\d+\.pdf$/i, '.pdf');
      if (baseA !== baseB) return baseA.localeCompare(baseB);
      return new Date(b.uploaded_at) - new Date(a.uploaded_at);
    });

  // Tag each card with version + replaced flag
  const baseMap = {};
  for (const c of cardsForTeam) {
    const base = c.file_name.replace(/_v\d+\.pdf$/i, '.pdf');
    (baseMap[base] = baseMap[base] || []).push(c);
  }
  const cards = cardsForTeam.map(c => {
    const base     = c.file_name.replace(/_v\d+\.pdf$/i, '.pdf');
    const siblings = baseMap[base] || [c];
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
      fileUrl:      c.file_url,
      version,
      replaced:     siblings.length > 1 && !isNewest,
      hasSiblings:  siblings.length > 1,
      uploadedAt:   c.uploaded_at,
      status:       c.status,                           // raw: pending|accepted|refused
      statusLabel:  display.label,                      // pretty
      statusKind:   display.kind,                       // pending|accepted|refused
      refusedReason: c.refused_reason || null,
      players:      c.players.map(p => ({
        id:   p.player_id,
        name: p.player_name,
      })),
    };
  });

  // Compute team-level summary, mirroring getEntityStatus() in index.html
  const playingMembers = (t.players || []).filter(p => !isNpc(p));
  const hasRefusal     = cards.some(c => c.statusKind === 'refused');
  const cardCount      = cards.length;

  let summary = { kind: 'red',    label: 'No System Cards' };
  if (hasRefusal) {
    summary = { kind: 'red', label: 'File issue' };
  } else if (cardCount > 0) {
    const playersWithCards = new Set();
    for (const c of cards) {
      // Skip replaced (older versions) when checking coverage
      if (c.replaced) continue;
      for (const p of c.players) playersWithCards.add(String(p.id));
    }
    const everyoneCovered = playingMembers.length > 0 &&
      playingMembers.every(p => playersWithCards.has(String(p.wbfId)));
    const allAccepted = cards.every(c => c.statusKind === 'accepted');

    if (everyoneCovered && allAccepted) {
      summary = { kind: 'green',  label: `${cardCount} System Card(s) - Complete` };
    } else if (everyoneCovered) {
      summary = { kind: 'yellow', label: `${cardCount} System Card(s) - Pending file check` };
    } else {
      summary = { kind: 'yellow', label: `${cardCount} System Card(s) - Missing` };
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

function displayStatus(raw) {
  if (raw === 'accepted')  return { kind: 'accepted', label: '✓ File accepted' };
  if (raw === 'refused')   return { kind: 'refused',  label: '✗ File issue' };
  return                          { kind: 'pending',  label: 'Pending file check' };
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

function stripHtml(html) {
  return String(html)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, '')
    .trim();
}
