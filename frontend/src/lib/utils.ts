import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// The semantic sizes from index.css; unregistered, tailwind-merge reads them as colors and drops them.
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ["label", "caption", "message"] } },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
