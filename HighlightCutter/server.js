const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const crypto = require('crypto');
const { execFile } = require('child_process');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('dist'));

const sourceVideoDir = String.raw`E:\我的照片\羽毛球视频\原片`;
const aiPredictionRoot = path.resolve(__dirname, '..', 'TrackNetV3', 'prediction', 'baseline');
const motionModelPath = path.join(aiPredictionRoot, 'motion_model.json');
const videoExtensions = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v']);
const reviewReasons = new Set([
  'start_too_early', 'start_too_late', 'end_too_early',
  'end_too_late', 'merged_rallies', 'not_a_rally',
]);
const ffmpegPath = process.env.FFMPEG_PATH || String.raw`C:\Users\39249\anaconda3\envs\tracknet\lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win64-v4.2.2.exe`;
ffmpeg.setFfmpegPath(ffmpegPath);

function isVideoFile(filename) {
  return videoExtensions.has(path.extname(filename).toLowerCase());
}

function probeVideo(filePath) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-hide_banner', '-i', filePath], { windowsHide: true }, (error, stdout, stderr) => {
      const fpsMatch = stderr.match(/(\d+(?:\.\d+)?)\s*fps\b/);
      const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!fpsMatch || !durationMatch) return reject(error || new Error('无法读取视频元数据'));
      const duration = Number(durationMatch[1]) * 3600
        + Number(durationMatch[2]) * 60 + Number(durationMatch[3]);
      resolve({ fps: Number(fpsMatch[1]), duration });
    });
  });
}

function modelFingerprint() {
  if (!fs.existsSync(motionModelPath)) return null;
  const digest = crypto.createHash('sha256').update(fs.readFileSync(motionModelPath)).digest('hex');
  return `sha256:${digest}`;
}

function annotationFilename(videoFilename) {
  return `${path.basename(videoFilename, path.extname(videoFilename))}.annotations.json`;
}

function reviewFilename(videoFilename) {
  return `${path.basename(videoFilename, path.extname(videoFilename))}.review.json`;
}

function readAnnotation(videoFilename) {
  const filename = annotationFilename(videoFilename);
  const annotationPath = path.join(sourceVideoDir, filename);
  if (!fs.existsSync(annotationPath)) {
    return { status: 'unannotated', count: 0, annotations: [] };
  }

  try {
    const payload = JSON.parse(fs.readFileSync(annotationPath, 'utf8'));
    const annotations = Array.isArray(payload.annotations) ? payload.annotations : [];
    return { status: 'annotated', count: annotations.length, annotations };
  } catch (error) {
    console.error(`[source-videos] 标注文件解析失败: ${annotationPath}`, error.message);
    return { status: 'invalid', count: 0, annotations: [] };
  }
}

function readAiPrediction(videoFilename) {
  const stem = path.basename(videoFilename, path.extname(videoFilename));
  const predictionPath = path.join(aiPredictionRoot, stem, 'rallies_ai.json');
  if (!fs.existsSync(predictionPath)) {
    return { status: 'unavailable', count: 0, predictions: [] };
  }

  try {
    const payload = JSON.parse(fs.readFileSync(predictionPath, 'utf8'));
    const predictions = (Array.isArray(payload) ? payload : [])
      .map(item => ({
        start_seconds: Number(item.start ?? item.start_seconds),
        end_seconds: Number(item.end ?? item.end_seconds),
        hit_count: Number(item.hit_count || 0),
        confidence: Number(item.confidence ?? 0),
      }))
      .filter(item => Number.isFinite(item.start_seconds)
        && Number.isFinite(item.end_seconds)
        && item.end_seconds > item.start_seconds);
    return { status: 'available', count: predictions.length, predictions };
  } catch (error) {
    console.error(`[source-videos] AI 预测文件解析失败: ${predictionPath}`, error.message);
    return { status: 'invalid', count: 0, predictions: [] };
  }
}

