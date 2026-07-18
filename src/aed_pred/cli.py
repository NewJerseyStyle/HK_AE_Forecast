from __future__ import annotations

import argparse
import json
from datetime import date, timedelta
from pathlib import Path

from .archive import download_current, download_history_cached
from .context import download_holiday_dates, refresh_context
from .model import build_state, load_state, make_public_model, save_public_model, save_state


def bootstrap(args: argparse.Namespace) -> None:
    end = date.fromisoformat(args.end) if args.end else date.today() - timedelta(days=1)
    start = date.fromisoformat(args.start) if args.start else end - timedelta(days=args.days - 1)
    snapshots = download_history_cached(
        start,
        end,
        workers=args.workers,
        sample_every=args.sample_every,
        cache_dir=Path(args.cache_dir),
    )
    state = build_state(snapshots, holiday_dates=download_holiday_dates())
    save_state(state, Path(args.state))
    save_public_model(make_public_model(state), Path(args.output))
    print(json.dumps({"snapshots": len(snapshots), "from": state["first_timestamp"], "to": state["last_timestamp"], "output": args.output}, ensure_ascii=False))


def refresh(args: argparse.Namespace) -> None:
    state_path = Path(args.state)
    state = load_state(state_path)
    latest = download_current()
    if latest['timestamp'] <= state['latest']['timestamp']:
        latest_timestamp = latest['timestamp']
        trained_timestamp = state['latest']['timestamp']
        print(
            f'Current API snapshot {latest_timestamp} is not newer than '
            f'trained snapshot {trained_timestamp}; keeping the latter'
        )
        latest = state['latest']
    # Rebuild from the compact point state is intentionally not attempted: a fresh
    # snapshot alone has no 60-minute outcome. Keep the trained analogue pool and
    # replace only the current state used for inference.
    state["latest"] = latest
    save_state(state, state_path)
    save_public_model(make_public_model(state), Path(args.output))
    print(f"Refreshed model at {latest['timestamp']}")


def update_context(args: argparse.Namespace) -> None:
    context = refresh_context(Path(args.output))
    seasonal = context['seasonal_pressure']
    week_ending = seasonal['week_ending']
    print(f'Refreshed seasonal context through {week_ending}')


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build Hong Kong A&E waiting-time forecasts")
    sub = parser.add_subparsers(required=True)
    boot = sub.add_parser("bootstrap", help="Download official history and train the analogue model")
    boot.add_argument("--start")
    boot.add_argument("--end")
    boot.add_argument("--days", type=int, default=90)
    boot.add_argument("--workers", type=int, default=24)
    boot.add_argument("--sample-every", type=int, default=1, help="Keep every Nth 15-minute archive snapshot")
    boot.add_argument("--state", default="data/training_state.json.gz")
    boot.add_argument("--output", default="web/data/model.json")
    boot.add_argument('--cache-dir', default='data/archive-cache', help='Month-sized resumable raw snapshot cache')
    boot.set_defaults(func=bootstrap)
    update = sub.add_parser("refresh", help="Refresh forecasts from the current HA snapshot")
    update.add_argument("--state", default="data/training_state.json.gz")
    update.add_argument("--output", default="web/data/model.json")
    update.set_defaults(func=refresh)
    context = sub.add_parser('context', help='Refresh weekly influenza and surge context')
    context.add_argument('--output', default='web/data/context.json')
    context.set_defaults(func=update_context)
    return parser


def main() -> None:
    args = make_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
