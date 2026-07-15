import argparse
import json
import subprocess
from pathlib import Path

import imageio_ffmpeg
import numpy as np

from hybrid_rally_detector import (
    audio_feature,
    detect_from_features,
    find_events,
    track_activity,
    tracknet_candidate_intervals,
)


def motion_feature(video_path, sample_fps=5, width=160, height=90):
    result = subprocess.run([
        imageio_ffmpeg.get_ffmpeg_exe(),
        "-loglevel", "error",
        "-i", str(video_path),
        "-vf", f"fps={sample_fps},scale={width}:{height},format=gray",
        "-f", "rawvideo",
        "pipe:1",
    ], check=True, capture_output=True)
    frame_size = width * height
    pixels = np.frombuffer(result.stdout, dtype=np.uint8)
    if len(pixels) % frame_size:
        raise ValueError(f"Incomplete raw frame data from {video_path}")
    frames = pixels.reshape(-1, height, width).astype(np.int16)
    roi = frames[:, 22:88, 8:152]
    return np.r_[0.0, np.abs(np.diff(roi, axis=0)).mean(axis=(1, 2))]


def motion_candidates(
    feature,
    sample_fps=5,
    quantile=0.5,
    smooth_frames=8,
    max_gap_frames=8,
    min_core_duration=3.0,
    min_duration=5.0,
    pre_seconds=2.0,
    post_seconds=0.0,
):
    smooth = np.convolve(feature, np.ones(smooth_frames) / smooth_frames, mode="same")
    ranks = np.argsort(np.argsort(smooth)) / max(1, len(smooth) - 1)
    active = np.flatnonzero(smooth >= np.quantile(smooth, quantile))
    groups = []
    for frame in active:
        if groups and frame - groups[-1][-1] <= max_gap_frames:
            groups[-1].append(frame)
        else:
            groups.append([frame])
    segments = []
    for group in groups:
        start = max(0.0, group[0] / sample_fps - pre_seconds)
        end = max(group[-1] / sample_fps + post_seconds, start + min_duration)
        if (group[-1] - group[0] + 1) / sample_fps >= min_core_duration:
            segments.append((start, end))
    return segments, smooth, ranks


def sparse_tracknet_intervals(source_video, motion_video):
    motion, _, _ = motion_candidates(motion_feature(motion_video))
    audio, times = audio_feature(source_video)
    events = find_events(audio, times, 0.985, 0.15)
    intervals = [list(segment) for segment in motion]
    intervals.extend([
        [interval['start'], interval['end']]
        for interval in tracknet_candidate_intervals(events)
    ])
    intervals.sort()

    merged = []
    for start, end in intervals:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return {
        'events': events,
        'intervals': [
            {'start': round(start, 3), 'end': round(end, 3)}
            for start, end in merged
        ],
    }


def overlap(left, right):
    return max(0.0, min(left[1], right[1]) - max(left[0], right[0]))


def candidate_features(segments, smooth, ranks, activity, audio_rallies, motion_fps=5, track_fps=30):
    rows = []
    for segment in segments:
        start, end = segment
        motion_start = max(0, round(start * motion_fps))
        motion_end = min(len(smooth), round(end * motion_fps))
        motion_values = smooth[motion_start:motion_end]
        audio_overlaps = []
        for rally in audio_rallies:
            audio_segment = (rally["start"], rally["end"])
            intersection = overlap(segment, audio_segment)
            if intersection > 0:
                audio_overlaps.append((
                    intersection / min(end - start, rally["end"] - rally["start"]),
                    rally["hit_count"],
                ))
        track_start = max(0, round(start * track_fps))
        track_end = min(len(activity), round(end * track_fps))
        rows.append([
            end - start,
            float(motion_values.mean()),
            float(motion_values.std()),
            float(motion_values.max()),
            float(ranks[motion_start:motion_end].mean()),
            max((item[0] for item in audio_overlaps), default=0.0),
            len(audio_overlaps),
            max((item[1] for item in audio_overlaps), default=0),
            sum(item[1] for item in audio_overlaps),
            float(activity[track_start:track_end].mean()) if track_end > track_start else 0.0,
        ])
    return np.asarray(rows, dtype=float)


def expand_features(normalized, quadratic=False, interactions=False):
    columns = [normalized]
    if quadratic:
        columns.append(normalized ** 2)
    if interactions and normalized.shape[1] > 1:
        columns.append(np.column_stack([
            normalized[:, left] * normalized[:, right]
            for left in range(normalized.shape[1])
            for right in range(left + 1, normalized.shape[1])
        ]))
    return np.column_stack(columns)


