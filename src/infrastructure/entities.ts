import { EntitySchema } from "typeorm";
export interface WalletRecord {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}
export const walletEntity = new EntitySchema<WalletRecord>({
  name: "WalletRecord",
  tableName: "wallet",
  columns: {
    id: { type: "uuid", primary: true },
    player_id: { type: "uuid" },
    currency: { type: "text" },
    balance: { type: "numeric", precision: 18, scale: 2 },
    version: { type: "integer" },
    created_at: { type: "timestamptz" },
    updated_at: { type: "timestamptz" },
  },
  uniques: [{ columns: ["player_id", "currency"] }],
});
