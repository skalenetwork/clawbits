/**
 * One static build serves every host, so the environment favicon is picked
 * from the hostname at runtime: *.clawbits.ai keeps the prod icons from
 * index.html, freeclaws.ai gets the staging icon, and everything else
 * (localhost, *.ts.net, IPs, previews) gets the dev icon. Source art:
 * desktop/icons-src/{dev,staging}.png.
 */
export function setupEnvFavicon(): void {
  const host = location.hostname;
  if (host === "clawbits.ai" || host.endsWith(".clawbits.ai")) return;
  const href = host === "freeclaws.ai" || host.endsWith(".freeclaws.ai") ? "/favicon-staging.png" : "/favicon-dev.png";
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')) link.href = href;
}
