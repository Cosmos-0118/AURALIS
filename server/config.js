import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT = path.join(__dirname, '..');

export const port = Number(process.env.PORT) || 3000;
export const REQUEST_TIMEOUT_MS = Number(process.env.AURALIS_REQUEST_TIMEOUT_MS) || 300_000;
export const MAX_UPLOAD_BYTES = Number(process.env.AURALIS_MAX_UPLOAD_MB || 100) * 1024 * 1024;

export const PYTHON =
  process.env.AURALIS_PYTHON ||
  path.join(ROOT, 'engine', '.venv', 'bin', 'python');

export const PYTHONPATH = path.join(ROOT, 'engine');

export const VALID_PROFILES = new Set([
  'audiophile',
  'basshead',
  'cinema',
  'concert',
  'hyper_immersive',
  'god',
]);

export const uploadDir = path.join(ROOT, 'data', 'uploads');
export const rendersDir = path.join(ROOT, 'data', 'renders');
