import React, { useState, useRef, useEffect, useMemo } from 'react';
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

interface SourceAnnotation {
    start_seconds: number;
    end_seconds: number;
}

interface AiPrediction extends SourceAnnotation {
    hit_count: number;
    confidence: number;
}

interface ReviewIssue extends SourceAnnotation {
    reasons: ReviewReason[];
    confidence?: number | null;
    hit_count?: number | null;
    reviewed_at?: string;
}

interface ReviewAccepted extends SourceAnnotation {
    confidence?: number | null;
    hit_count?: number | null;
    reviewed_at?: string;
}

const reviewReasons = [
    { code: 'start_too_early', label: '开头太早，有多余画面' },
    { code: 'start_too_late', label: '开头太晚，前面被截掉' },
    { code: 'end_too_early', label: '结束太早，回合还没打完' },
    { code: 'end_too_late', label: '结束太晚，死球还在播放' },
    { code: 'merged_rallies', label: '多个回合连在一起' },
    { code: 'not_a_rally', label: '这段不是有效回合' },
] as const;

type ReviewReason = typeof reviewReasons[number]['code'];

interface SourceVideo {
    name: string;
    url: string;
    size_bytes: number;
    fps: number;
    duration_seconds: number;
    annotation_status: 'annotated' | 'unannotated' | 'invalid';
    annotation_count: number;
    annotations: SourceAnnotation[];
    ai_status: 'available' | 'unavailable' | 'invalid';
    ai_count: number;
    ai_predictions: AiPrediction[];
    model_fingerprint: string | null;
    review_issue_count: number;
    review_issues: ReviewIssue[];
    review_accepted_count: number;
    review_accepted: ReviewAccepted[];
    review_complete: boolean;
}

function intervalIou(left: SourceAnnotation, right: SourceAnnotation) {
    const intersection = Math.max(0, Math.min(left.end_seconds, right.end_seconds) - Math.max(left.start_seconds, right.start_seconds));
    const union = Math.max(left.end_seconds, right.end_seconds) - Math.min(left.start_seconds, right.start_seconds);
    return union > 0 ? intersection / union : 0;
}

