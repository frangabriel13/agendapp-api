import { Controller, Get, Query } from '@nestjs/common';
import { EmployeeRole } from '@prisma/client';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  MAX_RECEIVABLES_RANGE_DAYS,
  PaymentReceivablesQueryDto,
  PaymentReceivablesResponseDto,
} from './dto/payment-receivables.dto';
import {
  PaymentRangeQueryDto,
  PaymentRangeResponseDto,
} from './dto/payment-range.dto';
import { PaymentsService } from './payments.service';

/**
 * Los cobros del negocio por rango de fechas.
 *
 * **Controller aparte y no un método más de `PaymentsController`**: ese cuelga
 * de `appointments/:appointmentId/payments` y esto no es de un turno, es de
 * todos. Y porque los dos no responden la misma pregunta ni piden lo mismo.
 *
 * **Con `@Roles`, al revés que `PaymentsController`.** La asimetría es
 * deliberada y conviene entenderla: registrar un cobro es trabajo de mostrador
 * —de a un turno, con el cliente delante— y por eso ese endpoint está abierto a
 * cualquier empleado. Leer toda la plata del negocio de un mes es otra cosa, y
 * el repo ya trata así esa clase de lectura (`GET /tenants/me/subscription`).
 *
 * La consecuencia, que está anotada en el contrato del front: un
 * `PROFESSIONAL` puede seguir viendo lo cobrado **de a un turno** por el otro
 * endpoint, y no el total del mes. Visto de afuera parece un agujero; es el
 * mismo criterio aplicado dos veces.
 *
 * Solo trae cobros de turnos. Los de la suscripción del negocio son otra tabla
 * y viven en `GET /tenants/me/subscription`.
 */
@ApiTags('payments')
@ApiBearerAuth()
@Roles(EmployeeRole.OWNER, EmployeeRole.ADMINISTRATIVE)
@Controller('payments')
export class PaymentReportsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @ApiOperation({
    summary: 'Cobros acreditados en un rango, con los totales del rango',
    description:
      'Filtra por **cuándo entró la plata** (`paidAt`), no por cuándo se creó ' +
      'la fila. Los días son días del calendario **del negocio**: un cobro de ' +
      'las 21:30 en Buenos Aires cuenta para ese día y no para el siguiente.\n\n' +
      '**Devuelve plata liquidada, no el estado de cobranza del mes.** Un ' +
      'cobro pendiente o fallado no tiene fecha de acreditación y por lo tanto ' +
      'no puede aparecer; pedirlos con `status=PENDING` es un 400, no una ' +
      'lista vacía. Lo que falta cobrar de un turno sale de su saldo.\n\n' +
      '`totals` es del **rango entero**, no de la página: paginar no lo mueve.',
  })
  @ApiOkResponse({ type: PaymentRangeResponseDto })
  @ApiBadRequestResponse({
    description:
      'Fechas mal formadas, rango invertido, o un `status` que no puede ' +
      'estar acreditado.',
  })
  @ApiForbiddenResponse({
    description: 'Un `PROFESSIONAL` no ve la plata del negocio.',
  })
  findByRange(
    @Query() query: PaymentRangeQueryDto,
  ): Promise<PaymentRangeResponseDto> {
    return this.payments.findByRange(query);
  }

  @Get('receivables')
  @ApiOperation({
    summary: 'Lo que falta cobrar de un rango, con los totales del rango',
    description:
      'La otra mitad de `GET /payments`, y **filtra por otra fecha**: por la ' +
      'del **turno**, no por la de un cobro. Una deuda no tiene fecha propia ' +
      '—si tuviera fecha de acreditación ya no sería una deuda—, así que la ' +
      'única fecha que existe es la del turno que la generó.\n\n' +
      'Trae **solo los turnos que deben algo**: los que están al día no ' +
      'aparecen, y por eso `meta.total` cuenta turnos con deuda y no turnos ' +
      'del rango.\n\n' +
      'Quedan afuera los cancelados y los reprogramados: un turno que no pasó ' +
      'no genera deuda, y en el reprogramado la deuda se mudó al turno nuevo ' +
      '—contar los dos la duplicaría—. Si el negocio cobra multa por cancelar, ' +
      'eso se registra como cobro y sale por el otro endpoint.\n\n' +
      `El rango no puede pasar de ${MAX_RECEIVABLES_RANGE_DAYS} días.`,
  })
  @ApiOkResponse({ type: PaymentReceivablesResponseDto })
  @ApiBadRequestResponse({
    description: 'Fechas mal formadas, rango invertido o demasiado largo.',
  })
  @ApiForbiddenResponse({
    description: 'Un `PROFESSIONAL` no ve la plata del negocio.',
  })
  findReceivables(
    @Query() query: PaymentReceivablesQueryDto,
  ): Promise<PaymentReceivablesResponseDto> {
    return this.payments.findReceivables(query);
  }
}
