import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const R2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  const tournament = req.query.tournament || '26prague';
  const event = req.query.event || '';
  
  try {
    const key = `${tournament}/admin/${encodeURIComponent(event)}.json`;
    const response = await R2.send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
    }));
    const body = await response.Body.transformToString();
    const data = JSON.parse(body);
    
    // Return only validation status (not completion - that's admin only)
    return res.status(200).json({
      status: data.validationStatus || {}
    });
    
  } catch (error) {
    // File doesn't exist - return empty
    return res.status(200).json({ status: {} });
  }
}
