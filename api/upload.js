import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

const R2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

export const config = {
  api: {
    bodyParser: false,
  },
};

// Parse multipart form data
async function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const contentType = req.headers['content-type'];
      const boundary = contentType.split('boundary=')[1];
      
      const parts = {};
      const boundaryBuffer = Buffer.from(`--${boundary}`);
      
      let start = buffer.indexOf(boundaryBuffer) + boundaryBuffer.length + 2;
      
      while (start < buffer.length) {
        const end = buffer.indexOf(boundaryBuffer, start);
        if (end === -1) break;
        
        const part = buffer.slice(start, end - 2);
        const headerEnd = part.indexOf('\r\n\r\n');
        const header = part.slice(0, headerEnd).toString();
        const body = part.slice(headerEnd + 4);
        
        const nameMatch = header.match(/name="([^"]+)"/);
        const filenameMatch = header.match(/filename="([^"]+)"/);
        
        if (nameMatch) {
          const name = nameMatch[1];
          if (filenameMatch) {
            parts[name] = { 
              filename: filenameMatch[1], 
              data: body,
              contentType: header.match(/Content-Type: ([^\r\n]+)/)?.[1] || 'application/octet-stream'
            };
          } else {
            parts[name] = body.toString();
          }
        }
        
        start = end + boundaryBuffer.length + 2;
      }
      
      resolve(parts);
    });
    req.on('error', reject);
  });
}

function validatePDF(buffer) {
  if (buffer.length < 5) {
    return { valid: false, error: 'File too small' };
  }
  
  const header = buffer.slice(0, 5).toString();
  if (header !== '%PDF-') {
    return { valid: false, error: 'Invalid PDF file' };
  }
  
  // Check for suspicious content
  const content = buffer.toString('utf-8', 0, Math.min(buffer.length, 50000));
  const suspicious = [/\/JavaScript/i, /\/JS\s/i, /\/Launch/i, /\/EmbeddedFile/i];
  
  for (const pattern of suspicious) {
    if (pattern.test(content)) {
      return { valid: false, error: 'PDF contains suspicious content' };
    }
  }
  
  return { valid: true };
}

// Reset validation status when a file is overwritten
async function resetValidationStatus(tournamentCode, eventFolder, fileName) {
  try {
    // Convert folder name back to event name format for admin file lookup
    // eventFolder is like "Winter_Mixed_Pairs" -> try to find matching admin file
    const eventName = eventFolder.replace(/_/g, ' ');
    const adminKey = `${tournamentCode}/admin/${encodeURIComponent(eventName)}.json`;
    
    try {
      // Get current admin data
      const getResponse = await R2.send(new GetObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: adminKey,
      }));
      
      const body = await getResponse.Body.transformToString();
      const data = JSON.parse(body);
      
      // Check if this file exists in validation status
      if (data.validationStatus && data.validationStatus[fileName]) {
        // Reset to pending
        delete data.validationStatus[fileName];
        
        // Save back
        await R2.send(new PutObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: adminKey,
          Body: JSON.stringify(data),
          ContentType: 'application/json',
        }));
        
        console.log(`Reset validation status for ${fileName} in ${eventName}`);
      }
    } catch (e) {
      // Admin file doesn't exist for this event, that's ok
      console.log('No admin file found for event:', eventName);
    }
  } catch (error) {
    console.log('Could not reset validation status:', error.message);
  }
}

export default async function handler(req, res) {
  // CORS headers
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
    const parts = await parseMultipart(req);
    
    console.log('Received parts:', Object.keys(parts));
    
    const file = parts.file;
    const tournamentCode = parts.tournamentCode || '26prague';
    const teamName = parts.teamName;
    const fileName = parts.fileName;
    
    if (!file || !teamName || !fileName) {
      console.log('Missing fields - file:', !!file, 'teamName:', teamName, 'fileName:', fileName);
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Validate file size (10MB max)
    if (file.data.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large (max 10MB)' });
    }
    
    // Validate PDF
    const validation = validatePDF(file.data);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }
    
    // Extract event folder from fileName (first part before first underscore with team)
    // fileName format: EVENT_TEAM_ID1_SURNAME1_ID2_SURNAME2.pdf
    // We need to get the event part to create the folder
    const eventFolder = parts.eventFolder || 'CC';
    
    // Upload to R2 with new folder structure: tournament/Event_Folder/filename.pdf
    const key = `${tournamentCode}/${eventFolder}/${fileName}`;
    
    console.log('Uploading to R2:', key);
    
    await R2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: file.data,
      ContentType: 'application/pdf',
      CacheControl: 'public, max-age=31536000',
    }));
    
    // Reset validation status since file was overwritten
    await resetValidationStatus(tournamentCode, eventFolder, fileName);
    
    const publicUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
    
    console.log('Upload successful:', publicUrl);
    
    return res.status(200).json({
      success: true,
      fileName,
      url: publicUrl
    });
    
  } catch (error) {
    console.error('Upload error:', error);
    return res.status(500).json({ error: 'Upload failed: ' + error.message });
  }
}
