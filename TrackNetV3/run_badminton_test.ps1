# badminton 视频自动化处理测试脚本 (前5分钟验证)

# 1. 配置参数
$VIDEO_PATH = "E:/我的照片/iphone相册/视频/2024_06_05_19_22_IMG_8148.MOV"
$SAVE_DIR = "prediction"
$CSV_NAME = "2024_06_05_19_22_IMG_8148_ball.csv"
$TRACKNET_MODEL = "ckpts/TrackNet_best.pt"
$INPAINT_MODEL = "ckpts/InpaintNet_best.pt"

# 2. 环境验证
Write-Host "--- 准备开始验证：TrackNetV3 + 回合识别 ---" -ForegroundColor Cyan
if (-not (Test-Path $VIDEO_PATH)) {
    Write-Error "视频文件不存在: $VIDEO_PATH"
    exit
}
if (-not (Test-Path $TRACKNET_MODEL)) {
    Write-Error "找不到权重文件 $TRACKNET_MODEL ，请确保已将其放入 ckpts 文件夹"
    exit
}

# 3. 执行第 3 步：TrackNetV3 推理 (限制前300秒)
Write-Host "`n[Step 3/4] 正在运行 TrackNetV3 坐标推理 (前5分钟)..." -ForegroundColor Yellow
conda run -n tracknet python predict.py `
  --video_file "$VIDEO_PATH" `
  --tracknet_file "$TRACKNET_MODEL" `
  --inpaintnet_file "$INPAINT_MODEL" `
  --save_dir "$SAVE_DIR" ^
  --large_video ^
  --video_range 0,300

# 4. 执行第 4 步：回合识别逻辑
if (Test-Path "$SAVE_DIR/$CSV_NAME") {
    Write-Host "`n[Step 4/4] 坐标提取成功，正在识别有效回合..." -ForegroundColor Yellow
    conda run -n tracknet python rally_detector.py `
      --csv "$SAVE_DIR/$CSV_NAME" `
      --fps 30 `
      --min_duration 4 `
      --output rallies_test.json
    
    Write-Host "`n✅ 处理完成！" -ForegroundColor Green
    Write-Host "结果已保存至: d:\Project\AIProject\badminton\TrackNetV3\rallies_test.json" -ForegroundColor Green
} else {
    Write-Error "推理失败，未生成 CSV 文件。"
}
