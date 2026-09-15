import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

function Input({
  className,
  type,
  size = "default",
  ...props
}: Omit<React.ComponentProps<"input">, "size"> & { size?: "default" | "sm" }) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "min-w-0 border transition-[color,box-shadow,background-color] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        size === "sm"
          ? "h-[30px] w-42 rounded-lg border-border bg-background px-2.5 text-[13px]"
          : "h-9 w-full rounded-md border-transparent bg-input/50 px-3 py-1 text-base md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Input }
