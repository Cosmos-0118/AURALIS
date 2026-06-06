import fs from 'fs';
import path from 'path';

import youtubedl from 'youtube-dl-exec';

function sanitizeName(value) {
  return String(value || 'media').replace(/[^\w.-]+/g, '_').slice(0, 80);
}

export async function downloadMediaFromUrl(url, destDir) {
  const stamp = Date.now();
  const outputTemplate = path.join(destDir, `${stamp}_%(title)s.%(ext)s`);

  const filepath = await youtubedl(url, {
    format: 'bestaudio/best',
    output: outputTemplate,
    noPlaylist: true,
    restrictFilenames: true,
    noWarnings: true,
    print: 'after_move:filepath',
  });

  const inputPath = String(filepath || '').trim();
  if (!inputPath || !fs.existsSync(inputPath)) {
    throw new Error('Download completed but output file was not found.');
  }

  const base = path.basename(inputPath, path.extname(inputPath));
  const title = base.replace(new RegExp(`^${stamp}_`), '');
  const originalName = sanitizeName(title || 'media');

  return { inputPath, originalName };
}
