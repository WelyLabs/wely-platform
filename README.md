# Wely Calendar

> Réseau social de calendrier partagé, construit comme un terrain d'exploration de la **programmation réactive** et de l'**architecture microservices**.

Les utilisateurs créent des événements, s'abonnent à ceux de leurs amis et discutent en temps réel. La fonctionnalité est un prétexte : l'objet du projet est la mise en œuvre bout en bout d'une plateforme distribuée — architecture hexagonale, persistance polyglotte, communication événementielle, messagerie RSocket, déploiement GitOps.

Projet personnel, écrit intégralement à la main.

---

## Sommaire

- [Aperçu](#aperçu)
- [Architecture](#architecture)
- [Choix techniques](#choix-techniques)
- [Les dépôts](#les-dépôts)
- [Démarrage local](#démarrage-local)
- [CI/CD](#cicd)
- [Ce que ce projet m'a appris](#ce-que-ce-projet-ma-appris)
- [Limites connues](#limites-connues)

---

## Aperçu

| | |
|---|---|
| **Backend** | Java 25 · Spring Boot 4 · Spring WebFlux · Project Reactor |
| **Temps réel** | RSocket over WebSocket |
| **Événementiel** | Apache Kafka · Spring Cloud Stream |
| **Persistance** | PostgreSQL (R2DBC) · MongoDB réactif · Neo4j réactif |
| **Identité** | Keycloak · OIDC · mapper de protocole custom |
| **Frontend** | Angular 21 · Angular Material · Tailwind |
| **Infrastructure** | Kubernetes · Kustomize · ArgoCD · Sealed Secrets · Cloudflare Tunnel |
| **Qualité** | JUnit 5 · Mockito · Reactor Test · Vitest · SonarCloud · JaCoCo |
| **Livraison** | GitHub Actions · semantic-release · GHCR |

**Les chemins de requête sont non bloquants de bout en bout** : pas de `.block()`, pas de pool de threads par requête, et les quatre bases sont accédées par des drivers réactifs. La seule exception est un `DatabaseSeeder` de jeu d'essai, actif uniquement en profil local.

---

## Architecture

```mermaid
graph TB
    subgraph client["Navigateur"]
        FE["<b>wely-web</b><br/>Angular 21"]
    end

    subgraph edge["Edge"]
        GW["<b>wely-gateway</b> :8081<br/>Spring Cloud Gateway<br/><i>validation JWT · CORS · routage</i>"]
        KC["<b>Keycloak</b> :8080<br/><i>OIDC + BusinessIdMapper</i>"]
    end

    subgraph services["Services métier"]
        U["<b>wely-users</b> :8082<br/><i>profils · identité</i>"]
        S["<b>wely-social</b> :8083<br/><i>graphe d'amitié</i>"]
        C["<b>wely-chat</b> :8084<br/><i>messagerie RSocket</i>"]
        E["<b>wely-events</b> :8086<br/><i>événements · feed</i>"]
    end

    subgraph data["Persistance"]
        PG[("PostgreSQL<br/>R2DBC")]
        NEO[("Neo4j")]
        MG1[("MongoDB<br/>chat")]
        MG2[("MongoDB<br/>events")]
    end

    K{{"<b>Kafka</b><br/>USER_CREATED<br/>MESSAGE_BROADCAST"}}

    FE -->|"REST · /api/v1/*"| GW
    FE -->|"RSocket · /rsocket"| GW
    FE -.->|"OIDC"| KC
    KC -.->|"JIT provisioning"| U

    GW --> U & S & C & E

    U --> PG
    U -->|"produit"| K
    K -->|"consomme"| S
    C <-->|"diffuse et consomme"| K
    S --> NEO
    C --> MG1
    E --> MG2
```

### Architecture interne — hexagonale

Les quatre services métier suivent la même structure. Le domaine ne connaît ni Spring, ni la base, ni le protocole. La gateway en est exclue : elle route, elle n'a pas de domaine.

```
                    ┌─────────────────────────────────┐
   HTTP / RSocket   │          application/           │
        ────────────▶   rest · dtos · mappers         │
                    └───────────────┬─────────────────┘
                                    │ appelle
                    ┌───────────────▼─────────────────┐
                    │            domain/              │
                    │   models  ·  services           │
                    │                                 │
                    │   ports/  ◀── interfaces        │
                    │     UserRepository              │  ← le domaine DÉCLARE
                    │     IdentityProvider            │    ce dont il a besoin
                    │     UserEventPublisher          │
                    └───────────────▲─────────────────┘
                                    │ implémente
                    ┌───────────────┴─────────────────┐
                    │        infrastructure/          │
                    │  persistence · messaging        │  ← l'infra S'ADAPTE
                    │  identity     · adapters        │
                    └───────────────┬─────────────────┘
                                    ▼
                          PostgreSQL · Kafka · Keycloak
```

Les services de domaine sont des **POJO sans annotation Spring**, instanciés explicitement :

```java
@Configuration
public class UsersApplicationConfig {
    @Bean
    public UserService userService(UserRepository repository,
                                   IdentityProvider identityProvider,
                                   UserEventPublisher publisher) {
        return new UserService(repository, identityProvider, publisher);
    }
}
```

C'est volontairement plus verbeux qu'un `@Service`. En contrepartie, le domaine se teste sans contexte Spring, et l'inversion de dépendance est réelle plutôt que déclarative.

### Flux d'authentification — provisioning JIT

Le problème : Keycloak connaît un utilisateur par son UUID d'IdP, l'application par son identifiant métier. Comment éviter que chaque service traduise l'un en l'autre à chaque requête ?

```mermaid
sequenceDiagram
    participant FE as wely-web
    participant KC as Keycloak
    participant M as BusinessIdMapper
    participant U as wely-users
    participant K as Kafka
    participant S as wely-social

    FE->>KC: authentification OIDC
    KC->>M: émission du token
    M->>M: attribut "businessId" en cache ?
    alt première connexion
        M->>U: GET /profile/resolve/{keycloakId}
        U->>U: création de l'utilisateur + hashtag unique
        U->>K: publie USER_CREATED
        U-->>M: businessId (UUID)
        M->>KC: mémorise l'attribut sur l'utilisateur
        K->>S: consomme → crée le nœud Neo4j
    end
    M-->>KC: claim businessId
    KC-->>FE: access token (avec businessId)
    Note over FE,U: toute requête suivante porte l'identité métier
```

Un **mapper de protocole Keycloak custom** ([`BusinessIdMapper`](wely-identity/plugins/business-id-mapper/)) injecte l'identifiant métier directement dans le token. Les services lisent `jwt.getClaimAsString("businessId")` et ne font jamais confiance à un identifiant reçu du client.

La création de l'utilisateur est donc **paresseuse** : elle se déclenche à la première émission de token, pas via un webhook ni un batch de synchronisation.

### Validation du JWT derrière un ingress

Chaque service valide les tokens en dissociant deux URL :

```properties
# récupération des clés : service Keycloak interne au cluster
spring.security.oauth2.resourceserver.jwt.jwk-set-uri=${KEYCLOAK_INTERNAL_JWK_SET_URI}
# validation de l'émetteur : URL publique, celle qui figure dans le token
spring.security.oauth2.resourceserver.jwt.issuer-uri=${KEYCLOAK_ISSUER_URI}
```

Sans cette dissociation, soit le service sort du cluster pour récupérer les clés à chaque rotation, soit la validation de l'`iss` échoue parce que l'URL interne ne correspond pas à celle inscrite dans le token.

---

## Choix techniques

### Une base par service, choisie pour la forme de la donnée

| Service | Base | Raison |
|---|---|---|
| **users** | PostgreSQL / R2DBC | Données relationnelles, contrainte d'unicité `(user_name, hashtag)` garantie par la base |
| **social** | Neo4j | « amis d'amis », statut relationnel bidirectionnel, suggestions : requêtes de graphe naturelles en Cypher, pénibles en SQL |
| **chat** | MongoDB | *Bucket pattern* — voir ci-dessous |
| **events** | MongoDB | Documents autonomes, schéma souple, pas de jointure |

### Le bucket pattern pour les messages

Un document par message crée des dizaines de milliers de documents par conversation et rend la pagination coûteuse. Les messages sont donc groupés par **50 dans un document `MessageBucket`** :

```
conversations                     message_buckets
┌──────────────────┐              ┌────────────────────────────┐
│ _id              │              │ conversationId  bucketIndex│
│ participantIds[] │◀────────────▶│ messages[ 50 ]             │
│ lastMessage      │              └────────────────────────────┘
│ updatedAt        │              bucket 0 → messages 1 à 50
└──────────────────┘              bucket 1 → messages 51 à 100
```

Charger une conversation = lire **un** document (le dernier bucket). Remonter l'historique = décrémenter `bucketIndex`. Les noms de champs sont abrégés au stockage (`s_id`, `s_un`, `txt`, `ts`) pour réduire la taille des documents, et remappés vers des noms explicites par la couche de persistance.

### Kafka pour la cohérence inter-services

`wely-users` ne connaît pas `wely-social`. Il publie `USER_CREATED`, et le service social matérialise le nœud de son côté. Le couplage est un contrat d'événement, pas un appel HTTP.

```
wely-users ──▶ USER_CREATED ──▶ wely-social ──▶ nœud Neo4j
     (Postgres)          (topic Kafka)                             (graphe)
```

### RSocket plutôt que WebSocket brut

RSocket apporte le modèle `request/stream` et la **contre-pression native** : le client déclare sa demande, le serveur ne l'inonde pas. C'est cohérent avec Reactor de bout en bout, là où un WebSocket brut aurait imposé de réinventer le protocole applicatif.

---

## Les dépôts

Le projet est réparti en 8 dépôts indépendants, chacun avec son CI/CD et son cycle de release.

| Dépôt | Rôle |
|---|---|
| [`wely-web`](https://github.com/WelyLabs/wely-web) | Frontend Angular 21 |
| [`wely-gateway`](https://github.com/WelyLabs/wely-gateway) | API Gateway — point d'entrée unique |
| [`wely-users`](https://github.com/WelyLabs/wely-users) | Profils, identité, producteur Kafka |
| [`wely-social`](https://github.com/WelyLabs/wely-social) | Graphe social Neo4j, consommateur Kafka |
| [`wely-chat`](https://github.com/WelyLabs/wely-chat) | Messagerie temps réel RSocket |
| [`wely-events`](https://github.com/WelyLabs/wely-events) | Événements et abonnements |
| [`wely-identity`](https://github.com/WelyLabs/wely-identity) | Realm Keycloak + plugin `BusinessIdMapper` |
| [`wely-gitops-infra`](https://github.com/WelyLabs/wely-gitops-infra) | Manifestes Kustomize, applications ArgoCD |

Chaque dépôt a son propre README détaillant son architecture interne, ses endpoints et sa configuration.

---

## Démarrage local

### Prérequis

Java 25 · Node 20+ · Docker

### Option A — tout le cluster en une commande *(recommandé)*

Prérequis : un Kubernetes local — [OrbStack](https://orbstack.dev/), Docker Desktop, Minikube ou k3d.

```bash
cd wely-gitops-infra
kubectl apply -k overlays/local --server-side
```

Déploie les quatre bases, Keycloak, la gateway, le frontend et les quatre microservices, avec des secrets locaux préconfigurés.

| | |
|---|---|
| Frontend | http://localhost |
| Keycloak | http://localhost:8080 *(admin / admin)* |
| Gateway | http://localhost:8081 |

```bash
kubectl delete -k overlays/local        # nettoyage
```

### Option B — services en local, Keycloak en conteneur

Pour développer sur un service en particulier.

```bash
docker compose up -d      # Keycloak, avec import automatique du realm
```

> Le `docker-compose.yml` ne démarre que Keycloak : les bases doivent être lancées séparément. Un compose complet est le prochain chantier (voir [Limites connues](#limites-connues)).

Puis chaque service, avec le profil `dev` :

```bash
cd wely-gateway   && ./mvnw spring-boot:run -Dspring-boot.run.profiles=dev
cd wely-users && ./mvnw spring-boot:run -Dspring-boot.run.profiles=dev
# … idem pour social, chat, events
```

Et le frontend :

```bash
cd wely-web
npm ci --legacy-peer-deps
npm start                 # http://localhost:4200
```

### Ports

| | |
|---|---|
| 4200 | Frontend |
| 8080 | Keycloak |
| 8081 | Gateway |
| 8082 | wely-users |
| 8083 | wely-social |
| 8084 | wely-chat (HTTP + RSocket) |
| 8086 | wely-events |

---

## CI/CD

```mermaid
graph LR
    A["push sur dev"] --> B["CI<br/>build · test · JaCoCo"]
    B --> C["SonarCloud"]
    C --> D["image Docker<br/>→ GHCR"]
    D --> E["CD<br/>kustomize edit set image"]
    E --> F["commit sur<br/>wely-gitops-infra"]
    F --> G["ArgoCD<br/>sync automatique"]
    G --> H["Kubernetes"]
```

Le déploiement suit un **modèle GitOps pull** : la CD ne parle jamais au cluster. Elle met à jour le tag d'image dans le dépôt d'infrastructure, et ArgoCD — qui surveille ce dépôt avec `selfHeal: true` — réconcilie l'état réel. Le dépôt Git est la seule source de vérité ; une modification manuelle du cluster est automatiquement annulée.

Le versionnement est assuré par **semantic-release** à partir des Conventional Commits.

---

## Ce que ce projet m'a appris

**Le réactif est contagieux, et c'est le but.** Un seul appel bloquant dans une chaîne suffit à immobiliser un thread de l'event loop et à annuler le bénéfice de tout le reste. Écrire quatre services métier sans jamais recourir à `.block()` sur un chemin de requête oblige à penser en flux plutôt qu'en séquence d'instructions.

**Ne jamais souscrire à un flux que le framework doit piloter.** Appeler `.subscribe()` soi-même dans un consumer Spring Cloud Stream retire au framework la gestion de l'acquittement et de la reprise : les erreurs deviennent invisibles et les messages sont perdus en silence. C'est l'erreur que j'ai mis le plus longtemps à comprendre.

**L'architecture hexagonale coûte cher en frappe et se rembourse au test.** Tester `UserService` ne demande ni base, ni broker, ni contexte Spring — trois implémentations d'interfaces suffisent.

**La persistance polyglotte n'est justifiée que par la forme des requêtes.** Le graphe social en SQL était faisable ; en Cypher, la requête de statut relationnel bidirectionnel tient en huit lignes lisibles. À l'inverse, mettre les utilisateurs dans Mongo aurait fait perdre la contrainte d'unicité `(user_name, hashtag)` garantie par la base.

**GitOps déplace le problème au bon endroit.** Passer de « la CD déploie » à « la CD met à jour un fichier, et le cluster se réconcilie » rend l'état du système lisible dans un dépôt Git plutôt que dans l'historique d'un pipeline.

---

## Limites connues

Ce projet est un terrain d'apprentissage ; ces points sont identifiés et suivis, pas ignorés.

| Limite | Détail |
|---|---|
| **La diffusion des messages est au mieux-effort** | `wely-chat` tourne à deux réplicas et diffuse par Kafka, chaque pod formant son propre groupe de consommation pour recevoir tous les enregistrements. La livraison temps réel n'est pas garantie pour autant : le message est en base avant d'être diffusé, et un client qui a raté une frame recharge la conversation. Une garantie *at-least-once* demanderait un outbox côté producteur. |
| **Pas de pagination sur la recherche d'utilisateurs** | La requête Cypher parcourt tous les nœuds `User` et le filtrage est fait côté client. À remplacer par une recherche serveur paginée et indexée. |
| **Pas de tests d'intégration** | Les quatre bases et Kafka sont mockés. Les requêtes Cypher et R2DBC ne sont jamais vérifiées contre un vrai moteur. Testcontainers est le prochain chantier. |
| **Keycloak n'a pas de probes et il n'y a pas de `NetworkPolicy`** | Les six services applicatifs exposent Actuator et portent `startupProbe` / `livenessProbe` / `readinessProbe`, des `resources` et un `securityContext` non-root. Keycloak attend que son image soit épinglée, et rien ne restreint encore les communications entre pods. |
| **Les seuils de résilience de la gateway sont uniformes** | Un circuit breaker Resilience4j et un quota Redis par appelant protègent les cinq routes, mais avec la même configuration pour toutes — alors que `wely-social` interroge Neo4j et `wely-users` PostgreSQL, dont les latences normales diffèrent. À différencier quand il existera des mesures. |
| **Pas d'outbox transactionnel** | Si la publication de `USER_CREATED` échoue après le commit Postgres, l'utilisateur existe sans nœud social et rien ne rattrape. |
| **Démarrage local** | Le chemin complet passe par un Kubernetes local ; le `docker-compose.yml` ne lance que Keycloak. Un compose complet reste à écrire pour ceux qui n'ont pas de cluster. |

---

## Licence

Projet personnel à but pédagogique.
