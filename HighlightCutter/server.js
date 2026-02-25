const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('dist'));

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
