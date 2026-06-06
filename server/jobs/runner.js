import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { PYTHON, PYTHONPATH, ROOT, resolveProfile } from '../config.js';
import { readJobStatus, writeJobStatus } from './status.js';

/** @type {Map<string, { process: import('child_process').ChildProcess, inputPath: string }>} */
export const activeJobs = new Map();

function cleanupUpload(filePath) {
  fs.unlink(filePath, (err) => {
    if (err && err.code !== 'ENOENT') console.error('[!] Upload cleanup failed:', err);
  });
}

export function spawnPipeline({ jobId, workDir, inputPath, outputPath, profile, originalName }) {
  const resolvedProfile = resolveProfile(profile);
  const args = [
    '-m',
    'auralis',
    'process',
    inputPath,
    '--profile',
    resolvedProfile,
    '-o',
    outputPath,
    '--work-dir',
    workDir,
  ];

  const pythonProcess = spawn(PYTHON, args, {
    cwd: ROOT,
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONPATH },
  });

  activeJobs.set(jobId, { process: pythonProcess, inputPath });

  let stderr = '';

  pythonProcess.stdout.on('data', (data) => {
    const line = data.toString().trim();
    if (line) console.log(`[Python:${jobId}] ${line}`);
  });

  pythonProcess.stderr.on('data', (data) => {
    const line = data.toString().trim();
    stderr += `${line}\n`;
    if (line) console.error(`[Python:${jobId}] ${line}`);
  });

  pythonProcess.on('error', (err) => {
    activeJobs.delete(jobId);
    cleanupUpload(inputPath);
    writeJobStatus(workDir, {
      jobId,
      status: 'failed',
      percent: 0,
      message: 'PIPELINE FAILED',
      error: err.message,
    });
    console.error(`[!] Job ${jobId} spawn error:`, err);
  });

  pythonProcess.on('close', (code) => {
    activeJobs.delete(jobId);
    cleanupUpload(inputPath);

    if (code !== 0) {
      const existing = readJobStatus(workDir);
      if (existing?.status !== 'failed') {
        writeJobStatus(workDir, {
          jobId,
          status: 'failed',
          percent: existing?.percent ?? 0,
          message: 'PIPELINE FAILED',
          error: stderr.trim() || `Exit code ${code}`,
        });
      }
      console.error(`[!] Job ${jobId} exited with code ${code}`);
      return;
    }

    if (!fs.existsSync(outputPath)) {
      writeJobStatus(workDir, {
        jobId,
        status: 'failed',
        percent: 0,
        message: 'PIPELINE FAILED',
        error: 'Output file missing after pipeline completed.',
      });
      return;
    }

    const existing = readJobStatus(workDir);
    if (existing?.status !== 'complete') {
      let meta = {};
      try {
        const profileJson = path.join(workDir, 'profile.json');
        if (fs.existsSync(profileJson)) {
          const p = JSON.parse(fs.readFileSync(profileJson, 'utf8'));
          meta = {
            bpm: p.bpm,
            genre: p.genre_hint,
            mood: p.mood_hint,
            profile,
          };
        }
      } catch {
        /* profile optional */
      }

      writeJobStatus(workDir, {
        jobId,
        status: 'complete',
        percent: 100,
        message: 'DECODE COMPLETE // LOCKED',
        output: outputPath,
        originalName,
        profile,
        meta,
      });
    }

    console.log(`[+] Job ${jobId} complete: ${outputPath}`);
  });

  return pythonProcess;
}

export function cancelJob(jobId, rendersDir) {
  const active = activeJobs.get(jobId);

  if (active) {
    active.process.kill('SIGTERM');
    activeJobs.delete(jobId);
    cleanupUpload(active.inputPath);
  }

  const workDir = path.join(rendersDir, jobId);
  if (fs.existsSync(workDir)) {
    const status = readJobStatus(workDir);
    if (status?.status !== 'complete') {
      writeJobStatus(workDir, {
        jobId,
        status: 'failed',
        percent: status?.percent ?? 0,
        message: 'JOB CANCELLED',
        error: 'Cancelled by client.',
      });
    }
  }

  return Boolean(active);
}
