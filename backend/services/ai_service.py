import subprocess
import os
import json

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

    # Paths to model weights
    tracknet_model = os.path.join(TRACKNET_DIR, "ckpts", "TrackNet_best.pt")
    inpaint_model = os.path.join(TRACKNET_DIR, "ckpts", "InpaintNet_best.pt")

    try:
        # Step 1: Run the established 720p/30 FPS inference path.
        predict_cmd = [
            "conda", "run", "-n", "tracknet", "python", "predict.py",
            "--video_file", proxy_path,
            "--tracknet_file", tracknet_model,
            "--inpaintnet_file", inpaint_model,
            "--save_dir", out_dir,
            "--batch_size", "8",
            "--large_video",
            "--eval_mode", "nonoverlap",
            "--max_sample_num", "100"
        ]
        
        print(f"[{task_id}] Running Tracker: {' '.join(predict_cmd)}")
        # Execute prediction
        subprocess.run(predict_cmd, cwd=TRACKNET_DIR, check=True)

        # Step 2: Combine original audio hits with TrackNet activity.
        detector_cmd = [
            "conda", "run", "-n", "tracknet", "python", "hybrid_rally_detector.py",
            "--video", video_path,
            "--csv", csv_path,
            "--fps", "30",
            "--output", json_path
        ]
        
        print(f"[{task_id}] Running Rally Detector: {' '.join(detector_cmd)}")
        subprocess.run(detector_cmd, cwd=TRACKNET_DIR, check=True)

        # Step 3: Parse and return results
        if os.path.exists(json_path):
            with open(json_path, "r", encoding="utf-8") as f:
                rallies = json.load(f)
            print(f"[{task_id}] Analysis complete. Found {len(rallies)} rallies.")
            return rallies
        else:
            raise FileNotFoundError(f"Output JSON not found: {json_path}")

    except subprocess.CalledProcessError as e:
        print(f"[{task_id}] AI analysis failed with error: {e}")
        raise e
