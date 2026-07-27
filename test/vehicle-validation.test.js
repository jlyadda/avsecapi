const test = require('node:test');
const assert = require('node:assert/strict');
const { schemas } = require('../validation');

test('vehicle access payload normalizes registration, NIN and date', () => {
  const result = schemas.vehicleAccessApplication.safeParse({
    body: {
      driver_name: 'Lyadda Jonathan',
      driver_national_id_number: 'cm203601en7tl',
      vehicle_registration_number: 'uab 123x',
      vehicle_type: 'Service van',
      company: 'Kalman Solutions Limited',
      reason_for_access: 'Transport CCTV installation equipment',
      access_gate: 'Main Gate',
      date_of_access: '27-07-2026',
      time_of_access: '14:30',
      duration_of_access_hours: 6
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.data.body.driver_national_id_number, 'CM203601EN7TL');
  assert.equal(result.data.body.vehicle_registration_number, 'UAB 123X');
  assert.equal(result.data.body.date_of_access, '2026-07-27');
  assert.equal(result.data.body.time_of_access, '14:30');
  assert.equal(result.data.body.duration_of_access_hours, 6);
});

test('vehicle access payload rejects non-DD-MM-YYYY dates', () => {
  const result = schemas.vehicleAccessApplication.safeParse({
    body: {
      driver_name: 'Lyadda Jonathan',
      driver_national_id_number: 'CM203601EN7TL',
      vehicle_registration_number: 'UAB 123X',
      vehicle_type: 'Service van',
      company: 'Kalman Solutions Limited',
      reason_for_access: 'Transport CCTV installation equipment',
      access_gate: 'Main Gate',
      date_of_access: '2026-07-27',
      time_of_access: '14:30',
      duration_of_access_hours: 6
    }
  });

  assert.equal(result.success, false);
});

test('vehicle access payload rejects invalid time and duration', () => {
  const result = schemas.vehicleAccessApplication.safeParse({
    body: {
      driver_name: 'Lyadda Jonathan',
      driver_national_id_number: 'CM203601EN7TL',
      vehicle_registration_number: 'UAB 123X',
      vehicle_type: 'Service van',
      company: 'Kalman Solutions Limited',
      reason_for_access: 'Transport CCTV installation equipment',
      access_gate: 'Main Gate',
      date_of_access: '27-07-2026',
      time_of_access: '25:10',
      duration_of_access_hours: 0
    }
  });

  assert.equal(result.success, false);
});
