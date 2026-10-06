import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

// Radix reserves the empty string for clearing a value; catalogue filters use it for All.
const EMPTY_VALUE = "__anicore_all__";
const encodeValue = (value: string) => (value === "" ? EMPTY_VALUE : value);

export interface SelectProps
  extends Omit<
    React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>,
    "value" | "onChange" | "defaultValue"
  > {
  value: string;
  onValueChange: (value: string) => void;
  containerClassName?: string;
  placeholder?: string;
}

/** Shadcn-style select: Radix handles focus, keyboard navigation, typeahead and portals. */
export const Select = React.forwardRef<HTMLButtonElement, SelectProps>(
  (
    {
      value,
      onValueChange,
      containerClassName,
      className,
      children,
      placeholder,
      disabled,
      ...props
    },
    ref,
  ) => (
    <SelectPrimitive.Root
      value={encodeValue(value)}
      onValueChange={(next) => onValueChange(next === EMPTY_VALUE ? "" : next)}
      disabled={disabled}
    >
      <div className={cn("min-w-0", containerClassName)}>
        <SelectPrimitive.Trigger
          ref={ref}
          disabled={disabled}
          className={cn(
            "group flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-card px-3 text-sm font-medium shadow-xs outline-none transition-[color,box-shadow,border-color] hover:border-ring/50 hover:bg-accent/40 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35 data-[state=open]:border-ring data-[state=open]:ring-2 data-[state=open]:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:truncate",
            className,
          )}
          {...props}
        >
          <SelectPrimitive.Value placeholder={placeholder} />
          <SelectPrimitive.Icon asChild>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
      </div>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          collisionPadding={8}
          className="z-[100] max-h-[min(var(--radix-select-content-available-height),20rem)] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl shadow-black/15"
        >
          <SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center bg-popover text-muted-foreground">
            <ChevronUp className="size-4" />
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center bg-popover text-muted-foreground">
            <ChevronDown className="size-4" />
          </SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  ),
);
Select.displayName = "Select";

export const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  Omit<React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>, "value"> & {
    value: string | number;
  }
>(({ value, className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    value={encodeValue(String(value))}
    className={cn(
      "relative flex cursor-default select-none items-center rounded-md py-2 pl-3 pr-9 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[state=checked]:bg-primary/10 data-[state=checked]:font-medium data-[state=checked]:text-primary data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className,
    )}
    {...props}
  >
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <span className="absolute right-3 flex size-4 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="size-4" />
      </SelectPrimitive.ItemIndicator>
    </span>
  </SelectPrimitive.Item>
));
SelectItem.displayName = "SelectItem";
