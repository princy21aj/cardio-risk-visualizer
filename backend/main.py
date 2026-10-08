import json
from pathlib import Path
import joblib, numpy as np, pandas as pd, shap
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

BASE = Path(__file__).parent / "saved_models"
TARGETS = ["CAD", "LAD", "LCX", "RCA"]
COLUMNS = json.load(open(BASE / "feature_columns.json"))
META = json.load(open(BASE / "meta.json"))
DEFAULTS, BINARY, DEMO = META["defaults"], set(META["binary"]), META["demo"]

MODELS = {t: joblib.load(BASE / f"{t.lower()}_model.joblib") for t in TARGETS}
EXPLAINERS = {t: shap.TreeExplainer(m) for t, m in MODELS.items()}

# cross-validated ROC-AUC from our evaluation (shows how far to trust each output)
CV_AUC = {"CAD": 0.923, "LAD": 0.851, "LCX": 0.725, "RCA": 0.718}
DISCLAIMER = ("Decision support / educational use only. Not a substitute "
              "for formal diagnostic imaging.")

app = FastAPI(title="Cardiac Risk API")
app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_methods=["*"], allow_headers=["*"])


def class1(sv):
    if isinstance(sv, list):
        return np.asarray(sv[1])
    sv = np.asarray(sv)
    return sv[:, :, 1] if sv.ndim == 3 else sv


def label(feat, val):
    if feat == "Sex":
        return "Male" if val == 1 else "Female"
    if feat in BINARY:
        return f"{feat} {'present' if val == 1 else 'absent'}"
    return f"{feat} = {val:g}"


@app.get("/features")
def features():
    return {"columns": COLUMNS, "binary": sorted(BINARY), "defaults": DEFAULTS}


@app.get("/demo-patients")
def demo_patients():
    return DEMO


@app.post("/predict")
def predict(patient: dict):
    unknown = [k for k in patient if k not in COLUMNS]
    if unknown:
        raise HTTPException(422, f"Unknown features: {unknown}")
    row = {**DEFAULTS, **patient}
    assumed = [c for c in COLUMNS if c not in patient]
    try:
        df = pd.DataFrame([row])[COLUMNS].astype(float)
    except ValueError:
        raise HTTPException(422, "All feature values must be numbers")

    results = {}
    for t in TARGETS:
        prob = float(MODELS[t].predict_proba(df)[0][1])
        sv = class1(EXPLAINERS[t].shap_values(df))[0]
        order = np.argsort(-np.abs(sv))[:8]
        contrib = [{"feature": COLUMNS[i],
                    "value": float(df.iloc[0, i]),
                    "label": label(COLUMNS[i], float(df.iloc[0, i])),
                    "shap": float(sv[i]),
                    "direction": "raises" if sv[i] > 0 else "lowers"}
                   for i in order]
        top = contrib[:4]
        up = [c["label"] for c in top if c["shap"] > 0]
        down = [c["label"] for c in top if c["shap"] < 0]
        text = f"Predicted {t} risk: {prob:.0%}. "
        if up:
            text += "Raising the risk: " + "; ".join(up) + ". "
        if down:
            text += "Lowering the risk: " + "; ".join(down) + ". "
        text += "These show how the model reasoned, not a medical cause."
        results[t] = {"probability": prob,
                      "cv_roc_auc": CV_AUC[t],
                      "lower_confidence": CV_AUC[t] < 0.75,
                      "contributions": contrib,
                      "explanation": text}

    return {"results": results,
            "assumed_defaults": assumed,
            "disclaimer": DISCLAIMER}


@app.get("/metrics")
def metrics():
    return json.load(open(BASE / "metrics.json"))