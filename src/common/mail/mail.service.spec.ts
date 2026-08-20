import { Logger } from '@nestjs/common';
import { MailService } from './mail.service';
import type { MailMessage, MailProvider } from './mail.types';

const RESET_URL = 'https://app.test/restablecer?token=abc.el-secreto';

function providerThat(
  send: (message: MailMessage) => Promise<void>,
): MailProvider {
  return { name: 'test', send: jest.fn(send) };
}

function makeService(provider: MailProvider): MailService {
  return new MailService(provider);
}

const RESET = {
  to: 'ana@test.com',
  firstName: 'Ana',
  url: RESET_URL,
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
};

describe('MailService', () => {
  let errorLog: jest.SpyInstance;

  beforeEach(() => {
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('le pasa al provider el sobre ya renderizado', async () => {
    const sent: MailMessage[] = [];
    const service = makeService(
      providerThat((message) => {
        sent.push(message);

        return Promise.resolve();
      }),
    );

    await expect(service.sendPasswordReset(RESET)).resolves.toBe(true);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: 'ana@test.com',
      subject: 'Restablecé tu contraseña',
    });
    expect(sent[0].html).toContain(RESET_URL);
    expect(sent[0].text).toContain(RESET_URL);
  });

  /**
   * La regla central de este archivo: un proveedor de mail caído no puede
   * voltear el registro de un negocio ni impedir que se emita un token.
   */
  describe('cuando el provider falla', () => {
    const exploding = () =>
      providerThat(() => Promise.reject(new Error('503')));

    it('no lanza: devuelve false', async () => {
      await expect(
        makeService(exploding()).sendPasswordReset(RESET),
      ).resolves.toBe(false);
    });

    it('deja el fallo en el log', async () => {
      await makeService(exploding()).sendPasswordReset(RESET);

      expect(errorLog).toHaveBeenCalledTimes(1);
    });

    /**
     * El cuerpo del mail lleva el link, y el link lleva el token. Un token en
     * los logs es un token comprometido: cualquiera con acceso al agregador de
     * logs podría tomar la cuenta.
     */
    it('no escribe el token en el log', async () => {
      await makeService(exploding()).sendPasswordReset(RESET);

      const logged = JSON.stringify(errorLog.mock.calls[0]);

      expect(logged).not.toContain('el-secreto');
      expect(logged).not.toContain(RESET_URL);
    });
  });
});
