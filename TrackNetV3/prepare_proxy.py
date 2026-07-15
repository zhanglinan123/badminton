import argparse
import subprocess
from pathlib import Path

import imageio_ffmpeg


def self_test():
    assert Path(imageio_ffmpeg.get_ffmpeg_exe()).exists()
    print("self-test passed")


def transcode(input_path, output_path, target_fps, target_height):
    output_path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([
        imageio_ffmpeg.get_ffmpeg_exe(),
        "-loglevel", "error",
        "-y",
        "-i", str(input_path),
        "-map", "0:v:0",
        "-map", "0:a:0?",
        "-vf", f"scale=-2:{target_height}",
        "-r", str(target_fps),
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "28",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        str(output_path),
    ], check=True)
    print(f"created {output_path} ({target_height}p at {target_fps} FPS)")


def main():
    parser = argparse.ArgumentParser(description="Create a smaller proxy for TrackNet inference")
    parser.add_argument("input", nargs="?")
    parser.add_argument("output", nargs="?")
    parser.add_argument("--fps", type=float, default=30.0)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        return
    if not args.input or not args.output:
        parser.error("input and output are required unless --self-test is used")
    transcode(Path(args.input), Path(args.output), args.fps, args.height)


if __name__ == "__main__":
    main()
