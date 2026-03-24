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

    // Instead of deleting, add to hidden list in R2
    const hiddenKey = `${tournament}/hidden.json`;
    
    let hiddenList = [];
    try {
      const response = await R2.send(new GetObjectCommand({
        Bucket: BUCKET,
        Key: hiddenKey,
      }));
      const body = await response.Body.transformToString();
      hiddenList = JSON.parse(body);
    } catch {
      // No hidden list yet, start fresh
    }

    // Add with folder info for reference
    const entry = { fileName, eventFolder: eventFolder || 'CC', hiddenAt: new Date().toISOString() };
    if (!hiddenList.find(h => h.fileName === fileName)) {
      hiddenList.push(entry);
    }

    await R2.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: hiddenKey,
      Body: JSON.stringify(hiddenList),
      ContentType: 'application/json',
    }));

    return res.status(200).json({ success: true, hidden: fileName });

  } catch (error) {
    console.error('Hide error:', error);
    return res.status(500).json({ error: 'Failed to hide file' });
  }
}
