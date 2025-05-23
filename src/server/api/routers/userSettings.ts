import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { CostBasisMethod } from "@/lib/cost-basis"; // Import enum for validation

export const userSettingsRouter = createTRPCRouter({
  // GET current settings
  get: protectedProcedure
    .input(z.undefined())
    .query(async ({ ctx }) => {
      // Add temporary log to inspect session context
      console.log("\n[DEBUG] Incoming session in userSettings.get:", JSON.stringify(ctx.session, null, 2)); 
      
      // Original logic (keep for now, but add check)
      if (!ctx.session?.user) { 
        console.error("[DEBUG] Session or session.user is missing!");
        throw new Error("User session not found in context"); // Throw specific error
      }

      const user = await ctx.db.user.findUniqueOrThrow({
        where: { id: ctx.session.user.id },
        select: { accountingMethod: true }, // Select the specific field
      });
      // Ensure the returned value conforms to the enum
      return { 
        accountingMethod: user.accountingMethod as CostBasisMethod 
      };
    }),

  // UPDATE accountingMethod
  update: protectedProcedure
    .input(
      z.object({
        // Use nativeEnum for TS enums
        accountingMethod: z.nativeEnum(CostBasisMethod), 
      })
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.db.user.update({
        where: { id: ctx.session.user.id },
        data: { accountingMethod: input.accountingMethod },
      });
      return { accountingMethod: input.accountingMethod };
    }),
});

export type UserSettingsRouter = typeof userSettingsRouter; 