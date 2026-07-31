/**
 * Breadcrumbs — a universal, reusable trail built on the shadcn breadcrumb
 * primitive. Each crumb carries its OWN icon (or a leading node such as an
 * avatar) so every section is labelled, and the whole crumb (icon + label) is a
 * single clickable target. The last crumb is the current page (inert). Designed
 * to sit in the page-header bar via {@link PageHeader}'s `breadcrumb` prop.
 */
import { Fragment, type MouseEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { IconSvgElement } from "@hugeicons/react";
import { Icon } from "@/components/Icon";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

export interface Crumb {
  label: string;
  /** Makes the crumb a link (ignored for the last/current crumb). */
  to?: string;
  /** Icon shown before the label. */
  icon?: IconSvgElement;
  /** Custom leading node (e.g. an avatar) — overrides `icon`. */
  leading?: ReactNode;
  /** Optional click interceptor for a linked crumb. Call `e.preventDefault()`
   *  inside to take over the navigation (e.g. to run a view-transition morph);
   *  modified/middle clicks still open in a new tab. */
  onNavigate?: (e: MouseEvent) => void;
}

export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  return (
    <Breadcrumb className={className}>
      <BreadcrumbList>
        {items.map((crumb, i) => {
          const last = i === items.length - 1;
          const lead =
            crumb.leading ?? (crumb.icon ? <Icon icon={crumb.icon} className="size-4 shrink-0" /> : null);
          const inner = (
            <>
              {lead}
              <span className="truncate">{crumb.label}</span>
            </>
          );
          return (
            <Fragment key={`${crumb.label}-${String(i)}`}>
              {i > 0 && <BreadcrumbSeparator />}
              <BreadcrumbItem>
                {crumb.to && !last ? (
                  <BreadcrumbLink render={<Link to={crumb.to} viewTransition onClick={crumb.onNavigate} />}>{inner}</BreadcrumbLink>
                ) : (
                  <BreadcrumbPage>{inner}</BreadcrumbPage>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
