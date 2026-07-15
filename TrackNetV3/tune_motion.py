import argparse
import json
from pathlib import Path

import numpy as np

from evaluate_rallies import evaluate, interval_iou, load_intervals
from hybrid_rally_detector import audio_feature, detect_from_features, find_events, track_activity
from motion_rally_detector import (
    candidate_features, expand_features, motion_candidates, motion_feature, probabilities,
    split_rallies_on_audio_gaps,
)
from tune_hybrid import aggregate


def load_case(source_video, motion_video, csv_path, truth_path):
    feature = motion_feature(motion_video)
    segments, smooth, ranks = motion_candidates(feature)
    activity = track_activity(csv_path)
    audio, times = audio_feature(source_video)
    events = find_events(audio, times, 0.985, 0.15)
    audio_rallies = detect_from_features(audio, times, activity)
    features = candidate_features(segments, smooth, ranks, activity, audio_rallies)
    truth = load_intervals(truth_path, 30.0, 5.0)
    labels = np.asarray([
        max((interval_iou(segment, target) for target in truth), default=0.0) >= 0.5
        for segment in segments
    ], dtype=float)
    return {
        "name": Path(source_video).stem,
        "features": features,
        "labels": labels,
        "segments": segments,
        "events": events,
        "truth": truth,
    }


def fit_model(cases):
    features = np.vstack([case["features"] for case in cases])
    labels = np.concatenate([case["labels"] for case in cases])
    mean = features.mean(axis=0)
    std = features.std(axis=0) + 1e-6
    normalized = (features - mean) / std
    design = np.c_[np.ones(len(features)), expand_features(normalized, True, True)]
    weights = np.zeros(design.shape[1])
    for _ in range(3000):
        predicted = 1 / (1 + np.exp(-np.clip(design @ weights, -30, 30)))
        gradient = design.T @ (predicted - labels) / len(labels)
        gradient[1:] += 0.01 * weights[1:]
        weights -= 0.1 * gradient
    return {
        "mean": mean.tolist(),
        "std": std.tolist(),
        "weights": weights.tolist(),
        "quadratic": True,
        "interactions": True,
        "threshold": 0.5,
    }


def evaluate_model(cases, model):
    results = []
    for case in cases:
        scores = probabilities(case["features"], model)
        selected = [
            {
                "start": segment[0],
                "end": segment[1],
                "duration": segment[1] - segment[0],
                "hit_count": 0,
            }
            for segment, score in zip(case["segments"], scores)
            if score >= model["threshold"]
        ]
        prediction = [
            (rally["start"], rally["end"])
            for rally in split_rallies_on_audio_gaps(selected, case["events"])
        ]
        results.append({"name": case["name"], **evaluate(case["truth"], prediction, 0.5)})
    return results


def choose_threshold(cases, model, baselines=None, require_targets=False):
    best = None
    for threshold in np.arange(0.15, 0.851, 0.01):
        candidate = {**model, "threshold": round(float(threshold), 2)}
        results = evaluate_model(cases, candidate)
        total = aggregate(results)
        if require_targets:
            if total["precision"] < 0.75 or total["recall"] < 0.80:
                continue
            if any(
                result["f1"] < baselines[result["name"]] - 0.05
                for result in results
            ):
                continue
        key = (total["f1"], total["mean_iou"])
        if best is None or key > best[0]:
            best = (key, candidate, results, total)
    if best is None:
        raise RuntimeError("No threshold satisfies the requested constraints")
    return best[1], best[2], best[3]


def self_test():
    cases = [{
        "features": np.array([[1.0], [-1.0], [2.0], [-2.0]]),
        "labels": np.array([1.0, 0.0, 1.0, 0.0]),
    }]
    model = fit_model(cases)
    assert probabilities(np.array([[2.0], [-2.0]]), model)[0] > 0.5
    print("self-test passed")


def main():
    parser = argparse.ArgumentParser(description="Train and validate the motion rally classifier")
    parser.add_argument("--case", action="append", nargs=4, metavar=("VIDEO", "MOTION_VIDEO", "CSV", "TRUTH"))
    parser.add_argument("--baseline", action="append", default=[], metavar="VIDEO=F1")
    parser.add_argument("--model-output", default="prediction/baseline/motion_model.json")
    parser.add_argument("--report-output", default="prediction/baseline/motion_validation.json")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if not args.case:
        parser.error("--case is required unless --self-test is used")
    baselines = {name: float(value) for name, value in (item.rsplit("=", 1) for item in args.baseline)}
    cases = [load_case(*item) for item in args.case]
    if set(baselines) != {case["name"] for case in cases}:
        parser.error("--baseline must be provided once for every case")

    folds = []
    for index, holdout in enumerate(cases):
        training = cases[:index] + cases[index + 1:]
        fold_model = fit_model(training)
        fold_model, training_results, training_total = choose_threshold(training, fold_model)
        validation = evaluate_model([holdout], fold_model)[0]
        folds.append({
            "holdout": holdout["name"],
            "threshold": fold_model["threshold"],
            "training": training_total,
            "validation": validation,
        })

    model = fit_model(cases)
    model, results, total = choose_threshold(cases, model, baselines, require_targets=True)
    report = {
        "full": {"aggregate": total, "cases": results},
        "leave_one_out": {
            "aggregate": aggregate([fold["validation"] for fold in folds]),
            "folds": folds,
        },
    }
    Path(args.model_output).write_text(json.dumps(model, indent=2) + "\n", encoding="utf-8")
    Path(args.report_output).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
