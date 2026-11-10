const SITE_DATA = {
  hero: {
    title: "Des probabilités de football calibrées, pas des promesses",
    subtitle: "Un moteur d'analyse qui combine XGBoost, Poisson et Dixon-Coles, validé sans fuite de données.",
    cta: "Ouvrir le bot Telegram",
    cta2: "Lancer la simulation"
  },
  stats: [
    { v: "20+", l: "modèles qui votent ensemble" },
    { v: "24/7", l: "exécution automatique" },
    { v: "0", l: "fuite de données" }
  ],
  features: [
    { icon: "🧠", title: "Pipeline MLOps", desc: "Plus de 20 modèles de Machine Learning et de probabilités votent ensemble." },
    { icon: "🛡️", title: "Aucune fuite de données", desc: "Validation Walk-Forward stricte : le modèle n'utilise jamais le futur pour prédire le passé." },
    { icon: "⚖️", title: "Calibration isotonique", desc: "Une probabilité de 60 % doit se réaliser environ 6 fois sur 10. Nous le vérifions." },
    { icon: "⚡", title: "Infrastructure Haute Disponibilité", desc: "Nos serveurs fonctionnent 24h/24 et 7j/7 pour vous garantir des analyses en temps réel." }
  ],
  steps: [
    { t: "Créez votre compte", d: "Inscription gratuite sur ce site." },
    { t: "Choisissez un pack", d: "Starter, Pro ou Elite selon votre besoin." },
    { t: "Payez en Crypto", d: "USDT ou TRX via le réseau Tron." },
    { t: "Recevez votre lien", d: "Après validation de la blockchain, téléchargez votre fichier." }
  ],
  packs: [
    { name: "Starter", price: "40", features: ["Cache complet", "Script d'inférence", "Support standard"], featured: false },
    { name: "Pro", price: "120", features: ["Tout Starter", "Code source MLOps", "Documentation", "Mises à jour 1 mois"], featured: true },
    { name: "Elite", price: "250", features: ["Tout Pro", "Accompagnement", "Déploiement", "Mises à jour à vie"], featured: false }
  ],
  faq: [
    { q: "Comment vais-je recevoir mon produit ?", a: "Après confirmation du paiement crypto sur la blockchain, le site vous génère un lien de téléchargement sécurisé." },
    { q: "Quels moyens de paiement sont acceptés ?", a: "USDT et TRX sur le réseau Tron (TRC-20). Les frais de réseau sont très faibles." },
    { q: "Le bot garantit-il des gains ?", a: "Non. GOANGEL est un outil d'analyse statistique avancé. Les performances passées ne garantissent pas les résultats futurs." },
    { q: "Mes données sont-elles protégées ?", a: "L'authentification est assurée par Firebase (Google) : votre mot de passe n'est jamais stocké en clair." }
  ],
  legal: [
    "<strong style='color:var(--gold); font-size:1.2rem;'>La puissance technologique de GOANGEL</strong>",
    "GOANGEL n'est pas un simple bot de prédiction. C'est un moteur d'analyse de pointe qui combine plus de 20 modèles d'apprentissage automatique et de modèles mathématiques probabilistes avancés.",
    "<strong>🌳 Modèles à base d'arbres :</strong> XGBoost, LightGBM, CatBoost, Random Forest, ExtraTrees, HistGradientBoosting.",
    "<strong>🧠 Réseaux de neurones :</strong> Deep Learning, Multi-Layer Perceptron, TabM, RealMLP, ExcelFormer.",
    "<strong>⚽ Modèles statistiques football :</strong> PoissonGoalsModel, DixonColesGoalModel, NegativeBinomialGoalModel, ZeroInflatedPoissonGoalsModel.",
    "<strong>🧮 Modèles avancés :</strong> KalmanBayesianModel, MonteCarloSimulator, SkellamModel, CopulaModel, HMMModel, NGBoost.",
    "<br><hr style='border-color:var(--line); margin:1.5rem 0;'><strong style='color:var(--muted);'>Avertissements légaux</strong>",
    "GOANGEL fournit des analyses statistiques à titre informatif. Aucun gain n'est garanti. Les paris sportifs comportent un risque de perte. Service réservé aux personnes majeures (18+)."
  ]
};
