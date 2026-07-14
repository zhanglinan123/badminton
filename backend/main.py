import os
import uuid
import asyncio
from typing import Dict, Any

from fastapi import FastAPI, BackgroundTasks, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from concurrent.futures import ProcessPoolExecutor

from services.video_service import generate_proxy_video, splice_highlights
from services.ai_service import run_ai_analysis

app = FastAPI(title="Badminton Highlight API (MVP)")

# Allow cross-origin requests from the Next.js frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global process pool executor for async CPU-bound tasks
process_pool = ProcessPoolExecutor(max_workers=3)

# Storage for simple task tracking logic (In-memory for MVP)
# Format: { task_id: { "status": str, "proxy_url": str, "rallies": list, "error": str, "completed_subtasks": int } }
TASK_STORE: Dict[str, Dict[str, Any]] = {}

@app.on_event("startup")
def startup_event():
    pass
    
# Create directories immediately before mounting StaticFiles to avoid RuntimeError
os.makedirs("uploads", exist_ok=True)
os.makedirs("outputs", exist_ok=True)
os.makedirs("proxies", exist_ok=True)

app.mount("/static/proxies", StaticFiles(directory="proxies"), name="proxies")
app.mount("/static/outputs", StaticFiles(directory="outputs"), name="outputs")

@app.on_event("shutdown")
def shutdown_event():
    process_pool.shutdown()

@app.get("/")
def read_root():
    return {"status": "ok", "message": "Badminton MVP API is running."}

class AnalyzeRequest(BaseModel):
    video_path: str

async def process_video_pipeline(task_id: str, video_path: str):
    """
    Background pipeline to generate proxy video and run AI analysis concurrently.
    """
    try:
        loop = asyncio.get_running_loop()
        
        # 1. Setup paths
        video_filename = os.path.basename(video_path)
        proxy_filename = f"proxy_{task_id}.mp4"
        proxy_path = os.path.join("proxies", proxy_filename)
        proxy_url = f"http://localhost:8000/static/proxies/{proxy_filename}"
        
        # 2. Generate the normalized inference proxy first.
        proxy_future = loop.run_in_executor(
            process_pool, generate_proxy_video, video_path, proxy_path, task_id
        )
        proxy_success = await proxy_future
        if proxy_success:
            TASK_STORE[task_id]["proxy_url"] = proxy_url
            TASK_STORE[task_id]["completed_subtasks"] += 1
            TASK_STORE[task_id]["status"] = "ai_processing"
        else:
            TASK_STORE[task_id]["status"] = "error"
            TASK_STORE[task_id]["error"] = "Proxy generation failed."
            return

        # 3. TrackNet reads the proxy while the hybrid detector reads original audio.
        rallies = await loop.run_in_executor(
            process_pool, run_ai_analysis, video_path, task_id, proxy_path
        )
        if rallies is not None:
            TASK_STORE[task_id]["rallies"] = rallies
            TASK_STORE[task_id]["completed_subtasks"] += 1
            
        # 4. Final success check
        if proxy_success and rallies is not None:
            TASK_STORE[task_id]["status"] = "completed"
        else:
             TASK_STORE[task_id]["status"] = "error"
             TASK_STORE[task_id]["error"] = "One of the processing pipelines failed."
             
    except Exception as e:
        print(f"[{task_id}] Pipeline failed: {e}")
        TASK_STORE[task_id]["status"] = "error"
        TASK_STORE[task_id]["error"] = str(e)


@app.post("/analyze")
async def trigger_analysis(req: AnalyzeRequest, background_tasks: BackgroundTasks):
    if not os.path.exists(req.video_path):
        raise HTTPException(status_code=400, detail="Video file does not exist locally.")
        
    task_id = str(uuid.uuid4())
    TASK_STORE[task_id] = {
        "status": "processing",
        "proxy_url": None,
        "rallies": None,
        "error": None,
        "completed_subtasks": 0,
        "original_video": req.video_path
    }
    
    # Push complex processing to background to avoid blocking HTTP request
    background_tasks.add_task(process_video_pipeline, task_id, req.video_path)
    
    return {"status": "processing", "task_id": task_id}

@app.get("/task/{task_id}/status")
def get_task_status(task_id: str):
    if task_id not in TASK_STORE:
        raise HTTPException(status_code=404, detail="Task not found")
        
    return TASK_STORE[task_id]

class ClipRequest(BaseModel):
    task_id: str
    rallies: list # list of dicts with start, end

@app.post("/clip_highlight")
def generate_highlights(req: ClipRequest):
    if req.task_id not in TASK_STORE:
        raise HTTPException(status_code=404, detail="Task mapping not found")
        
    original_video = TASK_STORE[req.task_id].get("original_video")
    if not original_video or not os.path.exists(original_video):
        raise HTTPException(status_code=400, detail="Original video unavailable")
        
    output_filename = f"highlight_{req.task_id}.mp4"
    output_path = os.path.join("outputs", output_filename)
    
    # We run splicing directly (MVP is blocking, ideally it should be async like /analyze)
    # If the user needs true async, we can refactor this similarly.
    success = splice_highlights(original_video, output_path, req.rallies, req.task_id)
    
    if success is False: # Assuming splice_highlights will return True on success
        raise HTTPException(status_code=500, detail="Splicing failed")
        
    return {
        "status": "success", 
        "download_url": f"http://localhost:8000/static/outputs/{output_filename}"
    }
