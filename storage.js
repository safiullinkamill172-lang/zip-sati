const fs = require('fs');
const path = require('path');

const LOCAL_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(LOCAL_DIR)) fs.mkdirSync(LOCAL_DIR, { recursive: true });

class LocalStorage {
  constructor() { this.dir = LOCAL_DIR; }
  async listArchives() {
    const entries = await fs.promises.readdir(this.dir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory() && e.name !== '_tmp');
    const out = [];
    for (const d of dirs) {
      try { out.push(JSON.parse(await fs.promises.readFile(path.join(this.dir, d.name, '_meta.json'), 'utf8'))); }
      catch { out.push({ id: d.name, name: d.name, uploadedAt: null }); }
    }
    out.sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''));
    return out;
  }
  async getMeta(id) {
    try { return JSON.parse(await fs.promises.readFile(path.join(this.dir, id, '_meta.json'), 'utf8')); }
    catch { return {}; }
  }
  async listFiles(id) {
    const baseDir = path.join(this.dir, id);
    if (!fs.existsSync(baseDir)) return null;
    const walk = (dir, base = '') => {
      const result = [];
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (item.name === '_meta.json') continue;
        const rel = base ? base + '/' + item.name : item.name;
        if (item.isDirectory()) result.push({ type: 'dir', name: item.name, path: rel, children: walk(path.join(dir, item.name), rel) });
        else result.push({ type: 'file', name: item.name, path: rel, size: fs.statSync(path.join(dir, item.name)).size });
      }
      result.sort((a, b) => a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, 'ru'));
      return result;
    };
    return walk(baseDir);
  }
  async getArchiveTree(id) {
    const meta = await this.getMeta(id);
    const files = await this.listFiles(id);
    if (files === null) return null;
    return { meta, files };
  }
  async createArchiveDir(id) {
    const dir = path.join(this.dir, id);
    await fs.promises.mkdir(dir, { recursive: true });
    return dir;
  }
  async saveMeta(id, meta) {
    await fs.promises.writeFile(path.join(this.dir, id, '_meta.json'), JSON.stringify(meta, null, 2));
  }
  async readFileStream(id, relPath) {
    const abs = path.join(this.dir, id, relPath);
    const baseDir = path.join(this.dir, id);
    if (!abs.startsWith(baseDir + path.sep)) throw new Error('invalid path');
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return null;
    return fs.createReadStream(abs);
  }
  async deleteArchive(id) {
    const dir = path.join(this.dir, id);
    if (!dir.startsWith(this.dir)) return false;
    await fs.promises.rm(dir, { recursive: true, force: true });
    return true;
  }
}

let s3Client = null, S3_BUCKET = null, S3_PREFIX = '';
function getS3() {
  if (s3Client) return s3Client;
  const { S3Client } = require('@aws-sdk/client-s3');
  s3Client = new S3Client({
    region: 'auto',
    endpoint: process.env.S3_ENDPOINT,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
    forcePathStyle: true
  });
  S3_BUCKET = process.env.S3_BUCKET;
  S3_PREFIX = (process.env.S3_PREFIX || '').replace(/^\/+|\/+$/g, '');
  return s3Client;
}

class S3Storage {
  constructor() { getS3(); }
  key(...parts) { return [S3_PREFIX, ...parts].filter(Boolean).join('/'); }

  async listArchives() {
    const { ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
    const prefix = this.key('archives') + '/';
    const out = [];
    let ContinuationToken;
    do {
      const resp = await s3Client.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix, ContinuationToken }));
      for (const obj of resp.Contents || []) {
        const m = obj.Key.match(/archives\/([^\/]+)\/_meta\.json$/);
        if (m) {
          try {
            const body = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: obj.Key }));
            out.push(JSON.parse(await body.Body.transformToString('utf8')));
          } catch {}
        }
      }
      ContinuationToken = resp.IsTruncated ? resp.NextContinuationToken : null;
    } while (ContinuationToken);
    out.sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''));
    return out;
  }

  async getMeta(id) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    try {
      const body = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: this.key('archives', id, '_meta.json') }));
      return JSON.parse(await body.Body.transformToString('utf8'));
    } catch { return {}; }
  }

  async getArchiveTree(id) {
    const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
    const prefix = this.key('archives', id) + '/';
    const meta = await this.getMeta(id);
    const files = [];
    let ContinuationToken;
    do {
      const resp = await s3Client.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix, ContinuationToken }));
      for (const obj of resp.Contents || []) {
        const rel = obj.Key.slice(prefix.length);
        if (!rel || rel.endsWith('/_meta.json') || rel.endsWith('/')) continue;
        const parts = rel.split('/');
        let cur = files;
        for (let i = 0; i < parts.length; i++) {
          const name = parts[i];
          if (i === parts.length - 1) cur.push({ type: 'file', name, path: rel, size: obj.Size });
          else {
            let dir = cur.find(n => n.type === 'dir' && n.name === name);
            if (!dir) { dir = { type: 'dir', name, path: parts.slice(0, i + 1).join('/'), children: [] }; cur.push(dir); }
            cur = dir.children;
          }
        }
      }
      ContinuationToken = resp.IsTruncated ? resp.NextContinuationToken : null;
    } while (ContinuationToken);
    const sortTree = a => { a.sort((x, y) => x.type !== y.type ? (x.type === 'dir' ? -1 : 1) : x.name.localeCompare(y.name, 'ru')); a.forEach(n => n.children && sortTree(n.children)); };
    sortTree(files);
    if (!meta.id && !files.length) return null;
    return { meta, files };
  }

  async createArchiveDir(id) {
    const tmp = path.join(LOCAL_DIR, '_tmp', id);
    await fs.promises.mkdir(tmp, { recursive: true });
    return tmp;
  }

  async saveMeta(id, meta) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3Client.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: this.key('archives', id, '_meta.json'), Body: JSON.stringify(meta, null, 2), ContentType: 'application/json' }));
  }

  async uploadExtracted(localDir, id) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const mime = require('./mime');
    const walk = async (dir, base = '') => {
      for (const item of await fs.promises.readdir(dir, { withFileTypes: true })) {
        const rel = base ? base + '/' + item.name : item.name;
        if (item.isDirectory()) await walk(path.join(dir, item.name), rel);
        else {
          const data = await fs.promises.readFile(path.join(dir, item.name));
          await s3Client.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: this.key('archives', id, rel), Body: data, ContentType: mime.contentType(path.extname(item.name)) || 'application/octet-stream' }));
        }
      }
    };
    await walk(localDir);
    await fs.promises.rm(localDir, { recursive: true, force: true });
  }

  async readFileStream(id, relPath) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    if (relPath.includes('..')) return null;
    try {
      const resp = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: this.key('archives', id, relPath) }));
      return resp.Body;
    } catch (e) {
      if (e.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }

  async deleteArchive(id) {
    const { ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
    const prefix = this.key('archives', id) + '/';
    const keys = [];
    let ContinuationToken;
    do {
      const resp = await s3Client.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix, ContinuationToken }));
      for (const obj of resp.Contents || []) keys.push({ Key: obj.Key });
      ContinuationToken = resp.IsTruncated ? resp.NextContinuationToken : null;
    } while (ContinuationToken);
    if (keys.length) await s3Client.send(new DeleteObjectsCommand({ Bucket: S3_BUCKET, Delete: { Objects: keys } }));
    return true;
  }
}

const USE_S3 = process.env.STORAGE === 's3' && process.env.S3_BUCKET && process.env.S3_ACCESS_KEY_ID;
module.exports = USE_S3 ? new S3Storage() : new LocalStorage();
