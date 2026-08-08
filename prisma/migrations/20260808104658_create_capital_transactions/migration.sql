-- CreateTable
CREATE TABLE "Capital_Transactions" (
    "transaction_id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "amount_foreign" DECIMAL NOT NULL,
    "currency" TEXT NOT NULL,
    "transaction_date" DATETIME NOT NULL,
    "fx_rate_bot" DECIMAL NOT NULL,
    "amount_thb" DECIMAL NOT NULL,
    "type" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    CONSTRAINT "Capital_Transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Capital_Transactions_user_id_idx" ON "Capital_Transactions"("user_id");