def probabilities(features, model):
    mean = np.asarray(model["mean"], dtype=float)
    std = np.asarray(model["std"], dtype=float)
    weights = np.asarray(model["weights"], dtype=float)
    normalized = (features - mean) / std
    expanded = expand_features(normalized, model.get("quadratic"), model.get("interactions"))
    design = np.c_[np.ones(len(features)), expanded]
    logits = np.clip(design @ weights, -30, 30)
    return 1 / (1 + np.exp(-logits))


def split_rallies_on_audio_gaps(
    rallies, events, fps=30, min_gap=4.0, min_duration=5.0, min_span=15.0,
):
    split_rallies = []
    for rally in rallies:
        inside = [event for event in events if rally["start"] <= event <= rally["end"]]
        candidates = []
        if rally["duration"] >= min_span:
            for left, right in zip(inside, inside[1:]):
                split = (left + right) / 2
                if right - left >= min_gap and split - rally["start"] >= min_duration \
                        and rally["end"] - split >= min_duration:
                    candidates.append((right - left, split))
        if not candidates:
            split_rallies.append(rally)
            continue
        _, split = max(candidates)
        for start, end in ((rally["start"], split), (split, rally["end"])):
            split_rallies.append({
                **rally,
                "start_frame": round(start * fps),
                "end_frame": round(end * fps),
                "start": round(start, 3),
                "end": round(end, 3),
                "duration": round(end - start, 3),
                "hit_count": int(sum(start <= event <= end for event in inside)),
            })
    return split_rallies


def detect_motion_rallies(source_video, motion_video, csv_path, model):
    feature = motion_feature(motion_video)
    segments, smooth, ranks = motion_candidates(feature)
    activity = track_activity(csv_path)
    audio, times = audio_feature(source_video)
    events = find_events(audio, times, 0.985, 0.15)
    audio_rallies = detect_from_features(audio, times, activity)
    features = candidate_features(segments, smooth, ranks, activity, audio_rallies)
    scores = probabilities(features, model)
    rallies = []
    for (start, end), score in zip(segments, scores):
        if score < model["threshold"]:
            continue
        hit_count = max((
            rally["hit_count"] for rally in audio_rallies
            if overlap((start, end), (rally["start"], rally["end"])) > 0
        ), default=0)
        rallies.append({
            "start_frame": round(start * 30),
            "end_frame": round(end * 30),
            "start": round(start, 3),
            "end": round(end, 3),
            "duration": round(end - start, 3),
            "hit_count": hit_count,
            "confidence": round(float(score), 4),
        })
    return split_rallies_on_audio_gaps(rallies, events)


def self_test():
    feature = np.r_[np.zeros(10), np.ones(20), np.zeros(10)]
    segments, smooth, ranks = motion_candidates(
        feature, sample_fps=5, quantile=0.75, smooth_frames=1, max_gap_frames=1,
        min_core_duration=3, min_duration=3, pre_seconds=0, post_seconds=0,
    )
    assert segments == [(2.0, 5.8)]
    model = {"mean": [0], "std": [1], "weights": [0, 1], "threshold": 0.5}
    assert probabilities(np.array([[1.0], [-1.0]]), model)[0] > 0.5
    split = split_rallies_on_audio_gaps(
        [{"start": 0, "end": 20, "duration": 20, "hit_count": 5}],
        [1, 4, 10, 12, 18],
    )
    assert len(split) == 2 and split[0]["end"] == split[1]["start"]
    assert len(smooth) == len(ranks) == len(feature)
    print("self-test passed")


def main():
    parser = argparse.ArgumentParser(description="Detect badminton rallies from motion and hybrid features")
    parser.add_argument("--video")
    parser.add_argument("--motion-video")
    parser.add_argument("--csv")
    parser.add_argument("--model")
    parser.add_argument("--output", default="rallies_ai.json")
    parser.add_argument("--candidates-output")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if args.candidates_output:
        if not args.video or not args.motion_video:
            parser.error("--video and --motion-video are required with --candidates-output")
        payload = sparse_tracknet_intervals(args.video, args.motion_video)
        Path(args.candidates_output).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(f"prepared {len(payload['intervals'])} TrackNet candidate intervals -> {args.candidates_output}")
        return
    if not all((args.video, args.motion_video, args.csv, args.model)):
        parser.error("--video, --motion-video, --csv and --model are required")
    model = json.loads(Path(args.model).read_text(encoding="utf-8"))
    rallies = detect_motion_rallies(args.video, args.motion_video, args.csv, model)
    Path(args.output).write_text(json.dumps(rallies, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"detected {len(rallies)} rallies -> {args.output}")


if __name__ == "__main__":
    main()
