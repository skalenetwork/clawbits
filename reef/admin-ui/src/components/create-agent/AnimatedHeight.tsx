/**
 * AnimatedHeight - the wizard body sizes to each step's natural content and
 * ANIMATES between them (a ResizeObserver drives an explicit pixel height the
 * CSS transition can interpolate; `height: auto` can't animate). The dialog is
 * translate-centered, so a height change re-centers it symmetrically. First
 * paint applies the measured height without a transition (no grow-from-zero on
 * open); `prefers-reduced-motion` snaps.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

export function AnimatedHeight({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  const innerRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<number | null>(null)
  const [ready, setReady] = useState(false)

  useLayoutEffect(() => {
    const el = innerRef.current
    if (!el) return
    setHeight(el.offsetHeight)
    const ro = new ResizeObserver(() => {
      setHeight(el.offsetHeight)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
    }
  }, [])

  // Arm the transition only after the first measured frame has painted.
  useEffect(() => {
    if (height === null || ready) return
    const id = requestAnimationFrame(() => {
      setReady(true)
    })
    return () => {
      cancelAnimationFrame(id)
    }
  }, [height, ready])

  return (
    <div
      className={cn(
        "overflow-hidden",
        ready && "transition-[height] duration-300 ease-in-out motion-reduce:transition-none",
        className,
      )}
      style={{ height: height ?? "auto" }}
    >
      <div ref={innerRef}>{children}</div>
    </div>
  )
}
