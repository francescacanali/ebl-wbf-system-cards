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
    const { tournament, event, fileName, status } = req.body;

    if (!tournament || !event || !fileName || status === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Load current data
    const data = await getAdminData(tournament, event);

    // Update validation status
    data.validationStatus[fileName] = status;

    // Save
    await saveAdminData(tournament, event, data);

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('Validation error:', error);
    return res.status(500).json({ error: 'Failed to update validation' });
  }
}
