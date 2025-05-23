import { db } from "@/lib/db";
import { z } from "zod";
import { transactionSchema, type TransactionFormData } from "@/schemas/transaction-schema";
import {
  generateEncryptionKey,
  decryptString,
} from "@/lib/encryption";
import { selectLotsForSale, CostBasisMethod, type AvailableLot, type SelectedLot, type SaleResult } from "@/lib/cost-basis";
import type { Lot, User, BitcoinTransaction } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { getDailyBtcUsdPrice } from '../price';
import type { SaleResult as SaleResultType } from '../cost-basis';

// Custom error for request-related issues (validation, etc.)
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

// Custom error for lot selection issues
export class LotSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LotSelectionError";
  }
}

// Custom error for database operations
export class DatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseError";
  }
}

// Schema for the incoming API request wrapper (copied from route.ts)
const wrapperSchema = z.object({
  timestamp: z.string().refine((val) => !isNaN(Date.parse(val)), "Invalid date string"),
  encryptedData: z.string(),
});

// Define session structure expected by the function
interface ProcessTransactionSession {
   user: { 
     id: string; 
     encryptionPhrase: string; 
     encryptionSalt: string; // required
     accountingMethod?: CostBasisMethod | null;
   };
}

// Define body structure expected
interface ProcessTransactionBody {
    timestamp: string;
    encryptedData: string;
}

// Type guard for error objects
function isError(value: unknown): value is Error {
  return value instanceof Error;
}

// Type guard for SaleResultType
function isValidSaleResult(result: unknown): result is SaleResultType {
  if (typeof result !== 'object' || result === null) return false;
  const maybe = result as Record<string, unknown>;
  return (
    'selectedLots' in maybe && Array.isArray(maybe.selectedLots) &&
    ('error' in maybe ? typeof maybe.error === 'string' || maybe.error === undefined : true)
  );
}

