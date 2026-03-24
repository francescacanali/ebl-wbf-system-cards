import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';

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
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  const tournamentCode = req.query.tournament || '26prague';
  const eventFolder = req.query.event ? req.query.event.replace(/\s+/g, '_') : '';
  
  try {
    // Load hidden list
    let hiddenSet = new Set();
    try {
      const hiddenRes = await R2.send(new GetObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: `${tournamentCode}/hidden.json`,
      }));
      const hiddenBody = await hiddenRes.Body.transformToString();
      const hiddenList = JSON.parse(hiddenBody);
      hiddenList.forEach(h => hiddenSet.add(h.fileName));
    } catch {
      // No hidden list, that's fine
    }

    const prefix = eventFolder 
      ? `${tournamentCode}/${eventFolder}/`
      : `${tournamentCode}/`;
    
    const command = new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET_NAME,
      Prefix: prefix
    });
    
    const response = await R2.send(command);
    
    const cards = (response.Contents || [])
      .filter(obj => obj.Key.endsWith('.pdf'))
      .filter(obj => {
        const fileName = obj.Key.split('/').pop();
        return !hiddenSet.has(fileName);
      })
      .map(obj => {
        const parts = obj.Key.split('/');
        const fileName = parts.pop();
        const folder = parts.length > 1 ? parts[parts.length - 1] : '';
        return {
          fileName,
          folder,
          url: `${process.env.R2_PUBLIC_URL}/${obj.Key}`,
          lastModified: obj.LastModified
        };
      });
    
    return res.status(200).json({ cards });
    
  } catch (error) {
    console.error('List cards error:', error);
    return res.status(500).json({ error: error.message });
  }
}
