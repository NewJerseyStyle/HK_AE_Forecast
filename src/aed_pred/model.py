from __future__ import annotations

import gzip
import json
import math
import re
import statistics
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

HK_TZ = timezone(timedelta(hours=8))
HORIZON_STEPS = 4
FORECAST_HORIZONS = (15, 30, 45, 60, 90, 120)

HOSPITAL_TC = {
    "Alice Ho Miu Ling Nethersole Hospital": "雅麗氏何妙齡那打素醫院",
    "Caritas Medical Centre": "明愛醫院",
    "Kwong Wah Hospital": "廣華醫院",
    "North District Hospital": "北區醫院",
    "North Lantau Hospital": "北大嶼山醫院",
    "Pamela Youde Nethersole Eastern Hospital": "東區尤德夫人那打素醫院",
    "Pok Oi Hospital": "博愛醫院",
    "Prince of Wales Hospital": "威爾斯親王醫院",
    "Princess Margaret Hospital": "瑪嘉烈醫院",
    "Queen Elizabeth Hospital": "伊利沙伯醫院",
    "Queen Mary Hospital": "瑪麗醫院",
    "Ruttonjee Hospital": "律敦治醫院",
    "St John Hospital": "長洲醫院",
    "Tin Shui Wai Hospital": "天水圍醫院",
    "Tseung Kwan O Hospital": "將軍澳醫院",
    "Tuen Mun Hospital": "屯門醫院",
    "United Christian Hospital": "基督教聯合醫院",
    "Yan Chai Hospital": "仁濟醫院",
}


def parse_wait_minutes(value: str | None) -> float | None:
    if not value:
        return None
    text = value.lower().strip()
    if "multiple resuscitation" in text:
        return None
    number = re.search(r"(\d+(?:\.\d+)?)", text)
    if not number:
        return None
    amount = float(number.group(1))
    if "hour" in text:
        amount *= 60
    return amount


def parse_update_time(value: str) -> datetime:
    return datetime.strptime(value.replace(" ", ""), "%d/%m/%Y%I:%M%p").replace(tzinfo=HK_TZ)


def normalize_payload(payload: dict, archive_timestamp: str | None = None) -> dict:
    observed = parse_update_time(payload["updateTime"])
    if archive_timestamp:
        archive_dt = datetime.strptime(archive_timestamp, "%Y%m%d-%H%M").replace(tzinfo=HK_TZ)
        # The upstream updateTime occasionally trails the archive filename by 15 minutes.
        observed = max(observed, archive_dt - timedelta(minutes=15))
    hospitals = {}
    for row in payload["waitTime"]:
        name = row["hospName"]
        hospitals[name] = {
            "t3": {
                "p50": parse_wait_minutes(row.get("t3p50")),
                "p95": parse_wait_minutes(row.get("t3p95")),
            },
            "t45": {
                "p50": parse_wait_minutes(row.get("t45p50")),
                "p95": parse_wait_minutes(row.get("t45p95")),
            },
            "critical": row.get("manageT1case") in {"Y", "N/A"},
            "emergency": row.get("manageT2case") in {"Y", "N/A"},
            "multiple_resuscitation": row.get("manageT1case") == "N/A" or row.get("manageT2case") == "N/A",
        }
    return {"timestamp": observed.isoformat(), "hospitals": hospitals}


def percentile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = (len(ordered) - 1) * q
    lo = math.floor(position)
    hi = math.ceil(position)
    if lo == hi:
        return ordered[lo]
    return ordered[lo] * (hi - position) + ordered[hi] * (position - lo)


def percentile_rank(values: list[float], value: float) -> float:
    if not values:
        return 0.5
    return sum(v <= value for v in values) / len(values)


def _trend(series: list[dict], index: int, hospital: str, triage: str) -> float:
    current = series[index]["hospitals"][hospital][triage]["p50"]
    earlier_index = max(0, index - HORIZON_STEPS)
    earlier = series[earlier_index]["hospitals"].get(hospital, {}).get(triage, {}).get("p50")
    return 0.0 if current is None or earlier is None else current - earlier