// --- Refactored Logic for applying Lot/Allocation rules ---
async function _applyTransactionLogic(
  userId: string,
  txId: string,
  txTimestamp: Date,
  transactionData: TransactionFormData,
  accountingMethod: CostBasisMethod
): Promise<void> {
  // 7. Handle BUY logic: Create a new Lot
  if (transactionData.type === "buy" && transactionData.amount && transactionData.price) {
    // Idempotency check: Check if Lot already exists for this transaction ID
    const existingLot = await db.lot.findFirst({ where: { txId: txId } });
    if (!existingLot) {
      try {
        await db.lot.create({
          data: {
            txId: txId,
            openedAt: txTimestamp,
            originalAmount: transactionData.amount,
            remainingQty: transactionData.amount,
            costBasisUsd: (transactionData.amount * transactionData.price) + (transactionData.fee ?? 0),
          },
        });
        console.log(`Logic: Created Lot for BUY transaction ${txId}`);
      } catch (error) {
        console.error(`Logic: Failed to create Lot for transaction ${txId}:`, error);
        throw new DatabaseError(`Failed to create corresponding Lot for tx ${txId}`); 
      }
    } else {
      console.log(`Logic: Lot already exists for BUY transaction ${txId}, skipping creation.`);
    }
  }
  // 8. Handle SELL logic: Select lots, create Allocations, update Lots
  else if (transactionData.type === "sell" && transactionData.amount && transactionData.price) {
      // Idempotency check: Check if Allocations already exist for this transaction ID
      const existingAllocations = await db.allocation.count({ where: { txId: txId } });
      if (existingAllocations > 0) {
        console.log(`Logic: Allocations already exist for SELL transaction ${txId}, skipping processing.`);
        return; // Already processed
      }

      const openLots = await db.lot.findMany({
        where: {
          transaction: { userId: userId },
          remainingQty: { gt: 1e-9 },
        },
        orderBy: { openedAt: 'asc' },
      });
      
      if (openLots.length === 0) {
          console.log(`Logic: No open lots available for user ${userId} to process SELL ${txId}.`);
          throw new BadRequestError(`No open lots available for user ${userId} to process SELL ${txId}`);
      }
      
      const availableLots: AvailableLot[] = openLots.map((lot) => ({
        id: lot.id,
        date: lot.openedAt.getTime(),
        originalAmount: lot.originalAmount,
        remaining: lot.remainingQty,
        price: (lot.originalAmount > 1e-9) ? lot.costBasisUsd / lot.originalAmount : 0, 
      }));

      const saleDateMs = txTimestamp.getTime();
      let saleResult: SaleResult;
      try {
        saleResult = selectLotsForSale(
          availableLots,
          transactionData.amount,
          accountingMethod,
          transactionData.price,
          saleDateMs
        );
        
        if (!isValidSaleResult(saleResult)) {
          const errorMessage = (saleResult as { error?: string }).error ?? 'Lot selection process failed to return selected lots';
          console.warn(`Logic: Lot selection for tx ${txId} failed:`, errorMessage);
          throw new LotSelectionError(errorMessage);
        }

      } catch (error: unknown) {
         const errorMessage = isError(error) ? error.message : "Unknown error during lot selection";
         console.error(`Logic: Lot selection failed for sell tx ${txId}:`, errorMessage);
         if (errorMessage.includes("Insufficient available lots")) {
             throw new BadRequestError(errorMessage);
         }
         throw new LotSelectionError(errorMessage); 
      }

      // Proceed with database transaction only if lot selection succeeded and returned lots
      try {
          await db.$transaction(async (prisma) => {
            for (const sel of saleResult.selectedLots) {
              if (sel.amountUsed <= 1e-9) continue; 
              
              await prisma.allocation.create({
                data: {
                  txId: txId,
                  lotId: sel.id,
                  qty: sel.amountUsed,
                  costUsd: sel.costBasis,
                  proceedsUsd: sel.proceeds,
                  gainUsd: sel.realizedGain,
                },
              });

              await prisma.lot.update({
                where: { id: sel.id },
                data: {
                  remainingQty: sel.remaining,
                  closedAt: sel.remaining < 1e-8 ? txTimestamp : null,
                  proceedsUsd: sel.remaining < 1e-8 ? sel.proceeds : undefined,
                  gainUsd: sel.remaining < 1e-8 ? sel.realizedGain : undefined,
                  term: sel.remaining < 1e-8 ? (sel.isLongTerm ? "Long" : "Short") : null,
                },
              });
            }
          });
          console.log(`Logic: Created Allocations and updated Lots for SELL transaction ${txId}`);
      } catch (error) {
           console.error(`Logic: Failed to save Allocations/update Lots for tx ${txId}:`, error);
           throw new DatabaseError(`Database update failed during allocation creation/update for tx ${txId}`);
      }
  }
  // 9. Handle INTEREST/DEPOSIT logic: Create a new Lot for interest payments
  else if (
    transactionData.type === "deposit" &&
    transactionData.amount &&
    // Assume BTC for now; add asset support if needed in the future
    transactionData.notes?.toLowerCase().includes('interest')
  ) {
    // Idempotency check: Check if Lot already exists for this transaction ID
    const existingLot = await db.lot.findFirst({ where: { txId: txId } });
    if (!existingLot) {
      let resolvedPrice: number | undefined = transactionData.price;
      if (typeof resolvedPrice !== 'number' || !resolvedPrice) {
        const fetchedPrice = await getDailyBtcUsdPrice(txTimestamp);
        if (typeof fetchedPrice === 'number' && fetchedPrice) {
          resolvedPrice = fetchedPrice;
        } else {
          console.warn(`Interest transaction ${txId} missing price, skipping lot creation.`);
          return; // Or flag for review if needed
        }
      }
      const finalPrice: number = resolvedPrice;
      try {
        await db.lot.create({
          data: {
            txId: txId,
            openedAt: txTimestamp,
            originalAmount: transactionData.amount,
            remainingQty: transactionData.amount,
            costBasisUsd: transactionData.amount * finalPrice,
          },
        });
        console.log(`Logic: Created Lot for INTEREST transaction ${txId}`);
      } catch (error) {
        console.error(`Logic: Failed to create Lot for INTEREST transaction ${txId}:`, error);
        throw new DatabaseError(`Failed to create corresponding Lot for interest tx ${txId}`);
      }
    } else {
      console.log(`Logic: Lot already exists for INTEREST transaction ${txId}, skipping creation.`);
    }
  }
}
// --- End Refactored Logic ---

