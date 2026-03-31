// api/sync-db.js
// Syncs all PDF files from R2 into the D1 database
// Call once to backfill missing records
//
// GET /api/sync-db?tournament=26riga&api_key=YOUR_SYNC_KEY
// GET /api/sync-db?tournament=26riga&dry_run=1&api_key=YOUR_SYNC_KEY  (preview only)

import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { d1, saveCard } from './db.js';

const R2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET   = process.env.R2_BUCKET_NAME;
const SYNC_KEY = process.env.SYNC_API_KEY || 'change-this-key';

// Try to extract WBF player IDs from filename
// e.g. CANIRL_230755_BURNS_234451_CROCKER.pdf → [230755, 234451]
// e.g. BAKKE_30303_BERG_17813.pdf → [30303, 17813]
function parsePlayerIdsFromFilename(fileName) {
  const name = fileName.replace(/\.pdf$/i, '');
  const parts = name.split('_');
  const ids = [];
  const names = [];

  // IDs are typically 4-6 digit numbers between name parts
  for (let i = 0; i < parts.length; i++) {
    const n = parseInt(parts[i]);
    if (!isNaN(n) && parts[i].length >= 4 && parts[i].length <= 7) {
      ids.push(n);
      // The name is the part before the ID
      if (i > 0 && isNaN(parseInt(parts[i-1]))) {
        names.push(parts[i-1]);
      }
    }
  }
  return { ids, names };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  // Auth
  const apiKey  = req.query.api_key;
  if (apiKey !== SYNC_KEY) return res.status(401).json({ error: 'Unauthorized' });

  const tournament = req.query.tournament;
  if (!tournament) return res.status(400).json({ error: 'Missing tournament' });

  const dryRun = req.query.dry_run === '1';

  try {
    // 1. Get all PDFs from R2 for this tournament
    const command = new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: `${tournament}/`,
    });
    const r2Response = await R2.send(command);
    const allFiles = (r2Response.Contents || []).filter(f => f.Key.endsWith('.pdf'));

    // 2. Get all filenames already in DB for this tournament
    const existing = await d1(
      `SELECT file_name FROM system_cards WHERE tournament=?`,
      [tournament]
    );
    const existingNames = new Set((existing.results || []).map(r => r.file_name));

    // 3. Find missing files
    const missing = allFiles.filter(f => {
      const fileName = f.Key.split('/').pop();
      return !existingNames.has(fileName);
    });

    if (dryRun) {
      return res.status(200).json({
        dry_run: true,
        tournament,
        total_in_r2:   allFiles.length,
        already_in_db: existingNames.size,
        missing:       missing.length,
        files_to_sync: missing.map(f => ({
          key:           f.Key,
          file_name:     f.Key.split('/').pop(),
          last_modified: f.LastModified,
        })),
      });
    }

    // 4. Insert missing files
    const results = [];
    for (const file of missing) {
      const parts    = file.Key.split('/');
      const fileName = parts.pop();
      const eventFolder = parts.length > 1 ? parts[parts.length - 1] : null;
      const subEvent    = eventFolder ? eventFolder.replace(/_/g, ' ') : null;
      const fileUrl     = `${process.env.R2_PUBLIC_URL}/${file.Key}`;
      const { ids, names } = parsePlayerIdsFromFilename(fileName);

      try {
        const cardId = await saveCard({
          tournament,
          sub_event:    subEvent,
          event_folder: eventFolder,
          file_name:    fileName,
          file_url:     fileUrl,
          player_ids:   ids,
          player_names: names,
        });
        results.push({ file_name: fileName, card_id: cardId, player_ids: ids, status: 'inserted' });
      } catch (err) {
        results.push({ file_name: fileName, status: 'error', error: err.message });
      }
    }

    return res.status(200).json({
      tournament,
      total_in_r2:   allFiles.length,
      already_in_db: existingNames.size,
      synced:        results.filter(r => r.status === 'inserted').length,
      errors:        results.filter(r => r.status === 'error').length,
      results,
    });

  } catch (err) {
    console.error('sync-db error:', err);
    return res.status(500).json({ error: err.message });
  }
}
