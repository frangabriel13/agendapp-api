import { renderHtml, renderText } from './layout';
import {
  employeeInvitationMail,
  humanizeExpiry,
  passwordResetMail,
} from './transactional';

const MS_PER_HOUR = 60 * 60 * 1000;

const NOW = new Date('2026-08-20T12:00:00.000Z');
const inHours = (hours: number): Date =>
  new Date(NOW.getTime() + hours * MS_PER_HOUR);

describe('humanizeExpiry', () => {
  it('una hora', () => {
    expect(humanizeExpiry(inHours(1), NOW)).toBe('en 1 hora');
  });

  it('varias horas', () => {
    expect(humanizeExpiry(inHours(6), NOW)).toBe('en 6 horas');
  });

  it('redondea hacia arriba', () => {
    expect(humanizeExpiry(inHours(2.1), NOW)).toBe('en 3 horas');
  });

  it('pasa a días a partir de las 24', () => {
    expect(humanizeExpiry(inHours(24), NOW)).toBe('en 1 día');
    expect(humanizeExpiry(inHours(72), NOW)).toBe('en 3 días');
  });

  /**
   * Nunca "en 0 horas" ni un negativo. Un token vencido no debería llegar a
   * renderizarse, pero si pasa, el mail tiene que seguir siendo legible.
   */
  it('nunca baja de una hora', () => {
    expect(humanizeExpiry(inHours(-5), NOW)).toBe('en 1 hora');
  });
});

describe('render', () => {
  const url = 'https://app.test/restablecer?token=abc.def';

  it('el link aparece en el HTML y en el texto', () => {
    const content = passwordResetMail({
      firstName: 'Ana',
      url,
      expiresAt: inHours(1),
    });

    expect(renderHtml(content)).toContain(url);
    // En texto plano también: es de donde `LogMailProvider` saca los links, y
    // es lo único que ve quien tiene el cliente de mail sin HTML.
    expect(renderText(content)).toContain(url);
  });

  /**
   * Un negocio puede llamarse como quiera, y ese nombre entra al HTML del mail.
   * Sin escapar, `<img onerror=...>` en el nombre del negocio se convierte en
   * HTML ejecutable dentro de la casilla de otra persona.
   */
  it('escapa lo que viene de la base', () => {
    const html = renderHtml(
      employeeInvitationMail({
        firstName: 'Ana',
        businessName: '<script>alert(1)</script>',
        url,
        expiresAt: inHours(72),
      }),
    );

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('el asunto de la invitación nombra al negocio', () => {
    const content = employeeInvitationMail({
      firstName: 'Ana',
      businessName: 'Peluquería Ana',
      url,
      expiresAt: inHours(72),
    });

    expect(content.subject).toBe('Peluquería Ana te invitó a su equipo');
  });
});
