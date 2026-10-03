import { ImageOff } from "lucide-react";

import type { AnimeListItem } from "@/lib/anime-api";
import { cn } from "@/lib/utils";

/** Cover thumbnail with the provider's dominant color as the placeholder. */
export function AnimeCover({
  item,
  className,
  iconClassName = "size-4",
}: {
  item: Pick<AnimeListItem, "coverImage" | "coverImageColor" | "titleRomaji">;
  className?: string;
  iconClassName?: string;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden border border-border/60 bg-muted",
        className,
      )}
      style={item.coverImageColor ? { backgroundColor: item.coverImageColor } : undefined}
    >
      {item.coverImage ? (
        <img
          src={item.coverImage}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
      ) : (
        <ImageOff className={cn("text-muted-foreground/60", iconClassName)} aria-hidden="true" />
      )}
    </div>
  );
}
