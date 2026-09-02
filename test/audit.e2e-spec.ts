import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { PrismaService } from '../src/prisma/prisma.service';
import {
  auth,
  createTestApp,
  registerTenant,
  resetDatabase,
  switchPlan,
  TEST_PASSWORD,
  type RegisteredTenant,
  type TestApp,
} from './utils/e2e-app';

interface AuditRow {
  id: string;
  user: { id: string; email: string } | null;
  action: string;
  entityType: string;
  entityId: string | null;
  changes: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

interface PaginatedAudit {
  data: AuditRow[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

/**
 * Lo que la auditoría **no** puede hacer se prueba mirando la tabla cruda, no
 * el endpoint: el endpoint podría estar escondiendo lo que la columna guarda.
 */
async function rawChanges(prisma: PrismaService): Promise<string> {
  const rows = await prisma.auditLog.findMany({ select: { changes: true } });

  return JSON.stringify(rows);
}

describe('Auditoría (e2e)', () => {
  let app: TestApp;
  let prisma: PrismaService;
  let tenant: RegisteredTenant;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  const asOwner = () => auth(tenant.accessToken);

  const logs = (token: string, query: Record<string, string> = {}) =>
    request(server())
      .get('/audit-logs')
      .set(...auth(token))
      .query(query);

  beforeEach(async () => {
    await resetDatabase(prisma);
    tenant = await registerTenant(app, 'Peluquería Ana');
    await switchPlan(prisma, tenant.tenantId, 'avanzado');
  });

  // ── Lo que se registra ────────────────────────────────────────────────────

  it('un login queda registrado con quién y desde dónde', async () => {
    await request(server())
      .post('/auth/login')
      .send({ email: tenant.email, password: TEST_PASSWORD })
      .expect(200);

    const response = await logs(tenant.accessToken, {
      action: 'login',
    }).expect(200);

    const [row] = (response.body as PaginatedAudit).data;

    expect(row.action).toBe('login');
    expect(row.entityType).toBe('session');
    expect(row.user?.email).toBe(tenant.email);
    expect(row.ipAddress).not.toBeNull();
  });

  /**
   * ⚠️ El test por el que existe `redactSecrets`. Si esto falla, la base tiene
   * contraseñas en texto plano y el bug es de seguridad, no de auditoría.
   */
  it('la contraseña NO llega a la base', async () => {
    await request(server())
      .post('/auth/login')
      .send({ email: tenant.email, password: TEST_PASSWORD })
      .expect(200);

    const stored = await rawChanges(prisma);

    expect(stored).not.toContain(TEST_PASSWORD);
    expect(stored).toContain('[censurado]');
    // El email sí: es lo que identifica el intento y no es un secreto.
    expect(stored).toContain(tenant.email);
  });

  /**
   * El único caso donde el fracaso es el evento. Sin sesión no hay `userId`,
   * y por eso la columna es nullable.
   */
  it('un login fallido queda registrado, sin usuario', async () => {
    await request(server())
      .post('/auth/login')
      .send({ email: tenant.email, password: 'noEsLaClave123' })
      .expect(401);

    const rows = await prisma.auditLog.findMany({
      where: { action: 'login_failed' },
      select: { userId: true, tenantId: true, changes: true },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBeNull();
    expect(rows[0].tenantId).toBeNull();
    expect(JSON.stringify(rows[0].changes)).not.toContain('noEsLaClave123');
  });

  it('invitar a alguien registra a quién se invitó', async () => {
    const invitation = await request(server())
      .post('/employees')
      .set(...asOwner())
      .send({
        email: `${randomUUID()}@e2e.test`,
        firstName: 'Lucía',
        lastName: 'Fernández',
        role: 'PROFESSIONAL',
      })
      .expect(201);

    const employeeId = (invitation.body as { employee: { id: string } })
      .employee.id;

    const response = await logs(tenant.accessToken, {
      entityType: 'employee',
      entityId: employeeId,
    }).expect(200);

    const [row] = (response.body as PaginatedAudit).data;

    expect(row.action).toBe('created');
    // Sin `entityIdFrom` esto sería `null`: la respuesta trae la entidad
    // adentro de `employee`, no pelada.
    expect(row.entityId).toBe(employeeId);
    expect(row.changes).toMatchObject({ role: 'PROFESSIONAL' });
  });

  it('un cambio de rol deja el rol nuevo escrito', async () => {
    const invitation = await request(server())
      .post('/employees')
      .set(...asOwner())
      .send({
        email: `${randomUUID()}@e2e.test`,
        firstName: 'Ana',
        lastName: 'Pérez',
        role: 'PROFESSIONAL',
      })
      .expect(201);

    const employeeId = (invitation.body as { employee: { id: string } })
      .employee.id;

    await request(server())
      .patch(`/employees/${employeeId}`)
      .set(...asOwner())
      .send({ role: 'ADMINISTRATIVE' })
      .expect(200);

    const response = await logs(tenant.accessToken, {
      action: 'updated',
      entityType: 'employee',
    }).expect(200);

    expect((response.body as PaginatedAudit).data[0].changes).toEqual({
      role: 'ADMINISTRATIVE',
    });
  });

  /** Las lecturas no se auditan: para eso están los logs de acceso. */
  it('mirar no deja rastro', async () => {
    await request(server())
      .get('/employees')
      .set(...asOwner())
      .expect(200);

    expect(await prisma.auditLog.count()).toBe(0);
  });

  // ── Quién puede leerla ────────────────────────────────────────────────────

  it('un profesional no puede leer la auditoría', async () => {
    const email = `${randomUUID()}@e2e.test`;

    const invitation = await request(server())
      .post('/employees')
      .set(...asOwner())
      .send({
        email,
        firstName: 'Lucía',
        lastName: 'Fernández',
        role: 'PROFESSIONAL',
      })
      .expect(201);

    const { activationUrl } = invitation.body as { activationUrl: string };

    await request(server())
      .post('/employees/activate')
      .send({
        token: new URL(activationUrl).searchParams.get('token'),
        password: 'claveNueva123',
      })
      .expect(204);

    const login = await request(server())
      .post('/auth/login')
      .send({ email, password: 'claveNueva123' })
      .expect(200);

    await logs((login.body as { accessToken: string }).accessToken).expect(403);
  });

  /**
   * ⚠️ `AuditLog` está en `TENANT_EXEMPT_MODELS`, así que **no hay extension
   * que filtre**: el `tenantId` lo pone `AuditLogsService.scopeOf()` a mano.
   * Es la línea más peligrosa del módulo y este es el test que la sostiene.
   */
  it('un negocio no ve la auditoría del otro', async () => {
    await request(server())
      .post('/employees')
      .set(...asOwner())
      .send({
        email: `${randomUUID()}@e2e.test`,
        firstName: 'Lucía',
        lastName: 'Fernández',
        role: 'PROFESSIONAL',
      })
      .expect(201);

    const otro = await registerTenant(app, 'Peluquería Beto');
    const response = await logs(otro.accessToken).expect(200);

    expect((response.body as PaginatedAudit).meta.total).toBe(0);
    // Y del otro lado sí está, para que el 0 signifique algo.
    expect(
      ((await logs(tenant.accessToken).expect(200)).body as PaginatedAudit).meta
        .total,
    ).toBeGreaterThan(0);
  });

  // ── Filtros ───────────────────────────────────────────────────────────────

  it('filtra por persona', async () => {
    await request(server())
      .post('/auth/login')
      .send({ email: tenant.email, password: TEST_PASSWORD })
      .expect(200);

    const mios = await logs(tenant.accessToken, {
      userId: tenant.userId,
    }).expect(200);

    expect((mios.body as PaginatedAudit).meta.total).toBeGreaterThan(0);

    const deOtro = await logs(tenant.accessToken, {
      userId: randomUUID(),
    }).expect(200);

    expect((deOtro.body as PaginatedAudit).meta.total).toBe(0);
  });

  it('el rango va con las dos puntas', async () => {
    await logs(tenant.accessToken, { from: '2026-09-01' }).expect(400);
  });

  it('un rango invertido es 400', async () => {
    await logs(tenant.accessToken, {
      from: '2026-09-30',
      to: '2026-09-01',
    }).expect(400);
  });

  /** La tabla no se borra nunca: sin tope, una consulta barrería años. */
  it('un rango de más de 92 días es 400', async () => {
    await logs(tenant.accessToken, {
      from: '2026-01-01',
      to: '2026-12-31',
    }).expect(400);
  });

  it('un rango que incluye hoy trae lo de hoy', async () => {
    await request(server())
      .post('/auth/login')
      .send({ email: tenant.email, password: TEST_PASSWORD })
      .expect(200);

    const hoy = new Date().toISOString().slice(0, 10);
    const response = await logs(tenant.accessToken, {
      from: hoy,
      to: hoy,
    }).expect(200);

    expect((response.body as PaginatedAudit).meta.total).toBeGreaterThan(0);
  });
});