def build_state(
    snapshots: Iterable[dict],
    max_points_per_group: int = 4000,
    holiday_dates: set[str] | None = None,
) -> dict:
    holiday_dates = holiday_dates or set()
    series = sorted(snapshots, key=lambda row: row["timestamp"])
    series_by_time = {datetime.fromisoformat(row['timestamp']): row for row in series}
    points: dict[str, list[dict]] = defaultdict(list)
    for i, snapshot in enumerate(series):
        dt = datetime.fromisoformat(snapshot["timestamp"])
        for hospital, row in snapshot["hospitals"].items():
            for triage in ("t3", "t45"):
                p50 = row[triage]["p50"]
                p95 = row[triage]["p95"]
                if p50 is None or p95 is None:
                    continue
                point = {
                    "ts": snapshot["timestamp"],
                    "h": dt.hour + dt.minute / 60,
                    "dow": dt.weekday(),
                    "p50": p50,
                    "p95": p95,
                    "trend": _trend(series, i, hospital, triage),
                    "emergency": row["emergency"] or row["critical"] or row["multiple_resuscitation"],
                }
                point['targets'] = {}
                point['target_emergency'] = {}
                point['holiday'] = dt.strftime('%Y%m%d') in holiday_dates
                for horizon in FORECAST_HORIZONS:
                    exact_future = series_by_time.get(dt + timedelta(minutes=horizon))
                    if exact_future is None:
                        continue
                    exact_row = exact_future['hospitals'].get(hospital)
                    if exact_row and exact_row[triage]['p50'] is not None:
                        point['targets'][str(horizon)] = exact_row[triage]['p50']
                        point['target_emergency'][str(horizon)] = (
                            exact_row['emergency']
                            or exact_row['critical']
                            or exact_row['multiple_resuscitation']
                        )
                if i + HORIZON_STEPS < len(series):
                    future = series[i + HORIZON_STEPS]
                    future_dt = datetime.fromisoformat(future["timestamp"])
                    if future_dt - dt <= timedelta(minutes=75):
                        future_row = future["hospitals"].get(hospital)
                        if future_row and future_row[triage]["p50"] is not None:
                            point["target"] = future_row[triage]["p50"]
                            point["future_emergency"] = (
                                future_row["emergency"]
                                or future_row["critical"]
                                or future_row["multiple_resuscitation"]
                            )
                points[f"{hospital}|{triage}"].append(point)
    for key, rows in points.items():
        if len(rows) > max_points_per_group:
            # Deterministic evenly-spaced reservoir; retains the full time range.
            step = len(rows) / max_points_per_group
            points[key] = [rows[min(int(i * step), len(rows) - 1)] for i in range(max_points_per_group)]
    return {
        "schema_version": 1,
        "source": "https://www.ha.org.hk/opendata/aed/aedwtdata2-en.json",
        "generated_at": datetime.now(HK_TZ).isoformat(),
        "first_timestamp": series[0]["timestamp"],
        "last_timestamp": series[-1]["timestamp"],
        "snapshot_count": len(series),
        "points": points,
        "latest": series[-1],
    }


def _distance(candidate: dict, current: dict, scale: float) -> float:
    hour_delta = abs(candidate["h"] - current["h"])
    hour_delta = min(hour_delta, 24 - hour_delta) / 6
    dow_penalty = 0 if candidate["dow"] == current["dow"] else 0.18
    emergency_penalty = 0 if candidate["emergency"] == current["emergency"] else 0.65
    holiday_penalty = 0 if candidate.get('holiday', False) == current.get('holiday', False) else 0.22
    candidate_night = 0 <= candidate['h'] < 6
    current_night = 0 <= current['h'] < 6
    night_capacity_penalty = 0 if candidate_night == current_night else 0.28
    return (
        abs(candidate["p50"] - current["p50"]) / scale
        + 0.45 * abs(candidate["p95"] - current["p95"]) / scale
        + 0.35 * abs(candidate["trend"] - current["trend"]) / scale
        + 0.3 * hour_delta
        + dow_penalty
        + emergency_penalty
        + holiday_penalty
        + night_capacity_penalty
    )


