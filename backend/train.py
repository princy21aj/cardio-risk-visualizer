"""Train and persist the leakage-safe cardiac risk Random Forest models."""

import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import RepeatedStratifiedKFold, cross_validate

ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = ROOT / "data" / "clean.csv"
MODEL_DIR = ROOT / "backend" / "saved_models"
TARGETS = ["CAD", "LAD", "LCX", "RCA"]
LEAKAGE_COLUMNS = ["LAD", "LCX", "RCA", "Cath"]


def load_dataset() -> pd.DataFrame:
    """Load the cleaned dataset and remove target/leakage columns from the input set."""
    data = pd.read_csv(DATA_PATH)
    feature_columns = [
        column
        for column in data.columns
        if column not in set(TARGETS) | set(LEAKAGE_COLUMNS)
    ]
    return data[feature_columns + TARGETS].copy()


def build_models() -> dict[str, RandomForestClassifier]:
    """Match the notebook's final model configuration for each target."""
    return {
        "CAD": RandomForestClassifier(n_estimators=300, random_state=42),
        "LAD": RandomForestClassifier(n_estimators=300, random_state=42),
        "LCX": RandomForestClassifier(
            n_estimators=300,
            min_samples_leaf=3,
            class_weight="balanced",
            random_state=42,
        ),
        "RCA": RandomForestClassifier(
            n_estimators=300,
            min_samples_leaf=3,
            class_weight="balanced",
            random_state=42,
        ),
    }


def save_feature_metadata(X: pd.DataFrame) -> None:
    """Persist feature metadata and demo defaults exactly like the notebook."""
    binary_columns = [column for column in X.columns if set(X[column].unique()) <= {0, 1}]
    defaults = X.median().to_dict()

    cad_model = joblib.load(MODEL_DIR / "cad_model.joblib")
    probabilities = cad_model.predict_proba(X)[:, 1]
    picks = {
        "low": int(np.argmin(probabilities)),
        "medium": int(np.argmin(np.abs(probabilities - 0.5))),
        "high": int(np.argmax(probabilities)),
    }
    demo = {key: X.iloc[index].astype(float).to_dict() for key, index in picks.items()}

    meta = {"defaults": defaults, "binary": binary_columns, "demo": demo}
    for column in meta["binary"]:
        meta["defaults"][column] = 0.0

    with (MODEL_DIR / "feature_columns.json").open("w", encoding="utf-8") as fh:
        json.dump(list(X.columns), fh)
    with (MODEL_DIR / "meta.json").open("w", encoding="utf-8") as fh:
        json.dump(meta, fh)


def print_cv_metrics(models: dict[str, RandomForestClassifier], data: pd.DataFrame, X: pd.DataFrame) -> pd.DataFrame:
    """Run repeated stratified CV and print the metrics used in the notebook."""
    cv = RepeatedStratifiedKFold(n_splits=5, n_repeats=3, random_state=42)
    scoring = ["accuracy", "precision", "recall", "f1", "roc_auc"]

    rows = []
    for target in TARGETS:
        model = models[target]
        scores = cross_validate(model, X, data[target], cv=cv, scoring=scoring)
        row = {"target": target, "model": "RandomForest"}
        for metric in scoring:
            values = scores[f"test_{metric}"]
            row[metric] = f"{values.mean():.3f} +/- {values.std():.3f}"
        rows.append(row)

    results = pd.DataFrame(rows)
    print(results.to_string(index=False))
    return results


def save_metrics(results: pd.DataFrame, dataset: pd.DataFrame) -> None:
    """Persist the same metric summary used by the backend dashboard."""
    metric_rows = []
    for _, row in results.iterrows():
        metric_rows.append(
            {
                "target": row["target"],
                "model": "Random Forest" if row["target"] in {"CAD", "LAD"} else "Random Forest (balanced)",
                "accuracy": [float(x) for x in row["accuracy"].split(" +/- ")],
                "precision": [float(x) for x in row["precision"].split(" +/- ")],
                "recall": [float(x) for x in row["recall"].split(" +/- ")],
                "f1": [float(x) for x in row["f1"].split(" +/- ")],
                "roc_auc": [float(x) for x in row["roc_auc"].split(" +/- ")],
            }
        )

    payload = {
        "validation": "Stratified 5-fold CV, 3 repeats",
        "n_patients": int(len(dataset)),
        "rows": metric_rows,
    }
    with (MODEL_DIR / "metrics.json").open("w", encoding="utf-8") as fh:
        json.dump(payload, fh)


def main() -> None:
    """Train the models, save them, and print cross-validated metrics."""
    MODEL_DIR.mkdir(parents=True, exist_ok=True)

    data = load_dataset()
    X = data.drop(columns=TARGETS)
    models = build_models()

    for target, model in models.items():
        model.fit(X, data[target])
        joblib.dump(model, MODEL_DIR / f"{target.lower()}_model.joblib")

    save_feature_metadata(X)
    results = print_cv_metrics(models, data, X)
    save_metrics(results, data)


if __name__ == "__main__":
    main()
