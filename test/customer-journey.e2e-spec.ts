import { randomUUID } from 'node:crypto';
import { AppointmentStatus } from '@prisma/client';
import request from 'supertest';
import type { SandboxPaymentProvider } from '../src/modules/payments/providers/sandbox-payment.provider';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { RecordingMailProvider } from './utils/recording-mail.provider';
import {
  auth,
  createTestApp,
  registerTenant,
  type RegisteredTenant,
  resetDatabase,
  switchPlan,
  type TestApp,
} from './utils/e2e-app';
import { aDiasDeHoy, enHorarioDe } from './utils/fechas';

/**
 * El recorrido entero, de una: **registro → primer turno → seña → atención**.
 *
 * Todo lo que hay acá ya está cubierto por tramos en otros archivos, y eso es
 * justamente lo que este test no puede hacer. Su valor no está en los pasos
 * sino en las **costuras**: que el `appointmentId` que devuelve el portal sea el
 * que acepta el checkout, que el `providerPaymentId` que el sandbox le dio al
 * link sea el que el webhook busca, que el turno que nació `PENDING_PAYMENT`
 * desde el portal sea el mismo que el panel puede pasar a `ATTENDED`. Cada
 * suite prueba su lado del empalme; ninguna prueba el empalme.
 *
 * Por eso es **un solo `it`** y no diez: partirlo en pasos independientes sería
 * volver a tener tramos. Lo que se lee acá es la historia, con las
 * verificaciones adentro.
 *
 * Los actores son dos y se distinguen por el token: el **negocio**, que manda
 * `Authorization`, y la **clienta**, que no manda nada porque no tiene cuenta.
 */

const PRECIO = 120_000;
const SEÑA = 40_000;

interface BookingBody {
  appointmentId: string;
  startsAt: string;
  status: string;
  totalPriceCents: number;
  deposit: { amountCents: number; checkoutUrl: string } | null;
}

interface Balance {
  totalPriceCents: number;
  depositAmountCents: number | null;
  paidCents: number;
  dueCents: number;
  depositCovered: boolean;
  fullyPaid: boolean;
}

interface PaymentsBody {
  balance: Balance;
  payments: { amountCents: number; recordedBy: { id: string } | null }[];
}

