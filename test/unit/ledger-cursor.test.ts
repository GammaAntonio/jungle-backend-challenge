import { expect, test } from "bun:test";
import { AppError } from "../../src/application/contracts";
import { decodeLedgerCursor } from "../../src/application/wagering";
import { assertRuntimeDatabaseConfiguration } from "../../src/infrastructure/permissions";

const cursor = (walletId: string, sequence: unknown) =>
  Buffer.from(JSON.stringify({ walletId, sequence })).toString("base64url");

test("ledger cursor accepts the opaque JSON token emitted by older versions", () => {
  const priorToken =
    "eyJ3YWxsZXRJZCI6IjUwYTRhNDgzLTliNWMtNGQ4MC04MGE3LTBmZDFkYjRlMGE1YyIsInNlcXVlbmNlIjoiMTEifQ";
  expect(
    decodeLedgerCursor(priorToken, "50a4a483-9b5c-4d80-80a7-0fd1db4e0a5c"),
  ).toBe("11");
});

test("ledger cursor accepts zero and the maximum PostgreSQL bigint sequence", () => {
  const walletId = crypto.randomUUID();
  expect(decodeLedgerCursor(cursor(walletId, "0"), walletId)).toBe("0");
  expect(
    decodeLedgerCursor(cursor(walletId, "9223372036854775807"), walletId),
  ).toBe("9223372036854775807");
});

test("ledger cursor rejects malformed types, shapes and bigint ranges as INVALID_CURSOR", () => {
  const walletId = crypto.randomUUID();
  const invalid: unknown[] = [
    undefined,
    [cursor(walletId, "8")],
    "",
    "invalid",
    "eyJ3YWxsZXRJZCI6ImEiLCJzZXF1ZW5jZSI6IjgifQ==",
    cursor(walletId, ["8"]),
    cursor(walletId, 8),
    cursor(walletId, -1),
    cursor(walletId, "-1"),
    cursor(walletId, "08"),
    cursor(walletId, "8.0"),
    cursor(walletId, "8e0"),
    cursor(walletId, "9223372036854775808"),
    cursor(crypto.randomUUID(), "8"),
    Buffer.from("null").toString("base64url"),
  ];
  for (const value of invalid) {
    try {
      decodeLedgerCursor(value, walletId);
      throw Error("EXPECTED_INVALID_CURSOR");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("INVALID_CURSOR");
      expect((error as AppError).httpStatus).toBe(400);
    }
  }
});

test("application startup rejects configured administrative database credentials", () => {
  const oldRuntime = process.env.DATABASE_URL;
  const oldAdmin = process.env.ADMIN_DATABASE_URL;
  try {
    process.env.ADMIN_DATABASE_URL = "postgres://admin:secret@127.0.0.1/db";
    process.env.DATABASE_URL = "postgres://admin:secret@127.0.0.1/db";
    expect(assertRuntimeDatabaseConfiguration).toThrow(
      "UNSAFE_RUNTIME_DATABASE_ROLE",
    );
    process.env.DATABASE_URL = "postgres://runtime:secret@127.0.0.1/db";
    expect(assertRuntimeDatabaseConfiguration).not.toThrow();
    delete process.env.ADMIN_DATABASE_URL;
    process.env.DATABASE_URL = "postgres://jungle:secret@127.0.0.1/db";
    expect(assertRuntimeDatabaseConfiguration).toThrow(
      "UNSAFE_RUNTIME_DATABASE_ROLE",
    );
  } finally {
    if (oldRuntime === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldRuntime;
    if (oldAdmin === undefined) delete process.env.ADMIN_DATABASE_URL;
    else process.env.ADMIN_DATABASE_URL = oldAdmin;
  }
});