def _forecast_group(rows: list[dict], current: dict, triage: str) -> dict:
    usable = [row for row in rows if "target" in row]
    scale = max(30.0, percentile([row["p50"] for row in usable], 0.75))
    neighbours = sorted(usable, key=lambda row: _distance(row, current, scale))[: min(240, len(usable))]
    targets = [row["target"] for row in neighbours]
    deltas = [row["target"] - row["p50"] for row in neighbours]
    threshold = 15 if triage == "t3" else 30
    shock_count = sum(
        delta >= threshold or (not row["emergency"] and row.get("future_emergency", False))
        for row, delta in zip(neighbours, deltas)
    )
    return {
        "p10": round(percentile(targets, 0.10)),
        "p50": round(percentile(targets, 0.50)),
        "p90": round(percentile(targets, 0.90)),
        "change_p50": round(percentile(deltas, 0.50)),
        "shock_probability": round(100 * shock_count / len(neighbours)) if neighbours else None,
        "analog_count": len(neighbours),
        "definition": f"未來60分鐘上升至少{threshold}分鐘，或緊急／危殆訊號由無轉有",
    }


def _rows_for_horizon(rows: list[dict], horizon: int) -> list[dict]:
    key = str(horizon)
    stored = []
    for row in rows:
        target = row.get('targets', {}).get(key)
        if target is None:
            continue
        candidate = dict(row)
        candidate['target'] = target
        candidate['future_emergency'] = row.get('target_emergency', {}).get(key, False)
        stored.append(candidate)
    if stored:
        return stored
    by_time = {datetime.fromisoformat(row['ts']): row for row in rows}
    fallback = []
    for row in rows:
        future = by_time.get(datetime.fromisoformat(row['ts']) + timedelta(minutes=horizon))
        if future is None:
            continue
        candidate = dict(row)
        candidate['target'] = future['p50']
        candidate['future_emergency'] = future['emergency']
        fallback.append(candidate)
    return fallback


def _forecast_from_rows(usable: list[dict], current: dict, triage: str, horizon: int) -> dict:
    scale = max(30.0, percentile([row['p50'] for row in usable], 0.75))
    neighbours = sorted(usable, key=lambda row: _distance(row, current, scale))[: min(240, len(usable))]
    targets = [row['target'] for row in neighbours]
    deltas = [row['target'] - row['p50'] for row in neighbours]
    threshold = 15 if triage == 't3' else 30
    shock_count = sum(
        delta >= threshold or (not row['emergency'] and row.get('future_emergency', False))
        for row, delta in zip(neighbours, deltas)
    )
    sample_count = len(targets)
    return {
        'p10': round(percentile(targets, 0.10)),
        'p50': round(percentile(targets, 0.50)),
        'p90': round(percentile(targets, 0.90)),
        'change_p50': round(percentile(deltas, 0.50)),
        'shock_probability': round(100 * shock_count / len(neighbours)) if neighbours else None,
        'analog_count': len(neighbours),
        'definition': f'未來{horizon}分鐘上升至少{threshold}分鐘，或緊急／危殆訊號由無轉有',
        'simulation': {
            'sample_count': sample_count,
            'within_60_pct': round(100 * sum(value <= 60 for value in targets) / sample_count) if sample_count else None,
            'within_120_pct': round(100 * sum(value <= 120 for value in targets) / sample_count) if sample_count else None,
            'over_240_pct': round(100 * sum(value > 240 for value in targets) / sample_count) if sample_count else None,
        },
    }


