# cicd-updater

English: [README.md](README.md)

Signierte Updates in Eigenregie für Apps, die mit Docker Compose laufen: per Knopf in der
App oder per Befehl auf dem Host.

Ihre CI baut die Images der App, startet sie einmal als Smoke-Test, signiert sie und
veröffentlicht daneben eine signierte `release.json`. Auf jeder Installation liest ein
optionaler Sidecar-Container dieses Dokument, prüft die Signaturen, sichert die Datenbank,
installiert genau die veröffentlichten Image-Digests und prüft, ob die neue Version gesund
ist. Schlägt etwas fehl, setzt er nur dann zurück, wenn er beweisen kann, dass das sicher
ist; andernfalls hält er an, behält die Sicherung und sagt dem Betreiber genau, was zu tun
ist. Ihre App fordert Updates beim Sidecar über eine kleine HTTP-API an (in jeder Sprache,
oder mit dem TypeScript-SDK samt React-Komponenten), oder der Betreiber nutzt die CLI.
cicd-updater stammt aus dem optionalen Updater von
[Restow](https://github.com/restow-backup/restow) und wurde verallgemeinert.

Die ausführliche Dokumentation unter [docs/](docs/index.md) ist auf Englisch.

## Inhalt

- [Für wen es gedacht ist](#für-wen-es-gedacht-ist)
- [Welches Problem es löst](#welches-problem-es-löst)
- [Was es genau tut](#was-es-genau-tut)
- [Einrichtung in einem bestehenden Projekt](#einrichtung-in-einem-bestehenden-projekt)
- [Vorlage für Webanwendungen](#vorlage-für-webanwendungen)
- [Kompatibilität](#kompatibilität)
- [Sicherheit](#sicherheit)
- [FAQ in Kürze](#faq-in-kürze)
- [Dokumentation](#dokumentation)
- [Lizenz](#lizenz)

## Für wen es gedacht ist

Für Teams, die selbst gehostete Software als Docker-Compose-Stack ausliefern, auf eigene
Server oder auf die Server ihrer Kunden, und Updates wollen, die ein Admin sicher starten
kann, ohne SSH und ohne Runbook. Typische Fälle:

- **On-Premises-Ausgabe eines SaaS.** Kunden betreiben Ihre App auf eigener Hardware. Ihr
  Admin sieht in der App „Version 1.4.0 ist verfügbar“ und plant sie für heute Nacht ein.
- **Managed Service Provider und Agenturen.** Dieselbe App läuft als ein Compose-Projekt je
  Kunde. Jede Installation installiert Ihre signierten Releases, wenn ihr Admin (oder Sie)
  sie einplant.
- **Interne Werkzeuge.** Ein kleines Team betreibt eine Handvoll Apps auf einem
  Firmenserver und will bei jedem Update eine Sicherung, eine Wartungsseite und eine
  Nachvollziehbarkeit im Audit-Log.
- **Selbst gehostete Open-Source-Apps.** Die Nutzer starten `docker compose up`. Der
  optionale Sidecar gibt ihnen einen Update-Knopf, der nie ein unsigniertes Image
  installiert.

### Für wen es nicht gedacht ist

| Wenn Sie … nutzen | Nehmen Sie stattdessen |
| --- | --- |
| Kubernetes | dessen eigenes Rollout-Modell: Helm, Argo CD oder Flux, Readiness Gates |
| Docker Swarm, Nomad, mehrere Hosts oder einen entfernten Docker-Host | die Rolling Updates des Orchestrators; cicd-updater verwaltet ein Compose-Projekt auf einem Host |
| Desktop- oder Mobil-Apps | den Updater der Plattform oder den App Store |
| eine verwaltete Plattform (PaaS) | die Deployments der Plattform aus Ihrer CI |
| keine CI, die Ihre Images baut, oder keine, die signieren kann | richten Sie zuerst eine CI ein: Der Modus `key` funktioniert mit jeder CI, die einen Container ausführen kann (die `release`-CLI). Ohne CI aktualisieren Sie von Hand; der Vertrauensmodus `none` ist nur für Testinstallationen gedacht |
| eine Richtlinie, die den Docker-Socket in einem Container verbietet | Updates von Hand ([FAQ](#faq-in-kürze)) oder eigene Werkzeuge auf dem Host; der Sidecar braucht den Socket, und das lässt sich nicht einschränken |
| zustandslose Container, bei denen „neues Tag ziehen und neu starten“ genügt | einen einfacheren Registry-Beobachter; Sicherungen, Proben und Signaturen wären unnötiger Aufwand |

## Welches Problem es löst

Selbst gehostete Software hat ein Update-Problem. Installationen hinken hinterher, weil
Updates manuell und riskant sind. Update-Skripte lassen die Sicherung weg, wenn es eilt,
ziehen ein wanderndes Tag, das nicht unbedingt dem getesteten Stand entspricht, und
„setzen zurück“, indem sie ein altes Image gegen eine Datenbank starten, die die neue
Version bereits migriert hat. Die Nutzer sehen währenddessen ein nacktes `502`, und
hinterher kann niemand sagen, wer was aktualisiert hat.

Wenn es wie dokumentiert eingerichtet ist (Vertrauensmodus `keyless` oder `key`),
garantiert cicd-updater:

- **Nur signierte Releases.** Ein Release wird nur installiert, wenn `release.json` und
  jedes Image gültige Signaturen genau der Identität tragen, die Sie konfiguriert haben
  (Ihr Release-Workflow an diesem Tag oder Ihr cosign-Schlüssel). Images werden per Digest
  gezogen und als `repo:tag@sha256:...` eingetragen, sodass ein verschobenes Tag nie ändern
  kann, was läuft.
- **Nur auf Anforderung.** Jedes Update plant ein Admin oder der Betreiber ein. Der Sidecar
  installiert nie von sich aus, nie eine ältere Version und aktualisiert sich nie selbst.
- **Zuerst die Sicherung.** Die Sicherung (PostgreSQL, MySQL/MariaDB, Docker-Volumes oder
  ein eigener Befehl, optional mit age verschlüsselt) wird erstellt und geprüft, bevor
  irgendetwas gestoppt wird.
- **Vor dem Punkt ohne Wiederkehr ändert sich nichts.** Ein Fehler oder ein Abbruch,
  bevor Dienste gestoppt werden, lässt die Installation genau so, wie sie war.
- **Rollback nur, wenn er sicher ist.** Nach dem Punkt ohne Wiederkehr startet der Sidecar
  die vorige Version nur dann wieder, wenn das nachweislich sicher ist. Andernfalls stoppt
  er die App, behält die Sicherung und hinterlegt die Befehle zur Wiederherstellung
  (`needs_attention`).
- **Eine Datei, wenige Zeilen.** Er schreibt in `.env` nur die Image-Zeilen Ihrer Dienste
  (und optional eine Versionszeile), Byte für Byte genau, und sonst nichts in Ihrem
  Projekt.
- **Ein Audit-Trail.** Jede Aktion wird mit der Person, die sie angefordert hat, im Journal
  festgehalten, damit Ihre App sie genau einmal in ihr Audit-Log übernimmt.

Es leistet **nicht**:

- Updates ohne Ausfallzeit. Zwischen den Schritten `stop` und `health` sind die Dienste
  gestoppt; die Nutzer sehen vorher einen Countdown und währenddessen eine Wartungsseite.
- das eigenständige Wiederherstellen einer Datenbank. Die Wiederherstellung bleibt eine
  Entscheidung des Betreibers.
- die Beurteilung, ob ein Release gut ist. Eine Signatur belegt, woher ein Release kommt,
  nicht, dass es funktioniert; Qualitätsschranke sind der Smoke-Test in der CI und Ihre
  Health- und Smoke-Checks. Wer Ihre Signier-Pipeline kontrolliert, kann auch ein
  schlechtes Release signieren.
- eine Einschränkung dessen, was der Docker-Socket erlaubt. Der Sidecar hat auf dem Host
  faktisch Root-Rechte ([Sicherheit](#sicherheit)).
- irgendeine Prüfung im Vertrauensmodus `none`.

## Was es genau tut

cicd-updater hat drei Seiten mit einem gemeinsamen Vertrag, der signierten `release.json`:

| Seite | Was sie ist | Was sie tut |
| --- | --- | --- |
| Release-Seite | Ihre CI mit den Composite Actions (GitHub, Forgejo/Gitea) oder der `release`-CLI (jede CI) | baut die Images je Architektur, pusht sie per Digest, startet sie mit Ihrer Produktions-Compose-Datei und `.env.example` (optional mit einem Upgrade vom vorigen Release über den Sidecar selbst) und taggt, signiert und veröffentlicht sie erst dann zusammen mit einer signierten `release.json` |
| Host-Seite | der Sidecar-Container `cicd-updater` in Ihrem Compose-Projekt, optional über ein Profil | findet Releases in Ihrem Feed, prüft sie, sichert, installiert genau die veröffentlichten Digests, prüft Gesundheit und Version, setzt zurück oder hält an; liefert den lesenden öffentlichen Status für die Wartungsseite |
| App-Seite | Ihre App, in beliebiger Sprache | entscheidet, wer aktualisieren darf (Berechtigung, frische starke Anmeldung), fragt den Sidecar, übernimmt sein Journal ins Audit-Log, zeigt das Banner, meldet ihre Version nur dem Sidecar |

```
 RELEASE SIDE (CI)                       REGISTRY
 build -> smoke -> publish ----------->  multi-arch images and signatures, by digest
       -> release-json                        ^
       |                                      | verify signature, pull by digest
       | release.json + signature bundle      |
       v                                      |
 RELEASE HOST  <---- feed ----  HOST: one Compose project, internal network
 GitHub, Forgejo, GitLab        +-------------+  bearer token   +--------------------+
 releases, or a static index    | app backend | --------------> | updater sidecar    |
                                | (SDK, HTTP) | <-------------- | docker.sock, .env  |
                                +-------------+  health with    | status.json,       |
                                +-------------+  version        | backups            |
                                | edge/proxy  | <-------------- +--------------------+
                                +-------------+  public status (read-only)
                                      ^
                                      | users, maintenance page
```

### Ein Lauf, Schritt für Schritt

Jemand plant ein Release ein: sofort, in 15 Minuten oder zu einer festen Uhrzeit. Bevor
der Sidecar das annimmt, prüft er `release.json` und jede Image-Signatur in der Registry;
was sich nicht prüfen lässt, wird nie angekündigt. Während des Countdowns sieht jeder
angemeldete Nutzer ein Banner, und der Lauf lässt sich verschieben oder abbrechen. Dann
laufen die Schritte in fester Reihenfolge:

| Schritt | Was passiert |
| --- | --- |
| `prepare` | Prüft jeden Blocker (Docker, Compose, Env-Datei, Speicherplatz, Ports, das gepinnte Sidecar-Image) und prüft die gespeicherte `release.json` erneut. Lehnt das Release ab, wenn die laufende Version unter seinem Minimum liegt oder es manuelle Schritte, einen neueren Sidecar, einen fehlenden Env-Schlüssel oder eine andere Plattform verlangt. Hält das vorige Image jedes Dienstes und die vorigen `.env`-Zeilen fest. |
| `fetch` | Prüft jede Image-Signatur in einem isolierten Prüfcontainer, zieht per Digest, prüft den Digest und das Versions-Label. |
| `backup` | Liest den Ausgangswert der Migrationsprobe, erstellt die Sicherung, prüft sie und verschlüsselt sie, falls konfiguriert. |
| `stop` | **Der Punkt ohne Wiederkehr.** Stoppt die schreibenden Dienste (die API, Worker). |
| `migrate` | Optional: führt Ihren Migrationsbefehl mit dem neuen Image aus. |
| `start` | Schreibt die neuen Image-Referenzen in `.env` und startet die erste Dienstgruppe. |
| `health` | Startet die Gruppen der Reihe nach und wartet, bis die Container laufen und Ihr Health-Endpunkt die neue Version meldet. |
| `smoke` | Optionale HTTP- oder Befehls-Checks, zum Beispiel eine Seite über Ihren Edge. |
| `finish` | Wendet die Aufbewahrungsregeln der Sicherungen an und entfernt alte Images. |

Bei einer Sicherung mit stillgelegten Diensten (`backup.quiesce`, bei Volume-Sicherungen
immer) kommt `stop` vor `backup`; der Punkt ohne Wiederkehr liegt dann vor der Sicherung.

### Wie ein Lauf endet

| Ergebnis | Bedeutung | Was Sie tun |
| --- | --- | --- |
| `succeeded` | die neue Version läuft und hat Health- und Smoke-Checks bestanden | bestätigen |
| `unchanged` | Fehler (oder Abbruch) vor dem Punkt ohne Wiederkehr; nichts wurde verändert | Fehlercode lesen, beheben, erneut einplanen |
| `rolled_back` | Fehler nach dem Punkt ohne Wiederkehr; die vorige Version läuft wieder, die Daten sind nachweislich unverändert | Fehlercode lesen, beheben, erneut einplanen |
| `needs_attention` | Fehler, und eine Rückkehr war nicht sicher genug; die App ist gestoppt, die Sicherung behalten, die Wiederherstellungsbefehle hinterlegt | dem [Runbook](docs/backups-and-recovery.md#runbook-a-run-ended-in-needs_attention) folgen |

**Die Rollback-Regel.** Alten Code auf einer Datenbank zu starten, die neuer Code bereits
migriert hat, kann Daten beschädigen. Nach dem Punkt ohne Wiederkehr startet der Sidecar
die vorige Version nur dann wieder, wenn eine dieser Bedingungen gilt: Es war noch nichts
Neues gestartet; die App erklärt, dass sie kein dauerhaftes Schema hat
(`rollback.policy: always`); oder die Migrationsprobe liest denselben Wert wie vor dem
Update, gelesen bei gestoppter neuer Version (`rollback.policy: probe`). In jedem anderen
Fall endet der Lauf mit `needs_attention`. Die genaue Regel, alle Fehlercodes und die
Fortsetzung nach einem Neustart stehen in [docs/state-machine.md](docs/state-machine.md).

## Einrichtung in einem bestehenden Projekt

Der folgende Weg führt eine bestehende Compose-App bis zu ihrem ersten Update über den
Sidecar. Jeder Schritt nennt die Dateien, die Sie hinzufügen, und die Seite mit den
Einzelheiten. Der [Getting-started-Leitfaden](docs/getting-started.md) beschreibt
denselben Weg ausführlicher, und die [Beispiele](examples/) sind vollständige Projekte.

### 1. Voraussetzungen prüfen (15 Minuten)

- [ ] **Compose v2 unter Linux**, Docker Engine 24 oder neuer, amd64 oder arm64. Der
      Sidecar bringt seine eigene Docker-CLI und sein eigenes Compose mit.
- [ ] **Images aus einer CI**, und jeder Dienst, der aktualisiert werden soll, bezieht sein
      Image aus einer Variablen in `.env`: `image: ${APP_IMAGE:?set APP_IMAGE in .env}`.
- [ ] **Ein Health-Endpunkt**, der die Version melden kann (nur dem Sidecar, Schritt 4).
      Ohne ihn prüft der Sidecar nur die Container-Zustände und liest die Version aus dem
      Image-Label.
- [ ] **Eine Migrationsprobe oder keine.** Mit Datenbank: Ihr Migrationswerkzeug hat ein
      Preset (drizzle, prisma, knex, alembic, django, flyway, rails, golang-migrate,
      node-pg-migrate, typeorm, sequelize), oder Sie schreiben ein einzelnes `SELECT`.
      Ohne dauerhaftes Schema: `rollback.policy: always`.
- [ ] **Eine Sicherungsart**: `postgres`, `mysql` (auch MariaDB), `volume`, `command` oder
      `none`. Für die eingebauten Arten liegt die Datenbank im selben Compose-Projekt.

Einzelheiten: [Kompatibilität](docs/compatibility.md), [Hooks](docs/hooks.md).

### 2. Release-Seite (30 bis 60 Minuten, dazu der erste CI-Lauf)

1. Kopieren Sie den Workflow für Ihre CI und passen Sie die mit `ADJUST` markierten Zeilen
   an:

   | CI | Vorlage | Vertrauensmodus |
   | --- | --- | --- |
   | GitHub Actions | [templates/github/release.yml](templates/github/release.yml) nach `.github/workflows/release.yml` | `keyless` |
   | Forgejo / Gitea Actions | [templates/forgejo/release.yml](templates/forgejo/release.yml) nach `.forgejo/workflows/release.yml` | `key` |
   | GitLab CI | [templates/gitlab/.gitlab-ci.yml](templates/gitlab/.gitlab-ci.yml) | `keyless` |

2. Legen Sie `.cicd-updater/release-policy.yaml` an (die Upgrade-Bedingungen, die mit dem
   Code reviewt werden), führen Sie jede Compose-Variable in `.env.example` auf und
   ergänzen Sie eine kleine `docker-compose.smoke.yml`, die den Health-Endpunkt auf dem
   Loopback des Runners veröffentlicht.
3. Wählen Sie den Vertrauensmodus. Er wird auf beiden Seiten gesetzt und fällt nie auf
   einen schwächeren zurück:

   | Modus | Vertrauensanker | Einsatz |
   | --- | --- | --- |
   | `keyless` | die OIDC-Identität Ihres Release-Workflows am genauen Tag, im öffentlichen Log von Sigstore | GitHub Actions, GitLab CI |
   | `key` | ein cosign-Schlüsselpaar; die CI hat den privaten, der Host den öffentlichen Schlüssel | Forgejo/Gitea, jede andere CI, private Infrastruktur |
   | `none` | nichts: Wer Ihr Release-Dokument ändern kann, bestimmt, was neben dem Docker-Socket läuft | nur Testinstallationen; muss ausdrücklich bestätigt werden und wird bei jedem Lauf angezeigt |

4. Pushen Sie ein Tag `v1.0.0`. Bevor der Smoke-Test bestanden ist, wird nichts in der
   Registry getaggt und kein Release veröffentlicht.

Einzelheiten: [Release-Seite](docs/release-side.md), [Vertrauensmodi](docs/trust-modes.md),
[release.json](docs/release-json.md), CI-Leitfäden für [GitHub](docs/ci/github.md),
[GitLab](docs/ci/gitlab.md) und [Forgejo](docs/ci/forgejo.md).

### 3. Host-Seite (30 Minuten)

1. Fügen Sie Ihrer Compose-Datei den Dienst `updater` hinzu, im Profil `updater`, mit dem
   Docker-Socket, dem Projektverzeichnis unter demselben Pfad, den Volumes `/state`,
   `/shared` (das Token) und `/verify`, dem internen Netz und ohne `ports:`. Die
   [Vorlage für Webanwendungen](templates/web-app/compose/docker-compose.updater.yml)
   enthält ihn als kommentiertes Fragment.
2. Binden Sie das Token-Volume schreibgeschützt in Ihr Backend ein, und nur dort:
   `updater-shared:/run/cicd-updater:ro`.
3. Legen Sie `updater.yaml` ins Projektverzeichnis: Feed, Vertrauensidentität, die
   verwalteten Dienste und die `.env`-Schlüssel, aus denen sie lesen, Sicherung, Probe,
   Health ([kommentierte Vorlage](templates/web-app/updater.yaml)). Prüfen Sie die Datei
   offline mit `docker compose run --rm --no-deps updater config check`.
4. Setzen Sie die Image-Variablen in `.env` einmalig von Hand auf die per Digest
   gepinnten Referenzen von `v1.0.0` (`<repository>:<tag>@sha256:<digest>`, aus dessen
   `release.json`).
5. Prüfen Sie das Sidecar-Image mit cosign und pinnen Sie seinen Digest
   ([Upgrade des Updaters](docs/upgrading-the-updater.md)):

   ```sh
   cosign verify ghcr.io/restow-backup/cicd-updater@sha256:<digest> \
     --certificate-identity https://github.com/restow-backup/cicd-updater/.github/workflows/release.yml@refs/tags/v1.0.0 \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com \
     --certificate-github-workflow-repository restow-backup/cicd-updater \
     --certificate-github-workflow-ref refs/tags/v1.0.0 \
     --certificate-github-workflow-trigger push
   ```

6. Starten Sie ihn und beheben Sie jede `FAIL`-Zeile:

   ```sh
   docker compose --profile updater up -d
   docker compose exec updater cicd-updater doctor
   docker compose exec updater cicd-updater status        # ready: yes
   ```

Ohne das Profil `updater` ändert sich nichts: Ihre App läuft wie bisher und lässt sich
jederzeit von Hand aktualisieren. Einzelheiten: [Getting started](docs/getting-started.md),
[Konfiguration](docs/configuration.md), [Architektur](docs/architecture.md),
[CLI](docs/cli.md).

### 4. App-Seite (gar kein Aufwand bis wenige Stunden, je nach Stufe)

Wählen Sie eine Integrationsstufe. Alle drei steuern dieselbe Engine.

| Stufe | Änderungen an der App | Wer ein Update startet |
| --- | --- | --- |
| 1. Keine App-Änderungen | keine; ein Health-Endpunkt hilft | der Betreiber: `docker compose exec updater cicd-updater schedule 1.1.0 --in 15m` |
| 2. Jede Sprache | das Backend ruft die HTTP-API auf ([OpenAPI](openapi/updater-api.v1.yaml)) | ein Admin, in der Admin-Oberfläche Ihrer App |
| 3. TypeScript | das Backend nutzt das SDK `@restow-backup/cicd-updater`, optional mit seinen React-Komponenten | ein Admin, in der Admin-Oberfläche Ihrer App, mit weniger Code |

Auf den Stufen 2 und 3 übernimmt Ihre App, was nur sie kann:

- **Berechtigung**: Nur Admins auf Installationsebene dürfen einplanen, abbrechen und
  bestätigen; Sitzungen im Namen anderer Nutzer (Impersonation) zählen nie.
- **Step-up**: Das Einplanen verlangt eine starke Anmeldung (Passkey, Passwort plus TOTP,
  OIDC), die höchstens 10 Minuten zurückliegt.
- **Audit**: Übergeben Sie den handelnden Nutzer als `requestedBy` und den Release-Hash,
  den der Admin gesehen hat, als `expect.releaseSha256`, und übernehmen Sie das Journal des
  Sidecars genau einmal in Ihr Audit-Log.
- **Eine Admin-Seite „Updates“** mit laufender und verfügbarer Version, einer Auswahl der
  Vorlaufzeit, Abbruch und Ergebnis; und **ein Wartungsbanner** für jeden angemeldeten
  Nutzer, das auf den öffentlichen Status über Ihren Edge ausweicht, solange die App nicht
  erreichbar ist.
- **Health mit Version**: Bereitschaft für alle, die Version nur für das Token des
  Sidecars.

Die [Vorlage für Webanwendungen](#vorlage-für-webanwendungen) enthält all das zum
Kopieren. Einzelheiten: [App-Integration](docs/app-integration.md),
[HTTP-API](docs/http-api.md), [SDK](docs/sdk.md), [React](docs/react.md),
[Wartungsseite](docs/maintenance-page.md).

### 5. Das erste Update (15 Minuten)

Pushen Sie `v1.1.0` und warten Sie auf das Release. Planen Sie es dann auf Ihrer
Admin-Seite ein, oder auf dem Host:

```sh
docker compose exec updater cicd-updater releases          # neuere Releases und warum eines abgelehnt wird
docker compose exec updater cicd-updater verify 1.1.0      # Probelauf, ohne Pull
docker compose exec updater cicd-updater schedule 1.1.0 --in 15m
docker compose exec updater cicd-updater status
docker compose exec updater cicd-updater ack               # sobald er beendet ist
```

Endet ein Lauf mit `needs_attention`, passiert nichts automatisch:

1. Lesen Sie nach, was passiert ist: `cicd-updater status`, `cicd-updater logs` und
   `cicd-updater recover show` (die Sicherung, die vorigen Images, die vorigen
   `.env`-Zeilen und die vorbereiteten Wiederherstellungsbefehle).
2. Entscheiden Sie: zurück (die Sicherung zurückspielen, wenn sich das Schema geändert
   hat, dann `cicd-updater recover restore-env <runId>` und
   `docker compose --profile updater up -d`) oder vorwärts (die Ursache beheben und die
   neue Version starten).
3. Prüfen Sie die App, dann `cicd-updater ack`.

Einzelheiten: [Runbook](docs/backups-and-recovery.md#runbook-a-run-ended-in-needs_attention),
[Fehlersuche](docs/troubleshooting.md).

## Vorlage für Webanwendungen

[templates/web-app/](templates/web-app/) ist eine framework-unabhängige Vorlage für die
Schritte 3 und 4 in einer bestehenden Webanwendung, mit `TODO(cicd-updater)`-Markierungen
und einer [Anleitung für etwa 30 Minuten](templates/web-app/README.md) (auf Englisch):

| Ordner | Was er enthält |
| --- | --- |
| `compose/` | den Sidecar als Compose-Fragment (einfügen oder mit `-f` zusammenführen) und das Smoke-Override |
| `updater.yaml`, `.env.example` | die kommentierte Konfiguration und die `.env`-Zeilen zum Ergänzen |
| `release/` | den GitHub-Release-Workflow und die Release-Policy |
| `backend/node/` | Endpunkte auf Basis von Standard-`Request`/`Response` mit Hooks für Berechtigung, Step-up und Audit, Health mit Version, Journal-Übernahme, Adapter für Express und Hono (SDK) |
| `backend/python/` | dieselben Endpunkte und Health für FastAPI (HTTP-API) |
| `backend/http/`, `backend/sql/` | die API-Aufrufe für jede andere Sprache mit einem `curl`-Skript; die Probe-Abfrage jedes Presets |
| `frontend/react/` | die Admin-Seite `UpdatesPage` und das Banner `MaintenanceNotice` |
| `frontend/vanilla/` | dasselbe als ein ES-Modul ohne Build-Schritt |

Kopieren Sie `compose/`, `updater.yaml`, `.env.example`, `release/`, einen Ordner aus
`backend/` und einen aus `frontend/` (mit `frontend/updates.css`) in Ihr Projekt, folgen Sie
dann [ihrer README](templates/web-app/README.md) und haken Sie
[INTEGRATION-CHECKLIST.md](templates/web-app/INTEGRATION-CHECKLIST.md) ab. Die TypeScript-
und JavaScript-Dateien werden in der CI dieses Repositorys gegen das SDK typgeprüft.

## Kompatibilität

| | 1.0 |
| --- | --- |
| Hosts | Linux, Docker Engine 24 oder neuer (API 1.43), amd64 und arm64. Der Sidecar bringt sein eigenes Compose und Buildx mit |
| Apps | alles, was mit Docker Compose läuft und seine Images aus Variablen der Env-Datei bezieht |
| CI und Signatur | GitHub Actions (keyless, key, none), Forgejo/Gitea Actions (key, none), GitLab CI und andere CIs über die `release`-CLI |
| Registries | GHCR, Docker Hub, GitLab, Harbor, distribution, Forgejo/Gitea und andere, siehe [docs/registries.md](docs/registries.md) |
| Release-Feeds | Releases von GitHub, Forgejo/Gitea und GitLab, ein statischer Index, ein lokales Verzeichnis |
| SDK | Node.js 22 und neuer für die Server-Teile; Protokoll, SemVer und Texte laufen überall; React 18 und neuer |

Jeder Eintrag hat in [docs/compatibility.md](docs/compatibility.md) einen Status:
**Tested** (von den Unit-Tests abgedeckt, die mit Fakes laufen), **Expected** (sollte laut
Dokumentation der jeweiligen Software funktionieren) oder **To verify** (noch zu prüfen).
1.0 ist implementiert und durch etwa 520 Unit-Tests abgedeckt. Noch **To verify**, im
anstehenden End-to-End-Lauf: alles gegen echtes Docker (Engine-Versionen, der
containerd-Image-Store, rootless Docker), echte Registries (GHCR, distribution, Signaturen
in der Forgejo/Gitea-Registry, mit `cosign copy` befüllte Spiegel), keyless Signieren mit
Sigstore aus GitHub Actions, der Forgejo-Actions-Runner und die drei Beispiele von Anfang
bis Ende aktualisiert. Die Ergebnisse werden auf dieser Seite festgehalten. In 1.0 nicht
unterstützt: Podman, Kubernetes, Swarm, Nomad, Apps über mehrere Hosts und entfernte
Docker-Hosts.

## Sicherheit

**Der Sidecar hält den Docker-Socket, und der bedeutet Root-Rechte auf dem Host.**
Behandeln Sie ihn wie Root. Daraus folgt der Entwurf:

- **Optional**: ein Compose-Profil; nichts läuft, bevor Sie es starten, und Updates von
  Hand bleiben unterstützt.
- **Minimale Rechte drumherum**: Er lauscht nur im internen Netz (ein veröffentlichter Port
  ist ein Blocker), verlangt ein Bearer-Token, das nur in Ihr Backend und nur lesend
  eingebunden ist, bietet keinen Endpunkt, der einen Befehl ausführt oder ein Image
  auswählt, und hält keine Zugangsdaten der Anwendung. Hooks (Sicherung, Probe, Migration,
  Health, Smoke) kommen nur aus `updater.yaml`, die nur der Betreiber schreibt; die App
  darf sie nicht ändern können.
- **Nur geprüfte Eingaben**: In den Modi `keyless` und `key` installiert er nur Releases,
  deren `release.json` und Images gültige Signaturen genau der konfigurierten Identität
  tragen; cosign läuft in einem isolierten Container ohne Socket. Der Modus `none` muss
  ausdrücklich bestätigt werden und wird bei jedem Lauf angezeigt.
- **Gepinnt, nie selbst aktualisiert**: Sein eigenes Image ist per Digest gepinnt und wird
  nur vom Betreiber geändert. Er verweigert ein Update, solange sein eigener Dienst einem
  `.env`-Schlüssel folgen würde, den er umschreibt.

Lesen Sie vor dem Einsatz [docs/security.md](docs/security.md) (mit einer Checkliste zur
Härtung), [docs/trust-modes.md](docs/trust-modes.md) und
[docs/threat-model.md](docs/threat-model.md). Sicherheitslücken melden Sie wie in
[SECURITY.md](SECURITY.md) beschrieben.

## FAQ in Kürze

- **Warum keine automatischen Updates wie bei Watchtower?** Ein verschobenes Tag ist kein
  Release, eine App mit Datenbank braucht eine Sicherung und eine Regel für Fehler, und die
  Nutzer müssen Bescheid wissen. Der Sidecar installiert nie von sich aus.
- **Warum kein Kubernetes?** Kubernetes hat sein eigenes Rollout-Modell; cicd-updater ist
  für einen einzelnen Host mit Docker Compose gedacht.
- **Warum aktualisiert sich der Sidecar nicht selbst?** Wer seinen Feed kontrollierte,
  könnte dann den mächtigsten Container auf dem Host austauschen. Er meldet nur eine
  neuere Version (`selfCheck`).
- **Was passiert ohne den Sidecar?** Nichts ändert sich. Das SDK meldet „kein Sidecar“, und
  die App zeigt die manuellen Schritte: Images mit cosign prüfen, sichern, die per Digest
  gepinnten Referenzen aus `release.json` in `.env` schreiben, `docker compose pull`,
  `docker compose up -d`.
- **Kann ich zu einer älteren Version zurück?** Nicht über den Sidecar: Er installiert nur
  neuere Versionen. Zurück heißt: eine Sicherung und die vorigen `.env`-Zeilen
  wiederherstellen.

Alle Antworten: [docs/faq.md](docs/faq.md).

## Dokumentation

Die Dokumentation ist auf Englisch.

- [Übersicht](docs/index.md): Getting started, Konzepte, Konfigurationsreferenz, Hooks,
  Zustandsautomat, Fehlersuche, Sicherung und Wiederherstellung
- Release-Seite: [Actions und Vorlagen](docs/release-side.md),
  [release.json](docs/release-json.md), [Feeds](docs/feeds.md),
  [Vertrauensmodi](docs/trust-modes.md), [Registries](docs/registries.md)
- App-Seite: [App-Integration](docs/app-integration.md), [HTTP-API](docs/http-api.md),
  [SDK](docs/sdk.md), [React-Komponenten](docs/react.md),
  [Vorlage für Webanwendungen](templates/web-app/README.md)
- Betrieb: [CLI](docs/cli.md), [Wartungsseite](docs/maintenance-page.md),
  [Upgrade des Updaters](docs/upgrading-the-updater.md), [Versionierung](docs/versioning.md),
  [FAQ](docs/faq.md), [Designspezifikation](docs/design.md)
- [Beispiele](examples/), [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md),
  [CHANGELOG.md](CHANGELOG.md)

## Lizenz

Apache License 2.0, siehe [LICENSE](LICENSE) und [NOTICE](NOTICE).
Copyright IT Systeme Flores UG (haftungsbeschränkt).
Komponenten Dritter: [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
