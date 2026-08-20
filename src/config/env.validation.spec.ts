import { validateEnv } from './env.validation';

/**
 * Lo mínimo para arrancar. Todo lo demás tiene default, y esa es media la
 * gracia: el proyecto levanta sin credenciales de ningún proveedor.
 */
const MINIMAL = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
};

const MP = {
  MP_ACCESS_TOKEN: 'TEST-abc',
  MP_WEBHOOK_SECRET: 'secreto',
};

describe('validateEnv', () => {
  it('arranca sin configurar ningún proveedor', () => {
    const env = validateEnv(MINIMAL);

    expect(env.MAIL_PROVIDER).toBe('log');
    expect(env.PAYMENT_PROVIDER).toBe('sandbox');
  });

  it('rechaza un DATABASE_URL que no es de Postgres', () => {
    expect(() =>
      validateEnv({ ...MINIMAL, DATABASE_URL: 'mysql://localhost/db' }),
    ).toThrow(/DATABASE_URL/);
  });

  it('rechaza un JWT_SECRET corto', () => {
    expect(() => validateEnv({ ...MINIMAL, JWT_SECRET: 'corto' })).toThrow(
      /JWT_SECRET/,
    );
  });

  /**
   * Estas dos validaciones cruzadas existen para que un deploy mal configurado
   * **no levante**, en vez de descubrirse con un cliente esperando en el
   * checkout o con alguien que no puede recuperar su contraseña.
   */
  describe('credenciales según el proveedor elegido', () => {
    it('resend sin API key no levanta', () => {
      expect(() =>
        validateEnv({ ...MINIMAL, MAIL_PROVIDER: 'resend' }),
      ).toThrow(/RESEND_API_KEY/);
    });

    it('resend con API key sí', () => {
      expect(
        validateEnv({
          ...MINIMAL,
          MAIL_PROVIDER: 'resend',
          RESEND_API_KEY: 're_x',
        }).MAIL_PROVIDER,
      ).toBe('resend');
    });

    it('mercadopago sin access token no levanta', () => {
      expect(() =>
        validateEnv({
          ...MINIMAL,
          PAYMENT_PROVIDER: 'mercadopago',
          MP_WEBHOOK_SECRET: 'secreto',
        }),
      ).toThrow(/MP_ACCESS_TOKEN/);
    });

    /**
     * El más importante de los dos: sin secreto de webhook no hay firma que
     * verificar, y el webhook pasa a ser un endpoint público donde cualquiera
     * avisa "este turno ya se pagó".
     */
    it('mercadopago sin secreto de webhook no levanta', () => {
      expect(() =>
        validateEnv({
          ...MINIMAL,
          PAYMENT_PROVIDER: 'mercadopago',
          MP_ACCESS_TOKEN: 'TEST-abc',
        }),
      ).toThrow(/MP_WEBHOOK_SECRET/);
    });

    it('mercadopago con las dos cosas sí', () => {
      expect(
        validateEnv({ ...MINIMAL, PAYMENT_PROVIDER: 'mercadopago', ...MP })
          .PAYMENT_PROVIDER,
      ).toBe('mercadopago');
    });

    /** En sandbox no se pide nada, aunque sobren variables de MP. */
    it('en sandbox las credenciales de MP son opcionales', () => {
      expect(validateEnv(MINIMAL).PAYMENT_PROVIDER).toBe('sandbox');
    });
  });
});
