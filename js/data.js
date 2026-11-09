// 📝 CONTENU DU SITE — modifier les textes ici, jamais dans le HTML
const SITE_DATA = {
  hero: {
    title: "Des probabilités de football calibrées, pas des promesses",
    subtitle: "Un moteur d'analyse qui combine XGBoost, Poisson et Dixon-Coles, validé sans fuite de données, et livré via Telegram.",
    cta: "Ouvrir le bot Telegram",
    cta2: "Lancer la simulation"
  },
  stats: [
    { v: "3", l: "modèles qui votent ensemble" },
    { v: "24/7", l: "exécution automatique" },
    { v: "0", l: "fuite de données (Walk-Forward)" }
  ],
  features: [
    { icon: "🧠", title: "Pipeline MLOps", desc: "XGBoost, Poisson et Dixon-Coles votent ensemble pour estimer la probabilité réelle d'un résultat." },
    { icon: "🛡️", title: "Aucune fuite de données", desc: "Validation Walk-Forward stricte : le modèle n'utilise jamais le futur pour prédire le passé." },
    { icon: "⚖️", title: "Calibration isotonique", desc: "Une probabilité de 60 % doit se réaliser environ 6 fois sur 10. Nous le vérifions." },
    { icon: "⚡", title: "Cloud autonome", desc: "Tourne en continu sur GitHub Actions, sans serveur à gérer." }
  ],
  steps: [
    { t: "Créez votre compte", d: "Inscription gratuite sur ce site." },
    { t: "Choisissez un pack", d: "Starter, Pro ou Elite selon votre besoin." },
    { t: "Payez par Mobile Money", d: "Orange Money ou MTN MoMo, instructions dans le bot." },
    { t: "Recevez votre lien", d: "Après validation, le bot envoie un lien de téléchargement sécurisé." }
  ],
  packs: [
    { name: "Starter", price: "25 000", features: ["Cache complet", "Script d'inférence", "Support standard"], featured: false },
    { name: "Pro", price: "75 000", features: ["Tout Starter", "Code source MLOps", "Documentation", "Mises à jour 1 mois"], featured: true },
    { name: "Elite", price: "150 000", features: ["Tout Pro", "Accompagnement", "Déploiement", "Mises à jour à vie"], featured: false }
  ],
  faq: [
    { q: "Comment vais-je recevoir mon produit ?", a: "Après validation de votre paiement Mobile Money par l'administrateur, le bot vous envoie automatiquement un lien de téléchargement sécurisé." },
    { q: "Quels moyens de paiement sont acceptés ?", a: "Orange Money et MTN Mobile Money. Les instructions sont données directement dans le bot." },
    { q: "Le bot garantit-il des gains ?", a: "Non. GOANGEL est un outil d'analyse statistique. Les performances passées ne garantissent pas les résultats futurs." },
    { q: "Mes données sont-elles protégées ?", a: "L'authentification est assurée par Firebase (Google) : votre mot de passe n'est jamais stocké ni affiché en clair." }
  ],
  legal: [
    "GOANGEL fournit des analyses statistiques à titre informatif. Ce n'est pas un conseil financier et aucun gain n'est garanti.",
    "Les paris sportifs comportent un risque de perte. Ne misez jamais d'argent dont vous avez besoin.",
    "Service réservé aux personnes majeures selon la loi de leur pays. Si le jeu devient un problème, demandez de l'aide à un organisme spécialisé.",
    "Les produits numériques livrés ne sont ni remboursables ni échangeables une fois le lien de téléchargement envoyé."
  ]
};
