from __future__ import annotations

import csv
import io
import json
import urllib.request
from datetime import datetime
from pathlib import Path

from .model import HK_TZ, percentile_rank

AED_WEEKLY_URL = 'https://www.chp.gov.hk/files/misc/aed_weekly.csv'
FLUX_URL = 'https://www.chp.gov.hk/files/misc/flux_data.csv'
HOLIDAY_URL = 'https://www.1823.gov.hk/common/ical/en.json'
ATTENDANCE_URL = 'https://www.ha.org.hk/opendata/ae-attnd-en.json'
MANPOWER_URL = 'https://www.ha.org.hk/opendata/manpower-position-by-clusters-en.json'
SURGE_URL = 'https://www.ha.org.hk/opendata/pas_report/Daily_Services_Statistics/Daily_Services_Statistics_EN.json'


def _text_get(url: str) -> str:
    request = urllib.request.Request(url, headers={'User-Agent': 'aed-pred/0.1'})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read().decode('utf-8-sig')


def _rows(url: str) -> list[dict]:
    return list(csv.DictReader(io.StringIO(_text_get(url))))


def _json_get(url: str):
    request = urllib.request.Request(url, headers={'User-Agent': 'aed-pred/0.1'})
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.load(response)


def download_holiday_dates() -> set[str]:
    payload = _json_get(HOLIDAY_URL)
    calendars = payload.get('vcalendar', [])
    if not calendars:
        return set()
    return {event['dtstart'][0] for event in calendars[0].get('vevent', [])}


def _number(row: dict, key: str) -> float | None:
    value = (row.get(key) or '').strip()
    try:
        return float(value)
    except ValueError:
        return None