def _forecast_group_at_horizon(rows: list[dict], current: dict, triage: str, horizon: int) -> dict:
    return _forecast_from_rows(_rows_for_horizon(rows, horizon), current, triage, horizon)
    by_time = {datetime.fromisoformat(row['ts']): row for row in rows}
    usable = []
    for row in rows:
        future = by_time.get(datetime.fromisoformat(row['ts']) + timedelta(minutes=horizon))
        if future is None:
            continue
        candidate = dict(row)
        candidate['target'] = future['p50']
        candidate['future_emergency'] = future['emergency']
        usable.append(candidate)
    scale = max(30.0, percentile([row['p50'] for row in usable], 0.75))
    neighbours = sorted(usable, key=lambda row: _distance(row, current, scale))[: min(240, len(usable))]
    targets = [row['target'] for row in neighbours]
    deltas = [row['target'] - row['p50'] for row in neighbours]
    threshold = 15 if triage == 't3' else 30
    shock_count = sum(
        delta >= threshold or (not row['emergency'] and row.get('future_emergency', False))
        for row, delta in zip(neighbours, deltas)
    )
    return {
        'p10': round(percentile(targets, 0.10)),
        'p50': round(percentile(targets, 0.50)),
        'p90': round(percentile(targets, 0.90)),
        'change_p50': round(percentile(deltas, 0.50)),
        'shock_probability': round(100 * shock_count / len(neighbours)) if neighbours else None,
        'analog_count': len(neighbours),
        'definition': f'未來{horizon}分鐘上升至少{threshold}分鐘，或緊急／危殆訊號由無轉有',
    }


def _cycle_profile(rows: list[dict]) -> dict:
    bands = [
        (0, 6, '深夜 00–06'),
        (6, 12, '早上 06–12'),
        (12, 18, '下午 12–18'),
        (18, 24, '晚上 18–24'),
    ]
    overall = percentile([row['p50'] for row in rows], 0.5)
    periods = []
    for start, end, label in bands:
        values = [row['p50'] for row in rows if start <= row['h'] < end]
        median = percentile(values, 0.5)
        periods.append({
            'label': label,
            'median_minutes': round(median),
            'vs_overall_minutes': round(median - overall),
            'observations': len(values),
        })
    peak = max(periods, key=lambda row: row['median_minutes'])
    hourly = []
    for hour in range(24):
        hour_rows = [row for row in rows if hour <= row['h'] < hour + 1]
        values = [row['p50'] for row in hour_rows]
        changes = [
            row['targets']['60'] - row['p50']
            for row in hour_rows
            if row.get('targets', {}).get('60') is not None
        ]
        if not values:
            continue
        hourly.append({
            'hour': hour,
            'label': f'{hour:02d}:00–{(hour + 1) % 24:02d}:00',
            'median_minutes': round(percentile(values, 0.5)),
            'median_change_next_60m': round(percentile(changes, 0.5)) if changes else None,
            'observations': len(values),
        })
    lowest = min(hourly, key=lambda row: row['median_minutes'])
    clearing = min(
        (row for row in hourly if row['median_change_next_60m'] is not None),
        key=lambda row: row['median_change_next_60m'],
    )
    return {
        'periods': periods,
        'hourly': hourly,
        'historical_peak': peak['label'],
        'peak_vs_overall_minutes': peak['vs_overall_minutes'],
        'historical_lowest_hour': lowest['label'],
        'lowest_hour_median_minutes': lowest['median_minutes'],
        'fastest_clearing_hour': clearing['label'],
        'fastest_clearing_change_next_60m': clearing['median_change_next_60m'],
        'note': '描述輪候時間的週期，不等同於量度員工效率。',
    }


def _candidate_predictions(reference: list[dict], queries: list[dict], horizon: int) -> list[dict]:
    scale = max(30.0, percentile([row['p50'] for row in reference], 0.75))
    predictions = []
    for query in queries:
        neighbours = sorted(reference, key=lambda row: _distance(row, query, scale))[: min(120, len(reference))]
        targets = [row['target'] for row in neighbours]
        analogue = percentile(targets, 0.5)
        low = percentile(targets, 0.1)
        high = percentile(targets, 0.9)
        persistence = query['p50']
        trend = max(0, persistence + 0.5 * query['trend'] * min(2, horizon / 60))
        predictions.append({
            'actual': query['target'],
            'persistence': persistence,
            'damped_trend': trend,
            'analogue': analogue,
            'low_spread': max(0, analogue - low),
            'high_spread': max(0, high - analogue),
        })
    return predictions


