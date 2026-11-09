#!/bin/bash
# Envoie le site sur GitHub (à lancer depuis ce dossier : bash deploy.sh)
git add .
git commit -m "${1:-mise à jour du site}" || echo "Rien de nouveau à enregistrer."
git push origin main && echo "✅ Terminé. Rafraîchis ton site avec Ctrl+F5."