def refresh_context(path: Path) -> dict:
    aed_rows = _rows(AED_WEEKLY_URL)
    flux_rows = _rows(FLUX_URL)
    aed_latest, aed_previous = aed_rows[-1], aed_rows[-2]
    flux_latest, flux_previous = flux_rows[-1], flux_rows[-2]
    holiday_dates = download_holiday_dates()
    attendance_rows = _json_get(ATTENDANCE_URL)
    manpower_rows = _json_get(MANPOWER_URL)
    surge_rows = _json_get(SURGE_URL)
    attendance_year = max(row['Financial Year'] for row in attendance_rows)
    annual_attendance = {
        row['Hospital']: row['AE Attendances']
        for row in attendance_rows
        if row['Financial Year'] == attendance_year and row['Hospital']
    }
    manpower_year = max(row['Financial Year'] for row in manpower_rows)
    surge_latest_date = max(row['date'] for row in surge_rows)
    latest_surge_rows = [row for row in surge_rows if row['date'] == surge_latest_date]
    surge_overall = next((row for row in latest_surge_rows if row['cluster'] == 'HA Overall'), {})
    recent_aed = [
        float(row['ili_weekly_average_rate'])
        for row in aed_rows
        if int(row['year']) >= int(aed_latest['year']) - 2
    ]
    current_rate = float(aed_latest['ili_weekly_average_rate'])
    rank = round(100 * percentile_rank(recent_aed, current_rate))
    if rank >= 80:
        level = '高'
    elif rank >= 50:
        level = '中等'
    else:
        level = '較低'
    existing = {}
    if path.exists():
        existing = json.loads(path.read_text(encoding='utf-8'))
    context = {
        'as_of': datetime.now(HK_TZ).isoformat(),
        'seasonal_pressure': {
            'level': level,
            'aed_ili_rate': round(current_rate, 1),
            'aed_ili_percentile_3y': rank,
            'aed_ili_change': round(current_rate - float(aed_previous['ili_weekly_average_rate']), 1),
            'week_ending': aed_latest['end_date'],
            'flu_positive_proportion': _number(flux_latest, 'AandB_proportion'),
            'flu_positive_change': round(
                (_number(flux_latest, 'AandB_proportion') or 0)
                - (_number(flux_previous, 'AandB_proportion') or 0),
                4,
            ),
            'all_age_admission_rate': _number(flux_latest, 'Adm_All'),
            'model_use': 'monitoring_only',
            'note': '每週發布且有延遲；本版作季節背景，不直接調高即時預測，待較長訓練窗回測後才納入。',
        },
        'surge_statistics': existing.get('surge_statistics', {
            'latest_date': '2026-04-10',
            'availability': '只在服務需求高峰期間每日更新',
            'model_use': 'candidate_daily_feature',
        }),
        'operational_context': {
            'public_holiday_dates': sorted(holiday_dates),
            'holiday_model_use': 'analogue_matching_feature',
            'annual_attendance_year': attendance_year,
            'annual_ae_attendance_by_hospital': annual_attendance,
            'manpower_year': manpower_year,
            'manpower_scope': 'cluster_all_services_annual_fte',
            'night_shift_staffing_available': False,
            'night_capacity_expert_prior': True,
            'night_capacity_prior_source': 'experienced_doctor_oral_account',
            'night_capacity_regime': '00:00-06:00',
            'night_capacity_effect_size': None,
            'morning_capacity_expert_prior': True,
            'morning_capacity_peak': 'around_07:00',
            'morning_arrival_hypothesis': 'working_population_arrivals_and_family_escorts_increase_before_09:00',
            'morning_effect_size': None,
            'morning_prior_model_use': 'interpretation_only_arrival_service_confounding',
            'manpower_model_use': 'not_used_grain_mismatch',
            'surge_latest_date': surge_latest_date,
            'surge_overall': surge_overall,
            'surge_model_use': 'monitoring_only_outside_surge_period',
            'note': '有經驗醫生口述夜間人手較少；現場經驗亦指 07:00 左右容量較高、09:00 前工作人口到院或陪同家人令需求增加。公開資料沒有逐院逐更人手、分流到達與完成數，故不能從淨等候變化識別效率；模型只把 00–06 視為獨立配對 regime，其他早晨假設暫作解讀。',
        },
        'external_event_candidates': {
            'weather_warnings': {
                'provider': 'Hong Kong Observatory',
                'live_update': 'as_events_change',
                'historical_database_available': True,
                'model_use': 'candidate_pending_join_and_blocked_backtest',
            },
            'district_rainfall': {
                'provider': 'Hong Kong Observatory',
                'update_frequency': '15_minutes',
                'model_use': 'candidate_regional_demand_feature',
            },
            'district_ambulance_calls': {
                'provider': 'Fire Services Department',
                'update_frequency': 'about_quarterly',
                'model_use': 'background_only_not_live_forecasting',
            },
            'warning': '氣象與急症需求的關聯不等於能預測某院危急個案數；加入前須用較長時間窗作封鎖回測。',
        },
        'sources': [
            {'label': '急症室傳染病症候群監測', 'url': 'https://data.gov.hk/tc-data/dataset/hk-dh-chpsebcdde-aed-cdis-syndromic'},
            {'label': 'Flu Express 數據', 'url': 'https://data.gov.hk/tc-data/dataset/hk-dh-chpsebcddr-flu-express'},
            {'label': '服務需求高峰期重點數據', 'url': 'https://data.gov.hk/tc-data/dataset/hospital-hadata-key-statistics-during-surge'},
            {'label': '醫管局年度急症室求診人次', 'url': 'https://data.gov.hk/tc-data/dataset/hospital-hadata-service-ambulatory-community'},
            {'label': '醫管局年度聯網人手', 'url': 'https://data.gov.hk/tc-data/dataset/hospital-hadata-manpower'},
            {'label': '香港公眾假期', 'url': 'https://data.gov.hk/tc-data/dataset/hk-dpo-statistic-cal'},
            {'label': '天文台生效中天氣警告 API', 'url': 'https://data.gov.hk/tc-data/dataset/hk-hko-rss-weather-warning-information'},
            {'label': '天文台每 15 分鐘分區雨量', 'url': 'https://data.gov.hk/tc-data/dataset/hk-hko-rss-rainfall-in-the-past-hour'},
            {'label': '消防處十八區救護召喚（季度）', 'url': 'https://data.gov.hk/tc-data/dataset/hk-fsd-fsd1-fsdamb18'},
        ],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(context, ensure_ascii=False, indent=2), encoding='utf-8')
    return context
