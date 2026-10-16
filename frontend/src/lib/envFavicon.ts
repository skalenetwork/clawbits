/**
 * One static build serves every host, so the environment favicon is picked
 * from the hostname at runtime: *.clawbits.ai keeps the prod icons from
 * index.html and everything else (localhost, *.ts.net, IPs, previews) gets
 * the dev icon.
 */
export function setupEnvFavicon(): void {
  const host = location.hostname;
  if (host === "clawbits.ai" || host.endsWith(".clawbits.ai")) return;
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')) link.href = "/favicon-dev.png";
}
