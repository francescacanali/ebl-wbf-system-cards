import crypto from 'crypto';

// Password per ogni evento - MODIFICA QUESTE!
const EVENT_PASSWORDS = {
  '26prague': {
    'Winter Open Teams': 'openteams2026',
    'Winter Swiss Cup': 'swisscup2026',
    'Winter Mixed Teams': 'mixedteams2026',
    'Winter Open BAM': 'openbam2026',
    'Winter Open Pairs': 'openpairs2026',
    'Winter Mixed Pairs': 'mixedpairs2026',
  },
  // Aggiungi altri tornei qui
};

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
  
  try {
    const { tournament, event, password } = req.body;
    
    const tournamentPasswords = EVENT_PASSWORDS[tournament];
    if (!tournamentPasswords) {
      return res.status(401).json({ success: false, error: 'Invalid tournament' });
    }
    
    const correctPassword = tournamentPasswords[event];
    if (!correctPassword || password !== correctPassword) {
      return res.status(401).json({ success: false, error: 'Invalid password' });
    }
    
    // Generate simple token
    const token = crypto.randomBytes(32).toString('hex');
    
    // In production, save this token to verify later
    // For simplicity, we encode tournament+event in token
    const payload = Buffer.from(JSON.stringify({ tournament, event, exp: Date.now() + 86400000 })).toString('base64');
    
    return res.status(200).json({
      success: true,
      token: `${payload}.${token}`
    });
    
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ success: false, error: 'Login failed' });
  }
}
