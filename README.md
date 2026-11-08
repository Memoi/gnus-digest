# GitHub digest (GeniusVentures)

Résumé quotidien + hebdomadaire de l'activité des repos de l'organisation, sans coût.

- `scripts/build-digest.mjs` : interroge l'API GitHub, résume par règles (aucune IA), écrit `public/digest.json`
- `.github/workflows/digest.yml` : lance le script chaque jour (GitHub Actions) et committe le résultat
- `public/index.html` : page statique qui affiche `digest.json`

## Mise en place
1. Crée un repo GitHub avec ces fichiers (ou copie-les dans le repo de ton site).
2. Vercel : « Add New Project » → importe ce repo → Output Directory = `public` (pas de build).
3. Onglet Actions → « Daily GitHub digest » → « Run workflow » pour générer le premier `digest.json`.
4. Chaque commit du bot redéploie le site automatiquement.

Test local : `GITHUB_TOKEN=ghp_xxx node scripts/build-digest.mjs` puis ouvre `public/index.html` via un petit serveur (`npx serve public`).
