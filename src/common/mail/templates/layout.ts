/**
 * El molde de todos los mails transaccionales.
 *
 * Dos reglas que parecen manías y no lo son:
 *
 * 1. **Los estilos van inline.** Gmail borra los `<style>` del `<head>`, así que
 *    una hoja de estilos linda se ve como texto pelado en la bandeja de la
 *    mitad de la gente.
 * 2. **Todo valor que venga de la base se escapa.** Un negocio que se llame
 *    `Peluquería <b>Ana</b>` no puede reescribir el HTML del mail.
 *
 * Cada mail se arma una sola vez como `MailContent` y de ahí salen las dos
 * versiones (HTML y texto). Escribirlas por separado garantiza que en algún
 * momento digan cosas distintas.
 */

export interface MailAction {
  label: string;
  url: string;
}

export interface MailContent {
  /** El asunto, y también el `<title>` del documento. */
  subject: string;
  /**
   * La línea que la bandeja de entrada muestra al lado del asunto. Sin esto,
   * los clientes agarran el primer texto que encuentran, que suele ser el
   * saludo — la misma frase en todos los mails.
   */
  preview: string;
  heading: string;
  /** Párrafos del cuerpo, en orden. Se escapan al renderizar. */
  paragraphs: string[];
  action?: MailAction;
  /** Renglones del pie, más chicos y en gris. Típicamente el "si no fuiste vos". */
  footer: string[];
}

const BRAND = 'AgendApp';

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderHtml(content: MailContent): string {
  const paragraphs = content.paragraphs
    .map(
      (text) =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#3f3f46;">${escapeHtml(text)}</p>`,
    )
    .join('');

  const action = content.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
            <tr><td style="border-radius:8px;background:#18181b;">
              <a href="${escapeHtml(content.action.url)}" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(content.action.label)}</a>
            </td></tr>
          </table>
          <p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#71717a;">
            Si el botón no funciona, copiá y pegá este link en el navegador:<br />
            <span style="word-break:break-all;color:#3f3f46;">${escapeHtml(content.action.url)}</span>
          </p>`
    : '';

  const footer = content.footer
    .map(
      (text) =>
        `<p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#71717a;">${escapeHtml(text)}</p>`,
    )
    .join('');

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(content.subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#fafafa;">
    <!-- El preview text: visible para la bandeja, invisible al abrir el mail. -->
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(content.preview)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;">
            <tr>
              <td style="padding:32px;font-family:${FONT};">
                <p style="margin:0 0 24px;font-size:15px;font-weight:700;color:#18181b;letter-spacing:-0.01em;">${BRAND}</p>
                <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;font-weight:600;color:#18181b;">${escapeHtml(content.heading)}</h1>
                ${paragraphs}
                ${action}
                <hr style="margin:24px 0;border:none;border-top:1px solid #e4e4e7;" />
                ${footer}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function renderText(content: MailContent): string {
  const blocks = [content.heading, '', ...content.paragraphs];

  if (content.action) {
    blocks.push('', `${content.action.label}: ${content.action.url}`);
  }

  blocks.push('', '—', ...content.footer);

  return blocks.join('\n');
}
