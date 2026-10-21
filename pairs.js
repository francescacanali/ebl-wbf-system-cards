// api/pairs.js - Legge configurazione da R2 e parserizza la tabella coppie
// Supporta sia il formato VECCHIO (Event | [ID] | Pair | Roster)
// sia il NUOVO formato (Event | ID | Pair | Country | Submitted by | Email | Code)
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const R2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET || 'system-cards-01';
const CONFIG_KEY = 'config/tournaments.json';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const tournamentCode = req.query.tournament || '26prague';

  try {
    const config = await getConfig();
    const tournament = config.tournaments[tournamentCode];

    if (!tournament || !tournament.pairsUrl) {
      return res.status(200).json({ pairs: [] });
    }

    const response = await fetch(tournament.pairsUrl);
    const html = await response.text();
    const pairs = parsePairsHtml(html);

    return res.status(200).json({ pairs, org: tournament.org || 'ebl' });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Failed to fetch pairs: ' + error.message });
  }
}

async function getConfig() {
  try {
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: CONFIG_KEY });
    const response = await R2.send(command);
    const body = await response.Body.transformToString();
    return JSON.parse(body);
  } catch (error) {
    return {
      tournaments: {
        '26prague': {
          pairsUrl: 'https://db.eurobridge.org/repository/competitions/26Prague/Reg/displaypairsparticip.asp'
        },
        '26riga': {
          pairsUrl: 'https://db.eurobridge.org/repository/competitions/26riga/Reg/displaypairsparticip.asp'
        }
      }
    };
  }
}

// ---------- PARSER ----------

function parsePairsHtml(html) {
  // Detect table format
  // NEW format signature: has "Country" column header, no "Roster" column
  // OLD format signature: has "Roster" column, optional "ID" column
  const hasRosterHeader  = /<t[hd][^>]*>\s*Roster\s*<\/t[hd]>/i.test(html);
  const hasCountryHeader = /<t[hd][^>]*>\s*Country\s*<\/t[hd]>/i.test(html);
  const hasIdHeader      = /<t[hd][^>]*>\s*ID\s*<\/t[hd]>/i.test(html);

  const isNewFormat = hasCountryHeader && !hasRosterHeader;

  return isNewFormat
    ? parseNewFormat(html)
    : parseOldFormat(html, hasIdHeader);
}

// NEW: Event | ID | Pair | Country | Submitted by | Email | Code
function parseNewFormat(html) {
  const pairs = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;

  let rowMatch;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowContent = rowMatch[1];
    const cells = [];
    let cellMatch;
    cellRegex.lastIndex = 0;
    while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
      cells.push(stripHtml(cellMatch[1]));
    }

    // At minimum: Event, ID, Pair, Country
    if (cells.length < 4) continue;

    const event       = cells[0];
    const pairId      = cells[1];
    const pairNameRaw = cells[2];
    const country     = cells[3];

    // Skip header & empty rows
    if (!event || event === 'Event' || event === 'Pair') continue;
    if (!pairNameRaw || pairNameRaw === 'Pair') continue;
    if (!/^\d+$/.test(pairId)) continue; // Pair ID must be numeric

    const players = parsePairName(pairNameRaw, pairId);
    if (players.length >= 2) {
      pairs.push({
        id: pairId,
        event,
        name: pairNameRaw,
        country: country || '',
        players: players.slice(0, 2),
        uploadedCards: []
      });
    }
  }

  return pairs;
}

