const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');
const fs = require('fs-extra');
const archiver = require('archiver');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const sanitizeFilename = require('sanitize-filename');

const app = express();
const port = process.env.PORT || 3000;

// Security middleware
app.use(helmet());
app.use(cors());
app.use(bodyParser.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

app.post('/generate-app', async (req, res) => {
  try {
    const { appName, websiteUrl } = req.body;

    // Validate input
    if (!appName || !websiteUrl) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const sanitizedAppName = sanitizeFilename(appName);
    const uniqueId = uuidv4();
    const appDir = path.join(__dirname, 'generated-apps', `${sanitizedAppName}-${uniqueId}`);
    await fs.ensureDir(appDir);

    // Scrape website content
    const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.goto(websiteUrl, { waitUntil: 'networkidle0', timeout: 60000 });
    const content = await page.content();
    await browser.close();

    // Generate app files
    await generateAppFiles(appDir, sanitizedAppName, content, websiteUrl);

    // Create a zip file
    const zipPath = path.join(__dirname, 'generated-apps', `${sanitizedAppName}-${uniqueId}.zip`);
    await createZipArchive(appDir, zipPath);

    // Send the zip file
    res.download(zipPath, `${sanitizedAppName}.zip`, (err) => {
      if (err) {
        console.error('Error sending file:', err);
        res.status(500).json({ error: 'Error sending file' });
      }
      // Clean up
      fs.remove(appDir);
      fs.remove(zipPath);
    });
  } catch (error) {
    console.error('Error generating app:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function generateAppFiles(appDir, appName, content, websiteUrl) {
  // Generate index.html
  const indexHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${appName}</title>
    <link rel="manifest" href="manifest.json">
    <meta name="theme-color" content="#000000">
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <div id="app-content">
      ${content}
    </div>
    <script src="app.js"></script>
</body>
</html>`;

  await fs.writeFile(path.join(appDir, 'index.html'), indexHtml);

  // Generate manifest.json
  const manifest = {
    name: appName,
    short_name: appName,
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#000000',
    icons: [
      {
        src: 'icon-192x192.png',
        sizes: '192x192',
        type: 'image/png'
      },
      {
        src: 'icon-512x512.png',
        sizes: '512x512',
        type: 'image/png'
      }
    ]
  };

  await fs.writeFile(path.join(appDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // Generate sw.js (Service Worker)
  const serviceWorker = `
const CACHE_NAME = '${appName}-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/manifest.json',
  '/styles.css',
  '/app.js',
  '/icon-192x192.png',
  '/icon-512x512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request)
      .then((response) => response || fetch(event.request))
  );
});`;

  await fs.writeFile(path.join(appDir, 'sw.js'), serviceWorker);

  // Generate app.js
  const appJs = `
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((registration) => {
        console.log('Service Worker registered:', registration);
      })
      .catch((error) => {
        console.log('Service Worker registration failed:', error);
      });
  });
}

// Add any additional app-specific JavaScript here
`;

  await fs.writeFile(path.join(appDir, 'app.js'), appJs);

  // Generate styles.css
  const stylesCss = `
body {
  font-family: Arial, sans-serif;
  line-height: 1.6;
  margin: 0;
  padding: 0;
}

#app-content {
  max-width: 1200px;
  margin: 0 auto;
  padding: 20px;
}

/* Add any additional styles here */
`;

  await fs.writeFile(path.join(appDir, 'styles.css'), stylesCss);

  // Generate placeholder icons
  await fs.copyFile(path.join(__dirname, 'placeholder-icon-192x192.png'), path.join(appDir, 'icon-192x192.png'));
  await fs.copyFile(path.join(__dirname, 'placeholder-icon-512x512.png'), path.join(appDir, 'icon-512x512.png'));
}

function createZipArchive(sourceDir, outPath) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const stream = fs.createWriteStream(outPath);

    archive
      .directory(sourceDir, false)
      .on('error', err => reject(err))
      .pipe(stream);

    stream.on('close', () => resolve());
    archive.finalize();
  });
}

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
