// api/teams.js - Legge configurazione da R2
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

    if (!tournament || !tournament.teamsUrl) {
      return res.status(200).json({ teams: [] });
    }

    // Fetch teams from Fotis
    const response = await fetch(tournament.teamsUrl);
    const html = await response.text();
    const teams = parseTeamsHtml(html);

    return res.status(200).json({ teams });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Failed to fetch teams: ' + error.message });
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
          teamsUrl: 'https://db.eurobridge.org/repository/competitions/26prague/Reg/displayteamsparticipanalytical.asp'
        },
        '26youthonline': {
          teamsUrl: 'https://db.eurobridge.org/repository/competitions/26youthonline/Reg/displayteamsparticipanalytical.asp'
        },
        'womenonline26': {
          teamsUrl: 'https://db.worldbridge.org/Repository/tourn/womenonline.26/Reg/fullentriesreview.asp'
        }
      }
    };
  }
}

function parseTeamsHtml(html) {
  const teams = [];

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;

  // Detect if table has ID column by checking for ID header in th or td
  // Also check if second column contains numeric IDs
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
    // With ID column: Event, ID, Team Name, Roster, ...
    // Without ID column: Event, Team Name, Roster, ...
    const minCells = hasIdColumn ? 4 : 3;
    
    if (cells.length >= minCells) {
      let event, teamId, teamName, roster;
      
      if (hasIdColumn) {
        event = cells[0];
        teamId = cells[1];
        teamName = cells[2];
        roster = cells[3];
      } else {
        event = cells[0];
        teamName = cells[1];
        roster = cells[2];
        // Generate a unique ID from team name if no ID column
        teamId = generateTeamId(teamName, event);
      }

      if (!teamName || teamName === 'Team Name' || teamName === 'Team') continue;
      // Skip header rows - check if it looks like a header
      if (event === 'Event' || teamName === 'Team Name') continue;

      const players = parseRoster(roster);

      if (players.length >= 2) {
        teams.push({
          id: teamId,
          event,
          name: teamName,
          players,
          uploadedCards: []
        });
      }
    }
  }

  return teams;
}

function generateTeamId(teamName, event) {
  // Create a consistent ID from team name and event
  const str = (event + '_' + teamName).toLowerCase().replace(/[^a-z0-9]/g, '');
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
  // Match: Name (ID) optional_role
  // Role can be: captain, coach, npc
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

      let surname;
      if (surnameIndex >= 0) {
        surname = parts[surnameIndex];
      } else {
        surname = parts[parts.length - 1];
      }

      players.push({
        fullName,
        surname: surname.toUpperCase(),
        wbfId,
        role
      });
    }
  }

  return players;
}
