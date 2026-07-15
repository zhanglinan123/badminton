import argparse
import itertools
import json
from pathlib import Path

from evaluate_rallies import evaluate, load_intervals
from hybrid_rally_detector import audio_feature, detect_from_features, track_activity


def aggregate(results):
    truth_count = sum(item["truth_count"] for item in results)
    prediction_count = sum(item["prediction_count"] for item in results)
    true_positive = sum(item["true_positive"] for item in results)
    precision = true_positive / prediction_count if prediction_count else 0.0
    recall = true_positive / truth_count if truth_count else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    matched = sum(item["true_positive"] for item in results)
    mean_iou = (
        sum(item["mean_iou"] * item["true_positive"] for item in results) / matched
        if matched else 0.0
    )
    return {
        "truth_count": truth_count,
        "prediction_count": prediction_count,
        "true_positive": true_positive,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "mean_iou": round(mean_iou, 4),
    }


def score_key(result):
    return result["f1"], result["mean_iou"]


def self_test():
    result = aggregate([
        {"truth_count": 10, "prediction_count": 8, "true_positive": 6, "mean_iou": 0.7},
        {"truth_count": 5, "prediction_count": 7, "true_positive": 4, "mean_iou": 0.8},
    ])
    assert result["f1"] == 0.6667
    assert result["mean_iou"] == 0.74
    assert score_key({"f1": 0.7, "mean_iou": 0.6}) > score_key({"f1": 0.69, "mean_iou": 0.9})
    print("self-test passed")


def main():
    parser = argparse.ArgumentParser(description="Tune the hybrid detector on labeled videos")
    parser.add_argument("--case", action="append", nargs=3, metavar=("VIDEO", "CSV", "TRUTH"))
    parser.add_argument("--output", default="prediction/baseline/tuning_results.json")
    parser.add_argument("--top", type=int, default=20)
    parser.add_argument("--min-duration", type=float, default=5.0)
    parser.add_argument("--long-group-span", type=float, default=15.0)
    parser.add_argument("--event-window", type=float, default=0.1)
    parser.add_argument("--event-track-ratio", type=float, default=0.3)
    parser.add_argument("--isolated-bridge-gap", type=float, default=3.2)
    parser.add_argument("--leave-one-out", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        return
    if not args.case:
        parser.error("--case is required unless --self-test is used")

    cases = []
    for video, csv_path, truth_path in args.case:
        feature, times = audio_feature(video)
        cases.append({
            "name": Path(video).stem,
            "feature": feature,
            "times": times,
            "activity": track_activity(csv_path),
            "truth": load_intervals(truth_path, 30.0, args.min_duration),
        })

    keys = ("audio_quantile", "refractory", "max_gap", "strong_hits", "track_ratio",
            "strong_pre", "strong_post", "weak_pre", "weak_post")
    values = itertools.product(
        (0.97, 0.98, 0.985),
        (0.15, 0.2, 0.25),
        (3.0, 3.5, 4.0, 4.5),
        (3, 4, 5),
        (0.2, 0.35, 0.5),
        (0.3, 1.0, 2.0),
        (0.5, 1.5, 2.5),
        (1.0, 2.0),
        (1.5, 2.5),
    )

    ranked = []
    fold_best = [None] * len(cases)
    for combination in values:
        params = dict(zip(keys, combination))
        per_case = []
        for case in cases:
            rallies = detect_from_features(
                case["feature"], case["times"], case["activity"],
                weak_hits=2,
                min_duration=args.min_duration,
                long_group_span=args.long_group_span,
                event_window=args.event_window,
                event_track_ratio=args.event_track_ratio,
                isolated_bridge_gap=args.isolated_bridge_gap,
                **params,
            )
            prediction = [(item["start"], item["end"]) for item in rallies]
            result = evaluate(case["truth"], prediction, 0.5)
            per_case.append({"name": case["name"], **{key: result[key] for key in (
                "truth_count", "prediction_count", "true_positive", "precision", "recall", "f1", "mean_iou"
            )}})
        total = aggregate(per_case)
        ranked.append({"params": params, "aggregate": total, "cases": per_case})
        if args.leave_one_out:
            for holdout_index, holdout in enumerate(cases):
                training = aggregate(per_case[:holdout_index] + per_case[holdout_index + 1:])
                candidate = {
                    "holdout": holdout["name"],
                    "params": params,
                    "training": training,
                    "validation": per_case[holdout_index],
                }
                current = fold_best[holdout_index]
                if current is None or score_key(training) > score_key(current["training"]):
                    fold_best[holdout_index] = candidate

    ranked.sort(key=lambda item: (item["aggregate"]["f1"], item["aggregate"]["mean_iou"]), reverse=True)
    output = {
        "case_count": len(cases),
        "min_duration": args.min_duration,
        "long_group_span": args.long_group_span,
        "event_window": args.event_window,
        "event_track_ratio": args.event_track_ratio,
        "isolated_bridge_gap": args.isolated_bridge_gap,
        "searched": len(ranked),
        "top": ranked[:args.top],
    }
    if args.leave_one_out:
        output["leave_one_out"] = {
            "aggregate": aggregate([fold["validation"] for fold in fold_best]),
            "folds": fold_best,
        }
    Path(args.output).write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(output["top"][0], ensure_ascii=False, indent=2))
    print(f"searched {len(ranked)} combinations -> {args.output}")


if __name__ == "__main__":
    main()
