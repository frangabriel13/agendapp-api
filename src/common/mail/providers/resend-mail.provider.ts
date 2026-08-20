import { Injectable } from '@nestjs/common';
import type { MailMessage, MailProvider } from '../mail.types';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Corte duro. Un mail se manda dentro de un request HTTP, así que un proveedor
 * que tarda es un request que tarda. Diez segundos es generoso para un POST y
 * corto comparado con el default de `fetch`, que es no tener timeout.
 */
const TIMEOUT_MS = 10_000;

/** Cuánto del cuerpo del error se guarda en el log. */
const MAX_ERROR_BODY = 500;

/**
 * Resend por HTTP, sin SDK.
 *
 * Mandar un mail es un `POST` con cuatro campos: agregar una dependencia para
 * eso trae su cadena de transitivas y su ritmo de actualizaciones a cambio de
 * nada. Node trae `fetch` nativo desde la 18.
 *
 * Para que los mails no caigan en spam hace falta un dominio verificado con
 * SPF y DKIM en el panel de Resend; sin eso solo se puede mandar a la casilla
 * de la cuenta. Eso es configuración de infraestructura, no de este código.
 */
@Injectable()
export class ResendMailProvider implements MailProvider {
  readonly name = 'resend';

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: MailMessage): Promise<void> {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      // El cuerpo del error trae el motivo real (dominio sin verificar, API key
      // vencida, destinatario inválido). Sin él, el log dice "422" y nada más.
      const body = await response.text().catch(() => '');

      throw new Error(
        `Resend respondió ${response.status}: ${body.slice(0, MAX_ERROR_BODY)}`,
      );
    }
  }
}
