// api/lookup-tournament.js
//
// Resolves a championship's groupName (= tblTournamentGrouping.EventGroupDescr
// on Fotis's side) to the SC platform's tournament code (e.g. "26riga"),
// using the R2 tournaments.json config as the source of truth.
//
// Used by the team portal: Fotis's IIS doesn't know SC tournament codes,
// but it does know the groupName. The frontend (index.html) calls this
// at boot time when ?groupName= is in the URL, and uses the returned code
// for all subsequent /api/teams, /api/cards, etc. requests.
//
// GET /api/lookup-tournament?groupName=<EventGroupDescr>
// → { tournament: "26riga" }
// → 404 if not found
//
// CORS open since this is called from Fotis's iframe context.

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'GET required' });

  const groupName = req.query.groupName;
  if (!groupName) {
    return res.status(400).json({ error: 'Missing groupName' });
  }

  try {
    const resp = await R2.send(new GetObjectCommand({ Bucket: BUCKET, Key: CONFIG_KEY }));
    const cfg  = JSON.parse(await resp.Body.transformToString());

    const wanted = String(groupName).trim().toLowerCase();
    const code = Object.keys(cfg.tournaments || {}).find(c =>
      String(cfg.tournaments[c].groupName || '').trim().toLowerCase() === wanted
    );

    if (!code) {
      return res.status(404).json({ error: `No tournament with groupName "${groupName}"` });
    }
    return res.status(200).json({ tournament: code });
  } catch (err) {
    console.error('lookup-tournament error:', err);
    return res.status(500).json({ error: err.message });
  }
}
