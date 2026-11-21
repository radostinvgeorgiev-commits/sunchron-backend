const trackedVariants = new Set([
  "variant-1",
  "variant-2",
  "variant-3",
  "smoke-test",
]);

export function readCampaignAttribution(query) {
  if (
    query?.utm_source !== "chatgpt" ||
    query.utm_medium !== "paid" ||
    query.utm_campaign !== "ai-core-launch" ||
    !trackedVariants.has(query.utm_content)
  ) {
    return null;
  }

  return {
    utm_source: query.utm_source,
    utm_medium: query.utm_medium,
    utm_campaign: query.utm_campaign,
    utm_content: query.utm_content,
  };
}

export function logCampaignEvent(event, attribution) {
  if (!attribution) return;
  console.info(JSON.stringify({ event, ...attribution }));
}
