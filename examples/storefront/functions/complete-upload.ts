// system.completeUpload: the last step of db.storage.uploadFile. The platform
// reads the staged bytes back and records them only if they match what was
// declared.
import { FunctionError, mutation } from "npm:@excalibase/server@0.13.0";
import { z } from "npm:zod@^3.22.0";
import { staffRefusal } from "./storage-rules.ts";

export default mutation({
  args: z.object({ storageId: z.string(), uploadId: z.string() }),
  handler: async (ctx, { storageId, uploadId }) => {
    const refusal = staffRefusal(ctx.auth.claims);
    if (refusal) throw new FunctionError(refusal.status, refusal.message);
    return ctx.storage.completeUpload({ storageId, uploadId });
  },
});
