import { REDACTED, isSecretKey, redactSecrets, toAuditChanges } from './redact';

describe('isSecretKey', () => {
  /**
   * El caso que justifica el match por substring: nadie iba a acordarse de
   * enumerar `currentPassword` **y** `newPassword` **y** `passwordHash`.
   */
  it('reconoce las variantes sin enumerarlas', () => {
    for (const key of [
      'password',
      'currentPassword',
      'newPassword',
      'passwordHash',
      'refreshToken',
      'accessToken',
      'MP_WEBHOOK_SECRET',
      'x-signature',
      'apiKey',
      'api_key',
    ]) {
      expect(isSecretKey(key)).toBe(true);
    }
  });

  it('no censura lo que hay que poder leer', () => {
    for (const key of ['email', 'firstName', 'startsAt', 'status', 'notes']) {
      expect(isSecretKey(key)).toBe(false);
    }
  });
});

describe('redactSecrets', () => {
  /** El test que fija por qué existe todo este archivo. */
  it('la contraseña de un login no llega a la base', () => {
    const result = redactSecrets({
      email: 'maria@test.com',
      password: 'Password123!',
    });

    expect(result).toEqual({ email: 'maria@test.com', password: REDACTED });
  });

  it('baja por objetos anidados y por arrays', () => {
    const result = redactSecrets({
      user: { email: 'a@b.c', token: 'abc' },
      sessions: [{ refreshToken: 'x' }, { refreshToken: 'y' }],
    });

    expect(result).toEqual({
      user: { email: 'a@b.c', token: REDACTED },
      sessions: [{ refreshToken: REDACTED }, { refreshToken: REDACTED }],
    });
  });

  it('no muta la entrada: el handler ya usó ese body', () => {
    const body = { password: 'secreta' };

    redactSecrets(body);

    expect(body.password).toBe('secreta');
  });

  it('las fechas quedan legibles', () => {
    expect(redactSecrets({ at: new Date('2026-09-02T12:00:00.000Z') })).toEqual(
      {
        at: '2026-09-02T12:00:00.000Z',
      },
    );
  });

  it('corta un texto enorme en vez de guardarlo entero', () => {
    const result = redactSecrets({ notes: 'x'.repeat(5_000) }) as {
      notes: string;
    };

    expect(result.notes.length).toBeLessThan(1_100);
    expect(result.notes.endsWith('…')).toBe(true);
  });

  it('resume un array enorme y dice cuánto dejó afuera', () => {
    const result = redactSecrets(Array.from({ length: 60 }, (_, i) => i));

    expect(result).toHaveLength(51);
    expect((result as unknown[]).at(-1)).toBe('[+10 más]');
  });

  /** Un body anidado sin fondo no puede costarnos el CPU del servidor. */
  it('corta la recursión', () => {
    let nested: Record<string, unknown> = { password: 'x' };

    for (let i = 0; i < 20; i += 1) {
      nested = { level: nested };
    }

    expect(JSON.stringify(redactSecrets(nested))).toContain(
      'demasiado anidado',
    );
  });

  /** Un ciclo tampoco: no se cuelga, corta por profundidad. */
  it('sobrevive a una referencia circular', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;

    expect(() => redactSecrets(a)).not.toThrow();
  });
});

describe('toAuditChanges', () => {
  it('un body vacío no se guarda', () => {
    expect(toAuditChanges({})).toBeUndefined();
    expect(toAuditChanges(undefined)).toBeUndefined();
    expect(toAuditChanges('texto suelto')).toBeUndefined();
  });

  it('un body con datos se guarda censurado', () => {
    expect(toAuditChanges({ role: 'OWNER', password: 'x' })).toEqual({
      role: 'OWNER',
      password: REDACTED,
    });
  });
});
