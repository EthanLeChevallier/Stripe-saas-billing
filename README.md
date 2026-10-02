# Atelier Cloud | SaaS Billing, Stripe & Slack Webhooks

Ce dépôt est un démonstrateur pédagogique d'un flux de facturation par abonnement. Il met en œuvre une page légère de sélection d'offre, Stripe Checkout en mode test, un endpoint de webhook signé, une déduplication persistée dans PostgreSQL et une notification Slack Block Kit envoyée par un worker asynchrone.

> **Mode test uniquement.** Ne renseignez jamais de clé Stripe live dans ce projet. Les valeurs d'exemple ne sont pas des secrets valides. N'ajoutez pas `.env` au dépôt.

## Ce que vous allez construire

- Une page qui propose Starter à 10 €/mois et Pro à 30 €/mois.
- Une route serveur qui crée une Checkout Session Stripe en mode abonnement. Les prix sont calculés côté serveur, en centimes, et ne peuvent pas être modifiés par le navigateur.
- Un webhook qui accepte les événements Stripe après validation de leur signature cryptographique sur le corps HTTP brut.
- Une écriture PostgreSQL idempotente et transactionnelle de l'événement et de son message à envoyer.
- Un worker qui poste une notification riche dans Slack, avec reprises en cas de panne.

## Table des matières

