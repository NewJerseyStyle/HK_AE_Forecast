from __future__ import annotations

import gzip
import json
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta
from pathlib import Path

from .model import normalize_payload

RESOURCE_HASH = '6da4663262413a19ba736dbf871c4e1973f6c02550a0c6ef7f6a228de76837a0'
LEGACY_RESOURCE_HASH = 'ee6ca4d8bfdb51cf754a71131547e1d215250e775389dcc155aba0bcfc0031c5'
REVISED_RESOURCE_CUTOFF = '20251013-1200'
ARCHIVE_OBJECTS = 'https://historical-resource-download.oss-cn-hongkong.aliyuncs.com'

SOURCE_URL = "https://www.ha.org.hk/opendata/aed/aedwtdata2-en.json"
ARCHIVE_API = "https://app.data.gov.hk/v1/historical-archive"


def _json_get(url: str, retries: int = 4) -> dict:
    error = None
    for attempt in range(retries):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "aed-pred/0.1 (+GitHub Pages research project)"})
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except Exception as exc:  # network failures are retried and surfaced after the final attempt
            error = exc
            time.sleep(0.5 * (2**attempt))
    raise RuntimeError(f"Failed to download {url}: {error}")


def list_versions(start: date, end: date) -> list[str]:
    # The endpoint truncates at 10,000 timestamps, so query in <= 60-day windows.
    timestamps: list[str] = []
    cursor = start
    while cursor <= end:
        chunk_end = min(end, cursor + timedelta(days=59))
        query = urllib.parse.urlencode({"url": SOURCE_URL, "start": cursor.strftime("%Y%m%d"), "end": chunk_end.strftime("%Y%m%d")})
        payload = _json_get(f"{ARCHIVE_API}/list-file-versions?{query}")
        chunk = payload.get("timestamps", [])
        if payload.get("version-count", len(chunk)) > 10_000:
            raise RuntimeError("Historical API truncated a date chunk; reduce the chunk size")
        timestamps.extend(chunk)
        cursor = chunk_end + timedelta(days=1)
    return sorted(set(timestamps))


def download_snapshot(timestamp: str) -> dict:
    # The version-list response identifies this stable resource hash. Direct
    # object reads avoid one API request and redirect per 15-minute snapshot.
    yyyy, mm, dd = timestamp[:4], timestamp[4:6], timestamp[6:8]
    revised = timestamp >= REVISED_RESOURCE_CUTOFF
    resource_hash = RESOURCE_HASH if revised else LEGACY_RESOURCE_HASH
    stem = 'aedwtdata2-en.json' if revised else 'aedwtdata-en.json'
    filename = f'{timestamp}-{stem}'
    direct_url = f'{ARCHIVE_OBJECTS}/{resource_hash}/data/{yyyy}/{mm}/{dd}/{filename}'
    try:
        return normalize_payload(_json_get(direct_url, retries=1), timestamp)
    except RuntimeError:
        # Older versions can belong to a previous resource hash. The official
        # historical API resolves the correct object across dataset revisions.
        pass
    query = urllib.parse.urlencode({"url": SOURCE_URL, "time": timestamp})
    return normalize_payload(_json_get(f"{ARCHIVE_API}/get-file?{query}"), timestamp)


def download_history(start: date, end: date, workers: int = 24, sample_every: int = 1) -> list[dict]:
    timestamps = list_versions(start, end)[::sample_every]
    snapshots = []
    failures = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(download_snapshot, ts): ts for ts in timestamps}
        for index, future in enumerate(as_completed(futures), 1):
            try:
                snapshots.append(future.result())
            except Exception as exc:
                failures.append({'timestamp': futures[future], 'error': str(exc)})
            if index % 250 == 0 or index == len(futures):
                print(f"Downloaded {index}/{len(futures)} snapshots", flush=True)
    if failures:
        failure_rate = 100 * len(failures) / max(len(timestamps), 1)
        print(f'Skipped {len(failures)} unavailable snapshots ({failure_rate:.2f}%)', flush=True)
    if len(snapshots) < max(100, 0.9 * len(timestamps)):
        raise RuntimeError(f'Historical archive completeness too low: {len(snapshots)}/{len(timestamps)}')
    return sorted(snapshots, key=lambda row: row['timestamp'])


def download_history_cached(
    start: date,
    end: date,
    workers: int = 24,
    sample_every: int = 1,
    cache_dir: Path = Path('data/archive-cache'),
) -> list[dict]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    snapshots = []
    cursor = start
    while cursor <= end:
        next_month = (cursor.replace(day=28) + timedelta(days=4)).replace(day=1)
        chunk_end = min(end, next_month - timedelta(days=1))
        cache_path = cache_dir / f'{cursor:%Y%m%d}-{chunk_end:%Y%m%d}.json.gz'
        if cache_path.exists():
            with gzip.open(cache_path, 'rt', encoding='utf-8') as handle:
                chunk = json.load(handle)
            print(f'Loaded {len(chunk)} cached snapshots from {cache_path}', flush=True)
        else:
            chunk = download_history(cursor, chunk_end, workers=workers, sample_every=sample_every)
            temporary = cache_path.with_suffix(cache_path.suffix + '.tmp')
            with gzip.open(temporary, 'wt', encoding='utf-8') as handle:
                json.dump(chunk, handle, ensure_ascii=False, separators=(',', ':'))
            temporary.replace(cache_path)
            print(f'Cached {len(chunk)} snapshots at {cache_path}', flush=True)
        snapshots.extend(chunk)
        cursor = chunk_end + timedelta(days=1)
    return sorted(snapshots, key=lambda row: row['timestamp'])


def download_current() -> dict:
    return normalize_payload(_json_get(SOURCE_URL))
