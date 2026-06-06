import fs from 'fs';
import path from 'path';

export function jobStatusPath(workDir) {
  return path.join(workDir, 'job_status.json');
}

export function readJobStatus(workDir) {
  try {
    const raw = fs.readFileSync(jobStatusPath(workDir), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function writeJobStatus(workDir, fields) {
  const current = readJobStatus(workDir) || {};
  const next = { ...current, ...fields, updatedAt: Date.now() };
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(jobStatusPath(workDir), JSON.stringify(next, null, 2));
  return next;
}
