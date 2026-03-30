import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { saveCard } from './db.js';

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

// Find next available versioned filename: A.pdf -> A_v2.pdf -> A_v3.pdf etc.
async function findVersionedFileName(tournamentCode, eventFolder, baseFileName) {
  const namePart = baseFileName.replace(/\.pdf$/i, '');
  const originalKey = `${tournamentCode}/${eventFolder}/${baseFileName}`;
  try {
    await R2.send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: originalKey }));
    // Original exists — find next free version
    for (let v = 2; v <= 99; v++) {
      const vName = `${namePart}_v${v}.pdf`;
      try {
        await R2.send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: `${tournamentCode}/${eventFolder}/${vName}` }));
        // This version also exists, try next
      } catch {
        return vName; // free slot found
      }
    }
    return `${namePart}_v2.pdf`;
  } catch {
    return baseFileName; // original doesn't exist yet
  }
}


// Reset validation status when a file is overwritten
async function resetValidationStatus(tournamentCode, eventFolder, fileName, eventNameParam) {
  try {
    // Convert folder name back to event name format for admin file lookup
    // eventFolder is like "Winter_Mixed_Pairs" -> try to find matching admin file
    const eventName = eventNameParam || eventFolder.replace(/_/g, ' ');
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
    
    // Extract event folder from fileName
    const eventFolder = parts.eventFolder || 'CC';
    
    // Find versioned filename (A.pdf -> A_v2.pdf if A.pdf already exists)
    const versionedFileName = await findVersionedFileName(tournamentCode, eventFolder, fileName);
    
    // Upload to R2 with versioned filename
    const key = `${tournamentCode}/${eventFolder}/${versionedFileName}`;
    
    console.log('Uploading to R2:', key);
    
    await R2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: file.data,
      ContentType: 'application/pdf',
      CacheControl: 'public, max-age=31536000',
    }));
    
    // No reset needed: each version has its own filename and starts as pending automatically.
    // v1 keeps its validation status (e.g. refused) unchanged.
    
    const publicUrl = `${process.env.R2_PUBLIC_URL}/${key}`;

    console.log('Upload successful:', publicUrl);

    // Save to D1 database
    // player_ids and player_names come from the form (array of WBF IDs and names)
    const playerIds   = parts.player_ids   ? JSON.parse(parts.player_ids)   : [];
    const playerNames = parts.player_names ? JSON.parse(parts.player_names) : [];
    const subEvent    = parts.subEvent || parts.eventFolder?.replace(/_/g, ' ') || null;

    try {
      const cardId = await saveCard({
        tournament:   tournamentCode,
        sub_event:    subEvent,
        event_folder: eventFolder,
        file_name:    versionedFileName,
        file_url:     publicUrl,
        player_ids:   playerIds,
        player_names: playerNames,
      });
      console.log('Saved to D1, card id:', cardId);
    } catch (dbErr) {
      // DB write failure should not block the upload response
      console.error('D1 write failed (upload still succeeded):', dbErr.message);
    }

    return res.status(200).json({
      success: true,
      fileName: versionedFileName,
      url: publicUrl
    });
    
  } catch (error) {
    console.error('Upload error:', error);
    return res.status(500).json({ error: 'Upload failed: ' + error.message });
  }
}