function compareRallies(marks: Mark[], predictions: AiPrediction[], threshold = 0.5) {
    const eligibleMarkIndexes = new Set(marks
        .map((mark, index) => ({ mark, index }))
        .filter(({ mark }) => mark.end - mark.start >= 5)
        .map(({ index }) => index));
    const candidates = marks.flatMap((mark, markIndex) => eligibleMarkIndexes.has(markIndex)
        ? predictions.map((prediction, predictionIndex) => ({
        markIndex,
        predictionIndex,
        iou: intervalIou(
            { start_seconds: mark.start, end_seconds: mark.end },
            prediction,
        ),
    }))
        : []).sort((a, b) => b.iou - a.iou);
    const matchedMarks = new Set<number>();
    const matchedPredictions = new Set<number>();

    for (const candidate of candidates) {
        if (candidate.iou < threshold) break;
        if (matchedMarks.has(candidate.markIndex) || matchedPredictions.has(candidate.predictionIndex)) continue;
        matchedMarks.add(candidate.markIndex);
        matchedPredictions.add(candidate.predictionIndex);
    }

    const truePositive = matchedMarks.size;
    const precision = predictions.length ? truePositive / predictions.length : 0;
    const recall = eligibleMarkIndexes.size ? truePositive / eligibleMarkIndexes.size : 0;
    return {
        manual: marks.map((mark, index) => ({
            ...mark,
            status: !eligibleMarkIndexes.has(index) ? 'ignored' : matchedMarks.has(index) ? 'matched' : 'missed',
        })),
        ai: predictions.map((prediction, index) => ({
            ...prediction,
            id: `ai-${index}`,
            status: matchedPredictions.has(index) ? 'matched' : 'false-positive' as const,
        })),
        truePositive,
        falseNegative: eligibleMarkIndexes.size - truePositive,
        falsePositive: predictions.length - truePositive,
        ignored: marks.length - eligibleMarkIndexes.size,
        f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0,
    };
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
    const [fps, setFps] = useState<number | null>(null);
    const [sourceVideos, setSourceVideos] = useState<SourceVideo[]>([]);
    const [selectedSourceVideo, setSelectedSourceVideo] = useState<SourceVideo | null>(null);
    const [aiPredictions, setAiPredictions] = useState<AiPrediction[]>([]);
    const [selectedMarkId, setSelectedMarkId] = useState<string | null>(null);
    const [reviewedMarkIds, setReviewedMarkIds] = useState<string[]>([]);
    const [simpleReviewActive, setSimpleReviewActive] = useState(false);
    const [simpleReviewIndex, setSimpleReviewIndex] = useState(0);
    const [reviewIssues, setReviewIssues] = useState<ReviewIssue[]>([]);
    const [reviewAccepted, setReviewAccepted] = useState<ReviewAccepted[]>([]);
    const [awaitingReviewDecision, setAwaitingReviewDecision] = useState(false);
    const [problemDialogOpen, setProblemDialogOpen] = useState(false);
    const [selectedProblemReasons, setSelectedProblemReasons] = useState<ReviewReason[]>([]);

    const review = useMemo(() => compareRallies(marks, aiPredictions), [marks, aiPredictions]);
    const orderedMarks = useMemo(() => [...marks].sort((a, b) => a.start - b.start), [marks]);
    const selectedMark = marks.find(mark => mark.id === selectedMarkId) || null;
    const reviewedCount = marks.filter(mark => reviewedMarkIds.includes(mark.id)).length;

    const videoRef = useRef<HTMLVideoElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const loadSourceVideos = async () => {
        try {
            const response = await fetch('/api/source-videos');
            if (!response.ok) throw new Error('视频目录读取失败');
            const data = await response.json();
            setSourceVideos(data.videos || []);
        } catch (error) {
            console.error('[source-videos] load failed:', error);
            toast.error('视频目录读取失败，请检查服务端路径');
        }
    };

    useEffect(() => {
        void loadSourceVideos();
    }, []);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!videoRef.current || e.target instanceof HTMLInputElement || !fps) return;

            const time = videoRef.current.currentTime;
            const key = e.key.toLowerCase();
            if (problemDialogOpen) {
                const reason = reviewReasons[Number(e.key) - 1];
                if (reason) {
                    e.preventDefault();
                    handleToggleProblemReason(reason.code);
                } else if (e.key === 'Enter' && selectedProblemReasons.length > 0) {
                    e.preventDefault();
                    handleConfirmProblemReasons();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setProblemDialogOpen(false);
                    setSelectedProblemReasons([]);
                }
                return;
            }
            if (simpleReviewActive && awaitingReviewDecision && key === 'a') {
                e.preventDefault();
                handleReportProblem();
                return;
            }
            if (simpleReviewActive && key === 's') {
                e.preventDefault();
                handleUndoReview();
                return;
            }
            if (simpleReviewActive && awaitingReviewDecision && e.key === 'Enter') {
                e.preventDefault();
                handleAcceptReview();
                return;
            }
            switch (key) {
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
                        setSelectedMarkId(newMark.id);
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
                    videoRef.current.currentTime = Math.max(0, videoRef.current.currentTime - 1 / fps);
                    break;
                case 'arrowright':
                    e.preventDefault();
                    videoRef.current.currentTime = Math.min(videoRef.current.duration, videoRef.current.currentTime + 1 / fps);
                    break;
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [currentStart, fps, simpleReviewActive, simpleReviewIndex, aiPredictions, reviewIssues,
        reviewAccepted, selectedSourceVideo, problemDialogOpen, selectedProblemReasons, awaitingReviewDecision]);

    const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            setSelectedSourceVideo(null);
            setFps(null);
            setVideoFile(file);
            const url = URL.createObjectURL(file);
            setVideoUrl(url);
            setMarks([]);
            setAiPredictions([]);
            setSelectedMarkId(null);
            setReviewedMarkIds([]);
            setSimpleReviewActive(false);
            setSimpleReviewIndex(0);
            setReviewIssues([]);
            setReviewAccepted([]);
            setAwaitingReviewDecision(false);
            setProblemDialogOpen(false);
            setSelectedProblemReasons([]);
            setCurrentStart(null);
            try {
                const formData = new FormData();
                formData.append('video', file);
                const response = await fetch('/api/video-metadata', {
                    method: 'POST',
                    body: formData,
                });
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || '无法读取视频 FPS');
                setFps(data.fps);
            } catch (error: any) {
                toast.error(error.message || '无法读取视频 FPS');
            }
        }
    };

    const handleSourceVideoSelect = (video: SourceVideo) => {
        setSelectedSourceVideo(video);
        setVideoFile(null);
        setFps(video.fps);
        setVideoUrl(video.url);
        setAiPredictions(video.ai_predictions || []);
        setMarks(video.annotations.map((annotation, index) => ({
            id: `${video.name}-${index}`,
            start: annotation.start_seconds,
            end: annotation.end_seconds,
        })));
        setSelectedMarkId(null);
        setReviewedMarkIds([]);
        setSimpleReviewActive(false);
        setSimpleReviewIndex(0);
        setReviewIssues(video.review_issues || []);
        setReviewAccepted(video.review_accepted || []);
        setAwaitingReviewDecision(false);
        setProblemDialogOpen(false);
        setSelectedProblemReasons([]);
        setCurrentStart(null);
        setCurrentTime(0);
        setDuration(0);
        setIsPlaying(false);
        toast.success(video.annotation_status === 'annotated'
            ? `已加载 ${video.annotation_count} 个已有标注`
            : '已加载未标注视频');
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
            const time = videoRef.current.currentTime;
            setCurrentTime(time);
            const prediction = aiPredictions[simpleReviewIndex];
            if (simpleReviewActive && prediction && time >= prediction.end_seconds - 0.03
                && !awaitingReviewDecision) {
                videoRef.current.pause();
                setIsPlaying(false);
                setAwaitingReviewDecision(true);
            }
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
        setMarks(prev => prev.filter(mark => mark.id !== id));
        setReviewedMarkIds(prev => prev.filter(reviewedId => reviewedId !== id));
        if (selectedMarkId === id) setSelectedMarkId(null);
    };

    const handleSeek = (time: number) => {
        if (videoRef.current) {
            videoRef.current.currentTime = time;
        }
    }

    const playSimpleReview = (index: number) => {
        if (!videoRef.current || index >= aiPredictions.length) {
            setSimpleReviewActive(false);
            setSimpleReviewIndex(aiPredictions.length);
            setAwaitingReviewDecision(false);
            videoRef.current?.pause();
            setIsPlaying(false);
            toast.success('AI 片段已看完');
            return;
        }
        setSimpleReviewActive(true);
        setProblemDialogOpen(false);
        setSelectedProblemReasons([]);
        setAwaitingReviewDecision(false);
        setSimpleReviewIndex(index);
        videoRef.current.currentTime = aiPredictions[index].start_seconds;
        void videoRef.current.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
    };

    const saveReview = async (issues: ReviewIssue[], accepted: ReviewAccepted[]) => {
        if (!selectedSourceVideo) return;
        try {
            const response = await fetch('/api/review-issues', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source_video: selectedSourceVideo.name, issues, accepted }),
            });
            if (!response.ok) throw new Error('保存失败');
        } catch (error) {
            console.error('[review-issues] save failed:', error);
            toast.error('问题记录保存失败');
        }
    };

    const handleReportProblem = () => {
        const prediction = aiPredictions[simpleReviewIndex];
        if (!simpleReviewActive || !awaitingReviewDecision || !prediction) return;
        videoRef.current?.pause();
        setIsPlaying(false);
        setSelectedProblemReasons([]);
        setProblemDialogOpen(true);
    };

    const handleToggleProblemReason = (reason: ReviewReason) => {
        setSelectedProblemReasons(prev => prev.includes(reason)
            ? prev.filter(item => item !== reason)
            : [...prev, reason]);
    };

    const handleConfirmProblemReasons = () => {
        const prediction = aiPredictions[simpleReviewIndex];
        if (!prediction || selectedProblemReasons.length === 0) return;
        const next = [...reviewIssues.filter(issue => issue.start_seconds !== prediction.start_seconds
            || issue.end_seconds !== prediction.end_seconds), {
            start_seconds: prediction.start_seconds,
            end_seconds: prediction.end_seconds,
            confidence: prediction.confidence,
            hit_count: prediction.hit_count,
            reasons: selectedProblemReasons,
            reviewed_at: new Date().toISOString(),
        }];
        const nextAccepted = reviewAccepted.filter(item => item.start_seconds !== prediction.start_seconds
            || item.end_seconds !== prediction.end_seconds);
        setProblemDialogOpen(false);
        setSelectedProblemReasons([]);
        setReviewIssues(next);
        setReviewAccepted(nextAccepted);
        void saveReview(next, nextAccepted);
        playSimpleReview(simpleReviewIndex + 1);
    };

    const handleAcceptReview = () => {
        const prediction = aiPredictions[simpleReviewIndex];
        if (!simpleReviewActive || !awaitingReviewDecision || !prediction) return;
        const nextIssues = reviewIssues.filter(issue => issue.start_seconds !== prediction.start_seconds
            || issue.end_seconds !== prediction.end_seconds);
        const nextAccepted = [...reviewAccepted.filter(item => item.start_seconds !== prediction.start_seconds
            || item.end_seconds !== prediction.end_seconds), {
            start_seconds: prediction.start_seconds,
            end_seconds: prediction.end_seconds,
            confidence: prediction.confidence,
            hit_count: prediction.hit_count,
            reviewed_at: new Date().toISOString(),
        }];
        setReviewIssues(nextIssues);
        setReviewAccepted(nextAccepted);
        void saveReview(nextIssues, nextAccepted);
        playSimpleReview(simpleReviewIndex + 1);
    };

    const handleUndoReview = () => {
        const issue = reviewIssues.at(-1);
        const accepted = reviewAccepted.at(-1);
        const issueTime = issue?.reviewed_at ? Date.parse(issue.reviewed_at) : -1;
        const acceptedTime = accepted?.reviewed_at ? Date.parse(accepted.reviewed_at) : -1;
        const item = issueTime >= acceptedTime ? issue : accepted;
        if (!item) {
            toast('没有可撤销的验收结果');
            return;
        }
        setProblemDialogOpen(false);
        setSelectedProblemReasons([]);
        const nextIssues = item === issue ? reviewIssues.slice(0, -1) : reviewIssues;
        const nextAccepted = item === accepted ? reviewAccepted.slice(0, -1) : reviewAccepted;
        setReviewIssues(nextIssues);
        setReviewAccepted(nextAccepted);
        void saveReview(nextIssues, nextAccepted);
        const index = aiPredictions.findIndex(prediction => prediction.start_seconds === item.start_seconds
            && prediction.end_seconds === item.end_seconds);
        playSimpleReview(index >= 0 ? index : simpleReviewIndex);
        toast('已撤销，正在重播上一回合', { icon: '↩️' });
    };

    const handleStartSimpleReview = () => {
        const reviewed = [...reviewIssues, ...reviewAccepted];
        const index = aiPredictions.findIndex(prediction => !reviewed.some(item =>
            item.start_seconds === prediction.start_seconds && item.end_seconds === prediction.end_seconds));
        if (index < 0) {
            toast.success('所有 AI 片段都已验收');
            return;
        }
        playSimpleReview(index);
    };

    const handleStopSimpleReview = () => {
        setSimpleReviewActive(false);
        setAwaitingReviewDecision(false);
        setProblemDialogOpen(false);
        setSelectedProblemReasons([]);
        videoRef.current?.pause();
        setIsPlaying(false);
    };

    const handleSelectMark = (mark: Mark) => {
        setSelectedMarkId(mark.id);
        handleSeek(mark.start);
    };

    const handleCopyAiDraft = () => {
        if (aiPredictions.length === 0) {
            toast.error('当前视频没有 AI 识别结果');
            return;
        }
        if (marks.length > 0 && !window.confirm('复制 AI 草稿会覆盖当前人工标注，是否继续？')) return;
        const stamp = Date.now();
        const draft = aiPredictions.map((prediction, index) => ({
            id: `ai-draft-${stamp}-${index}`,
            start: prediction.start_seconds,
            end: prediction.end_seconds,
        }));
        setMarks(draft);
        setReviewedMarkIds([]);
        setSelectedMarkId(draft[0]?.id || null);
        if (draft[0]) handleSeek(draft[0].start);
        toast.success(`已复制 ${draft.length} 个 AI 回合作为人工草稿`);
    };

    const updateSelectedMark = (next: Mark) => {
        setMarks(prev => prev.map(mark => mark.id === next.id ? next : mark));
        setReviewedMarkIds(prev => prev.filter(id => id !== next.id));
    };

    const handleSetSelectedStart = () => {
        if (!selectedMark) return toast.error('请先选择一个人工片段');
        if (currentTime >= selectedMark.end - 0.05) return toast.error('新起点必须早于终点');
        updateSelectedMark({ ...selectedMark, start: currentTime });
        toast.success(`起点已修正为 ${formatTime(currentTime)}`);
    };

    const handleSetSelectedEnd = () => {
        if (!selectedMark) return toast.error('请先选择一个人工片段');
        if (currentTime <= selectedMark.start + 0.05) return toast.error('新终点必须晚于起点');
        updateSelectedMark({ ...selectedMark, end: currentTime });
        toast.success(`终点已修正为 ${formatTime(currentTime)}`);
    };

    const handleSplitSelected = () => {
        if (!selectedMark) return toast.error('请先选择一个人工片段');
        if (currentTime <= selectedMark.start + 0.1 || currentTime >= selectedMark.end - 0.1) {
            return toast.error('拆分位置必须在片段内部');
        }
        const stamp = Date.now();
        const left = { ...selectedMark, id: `${selectedMark.id}-left-${stamp}`, end: currentTime };
        const right = { ...selectedMark, id: `${selectedMark.id}-right-${stamp}`, start: currentTime };
        setMarks(prev => prev.flatMap(mark => mark.id === selectedMark.id ? [left, right] : [mark]));
        setReviewedMarkIds(prev => prev.filter(id => id !== selectedMark.id));
        setSelectedMarkId(right.id);
        toast.success(`已在 ${formatTime(currentTime)} 拆分片段`);
    };

    const selectNextUnreviewed = (confirmedId?: string) => {
        const reviewed = new Set(reviewedMarkIds);
        if (confirmedId) reviewed.add(confirmedId);
        const currentIndex = orderedMarks.findIndex(mark => mark.id === (confirmedId || selectedMarkId));
        const next = orderedMarks.slice(currentIndex + 1).find(mark => !reviewed.has(mark.id))
            || orderedMarks.find(mark => !reviewed.has(mark.id));
        setSelectedMarkId(next?.id || null);
        if (next) handleSeek(next.start);
        return next;
    };

    const handleStartReview = () => {
        if (selectedMark && !reviewedMarkIds.includes(selectedMark.id)) {
            handleSeek(selectedMark.start);
            return;
        }
        const next = selectNextUnreviewed();
        if (!next) toast.success('所有人工片段都已验收');
    };

    const handleConfirmAndNext = () => {
        if (!selectedMark) return handleStartReview();
        setReviewedMarkIds(prev => prev.includes(selectedMark.id) ? prev : [...prev, selectedMark.id]);
        const next = selectNextUnreviewed(selectedMark.id);
        toast.success(next ? '当前片段已确认，已跳到下一条' : '全部片段验收完成');
    };

    const handleExportAnnotations = async () => {
        const sourceVideoName = selectedSourceVideo?.name || videoFile?.name;
        if (!sourceVideoName) {
            toast.error('请先选择视频');
            return;
        }
        if (fps === null || !Number.isFinite(fps) || fps <= 0) {
            toast.error('正在读取视频真实 FPS，请稍后再导出');
            return;
        }

        const annotations = [...marks]
            .sort((a, b) => a.start - b.start)
            .map((mark, index) => ({
                id: index + 1,
                label: 'rally',
                start_seconds: Number(mark.start.toFixed(3)),
                end_seconds: Number(mark.end.toFixed(3)),
                duration_seconds: Number((mark.end - mark.start).toFixed(3)),
            }));
        const payload = {
            schema_version: 1,
            task: 'badminton_rally_segments',
            source_video: sourceVideoName,
            fps,
            duration_seconds: Number(duration.toFixed(3)),
            annotations,
        };

        if (selectedSourceVideo) {
            try {
                const response = await fetch('/api/annotations', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || '保存标注失败');

                const updatedVideo = {
                    ...selectedSourceVideo,
                    annotation_status: 'annotated' as const,
                    annotation_count: annotations.length,
                    annotations: annotations.map(annotation => ({
                        start_seconds: annotation.start_seconds,
                        end_seconds: annotation.end_seconds,
                    })),
                };
                setSelectedSourceVideo(updatedVideo);
                setSourceVideos(prev => prev.map(video => video.name === updatedVideo.name ? updatedVideo : video));
                toast.success(`已保存 ${annotations.length} 个标注到视频目录`);
            } catch (error: any) {
                toast.error(error.message || '保存标注失败');
            }
            return;
        }

        const baseName = sourceVideoName.replace(/\.[^/.]+$/, '') || 'video';
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${baseName}.annotations.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        toast.success(`已导出 ${annotations.length} 个回合标注`);
    };

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
            {problemDialogOpen && aiPredictions[simpleReviewIndex] && (
                <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="w-full max-w-2xl rounded-2xl bg-neutral-800 ring-1 ring-white/15 shadow-2xl p-6">
                        <h2 className="text-2xl font-bold text-neutral-100">这段哪里不对？</h2>
                        <p className="mt-2 text-sm text-neutral-400">
                            可以多选。按数字键切换选项，按 Enter 保存。
                        </p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-6">
                            {reviewReasons.map((reason, index) => (
                                <button
                                    key={reason.code}
                                    onClick={() => handleToggleProblemReason(reason.code)}
                                    className={cn(
                                        "rounded-xl px-4 py-4 text-left transition-colors ring-1",
                                        selectedProblemReasons.includes(reason.code)
                                            ? "bg-red-500/20 text-red-100 ring-red-400"
                                            : "bg-neutral-700 hover:bg-neutral-600 ring-neutral-600"
                                    )}
                                >
                                    <span className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-red-500/20 text-red-300 font-bold mr-3">
                                        {index + 1}
                                    </span>
                                    {reason.label}
                                </button>
                            ))}
                        </div>
                        <div className="flex items-center justify-between gap-4 mt-5">
                            <button
                                onClick={() => { setProblemDialogOpen(false); setSelectedProblemReasons([]); }}
                                className="text-sm text-neutral-400 hover:text-neutral-200"
                            >
                                Esc 取消
                            </button>
                            <button
                                onClick={handleConfirmProblemReasons}
                                disabled={selectedProblemReasons.length === 0}
                                className="px-5 py-3 rounded-lg bg-red-500 text-white font-bold hover:bg-red-400 disabled:opacity-40"
                            >
                                确认问题（{selectedProblemReasons.length}）
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-8">

                {/* 左侧：视频播放和控制台 */}
                <div className="lg:col-span-2 space-y-4">
                    <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-emerald-400 to-cyan-500 bg-clip-text text-transparent flex items-center gap-3">
                        <Scissors className="w-8 h-8 text-emerald-400" />
                        羽毛球精彩集锦快剪
                    </h1>

                    <section className="bg-neutral-800 rounded-2xl p-5 ring-1 ring-white/10 shadow-xl">
                        <div className="flex items-center justify-between gap-4 mb-4">
                            <div>
                                <h2 className="text-lg font-semibold text-neutral-100">视频库</h2>
                                <p className="text-xs text-neutral-500 mt-1">选择视频开始或继续人工回合标注（共 {sourceVideos.length} 个）</p>
                            </div>
                            <button
                                onClick={() => void loadSourceVideos()}
                                className="text-sm text-cyan-400 hover:text-cyan-300"
                            >
                                刷新
                            </button>
                        </div>
                        <div className="max-h-72 overflow-y-auto grid grid-cols-1 md:grid-cols-2 gap-2 pr-1">
                            {sourceVideos.map(video => {
                                const isSelected = selectedSourceVideo?.name === video.name;
                                const statusText = video.annotation_status === 'annotated'
                                    ? `已标注 · ${video.annotation_count} 个回合`
                                    : video.annotation_status === 'invalid'
                                        ? '标注文件损坏'
                                        : '未标注';
                                const statusClass = video.annotation_status === 'annotated'
                                    ? 'text-emerald-400'
                                    : video.annotation_status === 'invalid'
                                        ? 'text-red-400'
                                        : 'text-neutral-500';
                                return (
                                    <button
                                        key={video.name}
                                        onClick={() => handleSourceVideoSelect(video)}
                                        className={cn(
                                            "text-left rounded-lg px-3 py-2 ring-1 transition-colors",
                                            isSelected
                                                ? "bg-cyan-500/10 ring-cyan-400/70"
                                                : "bg-neutral-900/60 ring-neutral-700 hover:bg-neutral-700/70 hover:ring-neutral-600"
                                        )}
                                    >
                                        <p className="truncate text-sm text-neutral-200" title={video.name}>{video.name}</p>
                                        <p className={cn("text-xs mt-1", statusClass)}>{statusText}</p>
                                        <p className={cn(
                                            "text-xs mt-1",
                                            video.ai_status === 'available' ? 'text-cyan-400' : 'text-neutral-600'
                                        )}>
                                            {video.ai_status === 'available' ? `AI 已分析 · ${video.ai_count} 个回合` : '暂无 AI 结果'}
                                        </p>
                                    </button>
                                );
                            })}
                        </div>
                    </section>

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
                                {simpleReviewActive && (
                                    <div className="absolute bottom-4 left-4 bg-black/75 backdrop-blur-md px-4 py-2 rounded-lg text-sm ring-1 ring-emerald-400/50">
                                        <span className="text-emerald-300 font-bold">极简验收 {simpleReviewIndex + 1}/{aiPredictions.length}</span>
                                        <span className="text-neutral-300 ml-3">Enter 没问题 · A 有问题 · S 撤销</span>
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
                        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 mb-6">
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

                            <div className="flex flex-wrap gap-2 sm:gap-4 text-xs font-mono">
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

                        {/* Manual labels and AI predictions share one time axis. */}
                        <div className="relative h-9 bg-neutral-900 rounded-lg overflow-hidden mb-2 cursor-pointer ring-1 ring-neutral-700"
                            onClick={(e) => {
                                if (videoRef.current && duration) {
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    const x = e.clientX - rect.left;
                                    const ratio = x / rect.width;
                                    videoRef.current.currentTime = ratio * duration;
                                }
                            }}>
                            <div className="absolute top-0 left-0 bottom-0 bg-neutral-800 w-full"></div>
                            {duration > 0 && review.manual.map(mark => (
                                <div
                                    key={mark.id}
                                    title={`人工：${mark.status === 'ignored' ? '忽略短回合' : mark.status === 'matched' ? '命中' : '漏检'} ${formatTime(mark.start)}`}
                                    onClick={(event) => { event.stopPropagation(); handleSelectMark(mark); }}
                                    className={cn(
                                        "absolute top-0 h-1/2 border-x cursor-pointer",
                                        selectedMarkId === mark.id && "ring-2 ring-cyan-300 z-10",
                                        mark.status === 'ignored'
                                            ? "bg-neutral-500/50 border-neutral-400"
                                            : mark.status === 'matched'
                                                ? "bg-emerald-500/70 border-emerald-300"
                                                : "bg-red-500/80 border-red-300"
                                    )}
                                    style={{ left: `${(mark.start / duration) * 100}%`, width: `${((mark.end - mark.start) / duration) * 100}%` }}
                                >
                                </div>
                            ))}
                            {duration > 0 && review.ai.map(prediction => (
                                <div
                                    key={prediction.id}
                                    title={`AI：${prediction.status === 'matched' ? '命中' : '误检'} ${formatTime(prediction.start_seconds)}`}
                                    onClick={(event) => { event.stopPropagation(); handleSeek(prediction.start_seconds); }}
                                    className={cn(
                                        "absolute bottom-0 h-1/2 border-x cursor-pointer",
                                        prediction.status === 'matched'
                                            ? "bg-emerald-500/45 border-emerald-400"
                                            : "bg-amber-500/80 border-amber-300"
                                    )}
                                    style={{ left: `${(prediction.start_seconds / duration) * 100}%`, width: `${((prediction.end_seconds - prediction.start_seconds) / duration) * 100}%` }}
                                />
                            ))}
                            <div className="absolute top-0 bottom-0 w-1 bg-white shadow-[0_0_10px_white] transition-all duration-75" style={{ left: `${(currentTime / duration) * 100}%` }}></div>
                        </div>
                        <div className="flex flex-wrap items-center gap-4 text-xs text-neutral-400">
                            <span>上层：人工</span>
                            <span>下层：AI</span>
                            <span className="text-emerald-400">● 命中 {review.truePositive}</span>
                            <span className="text-red-400">● 漏检 {review.falseNegative}</span>
                            <span className="text-amber-400">● 误检 {review.falsePositive}</span>
                            <span className="text-neutral-500">● 忽略短回合 {review.ignored}</span>
                            <span className="font-mono text-cyan-300">F1 {review.f1.toFixed(3)}</span>
                        </div>
                        {aiPredictions.length > 0 && (
                            <div className="mt-4 rounded-xl bg-emerald-500/5 ring-1 ring-emerald-500/20 p-4 space-y-3">
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                    <div>
                                        <p className="font-semibold text-emerald-200">极简 AI 验收</p>
                                        <p className="text-xs text-neutral-500 mt-1">每段完整播放后暂停，必须选择没问题或有问题。不会修改人工标注。</p>
                                    </div>
                                    <button
                                        onClick={() => simpleReviewActive ? handleStopSimpleReview() : handleStartSimpleReview()}
                                        className="px-4 py-2 rounded-lg bg-emerald-500 text-neutral-950 font-bold hover:bg-emerald-400"
                                    >
                                        {simpleReviewActive ? '停止验收' : '开始连续播放'}
                                    </button>
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                    <button
                                        onClick={handleAcceptReview}
                                        disabled={!simpleReviewActive || !awaitingReviewDecision}
                                        className="px-5 py-4 rounded-xl bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-500/40 hover:bg-emerald-500/30 disabled:opacity-40 text-left"
                                    >
                                        <span className="text-xl font-black mr-2">Enter</span>
                                        没问题
                                    </button>
                                    <button
                                        onClick={handleReportProblem}
                                        disabled={!simpleReviewActive || !awaitingReviewDecision}
                                        className="px-5 py-4 rounded-xl bg-red-500/20 text-red-200 ring-1 ring-red-500/40 hover:bg-red-500/30 disabled:opacity-40 text-left"
                                    >
                                        <span className="text-2xl font-black mr-3">A</span>
                                        这段有问题
                                    </button>
                                    <button
                                        onClick={handleUndoReview}
                                        disabled={reviewIssues.length + reviewAccepted.length === 0}
                                        className="px-5 py-4 rounded-xl bg-neutral-700 text-neutral-200 ring-1 ring-neutral-600 hover:bg-neutral-600 disabled:opacity-40 text-left"
                                    >
                                        <span className="text-2xl font-black mr-3">S</span>
                                        撤销并重播上一回合
                                    </button>
                                </div>
                                <div className="flex flex-wrap gap-4 text-xs text-neutral-400">
                                    <span>当前片段：{simpleReviewActive ? `${simpleReviewIndex + 1}/${aiPredictions.length}` : '未开始'}</span>
                                    <span>已验收：{reviewIssues.length + reviewAccepted.length}/{aiPredictions.length}</span>
                                    <span>已标记问题：{reviewIssues.length}</span>
                                    <span>{awaitingReviewDecision ? '请选择验收结果' : '正在播放当前片段'}</span>
                                </div>
                            </div>
                        )}
                        {aiPredictions.length > 0 && (
                            <div className="mt-4 rounded-xl bg-cyan-500/5 ring-1 ring-cyan-500/20 p-4 space-y-3">
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                    <div>
                                        <p className="font-semibold text-cyan-200">AI 校正模式</p>
                                        <p className="text-xs text-neutral-500 mt-1">正确就确认；误检删除；漏检仍用 Q / W 补充。</p>
                                    </div>
                                    <button
                                        onClick={handleCopyAiDraft}
                                        className="px-4 py-2 rounded-lg bg-cyan-500 text-neutral-950 font-bold hover:bg-cyan-400"
                                    >
                                        复制 AI 为人工草稿
                                    </button>
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <button onClick={handleStartReview} disabled={marks.length === 0} className="px-3 py-2 rounded-lg bg-neutral-700 hover:bg-neutral-600 disabled:opacity-40">
                                        开始/继续逐条验收
                                    </button>
                                    <button onClick={handleSetSelectedStart} disabled={!selectedMark} className="px-3 py-2 rounded-lg bg-neutral-700 hover:bg-neutral-600 disabled:opacity-40">
                                        当前时间设为起点
                                    </button>
                                    <button onClick={handleSetSelectedEnd} disabled={!selectedMark} className="px-3 py-2 rounded-lg bg-neutral-700 hover:bg-neutral-600 disabled:opacity-40">
                                        当前时间设为终点
                                    </button>
                                    <button onClick={handleSplitSelected} disabled={!selectedMark} className="px-3 py-2 rounded-lg bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 disabled:opacity-40">
                                        在当前位置拆分
                                    </button>
                                    <button onClick={() => selectedMark && handleDeleteMark(selectedMark.id)} disabled={!selectedMark} className="px-3 py-2 rounded-lg bg-red-500/20 text-red-300 hover:bg-red-500/30 disabled:opacity-40">
                                        删除误检
                                    </button>
                                    <button onClick={handleConfirmAndNext} disabled={marks.length === 0} className="px-3 py-2 rounded-lg bg-emerald-500 text-neutral-950 font-bold hover:bg-emerald-400 disabled:opacity-40">
                                        确认并下一条
                                    </button>
                                </div>
                                <div className="flex flex-wrap gap-4 text-xs text-neutral-400">
                                    <span>验收进度：{reviewedCount}/{marks.length}</span>
                                    <span>当前：{selectedMark ? `${formatTime(selectedMark.start)} → ${formatTime(selectedMark.end)}` : '未选择'}</span>
                                </div>
                            </div>
                        )}
                        <div className="flex flex-wrap items-center gap-3 mt-4 text-sm text-neutral-400">
                            <span>源视频 FPS：{fps === null ? '读取中...' : fps}</span>
                            <span>已从源视频元数据读取，不使用固定默认值。</span>
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
                                人工标注 ({marks.length})
                            </h2>
                            {marks.length > 0 && (
                                <button onClick={() => { setMarks([]); setSelectedMarkId(null); setReviewedMarkIds([]); }} className="text-sm text-neutral-400 hover:text-red-400 transition-colors">清空</button>
                            )}
                        </div>

                        <div className="flex-1 overflow-y-auto p-3 space-y-2 relative">
                            {marks.length === 0 && review.ai.length === 0 ? (
                                <div className="absolute inset-0 flex flex-col items-center justify-center text-neutral-500 p-8 text-center">
                                    <Scissors className="w-12 h-12 mb-3 opacity-20" />
                                    <p>播放视频时按<br /> <b>Q</b>开始截取，<b>W</b>结束截取</p>
                                </div>
                            ) : (
                                <>
                                    {review.manual.map((mark, idx) => (
                                        <div key={mark.id} className={cn(
                                            "group rounded-xl p-3 flex items-center gap-3 transition-colors ring-1",
                                            mark.status === 'ignored'
                                                ? "bg-neutral-700/30 ring-neutral-700"
                                                : mark.status === 'matched'
                                                    ? "bg-emerald-500/5 ring-emerald-500/20 hover:bg-emerald-500/10"
                                                    : "bg-red-500/10 ring-red-500/30 hover:bg-red-500/15",
                                            selectedMarkId === mark.id && "ring-2 ring-cyan-400 bg-cyan-500/10"
                                        )}>
                                            <span className={cn(
                                                "w-6 h-6 rounded flex items-center justify-center text-xs font-bold font-mono border",
                                                mark.status === 'ignored'
                                                    ? "bg-neutral-900 text-neutral-500 border-neutral-700"
                                                    : mark.status === 'matched'
                                                        ? "bg-emerald-950 text-emerald-300 border-emerald-500/30"
                                                        : "bg-red-950 text-red-300 border-red-500/30"
                                            )}>{idx + 1}</span>
                                            <button onClick={() => handleSelectMark(mark)} className="flex-1 text-left text-sm font-mono tracking-tight text-neutral-300 hover:text-white">
                                                {formatTimeHHMMSS(mark.start)}
                                                <span className="text-neutral-500 mx-2">→</span>
                                                {formatTimeHHMMSS(mark.end)}
                                            </button>
                                            <span className={cn(
                                                "text-xs font-bold",
                                                reviewedMarkIds.includes(mark.id)
                                                    ? 'text-cyan-300'
                                                    : mark.status === 'ignored' ? 'text-neutral-500' : mark.status === 'matched' ? 'text-emerald-400' : 'text-red-400'
                                            )}>
                                                {reviewedMarkIds.includes(mark.id) ? '已确认' : mark.status === 'ignored' ? '忽略' : mark.status === 'matched' ? '命中' : '漏检'}
                                            </span>
                                            <div className="text-xs font-mono text-neutral-500">
                                                {(mark.end - mark.start).toFixed(1)}s
                                            </div>
                                            <button
                                                onClick={() => handleDeleteMark(mark.id)}
                                                className="p-1.5 text-neutral-400 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-all opacity-0 group-hover:opacity-100"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>
                                    ))}
                                    {review.ai.some(item => item.status === 'false-positive') && (
                                        <div className="pt-3">
                                            <p className="px-1 pb-2 text-xs font-bold uppercase tracking-widest text-amber-400">AI 误检</p>
                                            {review.ai.filter(item => item.status === 'false-positive').map((prediction, idx) => (
                                                <button
                                                    key={prediction.id}
                                                    onClick={() => handleSeek(prediction.start_seconds)}
                                                    className="w-full mb-2 rounded-xl p-3 flex items-center gap-3 bg-amber-500/10 ring-1 ring-amber-500/30 hover:bg-amber-500/15 text-left"
                                                >
                                                    <span className="w-6 h-6 rounded flex items-center justify-center text-xs font-bold font-mono bg-amber-950 text-amber-300 border border-amber-500/30">{idx + 1}</span>
                                                    <span className="flex-1 text-sm font-mono text-neutral-300">
                                                        {formatTimeHHMMSS(prediction.start_seconds)}
                                                        <span className="text-neutral-500 mx-2">→</span>
                                                        {formatTimeHHMMSS(prediction.end_seconds)}
                                                    </span>
                                                    <span className="text-xs text-amber-400">{prediction.hit_count} 击</span>
                                                    <span className="text-xs font-mono text-neutral-500">{(prediction.end_seconds - prediction.start_seconds).toFixed(1)}s</span>
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </>
                            )}
                        </div>

                        <div className="p-4 border-t border-neutral-700 bg-neutral-900/50">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <button
                                    onClick={handleExportAnnotations}
                                    disabled={(!videoFile && !selectedSourceVideo) || !Number.isFinite(fps) || fps <= 0}
                                    className={cn(
                                        "w-full py-4 rounded-xl font-bold flex items-center justify-center gap-2 transition-all shadow-xl font-sans",
                                        (!videoFile && !selectedSourceVideo) || !Number.isFinite(fps) || fps <= 0
                                            ? "bg-neutral-700 text-neutral-500 cursor-not-allowed"
                                            : "bg-cyan-500 text-neutral-950 hover:bg-cyan-400 hover:scale-[1.02] active:scale-[0.98] shadow-cyan-500/20"
                                    )}
                                >
                                    导出标注 JSON
                                </button>
                                <button
                                    onClick={handleProcess}
                                    disabled={isProcessing || marks.length === 0}
                                    className={cn(
                                        "w-full py-4 rounded-xl font-bold flex items-center justify-center gap-2 transition-all shadow-xl font-sans",
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
        </div>
    );
}
