import subprocess
import os
import json
import time

TRACKNET_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../TrackNetV3"))

def run_ai_analysis(video_path: str, task_id: str, proxy_path: str):
    """
    Runs the TrackNetV3 prediction and rally detection via subprocess 
    using the 'tracknet' conda environment.
    """
    print(f"[{task_id}] Starting AI analysis for: {video_path}")
    
    video_path = os.path.abspath(video_path)
    proxy_path = os.path.abspath(proxy_path)
    proxy_name = os.path.splitext(os.path.basename(proxy_path))[0]
    out_dir = os.path.join(TRACKNET_DIR, "prediction", task_id)
    os.makedirs(out_dir, exist_ok=True)
    
    csv_path = os.path.join(out_dir, f"{proxy_name}_ball.csv")
    json_path = os.path.join(out_dir, f"rallies_{task_id}.json")
    candidates_path = os.path.join(out_dir, f"candidates_{task_id}.json")

    # Paths to model weights
    tracknet_model = os.path.join(TRACKNET_DIR, "ckpts", "TrackNet_best.pt")
    inpaint_model = os.path.join(TRACKNET_DIR, "ckpts", "InpaintNet_best.pt")
    motion_model = os.path.join(TRACKNET_DIR, "prediction", "baseline", "motion_model.json")

    try:
        analysis_started = time.perf_counter()

        # Step 1: Motion and audio identify the intervals where TrackNet can affect the result.
        candidate_cmd = [
            "conda", "run", "-n", "tracknet", "python", "motion_rally_detector.py",
            "--video", video_path,
            "--motion-video", proxy_path,
            "--candidates-output", candidates_path,
        ]
        candidate_started = time.perf_counter()
        subprocess.run(candidate_cmd, cwd=TRACKNET_DIR, check=True)
        print(f"[{task_id}] Candidate preparation finished in {time.perf_counter() - candidate_started:.2f}s")

        # Step 2: Run TrackNet only on aligned candidate frame ranges.
        predict_cmd = [
            "conda", "run", "-n", "tracknet", "python", "predict.py",
            "--video_file", proxy_path,
            "--tracknet_file", tracknet_model,
            "--inpaintnet_file", inpaint_model,
            "--save_dir", out_dir,
            "--batch_size", "8",
            "--large_video",
            "--eval_mode", "nonoverlap",
            "--max_sample_num", "100",
            "--ranges_file", candidates_path,
        ]
        
        print(f"[{task_id}] Running Tracker: {' '.join(predict_cmd)}")
        # Execute prediction
        tracker_started = time.perf_counter()
        subprocess.run(predict_cmd, cwd=TRACKNET_DIR, check=True)
        print(f"[{task_id}] Sparse TrackNet finished in {time.perf_counter() - tracker_started:.2f}s")

        # Step 3: Run the established motion classifier and audio-gap splitter.
        detector_cmd = [
            "conda", "run", "-n", "tracknet", "python", "motion_rally_detector.py",
            "--video", video_path,
            "--motion-video", proxy_path,
            "--csv", csv_path,
            "--model", motion_model,
            "--output", json_path,
        ]
        
        print(f"[{task_id}] Running Rally Detector: {' '.join(detector_cmd)}")
        subprocess.run(detector_cmd, cwd=TRACKNET_DIR, check=True)

        # Step 4: Parse and return results
        if os.path.exists(json_path):
            with open(json_path, "r", encoding="utf-8") as f:
                rallies = json.load(f)
            print(
                f"[{task_id}] Analysis complete in {time.perf_counter() - analysis_started:.2f}s. "
                f"Found {len(rallies)} rallies."
            )
            return rallies
        else:
            raise FileNotFoundError(f"Output JSON not found: {json_path}")

    except subprocess.CalledProcessError as e:
        print(f"[{task_id}] AI analysis failed with error: {e}")
        raise e