function readReview(videoFilename) {
  const reviewPath = path.join(sourceVideoDir, reviewFilename(videoFilename));
  if (!fs.existsSync(reviewPath)) return { issues: [], accepted: [] };
  try {
    const payload = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
    const issues = (Array.isArray(payload.issues) ? payload.issues : [])
      .map(issue => ({
        start_seconds: issue.start_seconds,
        end_seconds: issue.end_seconds,
        reasons: Array.isArray(issue.reasons)
          ? issue.reasons
          : reviewReasons.has(issue.reason) ? [issue.reason] : [],
        confidence: issue.confidence,
        hit_count: issue.hit_count,
        reviewed_at: issue.reviewed_at || issue.reported_at,
      }))
      .filter(issue => issue.reasons.length > 0);
    const accepted = (Array.isArray(payload.accepted) ? payload.accepted : []).map(item => ({
      start_seconds: item.start_seconds,
      end_seconds: item.end_seconds,
      confidence: item.confidence,
      hit_count: item.hit_count,
      reviewed_at: item.reviewed_at,
    }));
    return {
      issues,
      accepted,
      complete: payload.review_complete === true,
    };
  } catch (error) {
    console.error(`[source-videos] 验收记录解析失败: ${reviewPath}`, error.message);
    return { issues: [], accepted: [] };
  }
}

app.get('/api/source-videos', async (req, res) => {
  try {
    if (!fs.existsSync(sourceVideoDir)) {
      return res.status(404).json({ error: `视频目录不存在: ${sourceVideoDir}` });
    }

    const entries = fs.readdirSync(sourceVideoDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && isVideoFile(entry.name));
    const fingerprint = modelFingerprint();
    const videos = (await Promise.all(entries.map(async entry => {
        const annotation = readAnnotation(entry.name);
        const aiPrediction = readAiPrediction(entry.name);
        const review = readReview(entry.name);
        const filePath = path.join(sourceVideoDir, entry.name);
        const metadata = await probeVideo(filePath);
        return {
          name: entry.name,
          url: `/source-videos/${encodeURIComponent(entry.name)}`,
          size_bytes: fs.statSync(filePath).size,
          fps: metadata.fps,
          duration_seconds: metadata.duration,
          annotation_status: annotation.status,
          annotation_count: annotation.count,
          annotations: annotation.annotations,
          ai_status: aiPrediction.status,
          ai_count: aiPrediction.count,
          ai_predictions: aiPrediction.predictions,
          model_fingerprint: fingerprint,
          review_issue_count: review.issues.length,
          review_issues: review.issues,
          review_accepted_count: review.accepted.length,
          review_accepted: review.accepted,
          review_complete: review.complete,
        };
      })))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({ directory: sourceVideoDir, videos });
  } catch (error) {
    console.error('[source-videos] 读取失败:', error.message);
    res.status(500).json({ error: '读取视频目录失败' });
  }
});

app.get('/source-videos/:filename', (req, res) => {
  const filename = req.params.filename;
  if (filename !== path.basename(filename) || !isVideoFile(filename)) {
    return res.status(400).json({ error: '非法视频文件名' });
  }

  const filePath = path.join(sourceVideoDir, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '视频文件不存在' });
  }
  res.sendFile(filePath);
});