// This function now handles API interaction, decryption, initial TX creation,
// and then calls the core logic function.
export async function processTransaction(
  body: ProcessTransactionBody, 
  session: ProcessTransactionSession 
): Promise<{ id: string }> {
  
  // 1. Validate session user ID, passphrase, and salt presence
  if (!session?.user?.id) {
    throw new Error("User ID missing from session");
  }
  if (!session.user.encryptionPhrase) {
    throw new Error("Encryption phrase missing from session");
  }
  if (!session.user.encryptionSalt) {
    throw new Error("Encryption salt missing from session");
  }
  const userId = session.user.id;
  const passphrase = session.user.encryptionPhrase;
  const saltHex = session.user.encryptionSalt;
  const accountingMethod = session.user.accountingMethod ?? CostBasisMethod.HIFO;

  // Convert hex salt to Uint8Array
  function hexToBytes(hex: string): Uint8Array {
    if (!hex) return new Uint8Array();
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
  }
  const salt = hexToBytes(saltHex);

  // 2. Validate the wrapper schema
  const wrapperParsed = wrapperSchema.safeParse(body);
  if (!wrapperParsed.success) {
    const errorMessage = wrapperParsed.error.flatten().fieldErrors;
    throw new BadRequestError(`Invalid request format: ${JSON.stringify(errorMessage)}`);
  }

  // 3. Decrypt the transaction data
  let transactionData: TransactionFormData;
  try {
    const key = await generateEncryptionKey(passphrase, salt);
    const decrypted = await decryptString(wrapperParsed.data.encryptedData, key);
    const parsed = transactionSchema.safeParse(JSON.parse(decrypted));
    if (!parsed.success) {
      throw new BadRequestError(`Invalid transaction data: ${parsed.error.message}`);
    }
    transactionData = parsed.data;
  } catch (error: unknown) {
    const errorMessage = isError(error) ? error.message : "Failed to decrypt transaction data";
    throw new BadRequestError(errorMessage);
  }

  // 4. Create the transaction record
  let txId: string;
  try {
    const txTimestamp = new Date(wrapperParsed.data.timestamp);
    const tx = await db.bitcoinTransaction.create({
      data: {
        userId,
        timestamp: txTimestamp,
        type: transactionData.type,
        amount: transactionData.amount,
        price: transactionData.price,
        encryptedData: wrapperParsed.data.encryptedData,
      },
    });
    txId = tx.id;
  } catch (error: unknown) {
    const errorMessage = isError(error) ? error.message : "Failed to create transaction record";
    throw new DatabaseError(errorMessage);
  }

  // 5. Apply transaction logic (lot/allocation rules)
  try {
    await _applyTransactionLogic(
      userId,
      txId,
      new Date(wrapperParsed.data.timestamp),
      transactionData,
      accountingMethod
    );
  } catch (error: unknown) {
    if (error instanceof BadRequestError || error instanceof LotSelectionError) {
      throw error;
    }
    const errorMessage = isError(error) ? error.message : "Failed to apply transaction logic";
    throw new DatabaseError(errorMessage);
  }

  return { id: txId };
}

// --- Bulk Processing Logic Implementation ---

/**
 * Defines the structure for the result of the bulk processing operation.
 */
export type BulkResult = {
  processed: number;
  errors: { txId: string; message: string }[];
};

/**
 * Processes a batch of newly imported transactions by applying the core Lot/Allocation logic.
 *
 * @param userId The ID of the user owning these transactions.
 * @param txIds An array of IDs for the BitcoinTransaction records already created.
 * @returns A Promise resolving to a BulkResult object.
 */
export async function processBulkImportedTransactions(
  userId: string,
  txIds: string[],
): Promise<BulkResult> {
  const result: BulkResult = {
    processed: 0,
    errors: [],
  };

  for (const txId of txIds) {
    try {
      const tx = await db.bitcoinTransaction.findUnique({
        where: { id: txId },
      });

      if (!tx) {
        result.errors.push({ txId, message: "Transaction not found" });
        continue;
      }

      if (tx.type !== 'buy' && tx.type !== 'sell') {
        // Only process buy/sell for lot/allocation logic
        continue;
      }
      if (typeof tx.amount !== 'number' || typeof tx.price !== 'number' || tx.amount === null || tx.price === null) {
        result.errors.push({ txId, message: 'Invalid amount or price for buy/sell transaction' });
        continue;
      }

      // Always use HIFO
      const accountingMethod: CostBasisMethod = CostBasisMethod.HIFO;

      // Use the clear fields from the DB row directly
      const transactionData = {
        type: tx.type as 'buy' | 'sell',
        amount: tx.amount,
        price: tx.price,
        timestamp: tx.timestamp instanceof Date ? tx.timestamp.toISOString() : String(tx.timestamp),
        fee: tx.fee ?? undefined,
        wallet: tx.wallet ?? undefined,
        tags: tx.tags ?? [],
        notes: tx.notes ?? undefined,
      };

      await _applyTransactionLogic(
        userId,
        txId,
        tx.timestamp,
        transactionData,
        accountingMethod
      );

      result.processed++;
    } catch (error: unknown) {
      const errorMessage = isError(error) ? error.message : "Unknown error processing transaction";
      result.errors.push({ txId, message: errorMessage });
    }
  }

  return result;
}

// export type BulkResult = { ... };
// export async function processBulkImportedTransactions(...) { ... } 