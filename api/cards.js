import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

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
  
  try {
    const command = new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET_NAME,
      Prefix: `${tournamentCode}/CC/`
    });
    
    const response = await R2.send(command);
    
    const cards = (response.Contents || []).map(obj => ({
      fileName: obj.Key.split('/').pop(),
      url: `${process.env.R2_PUBLIC_URL}/${obj.Key}`,
      lastModified: obj.LastModified
    }));
    
    return res.status(200).json({ cards });
    
  } catch (error) {
    console.error('List cards error:', error);
    return res.status(500).json({ error: error.message });
  }
}
