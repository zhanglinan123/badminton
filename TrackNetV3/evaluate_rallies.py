import argparse
import json
from pathlib import Path


def parse_time(value):
    if isinstance(value, (int, float)):
        return float(value)
    parts = [float(part) for part in value.split(":")]
    total = 0.0
    for part in parts:
        total = total * 60 + part
    return total


def item_to_interval(item, fps):
    if "start_seconds" in item and "end_seconds" in item:
        return float(item["start_seconds"]), float(item["end_seconds"])
    if "start_frame" in item and "end_frame" in item:
        return float(item["start_frame"]) / fps, float(item["end_frame"]) / fps
    return parse_time(item["start"]), parse_time(item["end"])


def filter_intervals(intervals, min_duration):
    return [interval for interval in intervals if interval[1] - interval[0] >= min_duration]


def load_intervals(path, fps, min_duration=0.0):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    items = data.get("annotations", []) if isinstance(data, dict) else data
    intervals = [item_to_interval(item, fps) for item in items]
    if any(start < 0 or end <= start for start, end in intervals):
        raise ValueError(f"Invalid interval in {path}")
    return sorted(filter_intervals(intervals, min_duration))


def interval_iou(left, right):
    intersection = max(0.0, min(left[1], right[1]) - max(left[0], right[0]))
    union = max(left[1], right[1]) - min(left[0], right[0])
    return intersection / union if union else 0.0


def evaluate(truth, prediction, threshold):
    candidates = sorted(
        (
            (interval_iou(gt, pred), gt_index, pred_index)
            for gt_index, gt in enumerate(truth)
            for pred_index, pred in enumerate(prediction)
        ),
        reverse=True,
    )
    matched_truth = set()
    matched_prediction = set()
    matches = []

    for score, gt_index, pred_index in candidates:
        if score < threshold:
            break
        if gt_index in matched_truth or pred_index in matched_prediction:
            continue
        matched_truth.add(gt_index)
        matched_prediction.add(pred_index)
        gt = truth[gt_index]
        pred = prediction[pred_index]
        matches.append({
            "truth_index": gt_index + 1,
            "prediction_index": pred_index + 1,
            "iou": round(score, 4),
            "start_error_seconds": round(pred[0] - gt[0], 3),
            "end_error_seconds": round(pred[1] - gt[1], 3),
        })

    true_positive = len(matches)
    false_positive = len(prediction) - true_positive
    false_negative = len(truth) - true_positive
    precision = true_positive / len(prediction) if prediction else 0.0
    recall = true_positive / len(truth) if truth else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0

    return {
        "truth_count": len(truth),
        "prediction_count": len(prediction),
        "true_positive": true_positive,
        "false_positive": false_positive,
        "false_negative": false_negative,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "mean_iou": round(sum(match["iou"] for match in matches) / true_positive, 4) if matches else 0.0,
        "mean_start_error_seconds": round(sum(abs(match["start_error_seconds"]) for match in matches) / true_positive, 3) if matches else 0.0,
        "mean_end_error_seconds": round(sum(abs(match["end_error_seconds"]) for match in matches) / true_positive, 3) if matches else 0.0,
        "matches": sorted(matches, key=lambda match: match["truth_index"]),
    }


def self_test():
    result = evaluate([(0, 5), (10, 15)], [(0.2, 5.2), (20, 22)], 0.5)
    assert result["true_positive"] == 1
    assert result["false_positive"] == 1
    assert result["false_negative"] == 1
    assert result["f1"] == 0.5
    assert filter_intervals([(0, 4.9), (10, 15)], 5.0) == [(10, 15)]
    print("self-test passed")


def main():
    parser = argparse.ArgumentParser(description="Evaluate predicted badminton rallies against manual labels")
    parser.add_argument("--truth")
    parser.add_argument("--prediction")
    parser.add_argument("--fps", type=float, default=30.0)
    parser.add_argument("--iou-threshold", type=float, default=0.5)
    parser.add_argument("--min-duration", type=float, default=5.0)
    parser.add_argument("--output")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        return
    if not args.truth or not args.prediction:
        parser.error("--truth and --prediction are required unless --self-test is used")

    result = evaluate(
        load_intervals(args.truth, args.fps, args.min_duration),
        load_intervals(args.prediction, args.fps, args.min_duration),
        args.iou_threshold,
    )
    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    print(rendered)
    if args.output:
        Path(args.output).write_text(rendered + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
