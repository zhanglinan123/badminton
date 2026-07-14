"use client";

import React, { useRef, useState, useEffect, KeyboardEvent } from "react";
import { Play, Pause, SkipBack, SkipForward, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

export interface Rally {
    start: string;
    end: string;
    duration: number;
    start_frame: number;
    end_frame: number;
}

interface CustomPlayerProps {
    videoUrl: string;
    rallies: Rally[];
    onRalliesChange: (newRallies: Rally[]) => void;
    fps?: number;
}

export function CustomPlayer({
    videoUrl,
    rallies,
    onRalliesChange,
    fps = 30, // Default to Proxy Video FPS
}: CustomPlayerProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(1); // Default to 1 to avoid div by 0
    const [selectedRallyIndex, setSelectedRallyIndex] = useState<number | null>(null);

    const frameStep = 1 / fps;

    // Sync state with video element
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const handleTimeUpdate = () => setCurrentTime(video.currentTime);
        const handleDurationChange = () => setDuration(video.duration);
        const handlePlay = () => setIsPlaying(true);
        const handlePause = () => setIsPlaying(false);

        video.addEventListener("timeupdate", handleTimeUpdate);
        video.addEventListener("durationchange", handleDurationChange);
        video.addEventListener("play", handlePlay);
        video.addEventListener("pause", handlePause);

        return () => {
            video.removeEventListener("timeupdate", handleTimeUpdate);
            video.removeEventListener("durationchange", handleDurationChange);
            video.removeEventListener("play", handlePlay);
            video.removeEventListener("pause", handlePause);
        };
    }, []);

    // Time parsing helper "HH:MM:SS" to seconds
    const parseTime = (timeStr: string) => {
        const parts = timeStr.split(":").map(Number);
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        return 0;
    };

    // Keyboard controls
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
        if (!videoRef.current) return;

        // Disable if typing in an input
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

        switch (e.code) {
            case "Space":
                e.preventDefault();
                togglePlay();
                break;
            case "ArrowLeft":
                e.preventDefault();
                step(-1);
                break;
            case "ArrowRight":
                e.preventDefault();
                step(1);
                break;
            case "Backspace":
            case "Delete":
                if (selectedRallyIndex !== null) {
                    e.preventDefault();
                    deleteSelectedRally();
                }
                break;
        }
    };

    useEffect(() => {
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [isPlaying, selectedRallyIndex]); // Need these deps for closures

    const togglePlay = () => {
        if (videoRef.current?.paused) {
            videoRef.current.play();
        } else {
            videoRef.current?.pause();
        }
    };

    const step = (frames: number) => {
        if (!videoRef.current) return;
        let newTime = videoRef.current.currentTime + frames * frameStep;
        newTime = Math.max(0, Math.min(newTime, duration));
        videoRef.current.currentTime = newTime;
    };

    const handleSeek = (value: number[]) => {
        if (!videoRef.current) return;
        videoRef.current.currentTime = value[0];
    };

    const deleteSelectedRally = () => {
        if (selectedRallyIndex === null) return;
        const newRallies = [...rallies];
        newRallies.splice(selectedRallyIndex, 1);
        onRalliesChange(newRallies);
        setSelectedRallyIndex(null);
    };

    const formatDisplayTime = (seconds: number) => {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 100);
        if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}.${ms.toString().padStart(2, "0")}`;
        return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}.${ms.toString().padStart(2, "0")}`;
    };

    return (
        <div className="w-full bg-background border rounded-xl overflow-hidden shadow-lg flex flex-col focus:outline-none" tabIndex={0}>
            {/* Video Display */}
            <div className="relative w-full aspect-video bg-black flex items-center justify-center">
                <video
                    ref={videoRef}
                    src={videoUrl}
                    className="w-full h-full object-contain"
                    onClick={togglePlay}
                    preload="auto"
                />

                {/* Overlay Current Active Rally Info (Optional) */}
                {rallies.map((rally, idx) => {
                    const start = parseTime(rally.start);
                    const end = parseTime(rally.end);
                    if (currentTime >= start && currentTime <= end) {
                        return (
                            <div key={idx} className="absolute top-4 right-4 bg-primary/80 text-primary-foreground px-3 py-1 rounded-md text-sm font-semibold animate-pulse shadow-md">
                                播放回合 #{idx + 1}
                            </div>
                        )
                    }
                    return null;
                })}
            </div>

            {/* Controls Area */}
            <div className="p-4 bg-card flex flex-col gap-4 border-t">
                {/* Timeline with Rallies */}
                <div className="relative h-12 flex items-center w-full group py-2">
                    {/* Base Slider */}
                    <div className="absolute inset-x-0 h-full flex items-center z-10 opacity-0 group-hover:opacity-100 transition-opacity translate-y-[2px]">
                        <Slider
                            value={[currentTime]}
                            max={duration}
                            step={frameStep}
                            onValueChange={handleSeek}
                            className="w-full relative z-20 cursor-pointer"
                        />
                    </div>

                    {/* Visual Track */}
                    <div className="absolute inset-x-0 h-3 bg-secondary rounded-full overflow-hidden pointer-events-none z-0">
                        {/* Render Highlight Blocks */}
                        {rallies.map((rally, idx) => {
                            const startTime = parseTime(rally.start);
                            const endTime = parseTime(rally.end);
                            const leftPercent = (startTime / duration) * 100;
                            const widthPercent = ((endTime - startTime) / duration) * 100;
                            const isSelected = selectedRallyIndex === idx;

                            return (
                                <div
                                    key={idx}
                                    className={cn(
                                        "absolute top-0 bottom-0 pointer-events-auto cursor-pointer transition-colors border-x border-background/50",
                                        isSelected ? "bg-destructive hover:bg-destructive/90" : "bg-primary hover:bg-primary/80"
                                    )}
                                    style={{
                                        left: `${Math.max(0, leftPercent)}%`,
                                        width: `${Math.min(100 - leftPercent, widthPercent)}%`,
                                    }}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        videoRef.current!.currentTime = startTime; // Seek to start of rally
                                        setSelectedRallyIndex(idx);
                                    }}
                                    title={`回合 #${idx + 1}: ${rally.duration}s`}
                                />
                            );
                        })}
                    </div>

                    {/* Playhead Marker */}
                    <div
                        className="absolute top-0 bottom-0 w-[2px] bg-red-500 z-10 pointer-events-none"
                        style={{ left: `${(currentTime / duration) * 100}%` }}
                    />
                </div>

                {/* Toolbar */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Button variant="outline" size="icon" onClick={() => step(-5)}>
                            <SkipBack className="w-4 h-4" />
                        </Button>
                        <Button variant="default" size="icon" onClick={togglePlay} className="w-10 h-10">
                            {isPlaying ? <Pause className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current ml-1" />}
                        </Button>
                        <Button variant="outline" size="icon" onClick={() => step(5)}>
                            <SkipForward className="w-4 h-4" />
                        </Button>

                        <div className="ml-4 font-mono text-sm">
                            <span className="font-semibold text-foreground">{formatDisplayTime(currentTime)}</span>
                            <span className="text-muted-foreground mx-1">/</span>
                            <span className="text-muted-foreground">{formatDisplayTime(duration)}</span>
                        </div>
                    </div>

                    <div className="flex items-center gap-4">
                        {selectedRallyIndex !== null && (
                            <div className="text-sm bg-destructive/10 text-destructive px-3 py-1.5 rounded-md flex items-center gap-2 font-medium">
                                已选定回合 #{selectedRallyIndex + 1}
                                <Button variant="destructive" size="sm" className="h-6 px-2 text-xs" onClick={deleteSelectedRally}>
                                    <Trash2 className="w-3 h-3 mr-1" /> 删除该段 (Del)
                                </Button>
                            </div>
                        )}
                        <p className="text-xs text-muted-foreground hidden sm:block">
                            提示: 空格键 播放/暂停 | 左右箭头 逐帧步进
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
