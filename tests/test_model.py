import unittest

from aed_pred.model import _backtest_champion, _cycle_profile, _distance, _rows_for_horizon, parse_update_time, parse_wait_minutes, percentile


class ModelTests(unittest.TestCase):
    def test_wait_parser(self):
        self.assertEqual(parse_wait_minutes("3.5 hours"), 210)
        self.assertEqual(parse_wait_minutes("47 minutes"), 47)
        self.assertEqual(parse_wait_minutes("less than 15 minutes"), 15)
        self.assertIsNone(parse_wait_minutes("Managing multiple resuscitation cases"))

    def test_update_time_parser(self):
        parsed = parse_update_time("31/5/2026 11:45PM")
        self.assertEqual((parsed.hour, parsed.minute), (23, 45))

    def test_percentile(self):
        self.assertEqual(percentile([0, 10, 20], 0.5), 10)

    def test_stored_horizon_target_survives_sampling(self):
        row = {
            'ts': '2026-07-01T00:00:00+08:00',
            'p50': 30,
            'emergency': False,
            'targets': {'15': 45},
            'target_emergency': {'15': True},
        }
        usable = _rows_for_horizon([row], 15)
        self.assertEqual(usable[0]['target'], 45)
        self.assertTrue(usable[0]['future_emergency'])

    def test_holiday_mismatch_adds_distance_penalty(self):
        base = {'h': 12, 'dow': 1, 'p50': 60, 'p95': 90, 'trend': 0, 'emergency': False, 'holiday': False}
        holiday = {**base, 'holiday': True}
        self.assertAlmostEqual(_distance(holiday, base, 60) - _distance(base, base, 60), 0.22)

    def test_night_capacity_regime_adds_distance_penalty(self):
        current = {'h': 2, 'dow': 1, 'p50': 60, 'p95': 90, 'trend': 0, 'emergency': False, 'holiday': False}
        daytime = {**current, 'h': 8}
        expected_hour_component = 0.3 * (6 / 6)
        self.assertAlmostEqual(_distance(daytime, current, 60) - expected_hour_component, 0.28)

    def test_champion_uses_separate_calibration_and_test(self):
        rows = []
        for index in range(120):
            rows.append({
                'ts': f'2026-01-{1 + index // 24:02d}T{index % 24:02d}:00:00+08:00',
                'h': index % 24,
                'dow': index % 7,
                'p50': 60,
                'p95': 90,
                'trend': 0,
                'emergency': False,
                'holiday': False,
                'targets': {'60': 60},
                'target_emergency': {'60': False},
            })
        result = _backtest_champion(rows, 60)
        self.assertEqual(result['status'], 'calibration_and_blocked_test')
        self.assertEqual(result['selected_method'], 'persistence')
        self.assertGreater(result['test_cases'], 0)

    def test_cycle_profile_separates_low_wait_from_clearing(self):
        rows = [
            {'h': 6, 'p50': 180, 'targets': {'60': 120}},
            {'h': 7, 'p50': 120, 'targets': {'60': 120}},
            {'h': 8, 'p50': 120, 'targets': {'60': 150}},
        ]
        profile = _cycle_profile(rows)
        self.assertEqual(profile['historical_lowest_hour'], '07:00–08:00')
        self.assertEqual(profile['fastest_clearing_hour'], '06:00–07:00')
        self.assertEqual(profile['fastest_clearing_change_next_60m'], -60)


if __name__ == "__main__":
    unittest.main()
