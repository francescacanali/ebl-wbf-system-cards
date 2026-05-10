import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { updateCardStatus, d1 } from './db.js';
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

async function getAdminData(tournament, event) {
  try {
    const key = `${tournament}/admin/${encodeURIComponent(event)}.json`;
    const response = await R2.send(new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
    }));
    const body = await response.Body.transformToString();
    return JSON.parse(body);
  } catch {
    return { validationStatus: {}, completionStatus: {} };
  }
}

async function saveAdminData(tournament, event, data) {
  const key = `${tournament}/admin/${encodeURIComponent(event)}.json`;
  await R2.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: JSON.stringify(data),
    ContentType: 'application/json',
  }));
}

async function getTournamentConfig(tournamentCode) {
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

// Fetch a card row + its players + sub_event for the Fotis sync.
async function getCardForSync(card_id) {
  const cardRow = await d1(
    `SELECT id, file_name, file_url, sub_event FROM system_cards WHERE id=? LIMIT 1`,
    [card_id]
  );
  const card = cardRow.results?.[0];
  if (!card) return null;
  const playersRes = await d1(
    `SELECT player_id, player_name FROM system_card_players WHERE card_id=?`,
    [card_id]
  );
  return {
    fileName: card.file_name,
    fileUrl:  card.file_url,
    subEvent: card.sub_event,
    players:  playersRes.results || [],
  };
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
    const { tournament, event, fileName, status, card_id, refused_reason, validated_by } = req.body;

    if (!tournament || !event || !fileName || status === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // 1. Update R2 admin data (kept for back-compat with admin.html UI)
    const data = await getAdminData(tournament, event);
    data.validationStatus[fileName] = status;
    await saveAdminData(tournament, event, data);

    // 2. Update D1 -- resolve card_id if the caller didn't pass it
    let resolvedCardId = card_id || null;
    if (!resolvedCardId) {
      try {
        const res2 = await d1(
          `SELECT id FROM system_cards WHERE tournament=? AND file_name=? LIMIT 1`,
          [tournament, fileName]
        );
        resolvedCardId = res2.results?.[0]?.id || null;
      } catch (dbErr) {
        console.error('D1 lookup failed:', dbErr.message);
      }
    }
    if (resolvedCardId) {
      try {
        await updateCardStatus({
          card_id:        resolvedCardId,
          status,
          refused_reason: refused_reason || null,
          validated_by:   validated_by   || null,
        });
      } catch (dbErr) {
        console.error('D1 update failed (R2 update still succeeded):', dbErr.message);
      }
    }

    // 3. Propagate to Fotis tblPlayerEventSC.
    //    'validated'/'accepted' -> upsert with statusint=1 + pdflink
    //    'pending'              -> upsert with statusint=0 + pdflink
    //    'refused'              -> remove (delete row -- "no record" convention)
    let fotisResult = { skipped: 'Fotis sync not attempted' };
    if (resolvedCardId) {
      try {
        const cardInfo      = await getCardForSync(resolvedCardId);
        const tournamentCfg = await getTournamentConfig(tournament);
        if (cardInfo && tournamentCfg) {
          const isAccepted = (status === 'accepted' || status === 'validated');
          const isRefused  = (status === 'refused');
          const action     = isRefused ? 'remove' : 'upsert';
          const statusint  = isAccepted ? 1 : 0;

          const players = (cardInfo.players || []).map(p => ({
            contactinfoid: p.player_id,
            fullName:      p.player_name || null,
            ...(action === 'upsert' ? {
              statusint,
              pdflink: cardInfo.fileUrl || '',
            } : {}),
          }));

          if (players.length) {
            fotisResult = await syncToFotis({
              tournament: tournamentCfg,
              subEvent:   cardInfo.subEvent,
              action,
              players,
            });
          } else {
            fotisResult = { ok: true, skipped: 'No players on card' };
          }
        } else {
          fotisResult = { ok: true, skipped: !cardInfo ? 'No card row' : 'No tournament config' };
        }
      } catch (e) {
        fotisResult = { ok: false, error: e.message };
      }
    }

    if (fotisResult && !fotisResult.ok && !fotisResult.skipped) {
      console.warn('Fotis sync after validate failed (non-fatal):', fotisResult.error);
    } else {
      console.log('Fotis sync after validate:', fotisResult);
    }

    return res.status(200).json({ success: true, fotisSync: fotisResult });

  } catch (error) {
    console.error('Validation error:', error);
    return res.status(500).json({ error: 'Failed to update validation' });
  }
}
