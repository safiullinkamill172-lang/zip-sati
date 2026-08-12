const express = require('express');
const multer = require('multer');
const unzipper = require('unzipper');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const store = require('./storage');
const mime = require('./mime');

const app = express();
const PORT = process.env.PORT || 3000;

const tmpDir = path.join(os.tmpdir(), 'zip-site-tmp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

const storage = multer.diskStorage({
  destination: tmpDir,
  filename: (req, file, cb) => cb(null, crypto.randomBytes(6).toString('hex') + '-' + file.originalname)
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith('.zip')) cb(null, true);
    else cb(new Error('Только .zip файлы разрешены'));
  },
  limits: { fileSize: 500 * 1024 * 1024 }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/upload', upload.single('zipfile'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
  const archiveId = crypto.randomBytes(8).toString('hex');
  const archiveName = path.basename(req.file.originalname, '.zip');
  try {
    const destDir = await store.createArchiveDir(archiveId);
    await fs.promises.readFile(req.file.path)
      .then(data => unzipper.Open.buffer(data))
      .then(d => d.extract({ path: destDir }));
    const meta = { id: archiveId, name: archiveName, originalFile: req.file.originalname, uploadedAt: new Date().toISOString(), size: req.file.size };
    await store.saveMeta(archiveId, meta);
    if (process.env.STORAGE === 's3') await store.uploadExtracted(destDir, archiveId);
    fs.unlink(req.file.path, () => {});
    res.json({ ok: true, id: archiveId, name: archiveName });
  } catch (err) {
    console.error(err);
    fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: 'Не удалось распаковать: ' + err.message });
  }
});

app.get('/api/archives', async (req, res) => {
  try { res.json(await store.listArchives()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/archives/:id', async (req, res) => {
  const tree = await store.getArchiveTree(req.params.id);
  if (!tree) return res.status(404).json({ error: 'Архив не найден' });
  res.json(tree);
});

app.get('/api/archives/:id/file/*', async (req, res) => {
  const relPath = req.params[0];
  if (relPath.includes('..')) return res.status(400).send('Недопустимый путь');
  try {
    const stream = await store.readFileStream(req.params.id, relPath);
    if (!stream) return res.status(404).send('Файл не найден');
    const fileName = path.basename(relPath);
    const ext = path.extname(relPath).toLowerCase();
    const inlineExts = ['.txt','.md','.html','.htm','.css','.js','.mjs','.json','.png','.jpg','.jpeg','.gif','.webp','.svg','.bmp','.pdf','.mp4','.webm','.mov','.mp3','.wav','.m4a','.flac','.ogg','.csv','.log','.xml'];
    res.setHeader('Content-Type', mime.contentType(ext));
    res.setHeader('Content-Disposition', `${inlineExts.includes(ext) ? 'inline' : 'attachment'}; filename="${encodeURIComponent(fileName)}"`);
    if (stream.on) {
      stream.on('error', e => { if (!res.headersSent) res.status(500).send(e.message); });
      stream.pipe(res);
    } else {
      stream.pipe ? stream.pipe(res) : res.end(await stream.transformToByteArray());
    }
  } catch (e) { res.status(500).send(e.message); }
});

app.delete('/api/archives/:id', async (req, res) => {
  try { await store.deleteArchive(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.use('/public', express.static(path.join(__dirname, 'public')));
app.listen(PORT, '0.0.0.0', () => console.log(`Сервер: http://0.0.0.0:${PORT} | хранилище: ${process.env.STORAGE === 's3' ? 'S3' : 'локально'}`));
