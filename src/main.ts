import "reflect-metadata";
import {
  Module,
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Headers,
  Res,
  Catch,
  ArgumentsHost,
  ExceptionFilter,
  HttpException,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Response, Request, NextFunction } from "express";
import { z, ZodError } from "zod";
import { WageringService } from "./application/wagering";
import { AppError } from "./application/contracts";
import { DomainError } from "./domain/model";
import { connectRuntime, db } from "./infrastructure/db";
import { assertRuntimeDatabaseConfiguration } from "./infrastructure/permissions";

import { collectMetrics, readiness } from "./infrastructure/metrics";
import {
  setMetricRole,
  DevelopmentProviderIdentity,
  log,
} from "./application/observability";
import {
  resolveCorrelationId,
  withCorrelation,
} from "./application/correlation";
setMetricRole("api");
const service = new WageringService();
const identity = new DevelopmentProviderIdentity();
const id = (v: string) => z.uuid().parse(v);
@Catch()
class Errors implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let status = 503,
      code = "INFRASTRUCTURE_UNAVAILABLE";
    if (e instanceof AppError) {
      status = e.httpStatus;
      code = e.code;
    } else if (e instanceof ZodError || e instanceof DomainError) {
      status = 400;
      code = e instanceof DomainError ? e.code : "INVALID_REQUEST";
    } else if (e instanceof HttpException) {
      status = e.getStatus();
      code = status === 404 ? "NOT_FOUND" : "INVALID_REQUEST";
    } else {
      log("request_failure", {
        errorType: e instanceof Error ? e.constructor.name : "Unknown",
      });
    }
    res.status(status).json({ code });
  }
}
@Controller()
class Api {
  @Post("wallets") open(@Body() body: unknown) {
    return service.open(body);
  }
  @Get("wallets/:walletId") wallet(@Param("walletId") walletId: string) {
    return service.wallet(id(walletId));
  }
  @Get("wallets/:walletId/ledger") ledger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor?: unknown,
    @Query("limit") limit?: string,
  ) {
    return service.ledgerPage(
      id(walletId),
      cursor,
      limit === undefined ? 50 : Number(limit),
    );
  }
  @Post("wallets/:walletId/reconciliation") reconcile(
    @Param("walletId") walletId: string,
  ) {
    return service.reconcile(id(walletId));
  }
  @Get("wagering/transactions/:transactionId") transaction(
    @Param("transactionId") transactionId: string,
  ) {
    return service.transaction(id(transactionId));
  }
  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  external(
    @Param("providerId") provider: string,
    @Param("externalTransactionId") external: string,
  ) {
    return service.byExternal(provider, external);
  }
  @Post("wagering/transactions") async submit(
    @Body() body: unknown,
    @Headers("idempotency-key") key: string,
    @Headers("x-correlation-id") correlationId: string,
    @Res() res: Response,
  ) {
    if (
      !(await identity.authorize(
        (body as { providerId?: string })?.providerId ?? "",
      ))
    )
      throw new AppError("FORBIDDEN", 403);
    const r = await service.submit(body, key, { correlationId });
    return res
      .status(
        r.status === "REJECTED"
          ? 422
          : r.status === "PENDING_REFERENCE"
            ? 202
            : 200,
      )
      .json(r);
  }
  @Get("health/live") live() {
    return { status: "ok" };
  }
  @Get("health/ready") async ready() {
    await readiness();
    return { status: "ready" };
  }
  @Get("metrics") async counters() {
    return collectMetrics();
  }
}
@Module({ controllers: [Api] })
class AppModule {}
assertRuntimeDatabaseConfiguration();
await connectRuntime();
const app = await NestFactory.create(AppModule, { logger: false });
app.use((req: Request, res: Response, next: NextFunction) => {
  const correlationId = resolveCorrelationId(req.headers["x-correlation-id"]);
  req.headers["x-correlation-id"] = correlationId;
  res.setHeader("x-correlation-id", correlationId);
  withCorrelation(correlationId, () => {
    res.once("finish", () =>
      log("http_request", {
        correlationId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
      }),
    );
    next();
  });
});
app.useGlobalFilters(new Errors());
app.enableShutdownHooks();
await app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
log("http_listening", { port: app.getHttpServer().address().port });
process.on("SIGTERM", () => {
  void db.destroy();
});