app.post('/api/annotations', async (req, res) => {
  const payload = req.body || {};
  const sourceVideo = payload.source_video;
  if (typeof sourceVideo !== 'string' || sourceVideo !== path.basename(sourceVideo) || !isVideoFile(sourceVideo)) {
    return res.status(400).json({ error: 'source_video 必须是目录中的视频文件名' });
  }

  const videoPath = path.join(sourceVideoDir, sourceVideo);
  if (!fs.existsSync(videoPath)) {
    return res.status(404).json({ error: '源视频不存在' });
  }

  const annotationPath = path.join(sourceVideoDir, annotationFilename(sourceVideo));
  const tempPath = `${annotationPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    const metadata = await probeVideo(videoPath);
    const savedPayload = { ...payload, fps: metadata.fps };
    fs.writeFileSync(tempPath, JSON.stringify(savedPayload, null, 2), 'utf8');
    fs.renameSync(tempPath, annotationPath);
    res.json({
      success: true,
      source_video: sourceVideo,
      annotation_file: path.basename(annotationPath),
      annotation_count: Array.isArray(payload.annotations) ? payload.annotations.length : 0,
      fps: metadata.fps,
    });
  } catch (error) {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    console.error('[annotations] 保存失败:', error.message);
    res.status(500).json({ error: '保存标注失败' });
  }
});

app.post('/api/review-issues', async (req, res) => {
  const payload = req.body || {};
  const sourceVideo = payload.source_video;
  if (typeof sourceVideo !== 'string' || sourceVideo !== path.basename(sourceVideo) || !isVideoFile(sourceVideo)) {
    return res.status(400).json({ error: 'source_video 必须是目录中的视频文件名' });
  }
  if (!fs.existsSync(path.join(sourceVideoDir, sourceVideo))) {
    return res.status(404).json({ error: '源视频不存在' });
  }
  const issues = Array.isArray(payload.issues) ? payload.issues : [];
  const accepted = Array.isArray(payload.accepted) ? payload.accepted : [];
  if (issues.some(issue => !Number.isFinite(issue.start_seconds)
      || !Number.isFinite(issue.end_seconds)
      || issue.end_seconds <= issue.start_seconds
      || !Array.isArray(issue.reasons)
      || issue.reasons.length === 0
      || issue.reasons.some(reason => !reviewReasons.has(reason)))) {
    return res.status(400).json({ error: '问题片段时间区间无效' });
  }
  if (accepted.some(item => !Number.isFinite(item.start_seconds)
      || !Number.isFinite(item.end_seconds)
      || item.end_seconds <= item.start_seconds)) {
    return res.status(400).json({ error: '正确片段时间区间无效' });
  }

  const reviewPath = path.join(sourceVideoDir, reviewFilename(sourceVideo));
  const tempPath = `${reviewPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    const aiPrediction = readAiPrediction(sourceVideo);
    const metadata = await probeVideo(path.join(sourceVideoDir, sourceVideo));
    const enrich = item => {
      const prediction = aiPrediction.predictions.find(candidate =>
        Math.abs(candidate.start_seconds - item.start_seconds) < 0.001
        && Math.abs(candidate.end_seconds - item.end_seconds) < 0.001);
      return {
        ...item,
        confidence: prediction?.confidence ?? null,
        hit_count: prediction?.hit_count ?? null,
        reviewed_at: item.reviewed_at || item.reported_at || new Date().toISOString(),
      };
    };
    const enrichedIssues = issues.map(enrich).map(({ reported_at, ...issue }) => issue);
    const enrichedAccepted = accepted.map(enrich).map(({ reported_at, ...item }) => item);
    const reviewed = new Set([...enrichedIssues, ...enrichedAccepted]
      .map(item => `${item.start_seconds}:${item.end_seconds}`));
    const savedPayload = {
      schema_version: 1,
      source_video: sourceVideo,
      fps: metadata.fps,
      duration_seconds: metadata.duration,
      model_fingerprint: modelFingerprint(),
      ai_count: aiPrediction.count,
      review_complete: aiPrediction.count > 0 && reviewed.size === aiPrediction.count,
      updated_at: new Date().toISOString(),
      issues: enrichedIssues,
      accepted: enrichedAccepted,
    };
    fs.writeFileSync(tempPath, JSON.stringify(savedPayload, null, 2), 'utf8');
    fs.renameSync(tempPath, reviewPath);
    res.json({
      success: true,
      issue_count: enrichedIssues.length,
      accepted_count: enrichedAccepted.length,
      review_complete: savedPayload.review_complete,
    });
  } catch (error) {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    console.error('[review-issues] 保存失败:', error.message);
    res.status(500).json({ error: '保存验收记录失败' });
  }
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = /mp4|avi|mov|mkv|webm/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype || extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only video files are allowed!'));
    }
  }
  // 不设置 fileSize 限制，支持任意大小的视频文件
});

