import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  getCardPlayersByFileName,
  getOtherCardFileNamesForPlayer,
} from './db.js';
import { syncToFotis } from './fotis-sync.js';

const R2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET     = process.env.R2_BUCKET || 'system-cards-01';
const CONFIG_KEY = 'config/tournaments.json';

async function getTournamentConfigForDelete(tournamentCode) {
  try {
    const resp = await R2.send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME || BUCKET,
      Key: CONFIG_KEY,
    }));
    const body = await resp.Body.transformToString();
    const config = JSON.parse(body);
    return config?.tournaments?.[tournamentCode] || null;
  } catch {
    return null;
  }
}

async function loadHiddenList(tournament) {
  try {
    const resp = await R2.send(new GetObjectCommand({
      Bucket: BUCKET,
      Key: `${tournament}/hidden.json`,
    }));
    const body = await resp.Body.transformToString();
    return JSON.parse(body);
  } catch {
    return [];
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { tournament, eventFolder, fileName } = req.body;

    if (!tournament || !fileName) {
      return res.status(400).json({ error: 'Missing tournament or fileName' });
    }

    // 1. Look up the card's players + sub_event BEFORE hiding it
    let cardPlayers = [];
    let cardSubEvent = null;
    try {
      const info = await getCardPlayersByFileName(tournament, fileName);
      cardPlayers  = info.players || [];
      cardSubEvent = info.card?.sub_event || null;
    } catch (e) {
      console.warn('Could not load card players from D1:', e.message);
    }

    // 2. Add to hidden list in R2 (existing behaviour)
    const hiddenKey = `${tournament}/hidden.json`;
    const hiddenList = await loadHiddenList(tournament);

    const entry = {
      fileName,
      eventFolder: eventFolder || 'CC',
      hiddenAt: new Date().toISOString(),
    };
    if (!hiddenList.find(h => h.fileName === fileName)) {
      hiddenList.push(entry);
    }

    await R2.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: hiddenKey,
      Body: JSON.stringify(hiddenList),
      ContentType: 'application/json',
    }));

    // 3. Sync to Fotis: for each player on the deleted card, send
    //    "remove" only if they have NO other (non-hidden) card for the
    //    same sub_event.
    let fotisResult = { skipped: 'No D1 card players found' };
    if (cardPlayers.length && cardSubEvent) {
      try {
        const tournamentCfg = await getTournamentConfigForDelete(tournament);
        if (tournamentCfg) {
          const hiddenSet = new Set(hiddenList.map(h => h.fileName));
          const playersToRemove = [];
          for (const p of cardPlayers) {
            const others = await getOtherCardFileNamesForPlayer(
              tournament, cardSubEvent, p.player_id, fileName
            );
            const visibleOthers = others.filter(fn => !hiddenSet.has(fn));
            if (visibleOthers.length === 0) {
              playersToRemove.push({
                contactinfoid: p.player_id,
                fullName: p.player_name || null,
              });
            }
          }
          if (playersToRemove.length) {
            fotisResult = await syncToFotis({
              tournament: tournamentCfg,
              subEvent: cardSubEvent,
              action: 'remove',
              players: playersToRemove,
            });
          } else {
            fotisResult = { ok: true, applied: [], skipped: 'Players still have other cards' };
          }
        } else {
          fotisResult = { ok: true, skipped: 'No tournament config' };
        }
      } catch (e) {
        fotisResult = { ok: false, error: e.message };
      }
    }

    if (!fotisResult.ok && !fotisResult.skipped) {
      console.warn('Fotis sync after delete failed (non-fatal):', fotisResult.error);
    } else {
      console.log('Fotis sync after delete:', fotisResult);
    }

    return res.status(200).json({ success: true, hidden: fileName, fotisSync: fotisResult });

  } catch (error) {
    console.error('Hide error:', error);
    return res.status(500).json({ error: 'Failed to hide file' });
  }
}
