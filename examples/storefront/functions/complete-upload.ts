// system.completeUpload: the last step of db.storage.uploadFile. The platform
// reads the staged bytes back and records them only if they match what was
// declared.
import { mutation } from "npm:@excalibase/server@0.11.0";
import { z } from "npm:zod@^3.22.0";
import { checkStaff } from "./storage-rules.ts";

export default mutation({
  args: z.object({ storageId: z.string(), uploadId: z.string() }),
  handler: async (ctx, { storageId, uploadId }) => {
    checkStaff(ctx.auth.claims);
    return ctx.storage.completeUpload({ storageId, uploadId });
  },
});
