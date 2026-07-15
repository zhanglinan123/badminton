import argparse
import json
from pathlib import Path

from evaluate_rallies import evaluate, load_intervals


def aggregate(results):
    truth_count = sum(item["truth_count"] for item in results)
    prediction_count = sum(item["prediction_count"] for item in results)
    true_positive = sum(item["true_positive"] for item in results)
    precision = true_positive / prediction_count if prediction_count else 0.0
    recall = true_positive / truth_count if truth_count else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "truth_count": truth_count,
        "prediction_count": prediction_count,
        "true_positive": true_positive,
        "false_positive": prediction_count - true_positive,
        "false_negative": truth_count - true_positive,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "merge_errors": sum(item["merge_errors"] for item in results),
    }


def overlap(left, right):
    return max(0.0, min(left[1], right[1]) - max(left[0], right[0]))


def evaluate_case(name, truth, prediction, threshold):
    result = evaluate(truth, prediction, threshold)
    merge_predictions = [
        index + 1
        for index, predicted in enumerate(prediction)
        if sum(overlap(predicted, target) > 0 for target in truth) >= 2
    ]
    return {
        "name": name,
        **{key: result[key] for key in (
            "truth_count", "prediction_count", "true_positive",
            "false_positive", "false_negative", "precision", "recall", "f1",
            "mean_iou", "mean_start_error_seconds", "mean_end_error_seconds",
        )},
        "merge_errors": len(merge_predictions),
        "merge_prediction_indexes": merge_predictions,
    }


def evaluate_dataset(
    truth_dir, prediction_root, min_duration=5.0, threshold=0.5,
    prediction_name="rallies_ai.json",
):
    cases = []
    missing = []
    for truth_path in sorted(Path(truth_dir).glob("*.annotations.json")):
        name = truth_path.name.removesuffix(".annotations.json")
        prediction_path = Path(prediction_root) / name / prediction_name
        if not prediction_path.exists():
            missing.append(name)
            continue
        truth = load_intervals(truth_path, 30.0, min_duration)
        prediction = load_intervals(prediction_path, 30.0, min_duration)
        cases.append(evaluate_case(name, truth, prediction, threshold))
    return {
        "settings": {"min_duration": min_duration, "iou_threshold": threshold},
        "case_count": len(cases),
        "missing_predictions": missing,
        "aggregate": aggregate(cases),
        "cases": cases,
    }


def self_test():
    case = evaluate_case("demo", [(0, 6), (8, 14)], [(0, 14)], 0.5)
    assert case["merge_errors"] == 1
    assert aggregate([case])["false_negative"] == 2
    print("self-test passed")


def main():
    parser = argparse.ArgumentParser(description="Evaluate all labeled badminton videos")
    parser.add_argument("--truth-dir")
    parser.add_argument("--prediction-root")
    parser.add_argument("--output")
    parser.add_argument("--min-duration", type=float, default=5.0)
    parser.add_argument("--iou-threshold", type=float, default=0.5)
    parser.add_argument("--prediction-name", default="rallies_ai.json")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if not args.truth_dir or not args.prediction_root:
        parser.error("--truth-dir and --prediction-root are required")
    report = evaluate_dataset(
        args.truth_dir, args.prediction_root, args.min_duration, args.iou_threshold,
        args.prediction_name,
    )
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    print(rendered)
    if args.output:
        Path(args.output).write_text(rendered + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