- [Architecture](#architecture)
- [Prérequis](#prérequis)
- [Installation pas à pas](#installation-pas-à-pas)
- [Tester un paiement réel en mode test](#tester-un-paiement-réel-en-mode-test)
- [Utiliser ngrok à la place du relais Stripe CLI](#utiliser-ngrok-à-la-place-du-relais-stripe-cli)
- [Tester les événements individuellement](#tester-les-événements-individuellement)
- [Comprendre le code](#comprendre-le-code)
- [Contrat HTTP](#contrat-http)
- [Données et idempotence](#données-et-idempotence)
- [Tests, compilation et commandes](#tests-compilation-et-commandes)
- [Dépannage](#dépannage)
- [Sécurité et limites de la démonstration](#sécurité-et-limites-de-la-démonstration)
- [Documentation externe](#documentation-externe)

## Architecture

```text
Navigateur
    │ POST /api/v1/checkout/sessions
    ▼
Express ───────────────► Stripe Checkout (test)
    ▲                              │
    │ POST /api/v1/webhooks/stripe │ événements signés
    └──────────────────────────────┘
    │
    ├─ transaction PostgreSQL : processed_events + notification_outbox
    │
    └─ worker asynchrone ────────► Slack Incoming Webhook (Block Kit)
```

Express/TypeScript est retenu pour utiliser le modèle asynchrone de Node avec le SDK Stripe. La route webhook ne contacte pas Slack : elle valide et persiste rapidement, puis répond à Stripe. Le worker envoie les messages depuis l'outbox; une indisponibilité temporaire de Slack ne fait donc pas perdre l'intention de notification.

### Arborescence

```text
src/
   app.ts             Routes Express Checkout et webhook
   config.ts          Variables d'environnement et valeurs obligatoires
   outbox.ts          Insertion transactionnelle et worker de livraison
   plans.ts           Catalogue et validation des plans
   server.ts          Assemblage Stripe, PostgreSQL, Express et worker
   slack.ts           Données de notification, Block Kit et POST Slack
   app.test.ts        Tests des routes HTTP
   slack.test.ts      Test du payload et du montant affiché
public/index.html    Page française des deux offres
sql/schema.sql       Tables d'idempotence et d'outbox
docker-compose.yml   PostgreSQL local
.env.example         Modèle de configuration, sans véritables secrets
```

## Prérequis

- Node.js 20 ou supérieur et npm
- Docker Desktop ou Docker Engine avec Docker Compose
- Un compte Stripe de test et [Stripe CLI](https://docs.stripe.com/stripe-cli)
- Un workspace Slack de test où créer une URL de webhook entrant
- ngrok uniquement si vous choisissez la méthode d'exposition publique décrite plus bas

Vérifiez les outils :

```bash
node --version
npm --version
docker compose version
stripe --version
```

Le serveur local écoute par défaut le port `3000`; PostgreSQL expose le port `5432`. Si l'un de ces ports est déjà pris, modifiez `PORT` ou le port publié dans `docker-compose.yml` et adaptez les commandes suivantes.

## Installation pas à pas

### 1. Installer les dépendances et créer la configuration locale

Depuis la racine de ce dépôt :

```bash
npm install
cp .env.example .env
```

`.env` est ignoré par Git. Ouvrez-le dans votre éditeur; vous ajouterez les secrets Stripe et Slack au fil des étapes. Le serveur exige les variables `DATABASE_URL`, `STRIPE_SECRET_KEY` et `STRIPE_WEBHOOK_SECRET` au démarrage. Il est donc normal de ne pas lancer Node avant d'avoir obtenu le secret du webhook à l'étape 4.

### 2. Démarrer PostgreSQL et créer les tables

```bash
docker compose up -d postgres
docker compose ps
docker compose exec -T postgres psql -U billing -d billing < sql/schema.sql
```

La commande SQL peut être rejouée : les tables et l'index sont déclarés `IF NOT EXISTS`. Le conteneur conserve les données dans le volume Docker `billing-data` quand il est arrêté.

### 3. Créer un webhook Slack entrant

Dans les paramètres de votre workspace Slack, créez une Slack App de développement, activez **Incoming Webhooks**, puis ajoutez un webhook au canal de test. Copiez l'URL générée, de la forme `https://hooks.slack.com/services/...`, dans `SLACK_WEBHOOK_URL` du fichier `.env`.

Cette URL est un secret : ne la publiez pas dans le README, dans une capture d'écran ou dans Git. Le worker démarre même si cette variable est vide, mais les messages échoueront puis finiront en état `failed`; renseignez-la avant de tester les notifications.

### 4. Configurer Stripe CLI et récupérer le secret de signature

Dans un premier terminal :

```bash
stripe login
stripe listen --forward-to localhost:3000/api/v1/webhooks/stripe
```

La commande `stripe listen` reste active et affiche une clé de webhook temporaire ressemblant à `whsec_...`. Copiez **cette** valeur dans `STRIPE_WEBHOOK_SECRET` du fichier `.env`. Elle correspond à l'écoute locale Stripe CLI; ce n'est pas votre clé API secrète `sk_test_...`.

Dans Stripe Dashboard, activez le mode test, ouvrez **Developers > API keys** et copiez la clé secrète de test `sk_test_...` dans `STRIPE_SECRET_KEY`. N'utilisez pas une clé `sk_live_...`.

Le secret émis par Stripe CLI peut changer lorsque vous arrêtez puis relancez `stripe listen`. Si c'est le cas, remplacez `STRIPE_WEBHOOK_SECRET` dans `.env` et redémarrez le serveur Node.

### 5. Compléter `.env`

Exemple local :

```dotenv
PORT=3000
DATABASE_URL=postgres://billing:billing@localhost:5432/billing
STRIPE_SECRET_KEY=sk_test_votre_cle_de_test
STRIPE_WEBHOOK_SECRET=whsec_secret_affiche_par_stripe_listen
APP_BASE_URL=http://localhost:3000
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/votre/webhook
OUTBOX_POLL_INTERVAL_MS=1500
```

| Variable | Obligatoire | Rôle |
| --- | --- | --- |
| `PORT` | Non | Port HTTP Express; valeur par défaut `3000`. |
| `DATABASE_URL` | Oui | URL PostgreSQL; l'exemple correspond au conteneur Compose local. |
| `STRIPE_SECRET_KEY` | Oui | Clé privée Stripe **de test** utilisée par le SDK. |
| `STRIPE_WEBHOOK_SECRET` | Oui | Secret `whsec_...` associé à la source qui transmet les webhooks. |
| `APP_BASE_URL` | Non | Base utilisée pour construire les URLs de retour Checkout; par défaut `http://localhost:3000`. |
| `SLACK_WEBHOOK_URL` | Non au démarrage, nécessaire pour livrer | URL secrète du webhook entrant Slack. |
| `OUTBOX_POLL_INTERVAL_MS` | Non | Intervalle d'attente entre les interrogations du worker; valeur par défaut `1500` ms. |

Les prix ne sont pas configurés dans `.env` ni dans le Dashboard Stripe : ils sont définis dans `src/plans.ts` et intégrés à la Checkout Session par le serveur.

### 6. Démarrer le serveur

Dans un deuxième terminal, à la racine du dépôt :

```bash
npm run dev
```

Ouvrez <http://localhost:3000>. Gardez les terminaux PostgreSQL, `stripe listen` et Node ouverts pendant les essais. `tsx watch` redémarre le serveur lors des changements dans `src/`.

### 7. Faire un achat de test

1. Cliquez sur **Choisir Starter** ou **Choisir Pro**.
2. Vérifiez que la page Stripe Checkout affiche respectivement 10 € ou 30 € par mois.
3. Utilisez la carte de test Stripe `4242 4242 4242 4242`, une date d'expiration future et un CVC quelconque. Utilisez des données fictives, pas les données d'une vraie carte.
4. Validez le paiement. Stripe redirige vers `APP_BASE_URL` avec `checkout=success`.
5. Regardez le terminal `stripe listen` pour voir les événements transmis, le terminal Node pour les erreurs éventuelles, et le canal Slack pour les messages.

Ce sont des transactions de test : aucune somme réelle n'est débitée. La page confirme le retour de Checkout, mais l'application n'implémente pas de portail client ni de vue persistante d'état d'abonnement.

## Utiliser ngrok à la place du relais Stripe CLI

**Pour le premier essai, préférez `stripe listen --forward-to localhost:3000/...`** : Stripe CLI relaie les événements sans rendre votre serveur public. ngrok est une alternative lorsque Stripe doit appeler directement une URL HTTPS publique, ou lorsque vous devez tester un parcours depuis un autre appareil.

1. Démarrez l'application et exposez son port :

    ```bash
    ngrok http 3000
    ```

2. Copiez l'adresse HTTPS générée, par exemple `https://exemple.ngrok-free.app`.
3. Dans Stripe Dashboard **en mode test**, ouvrez **Developers > Webhooks**, ajoutez un endpoint à l'adresse `https://exemple.ngrok-free.app/api/v1/webhooks/stripe`, puis abonnez-le aux types suivants :
    - `checkout.session.completed`
    - `invoice.payment_succeeded`
    - `customer.subscription.deleted`
4. Affichez les détails de cet endpoint et copiez son secret de signature `whsec_...` dans `STRIPE_WEBHOOK_SECRET`.
5. Redémarrez le serveur si vous avez modifié `.env`.

Avec ngrok, mettez `APP_BASE_URL=https://exemple.ngrok-free.app` si vous voulez que Stripe Checkout revienne sur l'URL publique. Vous devrez mettre à jour cette valeur et le endpoint Stripe si l'adresse ngrok change.

Choisissez une seule route de livraison pour un même essai : soit Stripe CLI relaie les événements vers localhost, soit Stripe envoie les événements au endpoint ngrok. Configurer les deux pour le même endpoint logique peut produire des notifications en double. Le secret `whsec_...` de `stripe listen` et celui du endpoint Stripe Dashboard sont différents; utiliser le mauvais fait échouer la vérification de signature.

## Tester les événements individuellement

Avec le serveur démarré et Stripe CLI connecté, vous pouvez demander à la CLI d'émettre des événements de fixture :

```bash
stripe trigger checkout.session.completed
stripe trigger invoice.payment_succeeded
stripe trigger customer.subscription.deleted
```

Les fixtures valident le transport et le traitement, mais peuvent contenir des métadonnées ou montants génériques; elles ne reproduisent pas nécessairement un parcours complet ni un vrai lien entre Checkout, facture et abonnement. Pour vérifier les plans Starter/Pro et leurs montants, faites un achat de test depuis la page, puis utilisez le Dashboard Stripe en mode test pour examiner ou annuler l'abonnement.

Vous pouvez aussi vérifier la validation de plan sans créer une session Stripe :

```bash
curl -i http://localhost:3000/api/v1/checkout/sessions \
   -H 'content-type: application/json' \
   -d '{"plan":"enterprise"}'
```

Cette requête doit répondre `400 Bad Request`. Une requête avec `starter` ou `pro` crée une session Stripe et répond avec son URL; le navigateur suit ensuite cette URL.

N'envoyez pas un faux `curl` au webhook pour le tester : une requête sans signature cryptographique valide doit être rejetée. Utilisez Stripe CLI, le Dashboard Stripe ou un test automatisé.

## Comprendre le code

### Création de Checkout

`public/index.html` envoie seulement l'identifiant public du plan : `starter` ou `pro`. `src/app.ts` valide cet identifiant par rapport au catalogue `src/plans.ts`, puis construit une session Stripe en mode `subscription` avec une récurrence mensuelle et un montant en centimes : `1000` ou `3000`.

Le serveur ajoute `metadata.plan` à la Checkout Session **et** à l'abonnement Stripe. Ces métadonnées permettent ensuite d'identifier le plan dans les événements. Les URLs `success_url` et `cancel_url` sont construites depuis `APP_BASE_URL`. Le navigateur ne peut donc pas demander un prix arbitraire en envoyant un montant différent.

### Validation et persistance du webhook

La route `/api/v1/webhooks/stripe` utilise `express.raw({ type: 'application/json' })`. Il ne faut pas placer un `express.json()` global avant cette route : parser ou reformater le JSON change les octets qui servent à vérifier la signature. Le code transmet le buffer reçu, l'en-tête `stripe-signature` et `STRIPE_WEBHOOK_SECRET` à `stripe.webhooks.constructEvent`.

- En-tête manquant ou signature invalide : réponse `400`, aucune écriture en base.
- Événement valide mais non géré : réponse `200` avec `ignored: true`.
- Événement géré : l'identifiant Stripe est inséré dans `processed_events`; si c'est une première livraison, le payload Slack est inséré dans `notification_outbox` dans la **même transaction PostgreSQL**.
- Événement reçu à nouveau : la clé primaire empêche une seconde insertion, aucune autre notification n'est mise en file, et le webhook répond `200` avec `duplicate: true`.

Les trois types traités sont `checkout.session.completed`, `invoice.payment_succeeded` et `customer.subscription.deleted`.

### Notification Slack

`src/slack.ts` fabrique un payload Block Kit qui contient le statut, le nom du plan, le montant formaté en devise et l'identifiant Stripe du client. Le payload comprend également l'identifiant et le type d'événement pour faciliter le diagnostic. Pour une annulation, le montant affiché est le prix unitaire récurrent du plan; ce n'est pas un remboursement.

L'envoi HTTP a un délai maximal de 10 secondes. Une erreur ou une réponse Slack non-2xx est considérée comme un échec et entraîne une nouvelle tentative de l'outbox.

### Exemple de message envoyé à Slack

```json
{
   "text": "Paiement recu | Pro | 30,00 €",
   "blocks": [
      {
         "type": "header",
         "text": { "type": "plain_text", "text": "Facturation SaaS · Paiement recu", "emoji": true }
      },
      {
         "type": "section",
         "fields": [
            { "type": "mrkdwn", "text": "*Statut*\nPaiement recu" },
            { "type": "mrkdwn", "text": "*Plan*\nPro" },
            { "type": "mrkdwn", "text": "*Montant*\n30,00 €" },
            { "type": "mrkdwn", "text": "*Client*\n`cus_...`" }
         ]
      },
      {
         "type": "context",
         "elements": [
            { "type": "mrkdwn", "text": "Evenement Stripe: `evt_...` · `invoice.payment_succeeded`" }
         ]
      }
   ]
}
```

Les accents dans le texte du payload réel peuvent dépendre des libellés du code et de la locale; l'exemple illustre sa structure et son contenu.

## Contrat HTTP

### `POST /api/v1/checkout/sessions`

Requête JSON :

```json
{ "plan": "starter" }
```

Valeurs possibles : `starter`, `pro`.

- `201 Created` : `{ "url": "https://checkout.stripe.com/..." }`
- `400 Bad Request` : identifiant de plan inconnu
- `502 Bad Gateway` : Stripe n'a pas pu créer la session

### `POST /api/v1/webhooks/stripe`

Cette route est destinée à Stripe et requiert le corps JSON brut ainsi que l'en-tête `stripe-signature` valide. Ne parsez pas puis ne sérialisez pas à nouveau le contenu avant de vérifier la signature.

- `200 OK` : événement pris en charge reçu, y compris une rediffusion déjà traitée
- `200 OK` avec `ignored: true` : type d'événement non géré
- `400 Bad Request` : signature manquante/invalide ou corps non conforme
- `500 Internal Server Error` : échec de persistance; Stripe pourra réessayer

## Données et idempotence

Le schéma `sql/schema.sql` crée deux tables :

| Table | Contenu |
| --- | --- |
| `processed_events` | Une ligne par identifiant d'événement Stripe, avec son type et son heure de traitement. La clé primaire est la barrière de déduplication. |
| `notification_outbox` | Le payload Slack, l'état de livraison, le nombre d'essais, la date de prochaine tentative, un bail de traitement, la dernière erreur et l'heure d'envoi. L'identifiant d'événement est unique et référencé vers `processed_events`. |

La transaction qui insère ces deux lignes garantit qu'un événement n'est pas marqué traité si son intention de notification n'a pas été enregistrée. L'index partiel aide le worker à retrouver les messages à traiter. Plusieurs processus worker peuvent se partager la file grâce à `FOR UPDATE SKIP LOCKED`.

États possibles d'un message :

- `pending` : disponible après sa date `next_attempt_at`;
- `processing` : réservé avec un bail d'une minute; un autre worker peut le reprendre si le bail expire;
- `sent` : Slack a répondu avec un statut HTTP de succès;
- `failed` : 12 tentatives ont échoué; le message reste dans PostgreSQL pour inspection.

Les délais de nouvelle tentative doublent à partir de 60 secondes. Après 12 tentatives, l'élément passe à `failed` au lieu d'être sélectionné automatiquement. Cette outbox est une livraison **au moins une fois** : si Slack accepte un message mais que le processus s'arrête avant d'enregistrer `sent`, le worker peut le renvoyer. L'idempotence empêche les doublons de traitement de l'événement Stripe, mais ne peut pas garantir une livraison Slack exactement une fois.

Pour inspecter les derniers messages :

```bash
docker compose exec -T postgres psql -U billing -d billing -c \
   "SELECT id, stripe_event_id, status, attempts, next_attempt_at, last_error FROM notification_outbox ORDER BY id DESC LIMIT 20;"
```

Après avoir corrigé une URL Slack ou un problème externe, vous pouvez remettre manuellement un message `failed` en file :

```sql
UPDATE notification_outbox
SET status = 'pending', attempts = 0, next_attempt_at = now(), locked_until = NULL, last_error = NULL
WHERE id = 123;
```

Exécutez cette requête avec `psql` en remplaçant `123` par l'identifiant à rejouer. Un rejeu peut créer un doublon Slack si Slack avait accepté une livraison précédente sans que l'application ait pu en enregistrer le succès.

## Tests, compilation et commandes

```bash
npm test       # lance les tests Vitest sans Stripe, Slack ou PostgreSQL réels
npm run build  # compile le serveur TypeScript dans dist/
npm start      # lance dist/server.js après configuration et compilation
npm run dev    # serveur local avec rechargement automatique
npm run test:watch
```

Les tests couvrent le rejet d'un plan inconnu, le rejet d'une signature invalide, l'écriture transactionnelle d'un événement valide et le contenu du message Slack pour une facture Pro. Ils remplacent Stripe et PostgreSQL par des mocks; ils ne remplacent pas le test d'intégration décrit plus haut.

## Dépannage

| Symptôme | Vérifications |
| --- | --- |
| Le serveur s'arrête avec `Missing required environment variable` | Vérifiez que `.env` existe à la racine, que la variable est remplie et que vous avez redémarré Node après sa modification. |
| PostgreSQL refuse la connexion | Vérifiez `docker compose ps`, le port `5432`, `DATABASE_URL` et les journaux avec `docker compose logs postgres`. |
| Erreur `relation ... does not exist` | Exécutez la commande de création du schéma SQL de l'étape 2. |
| Stripe répond `Invalid API Key` ou Checkout renvoie `502` | Utilisez la clé secrète `sk_test_...` du bon compte Stripe; ne copiez ni une clé publishable `pk_...` ni une clé live. |
| Le webhook répond `400` / `Invalid Stripe signature` | Vérifiez que le serveur utilise le `whsec_...` de la source active (`stripe listen` ou endpoint Dashboard), sans espace ajouté, puis redémarrez Node. |
| `stripe listen` voit les événements mais l'application ne les reçoit pas | Vérifiez son argument `--forward-to`, que Node écoute bien sur le port visé et que le terminal Node affiche le démarrage. |
| La page affiche une erreur de création de session | Consultez le terminal Node; vérifiez `STRIPE_SECRET_KEY`, l'accès réseau et que les montants/paramètres Stripe sont valides. |
| Le paiement marche mais aucun message Slack n'arrive | Vérifiez `SLACK_WEBHOOK_URL`, le canal lié à l'URL, `docker compose exec ...` sur l'outbox et les erreurs de livraison dans `last_error`. |
| La table d'outbox reste `pending` | Vérifiez que Node est démarré : le worker tourne dans le processus serveur. Vérifiez également les logs pour une panne PostgreSQL ou Slack. |
| Le message est `failed` | Corrigez Slack, inspectez `last_error`, puis remettez le message en file avec la requête SQL ci-dessus si vous souhaitez le rejouer. |
| La commande `stripe trigger` affiche un plan inconnu | Les fixtures CLI ont souvent des métadonnées différentes du vrai parcours. Faites un achat par Checkout pour vérifier le plan réel. |
| Stripe revient vers la mauvaise adresse après paiement | Corrigez `APP_BASE_URL` pour qu'il corresponde à l'adresse depuis laquelle vous utilisez la page, puis redémarrez. |

Pour examiner les journaux des services :

```bash
docker compose logs -f postgres
```

Le terminal de `stripe listen` affiche son propre journal de transfert; les erreurs du handler et du worker s'affichent dans le terminal Node.

## Arrêter et réinitialiser l'environnement

Arrêter PostgreSQL sans supprimer ses données :

```bash
docker compose down
```

Redémarrer ensuite avec `docker compose up -d postgres`; le schéma et le volume sont conservés. **Attention :** la commande suivante supprime également le volume de données PostgreSQL et toutes les lignes d'événements/outbox locales :

```bash
docker compose down -v
```

Arrêtez Stripe CLI avec `Ctrl+C` dans son terminal et le serveur Node avec `Ctrl+C` dans son terminal.

## Sécurité et limites de la démonstration

Ce dépôt montre des mécanismes ciblés, ce n'est pas un service prêt à facturer des clients réels.

- Gardez les clés Stripe et Slack dans `.env` local ou un gestionnaire de secrets. Ne les mettez pas dans le navigateur, les logs, les captures ou Git.
- Utilisez uniquement le mode test Stripe et des cartes de test.
- La signature prouve l'origine et l'intégrité du corps webhook; le corps brut doit être conservé jusqu'à `constructEvent`.
- Les prix sont définis côté serveur; ne faites jamais confiance à un prix reçu du navigateur.
- La page et l'API de création Checkout sont publiques dans cette démonstration. Une application publique devrait ajouter des protections anti-abus, du rate limiting, des règles d'accès et une validation adaptée des clients.
- La confirmation affichée dans la page est basée sur le retour navigateur de Checkout; pour des décisions métier, l'état fiable doit venir des webhooks traités, pas de la redirection.
- Il n'y a pas de connexion utilisateur, de stockage de profil client, de portail de facturation, de gestion complète de cycle de vie d'abonnement, ni d'interface opérateur.
- Le schéma est appliqué manuellement, sans migrations versionnées. Ajoutez des migrations avant tout déploiement partagé.
- Les logs sont élémentaires. Pour la production, prévoir métriques, alertes, corrélation par identifiant d'événement, rétention et alertes sur les messages `failed`.
- La stratégie de retry est simple et bornée; définissez une politique opérationnelle pour rejouer et résoudre les échecs permanents.
- Slack Incoming Webhooks ne fournit pas de clé d'idempotence pour ces messages : une livraison peut être répétée après une panne au mauvais moment.
- Une URL ngrok publique expose le serveur local sur Internet pendant que le tunnel fonctionne. Fermez le tunnel à la fin des essais.

## Documentation externe

- [Stripe Checkout](https://docs.stripe.com/checkout/quickstart)
- [Vérification des signatures de webhook Stripe](https://docs.stripe.com/webhooks/signature)
- [Stripe CLI](https://docs.stripe.com/stripe-cli)
- [Cartes de test Stripe](https://docs.stripe.com/testing)
- [Slack Incoming Webhooks](https://api.slack.com/messaging/webhooks)
- [Slack Block Kit](https://api.slack.com/block-kit)
- [Documentation ngrok](https://ngrok.com/docs)