describe('El recorrido entero (e2e)', () => {
  let app: TestApp;
  let prisma: PrismaService;
  let mail: RecordingMailProvider;
  let sandbox: SandboxPaymentProvider;

  beforeAll(async () => {
    ({ app, prisma, mail, payments: sandbox } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    mail.clear();
    sandbox.reset();
  });

  const server = () => app.getHttpServer();

  it('un negocio se registra, se arma, publica su portal, cobra la seña de una reserva anónima y la termina de cobrar al atender', async () => {
    // ── 1. El negocio se registra ─────────────────────────────────────────
    //
    // `registerTenant` es el mismo `POST /auth/register` que usa el resto de la
    // suite: sale con negocio, dueño, suscripción en trial y tokens.
    const negocio: RegisteredTenant = await registerTenant(app, 'Estudio Nube');
    const comoDueño = () => auth(negocio.accessToken);

    // El plan del trial no incluye todo; el portal público necesita uno que sí.
    await switchPlan(prisma, negocio.tenantId, 'avanzado');

    // Y le llegó el mail de verificación, que es la única señal de que el alta
    // salió entera y no a medias.
    expect(mail.to(negocio.email)).toHaveLength(1);

    // ── 2. Se arma: sucursal, horario, servicio con seña y profesional ─────
    const sucursal = (
      await request(server())
        .post('/branches')
        .set(...comoDueño())
        .send({ name: 'Sucursal Centro', address: 'Av. Siempreviva 742' })
        .expect(201)
    ).body as { id: string };

    // Abierta todos los días: qué día de la semana cae el turno depende de
    // cuándo se corra el test, y no es lo que se está probando.
    await request(server())
      .put(`/branches/${sucursal.id}/business-hours`)
      .set(...comoDueño())
      .send({
        days: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          dayOfWeek,
          opensAt: '09:00',
          closesAt: '18:00',
        })),
      })
      .expect(200);

    const servicio = (
      await request(server())
        .post('/services')
        .set(...comoDueño())
        .send({
          name: 'Color y corte',
          durationMinutes: 60,
          priceCents: PRECIO,
          depositAmountCents: SEÑA,
        })
        .expect(201)
    ).body as { id: string };

    const invitacion = (
      await request(server())
        .post('/employees')
        .set(...comoDueño())
        .send({
          email: `${randomUUID()}@e2e.test`,
          firstName: 'Lucía',
          lastName: 'Fernández',
          role: 'PROFESSIONAL',
          branchIds: [sucursal.id],
        })
        .expect(201)
    ).body as { employee: { id: string } };

    const empleadaId = invitacion.employee.id;

    await request(server())
      .put(`/employees/${empleadaId}/schedules`)
      .set(...comoDueño())
      .send({
        shifts: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          branchId: sucursal.id,
          dayOfWeek,
          startsAt: '09:00',
          endsAt: '18:00',
        })),
      })
      .expect(200);

    // El empalme que se olvida: un servicio sin nadie que lo preste no aparece
    // en la disponibilidad, y el portal muestra una agenda vacía sin decir por
    // qué.
    await request(server())
      .put(`/services/${servicio.id}/employees`)
      .set(...comoDueño())
      .send({
        assignments: [{ employeeId: empleadaId, branchId: sucursal.id }],
      })
      .expect(200);

    // ── 3. El portal, desde afuera y sin ningún token ──────────────────────
    const { slug } = await prisma.tenant.findUniqueOrThrow({
      where: { id: negocio.tenantId },
      select: { slug: true },
    });

    const portal = (await request(server()).get(`/public/${slug}`).expect(200))
      .body as { displayName: string; timezone: string };

    // `displayName` sale del branding, que el alta crea con el nombre del
    // registro: es la costura entre `POST /auth/register` y la vidriera.
    expect(portal.displayName).toBe('Estudio Nube');
    expect(portal.timezone).toBe('America/Argentina/Buenos_Aires');

    const catalogo = (
      await request(server()).get(`/public/${slug}/services`).expect(200)
    ).body as { services: { id: string; priceCents: number }[] }[];

    // El servicio que se acaba de crear ya se ve desde afuera, con su precio.
    expect(
      catalogo.flatMap((grupo) => grupo.services).map((s) => s.id),
    ).toContain(servicio.id);

    const DIA = aDiasDeHoy(7);

    const huecos = (
      await request(server())
        .get(`/public/${slug}/availability`)
        .query({ date: DIA, branchId: sucursal.id, serviceIds: servicio.id })
        .expect(200)
    ).body as { slots: { startsAt: string }[] };

    // La costura entre el armado y la disponibilidad: si el horario de la
    // sucursal, el de la empleada o la asignación del servicio no cerraran,
    // acá no habría ningún hueco y el error diría "esperaba 0 slots".
    expect(huecos.slots.length).toBeGreaterThan(0);
    expect(huecos.slots.map((slot) => slot.startsAt)).toContain(
      enHorarioDe(DIA, '10:00'),
    );

    // ── 4. La clienta reserva ─────────────────────────────────────────────
    const reserva = (
      await request(server())
        .post(`/public/${slug}/appointments`)
        .send({
          branchId: sucursal.id,
          serviceIds: [servicio.id],
          startsAt: enHorarioDe(DIA, '10:00'),
          customer: {
            firstName: 'María',
            lastName: 'López',
            phone: '11 5555-1234',
            email: 'maria@e2e.test',
          },
        })
        .expect(201)
    ).body as BookingBody;

    // Nace esperando el pago y con el link ya hecho: la clienta no tiene que
    // volver a pedir nada para pagar.
    expect(reserva.status).toBe(AppointmentStatus.PENDING_PAYMENT);
    expect(reserva.totalPriceCents).toBe(PRECIO);
    expect(reserva.deposit).toMatchObject({ amountCents: SEÑA });
    expect(reserva.deposit?.checkoutUrl).toContain('http');

    // ── 5. Paga la seña y el proveedor avisa ──────────────────────────────
    //
    // El pago no lo confirma la respuesta del checkout sino el aviso del
    // proveedor, que llega por un endpoint público y sin sesión. Es el empalme
    // más frágil de todo el recorrido: el id que viaja acá lo generó el
    // sandbox cuando armó el link del paso anterior.
    await request(server())
      .post('/webhooks/mercadopago')
      .send({ type: 'payment', data: { id: sandbox.lastPaymentId() } })
      .expect(200);

    const trasLaSeña = (
      await request(server())
        .get(`/appointments/${reserva.appointmentId}/payments`)
        .set(...comoDueño())
        .expect(200)
    ).body as PaymentsBody;

    expect(trasLaSeña.balance).toMatchObject({
      totalPriceCents: PRECIO,
      depositAmountCents: SEÑA,
      paidCents: SEÑA,
      dueCents: PRECIO - SEÑA,
      depositCovered: true,
      fullyPaid: false,
    });

    // Lo pagó la clienta online, así que no hay nadie del negocio que lo haya
    // cargado. Es lo que distingue esta plata de la del mostrador.
    expect(trasLaSeña.payments).toHaveLength(1);
    expect(trasLaSeña.payments[0].recordedBy).toBeNull();

    // ── 6. El negocio lo ve en su agenda ──────────────────────────────────
    //
    // El turno entró por el portal, sin sesión y sin tenant en el header. Que
    // aparezca acá es lo que prueba que quedó atado al negocio correcto.
    const agenda = (
      await request(server())
        .get('/appointments')
        .query({ from: DIA, to: DIA })
        .set(...comoDueño())
        .expect(200)
    ).body as { id: string; status: string }[];

    expect(agenda.map((turno) => turno.id)).toEqual([reserva.appointmentId]);

    // Pagada la seña, el turno ya no espera plata para existir.
    expect(agenda[0].status).toBe(AppointmentStatus.CONFIRMED);

    // ── 7. La atienden y termina de pagar en el mostrador ─────────────────
    await request(server())
      .patch(`/appointments/${reserva.appointmentId}/status`)
      .set(...comoDueño())
      .send({ status: AppointmentStatus.ATTENDED })
      .expect(200);

    await request(server())
      .post(`/appointments/${reserva.appointmentId}/payments/manual`)
      .set(...comoDueño())
      .send({
        amountCents: PRECIO - SEÑA,
        paymentType: 'REMAINDER',
        paymentMethod: 'CASH',
      })
      .expect(201);

    const alCerrar = (
      await request(server())
        .get(`/appointments/${reserva.appointmentId}/payments`)
        .set(...comoDueño())
        .expect(200)
    ).body as PaymentsBody;

    expect(alCerrar.balance).toMatchObject({
      paidCents: PRECIO,
      dueCents: 0,
      fullyPaid: true,
    });

    // Dos movimientos y de distinta naturaleza: la seña la puso la clienta
    // desde el portal, el saldo lo cargó alguien del negocio. Que uno tenga
    // autor y el otro no es lo único que queda si después se discute la plata.
    expect(alCerrar.payments).toHaveLength(2);
    expect(
      alCerrar.payments.map((pago) => pago.recordedBy?.id ?? null),
    ).toEqual(expect.arrayContaining([null, negocio.userId]));

    // ── 8. Y aparece en lo cobrado del mes ────────────────────────────────
    const cobrado = (
      await request(server())
        .get('/payments')
        .query({ from: `${DIA.slice(0, 7)}-01`, to: DIA })
        .set(...comoDueño())
        .expect(200)
    ).body as { totals: { chargedCents: number; netCents: number } };

    expect(cobrado.totals).toMatchObject({
      chargedCents: PRECIO,
      netCents: PRECIO,
    });
  });
});
