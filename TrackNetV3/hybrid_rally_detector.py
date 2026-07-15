import argparse
import json
import subprocess
from pathlib import Path

import imageio_ffmpeg
import numpy as np
import pandas as pd


def audio_feature(video_path, sample_rate=16000, frame_seconds=0.02):
    result = subprocess.run([
        imageio_ffmpeg.get_ffmpeg_exe(),
        "-loglevel", "error",
        "-i", str(video_path),
        "-map", "0:a:0",
        "-ac", "1",
        "-ar", str(sample_rate),
        "-f", "s16le",
        "pipe:1",
    ], check=True, capture_output=True)
    audio = np.frombuffer(result.stdout, dtype=np.int16).astype(np.float32) / 32768
    frame_size = int(sample_rate * frame_seconds)
    audio = audio[:len(audio) // frame_size * frame_size]
    frames = audio.reshape(-1, frame_size)
    feature = np.sqrt(np.mean(np.diff(frames, axis=1) ** 2, axis=1))
    return feature, np.arange(len(feature)) * frame_seconds


def track_activity(csv_path, speed_threshold=8.0, max_y=500, teleport_threshold=80):
    df = pd.read_csv(csv_path)
    df.columns = [column.strip().lower() for column in df.columns]
    distance = np.sqrt(df["x"].diff() ** 2 + df["y"].diff() ** 2)
    visibility = df["visibility"].copy()
    visibility[distance > teleport_threshold] = 0
    x = df["x"].where(visibility == 1).ffill(limit=3).bfill(limit=3)
    y = df["y"].where(visibility == 1).ffill(limit=3).bfill(limit=3)
    speed = np.sqrt(x.diff() ** 2 + y.diff() ** 2).fillna(0)
    return ((visibility == 1) & (speed > speed_threshold) & (df["y"] < max_y)).to_numpy()


def find_events(feature, times, quantile, refractory):
    threshold = np.quantile(feature, quantile)
    local_maximum = (
        (feature > threshold)
        & (feature >= np.r_[feature[0], feature[:-1]])
        & (feature >= np.r_[feature[1:], feature[-1]])
    )
    candidates = times[local_maximum]
    strengths = feature[local_maximum]
    kept = []
    for index in np.argsort(strengths)[::-1]:
        timestamp = float(candidates[index])
        if all(abs(timestamp - existing) >= refractory for existing in kept):
            kept.append(timestamp)
    return sorted(kept)


def group_events(events, max_gap):
    groups = []
    for timestamp in events:
        if groups and timestamp - groups[-1][-1] <= max_gap:
            groups[-1].append(timestamp)
        else:
            groups.append([timestamp])
    return groups


def tracknet_candidate_intervals(
    events,
    max_gap=4.0,
    strong_hits=5,
    weak_hits=2,
    strong_pre=2.0,
    strong_post=0.5,
    weak_pre=2.0,
    weak_post=2.5,
    long_group_span=15.0,
):
    pre = max(strong_pre, weak_pre)
    post = max(strong_post, weak_post)
    intervals = []
    for group in group_events(events, max_gap):
        is_long = group[-1] - group[0] >= long_group_span
        is_weak = weak_hits <= len(group) < strong_hits
        if is_long or is_weak:
            intervals.append([max(0.0, group[0] - pre), group[-1] + post])

    merged = []
    for start, end in intervals:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return [{"start": round(start, 3), "end": round(end, 3)} for start, end in merged]


def split_long_event_groups(
    events,
    activity,
    fps,
    max_gap,
    long_group_span,
    event_window,
    event_track_ratio,
    isolated_bridge_gap,
):
    supported = set()
    radius = max(1, round(event_window * fps))
    for timestamp in events:
        frame = round(timestamp * fps)
        start = max(0, frame - radius)
        end = min(len(activity), frame + radius + 1)
        ratio = float(activity[start:end].mean()) if end > start else 0.0
        if ratio >= event_track_ratio:
            supported.add(timestamp)

    groups = []
    for group in group_events(events, max_gap):
        if group[-1] - group[0] < long_group_span:
            groups.append(group)
        else:
            filtered = [event for event in group if event in supported]
            filtered = [
                event for index, event in enumerate(filtered)
                if not (
                    0 < index < len(filtered) - 1
                    and event - filtered[index - 1] >= isolated_bridge_gap
                    and filtered[index + 1] - event >= isolated_bridge_gap
                )
            ]
            groups.extend(group_events(filtered, max_gap))
    return groups


def detect_rallies(
    video_path,
    csv_path,
    fps=30.0,
    audio_quantile=0.985,
    refractory=0.15,
    max_gap=4.0,
    strong_hits=5,
    weak_hits=2,
    track_ratio=0.5,
    strong_pre=2.0,
    strong_post=0.5,
    weak_pre=2.0,
    weak_post=2.5,
    min_duration=5.0,
    long_group_span=15.0,
    event_window=0.1,
    event_track_ratio=0.3,
    isolated_bridge_gap=3.2,
):
    feature, times = audio_feature(video_path)
    activity = track_activity(csv_path)
    return detect_from_features(
        feature, times, activity, fps, audio_quantile, refractory, max_gap,
        strong_hits, weak_hits, track_ratio, strong_pre, strong_post,
        weak_pre, weak_post, min_duration, long_group_span, event_window,
        event_track_ratio, isolated_bridge_gap,
    )


def detect_from_features(
    feature,
    times,
    activity,
    fps=30.0,
    audio_quantile=0.985,
    refractory=0.15,
    max_gap=4.0,
    strong_hits=5,
    weak_hits=2,
    track_ratio=0.5,
    strong_pre=2.0,
    strong_post=0.5,
    weak_pre=2.0,
    weak_post=2.5,
    min_duration=5.0,
    long_group_span=15.0,
    event_window=0.1,
    event_track_ratio=0.3,
    isolated_bridge_gap=3.2,
):
    events = find_events(feature, times, audio_quantile, refractory)
    return detect_from_events(
        events, activity, fps, max_gap, strong_hits, weak_hits, track_ratio,
        strong_pre, strong_post, weak_pre, weak_post, min_duration,
        long_group_span, event_window, event_track_ratio, isolated_bridge_gap,
    )


def detect_from_events(
    events,
    activity,
    fps=30.0,
    max_gap=4.0,
    strong_hits=5,
    weak_hits=2,
    track_ratio=0.5,
    strong_pre=2.0,
    strong_post=0.5,
    weak_pre=2.0,
    weak_post=2.5,
    min_duration=5.0,
    long_group_span=15.0,
    event_window=0.1,
    event_track_ratio=0.3,
    isolated_bridge_gap=3.2,
):
    rallies = []

    for group in split_long_event_groups(
        events, activity, fps, max_gap, long_group_span, event_window,
        event_track_ratio, isolated_bridge_gap,
    ):
        if len(group) >= strong_hits:
            start = max(0.0, group[0] - strong_pre)
            end = group[-1] + strong_post
        elif len(group) >= weak_hits:
            start = max(0.0, group[0] - weak_pre)
            end = group[-1] + weak_post
            start_frame = max(0, int(start * fps))
            end_frame = min(len(activity), int(end * fps))
            ratio = float(activity[start_frame:end_frame].mean()) if end_frame > start_frame else 0.0
            if ratio < track_ratio:
                continue
        else:
            continue

        duration = end - start
        if duration < min_duration:
            continue

        rallies.append({
            "start_frame": round(start * fps),
            "end_frame": round(end * fps),
            "start": round(start, 3),
            "end": round(end, 3),
            "duration": round(duration, 3),
            "hit_count": len(group),
        })

    return rallies


def self_test():
    assert group_events([1.0, 2.0, 7.0], 2.0) == [[1.0, 2.0], [7.0]]
    feature = np.array([0.0, 2.0, 0.0, 3.0, 0.0])
    assert find_events(feature, np.arange(5), 0.5, 0.5) == [1.0, 3.0]
    activity = np.ones(5, dtype=bool)
    assert not detect_from_features(
        feature, np.arange(5), activity, audio_quantile=0.5,
        strong_hits=2, strong_pre=0, strong_post=0, min_duration=5,
    )
    split_activity = np.zeros(330, dtype=bool)
    for timestamp in (1, 2, 3, 9, 10):
        frame = timestamp * 30
        split_activity[frame - 1:frame + 2] = True
    assert split_long_event_groups(
        [1, 2, 3, 6, 9, 10], split_activity, 30, 4, 5, 0.03, 0.3, 3.2
    ) == [[1, 2, 3], [9, 10]]
    for timestamp in (6.4, 9.8, 10.8):
        frame = round(timestamp * 30)
        split_activity[frame - 1:frame + 2] = True
    assert split_long_event_groups(
        [1, 2, 3, 6.4, 9.8, 10.8], split_activity, 30, 4, 5, 0.03, 0.3, 3.2
    ) == [[1, 2, 3], [9.8, 10.8]]
    assert tracknet_candidate_intervals([1, 2, 3, 10, 11, 12, 13, 14]) == [
        {"start": 0.0, "end": 5.5}
    ]
    print("self-test passed")


def main():
    parser = argparse.ArgumentParser(description="Detect badminton rallies from audio hits and TrackNet activity")
    parser.add_argument("--video")
    parser.add_argument("--csv")
    parser.add_argument("--output", default="rallies.json")
    parser.add_argument("--fps", type=float, default=30.0)
    parser.add_argument("--audio-quantile", type=float, default=0.985)
    parser.add_argument("--refractory", type=float, default=0.15)
    parser.add_argument("--max-gap", type=float, default=4.0)
    parser.add_argument("--strong-hits", type=int, default=5)
    parser.add_argument("--weak-hits", type=int, default=2)
    parser.add_argument("--track-ratio", type=float, default=0.5)
    parser.add_argument("--strong-pre", type=float, default=2.0)
    parser.add_argument("--strong-post", type=float, default=0.5)
    parser.add_argument("--weak-pre", type=float, default=2.0)
    parser.add_argument("--weak-post", type=float, default=2.5)
    parser.add_argument("--min-duration", type=float, default=5.0)
    parser.add_argument("--long-group-span", type=float, default=15.0)
    parser.add_argument("--event-window", type=float, default=0.1)
    parser.add_argument("--event-track-ratio", type=float, default=0.3)
    parser.add_argument("--isolated-bridge-gap", type=float, default=3.2)
    parser.add_argument("--candidates-output")
    parser.add_argument("--events-file")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        return
    if args.candidates_output:
        if not args.video:
            parser.error("--video is required with --candidates-output")
        feature, times = audio_feature(args.video)
        events = find_events(feature, times, args.audio_quantile, args.refractory)
        payload = {
            "events": events,
            "intervals": tracknet_candidate_intervals(
                events, args.max_gap, args.strong_hits, args.weak_hits,
                args.strong_pre, args.strong_post, args.weak_pre, args.weak_post,
                args.long_group_span,
            ),
        }
        Path(args.candidates_output).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(f"prepared {len(payload['intervals'])} TrackNet candidate intervals -> {args.candidates_output}")
        return
    if not args.video or not args.csv:
        parser.error("--video and --csv are required unless a preparation mode is used")

    if args.events_file:
        payload = json.loads(Path(args.events_file).read_text(encoding="utf-8"))
        rallies = detect_from_events(
            payload["events"], track_activity(args.csv), args.fps, args.max_gap,
            args.strong_hits, args.weak_hits, args.track_ratio, args.strong_pre,
            args.strong_post, args.weak_pre, args.weak_post, args.min_duration,
            args.long_group_span, args.event_window, args.event_track_ratio,
            args.isolated_bridge_gap,
        )
    else:
        rallies = detect_rallies(
            args.video,
            args.csv,
            args.fps,
            args.audio_quantile,
            args.refractory,
            args.max_gap,
            args.strong_hits,
            args.weak_hits,
            args.track_ratio,
            args.strong_pre,
            args.strong_post,
            args.weak_pre,
            args.weak_post,
            args.min_duration,
            args.long_group_span,
            args.event_window,
            args.event_track_ratio,
            args.isolated_bridge_gap,
        )
    Path(args.output).write_text(json.dumps(rallies, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"detected {len(rallies)} rallies -> {args.output}")


if __name__ == "__main__":
    main()
