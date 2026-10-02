# Atelier Cloud

<div align="center">

![Status](https://img.shields.io/badge/status-demo%20ready-success)
![Stripe](https://img.shields.io/badge/Stripe-Checkout-635BFF)
![Node](https://img.shields.io/badge/Node.js-20+-339933)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15-336791)
![Slack](https://img.shields.io/badge/Slack-Webhooks-4A154B)

</div>

Une démonstration SaaS de facturation avec Stripe Checkout, webhooks signés, PostgreSQL et notifications Slack.

> Mode test uniquement. Ne jamais utiliser de vraie clé Stripe en production dans ce projet.

## 1) Vue d'ensemble

### Ce projet montre

- un parcours de vente SaaS simple et crédible
- un paiement subscriptionnel sécurisé via Stripe Checkout
- un webhook Stripe vérifié et traité correctement
- une base PostgreSQL pour sécuriser les événements et éviter les doublons
- un flux de notification Slack réaliste avec retry et outbox
- un dashboard opérationnel alimenté par Stripe et les événements traités localement

### À retenir en 10 secondes

- Front de vente : oui
- Paiement sécurisé : oui
- Webhook vérifié : oui
- Persistance transactionnelle : oui
- Notification Slack : oui
- Présentation premium : oui

### Stack technique

- Node.js + Express + TypeScript
- Stripe Checkout + Stripe Webhooks
- PostgreSQL
- Slack Incoming Webhooks
- Vitest pour les tests unitaires

Cette application montre un flux complet d'abonnement :

- une landing page de produit avec deux offres : Starter et Pro
- création d'une session Stripe Checkout côté serveur
- validation cryptographique des webhooks Stripe
- persistance PostgreSQL avec protection contre les doublons
- worker asynchrone qui envoie une notification dans Slack
- dashboard d'administration pour visualiser le produit et les paiements

## 2) Architecture

```text
Navigateur
   │
   ├─ Choisit Starter ou Pro
   │
   ▼
Express API
   │  POST /api/v1/checkout/sessions
   ▼
Stripe Checkout (mode test)
   │
   ├─ succès : /?checkout=success
   └─ retour sans paiement : /?checkout=cancelled&cancel_token=...

Webhook Stripe
   │  POST /api/v1/webhooks/stripe
   ▼
Validation signature + raw JSON
   │
   ├─ INSERT processed_events
   ├─ INSERT notification_outbox
   ▼
Worker PostgreSQL / Slack
   │
   └─ Slack Incoming Webhook

Retour du client après Checkout
   │  POST /api/v1/checkout/cancellations
   └─ vérification de la session Stripe + notification Slack idempotente
```

## 3) Ce qui est inclus

### Frontend
- page d'accueil premium
- 2 plans : Starter 10 €/mois, Pro 30 €/mois
- messages de succès / annulation
- bouton vers le dashboard

### Backend
- route API `/api/v1/checkout/sessions`
- route API `/api/v1/webhooks/stripe`
- route de santé `/api/v1/health`
- route dashboard `/api/v1/dashboard`

### Base de données
- table `processed_events` pour l'idempotence
- table `notification_outbox` pour les notifications en file
- table `checkout_cancellations` pour relier le retour Checkout à la session et éviter les notifications en double

### Intégrations
- Stripe Checkout
- Stripe webhooks signés
- PostgreSQL
- Slack Incoming Webhook

## 4) Structure du projet

```text
.
├── public/
│   ├── index.html
│   └── dashboard.html
├── src/
│   ├── app.ts
│   ├── app.test.ts
│   ├── config.ts
│   ├── outbox.ts
│   ├── plans.ts
│   ├── server.ts
│   ├── slack.ts
│   └── slack.test.ts
├── sql/
│   └── schema.sql
├── docker-compose.yml
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
├── README.md
└── requirements.txt
```

## 5) Prérequis

- Node.js 20+
- npm
- Docker + Docker Compose
- Stripe CLI
- compte Stripe en mode test
- workspace Slack avec Incoming Webhook

Vérification rapide :

```bash
node --version
npm --version
docker compose version
stripe --version
```

## 6) Démarrage rapide

### 1. Installer les dépendances

```bash
npm install
cp .env.example .env
```

### 2. Lancer PostgreSQL

```bash
docker compose up -d postgres
docker compose exec -T postgres psql -U billing -d billing < sql/schema.sql
```

### 3. Configurer les variables d'environnement

Exemple de `.env` :

```dotenv
PORT=3000
DATABASE_URL=postgres://billing:billing@localhost:5432/billing
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
APP_BASE_URL=http://localhost:3000
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx
OUTBOX_POLL_INTERVAL_MS=1500
```

### 4. Démarrer le serveur

```bash
npm run dev
```

Puis ouvrir :

- http://localhost:3000
- http://localhost:3000/dashboard

## 7) Configuration Stripe

### Clés Stripe

- `STRIPE_SECRET_KEY` : clé secrète de test, type `sk_test_...`
- `STRIPE_WEBHOOK_SECRET` : secret renvoyé par Stripe CLI (`whsec_...`)

### Lancer le listener Stripe

Dans un terminal séparé :

```bash
stripe login
stripe listen --forward-to localhost:3000/api/v1/webhooks/stripe --events checkout.session.completed,checkout.session.expired,invoice.payment_succeeded,customer.subscription.deleted
```

Le clic sur le bouton de retour de Checkout redirige vers l'application et déclenche une notification locale en file d'attente. Ce retour n'est pas un webhook Stripe. `checkout.session.expired` est, lui, le webhook Stripe envoyé quand une session expire ; les deux chemins sont dédupliqués.

Cette commande affiche un secret webhook local. Copiez-le dans `.env`.

## 8) Configuration Slack

1. Créer une Slack app en mode test
2. Activer Incoming Webhooks
3. Choisir un canal de test
4. Copier l'URL générée dans `SLACK_WEBHOOK_URL`

> Ne pas publier cette URL dans Git ou dans un message public.

## 9) Flux de démonstration

### Paiement de test

1. Ouvrir la page d'accueil
2. Choisir Starter ou Pro
3. Utiliser la carte Stripe de test : `4242 4242 4242 4242`
4. Valider le paiement
5. Vérifier les redirections et les messages de statut

Pour tester une annulation, retourner au site depuis Stripe Checkout : une notification `Checkout abandonné` est mise en file dans l'outbox Slack après vérification de la session auprès de Stripe.

### Vérification du webhook

Vous pouvez observer :

- le terminal `stripe listen`
- le terminal du serveur Node
- le canal Slack dédié
- la base PostgreSQL

## 10) Endpoints principaux

| Route | Description |
| --- | --- |
| `GET /` | Landing page SaaS |
| `GET /dashboard` | Dashboard d'activité |
| `GET /api/v1/health` | Vérifie que le service et PostgreSQL répondent |
| `POST /api/v1/checkout/sessions` | Crée une session Stripe Checkout |
| `POST /api/v1/checkout/cancellations` | Vérifie un retour Checkout non payé et met une notification Slack en file |
| `POST /api/v1/webhooks/stripe` | Reçoit et valide les événements Stripe |

## 11) État de la logique métier

### Tableau de bord
Le dashboard interroge l'API Stripe et affiche les factures payées, le revenu mensuel encaissé, les abonnements actifs et les checkouts abandonnés. Ce dernier indicateur vient de `checkout_cancellations.notified_at` et compte une seule fois les retours Checkout vérifiés ou les sessions expirées. La période couvre les mois calendaires d'octobre à octobre et s'actualise automatiquement chaque minute. Les événements traités et l'état des notifications viennent de PostgreSQL ; aucune série de démonstration n'est ajoutée.

### Idempotence
Le système protège les événements Stripe contre les doublons :

- `processed_events` : clé unique sur `stripe_event_id`
- `notification_outbox` : permet de relancer les notifications en sécurité

## 12) Tests et vérification

```bash
npm test
npm run build
```

Les tests couvrent :
- plan invalide
- signature Stripe invalide
- webhook valide et persistance
- message Slack généré

## 13) Dépannage rapide

### Le serveur ne démarre pas
- vérifier la présence de `.env`
- vérifier `DATABASE_URL` et `STRIPE_SECRET_KEY`
- relancer le serveur après modification des variables

### PostgreSQL refusé
```bash
docker compose ps
docker compose logs postgres
```

### Webhook invalid signature
- vérifier le bon `STRIPE_WEBHOOK_SECRET`
- s'assurer d'utiliser le secret de la source active (`stripe listen` ou dashboard Stripe)
- redémarrer le serveur Node

### Aucun message Slack
- vérifier `SLACK_WEBHOOK_URL`
- vérifier le canal Slack correspondant
- vérifier les logs du worker et la table `notification_outbox`

## 14) Sécurité et limites

- utiliser le mode test Stripe uniquement
- garder les secrets dans `.env` local
- ne jamais committer `.env`
- ne pas exposer les clés directement dans le code
- la démo ne remplace pas un vrai système de billing SaaS complet

## 15) Ressources utiles

- [Stripe Checkout](https://docs.stripe.com/checkout)
- [Stripe webhooks](https://docs.stripe.com/webhooks)
- [Stripe CLI](https://docs.stripe.com/stripe-cli)
- [Slack webhooks](https://api.slack.com/messaging/webhooks)

## 16) Résumé

Ce projet montre comment construire un SaaS minimal, fiable et visuel autour d'un abonnement Stripe :

- front de vente
- checkout secure
- webhook validé
- stockage transactionnel
- notifications Slack
- dashboard de pilotage

C'est une base idéale pour un démonstrateur technique, un portfolio, ou une preuve de concept de billing SaaS.
