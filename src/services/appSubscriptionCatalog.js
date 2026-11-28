// Subscriptions for the apps a person already uses with their own profile
// (Google, GitHub, ChatGPT, Claude), gathered on one page. The prices are
// EXAMPLES: the app's own monthly price plus 10%. Nothing is sold or charged
// yet: there is no checkout and payments stay off. РАДКО 28.11.2026: „за сега
// … с примерни цени … после ще решим какви цени“. Real prices and selling
// come only with his „да“ for each step.

export const APP_SUBSCRIPTION_MARKUP_PERCENT = 10;

// The app's own price for one month, in euro cents, as an example.
const EXAMPLE_APPS = Object.freeze([
  { id: "google-ai-pro", app: "Google AI Pro", maker: "Google", baseCents: 2199 },
  { id: "google-one", app: "Google One 100 GB", maker: "Google", baseCents: 199 },
  { id: "youtube-premium", app: "YouTube Premium", maker: "Google", baseCents: 1299 },
  { id: "github-copilot-pro", app: "GitHub Copilot Pro", maker: "GitHub", baseCents: 1000 },
  { id: "chatgpt-plus", app: "ChatGPT Plus", maker: "OpenAI", baseCents: 2300 },
  { id: "claude-pro", app: "Claude Pro", maker: "Anthropic", baseCents: 2160 },
]);

export function withMarkup(baseCents, percent = APP_SUBSCRIPTION_MARKUP_PERCENT) {
  return Math.round((Number(baseCents) * (100 + percent)) / 100);
}

export const APP_SUBSCRIPTIONS = Object.freeze({
  examplePrices: true,
  charging: false,
  markupPercent: APP_SUBSCRIPTION_MARKUP_PERCENT,
  currency: "EUR",
  period: "month",
  items: Object.freeze(
    EXAMPLE_APPS.map((item) =>
      Object.freeze({ ...item, priceCents: withMarkup(item.baseCents) }),
    ),
  ),
});
