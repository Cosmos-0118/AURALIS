import cors from 'cors';
import express from 'express';
import fs from 'fs';

import {
  PYTHON,
  REQUEST_TIMEOUT_MS,
  MAX_UPLOAD_BYTES,
  port,
  rendersDir,
  uploadDir,
} from './config.js';
import { createApiRouter } from './routes/api.js';

for (const dir of [uploadDir, rendersDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

const app = express();

app.use(cors());
app.use(express.json());
app.use('/api', createApiRouter());

const server = app.listen(port, () => {
  console.log(`Auralis backend running at http://localhost:${port}`);
  console.log(`Python: ${PYTHON}`);
  console.log(`Request timeout: ${REQUEST_TIMEOUT_MS / 1000}s | Max upload: ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB`);
  if (!fs.existsSync(PYTHON)) {
    console.warn('[!] Python venv not found — run: python3 -m venv engine/.venv && pip install -r engine/requirements.txt');
  }
});

server.timeout = REQUEST_TIMEOUT_MS;
server.requestTimeout = REQUEST_TIMEOUT_MS;
