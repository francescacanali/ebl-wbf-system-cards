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

  let rowMatch;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowContent = rowMatch[1];
    const cells = [];
    let cellMatch;

    while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
      cells.push(stripHtml(cellMatch[1]));
    }

    if (cells.length >= 4) {
      const event = cells[0];
      const pairId = cells[1];
      const pairName = cells[2];
      const roster = cells[3];

      if (!pairName || pairName === 'Team Name' || pairName === 'Pair Name' || !pairId || isNaN(parseInt(pairId))) continue;

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