def _prediction_for_method(row: dict, method: str) -> float:
    if method == 'damped_trend':
        return row['damped_trend']
    if method == 'historical_analogues':
        return row['analogue']
    if method.startswith('blend_'):
        weight = int(method.split('_')[1]) / 100
        return (1 - weight) * row['persistence'] + weight * row['analogue']
    return row['persistence']


def _backtest_champion(rows: list[dict], horizon: int) -> dict:
    usable = _rows_for_horizon(rows, horizon)
    first_cut = max(1, int(len(usable) * 0.6))
    second_cut = max(first_cut + 1, int(len(usable) * 0.8))
    train = usable[:first_cut]
    calibration = usable[first_cut:second_cut]
    test_reference = usable[:second_cut]
    test = usable[second_cut:]
    if not train or not calibration or not test:
        return {'status': 'insufficient_data'}
    calibration = calibration[::max(1, len(calibration) // 60)]
    test = test[::max(1, len(test) // 80)]
    methods = ('persistence', 'damped_trend', 'blend_25', 'blend_50', 'blend_75', 'historical_analogues')
    calibration_predictions = _candidate_predictions(train, calibration, horizon)
    calibration_mae = {
        method: statistics.fmean(abs(row['actual'] - _prediction_for_method(row, method)) for row in calibration_predictions)
        for method in methods
    }
    selected_method = min(methods, key=lambda method: calibration_mae[method])
    test_predictions = _candidate_predictions(test_reference, test, horizon)
    errors = {
        method: [abs(row['actual'] - _prediction_for_method(row, method)) for row in test_predictions]
        for method in methods
    }
    covered = 0
    for row in test_predictions:
        predicted = _prediction_for_method(row, selected_method)
        covered += predicted - row['low_spread'] <= row['actual'] <= predicted + row['high_spread']
    selected_mae = statistics.fmean(errors[selected_method])
    persistence_mae = statistics.fmean(errors['persistence'])
    improvement = 100 * (persistence_mae - selected_mae) / max(persistence_mae, 1)
    return {
        'status': 'calibration_and_blocked_test',
        'calibration_share': 0.2,
        'test_share': 0.2,
        'calibration_cases': len(calibration_predictions),
        'test_cases': len(test_predictions),
        'selected_method': selected_method,
        'mae_minutes': round(selected_mae, 1),
        'persistence_mae_minutes': round(persistence_mae, 1),
        'analogue_mae_minutes': round(statistics.fmean(errors['historical_analogues']), 1),
        'trend_mae_minutes': round(statistics.fmean(errors['damped_trend']), 1),
        'relative_improvement_pct': round(improvement, 1),
        'p10_p90_coverage_pct': round(100 * covered / len(test_predictions)),
    }


def _backtest_group_at_horizon(rows: list[dict], triage: str, horizon: int) -> dict:
    return _backtest_champion(rows, horizon)
    usable = _rows_for_horizon(rows, horizon)
    split = max(1, int(len(usable) * 0.8))
    train, test = usable[:split], usable[split:]
    if not train or not test:
        return {'status': 'insufficient_data'}
    stride = max(1, len(test) // 80)
    test = test[::stride]
    scale = max(30.0, percentile([row['p50'] for row in train], 0.75))
    absolute_errors = []
    baseline_errors = []
    covered = 0
    for query in test:
        neighbours = sorted(train, key=lambda row: _distance(row, query, scale))[: min(120, len(train))]
        targets = [row['target'] for row in neighbours]
        predicted = percentile(targets, 0.5)
        low, high = percentile(targets, 0.1), percentile(targets, 0.9)
        actual = query['target']
        absolute_errors.append(abs(actual - predicted))
        baseline_errors.append(abs(actual - query['p50']))
        covered += low <= actual <= high
    analog_mae = statistics.fmean(absolute_errors)
    persistence_mae = statistics.fmean(baseline_errors)
    improvement = 100 * (persistence_mae - analog_mae) / max(persistence_mae, 1)
    return {
        'status': 'blocked_holdout',
        'horizon_minutes': horizon,
        'holdout_share': 0.2,
        'test_cases': len(test),
        'mae_minutes': round(analog_mae, 1),
        'persistence_mae_minutes': round(persistence_mae, 1),
        'relative_improvement_pct': round(improvement, 1),
        'p10_p90_coverage_pct': round(100 * covered / len(test)),
    }


def _backtest_group(rows: list[dict], triage: str) -> dict:
    return _backtest_group_at_horizon(rows, triage, 60)
    usable = [row for row in rows if 'target' in row]
    split = max(1, int(len(usable) * 0.8))
    train, test = usable[:split], usable[split:]
    if not train or not test:
        return {'status': 'insufficient_data'}
    stride = max(1, len(test) // 80)
    test = test[::stride]
    scale = max(30.0, percentile([row['p50'] for row in train], 0.75))
    absolute_errors = []
    baseline_errors = []
    covered = 0
    for query in test:
        neighbours = sorted(train, key=lambda row: _distance(row, query, scale))[: min(120, len(train))]
        targets = [row['target'] for row in neighbours]
        predicted = percentile(targets, 0.5)
        low, high = percentile(targets, 0.1), percentile(targets, 0.9)
        actual = query['target']
        absolute_errors.append(abs(actual - predicted))
        baseline_errors.append(abs(actual - query['p50']))
        covered += low <= actual <= high
    return {
        'status': 'blocked_holdout',
        'holdout_share': 0.2,
        'test_cases': len(test),
        'mae_minutes': round(statistics.fmean(absolute_errors), 1),
        'persistence_mae_minutes': round(statistics.fmean(baseline_errors), 1),
        'p10_p90_coverage_pct': round(100 * covered / len(test)),
    }


def make_public_model(state: dict) -> dict:
    latest = state["latest"]
    dt = datetime.fromisoformat(latest["timestamp"])
    hospitals = []
    for hospital, latest_row in latest["hospitals"].items():
        triages = {}
        for triage in ("t3", "t45"):
            rows = state["points"].get(f"{hospital}|{triage}", [])
            current = {
                "h": dt.hour + dt.minute / 60,
                "dow": dt.weekday(),
                "p50": latest_row[triage]["p50"],
                "p95": latest_row[triage]["p95"],
                "trend": rows[-1]["trend"] if rows else 0,
                "emergency": latest_row["emergency"] or latest_row["critical"] or latest_row["multiple_resuscitation"],
            }
            p50_values = [row["p50"] for row in rows]
            spread_values = [max(0, row["p95"] - row["p50"]) for row in rows]
            spread = max(0, current["p95"] - current["p50"])
            pressure = round(100 * (0.72 * percentile_rank(p50_values, current["p50"]) + 0.28 * percentile_rank(spread_values, spread)))
            current['holiday'] = rows[-1].get('holiday', False) if rows else False
            forecasts = {}
            validations = {}
            for horizon in FORECAST_HORIZONS:
                forecast = _forecast_group_at_horizon(rows, current, triage, horizon)
                validation = _backtest_group_at_horizon(rows, triage, horizon)
                method = validation.get('selected_method', 'persistence')
                if validation.get('relative_improvement_pct', -1) < 0:
                    method = 'persistence_guardrail'
                analogue_median = forecast['p50']
                low_spread = max(0, analogue_median - forecast['p10'])
                high_spread = max(0, forecast['p90'] - analogue_median)
                if method == 'damped_trend':
                    selected_median = max(0, current['p50'] + 0.5 * current['trend'] * min(2, horizon / 60))
                elif method.startswith('blend_'):
                    weight = int(method.split('_')[1]) / 100
                    selected_median = (1 - weight) * current['p50'] + weight * analogue_median
                elif method == 'historical_analogues':
                    selected_median = analogue_median
                else:
                    selected_median = current['p50']
                forecast['p50'] = round(selected_median)
                forecast['p10'] = max(0, round(selected_median - low_spread))
                forecast['p90'] = max(forecast['p50'], round(selected_median + high_spread))
                forecast['change_p50'] = round(selected_median - current['p50'])
                forecast['method'] = method
                validation['deployed_method'] = method
                validation['deployed_mae_minutes'] = (
                    validation['persistence_mae_minutes']
                    if method == 'persistence_guardrail'
                    else validation['mae_minutes']
                )
                forecast['validation'] = validation
                forecasts[str(horizon)] = forecast
                validations[str(horizon)] = validation
            triages[triage] = {
                'validation': _backtest_group(rows, triage),
                'validation_by_horizon': validations,
                'cycle_profile': _cycle_profile(rows),
                'forecast_by_horizon': forecasts,
                "current": {"p50": round(current["p50"]), "p95": round(current["p95"]), "trend_60m": round(current["trend"])},
                "pressure_score": pressure,
                "forecast_60m": forecasts['60'],
                "historical": {
                    "p50_median": round(percentile(p50_values, 0.5)),
                    "p50_p90": round(percentile(p50_values, 0.9)),
                    "observations": len(rows),
                },
            }
        hospitals.append({
            "id": hospital.lower().replace(" ", "-").replace("'", ""),
            "name_en": hospital,
            "name_tc": HOSPITAL_TC.get(hospital, hospital),
            "signals": {
                "critical": latest_row["critical"],
                "emergency": latest_row["emergency"],
                "multiple_resuscitation": latest_row["multiple_resuscitation"],
            },
            "triage": triages,
        })
    return {
        "schema_version": 1,
        "as_of": latest["timestamp"],
        "training_window": {"from": state["first_timestamp"], "to": state["last_timestamp"], "snapshots": state["snapshot_count"]},
        "model": {
            "name": "相似歷史狀態轉移模型",
            "horizon_minutes": 60,
            "pressure_definition": "院內同分流歷史中，當前 p50（72%）與 p95-p50 差距（28%）的百分位加權；是隱含壅塞指標，不是實際床位或人手容量。",
            'expert_assumptions': [
                '有經驗醫生口述夜間人手較少；模型把 00–06 視為獨立容量 regime，加強夜間對夜間的歷史配對。',
                '口述資料沒有逐院、逐更人手數或容量減幅，因此不直接設定固定延誤分鐘或容量折扣。',
                '病人現場觀察與醫院工作人員反饋指約 07:00 人手及效率較高；另有 09:00 前工作人口到院或陪同家人令需求增加的假設。兩者只作外部檢驗先驗，不設定固定效應。',
            ],
            "limitations": [
                "官方 API 沒有病人到達量、人手、床位或個別病人完成時間，不能識別真實服務率或排隊次序。",
                "預測是醫院層級分布，不是醫療建議，也不能保證個別病人的就診時間。",
                "「再等 15 分鐘仍未見醫生」是條件存活事件，不等於 15 分鐘後官方 p50 的數值變化；API 沒有病人級首次見醫生事件，不能校準個人 hazard 或可靠剩餘分鐘。",
                "院內模式不得用官方到院估算減去已等候時間；只更新優先隊列狀態及院級情境。",
            ],
        },
        "sources": [
            {"label": "醫管局急症室等候時間 JSON", "url": state["source"]},
            {"label": "DATA.GOV.HK 資料集", "url": "https://data.gov.hk/tc-data/dataset/hospital-hadata-ae-waiting-time"},
            {"label": "官方資料字典", "url": "https://www.ha.org.hk/opendata/Data-Specification-for-A%26E-Waiting-Time-tc.pdf"},
        ],
        "hospitals": sorted(hospitals, key=lambda row: row["name_tc"]),
    }


def save_state(state: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False, separators=(",", ":"))


def load_state(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def save_public_model(model: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(model, ensure_ascii=False, indent=2), encoding="utf-8")
