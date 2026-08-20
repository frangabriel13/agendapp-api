import type {
  MailMessage,
  MailProvider,
} from '../../src/common/mail/mail.types';

/** El único link que lleva cada mail transaccional. */
const URL_PATTERN = /https?:\/\/\S+/;

/**
 * La casilla de los tests: en vez de mandar, guarda.
 *
 * Reemplaza al provider real en `createTestApp`, así los e2e pueden leer el
 * token que viajó por mail — que es la única forma de probar los flujos de
 * reset y verificación de punta a punta, porque en la base solo queda el hash.
 */
export class RecordingMailProvider implements MailProvider {
  readonly name = 'recording';

  readonly sent: MailMessage[] = [];

  /** Mientras esté en `true`, todo envío falla. Ver `failing()`. */
  private shouldFail = false;

  send(message: MailMessage): Promise<void> {
    if (this.shouldFail) {
      return Promise.reject(new Error('Proveedor de mail caído (simulado)'));
    }

    this.sent.push(message);

    return Promise.resolve();
  }

  clear(): void {
    this.sent.length = 0;
    this.shouldFail = false;
  }

  /** Simula un proveedor caído, para probar que eso no voltea el flujo. */
  failing(value: boolean): void {
    this.shouldFail = value;
  }

  to(email: string): MailMessage[] {
    return this.sent.filter((message) => message.to === email);
  }

  /** El último mail que le llegó a esa casilla. Falla si no llegó ninguno. */
  lastTo(email: string): MailMessage {
    const messages = this.to(email);
    const last = messages.at(-1);

    if (!last) {
      throw new Error(
        `No llegó ningún mail a ${email}. Casillas con mails: ${
          [...new Set(this.sent.map((m) => m.to))].join(', ') || '(ninguna)'
        }`,
      );
    }

    return last;
  }

  /** El token del link del último mail a esa casilla. */
  tokenFor(email: string): string {
    const url = URL_PATTERN.exec(this.lastTo(email).text)?.[0];

    if (!url) {
      throw new Error(`El mail a ${email} no traía ningún link`);
    }

    const token = new URL(url).searchParams.get('token');

    if (!token) {
      throw new Error(`El link del mail a ${email} no traía token: ${url}`);
    }

    return token;
  }
}
