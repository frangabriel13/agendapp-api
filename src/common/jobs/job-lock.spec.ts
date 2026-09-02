import { lockKey } from './job-lock.service';

describe('lockKey', () => {
  /** Si dos instancias no llegan al mismo número, el lock no sirve de nada. */
  it('el mismo nombre da siempre la misma clave', () => {
    expect(lockKey('expire-subscriptions')).toBe(
      lockKey('expire-subscriptions'),
    );
  });

  it('nombres distintos dan claves distintas', () => {
    const keys = new Set(
      [
        'expire-subscriptions',
        'release-abandoned-bookings',
        'appointment-reminders',
      ].map(lockKey),
    );

    expect(keys.size).toBe(3);
  });

  /** Postgres acepta bigint, pero un negativo es más difícil de rastrear. */
  it('siempre positivo y entero', () => {
    for (const name of ['a', 'appointment-reminders', 'ñandú', '']) {
      const key = lockKey(name);

      expect(Number.isInteger(key)).toBe(true);
      expect(key).toBeGreaterThanOrEqual(0);
      expect(key).toBeLessThanOrEqual(0xffffffff);
    }
  });
});
