"use client";

import { useState, useEffect } from "react";
import { VideoUploader } from "@/components/video/VideoUploader";
import { CustomPlayer, Rally } from "@/components/video/CustomPlayer";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Download, CheckCircle2, Scissors } from "lucide-react";

type TaskStatus = "pending" | "processing" | "ai_processing" | "completed" | "error" | "idle";

export default function Home() {
  const [taskId, setTaskId] = useState<string | null>(null);
  const [status, setStatus] = useState<TaskStatus>("idle");
  const [proxyUrl, setProxyUrl] = useState<string | null>(null);
  const [rallies, setRallies] = useState<Rally[]>([]);
  const [highlightUrl, setHighlightUrl] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (!taskId) return;
    if (status === "completed" || status === "error") return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/task/${taskId}/status`);
        if (res.ok) {
          const data = await res.json();
          setStatus(data.status);
          if (data.proxy_url && !proxyUrl) {
            setProxyUrl(data.proxy_url);
          }
          if (data.rallies && rallies.length === 0) {
            setRallies(data.rallies);
            toast({
              title: "AI 分析完成",
              description: `成功识别出 ${data.rallies.length} 个有效回合`,
            });
          }
        }
      } catch (err) {
        console.error("Failed to fetch status", err);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [taskId, status, proxyUrl, rallies, toast]);

  const handleGenerateHighlight = async () => {
    if (!taskId) return;
    setIsGenerating(true);
    try {
      const res = await fetch("/api/clip_highlight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_id: taskId, rallies }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "生成失败");

      setHighlightUrl(data.download_url);
      toast({
        title: "集锦生成成功！",
        description: "您的精彩集锦已准备就绪。",
      });
    } catch (err: any) {
      toast({
        title: "生成集锦失败",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <main className="min-h-screen bg-muted/20 p-6 md:p-12 font-sans font-medium">
      <div className="max-w-6xl mx-auto space-y-8">
        <header className="text-center space-y-3 mb-12">
          <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight">
            🏸 AI 羽毛球集锦<span className="text-primary">生成器</span>
          </h1>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
            全自动提取视频中的精彩回合，提供专业级逐帧审查及无损拼接导出功能。
          </p>
        </header>

        {status === "idle" && (
          <VideoUploader
            onUploadSuccess={(filePath, id) => {
              if (id) {
                setTaskId(id);
                setStatus("processing"); // 开始进入轮询
              }
            }}
          />
        )}

        {/* Polling States */}
        {(status === "processing" || status === "ai_processing") && (
          <div className="flex flex-col items-center justify-center p-12 border rounded-xl bg-card shadow-sm space-y-4">
            <Loader2 className="w-12 h-12 text-primary animate-spin" />
            <h3 className="text-xl font-semibold">
              {status === "processing" ? "正在压制前端预览代理视频..." : "预览就绪，AI 正在分析回合轨迹..."}
            </h3>
            <p className="text-muted-foreground text-sm">
              请耐心等待，这可能需要几分钟的时间
            </p>
          </div>
        )}

        {/* Player Area */}
        {proxyUrl && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-700">
            <div className="flex items-center justify-between border-b pb-4">
              <div>
                <h2 className="text-2xl font-bold flex items-center gap-2">
                  审查时间轴
                  {status === "ai_processing" && (
                    <span className="text-xs font-normal bg-secondary text-secondary-foreground px-2 py-1 rounded-md animate-pulse">
                      AI 分析中...
                    </span>
                  )}
                </h2>
                <p className="text-sm text-muted-foreground">代理视频已加载，您可以在 AI 分析完成前先行预览</p>
              </div>

              {status === "completed" && rallies.length > 0 && !highlightUrl && (
                <Button onClick={handleGenerateHighlight} disabled={isGenerating} size="lg" className="shadow-lg">
                  {isGenerating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Scissors className="w-4 h-4 mr-2" />}
                  合成精彩集锦
                </Button>
              )}
            </div>

            <CustomPlayer
              videoUrl={proxyUrl}
              rallies={rallies}
              onRalliesChange={setRallies}
            />
          </div>
        )}

        {/* Final Result */}
        {highlightUrl && (
          <div className="mt-8 p-8 border-2 border-green-500/30 bg-green-500/5 rounded-xl flex flex-col items-center text-center space-y-4 animate-in zoom-in duration-500">
            <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center mb-2">
              <CheckCircle2 className="w-8 h-8 text-green-600" />
            </div>
            <h3 className="text-2xl font-bold text-green-700">合成处理完毕！</h3>
            <p className="text-green-600/80 mb-4 cursor-pointer">
              原始画质的精彩集锦已经生成完毕。
            </p>
            <Button size="lg" asChild className="bg-green-600 hover:bg-green-700 text-white shadow-xl">
              <a href={highlightUrl} download target="_blank" rel="noreferrer">
                <Download className="w-5 h-5 mr-2" />
                下载最终集锦
              </a>
            </Button>
          </div>
        )}
      </div>
    </main>
  );
}