// OLD: Event | [ID] | Pair Name | Roster
function parseOldFormat(html, hasIdHeader) {
  const pairs = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;

  // Auto-detect ID column from data pattern if header missing
  let hasIdColumn = hasIdHeader;
  if (!hasIdColumn) {
    const firstDataRowMatch = /<tr[^>]*>(?:[\s\S]*?<td[^>]*>[\s\S]*?<\/td>){2,}/i.exec(html);
    if (firstDataRowMatch) {
      const cells = [];
      let m;
      const tmp = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      while ((m = tmp.exec(firstDataRowMatch[0])) !== null) {
        cells.push(stripHtml(m[1]));
      }
      if (cells.length >= 2 && /^\d+$/.test(cells[1])) hasIdColumn = true;
    }
  }

  let rowMatch;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowContent = rowMatch[1];
    const cells = [];
    let cellMatch;
    cellRegex.lastIndex = 0;
    while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
      cells.push(stripHtml(cellMatch[1]));
    }

    const minCells = hasIdColumn ? 4 : 3;
    if (cells.length < minCells) continue;

    let event, pairId, pairName, roster;
    if (hasIdColumn) {
      event = cells[0]; pairId = cells[1]; pairName = cells[2]; roster = cells[3];
    } else {
      event = cells[0]; pairName = cells[1]; roster = cells[2];
      pairId = generatePairId(pairName, event);
    }

    if (!pairName || pairName === 'Team Name' || pairName === 'Pair Name' || pairName === 'Pair') continue;
    if (event === 'Event') continue;

    const players = parseRoster(roster);
    if (players.length >= 2) {
      pairs.push({
        id: pairId,
        event,
        name: pairName,
        players: players.slice(0, 2),
        uploadedCards: []
      });
    }
  }

  return pairs;
}

// ---------- HELPERS ----------

// Split "Firstname1 LASTNAME1-Firstname2 LASTNAME2" → two player objects.
// Since Riga pairs table has no individual WBF IDs, we synthesise IDs as
// `${pairId}A` and `${pairId}B` to preserve the existing filename schema
// (WBFID1_SURNAME1_WBFID2_SURNAME2.pdf).
function parsePairName(pairName, pairId) {
  // Greedy match: take as much as possible before a hyphen followed by
  // a "firstname-looking" word (Capitalised + at least one lowercase letter).
  const match = pairName.match(/^(.+)-([A-ZÀ-Ÿ][a-zà-ÿ].*)$/);
  if (!match) return [];

  const p1Str = match[1].trim();
  const p2Str = match[2].trim();

  const p1 = splitNameSurname(p1Str);
  const p2 = splitNameSurname(p2Str);
  if (!p1 || !p2) return [];

  return [
    { fullName: p1Str, surname: p1.surname, wbfId: `${pairId}A`, role: '' },
    { fullName: p2Str, surname: p2.surname, wbfId: `${pairId}B`, role: '' }
  ];
}

// Given "Victoria DI BACCO" → { firstName: "Victoria", surname: "DI BACCO" }
// Given "Antoinette McGEE" → { firstName: "Antoinette", surname: "MCGEE" }
function splitNameSurname(str) {
  const tokens = str.trim().split(/\s+/);
  if (tokens.length === 0) return null;
  if (tokens.length === 1) {
    return { firstName: '', surname: tokens[0].toUpperCase() };
  }

  // First surname-looking token = all uppercase (≥2 chars) OR McGEE-style
  let idx = tokens.findIndex(t =>
    /^[A-ZÀ-Ÿ]{2,}$/.test(t) ||                       // GEMIGNANI, DI, BACCO
    /^[A-ZÀ-Ÿ][a-zà-ÿ]+[A-ZÀ-Ÿ]{2,}$/.test(t)         // McGEE, DeBELLIS
  );
  if (idx < 0) idx = tokens.length - 1; // fallback: last token is surname

  return {
    firstName: tokens.slice(0, idx).join(' '),
    surname:   tokens.slice(idx).join(' ').toUpperCase()
  };
}

function generatePairId(pairName, event) {
  const str = (event + '_' + pairName).toLowerCase().replace(/[^a-z0-9]/g, '');
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString();
}

function stripHtml(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, '')
    .trim();
}

// OLD-format roster parser: "Name (ID) role, Name (ID)"
function parseRoster(rosterText) {
  const players = [];
  const regex = /([A-Za-zÀ-ÿ\s\-'\.]+)\s*\((\d+)\)\s*(captain|coach|npc)?/gi;
  let match;
  const seen = new Set();
  while ((match = regex.exec(rosterText)) !== null) {
    const fullName = match[1].trim();
    const wbfId = match[2];
    const role = match[3] ? match[3].toLowerCase() : '';
    if (!seen.has(wbfId)) {
      seen.add(wbfId);
      const parts = fullName.split(/\s+/);
      const surnameIndex = parts.findIndex(p => p === p.toUpperCase() && p.length > 1);
      const surname = surnameIndex >= 0 ? parts[surnameIndex] : parts[parts.length - 1];
      players.push({ fullName, surname: surname.toUpperCase(), wbfId, role });
    }
  }
  return players;
}
