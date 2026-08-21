const DISABLED = Object.freeze({ enabled: false, status: "planned", reason: "Изисква отделно решение и разрешение." });

export const ECOSYSTEM_MODULES = Object.freeze({
  novarium: Object.freeze({
    id: "novarium",
    name: "NOVARIUM",
    purpose: "Проектна и продуктова екосистема около AI CORE.",
    enabled: true,
    status: "design",
  }),
  token: Object.freeze({
    id: "token",
    name: "NOVARIUM Token",
    purpose: "Бъдещ модел за достъп или участие, не активна емисия.",
    ...DISABLED,
    safety: Object.freeze({
      noIssuance: true,
      noTrading: true,
      noWalletCustody: true,
      requiresLegalReview: true,
    }),
  }),
  foundation: Object.freeze({
    id: "foundation",
    name: "NOVARIUM Foundation",
    purpose: "Бъдеща нестопанска структура за мисия, стандарти и обществена полза.",
    ...DISABLED,
    safety: Object.freeze({
      noRegistration: true,
      requiresLegalReview: true,
      requiresHumanBoardApproval: true,
    }),
  }),
  corporation: Object.freeze({
    id: "corporation",
    name: "NOVARIUM Corporation",
    purpose: "Бъдеща търговска структура за продукт, договори и приходи.",
    ...DISABLED,
    safety: Object.freeze({
      noRegistration: true,
      noContracts: true,
      noPayments: true,
      requiresLegalReview: true,
    }),
  }),
});

export function getEcosystemStatus() {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(ECOSYSTEM_MODULES).map(([id, module]) => [id, { ...module }]),
    ),
  );
}
