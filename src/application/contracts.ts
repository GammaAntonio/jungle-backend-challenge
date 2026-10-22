import { createHash } from "node:crypto";
import { z } from "zod";
import { Money } from "../domain/model";
const text = z.string().min(1).max(200);
export const moneySchema = z
  .object({ amount: z.string(), currency: z.string() })
  .strict()
  .superRefine((v, c) => {
    try {
      Money.from(v);
    } catch {
      c.addIssue({ code: "custom", message: "INVALID_MONEY" });
    }
  });
export const requestSchema = z
  .object({
    providerId: text,
    externalTransactionId: text,
    playerId: z.uuid(),
    walletId: z.uuid(),
    roundId: text,
    gameId: text,
    kind: z.enum(["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"]),
    money: moneySchema,
    referenceExternalTransactionId: text.optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      ["REFUND", "ROLLBACK"].includes(v.kind) &&
      !v.referenceExternalTransactionId
    )
      c.addIssue({ code: "custom", message: "REFERENCE_REQUIRED" });
    if (v.kind !== "LOSS" && Money.from(v.money).isZero())
      c.addIssue({ code: "custom", message: "AMOUNT_MUST_BE_POSITIVE" });
  });
export type Request = z.infer<typeof requestSchema>;
export const openingSchema = z
  .object({ playerId: z.uuid(), initialBalance: moneySchema })
  .strict();
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.entries(v)
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
    .join(",")}}`;
}
export function payloadHash(v: unknown) {
  return createHash("sha256").update(canonical(v)).digest("hex");
}
export function key(value: unknown): string {
  return text.parse(value);
}
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
  ) {
    super(code);
  }
}
