"""Read-only public-rate arithmetic. Keeps raw utterances out of published reports."""
import collections
import json
import sys
from decimal import Decimal
from pathlib import Path


def summarize(path):
    data = json.loads(Path(path).read_text())
    amount = Decimal(0)
    unknown = 0
    totals = collections.Counter()
    indexes = collections.Counter(row["completedBefore"] for row in data["usage"])
    if any(n != 1 for n in indexes.values()):
        raise ValueError("Multiple usage snapshots per response: reconcile before pricing")
    for row in data["usage"]:
        inputs = {v["modality"]: v["tokenCount"] for v in row.get("promptTokensDetails", [])}
        outputs = {v["modality"]: v["tokenCount"] for v in row.get("candidatesTokensDetails", row.get("responseTokensDetails", []))}
        if sum(inputs.values()) != row.get("promptTokenCount") or sum(inputs.values()) + sum(outputs.values()) != row.get("totalTokenCount"):
            unknown += 1
            continue
        if set(inputs) - {"TEXT", "AUDIO", "VIDEO", "IMAGE"} or set(outputs) - {"TEXT", "AUDIO"}:
            unknown += 1
            continue
        for label, values in [("input", inputs), ("output", outputs)]:
            for modality, count in values.items():
                totals[f"{label}_{modality.lower()}"] += count
        amount += (Decimal(inputs.get("TEXT", 0)) * Decimal("0.5") + sum(inputs.get(k, 0) for k in ["AUDIO", "VIDEO", "IMAGE"]) * 3 + outputs.get("TEXT", 0) * 2 + outputs.get("AUDIO", 0) * 12) / 1000000
    mentions = []
    for second in range(120, 1800, 150):
        answers = [x["text"] for x in data.get("answers", []) if second <= x["elapsed"] <= second + 20]
        mentions.append(any("田中" in x and "金曜" in x for x in answers))
    return {
        "runId": Path(path).stem,
        "variant": data["variant"], "status": data["status"],
        "startedAt": data["startedAt"], "finishedAt": data.get("finishedAt"),
        "replaySeconds": data.get("replaySeconds"),
        "liveActiveSeconds": round(data["liveActiveSeconds"], 3),
        "audioInputSeconds": round(data["audioInputSeconds"], 3),
        "audioOutputSeconds": round(data["audioOutputSeconds"], 3),
        "liveConnections": data["liveConnections"],
        "errorEventCount": data["errors"], "completedTurns": data["completedTurns"],
        "pricedResponses": len(data["usage"]) - unknown, "unpricedResponses": unknown,
        "peakInputTokens": max((x.get("promptTokenCount", 0) for x in data["usage"]), default=0),
        "tokens": dict(totals), "estimatedUsd": float(amount),
        "syntheticTaskFactMentionsWithin20s": mentions,
        "usage": data["usage"],
    }


if __name__ == "__main__":
    result = {
        "scope": "Synthetic Vertex replay with fixture observer captions; not a real Meet/Zoom or human trial",
        "model": "gemini-live-2.5-flash-native-audio",
        "priceSource": "https://cloud.google.com/vertex-ai/generative-ai/pricing",
        "ratesUsdPerMillion": {"input_text": .5, "input_audio": 3, "input_image": 3, "input_video": 3, "output_text": 2, "output_audio": 12},
        "runs": [summarize(path) for path in sys.argv[1:]],
        "billingReconciled": False,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
