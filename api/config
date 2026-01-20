// api/config.js - Gestisce configurazione tornei su R2
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

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

// Default configuration
const DEFAULT_CONFIG = {
  tournaments: {
    '26prague': {
      name: 'European Winter Transnational Championships 2026 - Prague',
      org: 'ebl',
      teamsUrl: 'https://db.eurobridge.org/repository/competitions/26prague/Reg/displayteamsparticipanalytical.asp',
      pairsUrl: 'https://db.eurobridge.org/repository/competitions/26Prague/Reg/displaypairsparticip.asp'
    },
    '26youthonline': {
      name: 'European Youth Online Championships 2026',
      org: 'ebl',
      teamsUrl: 'https://db.eurobridge.org/repository/competitions/26youthonline/Reg/displayteamsparticipanalytical.asp',
      pairsUrl: null
    },
    'womenonline26': {
      name: "Women's Online World Championship 2026",
      org: 'wbf',
      teamsUrl: 'https://db.worldbridge.org/Repository/tourn/womenonline.26/Reg/fullentriesreview.asp',
      pairsUrl: null
    }
  }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    // Get configuration
    try {
      const config = await getConfig();
      return res.status(200).json(config);
    } catch (error) {
      console.error('Error getting config:', error);
      return res.status(500).json({ error: 'Failed to get config' });
    }
  }

  if (req.method === 'POST') {
    // Save configuration
    try {
      const { action, tournamentCode, tournamentData } = req.body;

      let config = await getConfig();

      if (action === 'add' || action === 'update') {
        if (!tournamentCode || !tournamentData) {
          return res.status(400).json({ error: 'Missing tournamentCode or tournamentData' });
        }
        config.tournaments[tournamentCode] = tournamentData;
      } else if (action === 'delete') {
        if (!tournamentCode) {
          return res.status(400).json({ error: 'Missing tournamentCode' });
        }
        delete config.tournaments[tournamentCode];
      } else {
        return res.status(400).json({ error: 'Invalid action' });
      }

      await saveConfig(config);
      return res.status(200).json({ success: true, config });

    } catch (error) {
      console.error('Error saving config:', error);
      return res.status(500).json({ error: 'Failed to save config' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
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
    if (error.name === 'NoSuchKey') {
      // Config doesn't exist yet, create with defaults
      await saveConfig(DEFAULT_CONFIG);
      return DEFAULT_CONFIG;
    }
    throw error;
  }
}

async function saveConfig(config) {
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: CONFIG_KEY,
    Body: JSON.stringify(config, null, 2),
    ContentType: 'application/json',
  });
  await R2.send(command);
}
