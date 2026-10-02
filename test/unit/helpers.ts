import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, isActive, isNight, nextBoundary, withManualToggle } from '../../src/shared/settings.ts';

const at = (h: number, m = 0) => new Date(2026, 9, 2, h, m).getTime();

export function schedule() {
  assert.equal(isNight(at(20), '19:00', '07:00'), true);
  assert.equal(isNight(at(6, 59), '19:00', '07:00'), true);
  assert.equal(isNight(at(7), '19:00', '07:00'), false);
  assert.equal(isNight(at(12), '09:00', '17:00'), true);
  assert.equal(new Date(nextBoundary(at(20), '19:00', '07:00')).getHours(), 7);

  // Manual off at night lasts until the morning boundary, then the schedule takes over.
  const s = withManualToggle(DEFAULT_SETTINGS, false, at(22));
  assert.equal(isActive(s, at(23)), false);
  assert.equal(isActive(s, at(19, 30) + 86400000), true);
  // Turning on at noon keeps it on through the evening.
  const s2 = withManualToggle(DEFAULT_SETTINGS, true, at(12));
  assert.equal(isActive(s2, at(15)), true);
  assert.equal(isActive(s2, at(21)), true);
  // Toggling to what the schedule already says clears the override.
  assert.equal(withManualToggle(DEFAULT_SETTINGS, true, at(22)).override, null);
  // Without a schedule, the switch is the state.
  const manual = { ...DEFAULT_SETTINGS, schedule: { ...DEFAULT_SETTINGS.schedule, enabled: false } };
  assert.equal(isActive(withManualToggle(manual, false, at(22)), at(22)), false);
}