app.post('/api/video-metadata', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '未上传视频文件' });
  }

  try {
    const metadata = await probeVideo(req.file.path);
    res.json(metadata);
  } catch (error) {
    console.error('[video-metadata] 探测失败:', error.message);
    res.status(400).json({ error: `无法读取视频 FPS: ${error.message}` });
  } finally {
    cleanupFile(req.file.path);
  }
});

const outputDir = 'outputs';
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

app.post('/api/trim', upload.single('video'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    const { startTime = '0', endTime = '0' } = req.body;
    const inputPath = req.file.path;
    const outputPath = path.join(outputDir, `trimmed-${Date.now()}-${req.file.filename}`);

    ffmpeg(inputPath)
      .setStartTime(startTime)
      .setDuration(calculateDuration(startTime, endTime))
      .output(outputPath)
      .on('end', () => {
        res.json({
          success: true,
          message: 'Video trimmed successfully',
          filename: path.basename(outputPath),
          downloadUrl: `/download/${path.basename(outputPath)}`
        });
        cleanupFile(inputPath);
      })
      .on('error', (err) => {
        console.error('FFmpeg error:', err);
        res.status(500).json({ error: 'Error trimming video' });
        cleanupFile(inputPath);
      })
      .run();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/merge', upload.array('videos', 10), (req, res) => {
  try {
    if (!req.files || req.files.length < 2) {
      return res.status(400).json({ error: 'Please upload at least 2 videos' });
    }

    const inputPaths = req.files.map(file => file.path);
    const outputPath = path.join(outputDir, `merged-${Date.now()}.mp4`);

    mergeVideos(inputPaths, outputPath, res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function mergeVideos(inputPaths, outputPath, res) {
  let command = ffmpeg();

  inputPaths.forEach(path => {
    command = command.addInput(path);
  });

  command
    .on('end', () => {
      res.json({
        success: true,
        message: 'Videos merged successfully',
        filename: path.basename(outputPath),
        downloadUrl: `/download/${path.basename(outputPath)}`
      });
      inputPaths.forEach(p => cleanupFile(p));
    })
    .on('error', (err) => {
      console.error('FFmpeg error:', err);
      res.status(500).json({ error: 'Error merging videos' });
      inputPaths.forEach(p => cleanupFile(p));
    })
    .mergeToFile(outputPath);
}

app.get('/download/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'outputs', filename);

  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

function calculateDurationHHMMSS(startStr, endStr) {
  const start = parseTimeToSeconds(startStr);
  const end = parseTimeToSeconds(endStr);
  return end - start;
}

function calculateDuration(startTime, endTime) {
  return calculateDurationHHMMSS(startTime, endTime);
}

/**
 * /api/process-batch
 * 接收: video (文件) + cuts (JSON字符串数组, e.g. [{"start":"00:00:01","end":"00:00:05"},...])
 * 内部流程: 逐段 trim → 收集临时片段 → mergeToFile 合并 → 返回下载链接
 * 完全复用已验证的 trim / mergeToFile 核心逻辑
 */
app.post('/api/process-batch', (req, res, next) => {
  // 先单独运行 multer，捕获其可能抛出的 MulterError（如文件类型不允许等）
  upload.single('video')(req, res, (err) => {
    if (err) {
      console.error('[process-batch] multer 上传错误:', err.message);
      return res.status(400).json({ error: `上传失败: ${err.message}` });
    }
    next();
  });
}, async (req, res) => {
  const inputPath = req.file ? req.file.path : null;
  const tempFiles = []; // 记录所有临时片段，最终统一清理

  try {
    if (!req.file) {
      return res.status(400).json({ error: '未上传视频文件' });
    }

    let cuts;
    try {
      cuts = JSON.parse(req.body.cuts || '[]');
    } catch (e) {
      return res.status(400).json({ error: 'cuts 参数格式错误，需要合法 JSON' });
    }

    if (!cuts || cuts.length === 0) {
      return res.status(400).json({ error: '至少需要一个裁剪片段' });
    }

    console.log(`[process-batch] 开始处理, 片段数=${cuts.length}, 源文件=${inputPath}`);

    // ── Step 1: 逐段裁剪（复用已验证的 trim 逻辑）──────────────────────────
    const trimSegment = (cut, index) => new Promise((resolve, reject) => {
      const segPath = path.join(outputDir, `seg-${Date.now()}-${index}-${req.file.filename}.mp4`);
      const duration = calculateDuration(cut.start, cut.end);

      if (duration <= 0) {
        return reject(new Error(`片段 ${index + 1} 的结束时间必须大于开始时间`));
      }

      console.log(`[process-batch] 裁剪片段 ${index + 1}: ${cut.start} -> ${cut.end} (${duration}s)`);

      ffmpeg(inputPath)
        .setStartTime(cut.start)
        .setDuration(duration)
        .output(segPath)
        .on('end', () => {
          console.log(`[process-batch] 片段 ${index + 1} 完成: ${segPath}`);
          resolve(segPath);
        })
        .on('error', (err) => {
          console.error(`[process-batch] 片段 ${index + 1} 裁剪失败:`, err.message);
          reject(new Error(`片段 ${index + 1} 裁剪失败: ${err.message}`));
        })
        .run();
    });

    // 串行裁剪，保证顺序
    for (let i = 0; i < cuts.length; i++) {
      const segPath = await trimSegment(cuts[i], i);
      tempFiles.push(segPath);
    }

    // ── Step 2: 合并所有片段（复用已验证的 mergeToFile 逻辑）───────────────
    const finalOutput = path.join(outputDir, `final-${Date.now()}.mp4`);

    if (tempFiles.length === 1) {
      // 只有一段，直接改名即可，无需 merge
      fs.renameSync(tempFiles[0], finalOutput);
      tempFiles.length = 0; // 已经移动，不再需要清理
      console.log(`[process-batch] 单段直接输出: ${finalOutput}`);

      cleanupFile(inputPath);
      return res.json({
        success: true,
        message: '处理完成',
        filename: path.basename(finalOutput),
        downloadUrl: `/download/${path.basename(finalOutput)}`
      });
    }

    // 多段合并
    console.log(`[process-batch] 合并 ${tempFiles.length} 个片段 → ${finalOutput}`);
    let command = ffmpeg();
    tempFiles.forEach(f => { command = command.addInput(f); });

    command
      .on('end', () => {
        console.log(`[process-batch] 合并完成: ${finalOutput}`);
        res.json({
          success: true,
          message: '处理完成',
          filename: path.basename(finalOutput),
          downloadUrl: `/download/${path.basename(finalOutput)}`
        });
        // 清理临时片段和源文件
        tempFiles.forEach(f => cleanupFile(f));
        cleanupFile(inputPath);
      })
      .on('error', (err) => {
        console.error('[process-batch] 合并失败:', err.message);
        if (!res.headersSent) {
          res.status(500).json({ error: `合并失败: ${err.message}` });
        }
        tempFiles.forEach(f => cleanupFile(f));
        cleanupFile(inputPath);
      })
      .mergeToFile(finalOutput, outputDir);

  } catch (error) {
    console.error('[process-batch] 异常:', error.message);
    // 清理已生成的临时文件
    tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (_) { } });
    if (inputPath) cleanupFile(inputPath);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

function parseTimeToSeconds(timeStr) {
  const parts = timeStr.split(':').map(Number);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return parseFloat(timeStr) || 0;
}

function cleanupFile(filePath) {
  setTimeout(() => {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }, 60000);
}

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

// 全局守护：防止未捕获的异常或 Promise rejection 杀死进程
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] 捕获到未处理异常，服务继续运行:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] 捕获到未处理 Promise 拒绝，服务继续运行:', reason);
});
