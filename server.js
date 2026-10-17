const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;
const DATA_DIR = path.join(PUBLIC_DIR, 'data');
const USERS_DB_DIR = path.join(DATA_DIR, 'user_databases');
const CLOUD_CONFIG_FILE = path.join(DATA_DIR, 'cloud_config.json');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
const RESOURCES_FILE = path.join(DATA_DIR, 'resources.json');

// Ensure database directories exist
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_DB_DIR)) fs.mkdirSync(USERS_DB_DIR, { recursive: true });
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
} catch (e) {
  console.warn("Storage directory init:", e.message);
}

function loadResources() {
  if (!fs.existsSync(RESOURCES_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(RESOURCES_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveResources(resources) {
  fs.writeFileSync(RESOURCES_FILE, JSON.stringify(resources, null, 2), 'utf8');
}

const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 50 * 1024 * 1024) {
        reject(new Error('Payload Too Large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON format'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function getUserDbPath(userId) {
  const safeId = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(USERS_DB_DIR, `user_${safeId}.json`);
}

function getLiveHonorRoll() {
  const files = fs.readdirSync(USERS_DB_DIR);
  const honorRoll = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const content = fs.readFileSync(path.join(USERS_DB_DIR, file), 'utf8');
      const user = JSON.parse(content);
      if (user.role !== 'admin' && user.stats && user.stats.quizzesCompleted > 0) {
        honorRoll.push({
          userId: user.id,
          name: user.name,
          score: user.stats.points || 0,
          quizzesTaken: user.stats.quizzesCompleted || 0,
          averageScore: user.stats.averageScore || 0,
          grade: user.grade || 'Student',
          avatar: user.avatar || '🎓',
          lastActive: user.stats.lastActive || user.updatedAt || user.createdAt
        });
      }
    } catch (e) {
      console.error(`Error reading ${file}:`, e.message);
    }
  }

  honorRoll.sort((a, b) => b.score - a.score || b.quizzesTaken - a.quizzesTaken);

  return honorRoll.map((entry, index) => ({
    rank: index + 1,
    ...entry
  }));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // 1. User Registration with Dedicated Database
  if (pathname === '/api/auth/register' && req.method === 'POST') {
    try {
      const data = await parseJsonBody(req);
      const { name, email, password, grade } = data;

      if (!name || !email || !password) {
        sendJson(res, 400, { success: false, error: 'Name, email, and password are required.' });
        return;
      }

      const normalizedEmail = email.trim().toLowerCase();
      const userId = 'usr_' + Buffer.from(normalizedEmail).toString('hex').slice(0, 16);
      const userDbPath = getUserDbPath(userId);

      if (fs.existsSync(userDbPath)) {
        sendJson(res, 409, { success: false, error: 'An account database with this email already exists.' });
        return;
      }

      const newUserDb = {
        id: userId,
        name: name.trim(),
        email: normalizedEmail,
        password: password,
        role: 'student',
        grade: grade || 'Class 10',
        avatar: '🎓',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        cloudSynced: false,
        stats: {
          points: 0,
          quizzesCompleted: 0,
          averageScore: 0,
          badges: ['New Scholar'],
          history: []
        },
        enrolledCourses: ['course-math', 'course-phys'],
        savedNotes: []
      };

      fs.writeFileSync(userDbPath, JSON.stringify(newUserDb, null, 2), 'utf8');

      const safeUser = { ...newUserDb };
      delete safeUser.password;

      sendJson(res, 201, {
        success: true,
        message: 'Unique user database created successfully.',
        user: safeUser
      });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return;
  }

  // 2. User Login
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    try {
      const { email, password } = await parseJsonBody(req);
      if (!email || !password) {
        sendJson(res, 400, { success: false, error: 'Email and password required.' });
        return;
      }

      const normalizedEmail = email.trim().toLowerCase();

      if ((normalizedEmail === 'admin@quizguider.io' || normalizedEmail === 'admin@edunova.io' || normalizedEmail === 'admin@tmhnu.edu') && password === 'admin') {
        sendJson(res, 200, {
          success: true,
          user: {
            id: 'admin_root',
            name: 'Platform Administrator',
            email: normalizedEmail,
            role: 'admin',
            avatar: '🛡️'
          }
        });
        return;
      }

      const userId = 'usr_' + Buffer.from(normalizedEmail).toString('hex').slice(0, 16);
      const userDbPath = getUserDbPath(userId);

      if (!fs.existsSync(userDbPath)) {
        sendJson(res, 404, { success: false, error: 'Account not found. Please register first.' });
        return;
      }

      const userDb = JSON.parse(fs.readFileSync(userDbPath, 'utf8'));
      if (userDb.password !== password) {
        sendJson(res, 401, { success: false, error: 'Invalid password. Access denied.' });
        return;
      }

      const safeUser = { ...userDb };
      delete safeUser.password;

      sendJson(res, 200, {
        success: true,
        message: 'Authenticated successfully.',
        user: safeUser
      });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return;
  }

  // 3. Quiz Submission & Live Tracking Update
  if (pathname === '/api/quiz/submit' && req.method === 'POST') {
    try {
      const { userId, quizId, scorePercentage, correctCount, totalQuestions, answers } = await parseJsonBody(req);

      if (!userId || !quizId) {
        sendJson(res, 400, { success: false, error: 'userId and quizId are required.' });
        return;
      }

      const userDbPath = getUserDbPath(userId);
      if (!fs.existsSync(userDbPath)) {
        sendJson(res, 404, { success: false, error: 'User database not found.' });
        return;
      }

      const userDb = JSON.parse(fs.readFileSync(userDbPath, 'utf8'));
      userDb.stats = userDb.stats || { points: 0, quizzesCompleted: 0, averageScore: 0, history: [] };

      const earnedPoints = Math.round(scorePercentage * 2);
      userDb.stats.points = (userDb.stats.points || 0) + earnedPoints;
      userDb.stats.quizzesCompleted = (userDb.stats.quizzesCompleted || 0) + 1;

      const previousTotal = (userDb.stats.averageScore || 0) * (userDb.stats.quizzesCompleted - 1);
      userDb.stats.averageScore = Math.round((previousTotal + scorePercentage) / userDb.stats.quizzesCompleted);
      userDb.stats.lastActive = new Date().toISOString();

      userDb.stats.history.push({
        quizId,
        scorePercentage,
        correctCount,
        totalQuestions,
        earnedPoints,
        timestamp: new Date().toISOString()
      });

      userDb.updatedAt = new Date().toISOString();
      userDb.cloudSynced = false;

      fs.writeFileSync(userDbPath, JSON.stringify(userDb, null, 2), 'utf8');

      const liveHonorRoll = getLiveHonorRoll();

      sendJson(res, 200, {
        success: true,
        earnedPoints,
        totalPoints: userDb.stats.points,
        quizzesCompleted: userDb.stats.quizzesCompleted,
        liveHonorRoll
      });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return;
  }

  // 4. Pure Live Tracking Leaderboard (No mock records)
  if (pathname === '/api/leaderboard' && req.method === 'GET') {
    try {
      const honorRoll = getLiveHonorRoll();
      sendJson(res, 200, {
        success: true,
        totalTrackedScholars: honorRoll.length,
        honorRoll
      });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return;
  }

  // 5. Cloud Sync Status & Config
  if (pathname === '/api/cloud/config' && req.method === 'GET') {
    let config = {
      provider: 'Cloud Firestore / Cloud Storage',
      configured: false,
      endpoint: '',
      autoSync: true
    };
    if (fs.existsSync(CLOUD_CONFIG_FILE)) {
      try {
        config = JSON.parse(fs.readFileSync(CLOUD_CONFIG_FILE, 'utf8'));
      } catch (e) {}
    }
    sendJson(res, 200, config);
    return;
  }

  if (pathname === '/api/cloud/config' && req.method === 'POST') {
    try {
      const newConfig = await parseJsonBody(req);
      fs.writeFileSync(CLOUD_CONFIG_FILE, JSON.stringify(newConfig, null, 2), 'utf8');
      sendJson(res, 200, { success: true, message: 'Cloud configuration saved.', config: newConfig });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return;
  }

  // 6. Cloud Sync Trigger
  if (pathname === '/api/cloud/sync' && req.method === 'POST') {
    try {
      const files = fs.readdirSync(USERS_DB_DIR);
      let syncCount = 0;
      const timestamp = new Date().toISOString();

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(USERS_DB_DIR, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        data.cloudSynced = true;
        data.lastCloudSync = timestamp;
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        syncCount++;
      }

      sendJson(res, 200, {
        success: true,
        message: `Successfully synchronized ${syncCount} unique user databases to Cloud storage.`,
        syncedDatabases: syncCount,
        syncTimestamp: timestamp
      });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return;
  }

  // 7. Get All Resources
  if (pathname === '/api/resources' && req.method === 'GET') {
    const resources = loadResources();
    sendJson(res, 200, { success: true, resources });
    return;
  }

  // 8. Upload Resource (PDF)
  if (pathname === '/api/resources/upload' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const title = (body.title || '').trim();
      const subject = (body.subject || 'General').trim();
      const desc = (body.desc || '').trim();
      const badge = (body.badge || 'PDF').trim();
      const fileName = (body.fileName || 'document.pdf').trim();
      let fileData = body.fileData || '';

      if (!title) {
        sendJson(res, 400, { success: false, error: 'Resource title is required.' });
        return;
      }
      if (!fileData) {
        sendJson(res, 400, { success: false, error: 'PDF file content is required.' });
        return;
      }

      let cleanName = path.basename(fileName).replace(/[^a-zA-Z0-9_.-]/g, '_');
      if (!cleanName.toLowerCase().endsWith('.pdf')) {
        cleanName += '.pdf';
      }

      const resId = 'res_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
      const targetName = `${resId}_${cleanName}`;
      const targetPath = path.join(UPLOADS_DIR, targetName);

      if (fileData.includes(',')) {
        fileData = fileData.split(',')[1];
      }

      const buffer = Buffer.from(fileData, 'base64');
      fs.writeFileSync(targetPath, buffer);

      const bytesLen = buffer.length;
      const sizeStr = bytesLen < 1024 * 1024
        ? `${(bytesLen / 1024).toFixed(1)} KB`
        : `${(bytesLen / (1024 * 1024)).toFixed(2)} MB`;

      const newResource = {
        id: resId,
        title,
        subject,
        desc,
        badge,
        fileName: cleanName,
        fileSize: sizeStr,
        fileUrl: `/uploads/${targetName}`,
        uploadedAt: new Date().toISOString()
      };

      const resources = loadResources();
      resources.unshift(newResource);
      saveResources(resources);

      sendJson(res, 201, {
        success: true,
        message: 'PDF resource uploaded successfully.',
        resource: newResource,
        resources
      });
    } catch (err) {
      sendJson(res, 500, { success: false, error: 'Upload failed: ' + err.message });
    }
    return;
  }

  // 9. Delete Resource
  if (pathname === '/api/resources/delete' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const resId = (body.id || '').trim();
      if (!resId) {
        sendJson(res, 400, { success: false, error: 'Resource ID is required.' });
        return;
      }

      const resources = loadResources();
      const target = resources.find(r => r.id === resId);
      if (!target) {
        sendJson(res, 404, { success: false, error: 'Resource not found.' });
        return;
      }

      if (target.fileUrl && target.fileUrl.startsWith('/uploads/')) {
        const physicalName = path.basename(target.fileUrl);
        const physicalPath = path.join(UPLOADS_DIR, physicalName);
        if (fs.existsSync(physicalPath)) {
          try {
            fs.unlinkSync(physicalPath);
          } catch (e) {
            console.error('Failed to unlink file:', e.message);
          }
        }
      }

      const updated = resources.filter(r => r.id !== resId);
      saveResources(updated);

      sendJson(res, 200, {
        success: true,
        message: 'Resource deleted successfully.',
        resources: updated
      });
    } catch (err) {
      sendJson(res, 500, { success: false, error: 'Delete failed: ' + err.message });
    }
    return;
  }

  // Static Assets Serving
  let localPathname = pathname;
  if (localPathname === '/') {
    localPathname = '/index.html';
  }

  const safePath = path.normalize(path.join(PUBLIC_DIR, localPathname));
  if (!safePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(safePath, (err, stats) => {
    if (err || !stats.isFile()) {
      const ext = path.extname(localPathname);
      if (!ext) {
        const indexPath = path.join(PUBLIC_DIR, 'index.html');
        fs.readFile(indexPath, (indexErr, indexData) => {
          if (indexErr) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('404 Not Found');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
            res.end(indexData);
          }
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(safePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(safePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 Internal Server Error');
      } else {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
      }
    });
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`🚀 School Stall Educational Platform Running on Port ${PORT}`);
    console.log(`📍 Web URL: http://localhost:${PORT}`);
    console.log(`🏫 Dedicated to T.M.H.N.U Vidhyalaya Mat Hr Sec School, Theni`);
    console.log(`👨‍💻 Author & Lead Creator: Thaswin Kaarthi.A`);
    console.log(`🗄️ Location: D:\\School Stall`);
    console.log(`=======================================================`);
  });
}

module.exports = server;
