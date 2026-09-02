import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Audited, AuditAction, AuditEntity } from '../../common/audit';
import {
  ApiBadGatewayResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/jwt-payload';
import {
  AppointmentPaymentsDto,
  CheckoutResponseDto,
  CreateCheckoutDto,
  PaymentResponseDto,
  RecordManualPaymentDto,
} from './dto/payment.dto';
import { PaymentsService } from './payments.service';

/**
 * Los cobros de un turno.
 *
 * **Sin `@Roles`**: registrar plata no es configurar el negocio, es trabajo de
 * mostrador, y en una peluquería chica la persona que atiende es la que cobra.
 * El control no es restringir quién puede, es que quede asentado **quién lo
 * hizo** — por eso cada pago manual guarda su `recordedBy`.
 */
@ApiTags('payments')
@ApiBearerAuth()
@Controller('appointments/:appointmentId/payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @ApiOperation({
    summary: 'Los pagos del turno y el saldo que dejan',
    description:
      'El saldo no está guardado en ningún lado: se calcula sumando los pagos ' +
      'acreditados y restando las devoluciones.',
  })
  @ApiOkResponse({ type: AppointmentPaymentsDto })
  @ApiNotFoundResponse({ description: 'El turno no existe' })
  findAll(
    @Param('appointmentId', new ParseUUIDPipe({ version: '4' }))
    appointmentId: string,
  ): Promise<AppointmentPaymentsDto> {
    return this.payments.findForAppointment(appointmentId);
  }

  @Post('checkout')
  @ApiOperation({
    summary: 'Genera el link de pago online',
    description:
      'Crea el cobro en estado pendiente y devuelve a dónde mandar al cliente. ' +
      'Pedirlo dos veces por el mismo concepto y monto devuelve el mismo link ' +
      '(`reused: true`) en vez de generar otro. El turno se confirma cuando ' +
      'llega el aviso del proveedor, no acá.',
  })
  @ApiCreatedResponse({ type: CheckoutResponseDto })
  @ApiNotFoundResponse({ description: 'El turno no existe' })
  @ApiConflictResponse({
    description: 'El turno está cancelado, o no queda nada por cobrar',
  })
  @ApiBadGatewayResponse({ description: 'El proveedor de pagos no respondió' })
  createCheckout(
    @Param('appointmentId', new ParseUUIDPipe({ version: '4' }))
    appointmentId: string,
    @Body() dto: CreateCheckoutDto,
  ): Promise<CheckoutResponseDto> {
    return this.payments.createCheckout(appointmentId, dto);
  }

  @Post('manual')
  // Plata que ningún sistema externo puede confirmar: el rastro de quién la
  // cargó es lo único que queda si después alguien la discute.
  @Audited({
    action: AuditAction.PAYMENT_RECORDED,
    entityType: AuditEntity.PAYMENT,
    // La ruta cuelga de `/appointments/:appointmentId/payments`.
    entityIdParam: 'appointmentId',
  })
  @ApiOperation({
    summary: 'Registra un pago en efectivo, transferencia o una devolución',
    description:
      'Nace acreditado: quien lo carga está viendo la plata. Queda asentado ' +
      'quién lo registró, que es el único rastro de un movimiento que ningún ' +
      'sistema externo puede confirmar.',
  })
  @ApiCreatedResponse({ type: PaymentResponseDto })
  @ApiNotFoundResponse({ description: 'El turno no existe' })
  @ApiConflictResponse({ description: 'El turno está cancelado' })
  recordManual(
    @Param('appointmentId', new ParseUUIDPipe({ version: '4' }))
    appointmentId: string,
    @Body() dto: RecordManualPaymentDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaymentResponseDto> {
    return this.payments.recordManual(appointmentId, dto, user);
  }
}
