import express from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';

import {
  MAX_UPLOAD_BYTES,
  PYTHON,
  VALID_PROFILES,
  rendersDir,
  resolveProfile,
  uploadDir,
} from '../config.js';
import { downloadMediaFromUrl } from '../jobs/link-download.js';
import { activeJobs, cancelJob, clearAllRenders, deleteRenderJobs, listRenderJobs, spawnPipeline } from '../jobs/runner.js';
import { readJobStatus, writeJobStatus } from '../jobs/status.js';

function sanitizeJobSlug(value) {
  return String(value || 'media').replace(/[^\w.-]+/g, '_').slice(0, 80);
}

function isValidMediaUrl(raw) {
  if (!raw || typeof raw !== 'string') return false;
  try {
    const parsed = new URL(raw.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.mp3';
    const base = path.basename(file.originalname, ext).replace(/[^\w.-]+/g, '_');
    cb(null, `${Date.now()}_${base}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

export function createApiRouter() {
  const router = express.Router();

  router.get('/health', (_req, res) => {
    const pythonReady = fs.existsSync(PYTHON);
    res.json({
      ok: pythonReady,
      python: PYTHON,
      profiles: [...VALID_PROFILES],
      activeJobs: activeJobs.size,
    });
  });

  router.post('/process', upload.single('audio'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file uploaded.' });
    }

    const profile = resolveProfile(req.body.profile);
    const inputPath = req.file.path;
    const originalName = path.parse(req.file.originalname).name;
    const jobId = `${Date.now()}_${originalName.replace(/[^\w.-]+/g, '_')}`;
    const workDir = path.join(rendersDir, jobId);
    const outputPath = path.join(workDir, `${originalName}_${profile}.wav`);

    writeJobStatus(workDir, {
      jobId,
      status: 'queued',
      percent: 2,
      message: 'UPLOADING TO PIPELINE...',
      profile,
      originalName,
      output: outputPath,
    });

    console.log(`[*] Job queued: ${req.file.originalname} (profile=${profile}, job=${jobId})`);

    spawnPipeline({ jobId, workDir, inputPath, outputPath, profile, originalName });

    res.status(202).json({ jobId, status: 'queued', profile });
  });

  router.post('/process-link', (req, res) => {
    const url = req.body?.url?.trim();
    if (!isValidMediaUrl(url)) {
      return res.status(400).json({ error: 'A valid http(s) media URL is required.' });
    }

    const profile = resolveProfile(req.body?.profile);
    const slug = sanitizeJobSlug(new URL(url).hostname);
    const jobId = `${Date.now()}_${slug}`;
    const workDir = path.join(rendersDir, jobId);
    const originalName = slug;
    const outputPath = path.join(workDir, `${originalName}_${profile}.wav`);

    writeJobStatus(workDir, {
      jobId,
      status: 'downloading',
      percent: 1,
      message: 'DOWNLOADING MEDIA...',
      profile,
      originalName,
      output: outputPath,
      sourceUrl: url,
    });

    console.log(`[*] Link job queued: ${url} (profile=${profile}, job=${jobId})`);

    res.status(202).json({ jobId, status: 'downloading', profile });

    downloadMediaFromUrl(url, uploadDir)
      .then(({ inputPath, originalName: resolvedName }) => {
        const resolvedOutputPath = path.join(workDir, `${resolvedName}_${profile}.wav`);

        writeJobStatus(workDir, {
          status: 'queued',
          percent: 2,
          message: 'UPLOADING TO PIPELINE...',
          originalName: resolvedName,
          output: resolvedOutputPath,
        });

        spawnPipeline({
          jobId,
          workDir,
          inputPath,
          outputPath: resolvedOutputPath,
          profile,
          originalName: resolvedName,
        });
      })
      .catch((err) => {
        writeJobStatus(workDir, {
          status: 'failed',
          percent: 0,
          message: 'DOWNLOAD FAILED.',
          error: err.message || String(err),
        });
        console.error(`[!] Link download failed (${jobId}):`, err);
      });
  });

  router.get('/jobs/:id', (req, res) => {
    const jobId = req.params.id;
    const workDir = path.join(rendersDir, jobId);

    if (!fs.existsSync(workDir)) {
      return res.status(404).json({ error: 'Job not found.' });
    }

    const status = readJobStatus(workDir);
    if (!status) {
      return res.status(404).json({ error: 'Job status not available.' });
    }

    res.json({
      jobId,
      status: status.status,
      percent: status.percent ?? 0,
      message: status.message ?? '',
      profile: status.profile,
      originalName: status.originalName ?? null,
      meta: status.meta ?? null,
      error: status.error ?? null,
      updatedAt: status.updatedAt ?? null,
    });
  });

  router.get('/download/:id', (req, res) => {
    const jobId = req.params.id;
    const workDir = path.join(rendersDir, jobId);
    const status = readJobStatus(workDir);

    if (!status || status.status !== 'complete') {
      return res.status(409).json({ error: 'Job not complete.', status: status?.status ?? 'unknown' });
    }

    const outputPath = status.output;
    if (!outputPath || !fs.existsSync(outputPath)) {
      return res.status(404).json({ error: 'Rendered file not found.' });
    }

    const downloadName = `${status.originalName || 'track'}_Auralis.wav`;
    res.download(outputPath, downloadName, (err) => {
      if (err) console.error(`[!] Download error (${jobId}):`, err);
    });
  });

  router.delete('/jobs/:id', (req, res) => {
    const jobId = req.params.id;
    cancelJob(jobId, rendersDir);
    res.json({ jobId, cancelled: true });
  });

  router.get('/renders', (_req, res) => {
    const renders = listRenderJobs(rendersDir);
    res.json({
      count: renders.length,
      activeJobs: activeJobs.size,
      renders,
    });
  });

  router.post('/renders/delete', (req, res) => {
    const jobIds = req.body?.jobIds;
    if (!Array.isArray(jobIds) || jobIds.length === 0) {
      return res.status(400).json({ error: 'jobIds array required.' });
    }

    const { removed, deleted } = deleteRenderJobs(rendersDir, jobIds);
    console.log(`[*] Deleted ${removed} render job(s) from disk`);
    res.json({ removed, deleted, activeJobs: activeJobs.size });
  });

  router.delete('/renders', (_req, res) => {
    const { removed } = clearAllRenders(rendersDir);
    console.log(`[*] Cleared ${removed} render job(s) from disk`);
    res.json({ removed, activeJobs: activeJobs.size });
  });

  return router;
}
