import ffmpeg
import os
import subprocess
import time

TRACKNET_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../TrackNetV3"))

def generate_proxy_video(input_path: str, output_path: str, task_id: str,
                         target_height: int = 720, target_fps: int = 30):
    """
    Generates a proxy video optimized for web playback and seeking.
    Scales down to 720p, 30fps, with fast encoding settings.
    """
    print(f"[{task_id}] Starting proxy generation for: {input_path}")
    start_time = time.time()
    input_path = os.path.abspath(input_path)
    output_path = os.path.abspath(output_path)
    
    try:
        subprocess.run([
            "conda", "run", "-n", "tracknet", "python", "prepare_proxy.py",
            input_path,
            output_path,
            "--fps", str(target_fps),
            "--height", str(target_height),
        ], cwd=TRACKNET_DIR, check=True)
        print(f"[{task_id}] Proxy generation finished in {time.time() - start_time:.2f}s")
        return True
    except subprocess.CalledProcessError as e:
        print(f"[{task_id}] Proxy generation failed: {e}")
        return False
        
def splice_highlights(input_path: str, output_path: str, rallies: list, task_id: str):
    """
    Splices video sections together based on a list of {start, end} timestamps.
    Attempts to stream copy if possible, otherwise re-encodes.
    """
    print(f"[{task_id}] Starting highlight splice for: {input_path}")
    print(f"[{task_id}] Received rallies: {len(rallies)}")
    start_time = time.time()
    
    if not rallies:
        print(f"[{task_id}] No rallies provided to splice.")
        return False
        
    try:
        # Create a text file for the concat demuxer
        list_file_path = os.path.join(os.path.dirname(output_path), f"concat_list_{task_id}.txt")
        clips = []
        
        # We need to extract each segment first to avoid complex filter_complex issues with large files
        segment_dir = os.path.join(os.path.dirname(output_path), f"segments_{task_id}")
        os.makedirs(segment_dir, exist_ok=True)
        
        for idx, rally in enumerate(rallies):
            seg_out = os.path.join(segment_dir, f"seg_{idx}.mp4")
            
            # Using precise seeking
            (
                ffmpeg
                .input(input_path, ss=rally["start"], to=rally["end"])
                .output(
                    seg_out,
                    vcodec="libx264",
                    preset="fast",
                    crf=23,
                    acodec="aac"
                )
                .overwrite_output()
                .run(capture_stdout=True, capture_stderr=True)
            )
            clips.append(seg_out)
            
        # Write concat list
        with open(list_file_path, "w", encoding="utf-8") as f:
            for clip in clips:
                # ffmpeg requires forward slashes or escaped backslashes in the concat file
                f.write(f"file '{clip.replace(chr(92), '/')}'\n")
                
        # Concat all segments
        (
            ffmpeg
            .input(list_file_path, format="concat", safe=0)
            .output(output_path, c="copy")
            .overwrite_output()
            .run(capture_stdout=True, capture_stderr=True)
        )
        
        print(f"[{task_id}] Highlights spliced successfully in {time.time() - start_time:.2f}s")
        return True
    except ffmpeg.Error as e:
        print(f"[{task_id}] FFmpeg error during splicing:\n{e.stderr.decode('utf-8')}")
        return False
    except Exception as e:
        print(f"[{task_id}] Unexpected error during splicing: {str(e)}")
        return False
