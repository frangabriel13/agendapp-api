import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantContextMissingError } from '../../common/errors/tenant-context-missing.error';
import { TenantContextService } from '../../common/tenant-context';
import { dateToTimeOfDayOrNull } from '../../common/utils/time-of-day.util';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  PublicBranchDto,
  PublicServiceGroupDto,
} from './dto/public-catalog.dto';
import type { PublicBusinessDto } from './dto/public-portal.dto';

/** El nombre del grupo donde caen los servicios sin categoría. */
const UNCATEGORIZED = 'Otros';

const BRANCH_SELECT = {
  id: true,
  name: true,
  address: true,
  phone: true,
  businessHours: {
    select: {
      dayOfWeek: true,
      isClosed: true,
      opensAt: true,
      closesAt: true,
    },
    orderBy: { dayOfWeek: 'asc' },
  },
} satisfies Prisma.BranchSelect;

const SERVICE_SELECT = {
  id: true,
  name: true,
  description: true,
  durationMinutes: true,
  priceCents: true,
  depositAmountCents: true,
  color: true,
  category: { select: { id: true, name: true, displayOrder: true } },
} satisfies Prisma.ServiceSelect;

type ServiceRow = Prisma.ServiceGetPayload<{ select: typeof SERVICE_SELECT }>;

/**
 * Lo que el portal público muestra de un negocio.
 *
 * **Todo entra por `PublicTenantGuard`**, que ya resolvió el negocio por el
 * `:slug` y lo montó en el contexto. Por eso acá se usa `prisma.scoped` igual
 * que en el panel: el aislamiento entre negocios es el mismo de siempre, y no
 * hay una segunda forma de filtrar por tenant que pueda salir mal.
 *
 * La regla que atraviesa el archivo: **acá solo sale lo que el negocio ya
 * publica en su vidriera.** Nada de plan, suscripción, empleados, notas de
 * clientes ni fechas internas. Cuando dudes, no lo pongas: agregarlo después es
 * un cambio aditivo, sacarlo es romper el contrato.
 */
@Injectable()
export class PublicService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async findBusiness(): Promise<PublicBusinessDto> {
    const tenantId = this.requireTenantId();

    const tenant = await this.prisma.scoped.tenant.findFirst({
      where: { id: tenantId },
      select: {
        slug: true,
        businessName: true,
        timezone: true,
        currency: true,
        language: true,
        branding: {
          select: {
            displayName: true,
            description: true,
            logoUrl: true,
            primaryColor: true,
          },
        },
        settings: {
          select: {
            publicBookingEnabled: true,
            minBookingNoticeMinutes: true,
            maxBookingDaysAhead: true,
            cancellationPolicyHours: true,
          },
        },
      },
    });

    if (!tenant) {
      throw new NotFoundException('No encontramos ese negocio');
    }

    const { branding, settings } = tenant;

    return {
      slug: tenant.slug,
      // El branding y los settings se crean junto con el negocio en el
      // registro, así que faltar es data corrupta. El portal igual no se cae
      // por eso: cae al nombre del registro y a los defaults del schema.
      displayName: branding?.displayName ?? tenant.businessName,
      description: branding?.description ?? null,
      logoUrl: branding?.logoUrl ?? null,
      primaryColor: branding?.primaryColor ?? null,
      timezone: tenant.timezone,
      currency: tenant.currency,
      language: tenant.language,
      booking: {
        enabled: settings?.publicBookingEnabled ?? true,
        minNoticeMinutes: settings?.minBookingNoticeMinutes ?? 0,
        maxDaysAhead: settings?.maxBookingDaysAhead ?? 0,
        // Constante y no un setting: `requireDepositForBooking` gobierna el
        // mostrador, donde la clienta está enfrente. Acá se cobra siempre que
        // el servicio tenga seña.
        depositRequired: true,
        cancellationPolicyHours: settings?.cancellationPolicyHours ?? 0,
      },
    };
  }

  /** Solo las activas: una sucursal cerrada no es una opción para nadie. */
  async findBranches(): Promise<PublicBranchDto[]> {
    const branches = await this.prisma.scoped.branch.findMany({
      where: { isActive: true },
      select: BRANCH_SELECT,
      orderBy: { name: 'asc' },
    });

    return branches.map((branch) => ({
      id: branch.id,
      name: branch.name,
      address: branch.address,
      phone: branch.phone,
      businessHours: branch.businessHours.map((hour) => ({
        dayOfWeek: hour.dayOfWeek,
        isClosed: hour.isClosed,
        opensAt: dateToTimeOfDayOrNull(hour.opensAt),
        closesAt: dateToTimeOfDayOrNull(hour.closesAt),
      })),
    }));
  }

  /**
   * Los servicios reservables, agrupados por categoría.
   *
   * **Las dos condiciones son necesarias y distintas.** `isActive` es "existe";
   * `publiclyBookable` es "un desconocido lo puede elegir solo". Un retoque de
   * garantía está activo y no va acá.
   */
  async findServices(): Promise<PublicServiceGroupDto[]> {
    const services = await this.prisma.scoped.service.findMany({
      where: { isActive: true, publiclyBookable: true },
      select: SERVICE_SELECT,
      orderBy: { name: 'asc' },
    });

    return groupByCategory(services);
  }

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();

    if (!tenantId) {
      // Inalcanzable pasando por `PublicTenantGuard`. Si aparece, es que
      // alguien montó una ruta del portal sin `@PublicTenant()`.
      throw new TenantContextMissingError('Tenant', 'read public portal');
    }

    return tenantId;
  }
}

/**
 * Arma los grupos respetando el `displayOrder` de las categorías.
 *
 * Los sin categoría van al final en un grupo con `id: null`. **No se los
 * esconde**: un servicio sin categorizar es un descuido de carga, y sacarlo del
 * portal convertiría ese descuido en plata que no entra.
 */
function groupByCategory(services: ServiceRow[]): PublicServiceGroupDto[] {
  const groups = new Map<
    string,
    { id: string | null; name: string; order: number; services: ServiceRow[] }
  >();

  for (const service of services) {
    const key = service.category?.id ?? '';
    const group = groups.get(key);

    if (group) {
      group.services.push(service);
      continue;
    }

    groups.set(key, {
      id: service.category?.id ?? null,
      name: service.category?.name ?? UNCATEGORIZED,
      // `Infinity` empuja a los sin categoría al final sin necesidad de un
      // segundo criterio de orden.
      order: service.category?.displayOrder ?? Number.POSITIVE_INFINITY,
      services: [service],
    });
  }

  return [...groups.values()]
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .map((group) => ({
      id: group.id,
      name: group.name,
      services: group.services.map((service) => ({
        id: service.id,
        name: service.name,
        description: service.description,
        durationMinutes: service.durationMinutes,
        priceCents: service.priceCents,
        depositAmountCents: service.depositAmountCents,
        color: service.color,
      })),
    }));
}
