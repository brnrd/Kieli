import { KeyloService } from "../server/service";
import { Conflict, getStore } from "../server/store";
import { config } from "../server/config";
import type { Identity } from "../shared";

if (config().authMode !== "demo" || config().driver !== "sqlite")
  throw new Error(
    "Sample data can only be seeded in a local SQLite demo workspace.",
  );
const identity: Identity = {
  sub: "seed",
  name: "Alex Morgan",
  email: "alex@keylo.local",
  admin: true,
  projects: {},
};
const svc = new KeyloService(await getStore());
const projects = [
  {
    id: "acme-website",
    name: "Acme website",
    description: "Thoughtful products. Words to match.",
    color: "sage",
    sourceLanguage: "en",
    languages: [
      { code: "en", name: "English" },
      { code: "fr", name: "French" },
      { code: "nl", name: "Dutch" },
    ],
  },
  {
    id: "mobile-app",
    name: "Mobile app",
    description: "A little Acme, wherever you go.",
    color: "violet",
    sourceLanguage: "en",
    languages: [
      { code: "en", name: "English" },
      { code: "fr", name: "French" },
    ],
  },
  {
    id: "transactional-emails",
    name: "Transactional emails",
    description: "The small messages that make a difference.",
    color: "amber",
    sourceLanguage: "en",
    languages: [
      { code: "en", name: "English" },
      { code: "fr", name: "French" },
      { code: "de", name: "German" },
    ],
  },
];
for (const project of projects) {
  try {
    await svc.createProject(identity, project);
  } catch (e) {
    if (!(e instanceof Conflict)) throw e;
  }
}
const copy: [string, string, string, string, string, string?][] = [
  [
    "common.button.continue",
    "Continue",
    "Continuer",
    "Doorgaan",
    "common",
    "buttons",
  ],
  [
    "common.button.save",
    "Save changes",
    "Enregistrer",
    "Wijzigingen opslaan",
    "common",
    "buttons",
  ],
  [
    "common.nav.about",
    "A little about us",
    "Un peu de nous",
    "Een beetje over ons",
    "common",
    "navigation",
  ],
  [
    "common.nav.contact",
    "Say hello",
    "Dites bonjour",
    "Zeg hallo",
    "common",
    "navigation",
  ],
  [
    "common.nav.shop",
    "The good stuff",
    "Les belles choses",
    "De mooie dingen",
    "common",
    "navigation",
  ],
  [
    "home.hero.title",
    "Everyday, a little better.",
    "Le quotidien, en mieux.",
    "Elke dag een beetje beter.",
    "homepage",
    "hero",
  ],
  [
    "home.hero.subtitle",
    "Thoughtful things for the way you live.",
    "De belles choses pour votre quotidien.",
    "Mooie dingen voor jouw dagelijks leven.",
    "homepage",
    "hero",
  ],
  [
    "home.hero.cta",
    "Find your everyday favorite",
    "Trouvez votre nouveau favori",
    "",
    "homepage",
    "buttons",
  ],
  [
    "home.collection.title",
    "Made for your kind of day.",
    "Pour vos journées à vous.",
    "Gemaakt voor jouw dag.",
    "homepage",
    "collections",
  ],
  [
    "home.collection.subtitle",
    "Little things. Lasting company.",
    "De petites choses. Pour longtemps.",
    "",
    "homepage",
    "collections",
  ],
  [
    "checkout.empty.title",
    "A little empty in here.",
    "Un peu vide, par ici.",
    "Het is hier een beetje leeg.",
    "checkout",
    "empty state",
  ],
  [
    "checkout.empty.cta",
    "Find something lovely",
    "Trouvez votre bonheur",
    "",
    "checkout",
    "buttons",
  ],
  [
    "checkout.shipping.label",
    "Where should we send the good stuff?",
    "Où livrer vos belles trouvailles ?",
    "",
    "checkout",
    "shipping",
  ],
  [
    "checkout.success.title",
    "Good things are on their way.",
    "",
    "",
    "checkout",
    "confirmation",
  ],
  [
    "footer.newsletter.title",
    "A note from us, now and then.",
    "Un petit mot, de temps en temps.",
    "Af en toe een berichtje van ons.",
    "footer",
    "newsletter",
  ],
  [
    "footer.newsletter.placeholder",
    "Your email goes here",
    "Votre adresse e-mail",
    "",
    "footer",
    "newsletter",
  ],
  [
    "footer.newsletter.cta",
    "Keep me in the loop",
    "Tenez-moi au courant",
    "Hou me op de hoogte",
    "footer",
    "buttons",
  ],
  [
    "footer.copyright",
    "Thoughtfully made, for everyday.",
    "Pensé avec soin, pour chaque jour.",
    "Met aandacht gemaakt, voor elke dag.",
    "footer",
  ],
];
for (const [name, en, fr, nl, namespace, tag] of copy) {
  try {
    await svc.createKey(identity, "acme-website", {
      name,
      description:
        name === "home.hero.title"
          ? "Main heading on the homepage. Keep it short, warm, and easy to remember."
          : "",
      namespace,
      tags: tag ? [tag] : [],
      translations: { en, fr, nl },
    });
  } catch (e) {
    if (!(e instanceof Conflict)) throw e;
  }
}
console.log(
  "Local sample workspace ready: 3 projects, 18 keys. Existing records were preserved.",
);
