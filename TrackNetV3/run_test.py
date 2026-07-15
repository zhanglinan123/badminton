import os
import sys
import subprocess

# 自动切换到脚本所在目录，防止相对路径失效
script_dir = os.path.dirname(os.path.abspath(__file__))
os.chdir(script_dir)

# ── 配置入参 ───────────────────────────────────────────────────────────────────
VIDEO_PATH      = r"D:\test\羽毛球测试视频\羽毛球1.mp4"
SAVE_DIR        = "prediction"
TRACKNET_MODEL  = "ckpts/TrackNet_best.pt"
INPAINT_MODEL   = "ckpts/InpaintNet_best.pt"
FPS             = 30
MIN_RALLY_DURATION = 4.0

# 转码输出路径（720p H.264，供快速验证截取）
CLIP_PATH     = os.path.join(SAVE_DIR, "clip_720p.mp4")
CLIP_DURATION = 300   # 秒；改成10秒以供快速验证，原始为 300

# ──────────────────────────────────────────────────────────────────────────────

def run_command(cmd_list, desc=""):
    if desc:
        print(f"\n[{desc}]")
    print(f"  命令: {' '.join(str(c) for c in cmd_list)}\n")
    result = subprocess.run(cmd_list)
    if result.returncode != 0:
        print(f"\n❌ 失败，退出代码: {result.returncode}")
        sys.exit(result.returncode)


def transcode_clip(src, dst, duration_sec):
    """用 ffmpeg 转码为 720p H.264，速度更快、内存更低"""
    if os.path.exists(dst):
        print(f"[跳过转码] 已存在: {dst}")
        return
    cmd = ["ffmpeg", "-y", "-i", src]
    if duration_sec:
        cmd += ["-t", str(duration_sec)]
    # scale: 720p，保持宽高比；crf=23 平衡质量与体积
    cmd += ["-vf", "scale=-2:720", "-c:v", "libx264", "-crf", "23",
            "-preset", "fast", "-an", dst]
    run_command(cmd, desc="Step 0: ffmpeg 转码为 720p H.264（前5分钟）")


def main():
    # 检查模型文件
    if not os.path.exists(TRACKNET_MODEL):
        print(f"❌ 找不到模型文件: {TRACKNET_MODEL}")
        print("   请将 TrackNet_best.pt 和 InpaintNet_best.pt 放入 ckpts/ 目录")
        return

    os.makedirs(SAVE_DIR, exist_ok=True)

    # ── Step 0: 转码 ─────────────────────────────────────────────────────────
    transcode_clip(VIDEO_PATH, CLIP_PATH, CLIP_DURATION)

    # ── Step 1: TrackNetV3 推理（对转码后的轻量视频）─────────────────────────
    clip_name = os.path.splitext(os.path.basename(CLIP_PATH))[0]
    expected_csv = os.path.join(SAVE_DIR, f"{clip_name}_ball.csv")

    predict_cmd = [
        sys.executable, "predict.py",
        "--video_file",      CLIP_PATH,
        "--tracknet_file",   TRACKNET_MODEL,
        "--inpaintnet_file", INPAINT_MODEL,
        "--save_dir",        SAVE_DIR,
        "--batch_size",      "4",  # 减少 batch size，防止 CUDA OOM
        "--large_video",
        "--eval_mode",       "nonoverlap",  # 每帧只推理一次，速度提升 8x
        "--max_sample_num",  "100",
    ]
    run_command(predict_cmd, desc="Step 1: TrackNetV3 球坐标推理")

    # ── Step 2: 回合识别 ─────────────────────────────────────────────────────
    if not os.path.exists(expected_csv):
        print(f"❌ 未找到推理输出 CSV: {expected_csv}")
        return

    detect_cmd = [
        sys.executable, "rally_detector.py",
        "--csv",          expected_csv,
        "--fps",          str(FPS),
        "--min_duration", str(MIN_RALLY_DURATION),
        "--output",       "rallies_test.json",
    ]
    run_command(detect_cmd, desc="Step 2: 回合时间段识别")

    print("\n✅ 全部完成！结果已保存到: rallies_test.json")


if __name__ == "__main__":
    main()
