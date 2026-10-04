// images.urls: short-lived links for product pictures, for every caller,
// guests included. A storage id is only known to someone who may read the
// product row naming it; an id of another project resolves to nothing.
import { FunctionError, query } from "npm:@excalibase/server@0.13.0";
import { z } from "npm:zod@^3.22.0";
import { imageIdsRefusal, uniqueImageIds } from "./storage-rules.ts";

export default query({
  args: z.object({ storageIds: z.array(z.string()) }),
  handler: async (ctx, { storageIds }) => {
    const refusal = imageIdsRefusal(storageIds);
    if (refusal) throw new FunctionError(refusal.status, refusal.message);
    const ids = uniqueImageIds(storageIds);
    const urls = await Promise.all(ids.map((id) => ctx.storage.getUrl(id)));
    return Object.fromEntries(ids.map((id, i) => [id, urls[i]]));
  },
});
