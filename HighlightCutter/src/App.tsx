import React, { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import { Toaster, toast } from 'react-hot-toast';
import { Play, Pause, Scissors, Trash2, Undo, Upload, CheckSquare, FastForward, Rewind } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

interface Mark {
    id: string;
    start: number;
    end: number;
}

export default function App() {
    const [videoFile, setVideoFile] = useState<File | null>(null);
    const [videoUrl, setVideoUrl] = useState<string>('');
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);

    const [marks, setMarks] = useState<Mark[]>([]);
    const [currentStart, setCurrentStart] = useState<number | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);

    const videoRef = useRef<HTMLVideoElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!videoRef.current || e.target instanceof HTMLInputElement) return;

            const time = videoRef.current.currentTime;
            switch (e.key.toLowerCase()) {
                case 'q':
                    e.preventDefault();
                    setCurrentStart(time);
                    toast.success(`标记起点: ${formatTime(time)}`);
                    break;
                case 'w':
                    e.preventDefault();
                    if (currentStart !== null) {
                        if (time <= currentStart) {
                            toast.error('终点时间必须大于起点时间');
                            return;
                        }
                        const newMark = { id: Date.now().toString(), start: currentStart, end: time };
                        setMarks(prev => [...prev, newMark]);
                        setCurrentStart(null);
                        toast.success(`提取片段: ${formatTime(currentStart)} - ${formatTime(time)}`);
                    } else {
                        toast.error('请先按 Q 标记起点');
                    }
                    break;
                case 'e':
                    e.preventDefault();
                    setMarks(prev => {
                        if (prev.length === 0) {
                            toast("没有可撤销的标记片段");
                            return prev;
                        }
                        const newMarks = [...prev];
                        const popped = newMarks.pop();
                        toast(`已撤销片段: ${formatTime(popped!.start)} - ${formatTime(popped!.end)}`, { icon: '↩️' });
                        return newMarks;
                    });
                    break;
                case ' ':
                    e.preventDefault();
                    togglePlay();
                    break;
                case 'arrowleft':
                    e.preventDefault();
                    videoRef.current.currentTime = Math.max(0, videoRef.current.currentTime - 1 / 30);
                    break;
                case 'arrowright':
                    e.preventDefault();
                    videoRef.current.currentTime = Math.min(videoRef.current.duration, videoRef.current.currentTime + 1 / 30);
                    break;
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [currentStart]);

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            setVideoFile(file);
            const url = URL.createObjectURL(file);
            setVideoUrl(url);
            setMarks([]);
            setCurrentStart(null);
        }
    };

    const togglePlay = () => {
        if (videoRef.current) {
            if (isPlaying) {
                videoRef.current.pause();
            } else {
                videoRef.current.play();
            }
            setIsPlaying(!isPlaying);
        }
    };

    const handleTimeUpdate = () => {
        if (videoRef.current) {
            setCurrentTime(videoRef.current.currentTime);
        }
    };

    const handleLoadedMetadata = () => {
        if (videoRef.current) {
            setDuration(videoRef.current.duration);
        }
    };

    const formatTime = (seconds: number) => {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 100);
        return `${h > 0 ? h.toString().padStart(2, '0') + ':' : ''}${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
    };

    const formatTimeHHMMSS = (seconds: number) => {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }

    const handleDeleteMark = (id: string) => {
        setMarks(marks.filter(m => m.id !== id));
    };

    const handleSeek = (time: number) => {
        if (videoRef.current) {
            videoRef.current.currentTime = time;
        }
    }

    const handleProcess = async () => {
        if (!videoFile || marks.length === 0) {
            toast.error('请先选择视频并标记至少一个片段');
            return;
        }

        setIsProcessing(true);
        const toastId = toast.loading(`正在处理 ${marks.length} 个片段，请稍候...`);

        try {
            const formData = new FormData();
            formData.append('video', videoFile);
            formData.append('cuts', JSON.stringify(
                marks.map(m => ({ start: formatTimeHHMMSS(m.start), end: formatTimeHHMMSS(m.end) }))
            ));

            toast.loading(`上传中，后端裁剪&合并，请耐心等待...`, { id: toastId });

            const res = await axios.post('/api/process-batch', formData, {
                // 大文件上传超时设为10分钟
                timeout: 10 * 60 * 1000,
            });

            if (res.data.success) {
                toast.success(`✅ 处理完成！开始下载...`, { id: toastId, duration: 4000 });
                // 触发下载
                const a = document.createElement('a');
                a.href = res.data.downloadUrl;
                a.download = res.data.filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            } else {
                toast.error(res.data.error || '处理失败，请重试', { id: toastId });
            }
        } catch (error: any) {
            console.error('[handleProcess] error:', error);
            const msg = error?.response?.data?.error || error?.message || '网络错误，请检查服务是否正常';
            toast.error(msg, { id: toastId });
        } finally {
            setIsProcessing(false);
        }
    };

    return (
        <div className="min-h-screen bg-neutral-900 text-neutral-100 p-8 font-sans">
            <Toaster position="top-center" />

            <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-8">

                {/* 左侧：视频播放和控制台 */}
                <div className="lg:col-span-2 space-y-4">
                    <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-emerald-400 to-cyan-500 bg-clip-text text-transparent flex items-center gap-3">
                        <Scissors className="w-8 h-8 text-emerald-400" />
                        羽毛球精彩集锦快剪
                    </h1>

                    <div className="bg-neutral-800 rounded-2xl overflow-hidden shadow-2xl ring-1 ring-white/10 relative">
                        {videoUrl ? (
                            <div className="relative group aspect-video bg-black flex items-center justify-center">
                                <video
                                    ref={videoRef}
                                    src={videoUrl}
                                    className="w-full max-h-full object-contain"
                                    onTimeUpdate={handleTimeUpdate}
                                    onLoadedMetadata={handleLoadedMetadata}
                                    onClick={togglePlay}
                                />

                                {/* Time Overlay */}
                                <div className="absolute top-4 right-4 bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-lg text-emerald-400 font-mono text-sm tracking-widest ring-1 ring-white/10 opacity-0 group-hover:opacity-100 transition-opacity">
                                    {formatTime(currentTime)} / {formatTime(duration)}
                                </div>

                                {/* Pending Start Marker */}
                                {currentStart !== null && (
                                    <div className="absolute top-4 left-4 bg-red-500/80 backdrop-blur-md px-3 py-1 rounded shadow-lg text-white font-mono text-xs flex items-center gap-2 animate-pulse">
                                        <span className="w-2 h-2 rounded-full bg-white"></span>
                                        录像中: 自 {formatTime(currentStart)} 起
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div
                                className="aspect-video border-2 border-dashed border-neutral-700 m-8 rounded-xl flex flex-col items-center justify-center text-neutral-500 hover:border-emerald-500 hover:text-emerald-400 hover:bg-emerald-500/5 transition-all cursor-pointer"
                                onClick={() => fileInputRef.current?.click()}
                            >
                                <Upload className="w-12 h-12 mb-4" />
                                <p className="text-lg font-medium">点击或拖拽上传主视频</p>
                                <p className="text-sm opacity-60 mt-2">支持 MP4, MOV 格式</p>
                            </div>
                        )}
                    </div>

                    <div className="bg-neutral-800 rounded-xl p-6 ring-1 ring-white/10">
                        <div className="flex items-center justify-between mb-6">
                            <div className="flex gap-4 items-center">
                                <button onClick={() => { if (videoRef.current) videoRef.current.currentTime -= 5 }} className="p-3 bg-neutral-700 hover:bg-neutral-600 rounded-full transition-colors" title="-5s">
                                    <Rewind className="w-5 h-5 text-neutral-300" />
                                </button>
                                <button onClick={togglePlay} className="p-4 bg-emerald-500 hover:bg-emerald-400 rounded-full transition-transform hover:scale-105 shadow-lg shadow-emerald-500/20 active:scale-95 text-neutral-900">
                                    {isPlaying ? <Pause className="w-6 h-6 fill-current" /> : <Play className="w-6 h-6 ml-1 fill-current" />}
                                </button>
                                <button onClick={() => { if (videoRef.current) videoRef.current.currentTime += 5 }} className="p-3 bg-neutral-700 hover:bg-neutral-600 rounded-full transition-colors" title="+5s">
                                    <FastForward className="w-5 h-5 text-neutral-300" />
                                </button>
                            </div>

                            <div className="flex gap-4 text-xs font-mono">
                                <kbd className="px-3 py-2 bg-neutral-700 rounded-lg text-neutral-300 ring-1 ring-neutral-600 shadow-sm flex items-center gap-2">
                                    <span className="text-emerald-400 font-bold">Q</span> 记起
                                </kbd>
                                <kbd className="px-3 py-2 bg-neutral-700 rounded-lg text-neutral-300 ring-1 ring-neutral-600 shadow-sm flex items-center gap-2">
                                    <span className="text-emerald-400 font-bold">W</span> 记止
                                </kbd>
                                <kbd className="px-3 py-2 bg-neutral-700 rounded-lg text-neutral-300 ring-1 ring-neutral-600 shadow-sm flex items-center gap-2">
                                    <span className="text-amber-400 font-bold">E</span> 撤销
                                </kbd>
                                <kbd className="px-3 py-2 bg-neutral-700 rounded-lg text-neutral-300 ring-1 ring-neutral-600 shadow-sm flex items-center gap-2">
                                    <span className="text-sky-400 font-bold">← →</span> 逐帧
                                </kbd>
                            </div>
                        </div>

                        {/* Progress bar visualizer */}
                        <div className="relative h-4 bg-neutral-900 rounded-full overflow-hidden mb-2 cursor-pointer"
                            onClick={(e) => {
                                if (videoRef.current && duration) {
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    const x = e.clientX - rect.left;
                                    const ratio = x / rect.width;
                                    videoRef.current.currentTime = ratio * duration;
                                }
                            }}>
                            <div className="absolute top-0 left-0 bottom-0 bg-neutral-700 w-full"></div>
                            {marks.map(m => (
                                <div key={m.id} className="absolute top-0 bottom-0 bg-emerald-500/40 border-x border-emerald-400/50"
                                    style={{ left: `${(m.start / duration) * 100}%`, width: `${((m.end - m.start) / duration) * 100}%` }}>
                                </div>
                            ))}
                            <div className="absolute top-0 bottom-0 w-1 bg-white shadow-[0_0_10px_white] transition-all duration-75" style={{ left: `${(currentTime / duration) * 100}%` }}></div>
                        </div>
                    </div>

                    <input
                        type="file"
                        ref={fileInputRef}
                        className="hidden"
                        accept="video/*"
                        onChange={handleFileSelect}
                    />
                </div>

                {/* 右侧：片段列表 */}
                <div className="flex flex-col h-[calc(100vh-4rem)]">
                    <div className="bg-neutral-800 rounded-2xl flex-1 ring-1 ring-white/10 flex flex-col shadow-xl overflow-hidden">
                        <div className="p-5 border-b border-neutral-700 bg-neutral-800/80 backdrop-blur z-10 flex justify-between items-center">
                            <h2 className="text-lg font-semibold flex items-center gap-2 text-neutral-100">
                                <CheckSquare className="w-5 h-5 text-emerald-400" />
                                待提取剪辑 ({marks.length})
                            </h2>
                            {marks.length > 0 && (
                                <button onClick={() => setMarks([])} className="text-sm text-neutral-400 hover:text-red-400 transition-colors">清空</button>
                            )}
                        </div>

                        <div className="flex-1 overflow-y-auto p-3 space-y-2 relative">
                            {marks.length === 0 ? (
                                <div className="absolute inset-0 flex flex-col items-center justify-center text-neutral-500 p-8 text-center">
                                    <Scissors className="w-12 h-12 mb-3 opacity-20" />
                                    <p>播放视频时按<br /> <b>Q</b>开始截取，<b>W</b>结束截取</p>
                                </div>
                            ) : (
                                marks.map((mark, idx) => (
                                    <div key={mark.id} className="group bg-neutral-700/50 hover:bg-neutral-700 rounded-xl p-3 flex items-center gap-3 transition-colors ring-1 ring-transparent hover:ring-neutral-600">
                                        <span className="bg-neutral-900 text-emerald-400 w-6 h-6 rounded flex items-center justify-center text-xs font-bold font-mono border border-emerald-500/20">{idx + 1}</span>
                                        <div className="flex-1 text-sm font-mono tracking-tight text-neutral-300">
                                            <span onClick={() => handleSeek(mark.start)} className="cursor-pointer hover:text-emerald-300 transition-colors border-b border-dashed border-transparent hover:border-emerald-300">{formatTimeHHMMSS(mark.start)}</span>
                                            <span className="text-neutral-500 mx-2">→</span>
                                            <span onClick={() => handleSeek(mark.end)} className="cursor-pointer hover:text-emerald-300 transition-colors border-b border-dashed border-transparent hover:border-emerald-300">{formatTimeHHMMSS(mark.end)}</span>
                                        </div>
                                        <div className="text-xs font-mono text-neutral-500 mr-2">
                                            {((mark.end - mark.start)).toFixed(1)}s
                                        </div>
                                        <button
                                            onClick={() => handleDeleteMark(mark.id)}
                                            className="p-1.5 text-neutral-400 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-all opacity-0 group-hover:opacity-100"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    </div>
                                ))
                            )}
                        </div>

                        <div className="p-4 border-t border-neutral-700 bg-neutral-900/50">
                            <button
                                onClick={handleProcess}
                                disabled={isProcessing || marks.length === 0}
                                className={cn(
                                    "w-full py-4 rounded-xl font-bold flexitems-center justify-center gap-2 transition-all shadow-xl font-sans",
                                    isProcessing || marks.length === 0
                                        ? "bg-neutral-700 text-neutral-500 cursor-not-allowed"
                                        : "bg-emerald-500 text-neutral-900 hover:bg-emerald-400 hover:scale-[1.02] active:scale-[0.98] shadow-emerald-500/20"
                                )}
                            >
                                {isProcessing ? '正在云计算处理中...' : `一键出片 (共 ${(marks.reduce((a, b) => a + (b.end - b.start), 0)).toFixed(1)} 秒)`}
                            </button>
                        </div>
                    </div>
                </div>

            </div>
        </div>
    );
}
