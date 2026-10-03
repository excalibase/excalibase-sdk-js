// system.generateUploadUrl: the first step of db.storage.uploadFile. Staff
// only; the signed upload binds the declared type and size.
import { mutation } from "npm:@excalibase/server@0.11.0";
import { z } from "npm:zod@^3.22.0";
import { checkProductImageUpload } from "./storage-rules.ts";

export default mutation({
  args: z.object({ contentType: z.string(), size: z.number() }),
  handler: async (ctx, { contentType, size }) => {
    checkProductImageUpload(ctx.auth.claims, contentType, size);
    return ctx.storage.generateUploadUrl({ contentType, size });
  },
});
