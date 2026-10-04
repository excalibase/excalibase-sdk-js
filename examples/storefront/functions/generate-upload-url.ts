// system.generateUploadUrl: the first step of db.storage.uploadFile. Staff
// only; the signed upload binds the declared type and size.
import { FunctionError, mutation } from "npm:@excalibase/server@0.13.0";
import { z } from "npm:zod@^3.22.0";
import { productImageRefusal } from "./storage-rules.ts";

export default mutation({
  args: z.object({ contentType: z.string(), size: z.number() }),
  handler: async (ctx, { contentType, size }) => {
    const refusal = productImageRefusal(ctx.auth.claims, contentType, size);
    if (refusal) throw new FunctionError(refusal.status, refusal.message);
    return ctx.storage.generateUploadUrl({ contentType, size });
  },
});
