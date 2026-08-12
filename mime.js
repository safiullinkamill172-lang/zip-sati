const map = {
  '.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8','.css':'text/css; charset=utf-8',
  '.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8',
  '.json':'application/json; charset=utf-8','.xml':'application/xml; charset=utf-8',
  '.txt':'text/plain; charset=utf-8','.md':'text/plain; charset=utf-8',
  '.csv':'text/csv; charset=utf-8','.log':'text/plain; charset=utf-8',
  '.pdf':'application/pdf','.zip':'application/zip',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif',
  '.webp':'image/webp','.svg':'image/svg+xml','.bmp':'image/bmp',
  '.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime','.avi':'video/x-msvideo',
  '.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4','.flac':'audio/flac','.ogg':'audio/ogg',
  '.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf'
};
function contentType(ext) { return map[(ext || '').toLowerCase()] || 'application/octet-stream'; }
module.exports = { contentType, map };
