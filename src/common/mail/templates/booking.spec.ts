import {
  bookingConfirmationMail,
  bookingNoticeMail,
  formatMoney,
  formatWhen,
} from './booking';
import { renderHtml, renderText } from './layout';

const APPOINTMENT = {
  businessName: 'Peluquería Ana',
  startsAt: new Date('2026-09-07T17:30:00.000Z'),
  timezone: 'America/Argentina/Buenos_Aires',
  serviceNames: ['Corte de dama', 'Color'],
  employeeName: 'Lucía Fernández',
  branchName: 'Sucursal Centro',
  branchAddress: 'Av. Corrientes 1234',
};

describe('formatWhen', () => {
  /**
   * El test que justifica que la zona sea un parámetro obligatorio: el mismo
   * instante son las 14:30 en Buenos Aires y las 19:30 en Madrid. Formatearlo
   * con la zona del servidor le diría a una clienta que venga cinco horas
   * tarde.
   */
  it('usa la zona del negocio y no la del proceso', () => {
    expect(formatWhen(APPOINTMENT.startsAt, APPOINTMENT.timezone)).toContain(
      '14:30',
    );

    expect(formatWhen(APPOINTMENT.startsAt, 'Europe/Madrid')).toContain(
      '19:30',
    );
  });

  it('trae el día en palabras, que es lo que la gente lee', () => {
    expect(formatWhen(APPOINTMENT.startsAt, APPOINTMENT.timezone)).toContain(
      'lunes',
    );
  });
});

describe('formatMoney', () => {
  it('los centavos son centavos', () => {
    expect(formatMoney(1_250_000, 'ARS')).toContain('12.500');
  });
});

describe('bookingConfirmationMail', () => {
  const base = {
    firstName: 'María',
    appointment: APPOINTMENT,
    businessPhone: '+54 11 4444-5555',
  };

  it('sin seña dice que el turno está confirmado y no ofrece pagar', () => {
    const mail = bookingConfirmationMail(base);

    expect(mail.subject).toContain('confirmado');
    expect(mail.action).toBeUndefined();
    expect(renderText(mail)).toContain('Sucursal Centro');
  });

  /**
   * La diferencia que hace a este mail: **con seña el turno todavía no está**.
   * Si el asunto o el cuerpo dijeran "confirmado", la mitad de la gente no
   * pagaría y perdería el turno creyendo que lo tenía.
   */
  it('con seña avisa que falta pagar y lleva el link', () => {
    const mail = bookingConfirmationMail({
      ...base,
      deposit: {
        amountCents: 300_000,
        currency: 'ARS',
        url: 'https://pago.example/abc',
      },
    });

    expect(mail.subject).toContain('seña');
    expect(mail.subject).not.toContain('confirmado');
    expect(mail.heading).not.toContain('confirmado');
    expect(mail.action?.url).toBe('https://pago.example/abc');
    expect(renderText(mail)).toContain('3.000');
  });

  it('sin dirección de sucursal no escribe un paréntesis vacío', () => {
    const mail = bookingConfirmationMail({
      ...base,
      appointment: { ...APPOINTMENT, branchAddress: null },
    });

    expect(renderText(mail)).not.toContain('()');
  });

  it('sin teléfono del negocio no inventa uno', () => {
    const mail = bookingConfirmationMail({ ...base, businessPhone: null });

    expect(mail.footer.join(' ')).toContain('avisale a Peluquería Ana');
    expect(mail.footer.join(' ')).not.toContain('null');
  });
});

describe('bookingNoticeMail', () => {
  const base = {
    appointment: APPOINTMENT,
    customerName: 'María González',
    customerPhone: '+54 9 11 5555-1234',
    awaitingDeposit: true,
  };

  /** El teléfono es el motivo por el que el negocio abre este mail. */
  it('trae el teléfono de quien reservó', () => {
    expect(renderText(bookingNoticeMail(base))).toContain('5555-1234');
  });

  it('distingue el que ya está confirmado del que espera la seña', () => {
    expect(renderText(bookingNoticeMail(base))).toContain('Todavía no pagó');

    expect(
      renderText(bookingNoticeMail({ ...base, awaitingDeposit: false })),
    ).toContain('ya está confirmado');
  });

  /** El nombre del negocio entra al HTML del mail: no puede reescribirlo. */
  it('escapa lo que viene de la base', () => {
    const mail = bookingNoticeMail({
      ...base,
      customerName: 'María <script>alert(1)</script>',
    });

    expect(renderHtml(mail)).not.toContain('<script>');
    expect(renderHtml(mail)).toContain('&lt;script&gt;');
  });
});
