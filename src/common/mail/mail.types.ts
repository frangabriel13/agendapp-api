/**
 * El contrato mínimo entre "quiero mandar un mail" y "lo pongo en el cable".
 *
 * A propósito no sabe nada del negocio: recibe un sobre ya armado. Quién decide
 * qué dice cada mail es `MailService`; quién lo entrega es un `MailProvider`.
 * Cambiar de Resend a SES es escribir otra implementación, no tocar los flujos.
 */

export interface MailMessage {
  /** Un solo destinatario: todos los mails de este sistema son personales. */
  to: string;
  subject: string;
  html: string;
  /**
   * Alternativa en texto plano. No es opcional: los clientes que bloquean HTML
   * mostrarían un mail vacío, y los filtros de spam castigan al que no la trae.
   */
  text: string;
}

export interface MailProvider {
  /** Para poder loguear con qué se mandó (o con qué no se mandó). */
  readonly name: string;

  /**
   * Entrega el mensaje. **Puede lanzar**: el que decide qué hacer con un fallo
   * es `MailService`, no el provider ni el flujo que lo pidió.
   */
  send(message: MailMessage): Promise<void>;
}

/** Token de inyección: `MailProvider` es una interfaz y no existe en runtime. */
export const MAIL_PROVIDER = Symbol('MAIL_PROVIDER');
