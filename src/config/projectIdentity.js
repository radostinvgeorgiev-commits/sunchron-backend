export const PROJECT_NAME = "NOVARIUM / SYNCHRON-X";

export const PROJECT_DEFINITION =
  "SYNCHRON-X е лична AI операционна система, която познава човека, има постоянна контролирана памет и използва разрешени инструменти за изпълнение на реални задачи. За всяка задача тя може да избира най-подходящия AI модел, вместо да зависи от един-единствен AI.";

export const AVATAR_DEFINITION =
  "AI аватарът е интерфейсът на SYNCHRON-X — лицето, гласът, характерът и начинът на общуване.";

export const CANONICAL_PROJECT_MEMORY_ID = "canonical-project-definition";

export function isSupersededProjectDefinition(fact) {
  if (typeof fact !== "string") return false;
  const text = fact.toLocaleLowerCase("bg-BG");
  return (
    /първата\s+практическа\s+цел.*личен\s+ai\s+аватар/u.test(text) ||
    /текущата\s+цел.*работещ\s+личен\s+ai\s+аватар/u.test(text) ||
    /synchron-x\s+е\s+технологичното\s+ядро.*личен\s+ai\s+аватар/u.test(text)
  );
}
