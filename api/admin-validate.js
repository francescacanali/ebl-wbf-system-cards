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
  } catch {
    return { validationStatus: {}, completionStatus: {} };
  }
}

async function saveAdminData(tournament, event, data) {
  const key = `${tournament}/admin/${encodeURIComponent(event)}.json`;
  await R2.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: JSON.stringify(data),
    ContentType: 'application/json',
  }));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
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
  
  try {
    const { tournament, event, fileName, status } = req.body;
    
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
