// api/pairs.js - Legge configurazione da R2
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
    // Get config from R2
    const config = await getConfig();
    const tournament = config.tournaments[tournamentCode];

    if (!tournament || !tournament.pairsUrl) {
      return res.status(200).json({ pairs: [] });
    }

    // Fetch pairs from Fotis
    const response = await fetch(tournament.pairsUrl);
    const html = await response.text();
    const pairs = parsePairsHtml(html);

    return res.status(200).json({ pairs });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Failed to fetch pairs: ' + error.message });
  }
}

async function getConfig() {
  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET,
      Key: CONFIG_KEY,
    });
    const response = await R2.send(command);
    const body = await response.Body.transformToString();
    return JSON.parse(body);
  } catch (error) {
    // Return default config if not found
    return {
      tournaments: {
        '26prague': {
          pairsUrl: 'https://db.eurobridge.org/repository/competitions/26Prague/Reg/displaypairsparticip.asp'
        }
      }
    };
  }
}

function parsePairsHtml(html) {
  const pairs = [];

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;

  // Detect if table has ID column by checking for ID header in th or td
  const hasIdColumnHeader = /<t[hd][^>]*>\s*ID\s*<\/t[hd]>/i.test(html);
  
  // Alternative: check first data row to see if second column is numeric
  let hasIdColumn = hasIdColumnHeader;
  
  // If not detected via header, try to detect from data pattern
  if (!hasIdColumn) {
    const firstDataRowMatch = /<tr[^>]*>(?:[\s\S]*?<td[^>]*>[\s\S]*?<\/td>){2,}/i.exec(html);
    if (firstDataRowMatch) {
      const cells = [];
      let cellMatch;
      const tempRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      while ((cellMatch = tempRegex.exec(firstDataRowMatch[0])) !== null) {
        cells.push(stripHtml(cellMatch[1]));
      }
      // If second cell is a number, we have an ID column
      if (cells.length >= 2 && /^\d+$/.test(cells[1])) {
        hasIdColumn = true;
      }
    }
  }

  let rowMatch;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowContent = rowMatch[1];
    const cells = [];
    let cellMatch;

    while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
      cells.push(stripHtml(cellMatch[1]));
    }

    // Adjust column indices based on whether ID column exists
    const minCells = hasIdColumn ? 4 : 3;

    if (cells.length >= minCells) {
      let event, pairId, pairName, roster;

      if (hasIdColumn) {
        event = cells[0];
        pairId = cells[1];
        pairName = cells[2];
        roster = cells[3];
      } else {
        event = cells[0];
        pairName = cells[1];
        roster = cells[2];
        // Generate a unique ID from pair name if no ID column
        pairId = generatePairId(pairName, event);
      }

      if (!pairName || pairName === 'Team Name' || pairName === 'Pair Name' || pairName === 'Pair') continue;
      // Skip header rows
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
  }

  return pairs;
}

function generatePairId(pairName, event) {
  // Create a consistent ID from pair name and event
  const str = (event + '_' + pairName).toLowerCase().replace(/[^a-z0-9]/g, '');
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
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

function parseRoster(rosterText) {
  const players = [];
  const regex = /([A-Za-zÀ-ÿ\s\-'\.]+)\s*\((\d+)\)/g;
  let match;
  const seen = new Set();

  while ((match = regex.exec(rosterText)) !== null) {
    const fullName = match[1].trim();
    const wbfId = match[2];

    if (!seen.has(wbfId)) {
      seen.add(wbfId);

      const parts = fullName.split(/\s+/);
      const surnameIndex = parts.findIndex(p => p === p.toUpperCase() && p.length > 1);

      let surname;
      if (surnameIndex >= 0) {
        surname = parts[surnameIndex];
      } else {
        surname = parts[parts.length - 1];
      }

      players.push({
        fullName,
        surname: surname.toUpperCase(),
        wbfId
      });
    }
  }

  return players;
}
