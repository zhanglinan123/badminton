import { NextRequest, NextResponse } from "next/server";

export async function GET(
    req: NextRequest,
    { params }: { params: { task_id: string } }
) {
    try {
        const taskId = params.task_id;
        // Proxy request to the Python backend
        const response = await fetch(`http://localhost:8000/task/${taskId}/status`);

        if (!response.ok) {
            if (response.status === 404) {
                return NextResponse.json({ error: "Task not found" }, { status: 404 });
            }
            return NextResponse.json(
                { error: "Failed to fetch status from backend" },
                { status: response.status }
            );
        }

        const data = await response.json();
        return NextResponse.json(data);
    } catch (error) {
        console.error("Error fetching task status:", error);
        return NextResponse.json(
            { error: "Internal Server Error" },
            { status: 500 }
        );
    }
}
