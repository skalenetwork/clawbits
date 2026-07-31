import * as React from "react";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/Icon";
import { cn } from "@/lib/utils";

/**
 * shadcn-style breadcrumb primitive (adapted to the repo's base-ui `useRender`
 * pattern). `BreadcrumbLink` renders as any element via `render` (e.g. a
 * react-router `<Link>`), so the whole crumb — icon + label — is one hit target.
 * Compose with the higher-level {@link Breadcrumbs} for the common icon+label
 * trail.
 */
function Breadcrumb({ className, ...props }: React.ComponentProps<"nav">) {
  return <nav aria-label="Breadcrumb" data-slot="breadcrumb" className={className} {...props} />;
}

function BreadcrumbList({ className, ...props }: React.ComponentProps<"ol">) {
  return (
    <ol
      data-slot="breadcrumb-list"
      className={cn("flex min-w-0 flex-nowrap items-center gap-0.5 text-sm", className)}
      {...props}
    />
  );
}

function BreadcrumbItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="breadcrumb-item"
      className={cn("inline-flex min-w-0 items-center", className)}
      {...props}
    />
  );
}

// Padded hit target far larger than the glyphs (WCAG 2.2), hover wash + focus
// ring; the icon rides inside so it's clickable too.
const CRUMB_BASE =
  "inline-flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors [&>svg]:size-4 [&>svg]:shrink-0";

function BreadcrumbLink({
  className,
  render,
  ...props
}: useRender.ComponentProps<"a"> & React.ComponentProps<"a">) {
  return useRender({
    defaultTagName: "a",
    props: mergeProps<"a">(
      {
        className: cn(
          CRUMB_BASE,
          "font-medium text-muted-foreground hover:bg-[var(--sb-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          className,
        ),
      },
      props,
    ),
    render: render ?? <a />,
    state: { slot: "breadcrumb-link" },
  });
}

function BreadcrumbPage({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="breadcrumb-page"
      role="link"
      aria-disabled="true"
      aria-current="page"
      className={cn(CRUMB_BASE, "font-semibold text-foreground", className)}
      {...props}
    />
  );
}

function BreadcrumbSeparator({ children, className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="breadcrumb-separator"
      role="presentation"
      aria-hidden="true"
      className={cn("shrink-0 text-muted-foreground/40 [&>svg]:size-3.5", className)}
      {...props}
    >
      {children ?? <Icon icon={ArrowRight01Icon} className="size-3.5" />}
    </li>
  );
}

export {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
};
