import { useQuery } from "@tanstack/react-query";
import { useSession } from "./session";
import { IMAGE_URL_TTL_MS } from "../lib/images";

// A link to a product picture, renewed before the platform's signature runs out.
export function useImageUrl(storageId: string | null | undefined): string | null {
  const { imageUrl } = useSession();
  const link = useQuery({
    queryKey: ["image-url", storageId],
    queryFn: () => imageUrl(storageId!),
    enabled: Boolean(storageId),
    staleTime: IMAGE_URL_TTL_MS,
    refetchInterval: IMAGE_URL_TTL_MS,
  });
  return link.data ?? null;
}
