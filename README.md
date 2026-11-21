# diag run

**Où partent tes tokens Claude Code ? Un diagnostic en une commande, 100 % local.**

> **In English:** diag run reads your local Claude Code sessions and opens a plain-language report in your browser: which tasks ran on a model bigger than needed, how much your long conversations cost, and what you would have saved by following its advice. Nothing is sent anywhere. Requires Node 18+. The report and this README are in French for now; contributions in other languages are welcome.

![Exemple de rapport diag run (données fictives)](docs/apercu.png)

*Exemple de rapport, généré à partir de sessions fictives.*

## Pourquoi

Beaucoup de gens disent « je crame mes tokens très vite, je ne comprends pas ». Le plus souvent, deux causes reviennent : un gros modèle (Opus) utilisé pour des tâches qu'un petit (Haiku) aurait faites, et des conversations qui s'allongent sans jamais être vidées, parce que Claude relit tout l'historique à chaque message.

diag run lit tes sessions passées et te montre, en quelques cartes lisibles :

- **Le bon modèle pour la bonne tâche** : quelles demandes simples ont tourné sur un modèle trop gros.
- **Conversation trop longue** : la part de ta consommation due à la relecture de l'historique.
- **Actions inutiles** : fichiers relus plusieurs fois, commandes répétées, résultats énormes.
- **Si tu avais suivi ces conseils** : une estimation de ce que tu aurais économisé.

## Ce dont tu as besoin : Node

diag run se lance avec **Node 18 ou plus récent**.

Attention : **Claude Code n'installe pas Node**. Si tu as installé Claude Code avec l'installeur natif, tu n'as peut-être pas Node sur ta machine. Pour vérifier, ouvre un terminal et tape :

```bash
node --version
```

- Si un numéro s'affiche (par exemple `v22.1.0`) et qu'il commence par 18 ou plus : tu es prêt.
- Si tu obtiens une erreur du type « commande introuvable » : installe Node depuis [nodejs.org](https://nodejs.org) (choisis la version « LTS »), puis rouvre ton terminal et refais le test.

Sous Windows, le terminal est PowerShell (cherche « PowerShell » dans le menu Démarrer).

## Lancer diag run

Une seule commande :

```bash
npx diagrun@latest
```

La première fois, npx te demande de confirmer l'installation temporaire : réponds `y`. Ensuite, ton navigateur s'ouvre sur le rapport. Il est aussi enregistré dans `~/.diagrun/rapport.html` (sous Windows : `C:\Users\<toi>\.diagrun\rapport.html`).

Le rapport s'ouvre sur les **7 derniers jours**, avec deux boutons en haut, **7 jours** et **30 jours**, pour passer de l'un à l'autre sans relancer.

Pour une seule période de ton choix (par exemple 14 jours), ajoute l'option `--days` : le rapport n'aura alors pas de boutons.

```bash
npx diagrun@latest --days 14
```

**Limite à connaître :** Claude Code supprime lui-même les anciennes sessions, par défaut au bout de 30 jours. Même avec `--days 90`, diag run ne voit donc que ce qui reste sur ton ordinateur.

Le `@latest` est important : il force npx à récupérer la dernière version au lieu de réutiliser une copie gardée en cache.

**Depuis GitHub** (si le paquet n'est pas sur npm, il faut aussi avoir **git**) :

```bash
npx github:Francoisnollet/diagrun
```

### Options

| Option | Rôle |
|---|---|
| `--days N` | Une seule période de N jours, sans boutons (par défaut : 7 et 30 jours, avec boutons) |
| `--no-open` | Ne pas ouvrir le navigateur automatiquement |
| `--out fichier.html` | Écrire le rapport à un autre endroit |
| `--version` | Afficher le numéro de version |

La variable `DIAGRUN_HOME` change le dossier où le rapport est enregistré.

## Rester à jour

diag run **ne se connecte jamais à internet**, donc il ne vérifie pas tout seul s'il existe une nouvelle version. Deux choses à faire :

1. **Relance toujours avec `npx diagrun@latest`** : tu as alors la dernière version à chaque fois, sans rien installer.
2. **Surveille le dépôt pour être prévenu** : en haut de cette page GitHub, clique sur **Watch**, puis **Custom**, coche **Releases** et valide. GitHub t'enverra un message à chaque nouvelle version, sans te spammer.

Pour savoir quelle version tu utilises, regarde le bas du rapport (« diag run v… ») ou tape `npx diagrun@latest --version`.

## Confidentialité

- diag run lit uniquement les fichiers de sessions de Claude Code qui sont **déjà sur ton ordinateur** (dans `~/.claude/projects`).
- Il écrit un seul fichier : le rapport HTML.
- **Aucune donnée n'est envoyée nulle part.** Il n'y a aucun appel réseau.
- Attention : le rapport peut afficher le début de certaines de tes demandes (dans les exemples). **Relis-le avant d'en partager une capture.**

## À savoir sur les chiffres

- Les montants sont des **estimations** basées sur les tarifs publics, que tu peux modifier en tête de `cli.js` (variable `PRICES`). Sur un abonnement, lis-les comme des parts de consommation plutôt que comme des euros.
- Le classement des tâches (simple, moyenne, complexe) repose sur des règles simples, pas sur de l'intelligence artificielle. C'est une indication, pas un verdict.
- La carte « Si tu avais suivi ces conseils » est une projection prudente. Haiku peut faire un peu moins bien qu'Opus, et repartir de zéro oblige à réexpliquer.
- Pour vérifier ces chiffres dans Claude Code même, tape `/usage` (tokens par modèle) et `/context` (ce qui remplit ta conversation).

## Signaler un problème ou une idée

Ouvre une « issue » sur ce dépôt. Si une de tes demandes est mal classée, décris simplement le type de tâche (sans contenu privé) : ça aide à améliorer les règles.

## Licence

MIT. Fait par François Nollet.
