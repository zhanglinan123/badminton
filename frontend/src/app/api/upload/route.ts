import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { existsSync } from "fs";

export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const file = formData.get("video") as File;

        if (!file) {
            return NextResponse.json(
                { error: "No file received." },
                { status: 400 }
            );
        }

        const buffer = Buffer.from(await file.arrayBuffer());

        // Save to the python backend's uploads directory directly to avoid copying
        const uploadDir = path.join(process.cwd(), "..", "backend", "uploads");

        if (!existsSync(uploadDir)) {
            await mkdir(uploadDir, { recursive: true });
        }

        // Create a unique filename
        const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
        const ext = path.extname(file.name) || ".mp4";
        const filename = `vid-${uniqueSuffix}${ext}`;
        const filePath = path.join(uploadDir, filename);

        await writeFile(filePath, buffer);

        // Call Python FastAPI to trigger the background processing
        try {
            // Forward the absolute path to the backend AI service
            // This part will be executed on the Node server, communicating with the local FastAPI
            const aiResponse = await fetch("http://localhost:8000/analyze", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ video_path: filePath }),
            });

            if (!aiResponse.ok) {
                console.warn(`[API] Failed to trigger AI analysis directly: ${aiResponse.statusText}`);
            } else {
                const aiData = await aiResponse.json();
                return NextResponse.json({
                    status: "success",
                    file_path: filePath,
                    task_id: aiData.task_id // Forward the task ID to the frontend
                });
            }
        } catch (triggerError) {
            console.error("[API] Error contacting python backend:", triggerError);
            // We still return success for the upload part if the python server is down,
            // but without a task_id
        }

        return NextResponse.json({
            status: "success",
            file_path: filePath,
            task_id: null
        });

    } catch (error) {
        console.error("Error occurred while saving the file:", error);
        return NextResponse.json(
            { error: "Failed to save the file." },
            { status: 500 }
        );
    }
}
