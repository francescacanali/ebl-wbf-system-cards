import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const R2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

function verifyToken(token) {
  try {
    const [payload] = token.split('.');
    const data = JSON.parse(Buffer.from(payload, 'base64').toString());
    if (data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

async function getAdminData(tournament, event) {
  try {
    const key = `${tournament}/admin/${encodeURIComponent(event)}.json`;
    const response = await R2.send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
    }));
    const body = await response.Body.transformToString();
    return JSON.parse(body);
  } catch (error) {
    // File doesn't exist yet
    return { validationStatus: {}, completionStatus: {} };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  // Verify token
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const token = authHeader.substring(7);
  const tokenData = verifyToken(token);
  if (!tokenData) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  
  const tournament = req.query.tournament || tokenData.tournament;
  const event = req.query.event || tokenData.event;
  
  try {
    const data = await getAdminData(tournament, event);
    return res.status(200).json(data);
  } catch (error) {
    console.error('Error loading admin data:', error);
    return res.status(500).json({ error: 'Failed to load data' });
  }
}
