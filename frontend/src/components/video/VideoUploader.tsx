"use client";

import { useState, useRef } from "react";
import { Upload, FileVideo, X, CheckCircle2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function VideoUploader({
    onUploadSuccess,
}: {
    onUploadSuccess: (filePath: string, taskId: string | null) => void;
}) {
    const [isDragOver, setIsDragOver] = useState(false);
    const [file, setFile] = useState<File | null>(null);
    const [progress, setProgress] = useState(0);
    const [status, setStatus] = useState<"idle" | "uploading" | "success" | "error">("idle");
    const abortControllerRef = useRef<AbortController | null>(null);
    const { toast } = useToast();

    const handleFileSelect = (selectedFile: File) => {
        if (!selectedFile.type.startsWith("video/")) {
            toast({
                title: "格式不支持",
                description: "请上传 MP4 或 MOV 格式的视频文件",
                variant: "destructive",
            });
            return;
        }
        setFile(selectedFile);
        setStatus("idle");
        setProgress(0);
    };

    const startUpload = async () => {
        if (!file) return;

        setStatus("uploading");
        setProgress(0);
        abortControllerRef.current = new AbortController();

        try {
            // Using XMLHttpRequest for reliable progress tracking on large files
            const xhr = new XMLHttpRequest();
            const formData = new FormData();
            formData.append("video", file);

            xhr.upload.addEventListener("progress", (event) => {
                if (event.lengthComputable) {
                    const percent = Math.round((event.loaded * 100) / event.total);
                    setProgress(percent);
                }
            });

            const response = await new Promise((resolve, reject) => {
                xhr.addEventListener("load", () => {
                    if (xhr.status >= 200 && xhr.status < 300) {
                        resolve(JSON.parse(xhr.responseText));
                    } else {
                        reject(new Error(xhr.responseText || "上传失败"));
                    }
                });
                xhr.addEventListener("error", () => reject(new Error("网络错误")));
                xhr.addEventListener("abort", () => reject(new Error("上传已取消")));

                xhr.open("POST", "/api/upload");
                xhr.send(formData);
            });

            setStatus("success");
            onUploadSuccess((response as any).file_path, (response as any).task_id);
            toast({
                title: "上传成功",
                description: "视频已成功落盘，准备开始 AI 分析",
            });

        } catch (err: any) {
            if (err.message !== "上传已取消") {
                setStatus("error");
                toast({
                    title: "上传失败",
                    description: err.message,
                    variant: "destructive",
                });
            }
        }
    };

    const cancelUpload = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
        setFile(null);
        setStatus("idle");
        setProgress(0);
    };

    return (
        <div className="w-full max-w-2xl mx-auto p-6 bg-card rounded-xl border shadow-sm">
            {!file ? (
                <div
                    className={cn(
                        "border-2 border-dashed rounded-lg p-12 text-center transition-colors cursor-pointer",
                        isDragOver ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-primary/50"
                    )}
                    onDragOver={(e) => {
                        e.preventDefault();
                        setIsDragOver(true);
                    }}
                    onDragLeave={() => setIsDragOver(false)}
                    onDrop={(e) => {
                        e.preventDefault();
                        setIsDragOver(false);
                        if (e.dataTransfer.files?.[0]) {
                            handleFileSelect(e.dataTransfer.files[0]);
                        }
                    }}
                    onClick={() => document.getElementById("video-upload-input")?.click()}
                >
                    <input
                        id="video-upload-input"
                        type="file"
                        accept="video/mp4,video/quicktime"
                        className="hidden"
                        onChange={(e) => {
                            if (e.target.files?.[0]) {
                                handleFileSelect(e.target.files[0]);
                            }
                        }}
                    />
                    <div className="bg-muted w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
                        <Upload className="w-8 h-8 text-muted-foreground" />
                    </div>
                    <h3 className="text-lg font-semibold mb-2">拖拽或点击上传比赛视频</h3>
                    <p className="text-sm text-muted-foreground mb-4">支持 1080P/4K 的 MP4 或 MOV 格式 (30/60fps)</p>
                    <Button variant="secondary" className="pointer-events-none">选择文件</Button>
                </div>
            ) : (
                <div className="space-y-6">
                    <div className="flex items-center gap-4 p-4 border rounded-lg bg-muted/50">
                        <div className="bg-primary/10 p-3 rounded-lg">
                            <FileVideo className="w-8 h-8 text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{file.name}</p>
                            <p className="text-xs text-muted-foreground">
                                {(file.size / (1024 * 1024)).toFixed(2)} MB
                            </p>
                        </div>
                        {status === "idle" && (
                            <Button variant="ghost" size="icon" onClick={cancelUpload}>
                                <X className="w-4 h-4" />
                            </Button>
                        )}
                        {status === "success" && <CheckCircle2 className="w-6 h-6 text-green-500" />}
                        {status === "error" && <AlertCircle className="w-6 h-6 text-destructive" />}
                    </div>

                    {(status === "uploading" || status === "success") && (
                        <div className="space-y-2">
                            <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">
                                    {status === "uploading" ? "正在上传到本地..." : "上传完成"}
                                </span>
                                <span className="font-medium">{progress}%</span>
                            </div>
                            <Progress value={progress} className="h-2" />
                        </div>
                    )}

                    {status === "idle" && (
                        <div className="flex gap-3">
                            <Button className="flex-1" onClick={startUpload}>开始上传并分析</Button>
                            <Button variant="outline" onClick={cancelUpload}>取消</Button>
                        </div>
                    )}
                    {status === "error" && (
                        <div className="flex gap-3">
                            <Button className="flex-1" onClick={startUpload}>重试上传</Button>
                            <Button variant="outline" onClick={cancelUpload}>更换文件</Button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
